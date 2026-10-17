import 'reflect-metadata';
import { Controller, Get, HttpException, Logger, Module, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost, INestApplication } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SerenoEvent } from '@ascariodev/sereno-core';
import { close, flush, getClient, init } from '../src/index.js';
import { SerenoExceptionFilter, SerenoModule } from '../src/nest.js';

class UsersController {
  show(): never {
    throw new Error('nest boom');
  }

  missing(): never {
    throw new NotFoundException('no such user');
  }

  unavailable(): never {
    throw new HttpException('maintenance', 503);
  }
}

Controller()(UsersController);
for (const [method, path] of [['show', 'users/:id'], ['missing', 'missing'], ['unavailable', 'down']] as const) {
  Get(path)(UsersController.prototype, method, Object.getOwnPropertyDescriptor(UsersController.prototype, method)!);
}

let sink: Server;
let apps: INestApplication[];
let events: SerenoEvent[];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function start(imports: unknown[], configure?: (app: INestApplication) => void): Promise<string> {
  class AppModule {}
  Module({ imports: imports as never[], controllers: [UsersController] })(AppModule);

  const app = await NestFactory.create(AppModule, { logger: false });
  configure?.(app);
  await app.listen(0, '127.0.0.1');
  apps.push(app);

  return `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}

async function snapshot(response: Response): Promise<{ status: number; type: string | null; body: string }> {
  return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
}

beforeEach(async () => {
  events = [];
  apps = [];
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
  await Promise.all(apps.map((app) => app.close()));
  sink.closeAllConnections();
  await new Promise((resolve) => sink.close(resolve));
});

describe('SerenoExceptionFilter', () => {
  it('captures a 500 with method and route pattern, ignores a 404, and leaves both responses as Nest sends them', async () => {
    const plain = await start([]);
    const filtered = await start([SerenoModule.forRoot()]);

    for (const path of ['/users/42?token=secret', '/missing']) {
      expect(await snapshot(await fetch(`${filtered}${path}`))).toEqual(await snapshot(await fetch(`${plain}${path}`)));
    }
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'error', message: 'nest boom', context: { method: 'GET', route: '/users/:id' } });
    expect(JSON.stringify(events[0])).not.toContain('secret');
  });

  it('captures an HttpException with a 5xx status', async () => {
    const base = await start([SerenoModule.forRoot()]);

    const response = await fetch(`${base}/down`);
    await flush();

    expect(response.status).toBe(503);
    expect(events.map((event) => event.message)).toEqual(['maintenance']);
  });

  it('works registered with useGlobalFilters and the HTTP adapter', async () => {
    const base = await start([], (app) => app.useGlobalFilters(new SerenoExceptionFilter(app.get(HttpAdapterHost).httpAdapter)));

    const response = await fetch(`${base}/users/7`);
    await flush();

    expect(response.status).toBe(500);
    expect(events.map((event) => event.message)).toEqual(['nest boom']);
  });

  it('forRoot with options initializes the SDK', async () => {
    const url = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    await close();
    expect(getClient()).toBeUndefined();

    const base = await start([SerenoModule.forRoot({ url, key: 'wsk_test', handlers: false })]);
    const response = await fetch(`${base}/users/1`);
    await flush();

    expect(response.status).toBe(500);
    expect(events.map((event) => event.message)).toEqual(['nest boom']);
  });

  it('only delegates when the SDK is not initialized', async () => {
    await close();
    const base = await start([SerenoModule.forRoot()]);

    const response = await fetch(`${base}/users/1`);

    expect(response.status).toBe(500);
    expect(events).toHaveLength(0);
  });

  it('forRoot with options does not replace an SDK that is already initialized', async () => {
    const client = getClient();

    SerenoModule.forRoot({ url: 'http://127.0.0.1:1', key: 'wsk_other', handlers: false });

    expect(getClient()).toBe(client);
  });
});

class RpcException extends Error {
  constructor(private readonly error: unknown) {
    super(typeof error === 'string' ? error : 'Rpc Exception');
  }

  getError(): unknown {
    return this.error;
  }
}

class WsException extends RpcException {}

class CustomRpcException extends RpcException {}

class LookalikeError extends Error {
  getError(): unknown {
    return 'nope';
  }
}

function fakeHost(type: string, emit?: (event: string, payload: unknown) => void): ArgumentsHost {
  const ws = { getClient: () => ({ emit }), getData: () => ({ id: 1 }), getPattern: () => 'join' };

  return { getType: () => type, switchToWs: () => ws } as unknown as ArgumentsHost;
}

describe('SerenoExceptionFilter outside HTTP', () => {
  beforeEach(() => Logger.overrideLogger(false));
  afterEach(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  it('rpc: captures only unexpected errors and returns the error observable of BaseRpcExceptionFilter', async () => {
    const filter = new SerenoExceptionFilter();

    await expect(firstValueFrom(filter.catch(new Error('rpc boom'), fakeHost('rpc')) as Observable<never>)).rejects.toEqual({
      status: 'error',
      message: 'Internal server error',
    });
    await expect(firstValueFrom(filter.catch(new RpcException('denied'), fakeHost('rpc')) as Observable<never>)).rejects.toEqual({
      status: 'error',
      message: 'denied',
    });
    await expect(firstValueFrom(filter.catch(new RpcException({ code: 7 }), fakeHost('rpc')) as Observable<never>)).rejects.toEqual({ code: 7 });
    await flush();

    expect(events.map((event) => event.message)).toEqual(['rpc boom']);
    expect(events[0]?.context).not.toHaveProperty('route');
  });

  it('ws: captures only unexpected errors and emits what BaseWsExceptionFilter emits', async () => {
    const emitted: unknown[] = [];
    const host = fakeHost('ws', (event, payload) => emitted.push([event, payload]));
    const filter = new SerenoExceptionFilter();

    expect(() => filter.catch(new Error('ws boom'), host)).not.toThrow();
    filter.catch(new WsException('forbidden'), host);
    filter.catch(new WsException({ code: 9 }), host);
    filter.catch(new Error('no emit'), fakeHost('ws'));
    await flush();

    expect(emitted).toEqual([
      ['exception', { status: 'error', message: 'Internal server error', cause: { pattern: 'join', data: { id: 1 } } }],
      ['exception', { status: 'error', message: 'forbidden', cause: { pattern: 'join', data: { id: 1 } } }],
      ['exception', { code: 9 }],
    ]);
    expect(events.map((event) => event.message)).toEqual(['ws boom', 'no emit']);
  });

  it('does not capture RpcException, WsException or their subclasses, but captures lookalikes', async () => {
    const filter = new SerenoExceptionFilter();
    const host = fakeHost('ws', () => undefined);

    filter.catch(new RpcException('a'), host);
    filter.catch(new WsException('b'), host);
    filter.catch(new CustomRpcException('c'), host);
    await expect(firstValueFrom(filter.catch(new CustomRpcException('d'), fakeHost('rpc')) as Observable<never>)).rejects.toEqual({
      status: 'error',
      message: 'd',
    });
    filter.catch(new LookalikeError('lookalike'), host);
    await flush();

    expect(events.map((event) => event.message)).toEqual(['lookalike']);
  });
});
