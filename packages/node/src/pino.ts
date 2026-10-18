import type { LogLevel } from '@ascariodev/sereno-core';
import { emit, flushClient, splitException } from './logging.js';
import type { Fields, LoggerTransportOptions } from './logging.js';

export type { LoggerTransportOptions } from './logging.js';

/** The destination pino writes to: an object with `write(line)`, marked `writable` so `pino(stream)` accepts it. */
export interface SerenoPinoStream {
  readonly writable: true;
  write(line: string): void;
  end(): void;
  flush(callback?: () => void): void;
}

const NAMES: Record<string, LogLevel> = { trace: 'debug', debug: 'debug', info: 'info', warn: 'warning', error: 'error', fatal: 'critical' };

function levelOf(value: unknown): LogLevel {
  if (typeof value === 'string') {
    return NAMES[value] ?? 'info';
  }

  const level = typeof value === 'number' ? value : 30;

  return level <= 20 ? 'debug' : level <= 30 ? 'info' : level <= 40 ? 'warning' : level <= 50 ? 'error' : 'critical';
}

/**
 * Destination for pino that sends each line to Sereno, in the same process: `pino(options, serenoPinoStream())`.
 * Levels map trace/debug to debug, info to info, warn to warning, error to error and fatal to critical (by number,
 * or by name when `formatters.level` returns one). The `err` (or `error`) field becomes the exception when it is an
 * error; the other fields, without pino's `level`, `time`, `pid`, `hostname` and `msg`, are the context. Combine it
 * with other destinations through `pino.multistream`. A custom `messageKey` or `errorKey` is not supported.
 */
export function serenoPinoStream(options: LoggerTransportOptions = {}): SerenoPinoStream {
  return {
    writable: true,
    write(line) {
      try {
        const { level, time, pid, hostname, msg, ...fields } = JSON.parse(line) as Fields;
        const { exception, context } = splitException(fields, ['err', 'error']);
        const message = typeof msg === 'string' && msg !== '' ? msg : (exception?.message ?? '');

        emit(options, levelOf(level), message, context, exception);
      } catch {
        // not JSON: not a pino line
      }
    },
    end() {},
    flush(callback) {
      flushClient(options, callback);
    },
  };
}
