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

### Quote card (double-click)

**Double-click** a symbol in any scanner, alert or halts list to open its quote card in a separate browser window:
- **Header:** live price and change, company, exchange and country.
- **Flags:** foreign filer, and SSR (on once today's low is 10% below the prior close).
- **Stats:** prev close, market cap, float, shares outstanding, short interest and average volume.
- **Dilution & Risk Ratings:** Overall, Offering, Dilution, Frequency, Cash Need and Warrants.
- **Cash:** cash left, burn rate and estimated cash.
- **Recent splits.**

Each card is pinned to its symbol. Double-clicking a symbol that already has a card brings it to the front. A single click still just selects the symbol.

Institutional and insider ownership need a holdings data provider and show N/A. On live data, float, short interest and average volume also show N/A until a reference-data provider is connected.

### Short-side tools

**Fade Setups** and **Backside VWAP** are scanners for fading low-float runners. The server follows each runner on completed 1-minute bars through these stages:
- **SPIKE:** up 15% or more.
- **EXTENDED:** a new high while 5%+ above VWAP. In pre-market it's any new high.
- **REJECTING:** a red topping candle with a long upper wick, or a stall near the high that breaks the prior bar's low.
- **CONFIRMED:** a later bar closes below the rejection candle's low. This fires a **REJECT ✓** alert.
- **FADING:** 8% or more off the high, or below VWAP.
- **VWAP BOUNCE:** a broken runner rallies back into VWAP from below. This fires a **VWAP BNC** alert.

A few rules keep it safe:
- **Nothing confirms mid-candle.** Only completed bars count.
- **New highs reset it.** A new high above the rejection candle sends the setup back to EXTENDED.
- **No late confirmations.** A confirmation more than 15% off the high is treated as the back side, with no alert.
- **Floors.** Names under $1, with a float under 2M or over 30M, or a market cap under $5M are skipped.
- **LATE flag.** Rows are marked LATE once they're 25% off the high or 45 minutes past it.

The scanner floors and LATE thresholds are in `FADE` (`apps/web/src/scanners/fade.ts`). The stage thresholds are in `FadeDetector.ts`.

**+ Window → Short calc** plans a pyramided short:
- **Planning:** you enter the stop and first entry, then your add zones *before* you get in.
- **Sizing:** it sizes every lot so total dollar risk stays fixed, and moves the stop on the whole position to each add's entry + $0.10.
- **Caps and warnings:** it enforces your max shares, max risk and max lots, and caps the total at 100 shares before 9:30. It warns about tight stops (including inside the spread), averaging up and too many lots.
- **DAS prices:** it shows the prices for your DAS hotkeys (average cost ± $0.03).
- **Limits:** set your own with the gear icon. DeltaScan doesn't see your DAS positions or send orders.

### Dilution window

**+ Window → Dilution** opens a dilution report in its own browser window, so you can keep it on another monitor. It follows the symbol you click, like the chart.
- **Risk score:** a 0–10 score with the reason behind each point. It weighs cash runway, recent offerings, unregistered equity sales, share-count growth, reverse splits, warrants, convertible debt, delisting notices and late filings.
- **At a glance:** market cap, shares outstanding, cash, monthly burn, runway, warrants, preferred shares and convertible debt.
- **Filings:** the last 12 months of dilution-related SEC filings, each linking to the original on sec.gov.

The data comes free from SEC EDGAR. SEC requires a contact on every request, so set `SEC_USER_AGENT="DeltaScan you@example.com"` (with your own email) in `.env` and restart. SEC figures lag the latest filings and aren't split-adjusted. The report doesn't break out individual convertible notes or show float and institutional ownership; those need a paid data provider.

### Pre-market and after-hours scanners

**Pre-market Gainers** ranks stocks by their move before the 9:30 open. **After-hours Movers** ranks them by their move since the 4 pm close. On live data they fill in during those hours (4:00–9:30 and 16:00–20:00 ET). To try them on simulated data at any time, set `MOCK_SESSION=pre` or `MOCK_SESSION=post` in `.env` and restart `npm run dev`.

Outside regular hours, scans built on the regular session (Gap Ups, RVOL, HOD, VWAP) and their alerts stay quiet, because those numbers only count 9:30–16:00 trading.

## Using live Alpaca data

1. Create a free account at <https://alpaca.markets>, open the **Paper** dashboard and generate API keys.
2. In `.env`, set `DATA_PROVIDER=alpaca` and add `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY`.
3. To test outside market hours, set `ALPACA_FEED=test` and `WATCHLIST=FAKEPACA`.
4. During market hours, use `ALPACA_FEED=iex` with up to about 30 symbols.

Alpaca allows **one** stream connection per account. Running two copies of the server, or a notebook using the same keys, causes error `406 connection limit exceeded`.
