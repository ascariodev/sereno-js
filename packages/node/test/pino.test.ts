import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@ascariodev/sereno-core';
import { close, flush, init } from '../src/index.js';
import { serenoPinoStream } from '../src/pino.js';
import { startSink, type Sink } from './sink.js';

let sink: Sink;

beforeEach(async () => {
  sink = await startSink();
});

afterEach(async () => {
  await close();
  await sink.stop();
});

describe('serenoPinoStream', () => {
  it('maps levels and passes the context, without pino bookkeeping fields', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false, level: 'debug' });
    const logger = pino({ level: 'trace' }, serenoPinoStream());

    logger.debug('d');
    logger.info({ user: 7 }, 'i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');
    await flush();

    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ['debug', 'd'],
      ['info', 'i'],
      ['warning', 'w'],
      ['error', 'e'],
      ['critical', 'f'],
    ]);
    expect(sink.events[1]?.context).toEqual({ user: 7 });
  });

  it('sends err as the exception, with its class and trace', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const logger = pino(serenoPinoStream());

    logger.error({ err: new TypeError('bad input'), job: 'sync' }, 'job failed');
    logger.error(new RangeError('only an error'));
    await flush();

    expect(sink.events[0]).toMatchObject({ level: 'error', message: 'job failed', context: { job: 'sync', exception: expect.objectContaining({ class: 'TypeError', message: 'bad input' }) } });
    expect(sink.events[0]?.context?.exception).toMatchObject({ trace: expect.stringContaining('pino.test.ts') });
    expect(sink.events[1]).toMatchObject({ message: 'only an error', context: { exception: expect.objectContaining({ class: 'RangeError' }) } });
  });

  it('maps level names and keeps an error field that is not an error in the context', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const logger = pino({ formatters: { level: (label) => ({ level: label }) } }, serenoPinoStream());

    logger.warn({ error: 'timeout' }, 'a');
    logger.error({ err: { code: 5 } }, 'b');
    await flush();

    expect(sink.events[0]).toMatchObject({ level: 'warning', context: { error: 'timeout' } });
    expect(sink.events[1]).toMatchObject({ level: 'error', context: { err: { code: 5 } } });
  });

  it('flush sends the buffer and end does nothing', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const stream = serenoPinoStream();

    pino(stream).info('before');
    await new Promise<void>((resolve) => stream.flush(resolve));
    expect(sink.events.map((event) => event.message)).toEqual(['before']);
    expect(() => stream.end()).not.toThrow();
  });

  it('uses its own client when given, and does nothing without any', async () => {
    const own = new Client({ url: sink.url, key: 'wsk_own' });
    pino(serenoPinoStream({ client: own })).info('own');
    await own.flush();
    expect(sink.events.map((event) => event.message)).toEqual(['own']);

    expect(() => pino(serenoPinoStream()).info('nobody')).not.toThrow();
  });

  it('works inside pino.multistream and ignores lines that are not JSON', () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const stream = serenoPinoStream();

    expect(() => stream.write('plain text')).not.toThrow();
    expect(() => pino({}, pino.multistream([{ stream }])).info('x')).not.toThrow();
  });
});
