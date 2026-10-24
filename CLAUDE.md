# DeltaScan: notes for Claude

A real-time scanner for day and swing trading, modelled on Trade Ideas, Scanz and Day Trade Dash. It's an npm-workspaces monorepo on Node ≥ 22.
- [README.md](README.md) covers layout, quick start, the UI and Alpaca setup.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the stack, design decisions, the data-feed reality check and the **step-by-step implementation plan**.

## Commands

```bash
npm run dev          # server (ws://localhost:4000/ws) + web (http://localhost:5173), mock data, no keys
npm test             # vitest, server only (apps/server/test)
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

### Still to do (in order)
1. **Fix the server typecheck.** `apps/server/src/index.ts` hasn't been updated:
   - create `const halts = new HaltTracker({ onHalt, onResume })`, wiring `onHalt` / `onResume` to `alerts.raise('halt' | 'resume', …)`
   - pass `halts` to `new IngestionService(env, store, alerts, halts, logger, …)`, which currently breaks the argument order
   - pass `halts` to `ClientGateway`
   - add `setInterval(() => store.sampleMomentum(), 1_000)` and clear it in `shutdown()`
2. **Fix the mock typecheck.** At `MockProvider.ts:242`, `sim.burstDir = dir` is typed as `number`. Type `dir` as `1 | -1` in `advanceHalt`.
3. **Fix the web typecheck.** `apps/web/src/lib/alertMeta.ts` needs `halt` and `resume` entries.
4. **Web UI:**
   - handle `hello.halts` and the `halts` message in `lib/marketData.ts`
   - add a **Halts window** panel (symbol, reason, direction, halted at, countdown to `expectedResumeAt`, halt %, resume gap %) and register it in **+ Window**
   - add `chg1mPct` / `chg5mPct` columns and a halted badge in `scanners/columns.ts` / `cells.tsx`, and possibly a momentum preset in `presets.ts`
5. Run `npm test` and `npm run typecheck`, check it in the browser with `npm run dev` (a halt should appear in the mock within a few minutes; one is seeded live at startup), then commit.
6. Later: check `ALPACA_STATUSES=true` against a real Alpaca plan, since an unsupported channel makes Alpaca reject the whole subscription.

Status when we stopped: **tests pass (17/17); typecheck fails** for the reasons in items 1–3.

### After this feature
Continue the plan in docs/ARCHITECTURE.md §5. The open steps are 1 (live Alpaca verification), 2 (REST bootstrap), 3 (indicators), 4 (reference data + SQLite) and 5 (server-side scanner engine).
