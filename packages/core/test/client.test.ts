import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  Transport,
  normalizeLevel,
  normalizeTimeout,
  redact,
  type ClientOptions,
  type FetchInit,
  type FetchLike,
  type Scheduler,
  type SerenoEvent,
} from '../src/index.js';

interface Hit {
  headers: IncomingMessage['headers'];
  body: { events: SerenoEvent[] };
}

type Handler = (response: ServerResponse, hit: Hit, count: number) => void;

let server: Server;
let url: string;
let hits: Hit[];
let handler: Handler;

const reply =
  (status: number, body = '{"accepted":1}'): Handler =>
  (response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(body);
  };

beforeEach(async () => {
  hits = [];
  handler = reply(202);
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const hit: Hit = { headers: request.headers, body: JSON.parse(raw) };
      hits.push(hit);
      handler(response, hit, hits.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function make(options: ClientOptions = {}): { client: Client; notices: string[] } {
  const notices: string[] = [];
  const client = new Client({ url, key: 'wsk_test', notifier: (message) => notices.push(message), ...options });

  return { client, notices };
}

function manualScheduler(): Scheduler & { pending: Map<number, { callback: () => void; delay: number }>; fire(): void } {
  const pending = new Map<number, { callback: () => void; delay: number }>();
  let next = 1;

  return {
    pending,
    set(callback, delay) {
      const id = next++;
      pending.set(id, { callback, delay });

      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
    fire() {
      const [first] = pending.entries();

      if (first) {
        pending.delete(first[0]);
        first[1].callback();
      }
    },
  };
}

describe('Client over HTTP', () => {
  it('sends a batch with the bearer key and gets 202', async () => {
    const { client, notices } = make();
    client.log({ level: 'error', message: 'boom', context: { a: 1 } });

    const result = await client.flush();

    expect(result).toEqual({ sent: 1, failed: 0, dropped: 0 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers.authorization).toBe('Bearer wsk_test');
    expect(hits[0]!.headers['content-type']).toBe('application/json');
    expect(hits[0]!.body.events[0]).toMatchObject({ level: 'error', message: 'boom', context: { a: 1 } });
    expect(notices).toEqual([]);
  });

  it('sends right away when the buffer reaches 100 and splits larger flushes', async () => {
    const { client } = make();

    for (let i = 0; i < 99; i++) {
      client.log({ level: 'info', message: `m${i}` });
    }

    expect(hits).toHaveLength(0);
    expect(client.size).toBe(99);

    client.log({ level: 'info', message: 'm99' });
    await client.flush();

    expect(hits).toHaveLength(1);
    expect(hits[0]!.body.events).toHaveLength(100);
    expect(client.size).toBe(0);
  });

  it('does not retry a 401 and reports status, count and body', async () => {
    handler = reply(401, '{"message":"Unauthenticated."}');
    const { client, notices } = make();
    client.log({ level: 'error', message: 'x' });

    const result = await client.flush();

    expect(hits).toHaveLength(1);
    expect(result).toEqual({ sent: 0, failed: 1, dropped: 0 });
    expect(notices).toEqual(['Sereno log delivery failed: status=401 events=1 body={"message":"Unauthenticated."}']);
  });

  it('cuts the reported body at 500 characters', async () => {
    handler = reply(422, 'é'.repeat(900));
    const { client, notices } = make();
    client.log({ level: 'error', message: 'x' });
    await client.flush();

    expect(notices[0]).toBe(`Sereno log delivery failed: status=422 events=1 body=${'é'.repeat(500)}`);
  });

  it('retries a 500 once with the same ids and recovers', async () => {
    handler = (response, _hit, count) => reply(count === 1 ? 500 : 202)(response, _hit, count);
    const { client, notices } = make();
    client.log({ level: 'error', message: 'x' });

    const result = await client.flush();

    expect(hits).toHaveLength(2);
    expect(hits[1]!.body.events.map((e) => e.id)).toEqual(hits[0]!.body.events.map((e) => e.id));
    expect(result.sent).toBe(1);
    expect(notices).toEqual([]);
  });

  it('gives up after one retry on persistent 500', async () => {
    handler = reply(500, 'down');
    const { client, notices } = make();
    client.log({ level: 'error', message: 'x' });

    const result = await client.flush();

    expect(hits).toHaveLength(2);
    expect(result.failed).toBe(1);
    expect(notices).toEqual(['Sereno log delivery failed: status=500 events=1 body=down']);
  });

  it('does not follow redirects and does not retry them', async () => {
    handler = (response) => {
      response.writeHead(302, { Location: `${url}/elsewhere` });
      response.end();
    };
    const { client, notices } = make();
    client.log({ level: 'error', message: 'x' });
    await client.flush();

    expect(hits).toHaveLength(1);
    expect(notices[0]).toContain('status=302');
  });

  it('times out a hanging server, retries once and stays within the budget', async () => {
    handler = () => undefined;
    const { client, notices } = make({ timeout: 0.2 });
    client.log({ level: 'error', message: 'x' });
    const started = Date.now();

    const result = await client.flush();

    expect(Date.now() - started).toBeLessThan(2000);
    expect(hits).toHaveLength(2);
    expect(result.failed).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Sereno log delivery failed: error=.*events=1$/);
  });

  it('retries a network error once and reports it', async () => {
    const { client, notices } = make({ url: 'http://127.0.0.1:1' });
    client.log({ level: 'error', message: 'x' });

    const result = await client.flush();

    expect(result.failed).toBe(1);
    expect(notices).toHaveLength(1);
  });

  it('sends extra headers and fetch options without overriding authorization', async () => {
    const seen: FetchInit[] = [];
    const fetch: FetchLike = (target, init) => {
      seen.push(init);

      return globalThis.fetch(target, init as RequestInit);
    };
    const { client } = make({
      fetch,
      headers: { 'X-Extra': '1', Authorization: 'nope' },
      fetchOptions: { keepalive: true, method: 'GET' },
    });
    client.log({ level: 'info', message: 'x' });
    await client.flush();

    expect(seen[0]).toMatchObject({ keepalive: true, method: 'POST', redirect: 'manual' });
    expect(hits[0]!.headers['x-extra']).toBe('1');
    expect(hits[0]!.headers.authorization).toBe('Bearer wsk_test');
  });
});

describe('Client buffering', () => {
  it('is inert without url or key', async () => {
    for (const options of [{ url: '' }, { key: null }, { url: undefined, key: undefined }]) {
      const { client, notices } = make(options);
      client.log({ level: 'emergency', message: 'x' });

      expect(client.configured).toBe(false);
      expect(client.size).toBe(0);
      expect(await client.flush()).toEqual({ sent: 0, failed: 0, dropped: 0 });
      expect(notices).toEqual([]);
    }

    expect(hits).toHaveLength(0);
  });

  it('honors the minimum level', async () => {
    const { client } = make({ level: 'warning' });
    client.log({ level: 'info', message: 'skip' });
    client.log({ level: 'warning', message: 'keep' });
    client.log({ level: 'nope' as never, message: 'skip too' });
    await client.flush();

    expect(hits[0]!.body.events.map((e) => e.message)).toEqual(['keep']);
  });

  it('normalizes level and timeout', () => {
    expect(normalizeLevel('ERROR')).toBe('error');
    expect(normalizeLevel('nope')).toBe('debug');
    expect(normalizeLevel(undefined)).toBe('debug');
    expect(normalizeTimeout(undefined)).toBe(2);
    expect(normalizeTimeout('abc')).toBe(2);
    expect(normalizeTimeout('')).toBe(2);
    expect(normalizeTimeout(0)).toBe(2);
    expect(normalizeTimeout(-3)).toBe(2);
    expect(normalizeTimeout(Number.NaN)).toBe(2);
    expect(normalizeTimeout(5)).toBe(5);
    expect(normalizeTimeout(' 0.5 ')).toBe(0.5);
    expect(normalizeTimeout(60)).toBe(10);
    expect(normalizeTimeout(Number.POSITIVE_INFINITY)).toBe(10);
    expect(new Transport(url, 'k', { timeout: 99 }).timeout).toBe(10);
  });

  it('caps the buffer at 1000 and reports the dropped events once', async () => {
    const batches: number[] = [];
    const fetch: FetchLike = async (_target, init) => {
      batches.push(JSON.parse(init.body).events.length);

      return { status: 202, text: async () => '' };
    };
    const { client, notices } = make({ fetch, scheduler: manualScheduler() });

    for (let i = 0; i < 1000; i++) {
      client.log({ level: 'info', message: 'a' });
    }
    client.log({ level: 'info', message: 'lost 1' });
    client.log({ level: 'info', message: 'lost 2' });

    expect(client.size).toBe(1000);

    await client.flush();

    expect(client.size).toBe(0);
    expect(notices).toEqual(['Sereno dropped 2 log events: buffer limit of 1000 reached']);
    expect(batches.every((n) => n <= 100)).toBe(true);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(1000);

    client.log({ level: 'info', message: 'again' });
    await client.flush();

    expect(notices).toHaveLength(1);
  });

  it('counts pending events against the cap while a slow send is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sizes: number[] = [];
    const fetch: FetchLike = async (_target, init) => {
      sizes.push(JSON.parse(init.body).events.length);
      await gate;

      return { status: 202, text: async () => '' };
    };
    const { client, notices } = make({ fetch, scheduler: manualScheduler() });

    for (let i = 0; i < 100; i++) {
      client.log({ level: 'info', message: 'a' });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sizes).toEqual([100]);
    expect(client.size).toBe(0);

    for (let i = 0; i < 1005; i++) {
      client.log({ level: 'info', message: 'b' });
    }

    expect(client.size).toBe(1000);

    release();
    await client.flush();

    expect(notices).toEqual(['Sereno dropped 5 log events: buffer limit of 1000 reached']);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1100);
  });

  it('does not buffer what is logged while reporting a failure', async () => {
    let client!: Client;
    handler = reply(500, 'x');
    const made = make({
      notifier: () => {
        client.log({ level: 'error', message: 'from the notifier' });
        expect(client.reentrant).toBe(true);
      },
    });
    client = made.client;
    client.log({ level: 'error', message: 'x' });
    await client.flush();

    expect(client.size).toBe(0);
    expect(client.reentrant).toBe(false);
    expect(hits.every((hit) => hit.body.events.every((e) => e.message === 'x'))).toBe(true);
  });

  it('keeps events logged by the app while a batch is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sentMessages: string[][] = [];
    const fetch: FetchLike = async (_target, init) => {
      sentMessages.push(JSON.parse(init.body).events.map((e: SerenoEvent) => e.message));
      await gate;

      return { status: 202, text: async () => '' };
    };
    const { client } = make({ fetch, scheduler: manualScheduler() });
    client.log({ level: 'info', message: 'first' });
    const first = client.flush();
    await Promise.resolve();
    client.log({ level: 'info', message: 'during' });

    expect(client.size).toBe(1);

    release();
    await first;
    await client.flush();

    expect(sentMessages).toEqual([['first'], ['during']]);
  });

  it('flushes one second after the first buffered event and cancels the timer on flush', async () => {
    const scheduler = manualScheduler();
    const { client } = make({ scheduler });

    client.log({ level: 'info', message: 'a' });
    client.log({ level: 'info', message: 'b' });

    expect([...scheduler.pending.values()].map((t) => t.delay)).toEqual([1000]);

    scheduler.fire();
    await client.flush();

    expect(hits).toHaveLength(1);
    expect(hits[0]!.body.events).toHaveLength(2);
    expect(scheduler.pending.size).toBe(0);

    client.log({ level: 'info', message: 'c' });
    expect(scheduler.pending.size).toBe(1);
    await client.flush();
    expect(scheduler.pending.size).toBe(0);
  });

  it('does not keep the process alive with its flush timer', () => {
    let unrefCalled = false;
    const real = globalThis.setTimeout;
    const patched = ((callback: () => void, delay: number) => {
      const handle = real(callback, delay);
      const unref = handle.unref.bind(handle);
      handle.unref = () => {
        unrefCalled = true;

        return unref();
      };

      return handle;
    }) as typeof setTimeout;
    globalThis.setTimeout = patched;

    try {
      const { client } = make();
      client.log({ level: 'info', message: 'a' });
    } finally {
      globalThis.setTimeout = real;
    }

    expect(unrefCalled).toBe(true);
  });
});

describe('Transport budget and resilience', () => {
  const failing: FetchLike = async () => {
    throw new Error('network down');
  };

  it('skips the retry when less than 0.5 s of the 10 s budget is left', async () => {
    let calls = 0;
    let time = 0;
    const transport = new Transport(url, 'k', {
      now: () => time,
      fetch: async () => {
        calls++;
        time += 9600;

        return { status: 500, text: async () => 'e' };
      },
    });

    const result = await transport.send([]);

    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: 'rejected', code: 500, attempts: 1 });
  });

  it('makes a single attempt on a 500 or a network error when retry is false', async () => {
    let calls = 0;
    const rejected = new Transport(url, 'k', {
      retry: false,
      fetch: async () => {
        calls++;

        return { status: 500, text: async () => 'e' };
      },
    });

    expect(await rejected.send([])).toMatchObject({ status: 'rejected', code: 500, attempts: 1 });
    expect(await new Transport(url, 'k', { retry: false, fetch: failing }).send([])).toMatchObject({ status: 'error', attempts: 1 });
    expect(calls).toBe(1);
  });

  it('retries with the remaining budget when it is below the timeout', async () => {
    const delays: number[] = [];
    let time = 0;
    const scheduler: Scheduler = {
      set(_callback, delay) {
        delays.push(delay);

        return delays.length;
      },
      clear() {},
    };
    const transport = new Transport(url, 'k', {
      timeout: 5,
      scheduler,
      now: () => time,
      fetch: async () => {
        time += 7000;

        return { status: 503, text: async () => '' };
      },
    });

    await transport.send([]);

    expect(delays).toEqual([5000, 3000]);
  });

  it('turns an unserializable payload into an error without retrying', async () => {
    let calls = 0;
    const transport = new Transport(url, 'k', {
      fetch: async () => {
        calls++;

        return { status: 202, text: async () => '' };
      },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = await transport.send([circular as unknown as SerenoEvent]);

    expect(calls).toBe(0);
    expect(result.status).toBe('error');
  });

  it('reports a missing fetch instead of throwing', async () => {
    const real = globalThis.fetch;
    // @ts-expect-error simulating an environment without fetch
    globalThis.fetch = undefined;

    try {
      const { client, notices } = make({ fetch: undefined });
      client.log({ level: 'error', message: 'x' });
      const result = await client.flush();

      expect(result.failed).toBe(1);
      expect(notices[0]).toContain('fetch is not available');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('does not treat a missing fetch as transient', async () => {
    const real = globalThis.fetch;
    // @ts-expect-error simulating an environment without fetch
    globalThis.fetch = undefined;

    try {
      const result = await new Transport(url, 'k').send([]);

      expect(result).toMatchObject({ status: 'error', transient: false, attempts: 1 });
    } finally {
      globalThis.fetch = real;
    }
  });

  it('does not retry when the status arrived but the body stalls', async () => {
    let calls = 0;
    const transport = new Transport(url, 'k', {
      timeout: 0.1,
      fetch: async () => {
        calls++;

        return { status: 401, text: () => new Promise<string>(() => undefined) };
      },
    });

    const result = await transport.send([]);

    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: 'rejected', code: 401, body: '' });
  });

  it('never rejects or throws, even with a failing notifier and fetch', async () => {
    const { client } = make({
      fetch: failing,
      notifier: () => {
        throw new Error('notifier broke');
      },
    });

    expect(() => client.log({ level: 'error', message: 'x' })).not.toThrow();
    expect(() => client.log(null as never)).not.toThrow();
    expect(() => client.log({ level: 'error', get message(): string { throw new Error('getter'); } })).not.toThrow();
    await expect(client.flush()).resolves.toMatchObject({ failed: expect.any(Number) });
  });

  it('writes the default notice through console.error', async () => {
    const original = console.error;
    const lines: unknown[] = [];
    console.error = (message: unknown) => void lines.push(message);

    try {
      const client = new Client({ url, key: 'wsk_test', fetch: failing });
      client.log({ level: 'error', message: 'x' });
      await client.flush();
    } finally {
      console.error = original;
    }

    expect(lines).toEqual(['Sereno log delivery failed: error=network down events=1']);
  });
});

describe('Transport error redaction', () => {
  it('redacts the key from a network error message', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('failed with Bearer wsk_secret and wsk_secret');
    };
    const result = await new Transport(url, 'wsk_secret', { retry: false, fetch }).send([]);

    expect(result).toMatchObject({ status: 'error', error: 'failed with *** and ***' });
  });

  it('redacts a key with an inner line break, raw and escaped', async () => {
    const key = 'wsk_a\nb';
    const fetch: FetchLike = async () => {
      throw new Error(`raw ${key} escaped wsk_a\\nb`);
    };
    const result = await new Transport(url, key, { retry: false, fetch }).send([]);

    expect(result).toMatchObject({ status: 'error', error: 'raw *** escaped ***' });
  });

  it('drops userinfo from URLs in the error message', async () => {
    const key = 'wsk_7f3a9c1e5b2d8a4f6e0c9b7d1a3f5e8c';
    const fetch: FetchLike = async () => {
      throw new Error(`connect to http://user:${key}@example.test/api failed with ${key}`);
    };
    const result = await new Transport(`http://user:${key}@example.test`, key, { retry: false, fetch }).send([]);

    expect(result).toMatchObject({ status: 'error', error: 'connect to http://example.test/api failed with ***' });
    expect(redact('see https://u@h/x and https://h/a@b', '')).toBe('see https://h/x and https://h/a@b');
  });
});
