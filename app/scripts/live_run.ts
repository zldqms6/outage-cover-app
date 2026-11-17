// Live run through the app's own code path: src/chain.ts (client, faucet, sendTx
// with leader-error check, typed reads) and src/feeds.ts (the browser preview).
//   npm run live-run            open pools, buy cover, wait, resolve, claim, withdraw
//   npm run live-run -- resume  continue from live_run_result.json (resolve onwards)
// Opens three pools on the v2 contract against Kraken's real status page, plus one
// pool with the same scope on the first OutageCover (v1) for comparison.
// Keys are demo keys in app/.env (gitignored), generated on first run, never printed.
import fs from "node:fs";
import { createAccount, generatePrivateKey } from "genlayer-js";
import {
  CONTRACT_V1, CONTRACT_V2, GEN, LIMITS, fundAccount, getPool, getPoolCount, sendTx, useContract, useKey,
} from "../src/chain";
import { VENUES, feedUrl, preview } from "../src/feeds";

const OUT = "live_run_result.json";
const LEAD_S = 540;     // time to open and fund four pools before the window starts
const WINDOW_S = 300;
const TRIGGER_MIN = 3;
const MULTIPLE = 5;
const CAPITAL = 10n * GEN;
const PREMIUM = 1n * GEN;
const KRAKEN = VENUES.find((v) => v.key === "kraken")!;
const FEED = feedUrl(KRAKEN.base);

function key(name: string): `0x${string}` {
  const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  const m = env.match(new RegExp(`^${name}=(0x[0-9a-f]{64})`, "m"));
  if (m) return m[1] as `0x${string}`;
  const pk = generatePrivateKey();
  fs.appendFileSync(".env", `${name}=${pk}\n`);
  return pk;
}
const UW = key("DEMO_UNDERWRITER_PK");
const BUYER = key("DEMO_BUYER_PK");
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

const PLAN = [
  { label: "memecore-v2", contract: CONTRACT_V2, scope: "MemeCore (M) deposits on Kraken" },
  { label: "osmo-v2", contract: CONTRACT_V2, scope: "Osmosis (OSMO) deposits and withdrawals on Kraken" },
  { label: "btc-v2", contract: CONTRACT_V2, scope: "BTC spot order placement or matching on Kraken" },
  { label: "memecore-v1", contract: CONTRACT_V1, scope: "MemeCore (M) deposits on Kraken" },
] as const;

type Row = {
  label: string; contract: string; scope: string; id: number;
  open_tx: string; buy_tx: string; preview: unknown;
  resolve_tx?: string; resolve_attempts?: { hash?: string; ok: boolean; code?: string; message?: string }[];
  claim_tx?: string; withdraw_tx?: string; pool?: unknown;
};
type Out = { network: string; feed: string; start: number; end: number; rows: Row[] };

async function tx(as: `0x${string}`, contract: `0x${string}`, fn: string, args: (string | number)[], value = 0n) {
  useContract(contract);
  useKey(as);
  const r = await sendTx(fn, args, value);
  log(`${fn}(${args.join(", ")}) on ${contract.slice(0, 6)} -> ${r.ok ? "ok" : "ERROR " + r.code + " " + r.message} ${r.hash}`);
  return r;
}

async function openAll(): Promise<Out> {
  await fundAccount(createAccount(UW).address, 1000n);
  await fundAccount(createAccount(BUYER).address, 1000n);
  const start = now() + LEAD_S;
  const end = start + WINDOW_S;
  const out: Out = { network: "studionet", feed: FEED, start, end, rows: [] };
  for (const p of PLAN) {
    useContract(p.contract);
    const id = await getPoolCount();
    const o = await tx(UW, p.contract, "open_pool", ["Kraken", FEED, p.scope, start, end, TRIGGER_MIN, MULTIPLE], CAPITAL);
    if (!o.ok) throw new Error(`open_pool failed: ${o.message}`);
    const b = await tx(BUYER, p.contract, "buy_cover", [id], PREMIUM);
    if (!b.ok) throw new Error(`buy_cover failed: ${b.message}`);
    out.rows.push({ label: p.label, contract: p.contract, scope: p.scope, id, open_tx: o.hash, buy_tx: b.hash, preview: null });
    fs.writeFileSync(OUT, JSON.stringify(json(out), null, 2));
  }
  if (now() >= start) throw new Error("window started before every pool was funded; rerun");
  return out;
}

async function settle(out: Out) {
  const open = out.end + LIMITS.settleDelay + 20;
  if (now() < open) {
    log(`waiting ${open - now()} s for resolve to open (window end + ${LIMITS.settleDelay / 60} min)`);
    await sleep((open - now()) * 1000);
  }
  // the browser preview, computed the way the app computes it, once the window is over
  const pv = await preview(FEED, out.start, out.end);
  for (const r of out.rows) r.preview = json(pv);

  for (const r of out.rows) {
    const c = r.contract as `0x${string}`;
    r.resolve_attempts = r.resolve_attempts ?? [];
    for (let i = 0; i < 5; i++) {
      useContract(c);
      if ((await getPool(r.id)).status !== "open") break;
      const res = await tx(BUYER, c, "resolve", [r.id]);
      r.resolve_attempts.push(res.ok ? { hash: res.hash, ok: true } : { hash: res.hash, ok: false, code: res.code, message: res.message });
      fs.writeFileSync(OUT, JSON.stringify(json(out), null, 2));
      if (res.ok) {
        r.resolve_tx = res.hash;
        break;
      }
      await sleep(45_000);
    }
    useContract(c);
    const pool = await getPool(r.id);
    if (pool.status === "triggered" && !r.claim_tx) {
      const cl = await tx(BUYER, c, "claim", [r.id]);
      if (cl.ok) r.claim_tx = cl.hash;
    }
    if (pool.status !== "open" && !r.withdraw_tx) {
      const w = await tx(UW, c, "withdraw_capital", [r.id]);
      if (w.ok) r.withdraw_tx = w.hash;
    }
    useContract(c);
    r.pool = json(await getPool(r.id));
    log(r.label, "->", (r.pool as any).status, (r.pool as any).impaired_minutes, "min");
    fs.writeFileSync(OUT, JSON.stringify(json(out), null, 2));
  }
}

const resume = process.argv.includes("resume");
const out: Out = resume ? JSON.parse(fs.readFileSync(OUT, "utf8")) : await openAll();
log(`window ${new Date(out.start * 1000).toISOString()} -> ${new Date(out.end * 1000).toISOString()}`);
await settle(out);
log("done");
