# DeltaScan

Real-time day and swing trading scanner, inspired by Trade Ideas, Scanz and Day Trade Dash.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the stack, design and roadmap.

## Layout

```
deltascan/
├─ apps/
│  ├─ server/                 Node data engine (ws://localhost:4000/ws)
│  │  ├─ src/config/env.ts    typed + validated environment
│  │  ├─ src/ingestion/       ReconnectingSocket, providers (alpaca, mock), IngestionService
│  │  ├─ src/cache/           SymbolStore — in-memory live state + dirty-set throttling
│  │  ├─ src/scanner/         AlertEngine — edge-triggered alerts with cooldowns
│  │  ├─ src/gateway/         ClientGateway — batched deltas to the UI every 250 ms
│  │  └─ test/
│  └─ web/                    React UI (http://localhost:5173)
│     ├─ src/lib/marketData.ts   single WS client; ticks live outside React, flushed per frame
│     ├─ src/scanners/        column catalog, cell renderers, scanner presets
│     ├─ src/panels/          Filter, Alert and Symbol windows
│     └─ src/components/      Workspace (dockview), TopBar, StatusBar
├─ packages/
│  └─ shared/                 types shared by server and web
├─ docs/ARCHITECTURE.md
└─ .env.example
```

## Quick start

```bash
npm install
npm run dev              # server + UI, simulated market data, no keys needed
# open http://localhost:5173
npm test
npm run typecheck
```

### Using the UI

- **+ Window** opens any scanner, an alert window or a symbol detail window. New windows open floating; drag a tab to dock it.
- Each window's header can **float**, **pop out** to a separate OS window (for multiple monitors), or **maximize** it.
- The **scanner dropdown** in a window's toolbar switches the scan. The **columns** button shows or hides columns. Drag headers to reorder.
- **Clicking a row** selects that symbol everywhere and loads it in the Symbol panel. Arrow keys also work.
- **Alert chips** filter by type. The speaker on each chip turns that type's sound on or off. The first sound plays after your first click on the page, because browsers block audio before that.
- Layout, column setup and settings are saved automatically. The **Layouts** menu (grid icon, top right) saves named layouts and resets to the default.

### Charts

**+ Window → Chart** opens a candlestick chart. It's also a tab next to Symbol in the default layout, and it uses [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts).
- **Symbol:** the chart follows the symbol you select in any scanner or alert window. Click the link icon to pin it to its current symbol, or type a ticker in its symbol box.
- **Timeframes:** 1m, 5m, 15m and 1h.
- **Indicators:** VWAP (regular session, resets daily), EMA 9, EMA 20 and volume.
- **Ext hrs:** shows or hides pre-market and after-hours bars. When shown, they're drawn faded.
- **Readout:** hovering shows that bar's open, high, low and close, its % change and the indicator values.

### Pre-market and after-hours scanners

**Pre-market Gainers** ranks stocks by their move before the 9:30 open. **After-hours Movers** ranks them by their move since the 4 pm close. On live data they fill in during those hours (4:00–9:30 and 16:00–20:00 ET). To try them on simulated data at any time, set `MOCK_SESSION=pre` or `MOCK_SESSION=post` in `.env` and restart `npm run dev`.

Outside regular hours, scans built on the regular session (Gap Ups, RVOL, HOD, VWAP) and their alerts stay quiet, because those numbers only count 9:30–16:00 trading.

## Using live Alpaca data

1. Create a free account at <https://alpaca.markets>, open the **Paper** dashboard and generate API keys.
2. In `.env`, set `DATA_PROVIDER=alpaca` and add `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY`.
3. To test outside market hours, set `ALPACA_FEED=test` and `WATCHLIST=FAKEPACA`.
4. During market hours, use `ALPACA_FEED=iex` with up to about 30 symbols.

Alpaca allows **one** stream connection per account. Running two copies of the server, or a notebook using the same keys, causes error `406 connection limit exceeded`.
