import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@ascariodev/sereno-core';
import { flushClient } from '../src/logging.js';

const unhandled: unknown[] = [];
const collect = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', collect);
});

afterEach(() => {
  process.off('unhandledRejection', collect);
});

describe('flushClient', () => {
  it('contains a done callback that throws after an async flush, calling it once', async () => {
    const done = vi.fn(() => {
      throw new Error('user done');
    });
    const client = { flush: () => Promise.resolve() } as unknown as Client;

    expect(() => flushClient({ client }, done)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(done).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it('contains a done callback that throws when the flush itself throws or rejects, calling it once', async () => {
    const throwing = { flush: () => { throw new Error('flush boom'); } } as unknown as Client;
    const rejecting = { flush: () => Promise.reject(new Error('flush rejected')) } as unknown as Client;

    for (const client of [throwing, rejecting]) {
      const done = vi.fn(() => {
        throw new Error('user done');
      });

      expect(() => flushClient({ client }, done)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(done).toHaveBeenCalledTimes(1);
    }

    expect(unhandled).toEqual([]);
  });
});
