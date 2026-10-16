// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchInit, SerenoEvent } from '@ascariodev/sereno-core';
import {
  DEDUPE_WINDOW_MS,
  KEEPALIVE_BUDGET_BYTES,
  MAX_EVENTS_PER_PAGE,
  captureException,
  close,
  flush,
  getClient,
  init,
  log,
} from '../src/index.js';
import type { InitOptions } from '../src/index.js';

interface Dom {
  window: {
    dispatchEvent(event: Event): boolean;
    history: { replaceState(data: unknown, unused: string, url: string): void };
    location: { origin: string };
  };
  document: { dispatchEvent(event: Event): boolean };
  ErrorEvent: new (type: string, init: Record<string, unknown>) => Event;
}

const dom = globalThis as unknown as Dom;

const KEY ='wsp_' + 'a'.repeat(40);

interface Call {
  url: string;
  init: FetchInit;
  events: SerenoEvent[];
}

let calls: Call[];
let notices: string[];

function okFetch(url: string, request: FetchInit) {
  calls.push({ url, init: request, events: (JSON.parse(request.body) as { events: SerenoEvent[] }).events });

  return Promise.resolve({ status: 202, text: async () => '{"accepted":1}' });
}

function start(options: InitOptions = {}) {
  return init({ url: 'http://localhost:8003', key: KEY, fetch: okFetch, notifier: (message) => notices.push(message), ...options });
}

function sameError(): Error {
  return new Error('same place');
}

function sent(): SerenoEvent[] {
  return calls.flatMap((call) => call.events);
}

function dispatchError(error: unknown, extra: Record<string, unknown> = {}) {
  dom.window.dispatchEvent(new dom.ErrorEvent('error', { error, message: error instanceof Error ? error.message : '', ...extra }));
}

function dispatchRejection(reason: unknown) {
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: reason });
  dom.window.dispatchEvent(event);
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(dom.document, 'visibilityState', { value: state, configurable: true });
  dom.document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  calls = [];
  notices = [];
  dom.window.history.replaceState({}, '', '/');
});

afterEach(async () => {
  await close();
  vi.useRealTimers();
  setVisibility('visible');
});

describe('global capture', () => {
  it('captures uncaught errors with the exception context', async () => {
    start();
    dispatchError(new TypeError('boom'));
    await flush();

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ level: 'error', message: 'boom', context: { exception: { class: 'TypeError', message: 'boom' } } });
    expect(sent()[0]?.fingerprint).toMatch(/^TypeError\|/);
    expect(calls[0]?.url).toBe('http://localhost:8003/api/ingest/events');
    expect(calls[0]?.init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('captures error events without an Error, stripping the query from the file', async () => {
    start();
    dispatchError(null, { message: 'Script error.', filename: 'https://cdn.test/app.js?token=x', lineno: 3, colno: 7 });
    await flush();

    expect(sent()[0]).toMatchObject({ message: 'Script error.', context: { file: 'https://cdn.test/app.js', line: 3, column: 7 } });
  });

  it('captures unhandled rejections of errors and of other values', async () => {
    start();
    dispatchRejection(new RangeError('rejected'));
    dispatchRejection('plain reason');
    await flush();

    expect(sent().map((event) => event.message)).toEqual(['rejected', 'plain reason']);
    expect(sent()[0]?.context).toMatchObject({ exception: { class: 'RangeError' } });
  });

  it('puts the page URL in the context without query or fragment', async () => {
    dom.window.history.replaceState({}, '', '/app/page?token=secret#access_token=x');
    start();
    log('warning', 'hello', { extra: 1 });
    await flush();

    expect(sent()[0]?.context).toEqual({ url: `${dom.window.location.origin}/app/page`, extra: 1 });
  });

  it('captures manually with captureException and log, like sereno-node', async () => {
    start();
    captureException(new Error('manual'), { order: 5 });
    log('info', 'note');
    await flush();

    expect(sent().map((event) => event.message)).toEqual(['manual', 'note']);
    expect(sent()[0]?.context).toMatchObject({ order: 5, exception: { class: 'Error' } });
  });

  it('honours the minimum level', async () => {
    start({ level: 'error' });
    log('warning', 'ignored');
    log('error', 'kept');
    await flush();

    expect(sent().map((event) => event.message)).toEqual(['kept']);
  });

  it('stops listening after close and stays inert without a key', async () => {
    start();
    await close();
    expect(getClient()).toBeUndefined();

    const inert = init({ url: 'http://localhost:8003', key: '  ', fetch: okFetch });
    log('error', 'nothing');
    await flush();

    expect(inert.configured).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('deduplication and page limit', () => {
  it('sends the same fingerprint once every 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    start();

    dispatchError(sameError());
    dispatchError(sameError());
    vi.setSystemTime(Date.now() + DEDUPE_WINDOW_MS - 1);
    dispatchError(sameError());
    vi.setSystemTime(Date.now() + 1);
    dispatchError(sameError());
    log('error', 'other');
    log('error', 'other');
    await flush();

    expect(sent().map((event) => event.message)).toEqual(['same place', 'same place', 'other']);
  });

  it(`accepts at most ${MAX_EVENTS_PER_PAGE} events per page and warns once without the key`, async () => {
    const client = start();

    for (let index = 0; index < MAX_EVENTS_PER_PAGE + 50; index++) {
      log('error', `event ${index}`);
    }

    expect(client.count).toBe(MAX_EVENTS_PER_PAGE);
    await flush();

    expect(sent()).toHaveLength(MAX_EVENTS_PER_PAGE);
    expect(notices).toEqual([`Sereno reached the limit of ${MAX_EVENTS_PER_PAGE} events for this page; further events are dropped`]);
    expect(notices.join('\n')).not.toContain(KEY);
  });
});

describe('flushing when the page goes away', () => {
  it('uses plain fetch while the page lives', async () => {
    start();
    log('error', 'alive');
    await flush();

    expect(calls[0]?.init.keepalive).toBeUndefined();
  });

  it('flushes with keepalive on pagehide', async () => {
    start();
    log('error', 'leaving');
    dom.window.dispatchEvent(new Event('pagehide'));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.keepalive).toBe(true);
  });

  it('flushes with keepalive when the page is hidden and goes back to plain fetch when visible', async () => {
    start();
    log('error', 'hidden');
    setVisibility('hidden');
    await flush();
    setVisibility('visible');
    log('error', 'visible again');
    await flush();

    expect(calls.map((call) => call.init.keepalive)).toEqual([true, undefined]);
  });

  it('never uses keepalive in mode never', async () => {
    start({ keepalive: 'never' });
    log('error', 'leaving');
    dom.window.dispatchEvent(new Event('pagehide'));
    await flush();

    expect(calls[0]?.init.keepalive).toBeUndefined();
  });

  it('keeps the keepalive body under the budget and reports what it drops', async () => {
    start();

    for (let index = 0; index < 10; index++) {
      log('error', `${index}`.padEnd(8000, 'x'));
    }

    dom.window.dispatchEvent(new Event('pagehide'));
    await flush();

    expect(calls).toHaveLength(1);
    expect(new TextEncoder().encode(calls[0]!.init.body).length).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);
    expect(calls[0]!.events.length).toBeGreaterThan(0);
    expect(notices).toEqual([
      `Sereno dropped ${10 - calls[0]!.events.length} log events: keepalive limit of ${KEEPALIVE_BUDGET_BYTES} bytes reached`,
    ]);
  });

  it('does not report delivery failures while the page is going away', async () => {
    start({ fetch: () => Promise.reject(new Error('network down')) });
    log('error', 'lost');
    dom.window.dispatchEvent(new Event('pagehide'));
    await flush();

    expect(notices).toEqual([]);
  });

  it('goes back to plain fetch on pageshow after pagehide (bfcache)', async () => {
    start();
    dom.window.dispatchEvent(new Event('pagehide'));
    dom.window.dispatchEvent(new Event('pageshow'));
    log('error', 'restored');
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.keepalive).toBeUndefined();
  });

  it('measures the keepalive budget in UTF-8 bytes, not UTF-16 units', async () => {
    start();

    for (let index = 0; index < 10; index++) {
      log('error', `${index}`.padEnd(4000, '😀'));
    }

    dom.window.dispatchEvent(new Event('pagehide'));
    await flush();

    const body = calls[0]!.init.body;

    expect(body.length).toBeLessThan(KEEPALIVE_BUDGET_BYTES);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);
    expect(calls[0]!.events.length).toBeLessThan(10);
  });

  it('counts requests still in flight against the keepalive budget', async () => {
    const pending: Call[] = [];
    start({
      timeout: 0.05,
      fetch: (url, request) => {
        pending.push({ url, init: request, events: (JSON.parse(request.body) as { events: SerenoEvent[] }).events });

        return new Promise(() => undefined);
      },
    });

    for (let index = 0; index < 5; index++) {
      log('error', `${index}`.padEnd(8000, 'x'));
    }

    dom.window.dispatchEvent(new Event('pagehide'));
    await flush();

    const bytes = pending.map((call) => new TextEncoder().encode(call.init.body).length);

    expect(pending).toHaveLength(2);
    expect(pending.every((call) => call.init.keepalive === true)).toBe(true);
    expect(pending[0]!.events).toHaveLength(5);
    expect(pending[1]!.events.length).toBeLessThan(5);
    expect(bytes[0]! + bytes[1]!).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);
  });
});

describe('never throws', () => {
  it('returns an inert client with one notice for invalid options', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const throwingOptions = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
        get() {
          throw new Error('trap');
        },
      },
    );
    const candidates: unknown[] = [null, 42, { url: 5, key: KEY }, { url: 'http://localhost:8003', key: {} }, throwingOptions];

    for (const options of candidates) {
      const client = init(options as InitOptions);
      log('error', 'nothing');
      await flush();

      expect(client.configured).toBe(false);
    }

    const notified: string[] = [];
    expect(init({ url: 7 as unknown as string, key: KEY, notifier: (message) => notified.push(message) }).configured).toBe(false);

    expect(calls).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledTimes(candidates.length);
    expect(notified).toHaveLength(1);
    expect([...consoleError.mock.calls.flat(), ...notified].join('\n')).not.toContain(KEY);
    consoleError.mockRestore();
  });

  it('survives failing fetch, notifier and hostile values without looping', async () => {
    const throwingFetch = vi.fn(() => {
      throw new Error('fetch exploded');
    });
    const client = init({
      url: 'http://localhost:8003',
      key: KEY,
      fetch: throwingFetch,
      notifier: () => {
        throw new Error('notifier exploded');
      },
    });
    const hostile = {
      toString() {
        throw new Error('no string');
      },
    };
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );

    expect(() => {
      dispatchError(new Error('first'));
      dispatchRejection(hostile);
      dispatchRejection(trap);
      captureException(hostile);
      captureException(trap, trap as Record<string, unknown>);
      log('error', hostile as unknown as string, trap as Record<string, unknown>);
    }).not.toThrow();

    const result = await flush();

    expect(result.failed).toBeGreaterThan(0);
    expect(client.size).toBe(0);
    expect(throwingFetch).toHaveBeenCalledTimes(2);
  });

  it('does nothing before init', async () => {
    expect(() => {
      captureException(new Error('early'));
      log('error', 'early');
    }).not.toThrow();
    await expect(flush()).resolves.toEqual({ sent: 0, failed: 0, dropped: 0 });
  });
});
