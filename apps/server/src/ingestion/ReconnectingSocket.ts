import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import type { ConnectionState } from '@scanner/shared';
import type { Logger } from '../lib/logger';

export interface ReconnectingSocketOptions {
  url: string;
  name: string;
  logger: Logger;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

type SocketEvents = {
  open: [];
  message: [data: RawData];
  close: [code: number, reason: string];
  state: [state: ConnectionState];
};

/**
 * Provider-agnostic WebSocket with:
 *  - exponential backoff + jitter on reconnect
 *  - ping/pong heartbeat that kills half-open connections (common on flaky Wi-Fi / sleep)
 * Protocol concerns (auth, subscriptions) belong to the provider, which listens for `open`.
 */
export class ReconnectingSocket extends EventEmitter<SocketEvents> {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private minNextDelayMs = 0;
  private readonly log: Logger;

  constructor(private readonly opts: ReconnectingSocketOptions) {
    super();
    this.log = opts.logger.child({ socket: opts.name });
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'client shutdown');
      this.ws = null;
    }
    this.emit('state', 'stopped');
  }

  /** Drop the current connection; the normal backoff path reconnects it, waiting at least `minDelayMs`. */
  drop(reason: string, minDelayMs = 0): void {
    this.log.warn({ reason, minDelayMs }, 'dropping connection');
    this.minNextDelayMs = minDelayMs;
    this.ws?.terminate();
  }

  send(payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    this.emit('state', 'connecting');
    this.log.info({ url: this.opts.url, attempt: this.attempt }, 'connecting');

    const ws = new WebSocket(this.opts.url, { perMessageDeflate: false });
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.log.info('connected');
      this.startHeartbeat();
      this.emit('state', 'open');
      this.emit('open');
    });

    ws.on('message', (data) => this.emit('message', data));

    ws.on('pong', () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });

    ws.on('error', (err) => {
      // 'close' always follows 'error', so reconnection is handled there.
      this.log.error({ err: err.message }, 'socket error');
    });

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf.toString();
      this.clearTimers();
      this.ws = null;
      this.log.warn({ code, reason }, 'connection closed');
      this.emit('close', code, reason);
      this.scheduleReconnect();
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN || this.pongTimer) return;
      ws.ping();
      this.pongTimer = setTimeout(() => {
        this.log.warn({ timeoutMs: this.opts.heartbeatTimeoutMs }, 'heartbeat timed out');
        ws.terminate();
      }, this.opts.heartbeatTimeoutMs);
    }, this.opts.heartbeatIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const { reconnectBaseMs, reconnectMaxMs } = this.opts;
    const ceiling = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** this.attempt);
    // "Equal jitter": half fixed, half random — avoids thundering-herd reconnects.
    const jittered = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    const delay = Math.max(jittered, this.minNextDelayMs);
    this.minNextDelayMs = 0;
    this.attempt += 1;
    this.emit('state', 'reconnecting');
    this.log.info({ delayMs: delay, attempt: this.attempt }, 'reconnect scheduled');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.reconnectTimer = this.heartbeatTimer = this.pongTimer = null;
  }
}
