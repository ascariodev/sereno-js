import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/connection.js';
import { fileUrlFor, type UploadFetch } from '../src/sourcemaps.js';

interface Upload {
  authorization: string | undefined;
  url: string | undefined;
  release: string | File | null;
  fileUrl: string | File | null;
  map: string;
  mapName: string;
}

let server: Server | undefined;
let uploads: Upload[] = [];
let dir: string;

type Reply = (fileUrl: string) => { status: number; body?: unknown };

async function closeServer(): Promise<void> {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
}

async function serve(reply: Reply): Promise<string> {
  uploads = [];
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers['content-type'] ?? '' } }).formData();
      const map = form.get('map') as File;
      uploads.push({
        authorization: request.headers.authorization,
        url: request.url,
        release: form.get('release'),
        fileUrl: form.get('file_url'),
        map: await map.text(),
        mapName: map.name,
      });
      const { status, body } = reply(String(form.get('file_url')));
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const map = (name: string) => JSON.stringify({ version: 3, file: name, sources: ['../src/main.ts'], names: [], mappings: 'AAAA' });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sereno-sourcemaps-'));
  await mkdir(join(dir, 'assets', 'chunks'), { recursive: true });
  await writeFile(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  await writeFile(join(dir, 'assets', 'index-abc.js.map'), map('index-abc.js'));
  await writeFile(join(dir, 'assets', 'chunks', 'vendor.mjs.map'), map('vendor.mjs'));
  await writeFile(join(dir, 'assets', 'style.css.map'), map('style.css'));
});

afterEach(async () => {
  await closeServer();
  await rm(dir, { recursive: true, force: true });
});

function io(env: Record<string, string> = {}) {
  const lines: string[] = [];

  return { lines, io: { env, out: (text: string) => lines.push(text), err: (text: string) => lines.push(text) } };
}

describe('sourcemaps upload', () => {
  it('uploads every JavaScript map to a real server with the release and the file_url of its JS', async () => {
    const url = await serve((fileUrl) => ({ status: fileUrl.endsWith('vendor.mjs') ? 200 : 201 }));
    const { io: streams, lines } = io({ SERENO_URL: `${url}/`, SERENO_KEY: 'wsk_key' });

    expect(await runCli(['sourcemaps', 'upload', dir, '--release', 'v1.2.3', '--url-prefix=/'], streams)).toBe(0);
    expect(uploads.map(({ url: path, authorization, release, fileUrl, mapName }) => ({ path, authorization, release, fileUrl, mapName }))).toEqual([
      { path: '/api/ingest/sourcemaps', authorization: 'Bearer wsk_key', release: 'v1.2.3', fileUrl: '/assets/chunks/vendor.mjs', mapName: 'vendor.mjs.map' },
      { path: '/api/ingest/sourcemaps', authorization: 'Bearer wsk_key', release: 'v1.2.3', fileUrl: '/assets/index-abc.js', mapName: 'index-abc.js.map' },
    ]);
    expect(uploads[1]!.map).toBe(map('index-abc.js'));
    expect(lines.join('')).toBe(
      'Replaced: assets/chunks/vendor.mjs.map -> /assets/chunks/vendor.mjs\n' +
        'Uploaded: assets/index-abc.js.map -> /assets/index-abc.js\n' +
        '2 of 2 source maps uploaded for release v1.2.3.\n',
    );
  });

  it('goes on after a failed map and exits 1, with the server message', async () => {
    const url = await serve((fileUrl) =>
      fileUrl.endsWith('vendor.mjs') ? { status: 422, body: { message: 'The map must be a version 3 source map without sections.' } } : { status: 201 },
    );
    const { io: streams, lines } = io();
    const args = ['sourcemaps', 'upload', dir, `--url=${url}`, '--key=wsk_key', '--release=r1', '--url-prefix', 'https://cdn.example.com/static/'];

    expect(await runCli(args, streams)).toBe(1);
    expect(uploads.map((upload) => upload.fileUrl)).toEqual(['/static/assets/chunks/vendor.mjs', '/static/assets/index-abc.js']);
    expect(lines.join('')).toBe(
      'Failed: assets/chunks/vendor.mjs.map -> /static/assets/chunks/vendor.mjs (HTTP 422: The map must be a version 3 source map without sections.).\n' +
        'Uploaded: assets/index-abc.js.map -> /static/assets/index-abc.js\n' +
        '1 of 2 source maps uploaded for release r1.\n',
    );
  });

  it('stops at the first 401 or 403', async () => {
    const rejected = await serve(() => ({ status: 401 }));
    const first = io({ SERENO_URL: rejected, SERENO_KEY: 'wsk_bad' });

    expect(await runCli(['sourcemaps', 'upload', dir, '--release=r1', '--url-prefix=/'], first.io)).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(first.lines.join('')).toBe('Unauthorized: the key was rejected. Check that it is correct and has not been revoked.\n');

    await closeServer();
    const forbidden = await serve(() => ({ status: 403, body: { message: 'Browser keys cannot upload source maps. Use the server key of the source.' } }));
    const second = io({ SERENO_URL: forbidden, SERENO_KEY: 'wsp_key' });

    expect(await runCli(['sourcemaps', 'upload', dir, '--release=r1', '--url-prefix=/'], second.io)).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(second.lines.join('')).toBe('Forbidden: Browser keys cannot upload source maps. Use the server key of the source.\n');
  });

  it('sends nothing on missing options, an invalid release or no maps', async () => {
    const url = await serve(() => ({ status: 201 }));
    const run = async (args: string[], env: Record<string, string> = { SERENO_URL: url, SERENO_KEY: 'wsk_key' }) => {
      const result = io(env);

      return [await runCli(args, result.io), result.lines.join('')];
    };

    expect(await run(['sourcemaps', 'upload', dir, '--url-prefix=/'])).toEqual([1, 'Missing release: pass --release=<release>.\n']);
    expect(await run(['sourcemaps', 'upload', dir, '--release=r1'])).toEqual([
      1,
      'Missing URL prefix: pass --url-prefix=<prefix>, the URL path the JavaScript files are served from.\n',
    ]);
    expect(await run(['sourcemaps', 'upload', dir, '--release=r1', '--url-prefix=/'], { SERENO_KEY: 'wsk_key' })).toEqual([
      1,
      'Missing URL: pass --url=<url> or set SERENO_URL.\n',
    ]);
    expect(await run(['sourcemaps', 'upload', dir, '--release=r1', '--url-prefix=/'], { SERENO_URL: url })).toEqual([
      1,
      'Missing key: pass --key=<key> or set SERENO_KEY.\n',
    ]);
    expect(await run(['sourcemaps', 'upload', dir, '--release=a​b', '--url-prefix=/'])).toEqual([
      1,
      'Invalid release: it must have 1 to 200 characters and no control characters.\n',
    ]);

    const [code, output] = await run(['sourcemaps', 'upload', join(dir, 'missing'), '--release=r1', '--url-prefix=/']);
    expect(code).toBe(1);
    expect(output).toMatch(/^Failed: could not read /);

    await rm(join(dir, 'assets'), { recursive: true });
    expect(await run(['sourcemaps', 'upload', dir, '--release=r1', '--url-prefix=/'])).toEqual([1, `No source maps: no *.js.map files under ${dir}.\n`]);

    expect((await run(['sourcemaps', 'upload', '--release=r1', '--url-prefix=/']))[1]).toContain('Usage: sereno-node sourcemaps upload');
    expect((await run(['sourcemaps', 'push', dir, '--release=r1', '--url-prefix=/']))[1]).toContain('Usage: sereno-node sourcemaps upload');
    expect(uploads).toHaveLength(0);
  });

  it('uploads a file with a space and an accent under an encoded file_url', async () => {
    const url = await serve(() => ({ status: 201 }));
    const { io: streams, lines } = io({ SERENO_URL: url, SERENO_KEY: 'wsk_key' });
    await mkdir(join(dir, 'público'));
    await writeFile(join(dir, 'público', 'mi app é.js.map'), map('mi app é.js'));

    expect(await runCli(['sourcemaps', 'upload', join(dir, 'público'), '--release=r1', '--url-prefix=/estático b/'], streams)).toBe(0);
    expect(uploads.map((upload) => upload.fileUrl)).toEqual(['/est%C3%A1tico%20b/mi%20app%20%C3%A9.js']);
    expect(lines.join('')).toContain('Uploaded: mi app é.js.map -> /est%C3%A1tico%20b/mi%20app%20%C3%A9.js\n');
  });

  describe('key never reaches the output', () => {
    const key = 'wsk_test_secret_0123456789';

    it('redacts the key from a fetch error that contains it', async () => {
      const uploadFetch: UploadFetch = async () => {
        throw new Error(`boom Bearer ${key} and ${key} at http://user:pass@127.0.0.1:1/x`);
      };
      const { io: streams, lines } = io({ SERENO_URL: 'http://127.0.0.1:1', SERENO_KEY: key });
      const args = ['sourcemaps', 'upload', join(dir, 'assets', 'chunks'), '--release=r1', '--url-prefix=/assets/chunks'];

      expect(await runCli(args, streams, { uploadFetch })).toBe(1);
      expect(lines.join('')).toBe(
        'Failed: vendor.mjs.map -> /assets/chunks/vendor.mjs (boom *** and *** at http://127.0.0.1:1/x).\n' +
          '0 of 1 source maps uploaded for release r1.\n',
      );
    });

    it('redacts the key from a server message that echoes it', async () => {
      const url = await serve(() => ({ status: 422, body: { message: `bad key ${key}` } }));
      const { io: streams, lines } = io();
      const args = ['sourcemaps', 'upload', join(dir, 'assets', 'chunks'), `--url=${url}`, '--key', key, '--release=r1', '--url-prefix=/'];

      expect(await runCli(args, streams)).toBe(1);
      expect(uploads[0]!.authorization).toBe(`Bearer ${key}`);
      expect(lines.join('')).toBe('Failed: vendor.mjs.map -> /vendor.mjs (HTTP 422: bad key ***).\n0 of 1 source maps uploaded for release r1.\n');
    });
  });
});

describe('fileUrlFor', () => {
  it('joins the prefix path and the JS path into a single-slash path', () => {
    expect(fileUrlFor('/', 'assets/a.js.map')).toBe('/assets/a.js');
    expect(fileUrlFor('assets', 'a.js.map')).toBe('/assets/a.js');
    expect(fileUrlFor('/static//', 'nested\\a.mjs.map')).toBe('/static/nested/a.mjs');
    expect(fileUrlFor('https://cdn.example.com/app/', 'a.js.map')).toBe('/app/a.js');
    expect(fileUrlFor('https://cdn.example.com', 'a.js.map')).toBe('/a.js');
  });

  it('percent-encodes the path as the browser does in a stack trace', () => {
    expect(fileUrlFor('/', 'assets/mi app é.js.map')).toBe('/assets/mi%20app%20%C3%A9.js');
    expect(fileUrlFor('/estático b/', 'a.js.map')).toBe('/est%C3%A1tico%20b/a.js');
    expect(fileUrlFor('https://cdn.example.com/estático b/', 'a.js.map')).toBe('/est%C3%A1tico%20b/a.js');
    expect(fileUrlFor('/est%C3%A1tico/', 'a.js.map')).toBe('/est%C3%A1tico/a.js');
    expect(fileUrlFor('/', 'a[1].js.map')).toBe('/a[1].js');
    expect(fileUrlFor('/', '100%?#.js.map')).toBe('/100%25%3F%23.js');
  });

  it('rejects what the server would reject', () => {
    expect(fileUrlFor('/a?x=1', 'a.js.map')).toBeUndefined();
    expect(fileUrlFor('/a#x', 'a.js.map')).toBeUndefined();
    expect(fileUrlFor('/', `${'a'.repeat(500)}.js.map`)).toBeUndefined();
  });
});
