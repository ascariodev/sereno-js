import { isError } from '@ascariodev/sereno-core';
import type { Client } from '@ascariodev/sereno-core';

function describe(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

function errorMessage(error: Error): string {
  try {
    return typeof error.message === 'string' ? error.message : describe(error.message);
  } catch {
    return '';
  }
}

/** Buffers a thrown value at level `error`: an Error keeps its exception context, anything else is sent as `String(value)`. */
export function capture(client: Client, value: unknown, context?: Record<string, unknown>): void {
  try {
    if (isError(value)) {
      client.log({ level: 'error', message: errorMessage(value), context: { ...context, exception: value } });
    } else {
      client.log({ level: 'error', message: describe(value), context });
    }
  } catch {
    // capturing must never break the application
  }
}
