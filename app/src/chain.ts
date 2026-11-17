// Everything that talks to Studionet lives here: the read client, the burner
// wallet, funding, typed contract reads, and the write-and-wait loop with
// leader-error detection. scripts/live_run.ts imports this same module.
import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionHashVariant, TransactionStatus } from "genlayer-js/types";

/** OutageCover v2 (contracts/outage_cover.py), deployed for this app. */
export const CONTRACT_V2 = "0xa2C99AD4c408f620042A8CA42B30C11E8be33598" as const;
/** The first OutageCover (approved as an Intelligent Contract), used only by the live run for comparison. */
export const CONTRACT_V1 = "0x5aA5a3BC78f1753Be70c43308600bcE5474E53F3" as const;

let contract: `0x${string}` = CONTRACT_V2;
export const getContract = () => contract;
/** The live-run script points at v1 for one comparison pool; the app never calls this. */
export function useContract(addr: `0x${string}`) {
  contract = addr;
}

export const RPC_URL = studionet.rpcUrls.default.http[0];
export const EXPLORER = "https://explorer-studio.genlayer.com";
export const GEN = 10n ** 18n;

// limits enforced by the contract
export const LIMITS = {
  settleDelay: 600, // resolve opens 10 minutes after the window ends
  maxScope: 300,
  minMultiple: 2,
  maxMultiple: 100,
};

const PK_KEY = "outagecover.burner.pk";

export const reader = createClient({ chain: studionet });

/* ---------- burner wallet ---------- */

type Pk = `0x${string}`;

function loadPk(): Pk | null {
  try {
    const v = localStorage.getItem(PK_KEY);
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Pk) : null;
  } catch {
    return null;
  }
}

let account = (() => {
  const pk = typeof localStorage === "undefined" ? null : loadPk();
  return pk ? createAccount(pk) : null;
})();

export function getAccount() {
  return account;
}

export function createBurner() {
  const pk = generatePrivateKey();
  try {
    localStorage.setItem(PK_KEY, pk);
  } catch {
    /* private mode: the wallet lives for this tab only */
  }
  account = createAccount(pk);
  return account;
}

/** Use a given key without storing it (the node live-run script). */
export function useKey(pk: Pk) {
  account = createAccount(pk);
  return account;
}

export function forgetBurner() {
  try {
    localStorage.removeItem(PK_KEY);
  } catch {
    /* ignore */
  }
  account = null;
}

export function exportPk(): string | null {
  return loadPk();
}

export async function getBalance(address: `0x${string}`): Promise<bigint> {
  return reader.getBalance({ address });
}

/** Studionet's faucet. studio.genlayer.com/api reflects the request origin in CORS, so this works from a browser. */
export async function fundAccount(address: string, gen = 100n): Promise<void> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "sim_fundAccount",
      params: [address, Number(gen * GEN)],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
}

/* ---------- contract reads ---------- */

export type PoolStatus = "open" | "triggered" | "not_triggered";

export type Evidence = { id: string; name: string; reason: string };

export type Pool = {
  id: number;
  underwriter: string;
  venue: string;
  feed_url: string;
  scope: string;
  cover_start: number;
  cover_end: number;
  trigger_minutes: number;
  multiple: number;
  capital: bigint;
  liability: bigint;
  capacity_left: bigint;
  premiums: bigint;
  status: PoolStatus;
  impaired_minutes: number;
  evidence: Evidence[];
  resolvable_at: number;
};

const plain = (v: any): any => {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  return v;
};

// Studionet allows each IP 30 gen_call reads a minute. The 429 it sends past that
// has no CORS header, so a browser only sees "Failed to fetch". Reads that fail
// that way are retried with a pause; listeners can tell the user why.
let retryListener: (waitS: number | null) => void = () => {};
export function onReadRetry(fn: (waitS: number | null) => void) {
  retryListener = fn;
}
const RETRY_WAITS = [8, 15, 25];
const looksThrottled = (e: any) => /fetch|unknown rpc|429|rate|network|html|json/i.test(String(e?.shortMessage ?? e?.message ?? e));

// "latest-nonfinal": state as accepted by consensus, before the appeal window closes.
// Without it a fresh write would not be visible for a long time on Studionet.
async function read(functionName: string, args: (string | number | boolean)[] = []): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const v = await reader.readContract({
        address: contract,
        functionName,
        args,
        transactionHashVariant: TransactionHashVariant.LATEST_NONFINAL,
      });
      if (attempt) retryListener(null);
      return plain(v);
    } catch (e) {
      if (attempt >= RETRY_WAITS.length || !looksThrottled(e)) {
        if (attempt) retryListener(null);
        throw e;
      }
      retryListener(RETRY_WAITS[attempt]);
      await new Promise((r) => setTimeout(r, RETRY_WAITS[attempt] * 1000));
    }
  }
}

const big = (v: unknown) => BigInt(String(v ?? 0));
const num = (v: unknown) => Number(v ?? 0);

export async function getPoolCount(): Promise<number> {
  return num(await read("get_pool_count"));
}

export async function getPool(id: number): Promise<Pool> {
  const p = await read("get_pool", [id]);
  const end = num(p.cover_end);
  return {
    id,
    underwriter: String(p.underwriter),
    venue: String(p.venue),
    feed_url: String(p.feed_url),
    scope: String(p.scope),
    cover_start: num(p.cover_start),
    cover_end: end,
    trigger_minutes: num(p.trigger_minutes),
    multiple: num(p.multiple),
    capital: big(p.capital),
    liability: big(p.liability),
    capacity_left: big(p.capacity_left),
    premiums: big(p.premiums),
    status: p.status as PoolStatus,
    impaired_minutes: num(p.impaired_minutes),
    evidence: (p.evidence ?? []).map((e: any) => ({ id: String(e.id), name: String(e.name), reason: String(e.reason) })),
    // v1 has no resolvable_at; it resolves right at the window end
    resolvable_at: p.resolvable_at === undefined ? end : num(p.resolvable_at),
  };
}

export async function getCover(id: number, buyer: string): Promise<bigint> {
  return big(await read("get_cover", [id, buyer]));
}

/* ---------- writes ---------- */

export type TxOutcome =
  | { ok: true; hash: string; status: string; votes: string[]; returned?: string }
  | { ok: false; hash?: string; status?: string; code: string; message: string; votes: string[] };

export type TxProgress = (phase: "signing" | "pending", hash?: string) => void;

/**
 * Send a write and wait until consensus accepts it. "ACCEPTED" alone is not
 * success: if the leader hit a contract UserError (e.g. "pool did not trigger")
 * or the model provider rate-limited it, validators agree on the error and the
 * tx is still ACCEPTED with no state change. So look at the leader receipt.
 */
export async function sendTx(
  functionName: string,
  args: (string | number | boolean)[],
  value: bigint,
  onProgress: TxProgress = () => {},
): Promise<TxOutcome> {
  if (!account) throw new Error("no wallet");
  const writer = createClient({ chain: studionet, account });
  onProgress("signing");
  const hash = (await writer.writeContract({ account, address: contract, functionName, args, value })) as string;
  onProgress("pending", hash);
  let r: any;
  for (let i = 0; !r; i++) {
    try {
      r = await reader.waitForTransactionReceipt({
        hash: hash as any,
        status: TransactionStatus.ACCEPTED,
        retries: 150,
        interval: 4000,
      });
    } catch (e) {
      // Studionet's RPC sometimes answers with an HTML error page; the transaction is still there
      if (i >= 4) throw e;
      await new Promise((res) => setTimeout(res, 10_000));
    }
  }
  const leader = r?.consensus_data?.leader_receipt?.[0];
  const exec = leader?.execution_result;
  const status = r?.statusName ?? r?.status_name ?? "ACCEPTED";
  const votes: string[] = r?.last_round?.validator_votes_name ?? [];
  if (exec !== "ERROR" && !/UNDETERMINED/i.test(String(status)))
    return { ok: true, hash, status, votes, returned: leader?.result?.payload?.readable };
  const code: string = leader?.genvm_result?.error_code ?? (exec === "ERROR" ? "ERROR" : String(status));
  const message: string =
    (typeof leader?.result?.payload === "string" ? leader.result.payload : "") ||
    leader?.genvm_result?.error_description ||
    leader?.result?.payload?.readable ||
    leader?.genvm_result?.stderr ||
    code;
  return { ok: false, hash, status, code, message: String(message).replace(/^"|"$/g, "").trim(), votes };
}
