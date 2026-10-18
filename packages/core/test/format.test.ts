import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type LogLevel, formatEvent, phpJsonSize, serializeException, sha1, trim } from '../src/index.js';

interface Vector {
  name: string;
  input: { level: LogLevel; time: string; message: unknown; context?: Record<string, unknown> };
  expected: Record<string, unknown>;
}

class FixtureObject {}

const vectors: Vector[] = JSON.parse(readFileSync(new URL('./vectores.json', import.meta.url), 'utf8'));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function codePoints(value: string): number {
  return Array.from(value).length;
}

function makeError(spec: { class: string; message: string; file?: string; line?: number; trace?: string }): Error {
  const error = new Error(spec.message);
  error.stack =
    spec.trace !== undefined
      ? spec.trace
      : spec.file === undefined
      ? `Error: ${spec.message}`
      : `Error: ${spec.message}\n    at Object.<anonymous> (${spec.file}:${spec.line}:5)\n    at node:internal/main:1:1`;

  return error;
}

function resolve(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(resolve);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value);

  if (entries.length === 1) {
    const [marker, argument] = entries[0] as [string, any];

    switch (marker) {
      case '$repeat':
        return (argument[0] as string).repeat(argument[1]);
      case '$float':
        return { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, '-Infinity': Number.NEGATIVE_INFINITY }[argument as string];
      case '$date':
        return new Date(argument);
      case '$object':
        return new FixtureObject();
      case '$exception':
        return makeError(argument);
    }
  }

  return Object.fromEntries(entries.map(([key, item]) => [key, resolve(item)]));
}

function resolveExpected(expected: unknown, actual: unknown): unknown {
  if (Array.isArray(expected)) {
    return expected.map((item, index) => resolveExpected(item, Array.isArray(actual) ? actual[index] : undefined));
  }

  if (expected !== null && typeof expected === 'object') {
    const actualMap = actual !== null && typeof actual === 'object' ? (actual as Record<string, unknown>) : {};

    return Object.fromEntries(Object.entries(expected).map(([key, item]) => [key, resolveExpected(item, actualMap[key])]));
  }

  if (expected === '<trace>') {
    expect(typeof actual).toBe('string');
    expect(codePoints(actual as string)).toBeLessThanOrEqual(2000);

    return actual;
  }

  if (typeof expected === 'string') {
    return expected.replace('[object <Clase>]', `[object ${FixtureObject.name}]`).replace(/^RuntimeException(?=$|\|)/, 'Error');
  }

  return expected;
}

describe('formatEvent', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThan(20);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))('formats vector: %s', (_name, vector) => {
    const event = formatEvent({
      level: vector.input.level,
      message: resolve(vector.input.message) as string,
      context: vector.input.context === undefined ? undefined : (resolve(vector.input.context) as Record<string, unknown>),
      time: new Date(vector.input.time.replace(/(\.\d{3})\d+/, '$1')),
    });

    expect(event.id).toMatch(UUID_V4);

    const { id: _id, ...rest } = event;

    expect(rest).toStrictEqual(resolveExpected(resolve(vector.expected), rest));
  });

  it('generates unique ids', () => {
    const record = { level: 'info' as const, message: 'm' };

    expect(formatEvent(record).id).not.toBe(formatEvent(record).id);
  });

  it('defaults the time to now', () => {
    const before = Date.now();
    const occurredAt = Date.parse(formatEvent({ level: 'info', message: 'm' }).occurred_at);

    expect(occurredAt).toBeGreaterThanOrEqual(before);
    expect(occurredAt).toBeLessThanOrEqual(Date.now());
  });

  it('replaces lone surrogates with ? and counts astral characters as one code point', () => {
    const event = formatEvent({ level: 'info', message: 'a\uD800b', context: { s: `x\uDC00${'😀'.repeat(2100)}` } });

    expect(event.message).toBe('a?b');
    expect((event.context as Record<string, string>).s).toBe(`x?${'😀'.repeat(2046)}`);
    expect(event.context?._truncated).toBe(true);
  });

  it('maps JS values without a PHP equivalent to strings or null', () => {
    const event = formatEvent({
      level: 'info',
      message: 'm',
      context: {
        fn: () => 1,
        sym: Symbol('s'),
        big: 10n,
        undef: undefined,
        map: new Map(),
        json: { toJSON: () => ({ a: 1 }) },
      },
    });

    expect(event.context).toStrictEqual({
      fn: '[function]',
      sym: '[symbol]',
      big: '10',
      undef: null,
      map: '[object Map]',
      json: { a: 1 },
    });
  });

  it('survives circular references through the depth limit', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatEvent({ level: 'info', message: 'm', context: { circular } }).context?._truncated).toBe(true);
  });
});

describe('formatEvent robustness', () => {
  it('cuts self references without combinatorial explosion', () => {
    const node: Record<string, unknown> = {};

    for (let i = 0; i < 50; i++) {
      node[`k${i}`] = node;
    }

    const context = formatEvent({ level: 'info', message: 'm', context: { node } }).context as Record<string, any>;

    expect(context.node.k0).toBe('[truncated]');
    expect(context.node.k49).toBe('[truncated]');
    expect(context._truncated).toBe(true);
  });

  it('cuts a context that contains itself', () => {
    const context: Record<string, unknown> = { a: 1 };
    context.self = context;

    expect(formatEvent({ level: 'info', message: 'm', context }).context).toStrictEqual({ a: 1, self: '[truncated]', _truncated: true });
  });

  it('replaces values that throw while being read with [unserializable]', () => {
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const context = {
      ok: 1,
      get getter(): unknown {
        throw new Error('getter');
      },
      json: {
        toJSON() {
          throw new Error('toJSON');
        },
      },
      revoked,
      keys: new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('ownKeys');
          },
        },
      ),
    };

    expect(formatEvent({ level: 'info', message: 'm', context }).context).toStrictEqual({
      ok: 1,
      getter: '[unserializable]',
      json: '[unserializable]',
      revoked: '[unserializable]',
      keys: '[unserializable]',
      _truncated: true,
    });
  });

  it('never throws with a hostile root context or exception', () => {
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('message');
      },
    });
    Object.defineProperty(hostile, 'constructor', {
      get() {
        throw new Error('constructor');
      },
    });

    expect(() => formatEvent({ level: 'info', message: 'm', context: revoked as Record<string, unknown> })).not.toThrow();

    const event = formatEvent({ level: 'error', message: 'm', context: { exception: hostile } });

    expect((event.context as Record<string, any>).exception.class).toBe('Error');
    expect((event.context as Record<string, any>).exception.message).toBe('');
    expect(event.fingerprint).toMatch(/^Error\|/);
  });

  it('ignores a fingerprint getter that throws', () => {
    const context = {
      get fingerprint(): string {
        throw new Error('fingerprint');
      },
    };

    expect(formatEvent({ level: 'info', message: 'm', context }).fingerprint).toBeUndefined();
  });

  it('falls back to now for an invalid or out of range time', () => {
    for (const time of [new Date(Number.NaN), new Date('+010000-01-01T00:00:00Z')]) {
      expect(formatEvent({ level: 'info', message: 'm', time }).occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('sends invalid or out of range context dates as null', () => {
    const context = { invalid: new Date(Number.NaN), future: new Date('+010000-01-01T00:00:00Z'), past: new Date('-000001-01-01T00:00:00Z') };

    expect(formatEvent({ level: 'info', message: 'm', context }).context).toStrictEqual({ invalid: null, future: null, past: null });
  });

  it('does not throw when the message cannot be converted to a string', () => {
    const throwing = {
      toString() {
        throw new Error('toString');
      },
    };

    expect(formatEvent({ level: 'info', message: Object.create(null) }).message).toBe('[unserializable]');
    expect(formatEvent({ level: 'info', message: throwing as unknown as string }).message).toBe('[unserializable]');
  });

  it('keeps a __proto__ key as an own property', () => {
    const context = JSON.parse('{"__proto__": {"a": 1}, "b": 2}');
    const event = formatEvent({ level: 'info', message: 'm', context });

    expect(Object.keys(event.context as object)).toStrictEqual(['__proto__', 'b']);
    expect(JSON.stringify(event.context)).toBe('{"__proto__":{"a":1},"b":2}');
  });

  it('trims a huge blank fingerprint in linear time', () => {
    const fingerprint = `x${' '.repeat(1_000_000)}x${' '.repeat(1_000_000)}`;
    const started = Date.now();
    const event = formatEvent({ level: 'info', message: 'm', context: { fingerprint } });

    expect(event.fingerprint).toBe(sha1(`x${' '.repeat(1_000_000)}x`));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('serializeException', () => {
  it('uses the constructor name of subclasses', () => {
    class PaymentError extends Error {}

    expect(serializeException(new PaymentError('x')).class).toBe('PaymentError');
  });

  it('reads the location of the first V8 frame with a file, without column', () => {
    const error = new Error('x');
    error.stack = 'Error: x at a:1:2\n    at new Foo (native)\n    at async run (file:///app/src/job.js:12:7)';

    expect(serializeException(error).location).toBe('file:///app/src/job.js:12');
  });

  it('reads the location of Firefox and Safari stacks', () => {
    const error = new Error('x');
    error.stack = 'charge@https://example.com:8080/assets/app.js:10:5\n@https://example.com/other.js:1:1';

    expect(serializeException(error).location).toBe('https://example.com:8080/assets/app.js:10');
  });

  it('leaves the location empty without frames', () => {
    const error = new Error('x');
    error.stack = undefined;

    expect(serializeException(error)).toStrictEqual({ class: 'Error', message: 'x', location: '', trace: '' });
  });

  it('cuts the trace to 2000 code points', () => {
    const error = new Error('x');
    error.stack = '😀'.repeat(2500);

    expect(serializeException(error).trace).toBe('😀'.repeat(2000));
  });
});

describe('helpers', () => {
  it('computes SHA-1', () => {
    expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1('a'.repeat(1000))).toBe('291e9a6c66994949b57ba5e650361e98fc36b1ba');
    expect(sha1('é😀')).toBe('9c286deb5d7549eafd1dcb2b58e0b573bc1b4a97');
  });

  it('measures like PHP json_encode', () => {
    expect(phpJsonSize({ a: '/"\\\n\u0001é😀' })).toBe('{"a":"\\/\\"\\\\\\n\\u0001\\u00e9\\ud83d\\ude00"}'.length);
    expect(phpJsonSize({ 0: 'a', 1: 'b' })).toBe('["a","b"]'.length);
    expect(phpJsonSize([1.5, true, null, {}])).toBe('[1.5,true,null,[]]'.length);
  });

  it('trims like Str::trim', () => {
    expect(trim(' ​ x ﻿\u{E0020}')).toBe('x');
    expect(trim('\u0085x')).toBe('\u0085x');
  });
});
