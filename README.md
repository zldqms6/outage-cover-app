# OutageCover app

Downtime cover for crypto venues, settled by GenLayer validators from the venue's own public status page. This repository is the full product: the Intelligent Contract (v2), its tests, and a web app where you open a pool, buy cover, watch the status feed, resolve, and claim.

**Live app:** https://zldqms6.github.io/outage-cover-app/
**Contract (Studionet):** [`0xa2C99AD4c408f620042A8CA42B30C11E8be33598`](https://explorer-studio.genlayer.com/address/0xa2C99AD4c408f620042A8CA42B30C11E8be33598)

## Why I built this

For anyone with money on an exchange, the venue going down at the wrong moment is one of the few risks you can't plan around: orders stuck, a withdrawal halted while the price moves somewhere else. Afterwards the venue's status page usually admits it ("BTC funding paused", "API degraded"), but nobody owes you anything for that.

The first [OutageCover](https://github.com/zldqms6/outage-cover) was a bare contract: an underwriter locks capital, buyers pay a premium, and validators read the venue's Statuspage feed after the window. It worked, but nobody could use it without writing scripts, and when I built the screen for it I found a real hole in how it read the feed. So this is the app plus a fixed contract.

## What changed from the first contract (v1 → v2)

| | v1 ([0x5aA5…53F3](https://explorer-studio.genlayer.com/address/0x5aA5a3BC78f1753Be70c43308600bcE5474E53F3)) | v2 (this repo) |
|---|---|---|
| Incidents read | `incidents.json` only (latest 50) | `incidents.json` **plus** `incidents/unresolved.json`, merged by id |
| Validator accepts leader when | same incident ids, same trigger decision, minutes within 10% | same incident ids **and exactly** the same minutes |
| Resolve opens | at window end | 10 min after window end |

Why the first row matters, with real data: on 2026-11-16 Kraken's `incidents.json` held 50 incidents going back to 2026-10-06. Two incidents still open on Kraken, "Memecore (M) Deposits Disabled" (since 2026-08-19) and the Stablr USD/EUR funding halt (since 2026-05-24), were not on that page at all. A v1 pool covering MemeCore deposits would settle as "nothing happened" while Kraken itself said deposits were disabled. Both feeds are saved in `tests/fixtures/`, and the live run below shows v1 and v2 answering differently for the same scope and window.

The tolerance in the second row was the kind of gray area where a dishonest leader could shade the number. Minutes are computed in code from timestamps clipped to a window that has already ended, so honest nodes reading the same feed get the same integer; there is no reason to accept anything else.

## How it works

1. **Underwriter opens a pool**: venue feed, scope in plain words ("BTC spot order placement or matching on Kraken"), window, trigger in minutes, payout multiple. The GEN sent with the call is locked and caps total payouts.
2. **Buyers buy before the window starts.** Premium × multiple is recorded as that wallet's payout.
3. **Anyone resolves after the window + 10 min.** The leader fetches both feeds, keeps incidents overlapping the window, clips them (code), then asks a model one thing per incident: did it impair the covered scope? Qualifying intervals are merged and counted in code.
4. **Validators** repeat the whole thing on their own fetch and their own model and vote yes only on the same qualifying ids and the same minutes. A different answer fails the round, nothing is stored, and resolve can be called again.
5. **Claim / withdraw.** If merged minutes ≥ trigger, buyers claim; the underwriter withdraws capital + premiums − payouts owed.

Errors are tagged so validators compare them sensibly: `[EXPECTED]` / `[EXTERNAL]` must match the leader exactly, `[TRANSIENT]` (feed HTTP errors) only needs to be transient on both sides.

### The app

- **Pools**: every pool on the contract with phase, capacity sold and result.
- **Pool page**: terms, buy / resolve / claim / withdraw, and a live preview of the incidents validators will look at, read by the browser from the status page and filtered with a TypeScript port of the contract's deterministic half (`src/feeds.ts`: same merge, same clipping, same minute merge). Incidents that only appear on the unresolved list are marked "open list only". After resolve, the incidents consensus counted are shown in red with the model's one-line reason.
- **New pool**: venue presets with the feed filled in, scope suggestions, and the incidents open on that venue right now.
- **Status board**: open incidents across all preset venues, and how many of them the latest-50 page no longer lists.
- Burner wallet in localStorage + Studionet faucet button, one transaction at a time with the leader receipt checked (an `ACCEPTED` tx whose leader hit an error is reported as "not applied", not as success).

Preset venues (both feeds answer with `Access-Control-Allow-Origin: *`, checked 2026-11-16): Kraken, Coinbase, Coinbase Exchange, Gemini, Bitstamp, dYdX Chain.

## Live run (Studionet, real Kraken feed)

Window **2026-11-16 01:14:16 → 2026-11-16 01:19:16 UTC** (5 min), trigger 3 min, multiple 5×, 10 GEN capital, 1 GEN premium per pool. Same window, same feed (`https://status.kraken.com/api/v2/incidents.json`), four pools: three on v2, and the MemeCore scope once more on the original v1 contract. Script: `app/scripts/live_run.ts` (it uses the app's own `chain.ts`/`feeds.ts`); full output with every tx hash: `app/live_run_result.json`.

| Contract / pool | Scope | Result | Impaired min | Incidents counted (model's reason) | Settlement |
|---|---|---|---|---|---|
| v2 #0 | MemeCore (M) deposits on Kraken | triggered | 5 | `373bvd3r2h9c` Memecore (M) Deposits Disabled: "MemeCore (M) deposits on Kraken were explicitly disabled." | [resolve](https://explorer-studio.genlayer.com/tx/0xe9efe51d795a0ce6d9d23c35d32df019e5a2364280ead3636143cceb5cc18f44) · claimed 5 GEN |
| v2 #1 | Osmosis (OSMO) deposits and withdrawals on Kraken | triggered | 5 | `yshfxnffsgl2` Osmosis (OSMO) Funding Delays: "Osmosis (OSMO) deposits and withdrawals were delayed due to a funding gateway issue." | [resolve](https://explorer-studio.genlayer.com/tx/0xc47d20db9c082bde03c9b7b073fcbe4bab47f2d3048063ae11c21e47e5f0fa32) · claimed 5 GEN |
| v2 #2 | BTC spot order placement or matching on Kraken | not triggered | 0 | none | [resolve](https://explorer-studio.genlayer.com/tx/0xf976f1d02fe1e15cb526b53efea80a4924f86fcf0e6dd9714aee30675839a690) · underwriter kept 1 GEN premium |
| **v1** #2 | MemeCore (M) deposits on Kraken | not triggered | 0 | none | [resolve](https://explorer-studio.genlayer.com/tx/0x8ebc85680064409ef04ffc2c978640ff5a8340f0904713fe2bc3c3b9397301a5) · underwriter kept 1 GEN premium |

What it shows:

- **MemeCore, v2 vs v1.** Same scope, same window, same feed host. v2 read the unresolved list, found "Memecore (M) Deposits Disabled" (open since 2026-08-19, not on the latest-50 page) and paid out. v1 never saw it and settled as no outage. This is the bug described above, reproduced on chain.
- **OSMO** is on both lists ("Osmosis (OSMO) Funding Delays", open since 2026-11-14), so it triggers on v2 for the normal reason.
- **BTC spot matching**: five Kraken incidents overlapped the window (MemeCore, Stablr, Initia, Flare, OSMO, all funding/deposit issues on other assets). Consensus counted none of them for BTC order matching, and the underwriter kept the premium.
- Every resolve was accepted on the first attempt (no `LLM_RATE_LIMITED` this time). Claims and withdrawals went through right after.
- The browser preview (`feeds.preview`) listed the same five overlapping incidents for this window, two of them marked "open list only".

Honest notes: this is a 5-minute window over incidents that were already open, which is the easiest case to settle. It proves the feed handling and the consensus rule, not how a vague scope behaves during a fast-moving outage. Validator vote breakdowns are on each resolve transaction in the explorer.

## Verify the deployed source

`deployments.json` lists the address; the `glcheck` workflow ([zldqms6/glcheck](https://github.com/zldqms6/glcheck)) fails the build if the address stops running `contracts/outage_cover.py`.

```
glcheck verify 0xa2C99AD4c408f620042A8CA42B30C11E8be33598 contracts/outage_cover.py
OK   0xa2C99AD4c408f620042A8CA42B30C11E8be33598  contracts/outage_cover.py
     local    6988d2f0e38e759b
     deployed 6988d2f0e38e759b
```

`sha256(contracts/outage_cover.py)` = `6988d2f0e38e759b0beb2ca268394c53daff404c950121e5281a536304aeb6f8`

## Contract API

| Method | Kind | Notes |
|---|---|---|
| `open_pool(venue, feed_url, scope, cover_start, cover_end, trigger_minutes, multiple)` | write, payable | value = payout capital. `feed_url` must be `https://…/api/v2/incidents.json`; window in the future; 1 ≤ trigger ≤ window minutes; multiple 2–100 |
| `buy_cover(pool_id)` | write, payable | value = premium, before `cover_start`, payout = premium × multiple must fit in capital |
| `resolve(pool_id)` | write | from `cover_end + 600`; non-deterministic block described above |
| `claim(pool_id)` | write | buyer, triggered pools |
| `withdraw_capital(pool_id)` | write | underwriter, once, after resolve |
| `get_pool(pool_id)` | view | terms, capacity, status, `impaired_minutes`, `evidence` (id, name, reason), `resolvable_at` |
| `get_cover(pool_id, buyer)` | view | payout owed to `buyer` |
| `get_pool_count()` | view | |

## Tests

```
py -3.12 -m venv .venv
.venv\Scripts\pip install -r requirements-test.txt
.venv\Scripts\python -X utf8 -m pytest -q tests      # 13 passed
```

gltest direct mode, no node. The first seven tests are the v1 suite adapted to two feeds. The v2 tests use the real Kraken snapshot from 2026-11-16:

- the MemeCore incident is on the unresolved list and not on the latest page;
- a MemeCore-deposit pool triggers for the full window, and an honest validator agrees;
- a leader that read only the latest page (v1 behaviour, reports 0 minutes) is rejected;
- a leader reporting 89 or 91 minutes instead of 90 is rejected;
- when the same id is on both lists, the open copy is measured;
- an HTTP error on the unresolved feed blocks settlement and leaves the pool open.

CI runs the same suite (`.github/workflows/tests.yml`, genvm v0.2.16 pinned).

## Run the app

```
cd app
npm install
npm run dev          # http://localhost:5173/outage-cover-app/
npm run live-run     # the Studionet run above; demo keys go to app/.env (gitignored)
```

## Limits

- Only Statuspage feeds, and only ones that also serve `incidents/unresolved.json`. BitMEX's status page imitates the API but answers 404 there, so it is not a preset. Binance, OKX, Upbit and Bithumb publish no such feed at all.
- The venue writes its own status page. Cover pays on what the venue admits, not on what users experienced, and a venue that never posts an incident never pays out.
- The model decides scope. Validators must agree on the exact incident set, so a vague scope ("Kraken works") tends to fail consensus or settle unpredictably. Name the asset, product and action.
- If the venue edits an incident's timestamps between the leader's and a validator's fetch, the round fails; calling resolve again fixes it.
- If more than 50 incidents were created after the window started, the latest page no longer covers it and the contract refuses to settle (`feed no longer covers the window`). Resolve soon after the window.
- Studionet only, burner wallets, test GEN. The browser preview uses this machine's clock; the contract uses the transaction timestamp.
