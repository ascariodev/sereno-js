import 'reflect-metadata';
import { Controller, Get, Module, UseFilters } from '@nestjs/common';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientProxyFactory, MessagePattern, RpcException, Transport } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { WsAdapter } from '@nestjs/platform-ws';
import { SubscribeMessage, WebSocketGateway, WsException } from '@nestjs/websockets';
import type { AddressInfo, Server } from 'node:net';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { close, flush, init } from '../src/index.js';
import { SerenoExceptionFilter, SerenoModule } from '../src/nest.js';
import { startSink } from './sink.js';
import type { Sink } from './sink.js';

let sink: Sink;
const closers: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  sink = await startSink();
  init({ url: sink.url, key: 'wsk_test', handlers: false });
});

afterEach(async () => {
  await close();
  while (closers.length) {
    await closers.pop()!();
  }
  await sink.stop();
});

function messages(): string[] {
  return sink.events.map((event) => event.message);
}

describe('SerenoExceptionFilter against real Nest transports', () => {
  it('microservice over TCP: captures an unexpected error and replies like Nest, ignores RpcException', async () => {
    class MathController {
      boom(): never {
        throw new Error('rpc real boom');
      }

      denied(): never {
        throw new RpcException('denied');
      }
    }
    Controller()(MathController);
    for (const method of ['boom', 'denied'] as const) {
      MessagePattern(method)(MathController.prototype, method, Object.getOwnPropertyDescriptor(MathController.prototype, method)!);
    }
    class AppModule {}
    Module({ imports: [SerenoModule.forRoot()], controllers: [MathController] })(AppModule);

    const microservice: INestMicroservice = await NestFactory.createMicroservice(AppModule, {
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: 0 },
      logger: false,
    });
    await microservice.listen();
    const port = (microservice.unwrap<Server>().address() as AddressInfo).port;
    closers.push(() => microservice.close());
    const client: ClientProxy = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: '127.0.0.1', port } });
    closers.push(() => client.close());

    await expect(firstValueFrom(client.send('boom', {}))).rejects.toEqual({ status: 'error', message: 'Internal server error' });
    await expect(firstValueFrom(client.send('denied', {}))).rejects.toEqual({ status: 'error', message: 'denied' });
    await flush();

    expect(messages()).toEqual(['rpc real boom']);
  });

  it('ws gateway with @UseFilters: captures an unexpected error, ignores WsException', async () => {
    const emitted: unknown[] = [];
    class ChatGateway {
      handleConnection(client: WebSocket): void {
        client.on('exception', (payload: unknown) => emitted.push(payload));
      }

      boom(): never {
        throw new Error('ws real boom');
      }

      denied(): never {
        throw new WsException('forbidden');
      }
    }
    WebSocketGateway()(ChatGateway);
    UseFilters(SerenoExceptionFilter)(ChatGateway);
    for (const method of ['boom', 'denied'] as const) {
      SubscribeMessage(method)(ChatGateway.prototype, method, Object.getOwnPropertyDescriptor(ChatGateway.prototype, method)!);
    }
    class AppModule {}
    Module({ imports: [SerenoModule.forRoot()], providers: [ChatGateway] })(AppModule);

    const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0, '127.0.0.1');
    closers.push(() => app.close());

    const socket = new WebSocket(`ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    closers.push(async () => socket.terminate());
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.send(JSON.stringify({ event: 'boom', data: { id: 1 } }));
    socket.send(JSON.stringify({ event: 'denied', data: {} }));
    for (let attempt = 0; attempt < 100 && emitted.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await flush();

    expect(emitted).toMatchObject([
      { status: 'error', message: 'Internal server error' },
      { status: 'error', message: 'forbidden' },
    ]);
    expect(messages()).toEqual(['ws real boom']);
  });

  it('Fastify: captures a 500 with method and route pattern, answers like Nest without the filter', async () => {
    class ItemsController {
      show(): never {
        throw new Error('fastify boom');
      }
    }
    Controller()(ItemsController);
    Get('items/:id')(ItemsController.prototype, 'show', Object.getOwnPropertyDescriptor(ItemsController.prototype, 'show')!);

    async function boot(imports: unknown[]): Promise<string> {
      class AppModule {}
      Module({ imports: imports as never[], controllers: [ItemsController] })(AppModule);
      const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
      await app.listen(0, '127.0.0.1');
      closers.push(() => app.close());

      return await app.getUrl();
    }

    const plain = await boot([]);
    const filtered = await boot([SerenoModule.forRoot()]);
    const [expected, actual] = await Promise.all([fetch(`${plain}/items/9?token=secret`), fetch(`${filtered}/items/9?token=secret`)]);
    await flush();

    expect(actual.status).toBe(500);
    expect(await actual.text()).toBe(await expected.text());
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ message: 'fastify boom', context: { method: 'GET', route: '/items/:id' } });
    expect(JSON.stringify(sink.events[0])).not.toContain('secret');
  });
});
