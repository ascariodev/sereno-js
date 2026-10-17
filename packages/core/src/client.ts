import { LOG_LEVELS, formatEvent, isLogLevel } from './format.js';
import type { LogLevel, LogRecord, SerenoEvent } from './format.js';

export const BATCH_SIZE = 100;
export const MAX_BUFFER = 1000;
export const DEFAULT_TIMEOUT_SECONDS = 2;
export const MAX_TIMEOUT_SECONDS = 10;
export const MIN_RETRY_SECONDS = 0.5;
export const BUDGET_SECONDS = 10;
export const FLUSH_DELAY_MS = 1000;
export const INGEST_PATH = '/api/ingest/events';

const MAX_BODY_CHARS = 500;

/** Minimal shape of what the client needs from `fetch`, so no DOM or Node typings are required. */
export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: unknown;
  redirect: 'manual';
  [option: string]: unknown;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface Scheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface TransportOptions {
  /** Seconds per attempt; invalid values fall back to 2, the maximum is 10. */
  timeout?: number | string | null;
  fetch?: FetchLike;
  /** Monotonic clock in milliseconds. */
  now?: () => number;
  scheduler?: Scheduler;
  /** Extra headers; the authorization and content headers always win. */
  headers?: Record<string, string>;
  /** Extra options for every `fetch` call (for example `keepalive` in the browser); the SDK's own fields always win. */
  fetchOptions?: Record<string, unknown>;
  /** Set to false to make a single attempt even on network errors, timeouts or 5xx. Defaults to true. */
  retry?: boolean;
}

export interface ClientOptions extends TransportOptions {
  url?: string | null;
  key?: string | null;
  /** Minimum level to record; invalid values fall back to `debug`. */
  level?: LogLevel | string | null;
  /** Receives failure notices; defaults to `console.error`. Whatever it logs is not buffered. */
  notifier?: (message: string) => void;
}

export type DeliveryResult =
  | { status: 'sent'; code: number; attempts: number }
  | { status: 'rejected'; code: number; body: string; attempts: number }
  | { status: 'error'; error: string; transient: boolean; attempts: number };

export interface FlushResult {
  sent: number;
  failed: number;
  dropped: number;
}

interface GlobalScope {
  fetch?: FetchLike;
  AbortController?: new () => { signal: unknown; abort(): void };
  performance?: { now(): number };
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

const scope = globalThis as unknown as GlobalScope;

export function normalizeTimeout(value: unknown): number {
  const text = typeof value === 'string' ? value.trim() : value;
  const number = typeof text === 'number' || (typeof text === 'string' && text !== '') ? Number(text) : Number.NaN;

  if (Number.isNaN(number) || number <= 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  return number > MAX_TIMEOUT_SECONDS ? MAX_TIMEOUT_SECONDS : number;
}

export function normalizeLevel(value: unknown): LogLevel {
  const level = typeof value === 'string' ? value.trim().toLowerCase() : value;

  return isLogLevel(level) ? level : 'debug';
}

export const defaultScheduler: Scheduler = {
  set(callback, delayMs) {
    const handle = scope.setTimeout(callback, delayMs);

    if (typeof handle === 'object' && handle !== null && typeof (handle as { unref?: unknown }).unref === 'function') {
      (handle as { unref(): void }).unref();
    }

    return handle;
  },
  clear(handle) {
    scope.clearTimeout(handle);
  },
};

function defaultNow(): number {
  return scope.performance ? scope.performance.now() : Date.now();
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown error';
  }
}

const USERINFO = /(?<=\/\/)[^/\s@]*@/g;

/** Replaces each secret (also as `Bearer <secret>` and in escaped form) with `***` and drops URL userinfo. */
export function redact(text: string, ...secrets: string[]): string {
  let result = text;

  for (const secret of secrets.filter((value) => value !== '').sort((a, b) => b.length - a.length)) {
    const escaped = JSON.stringify(secret).slice(1, -1);

    for (const variant of new Set([`Bearer ${secret}`, `Bearer ${escaped}`, secret, escaped])) {
      result = result.split(variant).join('***');
    }
  }

  return result.replace(USERINFO, '');
}

export class Transport {
  readonly endpoint: string;
  readonly timeout: number;
  private readonly key: string;
  private readonly fetchFn: FetchLike | undefined;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly headers: Record<string, string>;
  private readonly fetchOptions: Record<string, unknown>;
  private readonly retry: boolean;
  private readonly guarded: <T>(run: () => T) => T;

  constructor(url: string, key: string, options: TransportOptions = {}, guarded: <T>(run: () => T) => T = (run) => run()) {
    this.endpoint = url.trim().replace(/\/+$/, '') + INGEST_PATH;
    this.key = key.trim();
    this.timeout = normalizeTimeout(options.timeout);
    this.fetchFn = options.fetch;
    this.now = options.now ?? defaultNow;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.headers = options.headers ?? {};
    this.fetchOptions = options.fetchOptions ?? {};
    this.retry = options.retry !== false;
    this.guarded = guarded;
  }

  /** Sends one batch with at most one retry on network error, timeout or 5xx. Never throws or rejects. */
  async send(batch: SerenoEvent[]): Promise<DeliveryResult> {
    try {
      const payload = JSON.stringify({ events: batch });
      const startedAt = this.now();
      let result = await this.attempt(payload, this.timeout, 1);

      if (this.retry && this.isTransient(result)) {
        const remaining = BUDGET_SECONDS - (this.now() - startedAt) / 1000;

        if (remaining >= MIN_RETRY_SECONDS) {
          result = await this.attempt(payload, Math.min(this.timeout, remaining), 2);
        }
      }

      return result;
    } catch (error) {
      return { status: 'error', error: redact(errorMessage(error), this.key), transient: false, attempts: 0 };
    }
  }

  private isTransient(result: DeliveryResult): boolean {
    return result.status === 'error' ? result.transient : result.status === 'rejected' && result.code >= 500;
  }

  private async attempt(payload: string, timeoutSeconds: number, attempts: number): Promise<DeliveryResult> {
    let handle: unknown;

    try {
      const controller = scope.AbortController ? new scope.AbortController() : undefined;
      const timedOut = new Promise<never>((_, reject) => {
        handle = this.scheduler.set(() => {
          try {
            controller?.abort();
          } catch {
            // the race below already settles the attempt
          }

          reject(new Error(`request timed out after ${timeoutSeconds}s`));
        }, Math.max(1, Math.ceil(timeoutSeconds * 1000)));
      });
      timedOut.catch(() => undefined);
      const request = this.request(payload, controller?.signal);
      request.catch(() => undefined);

      const response = await Promise.race([request, timedOut]);

      if (response.status >= 200 && response.status < 300) {
        return { status: 'sent', code: response.status, attempts };
      }

      let body = '';

      try {
        const reading = response.text();
        reading.catch(() => undefined);
        body = await Promise.race([reading, timedOut]);
      } catch {
        // the status is known; a stalled or failed body read does not turn it into a network error
      }

      return { status: 'rejected', code: response.status, body, attempts };
    } catch (error) {
      return { status: 'error', error: redact(errorMessage(error), this.key), transient: !(error instanceof FetchUnavailableError), attempts };
    } finally {
      if (handle !== undefined) {
        this.scheduler.clear(handle);
      }
    }
  }

  private async request(payload: string, signal: unknown): Promise<FetchResponseLike> {
    const fetchFn = this.fetchFn ?? scope.fetch;

    if (typeof fetchFn !== 'function') {
      throw new FetchUnavailableError('fetch is not available');
    }

    const init: FetchInit = {
      ...this.fetchOptions,
      method: 'POST',
      headers: {
        ...this.headers,
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: payload,
      redirect: 'manual',
    };

    if (signal !== undefined) {
      init.signal = signal;
    }

    const response = await this.guarded(() => (this.fetchFn ? fetchFn(this.endpoint, init) : scope.fetch!(this.endpoint, init)));

    return response;
  }
}

class FetchUnavailableError extends Error {}

export class Client {
  readonly configured: boolean;
  readonly level: LogLevel;
  private readonly transport: Transport | null;
  private readonly notifier: (message: string) => void;
  private readonly scheduler: Scheduler;
  private buffer: SerenoEvent[] = [];
  private dropped = 0;
  private timer: unknown;
  private guardDepth = 0;
  private flushQueued = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: ClientOptions = {}) {
    const url = (options.url ?? '').trim();
    const key = (options.key ?? '').trim();

    this.configured = url !== '' && key !== '';
    this.level = normalizeLevel(options.level);
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.notifier =
      options.notifier ??
      ((message) => {
        scopeConsole()?.error(message);
      });
    this.transport = this.configured ? new Transport(url, key, options, (run) => this.guard(run)) : null;
  }

  /** Events waiting in the buffer. */
  get size(): number {
    return this.buffer.length;
  }

  /** True while the SDK itself is sending or reporting a failure; whatever is logged then is not buffered. */
  get reentrant(): boolean {
    return this.guardDepth > 0;
  }

  /** Runs `run` marking the SDK as busy, so a logger hooked to what it calls cannot loop back into the buffer. */
  guard<T>(run: () => T): T {
    this.guardDepth++;

    try {
      return run();
    } finally {
      this.guardDepth--;
    }
  }

  /** Formats and buffers a record. Never throws. */
  log(record: LogRecord): void {
    try {
      if (!this.configured || this.guardDepth > 0 || !this.handles(record.level)) {
        return;
      }

      if (this.buffer.length >= MAX_BUFFER) {
        this.dropped++;

        return;
      }

      let event: SerenoEvent;

      try {
        event = formatEvent(record);
      } catch (error) {
        this.report(`Sereno log event could not be formatted: ${errorMessage(error)}`);

        return;
      }

      this.buffer.push(event);

      if (this.buffer.length >= BATCH_SIZE) {
        if (!this.flushQueued) {
          this.flushQueued = true;
          void this.flush();
        }
      } else if (this.timer === undefined) {
        this.timer = this.scheduler.set(() => {
          this.timer = undefined;
          void this.flush();
        }, FLUSH_DELAY_MS);
      }
    } catch {
      // logging must never break the application
    }
  }

  /**
   * Sends everything buffered, in batches of 100, and also what arrives while it sends. Never rejects.
   * The drain starts after a microtask, not synchronously, and a flush waits for the drain already running.
   * Its result only counts what that drain handled, so it can be empty when an earlier drain took the events.
   */
  flush(): Promise<FlushResult> {
    const run = this.tail.then(() => this.drain()).catch((): FlushResult => ({ sent: 0, failed: 0, dropped: 0 }));
    this.tail = run;

    return run;
  }

  private handles(level: unknown): boolean {
    return isLogLevel(level) && LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(this.level);
  }

  private async drain(): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, failed: 0, dropped: 0 };

    this.flushQueued = false;

    if (this.timer !== undefined) {
      this.scheduler.clear(this.timer);
      this.timer = undefined;
    }

    if (!this.transport) {
      return result;
    }

    for (;;) {
      if (this.dropped > 0) {
        const dropped = this.dropped;
        this.dropped = 0;
        result.dropped += dropped;
        this.report(`Sereno dropped ${dropped} log events: buffer limit of ${MAX_BUFFER} reached`);
      }

      const batch = this.buffer.splice(0, BATCH_SIZE);

      if (batch.length === 0) {
        break;
      }

      if (await this.deliver(batch)) {
        result.sent += batch.length;
      } else {
        result.failed += batch.length;
      }
    }

    return result;
  }

  private async deliver(batch: SerenoEvent[]): Promise<boolean> {
    const outcome = await this.transport!.send(batch);

    if (outcome.status === 'sent') {
      return true;
    }

    if (outcome.status === 'rejected') {
      this.report(
        `Sereno log delivery failed: status=${outcome.code} events=${batch.length} body=${Array.from(outcome.body).slice(0, MAX_BODY_CHARS).join('')}`,
      );
    } else {
      this.report(`Sereno log delivery failed: error=${outcome.error} events=${batch.length}`);
    }

    return false;
  }

  private report(message: string): void {
    this.guard(() => {
      try {
        this.notifier(message);
      } catch {
        // a failing notifier must not break delivery
      }
    });
  }
}

function scopeConsole(): { error(message: string): void } | undefined {
  return (globalThis as unknown as { console?: { error(message: string): void } }).console;
}
