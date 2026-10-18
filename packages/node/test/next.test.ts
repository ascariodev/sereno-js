import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Instrumentation } from 'next/dist/server/instrumentation/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerenoEvent } from '@ascariodev/sereno-core';
import { close, getClient, init } from '../src/index.js';
import { createOnRequestError, onRequestError, register } from '../src/next.js';

const nextOnRequestError: Instrumentation.onRequestError = onRequestError;

let sink: Server;
let sinkUrl: string;
let events: SerenoEvent[];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const routeRequest = {
  path: '/api/users/42?token=secret',
  method: 'POST',
  headers: { authorization: 'Bearer secret', cookie: 'session=secret' },
};

const routeContext = {
  routerKind: 'App Router',
  routePath: '/api/users/[id]',
  routeType: 'route',
  revalidateReason: undefined,
} as const;

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
  sinkUrl = await listen(sink);
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  init({ url: sinkUrl, key: 'wsk_test', handlers: false });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  sink.closeAllConnections();
  await new Promise((resolve) => sink.close(resolve));
});

describe('onRequestError', () => {
  it('captures and sends the error before resolving, with the route pattern and without path, query or headers', async () => {
    await nextOnRequestError(new Error('route boom'), routeRequest, routeContext);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'error',
      message: 'route boom',
      context: { method: 'POST', route: '/api/users/[id]', routeType: 'route', routerKind: 'App Router' },
    });
    expect(events[0]?.context).not.toHaveProperty('renderSource');
    expect(JSON.stringify(events[0])).not.toContain('secret');
    expect(JSON.stringify(events[0])).not.toContain('/api/users/42');
  });

  it('keeps the render source of a render error', async () => {
    await onRequestError(new Error('render boom'), { path: '/dashboard', method: 'GET', headers: {} }, {
      routerKind: 'App Router',
      routePath: '/dashboard',
      routeType: 'render',
      renderSource: 'react-server-components',
      revalidateReason: undefined,
    });

    expect(events[0]?.context).toMatchObject({ route: '/dashboard', routeType: 'render', renderSource: 'react-server-components' });
  });

  it('ignores the control flow errors of Next: redirect, notFound, forbidden and rendering bailouts', async () => {
    const digests = ['NEXT_REDIRECT;replace;/login;307;', 'NEXT_HTTP_ERROR_FALLBACK;404', 'NEXT_HTTP_ERROR_FALLBACK;403', 'NEXT_NOT_FOUND', 'BAILOUT_TO_CLIENT_SIDE_RENDERING', 'DYNAMIC_SERVER_USAGE'];

    for (const digest of digests) {
      await onRequestError(Object.assign(new Error(digest), { digest }), routeRequest, routeContext);
    }

    await onRequestError(Object.assign(new Error('hashed render error'), { digest: '2412345678' }), routeRequest, routeContext);

    expect(events.map((event) => event.message)).toEqual(['hashed render error']);
  });

  it('ignores errors with a status below 500 unless minStatus says otherwise', async () => {
    await onRequestError(Object.assign(new Error('bad input'), { statusCode: 400 }), routeRequest, routeContext);
    await onRequestError(Object.assign(new Error('upstream'), { status: 502 }), routeRequest, routeContext);
    await createOnRequestError({ minStatus: 400 })(Object.assign(new Error('conflict'), { status: 409 }), routeRequest, routeContext);

    expect(events.map((event) => event.message)).toEqual(['upstream', 'conflict']);
  });

  it('sends a thrown value that is not an Error as its string', async () => {
    await onRequestError('plain failure', routeRequest, routeContext);

    expect(events[0]).toMatchObject({ message: 'plain failure', context: { route: '/api/users/[id]' } });
  });

  it('does nothing before init and never rejects when the API is down', async () => {
    await close();
    await expect(onRequestError(new Error('ignored'), routeRequest, routeContext)).resolves.toBeUndefined();

    init({ url: 'http://127.0.0.1:1', key: 'wsk_test', handlers: false, timeout: 1 });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(onRequestError(new Error('lost'), routeRequest, routeContext)).resolves.toBeUndefined();
    warn.mockRestore();

    expect(events).toHaveLength(0);
  });

  it('tolerates missing request and context objects', async () => {
    await expect(onRequestError(new Error('bare'), undefined as never, undefined as never)).resolves.toBeUndefined();

    expect(events[0]).toMatchObject({ message: 'bare' });
  });
});

describe('register', () => {
  it('initializes from the environment only in the nodejs runtime', async () => {
    await close();
    vi.stubEnv('SERENO_URL', sinkUrl);
    vi.stubEnv('SERENO_KEY', 'wsk_test');

    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register({ handlers: false });
    expect(getClient()).toBeUndefined();

    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await register({ handlers: false });
    expect(getClient()?.configured).toBe(true);
  });

  it('keeps a client created earlier', async () => {
    const existing = getClient();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    await register({ url: 'http://127.0.0.1:1', key: 'wsk_other', handlers: false });

    expect(getClient()).toBe(existing);
  });
});

describe('Pages Router', () => {
  it('captures an error thrown by an API route with its route pattern and without path, query or headers', async () => {
    await nextOnRequestError(
      new Error('api route boom'),
      { path: '/api/users/42?token=secret', method: 'PUT', headers: { cookie: 'session=secret' } },
      { routerKind: 'Pages Router', routePath: '/api/users/[id]', routeType: 'route', revalidateReason: undefined },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      message: 'api route boom',
      context: { method: 'PUT', route: '/api/users/[id]', routeType: 'route', routerKind: 'Pages Router' },
    });
    expect(events[0]?.context).not.toHaveProperty('renderSource');
    expect(JSON.stringify(events[0])).not.toContain('secret');
    expect(JSON.stringify(events[0])).not.toContain('/api/users/42');
  });

  it('captures an error thrown by getServerSideProps as a render error', async () => {
    await nextOnRequestError(
      new Error('gssp boom'),
      { path: '/posts/7?draft=1', method: 'GET', headers: {} },
      { routerKind: 'Pages Router', routePath: '/posts/[id]', routeType: 'render', revalidateReason: undefined },
    );

    expect(events[0]).toMatchObject({
      message: 'gssp boom',
      context: { method: 'GET', route: '/posts/[id]', routeType: 'render', routerKind: 'Pages Router' },
    });
    expect(JSON.stringify(events[0])).not.toContain('draft');
  });

  it('applies the same status filter to errors of the Pages Router', async () => {
    const context = { routerKind: 'Pages Router', routePath: '/api/items', routeType: 'route', revalidateReason: undefined } as const;

    await nextOnRequestError(Object.assign(new Error('not allowed'), { statusCode: 405 }), { path: '/api/items', method: 'POST', headers: {} }, context);
    await nextOnRequestError(Object.assign(new Error('broken'), { statusCode: 500 }), { path: '/api/items', method: 'POST', headers: {} }, context);

    expect(events.map((event) => event.message)).toEqual(['broken']);
  });
});

describe('development server', () => {
  it('captures errors with NODE_ENV=development', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    await nextOnRequestError(new Error('dev boom'), routeRequest, routeContext);
    await nextOnRequestError(
      new Error('dev pages boom'),
      { path: '/api/dev', method: 'GET', headers: {} },
      { routerKind: 'Pages Router', routePath: '/api/dev', routeType: 'route', revalidateReason: undefined },
    );

    expect(events.map((event) => event.message)).toEqual(['dev boom', 'dev pages boom']);
  });

  it('registers the SDK with NODE_ENV=development', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    await close();
    vi.stubEnv('SERENO_URL', sinkUrl);
    vi.stubEnv('SERENO_KEY', 'wsk_test');
    await register({ handlers: false });
    expect(getClient()?.configured).toBe(true);
  });

  it('ignores the control flow errors of Next in development too', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    await nextOnRequestError(Object.assign(new Error('redirect'), { digest: 'NEXT_REDIRECT;push;/login;307;' }), routeRequest, routeContext);

    expect(events).toHaveLength(0);
  });
});

function distUrl(file: string): string {
  return pathToFileURL(fileURLToPath(new URL(`../dist/${file}`, import.meta.url))).href;
}

function runModule(source: string, env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

describe('edge runtime', () => {
  it('does nothing and never loads the Node modules of the SDK', () => {
    const output = runModule(
      `
import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
const { register, onRequestError } = await import(${JSON.stringify(distUrl('esm/next.js'))});
await register({ url: 'http://127.0.0.1:1', key: 'wsk_test' });
await onRequestError(new Error('edge boom'), { path: '/', method: 'GET', headers: {} }, { routerKind: 'App Router', routePath: '/', routeType: 'route' });
console.log(JSON.stringify(loaded));
`,
      { NEXT_RUNTIME: 'edge' },
    );

    const loaded = JSON.parse(output) as string[];

    expect(loaded.some((url) => url.endsWith('/next.js'))).toBe(true);
    expect(loaded.filter((url) => !url.endsWith('/next.js'))).toEqual([]);
  });
});

describe('dual package', () => {
  it('shares the active client between the ESM and CommonJS builds', () => {
    const output = runModule(`
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const esm = await import(${JSON.stringify(distUrl('esm/index.js'))});
const cjs = createRequire(import.meta.url)(fileURLToPath(${JSON.stringify(distUrl('cjs/index.js'))}));
const client = esm.init({ url: 'http://127.0.0.1:1', key: 'wsk_test', handlers: false });
const shared = cjs.getClient() === client;
await cjs.close();
console.log(JSON.stringify({ esm: esm !== cjs, shared, closed: esm.getClient() === undefined }));
`);

    expect(JSON.parse(output)).toEqual({ esm: true, shared: true, closed: true });
  });
});
