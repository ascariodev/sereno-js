import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, testConnection } from '../src/connection.js';

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

let server: Server | undefined;
let requests: { headers: IncomingMessage['headers']; url: string | undefined; body: string }[] = [];

async function serve(handler: Handler): Promise<string> {
  requests = [];
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({ headers: request.headers, url: request.url, body });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const status = (code: number, headers: Record<string, string> = {}): Handler => (_request, response) => {
  response.writeHead(code, headers);
  response.end('{}');
};

describe('testConnection', () => {
  it('reports connected on 202 and sends the info test event', async () => {
    const url = await serve(status(202));

    expect(await testConnection(`${url}/`, 'wsk_key')).toEqual({ status: 'connected', detail: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('/api/ingest/events');
    expect(requests[0]!.headers.authorization).toBe('Bearer wsk_key');

    const events = JSON.parse(requests[0]!.body).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'info', message: 'Sereno connection test' });
  });

  it('reports unauthorized on 401', async () => {
    const url = await serve(status(401));

    expect(await testConnection(url, 'wsk_bad')).toEqual({ status: 'unauthorized', detail: null });
  });

  it('does not send anything without url or key', async () => {
    const url = await serve(status(202));

    expect(await testConnection('  ', 'wsk_key')).toEqual({ status: 'no_url', detail: null });
    expect(await testConnection(url, undefined)).toEqual({ status: 'no_key', detail: null });
    expect(requests).toHaveLength(0);
  });

  it('does not follow redirects and suggests checking the scheme', async () => {
    const url = await serve(status(301, { Location: 'https://example.invalid/' }));

    expect(await testConnection(url, 'wsk_key')).toEqual({ status: 'failed', detail: 'HTTP 301, check the URL scheme' });
    expect(requests).toHaveLength(1);
  });

  it('reports other codes as failed without retrying', async () => {
    const url = await serve(status(500));

    expect(await testConnection(url, 'wsk_key')).toEqual({ status: 'failed', detail: 'HTTP 500' });
    expect(requests).toHaveLength(1);
  });

  it('reports a network error', async () => {
    const result = await testConnection('http://127.0.0.1:1', 'wsk_key');

    expect(result.status).toBe('failed');
    expect(result.detail).toBeTruthy();
  });

  it('redacts the key and the URL userinfo from the failure detail', async () => {
    const fetch = async () => {
      throw new Error('boom Bearer wsk_secret at http://user:pass@127.0.0.1:1/x');
    };
    const result = await testConnection('http://user:pass@127.0.0.1:1', 'wsk_secret', { fetch });

    expect(result).toEqual({ status: 'failed', detail: 'boom *** at http://127.0.0.1:1/x' });
  });

  it('times out after 5 seconds with a single attempt', async () => {
    const url = await serve(() => undefined);
    const startedAt = Date.now();
    const result = await testConnection(url, 'wsk_key');

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('timed out');
    expect(Date.now() - startedAt).toBeLessThan(7000);
    expect(requests).toHaveLength(1);
  });
});

describe('runCli', () => {
  function io(env: Record<string, string> = {}) {
    const lines: string[] = [];

    return { lines, io: { env, out: (text: string) => lines.push(text), err: (text: string) => lines.push(text) } };
  }

  it('exits 0 only when connected, reading the environment', async () => {
    const url = await serve(status(202));
    const { io: streams, lines } = io({ SERENO_URL: url, SERENO_KEY: 'wsk_key' });

    expect(await runCli(['test'], streams)).toBe(0);
    expect(lines.join('')).toBe('Connected: Sereno accepted the test event.\n');
  });

  it('lets --url and --key win over the environment', async () => {
    const url = await serve(status(202));
    const { io: streams } = io({ SERENO_URL: 'http://127.0.0.1:1', SERENO_KEY: 'wsk_env' });

    expect(await runCli(['test', `--url=${url}`, '--key', 'wsk_flag'], streams)).toBe(0);
    expect(requests[0]!.headers.authorization).toBe('Bearer wsk_flag');
  });

  it('exits 1 with a message for each failure', async () => {
    const rejected = await serve(status(401));
    const first = io({ SERENO_URL: rejected, SERENO_KEY: 'wsk_bad' });

    expect(await runCli(['test'], first.io)).toBe(1);
    expect(first.lines.join('')).toContain('Unauthorized: the key was rejected.');

    const noUrl = io({ SERENO_KEY: 'wsk_key' });
    expect(await runCli(['test'], noUrl.io)).toBe(1);
    expect(noUrl.lines.join('')).toBe('Missing URL: pass --url=<url> or set SERENO_URL.\n');

    const noKey = io({ SERENO_URL: rejected });
    expect(await runCli(['test'], noKey.io)).toBe(1);
    expect(noKey.lines.join('')).toBe('Missing key: pass --key=<key> or set SERENO_KEY.\n');

    const failed = io({ SERENO_URL: 'http://127.0.0.1:1', SERENO_KEY: 'wsk_key' });
    expect(await runCli(['test'], failed.io)).toBe(1);
    expect(failed.lines.join('')).toMatch(/^Failed: could not deliver the test event \(.+\)\.\n$/);
  });

  it('prints help with 0 and usage with 1 for an unknown command', async () => {
    const help = io();
    expect(await runCli(['--help'], help.io)).toBe(0);
    expect(help.lines.join('')).toContain('Usage: sereno-node test');

    const unknown = io();
    expect(await runCli([], unknown.io)).toBe(1);
    expect(unknown.lines.join('')).toContain('Usage: sereno-node test');
  });

  describe('key never reaches the output', () => {
    const key = 'wsk_test_secret_0123456789';

    function split() {
      const out: string[] = [];
      const err: string[] = [];

      return { out, err, io: { env: {}, out: (text: string) => out.push(text), err: (text: string) => err.push(text) } };
    }

    it('does not print the --key value when the event is sent', async () => {
      const url = await serve(status(202));
      const streams = split();

      expect(await runCli(['test', `--url=${url}`, '--key', key], streams.io)).toBe(0);
      expect(requests[0]!.headers.authorization).toBe(`Bearer ${key}`);
      expect(streams.out.join('') + streams.err.join('')).not.toContain(key);
      expect(streams.out.join('')).not.toContain('wsk_test');
    });

    it('does not print the --key=value form on a rejected key', async () => {
      const url = await serve(status(401));
      const streams = split();

      expect(await runCli(['test', `--url=${url}`, `--key=${key}`], streams.io)).toBe(1);
      expect(streams.out.join('') + streams.err.join('')).not.toContain(key);
    });

    it('does not print the key when the send fails with a network error', async () => {
      const streams = split();

      expect(await runCli(['test', '--url=http://127.0.0.1:1', '--key', key], streams.io)).toBe(1);
      expect(streams.out.join('')).toContain('Failed:');
      expect(streams.out.join('') + streams.err.join('')).not.toContain(key);
    });

    it('does not print the key with --help or on usage errors', async () => {
      const help = split();
      expect(await runCli(['test', '--key', key, '--help'], help.io)).toBe(0);
      expect(help.out.join('')).toContain('Usage: sereno-node test');
      expect(help.out.join('') + help.err.join('')).not.toContain(key);

      const usage = split();
      expect(await runCli(['--key', key], usage.io)).toBe(1);
      expect(usage.out.join('') + usage.err.join('')).not.toContain(key);
    });
  });
});

describe('built binary', () => {
  const bin = fileURLToPath(new URL('../dist/esm/cli.js', import.meta.url));

  it('runs from dist with a shebang and exits with the result code', async () => {
    const url = await serve(status(401));
    const run = (target: string) =>
      new Promise<{ code: number | null; stdout: string }>((resolve) => {
        import('node:child_process').then(({ spawn }) => {
          const child = spawn(process.execPath, [bin, 'test'], { env: { ...process.env, SERENO_URL: target, SERENO_KEY: 'wsk_bad' } });
          let stdout = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.on('close', (code) => resolve({ code, stdout }));
        });
      });

    const result = await run(url);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Unauthorized');
    expect(spawnSync(process.execPath, ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(bin)}, 'utf8').split('\\n')[0])`]).stdout.toString()).toBe(
      '#!/usr/bin/env node',
    );
  });
});
