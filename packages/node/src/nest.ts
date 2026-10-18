import * as nestCommon from '@nestjs/common';
import { Catch, HttpException, Logger, Module } from '@nestjs/common';
import type { ArgumentsHost, DynamicModule } from '@nestjs/common';
import { APP_FILTER, BaseExceptionFilter } from '@nestjs/core';
import { throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { capture } from './capture.js';
import { getClient, init } from './index.js';
import type { InitOptions } from './index.js';

interface HttpRequestLike {
  method?: string;
  baseUrl?: string;
  path?: string;
  url?: string;
  route?: { path?: unknown };
  routeOptions?: { url?: unknown };
}

interface WsClientLike {
  emit?: (event: string, payload: unknown) => unknown;
}

interface WsHostLike {
  getClient<T>(): T;
  getData<T>(): T;
  getPattern?(): string;
}

/** Same text as Nest's `MESSAGES.UNKNOWN_EXCEPTION_MESSAGE`, which `@nestjs/core` does not export from its root. */
const UNKNOWN_EXCEPTION_MESSAGE = 'Internal server error';

function routeOf(request: HttpRequestLike): string | undefined {
  const pattern = request.route?.path;

  if (typeof pattern === 'string') {
    return `${request.baseUrl ?? ''}${pattern}`;
  }

  const fastifyPattern = request.routeOptions?.url;

  if (typeof fastifyPattern === 'string') {
    return fastifyPattern;
  }

  if (typeof request.path === 'string') {
    return `${request.baseUrl ?? ''}${request.path}`;
  }

  return typeof request.url === 'string' ? request.url.split('?')[0] : undefined;
}

function contextOf(host: ArgumentsHost): Record<string, unknown> | undefined {
  if (host.getType() !== 'http') {
    return undefined;
  }

  const request = host.switchToHttp().getRequest<HttpRequestLike | undefined>();

  return request ? { method: request.method, route: routeOf(request) } : undefined;
}

/**
 * Matches `RpcException`/`WsException` (and subclasses) by class name, so `@nestjs/microservices` and
 * `@nestjs/websockets` stay optional. Does not call `getError()`.
 */
function isNamed(exception: unknown, className: string): boolean {
  if (typeof exception !== 'object' || exception === null || typeof (exception as { getError?: unknown }).getError !== 'function') {
    return false;
  }

  for (let proto = Object.getPrototypeOf(exception); proto; proto = Object.getPrototypeOf(proto)) {
    if ((proto as { constructor?: { name?: string } }).constructor?.name === className) {
      return true;
    }
  }

  return false;
}

function errorOf(exception: unknown, className: string): { value: unknown } | undefined {
  if (!isNamed(exception, className)) {
    return undefined;
  }

  try {
    return { value: (exception as { getError: () => unknown }).getError() };
  } catch {
    return undefined;
  }
}

function isExpected(exception: unknown): boolean {
  return (
    (exception instanceof HttpException && exception.getStatus() < 500) ||
    isNamed(exception, 'RpcException') ||
    isNamed(exception, 'WsException')
  );
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function logUnknown(exception: unknown, context: string): void {
  const intrinsic = (nestCommon as { IntrinsicException?: abstract new (...args: never[]) => unknown }).IntrinsicException;

  if (!(intrinsic && exception instanceof intrinsic)) {
    new Logger(context).error(exception);
  }
}

/** What Nest's `BaseRpcExceptionFilter` returns (verified against @nestjs/microservices 11.2.7). */
function replyRpc(exception: unknown): Observable<never> {
  const rpcError = errorOf(exception, 'RpcException');

  if (!rpcError) {
    logUnknown(exception, 'RpcExceptionsHandler');

    return throwError(() => ({ status: 'error', message: UNKNOWN_EXCEPTION_MESSAGE }));
  }

  const message = isObject(rpcError.value) ? rpcError.value : { status: 'error', message: rpcError.value };

  return throwError(() => message);
}

/** What Nest's default `WsExceptionsHandler` emits (verified against @nestjs/websockets 11.2.7, default options). */
function replyWs(exception: unknown, host: ArgumentsHost): void {
  const ws = host.switchToWs() as unknown as WsHostLike;
  const client = ws.getClient<WsClientLike | undefined>();

  if (!client || typeof client.emit !== 'function') {
    return;
  }

  const cause = { pattern: ws.getPattern?.(), data: ws.getData<unknown>() };
  const wsError = errorOf(exception, 'WsException');

  if (wsError && isObject(wsError.value)) {
    client.emit('exception', wsError.value);

    return;
  }

  client.emit('exception', { status: 'error', message: wsError ? wsError.value : UNKNOWN_EXCEPTION_MESSAGE, cause });

  if (!wsError) {
    logUnknown(exception, 'WsExceptionsHandler');
  }
}

/**
 * Global NestJS exception filter: captures the exception and then answers as Nest would without it. In HTTP it
 * delegates to `BaseExceptionFilter`; in rpc and ws it reproduces Nest's default handlers. `HttpException`s with a
 * status below 500, `RpcException`s and `WsException`s are expected errors and are not captured. In HTTP the
 * context carries only `method` and `route` (the route pattern such as `/users/:id` when known, otherwise the
 * path); never the query string, headers or body. Other rpc and ws errors are captured without context.
 *
 * `BaseExceptionFilter` needs the HTTP adapter. Recommended: `SerenoModule.forRoot()` in the root module, which
 * registers it with `APP_FILTER` and Nest injects the adapter. With `useGlobalFilters` pass it explicitly:
 * `app.useGlobalFilters(new SerenoExceptionFilter(app.get(HttpAdapterHost).httpAdapter))`.
 */
export class SerenoExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): Observable<never> | void {
    try {
      const client = getClient();

      if (client && !isExpected(exception)) {
        capture(client, exception, contextOf(host));
      }
    } catch {
      // capturing must never change the response
    }

    const type = host.getType<string>();

    if (type === 'rpc') {
      return replyRpc(exception);
    }

    if (type === 'ws') {
      return replyWs(exception, host);
    }

    super.catch(exception, host);
  }
}

Catch()(SerenoExceptionFilter);

/**
 * `SerenoModule.forRoot()` registers `SerenoExceptionFilter` as a global filter (`APP_FILTER`). With options it also
 * calls `init(options)` unless the SDK is already initialized; without them it expects `init()` to have run already,
 * ideally in `main.ts` before `NestFactory.create` so bootstrap errors are captured too.
 */
export class SerenoModule {
  static forRoot(options?: InitOptions): DynamicModule {
    if (options && !getClient()) {
      init(options);
    }

    return {
      module: SerenoModule,
      providers: [{ provide: APP_FILTER, useClass: SerenoExceptionFilter }],
    };
  }
}

Module({})(SerenoModule);
