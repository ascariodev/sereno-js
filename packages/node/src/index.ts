import { Client } from '@ascariodev/sereno-core';
import type { ClientOptions, FlushResult, LogLevel } from '@ascariodev/sereno-core';
import { capture } from './capture.js';
import { installProcessHandlers } from './process.js';

export { Client } from '@ascariodev/sereno-core';
export type { ClientOptions, FlushResult, LogLevel } from '@ascariodev/sereno-core';

export interface InitOptions extends ClientOptions {
  /** Capture uncaught exceptions, unhandled rejections and signals, and flush on exit. Defaults to true. */
  handlers?: boolean;
}

interface Active {
  client: Client;
  uninstall: () => void;
}

/** Shared through globalThis so the ESM and CommonJS copies of the package see the same setup. */
const ACTIVE_KEY = Symbol.for('@ascariodev/sereno-node.active');
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

  previous.uninstall();

  return previous.client.flush();
}

/**
 * Configures the SDK. Options win over `SERENO_URL`, `SERENO_KEY`, `SERENO_TIMEOUT` and `SERENO_LEVEL`. Calling it again
 * replaces the previous setup. Without url or key the SDK stays inert and installs nothing.
 */
export function init(options: InitOptions = {}): Client {
  void release();

  const { handlers, ...clientOptions } = options;
  const env = process.env;
  const client = new Client({
    ...clientOptions,
    url: options.url ?? env.SERENO_URL,
    key: options.key ?? env.SERENO_KEY,
    timeout: options.timeout ?? env.SERENO_TIMEOUT,
    level: options.level ?? env.SERENO_LEVEL,
  });

  registry[ACTIVE_KEY] = { client, uninstall: client.configured && handlers !== false ? installProcessHandlers(client) : () => undefined };

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

/** Sends what is buffered; resolves when done and never rejects. Use it before a serverless handler returns. */
export function flush(): Promise<FlushResult> {
  const active = current();

  return active ? active.client.flush() : Promise.resolve({ ...EMPTY_RESULT });
}

/** Removes the process handlers, sends what is buffered and leaves the SDK uninitialized. */
export function close(): Promise<FlushResult> {
  return release();
}

/** The active client, for framework integrations; undefined before `init`. */
export function getClient(): Client | undefined {
  return current()?.client;
}
