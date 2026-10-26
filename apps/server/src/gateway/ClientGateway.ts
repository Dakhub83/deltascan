import { createServer, type Server, type ServerResponse } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { Bar, ClientMessage, CompanyProfile, DilutionReport, MarketSession, ProviderStatus, ServerMessage, ServerStats } from '@deltascan/shared';
import type { Logger } from '../lib/logger';
import type { SymbolStore } from '../cache/SymbolStore';
import type { AlertEngine } from '../scanner/AlertEngine';
import type { HaltTracker } from '../scanner/HaltTracker';

export interface ClientGatewayOptions {
  port: number;
  broadcastIntervalMs: number;
  store: SymbolStore;
  alerts: AlertEngine;
  halts: HaltTracker;
  getStatus: () => ProviderStatus | null;
  getStats: () => ServerStats;
  getSession: () => MarketSession;
  /** Undefined when SEC access isn't configured (no SEC_USER_AGENT). */
  dilution?: (symbol: string) => Promise<DilutionReport | null>;
  /** Undefined when neither SEC nor Alpaca news is configured. */
  profile?: (symbol: string) => Promise<CompanyProfile | null>;
  logger: Logger;
}

/** A slow client above this many buffered bytes is skipped and resynced with a full snapshot. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const STATS_INTERVAL_MS = 1_000;

interface Client {
  ws: WebSocket;
  needsResync: boolean;
  /** Symbols this client has a chart open for; they get live 1-minute bars. */
  charts: Set<string>;
}

/** Caps a client's chart subscriptions so a bad message can't make every flush fan out. */
const MAX_CHARTS_PER_CLIENT = 50;

/**
 * Pushes batched deltas to UI clients over WebSocket (`/ws`).
 * Every tick of `broadcastIntervalMs`: changed snapshots + new alerts, serialized once, sent to all.
 */
export class ClientGateway {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private broadcastTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private readonly log: Logger;

  constructor(private readonly opts: ClientGatewayOptions) {
    this.log = opts.logger.child({ component: 'gateway' });
    this.http = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: this.clients.size, status: opts.getStatus() }));
        return;
      }
      if (url.pathname === '/api/dilution') {
        this.serveLookup(opts.dilution, (url.searchParams.get('symbol') ?? '').toUpperCase(), res, 'SEC_USER_AGENT is not set');
        return;
      }
      if (url.pathname === '/api/profile') {
        this.serveLookup(opts.profile, (url.searchParams.get('symbol') ?? '').toUpperCase(), res, 'Set SEC_USER_AGENT (and optionally Alpaca keys)');
        return;
      }
      if (url.pathname === '/api/bars') {
        const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(opts.store.getBars(symbol)));
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/ws', perMessageDeflate: false });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  start(): void {
    this.http.listen(this.opts.port, () => this.log.info({ port: this.opts.port }, 'client gateway listening'));
    this.broadcastTimer = setInterval(() => this.flush(), this.opts.broadcastIntervalMs);
    this.statsTimer = setInterval(
      () => this.broadcast({ type: 'stats', data: this.opts.getStats() }),
      STATS_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    for (const c of this.clients) c.ws.close(1001, 'server shutdown');
    this.wss.close();
    this.http.close();
  }

  publishStatus(status: ProviderStatus): void {
    this.broadcast({ type: 'status', data: status });
  }

  private onConnection(ws: WebSocket): void {
    const client: Client = { ws, needsResync: false, charts: new Set() };
    this.clients.add(client);
    this.log.info({ clients: this.clients.size }, 'client connected');
    this.sendHello(client);

    ws.on('close', () => {
      this.clients.delete(client);
      this.log.info({ clients: this.clients.size }, 'client disconnected');
    });
    ws.on('error', (err) => this.log.warn({ err: err.message }, 'client socket error'));
    ws.on('message', (raw) => this.onClientMessage(client, raw.toString()));
  }

  private onClientMessage(client: Client, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === 'chart' && Array.isArray(msg.symbols)) {
      const symbols = msg.symbols.filter((s): s is string => typeof s === 'string').slice(0, MAX_CHARTS_PER_CLIENT);
      client.charts = new Set(symbols.map((s) => s.toUpperCase()));
    }
  }

  private sendHello(client: Client): void {
    const msg: ServerMessage = {
      type: 'hello',
      data: {
        snapshots: this.opts.store.all().map((s) => ({ ...s })),
        alerts: this.opts.alerts.recent(),
        halts: this.opts.halts.recent(),
        status: this.opts.getStatus(),
        session: this.opts.getSession(),
        serverTime: Date.now(),
      },
    };
    client.ws.send(JSON.stringify(msg));
    client.needsResync = false;
  }

  private flush(): void {
    const snapshots = this.opts.store.drainDirty();
    const alerts = this.opts.alerts.drain();
    const halts = this.opts.halts.drain();
    if (snapshots.length) this.broadcast({ type: 'snapshots', data: snapshots });
    if (snapshots.length) this.sendChartBars(snapshots.map((s) => s.symbol));
    if (halts.length) this.broadcast({ type: 'halts', data: halts });
    if (alerts.length) this.broadcast({ type: 'alerts', data: alerts });
  }

  /** Symbol lookups backed by SEC / Alpaca: 503 when not configured, 404 for unknown tickers. */
  private serveLookup<T>(lookup: ((symbol: string) => Promise<T | null>) | undefined, symbol: string, res: ServerResponse, setupError: string): void {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!lookup) return send(503, { error: setupError, setup: true });
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return send(400, { error: 'invalid symbol' });
    lookup(symbol)
      .then((value) => (value ? send(200, value) : send(404, { error: `No filings or news for ${symbol}` })))
      .catch((err: Error) => {
        this.log.warn({ symbol, err: err.message }, 'lookup failed');
        send(502, { error: 'SEC EDGAR request failed' });
      });
  }

  /** Live bar updates go only to clients charting that symbol. */
  private sendChartBars(changed: string[]): void {
    for (const client of this.clients) {
      if (!client.charts.size || client.needsResync || client.ws.readyState !== WebSocket.OPEN) continue;
      const bars: Bar[] = [];
      for (const symbol of changed) {
        const bar = client.charts.has(symbol) ? this.opts.store.lastBar(symbol) : undefined;
        if (bar) bars.push({ ...bar });
      }
      if (bars.length) client.ws.send(JSON.stringify({ type: 'bars', data: bars } satisfies ServerMessage));
    }
  }

  private broadcast(msg: ServerMessage): void {
    if (!this.clients.size) return;
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      const { ws } = client;
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.needsResync = true;
        continue;
      }
      if (client.needsResync) {
        this.sendHello(client);
        continue;
      }
      ws.send(payload);
    }
  }
}
