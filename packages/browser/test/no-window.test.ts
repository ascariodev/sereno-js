// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import type { FetchInit } from '@ascariodev/sereno-core';
import { close, flush, init, log } from '../src/index.js';

afterEach(async () => {
  await close();
});

it('loads and sends without window or document', async () => {
  expect('window' in globalThis).toBe(false);

  const bodies: string[] = [];
  const client = init({
    url: 'http://localhost:8003',
    key: 'wsp_' + 'b'.repeat(40),
    fetch: (_url: string, request: FetchInit) => {
      bodies.push(request.body);

      return Promise.resolve({ status: 202, text: async () => '' });
    },
  });

  log('error', 'server side');
  const result = await flush();

  expect(client.configured).toBe(true);
  expect(result.sent).toBe(1);
  expect(JSON.parse(bodies[0]!).events[0].context).toBeUndefined();
});
