import winston from 'winston';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@ascariodev/sereno-core';
import { close, flush, init } from '../src/index.js';
import { SerenoWinstonTransport } from '../src/winston.js';
import { startSink, type Sink } from './sink.js';

let sink: Sink;

beforeEach(async () => {
  sink = await startSink();
});

afterEach(async () => {
  await close();
  await sink.stop();
});

describe('SerenoWinstonTransport', () => {
  it('maps npm levels and passes the meta as context', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false, level: 'debug' });
    const logger = winston.createLogger({ level: 'silly', transports: [new SerenoWinstonTransport()] });

    logger.silly('s');
    logger.verbose('v');
    logger.http('h');
    logger.info('i', { user: 7 });
    logger.warn('w');
    logger.error('e');
    await flush();

    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ['debug', 's'],
      ['debug', 'v'],
      ['info', 'h'],
      ['info', 'i'],
      ['warning', 'w'],
      ['error', 'e'],
    ]);
    expect(sink.events[3]?.context).toEqual({ user: 7 });
  });

  it('maps syslog levels', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const logger = winston.createLogger({ levels: winston.config.syslog.levels, level: 'debug', transports: [new SerenoWinstonTransport()] });
    const emit = logger as unknown as Record<string, (message: string) => void>;

    emit.crit?.('c');
    emit.emerg?.('m');
    await flush();

    expect(sink.events.map((event) => event.level)).toEqual(['critical', 'emergency']);
  });

  it('sends error and err meta, or an Error logged directly, as the exception', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const logger = winston.createLogger({ transports: [new SerenoWinstonTransport()] });

    logger.error('job failed', { error: new TypeError('bad input'), job: 'sync' });
    logger.error('other', { err: new RangeError('range') });
    logger.error(new SyntaxError('direct'));
    await flush();

    expect(sink.events[0]).toMatchObject({ message: 'job failed', context: { job: 'sync', exception: expect.objectContaining({ class: 'TypeError', message: 'bad input' }) } });
    expect(sink.events[1]).toMatchObject({ context: { exception: expect.objectContaining({ class: 'RangeError' }) } });
    expect(sink.events[2]).toMatchObject({ message: 'direct', context: { exception: expect.objectContaining({ message: 'direct' }) } });
    expect(sink.events[2]?.context?.exception).toMatchObject({ trace: expect.stringContaining('winston.test.ts') });
  });

  it('filters by the logger level and by its own level and silent options', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false, level: 'debug' });
    const logger = winston.createLogger({ level: 'info', transports: [new SerenoWinstonTransport()] });
    const own = winston.createLogger({ level: 'silly', transports: [new SerenoWinstonTransport({ level: 'warn' }), new SerenoWinstonTransport({ silent: true })] });

    logger.debug('dropped');
    logger.info('kept');
    own.info('dropped too');
    own.warn('kept too');
    await flush();

    expect(sink.events.map((event) => event.message)).toEqual(['kept', 'kept too']);
  });

  it('maps the level with format.colorize()', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const logger = winston.createLogger({ format: winston.format.colorize(), transports: [new SerenoWinstonTransport()] });

    logger.warn('colored');
    await flush();

    expect(sink.events[0]).toMatchObject({ level: 'warning' });
  });

  it('keeps the class of an Error logged directly or passed as meta', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const logger = winston.createLogger({ transports: [new SerenoWinstonTransport()] });

    logger.error(new TypeError('x'));
    logger.error('msg', new RangeError('boom'));
    await flush();

    expect(sink.events[0]).toMatchObject({ message: 'x', context: { exception: expect.objectContaining({ class: 'TypeError' }) } });
    expect(sink.events[1]).toMatchObject({ context: { exception: expect.objectContaining({ class: 'RangeError', message: 'boom' }) } });
  });

  it('keeps the class of an Error that format.errors() turned into a plain info', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const logger = winston.createLogger({
      format: winston.format.combine(winston.format.errors({ stack: true })),
      transports: [new SerenoWinstonTransport()],
    });
    class PaymentError extends Error {
      override name = 'PaymentError';
    }

    logger.error(new PaymentError('declined'));
    await flush();

    expect(sink.events[0]).toMatchObject({ message: 'declined', context: { exception: expect.objectContaining({ class: 'PaymentError' }) } });
  });

  it('keeps an error field that is not an error in the context', async () => {
    init({ url: sink.url, key: 'wsk_test', handlers: false });
    const logger = winston.createLogger({ transports: [new SerenoWinstonTransport()] });

    logger.error('a', { error: 'timeout' });
    logger.error('b', { err: { code: 5 } });
    await flush();

    expect(sink.events[0]?.context).toEqual({ error: 'timeout' });
    expect(sink.events[1]?.context).toEqual({ err: { code: 5 } });
  });

  it('uses its own client when given, and does nothing without any', async () => {
    const own = new Client({ url: sink.url, key: 'wsk_own' });
    winston.createLogger({ transports: [new SerenoWinstonTransport({ client: own })] }).info('own');
    await own.flush();
    expect(sink.events.map((event) => event.message)).toEqual(['own']);

    expect(() => winston.createLogger({ transports: [new SerenoWinstonTransport()] }).info('nobody')).not.toThrow();
  });
});
