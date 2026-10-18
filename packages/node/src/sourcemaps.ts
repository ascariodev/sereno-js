import { readFile, readdir } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { normalizeRelease, redact } from '@ascariodev/sereno-core';

export const SOURCEMAPS_PATH = '/api/ingest/sourcemaps';

export const UPLOAD_TIMEOUT_SECONDS = 120;

export const MAX_FILE_URL_LENGTH = 500;

const MAP_SUFFIX = /\.(?:m|c)?js\.map$/;

/** Same rule as the server: a path without origin, query, fragment, whitespace or control characters. */
const VALID_FILE_URL = /^\/(?!\/)[^\s?#\p{C}]+$/u;

const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:\/\//i;

export interface UploadInit {
  method: 'POST';
  headers: Record<string, string>;
  body: FormData;
  redirect: 'manual';
  signal: AbortSignal;
}

export type UploadFetch = (url: string, init: UploadInit) => Promise<{ status: number; text(): Promise<string> }>;

export interface UploadOptions {
  url: string;
  key: string;
  dir: string;
  release: string;
  urlPrefix: string;
  fetch?: UploadFetch;
  out(text: string): void;
}

/** Relative paths (with `/`) of the JavaScript source maps under `dir`, sorted. CSS maps are skipped. */
export async function findSourceMaps(dir: string, relative = ''): Promise<string[]> {
  const entries = await readdir(join(dir, relative), { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;

    if (entry.isDirectory()) {
      found.push(...(await findSourceMaps(dir, path)));
    } else if (entry.isFile() && MAP_SUFFIX.test(entry.name)) {
      found.push(path);
    }
  }

  return found.sort();
}

/**
 * The URL path the browser loads the JavaScript from: the prefix (a path or a full URL, of which only the path counts,
 * as the server matches traces by path) followed by the map path without `.map`. Undefined if the server would reject it.
 * Percent-encoded as the browser serializes the script URL in a stack trace (`é` is `%C3%A9`, a space `%20`), since the
 * server compares the trace path as it comes. The file names are literal, so their `%`, `?` and `#` are encoded too.
 */
export function fileUrlFor(urlPrefix: string, mapPath: string): string | undefined {
  let prefix = urlPrefix.trim();

  if (ABSOLUTE_URL.test(prefix)) {
    try {
      prefix = new URL(prefix).pathname;
    } catch {
      return undefined;
    }
  } else if (/[?#]/.test(prefix)) {
    return undefined;
  }

  const file = mapPath
    .replace(/\\/g, '/')
    .replace(/\.map$/, '')
    .replace(/[%?#]/g, (char) => encodeURIComponent(char));
  let fileUrl: string;

  try {
    fileUrl = new URL(posix.normalize(`/${prefix}/${file}`), 'http://localhost').pathname.replace(/\/{2,}/g, '/');
  } catch {
    return undefined;
  }

  return VALID_FILE_URL.test(fileUrl) && Array.from(fileUrl).length <= MAX_FILE_URL_LENGTH ? fileUrl : undefined;
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown error';
  }
}

function serverMessage(body: string): string {
  try {
    const message = (JSON.parse(body) as { message?: unknown }).message;

    return typeof message === 'string' && message !== '' ? `: ${message}` : '';
  } catch {
    return '';
  }
}

/** Uploads every map, going on after a failed one; exit code 1 if any failed. Every printed line is redacted. */
export async function uploadSourceMaps(options: UploadOptions): Promise<number> {
  const key = options.key.trim();
  const say = (text: string) => options.out(redact(text, key));
  const release = normalizeRelease(options.release);

  if (release === undefined) {
    say('Invalid release: it must have 1 to 200 characters and no control characters.\n');

    return 1;
  }

  let maps: string[];

  try {
    maps = await findSourceMaps(options.dir);
  } catch (error) {
    say(`Failed: could not read ${options.dir} (${errorMessage(error)}).\n`);

    return 1;
  }

  if (maps.length === 0) {
    say(`No source maps: no *.js.map files under ${options.dir}.\n`);

    return 1;
  }

  const endpoint = options.url.trim().replace(/\/+$/, '') + SOURCEMAPS_PATH;
  const fetchFn: UploadFetch = options.fetch ?? fetch;
  let failed = 0;

  for (const mapPath of maps) {
    const fileUrl = fileUrlFor(options.urlPrefix, mapPath);

    if (fileUrl === undefined) {
      say(`Failed: ${mapPath} (the URL prefix and the path do not form a valid URL path).\n`);
      failed++;
      continue;
    }

    let status: number;
    let body = '';

    try {
      const form = new FormData();
      form.append('release', release);
      form.append('file_url', fileUrl);
      form.append('map', new Blob([await readFile(join(options.dir, mapPath))], { type: 'application/json' }), basename(mapPath));

      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        body: form,
        redirect: 'manual',
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_SECONDS * 1000),
      });
      status = response.status;

      if (status < 200 || status >= 300) {
        body = await response.text().catch(() => '');
      }
    } catch (error) {
      say(`Failed: ${mapPath} -> ${fileUrl} (${errorMessage(error)}).\n`);
      failed++;
      continue;
    }

    if (status === 201 || status === 200) {
      say(`${status === 201 ? 'Uploaded' : 'Replaced'}: ${mapPath} -> ${fileUrl}\n`);
      continue;
    }

    if (status === 401) {
      say('Unauthorized: the key was rejected. Check that it is correct and has not been revoked.\n');

      return 1;
    }

    if (status === 403) {
      say(`Forbidden${serverMessage(body)}\n`);

      return 1;
    }

    const hint = status >= 300 && status < 400 ? ', check the URL scheme' : serverMessage(body);
    say(`Failed: ${mapPath} -> ${fileUrl} (HTTP ${status}${hint}).\n`);
    failed++;
  }

  say(`${maps.length - failed} of ${maps.length} source maps uploaded for release ${release}.\n`);

  return failed === 0 ? 0 : 1;
}
