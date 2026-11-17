import "./style.css";
import {
  CONTRACT_V2,
  EXPLORER,
  LIMITS,
  createBurner,
  exportPk,
  forgetBurner,
  fundAccount,
  getAccount,
  getBalance,
  getCover,
  getPool,
  getPoolCount,
  onReadRetry,
  sendTx,
  type Pool,
  type TxOutcome,
} from "./chain";
import { VENUES, board, feedUrl, preview, venueOf, type Candidate, type Incident, type Preview } from "./feeds";
import { duration, esc, fromKstInput, gen, kst, minutes, nowSec, parseGen, relTime, short, toKstInput } from "./format";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

const CONTRACT = CONTRACT_V2;
const PAGE = 12;
const app = $("#app");
const view = () => $("#view");

/* =====================================================================
   Shell
   ===================================================================== */

app.innerHTML = `
  <header class="top">
    <div class="top-inner">
      <a class="brand" href="#/">
        <span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M5 17h5l3-7 5 13 3-6h6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="brand-text"><b>OutageCover</b><small>downtime cover settled from status pages</small></span>
      </a>
      <nav class="tabs" aria-label="Screens">
        <a href="#/" data-tab="list">Pools</a>
        <a href="#/new" data-tab="new">New pool</a>
        <a href="#/board" data-tab="board">Status board</a>
        <a href="#/how" data-tab="how">How it works</a>
      </nav>
      <div class="top-right">
        <span class="net" title="GenLayer Studionet. Testnet, GEN here has no value."><i></i>Studionet</span>
        <button class="wallet-btn" id="wallet-btn" type="button"></button>
      </div>
    </div>
  </header>
  <div class="net-note wrap" id="net-note" hidden></div>
  <main id="view" class="wrap"></main>
  <footer class="foot wrap">
    <div>
      <b>Who decides.</b> Neither the underwriter nor the buyer. Each GenLayer validator reads the venue's own status page, measures incident time inside the window with the code in the contract, asks its own model which incidents hit the covered scope, and has to land on the same incidents and the same minutes as the leader.
    </div>
    <div class="foot-meta">
      Contract <a href="${EXPLORER}/address/${CONTRACT}" target="_blank" rel="noopener"><code>${short(CONTRACT, 8)}</code></a>
      · GenLayer Studionet · testnet only, no real funds
    </div>
  </footer>
  <aside class="dock" id="dock" hidden></aside>
  <dialog class="sheet" id="wallet-sheet"></dialog>
`;

onReadRetry((waitS) => {
  const n = $("#net-note");
  n.hidden = waitS === null;
  if (waitS !== null)
    n.textContent = `Studionet refused a read, most likely its limit of 30 contract reads per minute per IP. Retrying in ${waitS} s…`;
});

/* Pools read by the list are reused by the detail page for a short while; resolved ones barely change. */
const poolCache = new Map<number, { at: number; p: Pool }>();
async function loadPool(id: number, fresh = false): Promise<Pool> {
  const c = poolCache.get(id);
  if (!fresh && c && Date.now() - c.at < (c.p.status === "open" ? 20_000 : 120_000)) return c.p;
  const p = await getPool(id);
  poolCache.set(id, { at: Date.now(), p });
  return p;
}

/* =====================================================================
   Wallet
   ===================================================================== */

let balance: bigint | null = null;

async function refreshBalance() {
  const acc = getAccount();
  if (!acc) balance = null;
  else {
    try {
      balance = await getBalance(acc.address);
    } catch {
      /* keep last */
    }
  }
  paintWalletBtn();
  if (($("#wallet-sheet") as HTMLDialogElement).open) paintWalletSheet();
}

function paintWalletBtn() {
  const acc = getAccount();
  const b = $("#wallet-btn");
  b.innerHTML = acc
    ? `<span class="dot"></span><span class="mono">${short(acc.address, 5)}</span><span class="bal">${balance === null ? "…" : gen(balance)} GEN</span>`
    : `Create wallet`;
  b.classList.toggle("empty", !acc);
}

function paintWalletSheet(msg = "") {
  const sheet = $("#wallet-sheet") as HTMLDialogElement;
  const acc = getAccount();
  sheet.innerHTML = `
    <form method="dialog" class="sheet-head">
      <h2>Testnet wallet</h2>
      <button class="icon-btn" aria-label="Close">✕</button>
    </form>
    <div class="callout warn">
      A <b>throwaway testnet key</b> made in this browser and kept in its localStorage. Don't send real assets to it. Studionet GEN has no value.
    </div>
    ${
      acc
        ? `<dl class="kv">
            <dt>Address</dt><dd><code class="mono break">${acc.address}</code> <button class="link-btn" data-copy="${acc.address}" type="button">copy</button></dd>
            <dt>Balance</dt><dd><b class="big">${balance === null ? "…" : gen(balance, 4)}</b> GEN</dd>
          </dl>
          <div class="row gap mt">
            <button class="btn primary" id="w-fund" type="button">Get 100 test GEN</button>
            <a class="btn ghost" href="${EXPLORER}/address/${acc.address}" target="_blank" rel="noopener">Explorer</a>
          </div>
          <details class="adv"><summary>Advanced</summary>
            <div class="row gap mt">
              <button class="btn ghost" id="w-export" type="button">Show private key</button>
              <button class="btn danger" id="w-forget" type="button">Delete wallet</button>
            </div>
            <div id="w-pk"></div>
          </details>`
        : `<button class="btn primary mt" id="w-create" type="button">Create a testnet wallet</button>`
    }
    <div class="sheet-msg" id="w-msg">${msg}</div>
  `;
  $("#w-create", sheet)?.addEventListener("click", async () => {
    createBurner();
    paintWalletSheet(`<span class="muted">Wallet created. Funding it with 100 test GEN…</span>`);
    await doFund();
  });
  $("#w-fund", sheet)?.addEventListener("click", doFund);
  $("#w-export", sheet)?.addEventListener("click", () => {
    $("#w-pk", sheet).innerHTML = `<p class="small muted mt">Anyone with this key controls the wallet.</p><code class="mono break block">${esc(exportPk() ?? "")}</code>`;
  });
  $("#w-forget", sheet)?.addEventListener("click", () => {
    if (!confirm("Delete this wallet's key from the browser? Test GEN in it will be unreachable.")) return;
    forgetBurner();
    refreshBalance();
    paintWalletSheet();
  });
  $$("[data-copy]", sheet).forEach((b) => b.addEventListener("click", () => navigator.clipboard?.writeText(b.dataset.copy!)));
}

async function doFund() {
  const acc = getAccount();
  if (!acc) return;
  const m = () => $("#w-msg");
  if (m()) m().innerHTML = `<span class="muted">Calling sim_fundAccount…</span>`;
  try {
    await fundAccount(acc.address);
    await refreshBalance();
    if (m()) m().innerHTML = `<span class="ok-t">Funded with 100 test GEN.</span>`;
  } catch (e: any) {
    if (m())
      m().innerHTML = `<span class="no-t">Faucet failed: ${esc(e?.message ?? e)}</span>
        <p class="small muted">Same call from a terminal:</p>
        <code class="mono break block">curl -X POST https://studio.genlayer.com/api -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"sim_fundAccount","params":["${acc.address}",100000000000000000000]}'</code>`;
  }
}

$("#wallet-btn").addEventListener("click", () => {
  paintWalletSheet();
  ($("#wallet-sheet") as HTMLDialogElement).showModal();
});

/* =====================================================================
   Transactions: one at a time, shown in a dock
   ===================================================================== */

let busy = false;

async function runTx(label: string, fn: string, args: (string | number | boolean)[], value: bigint): Promise<TxOutcome | null> {
  if (busy) return null;
  if (!getAccount()) {
    paintWalletSheet(`<span class="no-t">Create and fund a wallet first.</span>`);
    ($("#wallet-sheet") as HTMLDialogElement).showModal();
    return null;
  }
  busy = true;
  document.body.dataset.busy = "1";
  const dock = $("#dock");
  dock.hidden = false;
  const t0 = Date.now();
  let hash = "";
  let phase = "Signing";
  const paint = () => {
    const secs = Math.round((Date.now() - t0) / 1000);
    dock.innerHTML = `<div class="dock-in"><span class="spin"></span><div><b>${esc(label)}</b>
      <div class="small muted">${phase} · ${secs}s${hash ? ` · <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener" class="mono">${short(hash, 8)}</a>` : ""}</div></div></div>`;
  };
  paint();
  const timer = setInterval(paint, 1000);
  try {
    const r = await sendTx(fn, args, value, (p, h) => {
      if (h) hash = h;
      phase = p === "signing" ? "Signing" : fn === "resolve" ? "Validators are reading the status page" : "Waiting for validators";
      paint();
    });
    clearInterval(timer);
    const secs = Math.round((Date.now() - t0) / 1000);
    const link = `<a href="${EXPLORER}/tx/${r.hash}" target="_blank" rel="noopener" class="mono">${short(r.hash ?? "", 8)}</a>`;
    const hint = !r.ok && /RATE|LLM/i.test(r.code + r.message) ? " The model provider throttled the leader; try again in a minute." : "";
    dock.innerHTML = r.ok
      ? `<div class="dock-in ok"><b>${esc(label)}: accepted</b><div class="small muted">${secs}s · ${link}${r.votes.length ? ` · votes ${esc(r.votes.join(", "))}` : ""}</div><button class="icon-btn" data-close>✕</button></div>`
      : `<div class="dock-in bad"><b>${esc(label)}: not applied</b><div class="small">${esc(r.message)}</div><div class="small muted">Nothing changed on chain.${hint} ${secs}s · ${link}</div><button class="icon-btn" data-close>✕</button></div>`;
    $("[data-close]", dock)?.addEventListener("click", () => (dock.hidden = true));
    refreshBalance();
    return r;
  } catch (e: any) {
    clearInterval(timer);
    dock.innerHTML = `<div class="dock-in bad"><b>${esc(label)}: error</b><div class="small">${esc(e?.shortMessage ?? e?.message ?? e)}</div><button class="icon-btn" data-close>✕</button></div>`;
    $("[data-close]", dock)?.addEventListener("click", () => (dock.hidden = true));
    return null;
  } finally {
    busy = false;
    delete document.body.dataset.busy;
  }
}

/* =====================================================================
   Helpers shared by screens
   ===================================================================== */

type Phase = "selling" | "covering" | "waiting" | "resolvable" | "triggered" | "not_triggered";

function phaseOf(p: Pool): Phase {
  if (p.status !== "open") return p.status;
  const t = nowSec();
  if (t < p.cover_start) return "selling";
  if (t < p.cover_end) return "covering";
  if (t < p.resolvable_at) return "waiting";
  return "resolvable";
}

const PHASE_PILL: Record<Phase, [string, string]> = {
  selling: ["live", "Selling cover"],
  covering: ["wait", "Window running"],
  waiting: ["wait", "Grace period"],
  resolvable: ["wait", "Ready to resolve"],
  triggered: ["bad", "Triggered · paid out"],
  not_triggered: ["done", "Not triggered"],
};
const pill = (ph: Phase) => `<span class="pill ${PHASE_PILL[ph][0]}">${PHASE_PILL[ph][1]}</span>`;

const venueName = (p: Pool) => venueOf(p.feed_url)?.name ?? p.venue;

function capBar(p: Pool) {
  const used = p.capital > 0n ? Number((p.liability * 1000n) / p.capital) / 10 : 0;
  return `<div class="cap" title="${used}% of payout capital sold"><i style="width:${Math.min(used, 100)}%"></i></div>`;
}

function incidentLi(c: Candidate, hit?: boolean) {
  const where = c.onPage ? "" : ` <span class="pill wait" title="Not on the latest-50 page; only the unresolved list has it">open list only</span>`;
  return `<li class="inc ${hit ? "hit" : ""} ${c.open ? "open" : ""}">
    <div class="inc-head"><b>${esc(c.name)}</b><span class="mono small">${minutes(c.minutes)}</span></div>
    <div class="tiny muted">${esc(c.impact || "none")} impact · ${c.components.length ? esc(c.components.slice(0, 3).join(", ")) : "no components"}${c.open ? " · still open" : ""}${where}
    ${c.link ? ` · <a href="${esc(c.link)}" target="_blank" rel="noopener">status page</a>` : ""}</div>
  </li>`;
}

function errBox(e: any) {
  return `<div class="callout bad">${esc(e?.shortMessage ?? e?.message ?? e)}</div>`;
}

/* =====================================================================
   Screen: pool list
   ===================================================================== */

async function screenList() {
  view().innerHTML = `
    <section class="hero">
      <h1>Buy cover against a venue going down, and get paid from its own status page.</h1>
      <p>An underwriter locks payout capital for one exchange, one scope in plain words ("BTC spot order matching on Kraken") and one time window. You pay a premium before the window starts. Afterwards GenLayer validators read the venue's public Statuspage feed, count impaired minutes in code, and ask a model only which incidents hit the scope. Enough minutes, and you claim premium × multiple.</p>
      <div class="row gap"><a class="btn primary" href="#/new">Open a pool</a><a class="btn ghost" href="#/board">See what is down right now</a></div>
    </section>
    <div class="list-head"><h2>Pools</h2><span class="muted small" id="count"></span></div>
    <div class="grid" id="pools"><div class="muted">Loading pools from Studionet…</div></div>`;
  try {
    const n = await getPoolCount();
    $("#count").textContent = `${n} on chain, newest first`;
    if (!n) {
      $("#pools").innerHTML = `<div class="card">No pools yet. <a href="#/new">Open the first one.</a></div>`;
      return;
    }
    const ids = Array.from({ length: Math.min(n, PAGE) }, (_, i) => n - 1 - i);
    const cards: string[] = [];
    for (const id of ids) {
      try {
        const p = await loadPool(id);
        cards.push(`
          <a class="card pool" href="#/pool/${id}">
            <div class="pool-top"><span class="muted small">#${id} · ${esc(venueName(p))}</span>${pill(phaseOf(p))}</div>
            <div class="pool-scope">${esc(p.scope)}</div>
            <div class="small muted">${kst(p.cover_start)} · ${duration(p.cover_end - p.cover_start)} · trigger ${minutes(p.trigger_minutes)} · pays ${p.multiple}×</div>
            ${capBar(p)}
            <div class="small">${gen(p.capacity_left)} of ${gen(p.capital)} GEN payout left${p.status !== "open" ? ` · <b>${minutes(p.impaired_minutes)}</b> impaired` : ""}</div>
          </a>`);
        $("#pools").innerHTML = cards.join("");
      } catch (e) {
        cards.push(`<div class="card">#${id}: ${errBox(e)}</div>`);
      }
    }
  } catch (e) {
    $("#pools").innerHTML = errBox(e);
  }
}

/* =====================================================================
   Screen: pool detail
   ===================================================================== */

async function screenPool(id: number) {
  view().innerHTML = `<a class="back" href="#/">← Pools</a><div id="pd" class="muted">Loading pool #${id}…</div>`;
  let p: Pool;
  try {
    p = await loadPool(id, true);
  } catch (e) {
    $("#pd").innerHTML = errBox(e);
    return;
  }
  const acc = getAccount();
  const ph = phaseOf(p);
  let mine = 0n;
  if (acc) mine = await getCover(id, acc.address).catch(() => 0n);
  const isUw = !!acc && acc.address.toLowerCase() === p.underwriter.toLowerCase();

  const actions: string[] = [];
  if (ph === "selling") {
    const maxPremium = p.capacity_left / BigInt(p.multiple);
    actions.push(`
      <form class="form" id="buy">
        <label>Premium (GEN)<input name="premium" inputmode="decimal" value="1" required>
          <span class="hint">Pays ${p.multiple}× if triggered. Room for up to ${gen(maxPremium)} GEN of premium. Sales close ${relTime(p.cover_start)}.</span></label>
        <button class="btn primary" data-tx>Buy cover</button>
      </form>`);
  }
  if (ph === "covering" || ph === "waiting")
    actions.push(`<p class="small">Resolve opens ${relTime(p.resolvable_at)} (${kst(p.resolvable_at)}): ${LIMITS.settleDelay / 60} minutes after the window, so incidents the venue posts a little late still count.</p>`);
  if (ph === "resolvable")
    actions.push(`<p class="small">Anyone can resolve. Validators each read the feed and must agree on the exact incident set and minute count.</p><button class="btn primary" id="resolve" data-tx>Resolve now</button>`);
  if (ph === "triggered" && mine > 0n) actions.push(`<button class="btn primary" id="claim" data-tx>Claim ${gen(mine)} GEN</button>`);
  if (ph === "triggered" && acc && mine === 0n) actions.push(`<p class="small muted">Nothing left to claim from this wallet.</p>`);
  if ((ph === "triggered" || ph === "not_triggered") && isUw)
    actions.push(`<button class="btn" id="withdraw" data-tx>Withdraw underwriter balance</button><p class="tiny muted">Capital + premiums − payouts owed. Fails if already withdrawn.</p>`);

  $("#pd").outerHTML = `
    <div class="detail-head"><h1>${esc(p.scope)}</h1>${pill(ph)}</div>
    <div class="cols">
      <div class="col">
        <div class="stats">
          <div><b>${minutes(p.trigger_minutes)}</b><span>trigger</span></div>
          <div><b>${p.multiple}×</b><span>payout multiple</span></div>
          <div><b>${gen(p.capacity_left)}</b><span>GEN payout left</span></div>
          <div><b>${p.status === "open" ? "–" : minutes(p.impaired_minutes)}</b><span>impaired (on chain)</span></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Incidents validators will look at</h3><button class="btn sm ghost" id="pv-reload" type="button">Refresh</button></div>
          <p class="small muted">Read live from <a href="${esc(p.feed_url)}" target="_blank" rel="noopener">${esc(new URL(p.feed_url).host)}</a> by this browser, filtered with the same code the contract runs. ${p.status === "open" ? "The model's yes/no per incident is decided at resolve." : "Red ones are the incidents consensus counted."}</p>
          <div id="pv" class="muted small">Reading the status page…</div>
        </div>
        ${
          p.status !== "open"
            ? `<div class="card"><h3>On-chain verdict</h3>${
                p.evidence.length
                  ? `<ul class="inc-list">${p.evidence.map((e) => `<li class="inc hit"><div class="inc-head"><b>${esc(e.name)}</b><span class="mono tiny">${esc(e.id)}</span></div><div class="small">${esc(e.reason)}</div></li>`).join("")}</ul>`
                  : `<p class="small">No incident impaired the scope during the window.</p>`
              }<p class="small mt">${minutes(p.impaired_minutes)} merged impaired time vs trigger ${minutes(p.trigger_minutes)} → <b>${p.status === "triggered" ? "triggered" : "not triggered"}</b>.</p></div>`
            : ""
        }
      </div>
      <div class="col side">
        <div class="card">
          <h3>Terms</h3>
          <dl class="kv">
            <dt>Venue</dt><dd>${esc(venueName(p))}</dd>
            <dt>Window</dt><dd>${kst(p.cover_start)}<br>→ ${kst(p.cover_end)}</dd>
            <dt>Capital</dt><dd>${gen(p.capital)} GEN</dd>
            <dt>Sold</dt><dd>${gen(p.liability)} GEN payout · ${gen(p.premiums)} GEN premiums</dd>
            <dt>Underwriter</dt><dd><a class="mono" href="${EXPLORER}/address/${p.underwriter}" target="_blank" rel="noopener">${short(p.underwriter)}</a>${isUw ? " (you)" : ""}</dd>
            ${acc ? `<dt>Your cover</dt><dd>${gen(mine)} GEN payout</dd>` : ""}
          </dl>
          ${capBar(p)}
        </div>
        <div class="card"><h3>Actions</h3>${actions.join("") || `<p class="small muted">Nothing to do from this wallet right now.</p>`}</div>
      </div>
    </div>`;

  const paintPreview = async () => {
    const box = $("#pv");
    box.textContent = "Reading the status page…";
    try {
      const pv = await preview(p.feed_url, p.cover_start, Math.min(p.cover_end, Math.max(nowSec(), p.cover_start)));
      const hits = new Set(p.evidence.map((e) => e.id));
      box.outerHTML = `<div id="pv">${previewHtml(pv, p.trigger_minutes, hits, p.status !== "open")}</div>`;
    } catch (e) {
      box.innerHTML = errBox(e);
    }
  };
  $("#pv-reload").addEventListener("click", paintPreview);
  paintPreview();

  $("#buy")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = parseGen(String(new FormData(ev.target as HTMLFormElement).get("premium")));
    if (!v) return alert("Enter a premium in GEN, e.g. 1 or 0.5");
    if ((await runTx(`Buy cover on #${id}`, "buy_cover", [id], v))?.ok) screenPool(id);
  });
  $("#resolve")?.addEventListener("click", async () => {
    if ((await runTx(`Resolve #${id}`, "resolve", [id], 0n))?.ok) screenPool(id);
  });
  $("#claim")?.addEventListener("click", async () => {
    if ((await runTx(`Claim #${id}`, "claim", [id], 0n))?.ok) screenPool(id);
  });
  $("#withdraw")?.addEventListener("click", async () => {
    if ((await runTx(`Withdraw #${id}`, "withdraw_capital", [id], 0n))?.ok) screenPool(id);
  });
}

function previewHtml(pv: Preview, trigger: number, hits: Set<string>, resolved: boolean) {
  const warn = !pv.pageCoversWindow
    ? `<div class="callout bad">The latest-50 page no longer reaches back to the window start. The contract refuses to settle on a feed like this ("feed no longer covers the window").</div>`
    : "";
  if (!pv.candidates.length) return `${warn}<p class="small">No incident on the feed overlaps the window. Settles as not triggered without asking a model.</p>`;
  const all = pv.candidates.reduce((s, c) => s + c.minutes, 0);
  return `${warn}
    <ul class="inc-list">${pv.candidates.map((c) => incidentLi(c, resolved && hits.has(c.id))).join("")}</ul>
    <p class="small mt">${pv.candidates.length} overlapping incident${pv.candidates.length > 1 ? "s" : ""}. If every one hit the scope: ${minutes(all)} before merging overlaps (trigger ${minutes(trigger)}).</p>`;
}

/* =====================================================================
   Screen: new pool
   ===================================================================== */

function screenNew(venueKey?: string) {
  const start = Math.ceil((nowSec() + 15 * 60) / 300) * 300;
  view().innerHTML = `
    <h1>Open a pool</h1>
    <div class="cols">
      <form class="card form" id="np">
        <fieldset>
          <legend>What is covered</legend>
          <label>Venue
            <select name="venue">${VENUES.map((v) => `<option value="${v.key}">${esc(v.name)}</option>`).join("")}<option value="custom">Other Statuspage…</option></select>
          </label>
          <label>Feed URL<input name="feed" readonly><span class="hint">Must be a Statuspage <code>/api/v2/incidents.json</code>.</span></label>
          <label class="full">Scope, in plain words
            <textarea name="scope" maxlength="${LIMITS.maxScope}" required placeholder="BTC spot order placement or matching on Kraken"></textarea>
            <span class="hint">The only thing the model decides is whether an incident made this unusable. Name the asset, product and action.</span>
          </label>
          <div class="full chips" id="ideas"></div>
        </fieldset>
        <fieldset>
          <legend>Window and payout</legend>
          <label>Start (KST)<input type="datetime-local" name="start" value="${toKstInput(start)}" required></label>
          <label>Length (minutes)<input name="len" inputmode="numeric" value="60" required></label>
          <label>Trigger (impaired minutes)<input name="trigger" inputmode="numeric" value="15" required><span class="hint">Merged time of qualifying incidents inside the window.</span></label>
          <label>Multiple<input name="multiple" inputmode="numeric" value="5" required><span class="hint">Buyer gets premium × this. ${LIMITS.minMultiple}–${LIMITS.maxMultiple}.</span></label>
          <label>Capital (GEN)<input name="capital" inputmode="decimal" value="10" required><span class="hint">Locked now; caps total payouts.</span></label>
        </fieldset>
        <div class="callout" id="np-msg" hidden></div>
        <button class="btn primary" data-tx>Open pool and lock capital</button>
      </form>
      <div class="col side">
        <div class="card"><h3>Open on this venue right now</h3><div id="np-open" class="small muted">…</div></div>
      </div>
    </div>`;

  const f = $("#np") as HTMLFormElement;
  const venueSel = f.elements.namedItem("venue") as HTMLSelectElement;
  const feedIn = f.elements.namedItem("feed") as HTMLInputElement;
  const scopeIn = f.elements.namedItem("scope") as HTMLTextAreaElement;

  const syncVenue = async () => {
    const v = VENUES.find((x) => x.key === venueSel.value);
    feedIn.readOnly = !v;
    if (v) feedIn.value = feedUrl(v.base);
    else if (!feedIn.value) feedIn.placeholder = "https://status.example.com/api/v2/incidents.json";
    const name = v?.name ?? "the venue";
    $("#ideas").innerHTML = [`BTC spot order placement or matching on ${name}`, `API order entry on ${name}`, `Fiat deposits and withdrawals on ${name}`]
      .map((s) => `<button type="button" class="chip">${esc(s)}</button>`)
      .join("");
    $$(".chip").forEach((c) => c.addEventListener("click", () => (scopeIn.value = c.textContent ?? "")));
    const box = $("#np-open");
    if (!v) return void (box.textContent = "Pick a listed venue to see its open incidents.");
    box.textContent = "Reading the status page…";
    try {
      const b = await board(v);
      box.innerHTML = b.open.length
        ? `<ul class="inc-list">${b.open.map((i) => boardLi(i)).join("")}</ul>
           <p class="tiny muted mt">An open incident overlapping your window counts for the whole overlap, if the model says it hits your scope.</p>`
        : `<p>Nothing open.</p>`;
    } catch (e) {
      box.innerHTML = errBox(e);
    }
  };
  if (venueKey && VENUES.some((v) => v.key === venueKey)) venueSel.value = venueKey;
  venueSel.addEventListener("change", syncVenue);
  syncVenue();

  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(f);
    const msg = $("#np-msg");
    const fail = (t: string) => {
      msg.hidden = false;
      msg.className = "callout bad";
      msg.textContent = t;
    };
    const feed = String(fd.get("feed") ?? "").trim();
    const scope = String(fd.get("scope") ?? "").trim();
    const s = fromKstInput(String(fd.get("start")));
    const len = Number(fd.get("len"));
    const trig = Number(fd.get("trigger"));
    const mult = Number(fd.get("multiple"));
    const cap = parseGen(String(fd.get("capital")));
    if (!/^https:\/\/.+\/api\/v2\/incidents\.json$/.test(feed)) return fail("Feed must be an https Statuspage /api/v2/incidents.json URL.");
    if (!scope) return fail("Describe the covered scope.");
    if (!s || s <= nowSec() + 120) return fail("Start at least a few minutes from now, so buyers have time to buy.");
    if (!Number.isInteger(len) || len < 1) return fail("Length must be whole minutes.");
    if (!Number.isInteger(trig) || trig < 1 || trig > len) return fail("Trigger must be between 1 and the window length.");
    if (!Number.isInteger(mult) || mult < LIMITS.minMultiple || mult > LIMITS.maxMultiple) return fail(`Multiple must be ${LIMITS.minMultiple}–${LIMITS.maxMultiple}.`);
    if (!cap) return fail("Capital must be a positive GEN amount.");
    const venue = VENUES.find((x) => x.key === venueSel.value)?.name ?? new URL(feed).host;
    const before = await getPoolCount().catch(() => null);
    const r = await runTx("Open pool", "open_pool", [venue, feed, scope, s, s + len * 60, trig, mult], cap);
    if (r?.ok) location.hash = before === null ? "#/" : `#/pool/${before}`;
    else if (r) fail(r.message);
  });
}

function boardLi(i: Incident) {
  const since = i.started_at || i.created_at;
  return `<li class="inc ${i.resolved_at ? "" : "open"}">
    <div class="inc-head"><b>${esc(i.name)}</b><span class="tiny muted">${i.resolved_at ? "resolved" : "open"}</span></div>
    <div class="tiny muted">${esc(i.impact || "none")} impact · since ${kst(Math.floor(Date.parse(since) / 1000))}${i.shortlink ? ` · <a href="${esc(i.shortlink)}" target="_blank" rel="noopener">details</a>` : ""}</div>
  </li>`;
}

/* =====================================================================
   Screen: status board
   ===================================================================== */

function screenBoard() {
  view().innerHTML = `
    <h1>Status board</h1>
    <p class="muted">Open incidents on every venue the app knows, read live from their Statuspage feeds. "Missing from latest-50" counts open incidents the plain <code>incidents.json</code> page no longer lists. The first OutageCover only read that page and would have missed them; this version also reads <code>incidents/unresolved.json</code>.</p>
    <div class="board" id="board">${VENUES.map((v) => `<div class="card" id="b-${v.key}"><h3>${esc(v.name)}<span class="tiny muted">…</span></h3></div>`).join("")}</div>`;
  for (const v of VENUES) {
    board(v)
      .then((b) => {
        const off = b.openOffPage ? `<span class="pill wait" title="Open incidents not on the latest-50 page">${b.openOffPage} missing from latest-50</span>` : "";
        $(`#b-${v.key}`).innerHTML = `
          <h3>${esc(v.name)}<span class="pill ${b.open.length ? "wait" : "done"}">${b.open.length} open</span></h3>
          ${off}
          ${b.open.length ? `<ul class="inc-list mt">${b.open.slice(0, 6).map(boardLi).join("")}</ul>` : `<p class="small">Nothing open.</p>`}
          <p class="tiny muted mt">${b.recent.length} resolved in the last 7 days · <a href="#/new/${v.key}">cover this venue</a></p>`;
      })
      .catch((e) => ($(`#b-${v.key}`).innerHTML = `<h3>${esc(v.name)}</h3>${errBox(e)}`));
  }
}

/* =====================================================================
   Screen: how it works
   ===================================================================== */

function screenHow() {
  view().innerHTML = `
    <div class="card prose">
      <h1>How it works</h1>
      <h3>1. Underwriter opens a pool</h3>
      <p>Venue feed, a scope in plain words, a window, a trigger in minutes and a payout multiple. The capital sent with the call is locked and caps what buyers can be paid.</p>
      <h3>2. Buyers buy before the window starts</h3>
      <p>Premium × multiple is recorded as that wallet's payout. Sales stop when the window starts or the capital is fully sold.</p>
      <h3>3. Anyone resolves after the window</h3>
      <p>Resolve opens ${LIMITS.settleDelay / 60} minutes after the window ends. The leader fetches <code>incidents.json</code> and <code>incidents/unresolved.json</code>, merges them by incident id, keeps the incidents that overlap the window and clips each to it. This part is code, so every honest node gets the same list and the same seconds.</p>
      <p>Only then is a model asked, per incident, whether it impaired the scope. Each validator repeats the whole thing on its own fetch and its own model and accepts the leader only if it gets <b>the same qualifying incident ids and the same merged minute count</b>. A different answer means the round fails and nothing is stored; resolve can be called again.</p>
      <h3>4. Claim or withdraw</h3>
      <p>If merged impaired minutes reach the trigger, each buyer claims their payout. The underwriter withdraws capital + premiums − payouts owed.</p>
      <h3>What changed from the first OutageCover</h3>
      <ul>
        <li>Long-running incidents fall off the latest-50 page. On 2026-11-16 Kraken had a MemeCore deposit outage open since August that the page did not list. v2 also reads the unresolved list.</li>
        <li>Validators used to accept a leader within 10% on minutes. Now the number must match exactly.</li>
        <li>A grace period before resolve, because status pages post incidents a few minutes late with a back-dated start.</li>
      </ul>
      <h3>Limits</h3>
      <ul>
        <li>Only Statuspage-hosted feeds. Binance, OKX, Upbit and Bithumb don't publish one, so they can't be covered.</li>
        <li>The venue writes its own status page. Cover pays on what it admits, not on what users felt.</li>
        <li>Studionet only, burner wallets, test GEN.</li>
      </ul>
    </div>`;
}

/* =====================================================================
   Router
   ===================================================================== */

function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const tab = h.startsWith("/new") ? "new" : h.startsWith("/board") ? "board" : h.startsWith("/how") ? "how" : "list";
  $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  const m = h.match(/^\/pool\/(\d+)/);
  if (m) return screenPool(Number(m[1]));
  if (tab === "new") return screenNew(h.split("/")[2]);
  if (tab === "board") return screenBoard();
  if (tab === "how") return screenHow();
  return screenList();
}

window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  route();
});
paintWalletBtn();
refreshBalance();
route();
