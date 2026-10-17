// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import type { Component } from 'vue';
import type { FetchInit, SerenoEvent } from '@ascariodev/sereno-core';
import { BrowserClient, close, flush, getClient, init } from '../src/index.js';
import type { InitOptions } from '../src/index.js';
import { SerenoVue } from '../src/vue.js';

const KEY = 'wsp_' + 'c'.repeat(40);

let events: SerenoEvent[];

function options(): InitOptions {
  return {
    url: 'http://localhost:8003',
    key: KEY,
    fetch: (_url: string, request: FetchInit) => {
      events.push(...(JSON.parse(request.body) as { events: SerenoEvent[] }).events);

      return Promise.resolve({ status: 202, text: async () => '' });
    },
  };
}

const Exploding = defineComponent({
  name: 'Exploding',
  props: { secret: { type: String, default: '' } },
  setup() {
    throw new Error('setup failed');
  },
});

function mount(root: Component, configure: (app: ReturnType<typeof createApp>) => void) {
  const app = createApp({ render: () => h(root, { secret: 'do-not-send' }) });
  configure(app);
  const document = (globalThis as unknown as { document: { createElement(tag: string): object } }).document;
  app.mount(document.createElement('div') as never);
  app.unmount();
}

beforeEach(() => {
  events = [];
});

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
});

describe('SerenoVue', () => {
  it('sends the setup error with component and hook, then calls the previous handler', async () => {
    init(options());
    const previous = vi.fn();

    mount(Exploding, (app) => {
      app.config.errorHandler = previous;
      app.use(SerenoVue);
    });
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'error',
      message: 'setup failed',
      context: { component: 'Exploding', info: 'setup function', exception: { class: 'Error', message: 'setup failed' } },
    });
    expect(JSON.stringify(events[0])).not.toContain('do-not-send');
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(previous.mock.calls[0]?.[2]).toBe('setup function');
  });

  it('logs to the console like Vue when there was no previous handler', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    init(options());

    mount(Exploding, (app) => app.use(SerenoVue));
    await flush();

    expect(events).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect((consoleError.mock.calls[0]?.[0] as Error).message).toBe('setup failed');
  });

  it('uses __name for script setup components', async () => {
    init(options());
    const ScriptSetup = { __name: 'ScriptSetupThing', setup: Exploding.setup } as unknown as Component;

    mount(ScriptSetup, (app) => {
      app.config.errorHandler = () => undefined;
      app.use(SerenoVue);
    });
    await flush();

    expect(events[0]?.context).toMatchObject({ component: 'ScriptSetupThing', info: 'setup function' });
  });

  it('initializes the SDK with the init option', async () => {
    mount(Exploding, (app) => {
      app.config.errorHandler = () => undefined;
      app.use(SerenoVue, { init: options() });
    });

    expect(getClient()?.configured).toBe(true);
    await flush();
    expect(events).toHaveLength(1);
  });

  it('sends to the client given in the options', async () => {
    const client = new BrowserClient(options());

    mount(Exploding, (app) => {
      app.config.errorHandler = () => undefined;
      app.use(SerenoVue, { client });
    });
    await client.flush();

    expect(getClient()).toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it('does nothing and does not throw without a client', () => {
    const previous = vi.fn();

    expect(() =>
      mount(Exploding, (app) => {
        app.config.errorHandler = previous;
        app.use(SerenoVue);
      }),
    ).not.toThrow();
    expect(previous).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it('captures once and calls the previous handler once when installed twice in the same app', async () => {
    init(options());
    const previous = vi.fn();

    mount(Exploding, (app) => {
      app.config.errorHandler = previous;
      app.use(SerenoVue);
      SerenoVue.install(app);
    });
    await flush();

    expect(events).toHaveLength(1);
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it('keeps the main entry free of vue', () => {
    for (const file of ['../src/index.ts', '../src/global.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');

      expect(source).not.toMatch(/from '(vue|\.\/vue\.js)'/);
    }
  });
});
