import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { ProviderStatus, ServerMessage } from '@deltascan/shared';
import type { Logger } from '../lib/logger';
import type { SymbolStore } from '../cache/SymbolStore';
import type { AlertEngine } from '../scanner/AlertEngine';

export interface ClientGatewayOptions {
  port: number;
  broadcastIntervalMs: number;
  store: SymbolStore;
  alerts: AlertEngine;
  getStatus: () => ProviderStatus | null;
  getStats: () => { tradesPerSec: number; quotesPerSec: number; symbols: number };
  logger: Logger;
}

/** A slow client above this many buffered bytes is skipped and resynced with a full snapshot. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const STATS_INTERVAL_MS = 1_000;

interface Client {
  ws: WebSocket;
  needsResync: boolean;
}

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
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: this.clients.size, status: opts.getStatus() }));
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
    const client: Client = { ws, needsResync: false };
    this.clients.add(client);
    this.log.info({ clients: this.clients.size }, 'client connected');
    this.sendHello(client);

    ws.on('close', () => {
      this.clients.delete(client);
      this.log.info({ clients: this.clients.size }, 'client disconnected');
    });
    ws.on('error', (err) => this.log.warn({ err: err.message }, 'client socket error'));
  }

  private sendHello(client: Client): void {
    const msg: ServerMessage = {
      type: 'hello',
      data: {
        snapshots: this.opts.store.all().map((s) => ({ ...s })),
        alerts: this.opts.alerts.recent(),
        status: this.opts.getStatus(),
        serverTime: Date.now(),
      },
    };
    client.ws.send(JSON.stringify(msg));
    client.needsResync = false;
  }

  private flush(): void {
    const snapshots = this.opts.store.drainDirty();
    const alerts = this.opts.alerts.drain();
    if (snapshots.length) this.broadcast({ type: 'snapshots', data: snapshots });
    if (alerts.length) this.broadcast({ type: 'alerts', data: alerts });
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
