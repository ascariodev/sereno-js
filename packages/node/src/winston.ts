import * as winston from 'winston';
import type { LogLevel } from '@ascariodev/sereno-core';
import { emit, reviveError, splitException } from './logging.js';
import type { Fields, LoggerTransportOptions } from './logging.js';

export type { LoggerTransportOptions } from './logging.js';

export interface SerenoWinstonTransportOptions extends LoggerTransportOptions {
  /** Minimum level of this transport, as for any winston transport; defaults to the logger's. */
  level?: string;
  silent?: boolean;
  format?: winston.Logform.Format;
}

const LEVELS: Record<string, LogLevel> = {
  emerg: 'emergency',
  alert: 'alert',
  crit: 'critical',
  error: 'error',
  warn: 'warning',
  warning: 'warning',
  notice: 'notice',
  info: 'info',
  http: 'info',
  verbose: 'debug',
  debug: 'debug',
  silly: 'debug',
};

const LEVEL = Symbol.for('level');
const SPLAT = Symbol.for('splat');
const RESERVED = ['level', 'message', 'stack', 'splat'];

function levelOf(value: unknown): LogLevel {
  return (typeof value === 'string' && LEVELS[value]) || 'info';
}

function plain(info: Fields): Fields {
  return Object.fromEntries(Object.entries(info).filter(([key]) => !RESERVED.includes(key)));
}

const Base = (winston as unknown as { Transport: typeof winston.transport }).Transport;

/**
 * Winston transport that sends each entry to Sereno: `logger.add(new SerenoWinstonTransport())`. It extends winston's
 * own transport, so `level`, `silent` and `format` work as in any other. Levels map by name (npm and syslog sets):
 * warn to warning, http to info, verbose and silly to debug, emerg to emergency, crit to critical. The exception is,
 * in this order: an Error logged directly, the `error` or `err` field when it is an error, an Error passed as meta
 * (`logger.error('msg', error)`), or the `stack` of the entry; the other fields are the context. `handleExceptions`
 * is not supported.
 */
export class SerenoWinstonTransport extends Base {
  private readonly target: LoggerTransportOptions;

  constructor(options: SerenoWinstonTransportOptions = {}) {
    const { client, ...rest } = options;
    super(rest);
    this.target = { client };
  }

  override log(info: Fields, callback: () => void): void {
    try {
      const level = levelOf((info as Record<symbol, unknown>)[LEVEL]);
      const message = typeof info.message === 'string' ? info.message : String(info.message ?? '');
      const fields = plain(info);

      if (info instanceof Error) {
        emit(this.target, level, message, fields, info);
      } else {
        const split = splitException(fields, ['error', 'err']);
        const splat = (info as Record<symbol, unknown>)[SPLAT];
        const thrown = Array.isArray(splat) ? (splat as unknown[]).find((item): item is Error => item instanceof Error) : undefined;
        const exception = split.exception ?? thrown ?? (typeof info.stack === 'string' ? reviveError({ message, stack: info.stack }) : undefined);

        emit(this.target, level, message, split.context, exception);
      }
    } catch {
      // a logger must never break the application
    }

    callback();
  }
}
