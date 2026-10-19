import { Transport, formatEvent } from '@ascariodev/sereno-core';
import type { TransportOptions } from '@ascariodev/sereno-core';
import { uploadSourceMaps, type UploadFetch } from './sourcemaps.js';

export const TEST_TIMEOUT_SECONDS = 5;

export type ConnectionStatus = 'connected' | 'unauthorized' | 'no_url' | 'no_key' | 'failed';

export interface ConnectionResult {
  status: ConnectionStatus;
  detail: string | null;
}

export async function testConnection(
  url: string | null | undefined,
  key: string | null | undefined,
  options: Pick<TransportOptions, 'fetch'> = {},
): Promise<ConnectionResult> {
  const trimmedUrl = (url ?? '').trim();
  const trimmedKey = (key ?? '').trim();

  if (trimmedUrl === '') {
    return { status: 'no_url', detail: null };
  }

  if (trimmedKey === '') {
    return { status: 'no_key', detail: null };
  }

  const transport = new Transport(trimmedUrl, trimmedKey, { ...options, timeout: TEST_TIMEOUT_SECONDS, retry: false });
  const result = await transport.send([formatEvent({ level: 'info', message: 'Sereno connection test' })]);

  if (result.status === 'error') {
    return { status: 'failed', detail: result.error };
  }

  const code = result.code;

  if (result.status === 'sent' && code === 202) {
    return { status: 'connected', detail: null };
  }

  if (code === 401) {
    return { status: 'unauthorized', detail: null };
  }

  if (code >= 300 && code < 400) {
    return { status: 'failed', detail: `HTTP ${code}, check the URL scheme` };
  }

  return { status: 'failed', detail: `HTTP ${code}` };
}

export interface CliIo {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
}

const USAGE =
  'Usage: sereno-node test [--key=<key>] [--url=<url>]\n' +
  'Sends a test event to Sereno.\n' +
  'Usage: sereno-node sourcemaps upload <dir> --release=<release> --url-prefix=<prefix> [--key=<key>] [--url=<url>]\n' +
  'Uploads the *.js.map files under <dir> with the server key. <prefix> is the URL path the JavaScript files are served from.\n' +
  'Both commands fall back to SERENO_KEY and SERENO_URL; sourcemaps upload also to SERENO_RELEASE.\n';

const VALUE_OPTIONS = ['key', 'url', 'release', 'url-prefix'];

function positionals(args: string[]): string[] {
  const found: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    if (!arg.startsWith('--')) {
      found.push(arg);
    } else if (VALUE_OPTIONS.includes(arg.slice(2)) && args[index + 1] !== undefined && !args[index + 1]!.startsWith('--')) {
      index++;
    }
  }

  return found;
}

function option(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    if (arg.startsWith(`--${name}=`)) {
      return arg.slice(name.length + 3);
    }

    if (arg === `--${name}`) {
      const next = args[index + 1];

      return next !== undefined && !next.startsWith('--') ? next : undefined;
    }
  }

  return undefined;
}

async function sourcemapsCommand(
  args: string[],
  io: CliIo,
  pick: (name: string, variable: string) => string | undefined,
  fetch: UploadFetch | undefined,
): Promise<number> {
  const [, action, dir, ...extra] = positionals(args);

  if (action !== 'upload' || dir === undefined || extra.length > 0) {
    io.err(USAGE);

    return 1;
  }

  const url = (pick('url', 'SERENO_URL') ?? '').trim();
  const key = (pick('key', 'SERENO_KEY') ?? '').trim();
  const release = pick('release', 'SERENO_RELEASE') ?? '';
  const urlPrefix = option(args, 'url-prefix') ?? '';
  const missing =
    url === ''
      ? 'Missing URL: pass --url=<url> or set SERENO_URL.'
      : key === ''
        ? 'Missing key: pass --key=<key> or set SERENO_KEY.'
        : release.trim() === ''
          ? 'Missing release: pass --release=<release> or set SERENO_RELEASE.'
          : urlPrefix.trim() === ''
            ? 'Missing URL prefix: pass --url-prefix=<prefix>, the URL path the JavaScript files are served from.'
            : undefined;

  if (missing !== undefined) {
    io.out(`${missing}\n`);

    return 1;
  }

  return uploadSourceMaps({ url, key, dir, release, urlPrefix, fetch, out: io.out });
}

export type CliOptions = Pick<TransportOptions, 'fetch'> & { uploadFetch?: UploadFetch };

export async function runCli(args: string[], io: CliIo, options: CliOptions = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.out(USAGE);

    return 0;
  }

  const pick = (name: string, variable: string): string | undefined => {
    const value = option(args, name);

    return value !== undefined && value !== '' ? value : io.env[variable];
  };

  if (args[0] === 'sourcemaps') {
    return sourcemapsCommand(args, io, pick, options.uploadFetch);
  }

  if (args[0] !== 'test') {
    io.err(USAGE);

    return 1;
  }

  const result = await testConnection(pick('url', 'SERENO_URL'), pick('key', 'SERENO_KEY'), options);
  const detail = result.detail !== null ? ` (${result.detail})` : '';

  switch (result.status) {
    case 'connected':
      io.out('Connected: Sereno accepted the test event.\n');

      return 0;
    case 'unauthorized':
      io.out('Unauthorized: the key was rejected. Check that it is correct and has not been revoked.\n');
      break;
    case 'no_url':
      io.out('Missing URL: pass --url=<url> or set SERENO_URL.\n');
      break;
    case 'no_key':
      io.out('Missing key: pass --key=<key> or set SERENO_KEY.\n');
      break;
    default:
      io.out(`Failed: could not deliver the test event${detail}.\n`);
  }

  return 1;
}
