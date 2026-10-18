import { isError } from '@ascariodev/sereno-core';
import type { Client, LogLevel } from '@ascariodev/sereno-core';
import { getClient } from './index.js';

export interface LoggerTransportOptions {
  /** Client that receives the records. Defaults to the one set up by `init()`, looked up on every record. */
  client?: Client;
}

export type Fields = Record<string, unknown>;

/** The Error itself, or one rebuilt from a serialized one (pino writes `{ type, message, stack }`); undefined for anything else. */
export function reviveError(value: unknown): Error | undefined {
  if (isError(value)) {
    return value;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const { type, name, message, stack } = value as Fields;

  if (typeof message !== 'string' && typeof stack !== 'string') {
    return undefined;
  }

  const error = new Error(typeof message === 'string' ? message : '');
  const className = typeof type === 'string' ? type : typeof name === 'string' ? name : 'Error';
  error.name = className;
  Object.defineProperty(error, 'constructor', { value: { name: className }, configurable: true });

  if (typeof stack === 'string') {
    error.stack = stack;
  }

  return error;
}

/** Takes the first of `keys` that holds an error out of `fields`; the other keys stay as context. */
export function splitException(fields: Fields, keys: string[]): { exception?: Error; context: Fields } {
  for (const key of keys) {
    const exception = reviveError(fields[key]);

    if (exception) {
      const { [key]: _taken, ...context } = fields;

      return { exception, context };
    }
  }

  return { context: fields };
}

function activeClient(options: LoggerTransportOptions): Client | undefined {
  return options.client ?? getClient();
}

/** Sends a record to the chosen or active client. Never throws. */
export function emit(options: LoggerTransportOptions, level: LogLevel, message: string, context: Fields, error?: Error): void {
  try {
    activeClient(options)?.log({ level, message, context: error ? { ...context, exception: error } : context });
  } catch {
    // a logger must never break the application
  }
}

/** Sends what the client has buffered, then calls `done`. Never throws. */
export function flushClient(options: LoggerTransportOptions, done?: () => void): void {
  const finish = (): void => {
    try {
      done?.();
    } catch {
      // a logger must never break the application
    }
  };

  try {
    const flushing = activeClient(options)?.flush();

    void (flushing ?? Promise.resolve()).then(
      finish,
      finish,
    );
  } catch {
    finish();
  }
}
