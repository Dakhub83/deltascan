# DeltaScan: notes for Claude

A real-time scanner for day and swing trading, modelled on Trade Ideas, Scanz and Day Trade Dash. It's an npm-workspaces monorepo on Node ≥ 22.
- [README.md](README.md) covers layout, quick start, the UI and Alpaca setup.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the stack, design decisions, the data-feed reality check and the **step-by-step implementation plan**.

## Commands

```bash
npm run dev          # server (ws://localhost:4000/ws) + web (http://localhost:5173), mock data, no keys
npm test             # vitest: apps/server/test and apps/web/src/**/*.test.ts
npm run typecheck    # all workspaces
```

## Layout in one breath

- `packages/shared/src/index.ts` holds **every** type that crosses the wire (`SymbolSnapshot`, `Alert`, `ServerMessage`, …). Change it first, then fix both apps.
- `apps/server`: provider (`alpaca` | `mock`) → `IngestionService` → `SymbolStore` (dirty set) → `AlertEngine` / `HaltTracker` → `ClientGateway` (flushes deltas every 250 ms). `src/index.ts` wires them together.
- `apps/web`: React + dockview + AG Grid + Zustand. Ticks go into `lib/marketData.ts` and stay out of React state; they're flushed once per animation frame.

## Conventions

- All scanning runs on the server. The browser only renders.
- Alerts are edge-triggered with per-type cooldowns (`DEFAULT_COOLDOWN_MS` in `AlertEngine.ts`). Adding an `AlertType` means updating `ALERT_TYPES` in shared, the cooldown map and `apps/web/src/lib/alertMeta.ts`.
- New env vars go in three places: `apps/server/src/config/env.ts` (zod), `.env.example` (with a comment) and the README if they're user-facing.
- Providers emit only normalized events (`trade`, `quote`, `bar`, `seed`, `reference`, `tradingStatus`, `status`). Nothing downstream knows which provider is running.
- Code is TypeScript strict. Keep comments sparse and only where they say *why*, and write tests next to the class they cover (`apps/server/test/<Class>.test.ts`).
- Alpaca allows **one** stream connection per account. A second server instance gets `406 connection limit exceeded`.

---

## Where we left off (2026-10-24) — delete this section once it's done

**Feature in progress: trading halts + 1m/5m momentum.** It's on branch `wip/halts-momentum`, committed and pushed, and doesn't typecheck yet. Merge it into `main` once the steps below are done.

### Done
- **shared**: `TradingStatus`, `HaltEvent`, `HaltState`; `halt` and `resume` alert types; `chg1mPct`, `chg5mPct` and `halted` on `SymbolSnapshot`; a `halts` field in `hello` and a new `halts` server message (upsert by id).
- **`scanner/HaltTracker.ts`** (new): turns status messages into halt records (halted → quoting → resumed), takes the first print after resumption as the resume price and gap, and exposes `drain()` / `recent()` plus `onHalt` / `onResume` callbacks. Tests are in `test/HaltTracker.test.ts`.
- **`SymbolStore`**: a per-second price ring buffer, `sampleMomentum()` (meant to be called every 1 s) and `setHalted()`. Tests added.
- **`AlertEngine.raise()`** lets other components fire alerts and still respect cooldowns.
- **Alpaca**: optional `statuses` subscription (`ALPACA_STATUSES=false` by default) and the `T:'s'` message → `haltStateOf()` mapping in `messages.ts`.
- **Mock**: simulated LULD halts (a burst of ≥ 8 %) and news halts (T1), a quoting phase, a reopen gap, seeded earlier halts, and `MOCK_HALT_SECONDS`.
- `IngestionService` and `ClientGateway` accept a `HaltTracker` and forward the data.

- `src/index.ts` wires `HaltTracker` in (halt / resume alerts via `alerts.raise`, the countdown uses `MOCK_HALT_SECONDS` on mock) and samples momentum every second.
- **Web**: `marketData` keeps `halts` (`onHalts` listener); `panels/HaltPanel.tsx` is in **+ Window → Halts** and is a tab next to Alerts in the default layout (a saved layout needs **Reset layout** to pick it up); HALT / RESUME chips in `alertMeta.ts`.
- `Popover` portals to the document body and scrolls, so the dropdowns are no longer clipped by dockview panels.
- **Mock price model**: prices mean-revert toward their seeded level (`MEAN_REVERSION`). Before this, prices compounded without limit (+10,000% within 40 min). Halts are spaced at least 2 min apart market-wide (`MIN_HALT_SPACING_MS`).

- **Momentum scanner** (`presets.ts`, thresholds in `MOMENTUM`): a multi-strategy filter (up ≥ 5 %, RVOL ≥ 2×, within 2 % of HOD, rising over 5 m, not halted), sorted by 5m %. New columns are `chg1mPct`, `chg5mPct` and `tier` (SUB $1 / LOW FLT / LARGE, thresholds in `TIERS` in `columns.ts`), plus a HALT badge in the Symbol cell. On the 56-symbol mock it usually shows 0–3 rows, because most movers have pulled back from their HOD.

- **Named layouts**: the Layouts menu (grid icon, top right) saves, opens, updates and deletes them, and replaces the old reset button. They're stored in `localStorage` (`deltascan.layouts.v1`) through `saveLayoutAs` / `loadLayout` / `deleteLayout` in `lib/layout.ts`. That's per browser; moving them to SQLite is part of ARCHITECTURE step 10.

- **Extended hours**: `sessionClock.tradeSessionAt` / `marketSessionAt` classify by ET time (holidays aren't modelled). `SymbolStore` books pre/post prints into `pre*` / `post*` fields and `regularClose`. Those prints move `last` and `changePct` but not the regular open/high/low/volume/VWAP. NHOD / NLOD / VWAP alerts only run on regular prints. The session reaches the UI through `hello` and `stats`. The scanners are **Pre-market Gainers** and **After-hours Movers** (thresholds in `EXTENDED` in `presets.ts`). `MOCK_SESSION=pre|regular|post` picks the session the simulator runs.

- **Charts**: `panels/ChartPanel.tsx` (lightweight-charts 5.2) with calculations in `lib/chartData.ts`.
  - `SymbolStore` builds 1-minute bars from every trade, tagged with `session` (`DEFAULT_MAX_BARS` 2,400, about 2½ days).
  - History is served at `GET /api/bars?symbol=` (proxied by Vite). Live bars go only to clients that sent `{ type: 'chart', symbols }`.
  - The mock emits a `history` event: the previous day's session plus today so far. Its paths pass exactly through the seeded open, high, low and last, but timestamps end at the real "now", so on mock the axis shows wall-clock times.
  - Line series join across empty points and a segment takes its *starting* point's color, so VWAP breaks are drawn with hidden points (see `vwapPoint`).
  - Not built yet: drawing tools, a daily timeframe (needs the REST bootstrap, ARCHITECTURE step 2), multi-pane indicators (RSI/MACD) and saved chart templates.

- **Dilution window**: `panels/DilutionPanel.tsx`.
  - Server: `fundamentals/SecClient.ts` fetches SEC EDGAR (rate-limited, 6 h cache, needs `SEC_USER_AGENT`). `fundamentals/dilution.ts` is a pure builder (tests in `test/dilution.test.ts`). The endpoint is `GET /api/dilution?symbol=`; it returns 503 when not configured and 404 for unknown tickers, including the mock's made-up ones.
  - Score heuristics: runway is skipped for SIC 6000–6799 (financials). Prospectus and shelf filings don't count for issuers with an S-3ASR (well-known seasoned issuers, usually debt deals). Share growth is measured from the last >40 % drop, because XBRL isn't split-adjusted.
  - Filing text: `filingsToRead` (dilution.ts) picks 8-Ks with item 5.03/3.03 and 424B prospectuses; `SecClient.filingDetails` fetches them and `parseReverseSplit` / `parseOfferingAmount` (filingText.ts) read the split ratio, effective date, shares after, and offering size. Counts before an 8-K-announced split are divided by its ratio (`shareHistory[].adjusted`) only when the counts show the drop; ratios estimated from share counts are shown but never used to adjust. The `compliance` rating comes from 8-K 3.01 notices, late filings and recent splits; the web side raises it to medium under $1 (`lib/dilutionView.ts`).
  - Burn is trailing-twelve-month operating cash flow (last fiscal year − prior-year YTD + current YTD), falling back to the latest period; a single quarter swings with working capital. `sectorFromSic` maps the SIC code to a broad sector.
  - The top of the tracker is a summary card laid out like the trader's reference: the name and Overall Offering Risk, then Company | Dilution Risk side by side, then Cash Position. Price, Mkt Cap and Float need the symbol in the live feed.
  - The tracker shows the ratings grid (`components/RiskRatings.tsx`), a cash-position sentence, float/market-cap labels, China yes/no, a share-count timeline with splits, and offering amounts on the filings. Insider ownership isn't built: it isn't in SEC's structured data.
  - **+ Window → Dilution tracker** docks it in the layout (`addDilutionWindow`: a tab beside Symbol/Chart, or on the right) and focuses an existing one instead of duplicating it. Only the double-click quote card pops out.

- **Short-side tools** (the trader fades low-float runners: Spike → Extension → Rejection → Confirmation → Fade, prime window 9:30–10:30, DAS Trader Pro).
  - `scanner/FadeDetector.ts` runs every second on completed 1-minute bars; the stage goes on `SymbolSnapshot.fade`. It fires `topping` (the starter-size signal on entering Rejection: a topping tail near the high, a reversal candle at the high closing in the bottom 30 % of a ≥ 3 % range, or a stall under it with a red bar breaking the prior low; none of them alert once the close is 15 %+ off the high), `rejection_confirmed`, `vwap_break` (the first 1-minute close under VWAP after the top, `FadeState.vwapBroken`, cleared by a close back over VWAP; the trader's main add), `failed_bounce` (on the backside, a bounce retracing ≥ 25 % of the drop makes a lower high under the rejection high, then a red bar breaks the prior low within 3 bars; `FadeState.lowerHigh`) and `vwap_bounce` alerts, and replays backfill silently.
  - The chart draws the setup from `fade` (`lib/fadeSignals.ts`): HOD, RISK (rejection high), CONFIRMS < (rejection low) and LH · ADD RISK price lines, TOP / CONF / LH / VWAP markers from the alert feed, and a stage badge whose text and tooltip follow the trader's scale-in (`stageAdvice`): a front-side starter of `shortLimits.starterPct` (default 30 %, editable in the short calculator's limits) on the top, the rest on the VWAP break.
  - The detector's price floor duplicates `FADE` in `apps/web/src/scanners/fade.ts`; keep them in sync. There's no float filter (the trader asked for it removed); the scanner alone keeps a $5M market-cap floor.
  - Scanners are `fade-setups` and `backside-vwap`; columns are `fadeStage`, `offHighPct` and `sinceHighMin`.
  - `panels/ShortCalcPanel.tsx` + `lib/shortPlan.ts` (tests in `shortPlan.test.ts`; the web workspace now runs vitest too). Limits live in `settings.shortLimits`; the persist `merge` layers saved settings over the defaults.
  - Not built yet: an overhang badge and warrant/conversion price lines on the chart, a 9:30–10:30 focus highlight, UI editing of detector thresholds, and DAS position sync.

- **Quote card**: `panels/QuotePanel.tsx`. Row double-click (Filter, Alert and Halt panels) calls `openQuoteFor` in `lib/layout.ts`, which pops out one window per symbol and focuses it if it already exists. The card uses the live snapshot plus `DilutionReport.ratings` / `foreignFiler` from `dilution.ts`. SSR is computed client-side (low ≤ 90 % of prevClose; carry-over from the prior day isn't tracked). Gap analysis and news aren't built yet: they need daily bars and a news feed (Alpaca has both).

- **Layout files**: `saveLayoutToFile` / `loadLayoutFromText` in `lib/layout.ts`. The JSON has `{ app: 'DeltaScan', kind: 'layout', version: 1, name, savedAt, layout }`. It uses `showSaveFilePicker` when available (call it straight from the click, since it needs the user gesture) and falls back to a download. A one-line notice bar (`uiStore.showNotice`) reports results.

- **Company profile & news**: `GET /api/profile` → `CompanyProfile`, served by `fundamentals/ProfileService.ts`.
  - It merges `SecClient.profile`: description from the annual report (≤ 5 MB streamed; SEC ignores Range headers), country, incorporation, ADR from the cover page, and EX-99.1 press releases from recent 8-K / 6-K filings.
  - Alpaca news (`AlpacaNews.ts`) is added when the Alpaca keys are set; its live behaviour hasn't been tested yet.
  - Parsers are in `fundamentals/filingText.ts` (tests in `test/filingText.test.ts`). The web side is `components/CompanyInfo.tsx`.
  - When editing regex-heavy files with Python, use a quoted heredoc and raw strings: `` once became a literal backspace byte.

- **Tape strip** (top of the Dilution tracker): `components/TapeStrip.tsx`, with the logic in `lib/tape.ts` (`readTape`, tests in `tape.test.ts`).
  - Minute bars come from `marketData.watchMinuteBars` / `getMinuteBars` via `useSyncExternalStore`: a shared, ref-counted store that loads history once, merges live bars and notifies at most once a second.
  - Don't keep bar data in component refs that effects reset: under React dev double-mounting inside dockview, the visible copy froze on "Waiting for bars…".
  - Share class (e.g. "Class A") isn't in SEC's structured data.

- **Ticker tape**: `components/TickerTape.tsx` under the top bar (Settings → Display → Scrolling ticker). It scrolls with requestAnimationFrame over two copies of the list. Prices refresh every second, the symbol list (`pickTapeSymbols` in `lib/tickerTape.ts`) every 10 s. Hover pauses it, and with reduced motion it becomes a static strip you can scroll.

- **Bullish scanners** (Trade Ideas-style, the early warning for future fades): New Highs on 2× RV, Up 50¢ in 5 Min, Under $20 Moving Up Fast, Turbo Breaks Up, Rallying off the Bottom. Thresholds are in `BULLISH` in `presets.ts` (tests in `presets.test.ts`); new columns `chg5mUsd` and `offLowPct`. Scans needing daily bars (yearly highs, up 5 days, MA breakouts), RSI or an earnings calendar wait on ARCHITECTURE steps 2–3.

- **Price filter**: each scanner window has its own price range (the **$ Price** button in its toolbar), applied on top of the scanner's filter, in `FilterPanelParams.priceRange`, so it's saved with layouts. Logic and quick ranges are in `scanners/priceRange.ts`. Symbols with no price yet are hidden while a range is set. A **Float** button beside it works the same way (`FilterPanelParams.floatRange`, `scanners/floatRange.ts`; bounds typed in millions or with K/M); unknown floats pass, because the live feed has no float data yet.

### Still to do (in order)
1. Run `npm test` and `npm run typecheck`, check it in the browser with `npm run dev`, then merge into `main`.
2. Later: check `ALPACA_STATUSES=true` against a real Alpaca plan, since an unsupported channel makes Alpaca reject the whole subscription.
3. Possibly: make the tab close button (×) visible without hovering. It's hidden until you hover the tab, so it's hard to find.

Status: **tests pass (65 server, 36 web), typecheck clean.**

### After this feature
Continue the plan in docs/ARCHITECTURE.md §5. The open steps are 1 (live Alpaca verification), 2 (REST bootstrap), 3 (indicators), 4 (reference data + SQLite) and 5 (server-side scanner engine).
