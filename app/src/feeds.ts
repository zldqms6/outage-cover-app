// Statuspage feeds read straight from the browser. Every venue below answered
// both incidents.json and incidents/unresolved.json with
// `Access-Control-Allow-Origin: *` when checked on 2026-11-16. BitMEX is left
// out: its status page imitates the Statuspage API but has no unresolved.json
// (HTTP 404), so the v2 contract could never settle a BitMEX pool.
//
// The window maths here is a line-by-line port of the contract's deterministic
// half (_clip, _merged_minutes, _merge_feeds, _candidates), so the preview shows
// exactly which incidents validators will hand to the model and how many
// minutes each one would add. The model's yes/no per incident is the only part
// the preview cannot know.

export type Venue = { key: string; name: string; base: string };

export const VENUES: Venue[] = [
  { key: "kraken", name: "Kraken", base: "https://status.kraken.com" },
  { key: "coinbase", name: "Coinbase", base: "https://status.coinbase.com" },
  { key: "coinbase-ex", name: "Coinbase Exchange", base: "https://status.exchange.coinbase.com" },
  { key: "gemini", name: "Gemini", base: "https://status.gemini.com" },
  { key: "bitstamp", name: "Bitstamp", base: "https://status.bitstamp.net" },
  { key: "dydx", name: "dYdX Chain", base: "https://status.dydx.trade" },
];

export const FEED_SUFFIX = "/api/v2/incidents.json";
export const UNRESOLVED_SUFFIX = "/api/v2/incidents/unresolved.json";
export const FEED_PAGE_SIZE = 50;

export const feedUrl = (base: string) => base.replace(/\/+$/, "") + FEED_SUFFIX;
export const unresolvedUrl = (feed: string) => feed.slice(0, -FEED_SUFFIX.length) + UNRESOLVED_SUFFIX;
export const venueOf = (feed: string) => VENUES.find((v) => feedUrl(v.base) === feed);

export type Incident = {
  id: string;
  name: string;
  impact: string;
  created_at: string;
  started_at?: string | null;
  resolved_at?: string | null;
  shortlink?: string;
  components?: { name: string }[];
  incident_updates?: { body: string; created_at?: string }[];
};

export type Candidate = {
  id: string;
  name: string;
  impact: string;
  components: string[];
  start: number;
  end: number;
  minutes: number;
  open: boolean;
  onPage: boolean;
  link?: string;
};

const cache = new Map<string, { at: number; data: Incident[] }>();

async function getIncidents(url: string): Promise<Incident[]> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
  const body = await res.json();
  const data: Incident[] = Array.isArray(body?.incidents) ? body.incidents : [];
  cache.set(url, { at: Date.now(), data });
  return data;
}

export const fetchPage = (feed: string) => getIncidents(feed);
export const fetchUnresolved = (feed: string) => getIncidents(unresolvedUrl(feed));

/** Python's int(datetime.fromisoformat(...).timestamp()) for Statuspage timestamps. */
export const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function clip(inc: Incident, start: number, end: number): [number, number] | null {
  const s0 = ts(inc.started_at || inc.created_at);
  const e0 = inc.resolved_at ? ts(inc.resolved_at) : end;
  const s = Math.max(s0, start);
  const e = Math.min(e0, end);
  return e > s ? [s, e] : null;
}

export function mergedMinutes(intervals: [number, number][]): number {
  let total = 0;
  let cs: number | null = null;
  let ce: number | null = null;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (ce === null || s > ce) {
      if (ce !== null && cs !== null) total += ce - cs;
      cs = s;
      ce = e;
    } else {
      ce = Math.max(ce, e);
    }
  }
  if (ce !== null && cs !== null) total += ce - cs;
  return Math.floor(total / 60);
}

export type Preview = {
  candidates: Candidate[];
  pageCoversWindow: boolean;
  pageOldest: number | null;
  openOffPage: number; // still-open incidents missing from the latest page (what v1 missed)
};

/** Same selection the contract makes before the model is asked anything. */
export async function preview(feed: string, start: number, end: number): Promise<Preview> {
  const [page, open] = await Promise.all([fetchPage(feed), fetchUnresolved(feed)]);
  const pageIds = new Set(page.map((i) => i.id));
  const byId = new Map<string, Incident>();
  for (const i of page) byId.set(i.id, i);
  for (const i of open) byId.set(i.id, i);
  const pageOldest = page.length ? Math.min(...page.map((i) => ts(i.created_at))) : null;
  const pageCoversWindow = !(page.length >= FEED_PAGE_SIZE && pageOldest !== null && pageOldest > start);

  const candidates: Candidate[] = [];
  for (const inc of byId.values()) {
    const span = clip(inc, start, end);
    if (!span) continue;
    candidates.push({
      id: inc.id,
      name: inc.name,
      impact: inc.impact,
      components: (inc.components ?? []).map((c) => c.name),
      start: span[0],
      end: span[1],
      minutes: Math.floor((span[1] - span[0]) / 60),
      open: !inc.resolved_at,
      onPage: pageIds.has(inc.id),
      link: inc.shortlink,
    });
  }
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    candidates,
    pageCoversWindow,
    pageOldest,
    openOffPage: open.filter((i) => !pageIds.has(i.id)).length,
  };
}

/** Recent and open incidents for the status board. */
export async function board(v: Venue): Promise<{ open: Incident[]; recent: Incident[]; openOffPage: number }> {
  const feed = feedUrl(v.base);
  const [page, open] = await Promise.all([fetchPage(feed), fetchUnresolved(feed)]);
  const pageIds = new Set(page.map((i) => i.id));
  const weekAgo = Date.now() / 1000 - 7 * 86400;
  return {
    open,
    recent: page.filter((i) => i.resolved_at && ts(i.created_at) > weekAgo),
    openOffPage: open.filter((i) => !pageIds.has(i.id)).length,
  };
}
