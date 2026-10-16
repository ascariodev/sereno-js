import type { FlushResult, LogLevel } from '@ascariodev/sereno-core';
import { BrowserClient, capture, installGlobalHandlers } from './global.js';
import type { BrowserClientOptions } from './global.js';

export { Client } from '@ascariodev/sereno-core';
export type { ClientOptions, FlushResult, LogLevel } from '@ascariodev/sereno-core';
export { BrowserClient, DEDUPE_WINDOW_MS, KEEPALIVE_BUDGET_BYTES, MAX_EVENTS_PER_PAGE, pageUrl } from './global.js';
export type { BrowserClientOptions, KeepaliveMode } from './global.js';

export interface InitOptions extends BrowserClientOptions {
  /** Capture uncaught errors and unhandled rejections, and flush when the page is hidden or left. Defaults to true. */
  handlers?: boolean;
}

interface Active {
  client: BrowserClient;
  uninstall: () => void;
}

/** Shared through globalThis so every copy of the package on the page sees the same setup. */
const ACTIVE_KEY = Symbol.for('@ascariodev/sereno-browser.active');
const registry = globalThis as unknown as Record<symbol, Active | undefined>;

function current(): Active | undefined {
  return registry[ACTIVE_KEY];
}

const EMPTY_RESULT: FlushResult = { sent: 0, failed: 0, dropped: 0 };

function release(): Promise<FlushResult> {
  const previous = current();
  registry[ACTIVE_KEY] = undefined;

  if (!previous) {
    return Promise.resolve({ ...EMPTY_RESULT });
  }

  try {
    previous.uninstall();
  } catch {
    // the previous setup is dropped anyway
  }

  return previous.client.flush();
}

/**
 * Configures the SDK with a public `wsp_` key. Calling it again replaces the previous setup. Without url or key the SDK
 * stays inert and installs nothing. Never throws.
 */
export function init(options: InitOptions = {}): BrowserClient {
  void release();

  let handlers: unknown;
  let client: BrowserClient;

  try {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('options must be an object');
    }

    const { handlers: wanted, ...clientOptions } = options;
    handlers = wanted;
    client = new BrowserClient(clientOptions);
  } catch {
    client = new BrowserClient(null as unknown as BrowserClientOptions);
  }

  let uninstall: () => void = () => undefined;

  if (client.configured && handlers !== false) {
    try {
      uninstall = installGlobalHandlers(client);
    } catch {
      // without handlers the manual API still works
    }
  }

  registry[ACTIVE_KEY] = { client, uninstall };

  return client;
}

/** Buffers a thrown value at level `error`; a value that is not an Error is sent as `String(value)`. */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  const active = current();

  if (active) {
    capture(active.client, error, context);
  }
}

export function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  current()?.client.log({ level, message, context });
}

/** Sends what is buffered; resolves when done and never rejects. */
export function flush(): Promise<FlushResult> {
  const active = current();

  return active ? active.client.flush() : Promise.resolve({ ...EMPTY_RESULT });
}

/** Removes the global handlers, sends what is buffered and leaves the SDK uninitialized. */
export function close(): Promise<FlushResult> {
  return release();
}

/** The active client, for framework integrations; undefined before `init`. */
export function getClient(): BrowserClient | undefined {
  return current()?.client;
}
