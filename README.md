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
│  │  ├─ src/gateway/         ClientGateway — batched deltas to the UI every 250 ms; AppApi — accounts, watchlists, layouts
│  │  ├─ src/db/              AppDb — SQLite (users, sessions, watchlists, layouts, alert history)
│  │  ├─ src/auth/            Auth — password hashing, session cookies, sign-in rate limit
│  │  └─ test/
│  └─ web/                    landing page (http://localhost:5173) and dashboard (/app/)
│     ├─ src/landing/         the marketing page
│     ├─ src/lib/marketData.ts   single WS client; ticks live outside React, flushed per frame
│     ├─ src/scanners/        column catalog, cell renderers, scanner presets
│     ├─ src/panels/          Filter, Alert and Symbol windows
│     └─ src/components/      Workspace (dockview), TopBar, StatusBar
├─ packages/
│  └─ shared/                 types shared by server and web
├─ docs/ARCHITECTURE.md
├─ docs/DEPLOY.md           putting it online over HTTPS (Docker + Caddy)
└─ .env.example
```

## Quick start

```bash
npm install
npm run dev              # server + UI, simulated market data, no keys needed
# landing page: http://localhost:5173    dashboard: http://localhost:5173/app/
npm test
npm run typecheck
```

### Running it without an editor (Windows)

Double-click **`start-deltascan.cmd`** in the project folder. It installs dependencies on the first run, rebuilds the site when the code has changed (about 30 s), starts the server with the settings in `.env`, and opens http://localhost:4000 (the landing page; the dashboard is at `/app/`). Close the window to stop it.

- For simulated data, run `start-deltascan mock` from a terminal in the project folder. It uses its own database (`data/mock.db`).
- Alpaca allows one stream connection per account, so with live data stop any `npm run dev` before starting it, or the second one gets `406 connection limit exceeded`.
- To start it from the desktop, right-click the file → **Show more options → Send to → Desktop (create shortcut)**. To give the shortcut the DeltaScan logo, right-click it → **Properties → Change Icon…** and pick `deltascan.ico` from the project folder.

### Using the UI

- **+ Window** opens any scanner, an alert window or a symbol detail window. New windows open floating; drag a tab to dock it.
- Each window's header can **float**, **pop out** to a separate OS window (for multiple monitors), or **maximize** it.
- The **scanner dropdown** in a window's toolbar switches the scan. The **columns** button shows or hides columns. Drag headers to reorder.
- **Clicking a row** selects that symbol everywhere and loads it in the Symbol panel. Arrow keys also work.
- **Alert chips** filter by type. The speaker on each chip turns that type's sound on or off. The first sound plays after your first click on the page, because browsers block audio before that.
- Layout, column setup and settings are saved automatically. The **Layouts** menu (grid icon, top right) has three options:
  - **Named layouts:** saved on the server under your account, so they follow you to other devices. Layouts saved in the browser before this are moved there the first time the dashboard opens.
  - **Save layout to file…:** opens a Save dialog in Chrome and Edge so you can pick the folder; other browsers download the file. **Open layout file…** loads a saved file back.
  - **Default layout:** resets everything.

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

**+ Window → Dilution tracker** opens a dilution report as a tab in the layout, next to Symbol and Chart. Drag it anywhere, or use the window's pop-out button to move it to another monitor. It follows the symbol you click, like the chart.

To keep a tracker beside a particular window, press the **panel** button (a square with a bar on the right) in that window's header. A docked window gets the tracker split off on its right, and a floating window gets one against its right edge. It follows the symbol you click; press the button again to remove it.
- **Risk score:** a 0–10 score with the reason behind each point. It weighs cash runway, recent offerings, unregistered equity sales, share-count growth, reverse splits, warrants, convertible debt, delisting notices and late filings.
- **At a glance:** market cap, shares outstanding, cash, monthly burn, runway, warrants, preferred shares and convertible debt.
- **Filings:** the last 12 months of dilution-related SEC filings, each linking to the original on sec.gov.

At the top, the tracker shows a live tape strip. It appears for any streamed symbol, with or without SEC data:
- **Ticker:** sector, country and float.
- **Price:** last price and % change.
- **Trend:** the last 60 minutes of price and volume.
- **Control:** buyers vs sellers, scored 0–100 from where the last 15 one-minute bars closed within their range, weighted by volume. It also shows whether volume is expanding or contracting, the momentum, and a status line such as "▲ RUNNING through $0.99 · 50×+ vol", "▼ REJECTED at $x" or "Below VWAP $x".

Both the Dilution window and the quote card also show:
- **Company description:** the opening of the latest 10-K or 20-F Business section, with a link to the report.
- **Country, place of incorporation, and ADR yes/no:** ADR status comes from the annual report's cover, which lists American Depositary Shares when the stock trades as an ADR.
- **Latest news:** headlines and summaries of the company's own press releases from its 8-K and 6-K filings over the last 60 days. With `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` in `.env`, Alpaca's newswire headlines are merged in too, newest first, with duplicates removed.

Descriptions are pulled from the filing text by DeltaScan's own rules. They're reliable for most 10-K filers, and rougher for some foreign 20-F filers.

The data comes free from SEC EDGAR. SEC requires a contact on every request, so set `SEC_USER_AGENT="DeltaScan you@example.com"` (with your own email) in `.env` and restart. SEC figures lag the latest filings and aren't split-adjusted. The report doesn't break out individual convertible notes or show float and institutional ownership; those need a paid data provider.

### Pre-market and after-hours scanners

**Pre-market Gainers** ranks stocks by their move before the 9:30 open. **After-hours Movers** ranks them by their move since the 4 pm close. On live data they fill in during those hours (4:00–9:30 and 16:00–20:00 ET). To try them on simulated data at any time, set `MOCK_SESSION=pre` or `MOCK_SESSION=post` in `.env` and restart `npm run dev`.

Outside regular hours, scans built on the regular session (Gap Ups, RVOL, HOD, VWAP) and their alerts stay quiet, because those numbers only count 9:30–16:00 trading.

### Watchlist, indicators and saved data

- **+ Window → My watchlist** keeps the tickers you add, saved on the server. Watched symbols stay in the data feed even when they aren't moving.
- Every scanner window has an **Indicators** button next to Price and Float. It filters on RSI(14), the EMA 9/20 cross (bullish or bearish, within N minutes) and relative volume. All three are computed on completed 1-minute bars. The **RSI**, **EMA 9/20**, **EMA 9** and **EMA 20** columns are in the columns menu.
- Two scanners use them: **RSI Overbought Runners** (up 10 %+ with RSI ≥ 80) and **EMA 9/20 Bear Cross** (up 10 %+, the 9 crossed under the 20 in the last 15 minutes).
- Alerts are saved to the database, so the day's alert feed survives a server restart.

### Accounts

Locally, sign-in is off: there's no login screen, and your watchlist and layouts are saved to a built-in local account. Data lives in `data/scanner.db` (`DB_PATH`).

| Setting | Default | What it does |
|---|---|---|
| `AUTH_REQUIRED` | `false` | Require sign-in for the dashboard, its API and the live data socket. Turn it on before the app is reachable from the internet. |
| `ALLOW_SIGNUP` | `false` | Let anyone create an account. When it's off, only the first account can be created. |
| `COOKIE_SECURE` / `TRUST_PROXY` | `false` | Set both when serving over HTTPS behind a reverse proxy. |
| `SERVE_WEB` | `false` | Serve the built site (`npm run build`) from the server port, for production. |

To put DeltaScan online, see [docs/DEPLOY.md](docs/DEPLOY.md).

## Using live Alpaca data

1. Create a free account at <https://alpaca.markets>, open the **Paper** dashboard and generate API keys.
2. In `.env`, set `DATA_PROVIDER=alpaca` and add `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY`.
3. To test outside market hours, set `ALPACA_FEED=test` and `WATCHLIST=FAKEPACA`.
4. During market hours, use `ALPACA_FEED=iex` with up to about 30 symbols.

On startup (and after every reconnect) the server loads each symbol's previous close, today's session so far and about four days of 1-minute bars over Alpaca's REST API, so % change, gap, RVOL, charts and the short signals work right away. It adds the market's top gainers every minute, and a **radar** watches every stock's 1-minute bars (free on Alpaca: bars don't count toward the symbol limit), so a stock that starts running shows up within about a minute even before it reaches the gainers list. The plan's few live trade slots rotate to whatever is moving hardest; the other rows keep updating once a minute from bars:

| Setting | Default | What it does |
|---|---|---|
| `ALPACA_MOVERS_TOP` | `20` | How many of Alpaca's top % gainers to add per refresh. `0` streams `WATCHLIST` only. |
| `ALPACA_MOVERS_REFRESH_SEC` | `60` | How often the gainers list is checked. Rows are only added, never dropped mid-session. |
| `ALPACA_RADAR` | `true` | Watch every stock's minute bars and rotate the live slots to the fastest movers. `false` = gainers list only, added until the limit is full. |
| `ALPACA_RADAR_MOVE_PCT` | `4` | A move of this many % (up or down) within 5 minutes puts a stock on the radar. |
| `ALPACA_PREV_AH_TOP` | `30` | After each session ends, the whole market's after-hours moves are read from full-market history (free on Alpaca once 15 minutes old). Every row gets them (**Prev AH %**, **Prev AH Last**, **Prev AH High**, **Prev AH Vol** columns) and the top gainers become rows for the **Prev Day AH Gainers** scanner. `0` turns it off. |
| `ALPACA_PREV_AH_MIN_PCT` | `5` | Minimum after-hours gain, vs the 4 PM price, for that list. |
| `ALPACA_MAX_SYMBOLS` | `30` | The plan's limit on trade + quote subscriptions, `WATCHLIST` included. 30 on the free `iex` feed (bars don't count); raise it on a paid `sip` plan. |
| `ALPACA_QUOTES` | `false` | Stream bid/ask quotes too (spread, quote card). On the free plan this halves the symbols, since trades and quotes share the limit. |

Float, market cap and short interest are not available from Alpaca, so those columns stay empty on live data.

Alpaca allows **one** stream connection per account. Running two copies of the server, or a notebook using the same keys, causes error `406 connection limit exceeded`.
