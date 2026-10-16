import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SerenoEvent } from '@ascariodev/sereno-core';
import { expressErrorHandler } from '../src/express.js';
import { close, flush, init } from '../src/index.js';

let sink: Server;
let app: Server;
let events: SerenoEvent[];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function build(configure: (instance: express.Express) => void): Promise<string> {
  const instance = express();
  configure(instance);
  instance.use(expressErrorHandler());
  app = createServer(instance);

  return listen(app);
}

beforeEach(async () => {
  events = [];
  sink = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      events.push(...(JSON.parse(raw) as { events: SerenoEvent[] }).events);
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end('{"accepted":1}');
    });
  });
  init({ url: await listen(sink), key: 'wsk_test', handlers: false });
});

afterEach(async () => {
  await close();
  app?.closeAllConnections();
  sink.closeAllConnections();
  await Promise.all([new Promise((resolve) => app?.close(resolve)), new Promise((resolve) => sink.close(resolve))]);
});

describe('expressErrorHandler', () => {
  it('captures a synchronous throw with method and route pattern (relative to its router) and leaves Express response intact', async () => {
    const base = await build((instance) => {
      const router = express.Router();
      router.get('/users/:id', () => {
        throw new Error('sync boom');
      });
      instance.use('/api', router);
    });

    const response = await fetch(`${base}/api/users/42?token=secret`);
    await flush();

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Error: sync boom');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'error', message: 'sync boom', context: { method: 'GET', route: '/users/:id' } });
    expect(JSON.stringify(events[0])).not.toContain('secret');
  });

  it('captures an async rejection (Express 5) and keeps the response', async () => {
    const base = await build((instance) => {
      instance.post('/jobs', async () => {
        await Promise.resolve();
        throw new TypeError('async boom');
      });
    });

    const response = await fetch(`${base}/jobs`, { method: 'POST' });
    await flush();

    expect(response.status).toBe(500);
    expect(events.map((event) => event.message)).toEqual(['async boom']);
    expect(events[0]?.context).toMatchObject({ method: 'POST', route: '/jobs' });
  });

  it('ignores errors with a status below 500 and keeps their response', async () => {
    const base = await build((instance) => {
      instance.get('/missing', () => {
        throw Object.assign(new Error('nope'), { status: 404 });
      });
    });

    const response = await fetch(`${base}/missing`);
    await flush();

    expect(response.status).toBe(404);
    expect(events).toHaveLength(0);
  });

  it('captures errors with a 5xx status', async () => {
    const base = await build((instance) => {
      instance.get('/down', () => {
        throw Object.assign(new Error('unavailable'), { statusCode: 503 });
      });
    });

    const response = await fetch(`${base}/down`);
    await flush();

    expect(response.status).toBe(503);
    expect(events.map((event) => event.message)).toEqual(['unavailable']);
  });

  it('only passes the error on when the SDK is not initialized', async () => {
    await close();
    const base = await build((instance) => {
      instance.get('/boom', () => {
        throw new Error('inert');
      });
    });

    const response = await fetch(`${base}/boom`);

    expect(response.status).toBe(500);
    expect(events).toHaveLength(0);
  });

  it('calls next(error) even when headers were already sent', async () => {
    const base = await build((instance) => {
      instance.get('/partial', (_request, response) => {
        response.write('partial');
        throw new Error('late');
      });
    });

    await fetch(`${base}/partial`).then((response) => response.text()).catch(() => undefined);
    await flush();

    expect(events.map((event) => event.message)).toEqual(['late']);
  });
});
