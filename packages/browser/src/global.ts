import { Client, LOG_LEVELS, isError, isLogLevel, serializeException } from '@ascariodev/sereno-core';
import type { ClientOptions, FetchInit, FetchLike, FetchResponseLike, LogRecord } from '@ascariodev/sereno-core';

export const DEDUPE_WINDOW_MS = 60_000;
export const MAX_EVENTS_PER_PAGE = 100;
/** Browsers cap the bodies of in-flight keepalive requests at 64 KiB per page; this leaves a margin. */
export const KEEPALIVE_BUDGET_BYTES = 60_000;

/** `unload`: plain `fetch` while the page lives and `keepalive` only when it is hidden or left. `never`: never `keepalive`. */
export type KeepaliveMode = 'unload' | 'never';

export interface BrowserClientOptions extends ClientOptions {
  keepalive?: KeepaliveMode;
}

/** Minimal shapes of the DOM objects the SDK touches, so no DOM typings are required. */
interface EventTargetLike {
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
}

interface DocumentLike extends EventTargetLike {
  visibilityState?: string;
}

interface BrowserScope {
  addEventListener?: EventTargetLike['addEventListener'];
  removeEventListener?: EventTargetLike['removeEventListener'];
  document?: DocumentLike;
  location?: { href?: string };
  fetch?: FetchLike;
  console?: { error(message: string): void };
}

interface ErrorEventLike {
  error?: unknown;
  message?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
}

interface RejectionEventLike {
  reason?: unknown;
}

const scope = globalThis as unknown as BrowserScope;

/** The page address without query string or fragment, which may carry tokens. */
export function pageUrl(href: unknown): string | undefined {
  try {
    if (typeof href !== 'string' || href === '') {
      return undefined;
    }

    return href.split(/[?#]/, 1)[0];
  } catch {
    return undefined;
  }
}

function describe(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

function utf8Length(text: string): number {
  let length = 0;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index++;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }

  return length;
}

export const INVALID_OPTIONS_NOTICE = 'Sereno could not be initialized: invalid options (url and key must be strings); the SDK stays inert';

interface PreparedOptions {
  keepalive: unknown;
  invalid: boolean;
  clientOptions: ClientOptions;
}

/** Splits and checks the options without throwing; anything unusable leaves the client inert (no url or key). */
function prepareOptions(options: unknown): PreparedOptions {
  try {
    if (options === undefined) {
      return { keepalive: undefined, invalid: false, clientOptions: {} };
    }

    if (options === null || typeof options !== 'object') {
      throw new TypeError('options must be an object');
    }

    const { keepalive, ...clientOptions } = options as BrowserClientOptions;
    const usable = (value: unknown) => value === undefined || value === null || typeof value === 'string';

    if (!usable(clientOptions.url) || !usable(clientOptions.key)) {
      throw new TypeError('url and key must be strings');
    }

    if (clientOptions.notifier !== undefined && typeof clientOptions.notifier !== 'function') {
      delete clientOptions.notifier;
    }

    if (clientOptions.fetch !== undefined && typeof clientOptions.fetch !== 'function') {
      delete clientOptions.fetch;
    }

    return { keepalive, invalid: false, clientOptions };
  } catch {
    let notifier: ClientOptions['notifier'];

    try {
      const candidate = (options as { notifier?: unknown } | null)?.notifier;
      notifier = typeof candidate === 'function' ? (candidate as ClientOptions['notifier']) : undefined;
    } catch {
      notifier = undefined;
    }

    return { keepalive: undefined, invalid: true, clientOptions: notifier ? { notifier } : {} };
  }
}

const KEEPALIVE_LIMIT_RESPONSE: FetchResponseLike = { status: 413, text: async () => 'keepalive limit reached' };

/**
 * A client for the browser: adds the page URL to the context, sends the same fingerprint once per minute, stops after
 * `MAX_EVENTS_PER_PAGE` events and switches to `keepalive` requests while the page is hidden or being left.
 */
export class BrowserClient extends Client {
  /** True while the page is hidden or being left: deliveries use `keepalive` and failures are not reported. */
  unloading = false;
  readonly keepalive: KeepaliveMode;
  private readonly seen = new Map<string, number>();
  private admitted = 0;
  private capNoticed = false;
  private keepaliveBytes = 0;
  private readonly notice: (message: string) => void;

  constructor(options: BrowserClientOptions = {}) {
    const { keepalive, invalid, clientOptions } = prepareOptions(options);
    const state: { client?: BrowserClient } = {};
    const notifier = clientOptions.notifier ?? ((message: string) => scope.console?.error(message));
    const baseFetch: FetchLike = clientOptions.fetch ?? ((url, init) => scope.fetch!(url, init));

    super({
      ...clientOptions,
      notifier: (message) => {
        if (!state.client?.unloading) {
          notifier(message);
        }
      },
      fetch: (url, init) => (state.client ? state.client.send(baseFetch, url, init) : baseFetch(url, init)),
    });

    state.client = this;
    this.keepalive = keepalive === 'never' ? 'never' : 'unload';
    this.notice = (message) => {
      this.guard(() => {
        try {
          notifier(message);
        } catch {
          // a failing notifier must not break the application
        }
      });
    };

    if (invalid) {
      this.notice(INVALID_OPTIONS_NOTICE);
    }
  }

  /** Total events this client accepted on this page. */
  get count(): number {
    return this.admitted;
  }

  override log(record: LogRecord): void {
    try {
      if (!this.configured || this.reentrant || !this.accepts(record.level)) {
        return;
      }

      const rawContext = record.context;
      const context: Record<string, unknown> =
        rawContext !== null && typeof rawContext === 'object' && !Array.isArray(rawContext) ? rawContext : {};

      if (!this.admit(this.fingerprintOf(record, context))) {
        return;
      }

      const url = pageUrl(scope.location?.href);

      super.log({ ...record, context: url === undefined ? context : { url, ...context } });
    } catch {
      // logging must never break the application
    }
  }

  private accepts(level: unknown): boolean {
    return isLogLevel(level) && LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(this.level);
  }

  private fingerprintOf(record: LogRecord, context: Record<string, unknown>): string {
    const explicit = context.fingerprint;

    if (typeof explicit === 'string' && explicit.trim() !== '') {
      return `fingerprint|${explicit}`;
    }

    const exception = context.exception;

    if (isError(exception)) {
      const serialized = serializeException(exception);

      return serialized.location === ''
        ? `exception|${serialized.class}|${serialized.message}`
        : `exception|${serialized.class}|${serialized.location}`;
    }

    return `message|${record.level}|${describe(record.message)}`;
  }

  private admit(fingerprint: string): boolean {
    const now = Date.now();
    const last = this.seen.get(fingerprint);

    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
      return false;
    }

    if (this.admitted >= MAX_EVENTS_PER_PAGE) {
      if (!this.capNoticed) {
        this.capNoticed = true;
        this.notice(`Sereno reached the limit of ${MAX_EVENTS_PER_PAGE} events for this page; further events are dropped`);
      }

      return false;
    }

    this.admitted++;
    this.seen.set(fingerprint, now);

    return true;
  }

  /** The only place that decides how a batch leaves the page; `keepalive` is used only while unloading. */
  private async send(fetchFn: FetchLike, url: string, init: FetchInit): Promise<FetchResponseLike> {
    if (this.keepalive === 'never' || !this.unloading) {
      return fetchFn(url, init);
    }

    let body = init.body;
    let size = utf8Length(body);
    const remaining = KEEPALIVE_BUDGET_BYTES - this.keepaliveBytes;

    if (size > remaining) {
      const fitted = this.fitBody(body, remaining);

      if (fitted.dropped > 0) {
        this.notice(`Sereno dropped ${fitted.dropped} log events: keepalive limit of ${KEEPALIVE_BUDGET_BYTES} bytes reached`);
      }

      if (fitted.body === null) {
        return KEEPALIVE_LIMIT_RESPONSE;
      }

      body = fitted.body;
      size = fitted.size;
    }

    this.keepaliveBytes += size;

    try {
      return await fetchFn(url, { ...init, body, keepalive: true });
    } finally {
      this.keepaliveBytes -= size;
    }
  }

  /** Keeps the leading events of a batch that fit in `limit` bytes. */
  private fitBody(body: string, limit: number): { body: string | null; size: number; dropped: number } {
    const events = (JSON.parse(body) as { events: unknown[] }).events;
    const kept: string[] = [];
    let size = utf8Length('{"events":[]}');

    for (const event of events) {
      const encoded = JSON.stringify(event);
      const next = size + utf8Length(encoded) + (kept.length > 0 ? 1 : 0);

      if (next > limit) {
        break;
      }

      kept.push(encoded);
      size = next;
    }

    return {
      body: kept.length > 0 ? `{"events":[${kept.join(',')}]}` : null,
      size,
      dropped: events.length - kept.length,
    };
  }
}

/** Buffers a thrown value at level `error`: an Error keeps its exception context, anything else is sent as `String(value)`. */
export function capture(client: Client, value: unknown, context?: Record<string, unknown>): void {
  try {
    if (isError(value)) {
      let message = '';

      try {
        message = typeof value.message === 'string' ? value.message : describe(value.message);
      } catch {
        // an unreadable message is sent empty
      }

      client.log({ level: 'error', message, context: { ...context, exception: value } });
    } else {
      client.log({ level: 'error', message: describe(value), context });
    }
  } catch {
    // capturing must never break the application
  }
}

function errorEventContext(event: ErrorEventLike): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  const file = pageUrl(event.filename);

  if (file !== undefined) {
    context.file = file;
  }

  if (typeof event.lineno === 'number' && event.lineno > 0) {
    context.line = event.lineno;
  }

  if (typeof event.colno === 'number' && event.colno > 0) {
    context.column = event.colno;
  }

  return context;
}

/** Listens to uncaught errors and rejections and flushes when the page is hidden or left. Returns the uninstaller. */
export function installGlobalHandlers(client: BrowserClient): () => void {
  const target = scope;
  const document = scope.document;

  if (typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') {
    return () => undefined;
  }

  const onError = (event: ErrorEventLike): void => {
    try {
      if (client.reentrant || event === null || typeof event !== 'object') {
        return;
      }

      if (isError(event.error)) {
        capture(client, event.error);
      } else {
        const message = typeof event.message === 'string' && event.message !== '' ? event.message : 'Script error.';
        client.log({ level: 'error', message, context: errorEventContext(event) });
      }
    } catch {
      // a global handler must never throw back into the page
    }
  };

  const onRejection = (event: RejectionEventLike): void => {
    try {
      if (!client.reentrant && event !== null && typeof event === 'object') {
        capture(client, event.reason);
      }
    } catch {
      // a global handler must never throw back into the page
    }
  };

  const leave = (): void => {
    try {
      client.unloading = true;
      void client.flush();
    } catch {
      // flushing on the way out is best effort
    }
  };

  const onVisibility = (): void => {
    try {
      if (document?.visibilityState === 'hidden') {
        leave();
      } else {
        client.unloading = false;
      }
    } catch {
      // flushing on the way out is best effort
    }
  };

  const onPageShow = (): void => {
    client.unloading = false;
  };

  const listeners: [EventTargetLike, string, (event: never) => void][] = [
    [target as EventTargetLike, 'error', onError],
    [target as EventTargetLike, 'unhandledrejection', onRejection],
    [target as EventTargetLike, 'pagehide', leave],
    [target as EventTargetLike, 'pageshow', onPageShow],
  ];

  if (document && typeof document.addEventListener === 'function') {
    listeners.push([document, 'visibilitychange', onVisibility]);
  }

  for (const [where, type, listener] of listeners) {
    where.addEventListener(type, listener);
  }

  return () => {
    for (const [where, type, listener] of listeners) {
      try {
        where.removeEventListener(type, listener);
      } catch {
        // nothing left to undo
      }
    }
  };
}
