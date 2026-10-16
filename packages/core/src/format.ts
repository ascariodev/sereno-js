import { sha1 } from './sha1.js';

export const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogRecord {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  /** Moment of the record; defaults to now (also when invalid or outside years 0000-9999). */
  time?: Date;
}

export interface SerenoEvent {
  id: string;
  level: LogLevel;
  message: string;
  occurred_at: string;
  context?: Record<string, unknown>;
  fingerprint?: string;
}

export interface SerializedException {
  class: string;
  message: string;
  location: string;
  trace: string;
}

export const MAX_MESSAGE_LENGTH = 8192;
export const MAX_CONTEXT_BYTES = 32768;
export const MAX_CONTEXT_DEPTH = 8;
export const MAX_FINGERPRINT_LENGTH = 255;

const MAX_STRING_LENGTH = 2048;
const MAX_TRACE_LENGTH = 2000;
const MAX_ITEMS_PER_ARRAY = 50;
const MAX_STACK_LINE_LENGTH = 1000;
const CONTEXT_SIZE_MARGIN = 64;
const TRUNCATED = '[truncated]';
const UNSERIALIZABLE = '[unserializable]';
const TRUNCATED_KEY = '_truncated';

const TRIM_SINGLES = new Set([
  0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x00, 0xa0, 0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x202f,
  0x205f, 0x3000, 0x2800, 0x3164, 0xfeff, 0xffa0, 0x1d159, 0xe0020,
]);
const TRIM_RANGES: [number, number][] = [
  [0x2000, 0x200f],
  [0x2060, 0x2065],
  [0x206a, 0x206f],
  [0x1d173, 0x1d17a],
];
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

interface State {
  truncated: boolean;
  ancestors: Set<object>;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Builds the ingest event for a record. Never throws. */
export function formatEvent(record: LogRecord): SerenoEvent {
  const rawContext = attempt<object>(() => {
    const context = record.context;

    return isPlainObject(context) || Array.isArray(context) ? context : {};
  }, {});
  const event: SerenoEvent = {
    id: uuid(),
    level: attempt(() => record.level, 'error' as LogLevel),
    message: formatMessage(attempt(() => record.message, UNSERIALIZABLE)),
    occurred_at: occurredAt(attempt(() => record.time, undefined)),
  };

  const context = formatContext(rawContext);

  if (Object.keys(context).length > 0) {
    event.context = context;
  }

  const fingerprint = formatFingerprint(rawContext);

  if (fingerprint !== null) {
    event.fingerprint = fingerprint;
  }

  return event;
}

export function isError(value: unknown): value is Error {
  return attempt(() => value instanceof Error || Object.prototype.toString.call(value) === '[object Error]', false);
}

/** Never throws: unreadable fields fall back to empty strings or `Error`. */
export function serializeException(error: Error): SerializedException {
  const stack = errorStack(error);

  return {
    class: errorClass(error),
    message: attempt(() => (typeof error.message === 'string' ? error.message : String(error.message ?? '')), ''),
    location: stackLocation(stack),
    trace: substring(clean(stack), MAX_TRACE_LENGTH),
  };
}

export function uuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Removes leading and trailing whitespace and invisible characters, like Laravel's `Str::trim`. */
export function trim(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end) {
    const code = value.codePointAt(start) as number;

    if (!isTrimCodePoint(code)) {
      break;
    }

    start += code > 0xffff ? 2 : 1;
  }

  while (end > start) {
    const low = value.charCodeAt(end - 1);
    const high = end - 2 >= start ? value.charCodeAt(end - 2) : 0;
    const isPair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;

    if (!isTrimCodePoint(isPair ? (value.codePointAt(end - 2) as number) : low)) {
      break;
    }

    end -= isPair ? 2 : 1;
  }

  return value.slice(start, end);
}

/** Bytes that PHP's `json_encode` with default flags produces for a JSON-compatible value. */
export function phpJsonSize(value: unknown): number {
  if (typeof value === 'string') {
    return stringSize(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value).length : 1;
  }

  if (typeof value === 'boolean') {
    return value ? 4 : 5;
  }

  if (Array.isArray(value)) {
    return listSize(value);
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);

    return entries.every(([key], index) => key === String(index)) ? listSize(entries.map(([, item]) => item)) : mapSize(entries);
  }

  return 4;
}

function attempt<T>(callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function isTrimCodePoint(code: number): boolean {
  return TRIM_SINGLES.has(code) || TRIM_RANGES.some(([from, to]) => code >= from && code <= to);
}

function isRepresentableDate(value: Date): boolean {
  const time = value.getTime();

  if (Number.isNaN(time)) {
    return false;
  }

  const year = value.getUTCFullYear();

  return year >= 0 && year <= 9999;
}

function occurredAt(time: unknown): string {
  const valid = attempt(() => time instanceof Date && isRepresentableDate(time), false);

  return (valid ? (time as Date) : new Date()).toISOString();
}

function formatMessage(message: unknown): string {
  const text = typeof message === 'string' ? message : attempt(() => String(message), UNSERIALIZABLE);
  const value = substring(clean(text), MAX_MESSAGE_LENGTH);

  return trim(value) === '' ? '-' : value;
}

function formatContext(context: object): Record<string, unknown> {
  const state: State = { truncated: false, ancestors: new Set([context]) };
  let normalized: Record<string, unknown> | unknown[];

  try {
    normalized = normalizeMap(context, 1, state);
  } catch {
    state.truncated = true;
    normalized = {};
  }

  const fitted: Record<string, unknown> = {};
  let size = 2;
  let count = 0;

  for (const [key, value] of Object.entries(normalized)) {
    let candidate = value;
    let added = entrySize(key, candidate, count);

    if (size + added > MAX_CONTEXT_BYTES - CONTEXT_SIZE_MARGIN) {
      candidate = TRUNCATED;
      added = entrySize(key, candidate, count);

      if (size + added > MAX_CONTEXT_BYTES - CONTEXT_SIZE_MARGIN) {
        state.truncated = true;
        continue;
      }
    }

    if (candidate !== value) {
      state.truncated = true;
    }

    setKey(fitted, key, candidate);
    size += added;
    count++;
  }

  if (state.truncated) {
    fitted[TRUNCATED_KEY] = true;
  }

  return fitted;
}

function entrySize(key: string, value: unknown, index: number): number {
  return (index > 0 ? 1 : 0) + stringSize(key) + 1 + phpJsonSize(value);
}

function normalizeMap(values: object, depth: number, state: State): Record<string, unknown> | unknown[] {
  const isList = Array.isArray(values);
  const result: Record<string, unknown> = {};
  const list: unknown[] = [];
  let count = 0;

  for (const key of isList ? Array.from(values.keys(), String) : Object.keys(values)) {
    if (++count > MAX_ITEMS_PER_ARRAY) {
      state.truncated = true;
      break;
    }

    let value: unknown;

    try {
      value = normalize((values as Record<string, unknown>)[key], depth, state);
    } catch {
      state.truncated = true;
      value = UNSERIALIZABLE;
    }

    if (isList) {
      list.push(value);
    } else {
      setKey(result, clean(key), value);
    }
  }

  return isList ? list : result;
}

function normalize(value: unknown, depth: number, state: State): unknown {
  if (isError(value)) {
    value = serializeException(value);
  } else if (value instanceof Date) {
    // Dates PHP's DATE_ATOM could not write with a four digit year are dropped like invalid ones.
    return isRepresentableDate(value) ? `${value.toISOString().slice(0, 19)}+00:00` : null;
  } else if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON(): unknown }).toJSON();
  }

  if (Array.isArray(value) || isPlainObject(value)) {
    if (depth >= MAX_CONTEXT_DEPTH || state.ancestors.has(value)) {
      state.truncated = true;

      return TRUNCATED;
    }

    state.ancestors.add(value);

    try {
      return normalizeMap(value, depth + 1, state);
    } finally {
      state.ancestors.delete(value);
    }
  }

  switch (typeof value) {
    case 'string':
      return limitedString(value, state);
    case 'number':
      if (Number.isNaN(value)) {
        return 'NAN';
      }

      return Number.isFinite(value) ? value : value > 0 ? 'INF' : '-INF';
    case 'boolean':
      return value;
    case 'undefined':
      return null;
    case 'bigint':
      return value.toString();
    case 'function':
      return '[function]';
    case 'symbol':
      return '[symbol]';
  }

  return value === null ? null : `[object ${className(value)}]`;
}

function limitedString(value: string, state: State): string {
  const cleaned = clean(value);
  const limited = substring(cleaned, MAX_STRING_LENGTH);

  if (limited !== cleaned) {
    state.truncated = true;
  }

  return limited;
}

function formatFingerprint(context: object): string | null {
  return attempt(() => {
    const explicit = (context as Record<string, unknown>).fingerprint;

    if (typeof explicit === 'string') {
      const trimmed = trim(clean(explicit));

      if (trimmed !== '') {
        return fitFingerprint(trimmed);
      }
    }

    const exception = (context as Record<string, unknown>).exception;

    if (isError(exception)) {
      return fitFingerprint(`${errorClass(exception)}|${stackLocation(errorStack(exception))}`);
    }

    return null;
  }, null);
}

function fitFingerprint(fingerprint: string): string {
  return codePointLength(fingerprint) > MAX_FINGERPRINT_LENGTH ? sha1(fingerprint) : fingerprint;
}

function errorStack(error: Error): string {
  return attempt(() => (typeof error.stack === 'string' ? error.stack : ''), '');
}

function errorClass(error: Error): string {
  const constructorName = attempt(() => (error as { constructor?: { name?: unknown } }).constructor?.name, undefined);

  if (typeof constructorName === 'string' && constructorName !== '') {
    return constructorName;
  }

  const name = attempt(() => error.name, undefined);

  return typeof name === 'string' && name !== '' ? name : 'Error';
}

/** `file:line` of the first stack frame that has them, in V8 (`at fn (file:1:2)`) or Firefox/Safari (`fn@file:1:2`) format. */
function stackLocation(stack: string): string {
  const lines = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length <= MAX_STACK_LINE_LENGTH);
  const isV8 = lines.some((line) => line.startsWith('at '));

  for (const line of lines) {
    const match = isV8
      ? line.startsWith('at ')
        ? /^at\s+(?:.*?\s+\()?(.+?):(\d+)(?::\d+)?\)?$/.exec(line)
        : null
      : /^[^@]*@(.+?):(\d+)(?::\d+)?$/.exec(line);

    if (match) {
      return `${match[1]}:${match[2]}`;
    }
  }

  return '';
}

function className(value: unknown): string {
  const name = attempt(() => (value as { constructor?: { name?: unknown } }).constructor?.name, undefined);

  return typeof name === 'string' && name !== '' ? name : 'Object';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function clean(value: string): string {
  return value.replace(SURROGATES, (match) => (match.length === 2 ? match : '?')).replace(/\0/g, '');
}

function codePointLength(value: string): number {
  let length = 0;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      }
    }

    length++;
  }

  return length;
}

function substring(value: string, maxCodePoints: number): string {
  if (value.length <= maxCodePoints) {
    return value;
  }

  let count = 0;

  for (let i = 0; i < value.length; i++) {
    if (count === maxCodePoints) {
      return value.slice(0, i);
    }

    const code = value.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      }
    }

    count++;
  }

  return value;
}

function stringSize(value: string): number {
  let size = 2;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code === 0x22 || code === 0x5c || code === 0x2f || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) {
      size += 2;
    } else if (code < 0x20) {
      size += 6;
    } else if (code < 0x80) {
      size += 1;
    } else {
      size += 6;
    }
  }

  return size;
}

function listSize(items: unknown[]): number {
  return items.reduce<number>((size, item, index) => size + (index > 0 ? 1 : 0) + phpJsonSize(item), 2);
}

function mapSize(entries: [string, unknown][]): number {
  return entries.reduce<number>((size, [key, item], index) => size + entrySize(key, item, index), 2);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const filled = attempt(() => {
    const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;

    if (crypto && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);

      return true;
    }

    return false;
  }, false);

  if (!filled) {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return bytes;
}
