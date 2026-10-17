import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SerenoEvent } from '@ascariodev/sereno-core';
import { rejectionMode } from '../src/process.js';
import { captureException, close, flush, getClient, init, log } from '../src/index.js';

const distEntry = pathToFileURL(fileURLToPath(new URL('../dist/esm/index.js', import.meta.url))).href;

const script = `
import { init, captureException } from ${JSON.stringify(distEntry)};

if (process.env.SCENARIO === 'app-rejection') {
  process.on('unhandledRejection', () => { console.log('app saw rejection'); });
}

if (process.env.SCENARIO === 'strict-both') {
  process.on('uncaughtException', () => { console.log('app saw uncaught'); });
  process.on('unhandledRejection', () => { console.log('app saw rejection'); });
}

if (!process.env.NO_SDK) init();

switch (process.env.SCENARIO) {
  case 'throw':
    throw new Error('boom');
  case 'throw-string':
    throw 'plain string';
  case 'throw-later':
    setTimeout(() => { throw new TypeError('later'); }, 10);
    break;
  case 'reject':
    Promise.reject(new RangeError('rejected'));
    break;
  case 'reject-string':
    Promise.reject('nope');
    break;
  case 'reject-continues':
    Promise.reject(new Error('warned'));
    setTimeout(() => console.log('still alive'), 100);
    break;
  case 'app-uncaught':
    process.on('uncaughtException', () => { console.log('app handled'); });
    setTimeout(() => { throw new Error('handled by app'); }, 10);
    break;
  case 'app-rejection':
    Promise.reject(new Error('app rejection'));
    break;
  case 'strict-both':
    Promise.reject(new Error('twice'));
    setTimeout(() => {}, 100);
    break;
  case 'before-exit':
    captureException(new Error('at exit'));
    break;
  case 'sigterm':
  case 'sigint':
    captureException(new Error('before signal'));
    setInterval(() => {}, 1000);
    console.log('ready');
    break;
  case 'sigterm-app':
    process.on('SIGTERM', () => process.exit(7));
    captureException(new Error('before signal'));
    setInterval(() => {}, 1000);
    console.log('ready');
    break;
}
`;

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsed: number;
}

let directory: string;
let scriptPath: string;
let server: Server;
let url: string;
let events: SerenoEvent[];
let respond: 'accept' | 'hang';

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'sereno-node-'));
  scriptPath = join(directory, 'scenario.mjs');
  writeFileSync(scriptPath, script);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  events = [];
  respond = 'accept';
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      if (respond === 'hang') {
        return;
      }

      events.push(...(JSON.parse(raw) as { events: SerenoEvent[] }).events);
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end('{"accepted":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function run(
  scenario: string,
  options: { sdk?: boolean; nodeArgs?: string[]; env?: Record<string, string>; onReady?: (kill: (signal: NodeJS.Signals) => void) => void } = {},
): Promise<Outcome> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), scriptPath], {
      env: {
        PATH: process.env.PATH,
        SCENARIO: scenario,
        SERENO_URL: url,
        SERENO_KEY: 'wsk_test',
        ...(options.sdk === false ? { NO_SDK: '1' } : {}),
        ...options.env,
      },
    });
    let stdout = '';
    let stderr = '';
    let signalled = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk;

      if (!signalled && stdout.includes('ready')) {
        signalled = true;
        options.onReady?.((signal) => child.kill(signal));
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, elapsed: Date.now() - startedAt }));
  });
}

async function compare(scenario: string, options: Parameters<typeof run>[1] = {}): Promise<{ withSdk: Outcome; without: Outcome }> {
  const without = await run(scenario, { ...options, sdk: false });
  expect(events).toHaveLength(0);
  const withSdk = await run(scenario, options);

  expect({ code: withSdk.code, signal: withSdk.signal }).toEqual({ code: without.code, signal: without.signal });

  return { withSdk, without };
}

describe('uncaught exceptions', () => {
  it('sends the event and exits with the same code as without the SDK', async () => {
    const { withSdk, without } = await compare('throw');

    expect(without.code).toBe(1);
    expect(withSdk.stderr).toContain('Error: boom');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'error', message: 'boom' });
    expect(events[0]?.context?.exception).toMatchObject({ class: 'Error', message: 'boom' });
    expect(events[0]?.fingerprint).toBeTruthy();
  });

  it('sends a thrown string as the message without exception context', async () => {
    const { without } = await compare('throw-string');

    expect(without.code).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'error', message: 'plain string' });
    expect(events[0]?.context).toBeUndefined();
    expect(events[0]?.fingerprint).toBeUndefined();
  });

  it('captures an exception thrown from a timer', async () => {
    await compare('throw-later');

    expect(events.map((event) => event.message)).toEqual(['later']);
  });

  it('does not exit when the application has its own uncaughtException listener', async () => {
    const { withSdk } = await compare('app-uncaught');

    expect(withSdk.code).toBe(0);
    expect(withSdk.stdout).toContain('app handled');
    expect(events.map((event) => event.message)).toEqual(['handled by app']);
  });

  it('exits once the wait is over when the server never answers', async () => {
    respond = 'hang';
    const outcome = await run('throw', { env: { SERENO_TIMEOUT: '1' } });

    expect(outcome.code).toBe(1);
    expect(outcome.elapsed).toBeLessThan(9000);
  });
});

describe('unhandled rejections', () => {
  it('sends the error and exits with 1 in the default mode', async () => {
    const { without } = await compare('reject');

    expect(without.code).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'error', message: 'rejected' });
    expect(events[0]?.context?.exception).toMatchObject({ class: 'RangeError' });
  });

  it('sends a rejected string as the message', async () => {
    const { without } = await compare('reject-string');

    expect(without.code).toBe(1);
    expect(events.map((event) => event.message)).toEqual(['nope']);
    expect(events[0]?.context).toBeUndefined();
  });

  it('exits with 1 in strict mode', async () => {
    const { without } = await compare('reject', { nodeArgs: ['--unhandled-rejections=strict'] });

    expect(without.code).toBe(1);
    expect(events.map((event) => event.message)).toEqual(['rejected']);
  });

  it.each(['warn', 'none'])('keeps running in %s mode and still captures it', async (mode) => {
    const { withSdk } = await compare('reject-continues', { nodeArgs: [`--unhandled-rejections=${mode}`] });

    expect(withSdk.code).toBe(0);
    expect(withSdk.stdout).toContain('still alive');
    expect(events.map((event) => event.message)).toEqual(['warned']);
  });

  it('keeps the exit code 1 of warn-with-error-code', async () => {
    const { without } = await compare('reject-continues', { nodeArgs: ['--unhandled-rejections=warn-with-error-code'] });

    expect(without.code).toBe(1);
    expect(events.map((event) => event.message)).toEqual(['warned']);
  });

  it('captures once in strict mode when the application listens to both uncaughtException and unhandledRejection', async () => {
    const { withSdk } = await compare('strict-both', { nodeArgs: ['--unhandled-rejections=strict'] });

    expect(withSdk.code).toBe(0);
    expect(events.map((event) => event.message)).toEqual(['twice']);
  });

  it('captures a rejection the application handles with a hook registered before init', async () => {
    const { withSdk } = await compare('app-rejection');

    expect(withSdk.code).toBe(0);
    expect(withSdk.stdout).toContain('app saw rejection');
    expect(events.map((event) => event.message)).toEqual(['app rejection']);
  });
});

describe('exit and signals', () => {
  it('flushes on beforeExit and exits 0', async () => {
    const { withSdk } = await compare('before-exit');

    expect(withSdk.code).toBe(0);
    expect(events.map((event) => event.message)).toEqual(['at exit']);
  });

  it.skipIf(process.platform === 'win32').each([
    ['sigterm', 'SIGTERM'],
    ['sigint', 'SIGINT'],
  ] as const)('flushes on %s and ends by the signal like the default', async (scenario, signal) => {
    const { withSdk } = await compare(scenario, { onReady: (kill) => kill(signal) });

    expect(withSdk.signal).toBe(signal);
    expect(events.map((event) => event.message)).toEqual(['before signal']);
  });

  it.skipIf(process.platform === 'win32')('leaves the exit to the application when it listens to the signal', async () => {
    const { withSdk } = await compare('sigterm-app', { onReady: (kill) => kill('SIGTERM') });

    expect(withSdk.code).toBe(7);
    expect(withSdk.signal).toBeNull();
  });
});

describe('rejectionMode', () => {
  it('reads the flag from the arguments and NODE_OPTIONS, the arguments winning', () => {
    expect(rejectionMode([], '')).toBe('throw');
    expect(rejectionMode(['--unhandled-rejections=warn'], '')).toBe('warn');
    expect(rejectionMode(['--unhandled-rejections', 'none'], '')).toBe('none');
    expect(rejectionMode([], '--max-old-space-size=100 --unhandled-rejections=strict')).toBe('strict');
    expect(rejectionMode(['--unhandled-rejections=warn'], '--unhandled-rejections=strict')).toBe('warn');
    expect(rejectionMode(['--unhandled-rejections=bogus'], '')).toBe('throw');
  });
});

describe('init', () => {
  const names = ['SERENO_URL', 'SERENO_KEY', 'SERENO_TIMEOUT', 'SERENO_LEVEL'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    names.forEach((name) => delete process.env[name]);
  });

  afterEach(async () => {
    await close();
    names.forEach((name) => (saved[name] === undefined ? delete process.env[name] : (process.env[name] = saved[name])));
  });

  it('is inert without url or key and installs no process listeners', async () => {
    const before = process.listenerCount('uncaughtException');
    const client = init({ url, handlers: true });

    expect(client.configured).toBe(false);
    expect(process.listenerCount('uncaughtException')).toBe(before);

    captureException(new Error('ignored'));
    log('error', 'ignored');
    await flush();

    expect(events).toHaveLength(0);
  });

  it('reads the environment and lets the options win', async () => {
    process.env.SERENO_URL = url;
    process.env.SERENO_KEY = 'wsk_env';
    process.env.SERENO_LEVEL = 'error';

    const fromEnv = init({ handlers: false });

    expect(fromEnv.configured).toBe(true);
    expect(fromEnv.level).toBe('error');

    const overridden = init({ handlers: false, level: 'warning' });

    expect(overridden.level).toBe('warning');
    expect(getClient()).toBe(overridden);

    log('info', 'below level');
    log('warning', 'kept', { a: 1 });
    await flush();

    expect(events.map((event) => event.message)).toEqual(['kept']);
  });

  it('replaces the previous setup cleanly', async () => {
    const before = process.listenerCount('uncaughtException');

    init({ url, key: 'wsk_a' });
    init({ url, key: 'wsk_b' });

    expect(process.listenerCount('uncaughtException')).toBe(before + 1);

    await close();

    expect(process.listenerCount('uncaughtException')).toBe(before);
    expect(getClient()).toBeUndefined();
  });

  it('captureException keeps the exception context and a user context', async () => {
    init({ url, key: 'wsk_a', handlers: false });
    captureException(new Error('manual'), { user: 7 });
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.context).toMatchObject({ user: 7, exception: { class: 'Error', message: 'manual' } });
  });
});
