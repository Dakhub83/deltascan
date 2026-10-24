# Architecture

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere (npm workspaces monorepo) | One type system from the wire format to the grid cell. `packages/shared` holds the shared types. |
| Backend runtime | **Node.js 22** + `ws` | Fast enough for thousands of ticks/sec on a single core. `ws` is the lowest-overhead WebSocket lib for Node. |
| Config | `dotenv` + **zod** | The server refuses to start on a bad `.env`, and the config is fully typed. |
| Logging | **pino** | Structured logging that adds very little overhead on the hot path. |
| Market data | **Alpaca Market Data v2** (default), plus a **mock** provider | Free paper account, an IEX real-time WebSocket and a 24/7 test stream. Behind a `MarketDataProvider` interface, so Polygon can be swapped in. |
| Reference data | Polygon / Finnhub / FMP (step 4) | Alpaca doesn't provide float, short interest or market cap. |
| Persistence | **SQLite** via `better-sqlite3` (step 4+) | Stores layouts, scanner definitions, alert history and the reference-data cache. Synchronous and fast, with nothing to run separately. |
| Frontend | **React 18 + Vite + Tailwind CSS + Lucide** | Fast HMR, a small bundle, and dark theme tokens set in Tailwind. |
| Data grid | **AG Grid Community** | Virtualized rows, `applyTransactionAsync` batching, and built-in sorting, column pinning and resizing. It handles hundreds of row updates/sec without re-rendering React. |
| Docking layout | **dockview** | Trade Ideas-style tiled, tabbed and floating panels, with **pop-out windows** for multiple monitors. |
| UI state | **Zustand** | For UI and config state only. Tick data **bypasses React state** (see §3). |
| Desktop shell | Local web app first, **Electron** wrapper later (step 12) | Same code either way. Electron adds native notifications, tray, always-on-top and multi-monitor window placement. |
| Tests | **vitest** | |

## 2. System diagram

```
┌──────────────────────────── apps/server (Node) ────────────────────────────┐
│                                                                            │
│  Alpaca WS ──► ReconnectingSocket ──► AlpacaStreamProvider ─┐              │
│  (1 conn/acct)  backoff+jitter,        auth, resubscribe,   │ normalized   │
│                 ping/pong heartbeat    parse → Trade/Quote/Bar  events     │
│                                                             ▼              │
│  MockProvider ─────────────────────────────────────► IngestionService      │
│                                                             │              │
│                                                             ▼              │
│  REST bootstrap (step 2) ──► SymbolStore (in-memory, O(1)/tick, dirty-set) │
│  prev close, hist bars          │                 │                        │
│                                 ▼                 ▼                        │
│              IndicatorEngine (step 3)     ReferenceData + SQLite (step 4)  │
│              EMA/RSI/MACD/ATR/BB/VWAP     float, SI, mcap, avg vol         │
│                                 │                 │                        │
│                                 └──────┬──────────┘                        │
│                                        ▼                                   │
│                          ScannerEngine (step 5)                            │
│                 ┌─ Filter windows: predicate + sort + top-N                │
│                 └─ Alert windows: edge-triggered events + cooldown         │
│                                        │                                   │
│                          ClientGateway (step 6) — every 250 ms:            │
│                          only the deltas each client subscribed to         │
└────────────────────────────────────────┼───────────────────────────────────┘
                                         │ ws://localhost:4000
┌──────────────────────────── apps/web (React) ──────────────────────────────┐
│  WS client ──► row store (mutable Map, outside React)                      │
│                   │ requestAnimationFrame flush                            │
│                   ▼                                                        │
│  dockview layout ─► FilterWindow (AG Grid transactions)                    │
│                   ─► AlertWindow (virtual list, sound, notifications)      │
│                   ─► ScannerBuilder, Settings (Zustand)                    │
└────────────────────────────────────────────────────────────────────────────┘
```

## 3. Key design decisions

1. **All scanning happens on the server.** Alpaca allows one stream connection per account, and scan rules should run once rather than once per window. The browser only renders.
2. **Throttling in two stages.**
   - Server: `SymbolStore` marks symbols dirty, and the gateway drains them every `BROADCAST_INTERVAL_MS` (default 250 ms). A symbol printing 5,000 trades/sec still sends at most 4 updates/sec.
   - Client: incoming deltas go into a plain mutable `Map`. One `requestAnimationFrame` loop pushes them into AG Grid with `applyTransactionAsync`. React never re-renders per tick.
3. **Alerts are edge-triggered.** An alert fires when its condition goes from false to true. It then has a per-symbol cooldown and needs hysteresis to re-arm (for example, a new high of day must clear the prior high by at least one tick). Filter windows are level-based: membership is re-evaluated every cycle.
4. **Providers are pluggable.** Everything downstream sees only `Trade`, `Quote` and `Bar`. A new data source is one class.
5. **Resilience lives below the protocol layer.** `ReconnectingSocket` handles backoff, jitter and the heartbeat, and stays provider-agnostic. Providers own auth and restore the full subscription set on every `authenticated` event.
6. **Indicators update incrementally.** Each new 1-minute bar updates EMA, RSI and the others in O(1). Indicators are not recomputed over history.

## 4. Data reality check (read before trading on it)

| Need | Alpaca free (IEX) | What's actually required |
|---|---|---|
| Real-time price | ✅ Accurate enough for liquid names | |
| Volume, RVOL, HOD/LOD | ⚠️ IEX is only about 2–3% of US volume, so these are understated | **SIP** feed: Alpaca Algo Trader Plus, or Polygon Stocks Developer and up |
| Whole-market scanning (8k+ symbols) | ❌ About 30-symbol limit on trades/quotes | SIP plus a wildcard subscription (`*`) |
| Pre-market data | ✅ IEX, thin | SIP |
| Level 2 / order book | ❌ Not offered for equities | A separate vendor (for example Databento or IEX DEEP). Deferred. |
| Float, short interest, market cap | ❌ | Polygon / FMP / Finnhub reference endpoints (step 4) |
| Unusual options activity | ⚠️ Indicative options feed only | OPRA feed (paid) |
| Block trades | ✅ Can be derived from trade size and condition codes | |

The mock provider plus the free IEX feed is enough to build and test every feature. The paid SIP feed only matters once you rely on the scanner for real trades.

## 5. Implementation plan

Each step is small enough for one Claude Code session and ends with passing tests and a runnable app.

| # | Step | Deliverable |
|---|---|---|
| 0 | ✅ **Scaffold + ingestion core** | Monorepo, typed env, `ReconnectingSocket`, Alpaca + mock providers, `SymbolStore`, tests |
| 1 | **Live Alpaca verification** | Connect to the `test` feed (FAKEPACA), then `iex`. Filter trade condition codes that shouldn't update last/HOD/volume (odd lot, out-of-sequence, and so on). Add a stale-data watchdog during market hours. Unit-test the parser against recorded messages. |
| 2 | **REST bootstrap** | On startup and reconnect, pull snapshots (prev close, today's OHLCV) and about 2 days of 1-min bars to seed the store and warm up indicators. Add a market session clock (pre/regular/post) and a daily `resetSession()`. |
| 3 | **Indicator engine** | Incremental EMA 9/20/50/200, RSI(14, Wilder), MACD(12,26,9), ATR(14), Bollinger(20,2) and session VWAP on 1-min bars, plus daily ATR. Golden-value tests. |
| 4 | **Reference data + SQLite** | `better-sqlite3` schema and migrations. Daily fetch of float, short interest, market cap and 10/30-day average volume. Derive RVOL (time-of-day adjusted), gap %, pre-market volume and pre-market high. |
| UI | ✅ **UI pass (out of order, on mock data)** | Covers the client gateway, web scaffold, filter windows, alert window and layouts (steps 6–10, minus SQLite persistence). Filter windows currently filter in the browser, which is fine for a watchlist. Whole-market scans move to the server in step 5. |
| 5 | **Scanner engine** | JSON filter DSL (`{ field, op, value }` with AND/OR groups). Filter windows: predicate + sort + limit. Alerts: NHOD, NLOD, volume spike, VWAP cross, gap up/down, block trade, halt-like gap. Includes edge triggering, cooldowns and tests. |
| 6 | **Client gateway** | WS server on `SERVER_PORT`. Clients subscribe to window IDs and receive only the relevant row deltas every 250 ms. Includes backpressure (drop and coalesce if `bufferedAmount` grows) and a REST API for scanner CRUD. |
| 7 | **Web scaffold** | Vite + React + Tailwind dark theme, WS client with reconnect, connection status bar, Zustand store. |
| 8 | **Filter window** | AG Grid with rAF-batched transactions, flash-on-change cells, column chooser, per-window sort. |
| 9 | **Alert window** | Virtualized event feed, per-alert sounds (Web Audio), desktop notifications, click to focus the symbol. |
| 10 | **Layouts** | dockview multi-panel and pop-outs. Save and load named layouts to SQLite. |
| 11 | **Scanner builder UI** | Visual filter editor with live preview count, presets ("Gap & Go", "Low-float runners", "VWAP reclaim"). |
| 12 | **Electron shell** | Native notifications, tray, window state restore, packaged installer. |
| 13 | **Upgrades** | SIP plus wildcard full-market scan, options flow, L2 vendor, symbol charting (lightweight-charts). |
