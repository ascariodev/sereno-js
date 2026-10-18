// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, useState, version } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchInit, SerenoEvent } from '@ascariodev/sereno-core';
import { BrowserClient, close, flush, init } from '../src/index.js';
import type { InitOptions } from '../src/index.js';
import { SerenoErrorBoundary } from '../src/react.js';
import type { FallbackProps } from '../src/react.js';

interface Dom {
  document: {
    createElement(tag: string): { textContent: string | null; querySelector(selector: string): { click(): void } | null };
  };
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}

const dom = globalThis as unknown as Dom;
dom.IS_REACT_ACT_ENVIRONMENT = true;

const isReact18 = version.startsWith('18.');
// React 18 in development also reports the render error to window, before the boundary does
const boundaryEvents = isReact18 ? 2 : 1;
const KEY = 'wsp_' + 'd'.repeat(40);

let events: SerenoEvent[];
let container: ReturnType<Dom['document']['createElement']>;
let root: Root;

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

function Exploding({ when = true }: { when?: boolean }) {
  if (when) {
    throw new Error('render failed');
  }

  return <p>child ok</p>;
}

function Thrower({ error }: { error: Error }): never {
  throw error;
}

function render(node: ReactNode) {
  act(() => {
    root.render(node);
  });
}

beforeEach(() => {
  events = [];
  container = dom.document.createElement('div');
  root = createRoot(container as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  act(() => root.unmount());
  await close();
  vi.restoreAllMocks();
});

describe('SerenoErrorBoundary', () => {
  it('sends the error with the componentStack and renders the fallback', async () => {
    init(options());
    const onError = vi.fn();

    render(
      <SerenoErrorBoundary fallback={<p>something broke</p>} onError={onError}>
        <Exploding />
      </SerenoErrorBoundary>,
    );
    await flush();

    expect(container.textContent).toBe('something broke');
    expect(events).toHaveLength(boundaryEvents);
    expect(events.at(-1)).toMatchObject({ level: 'error', message: 'render failed', context: { exception: { class: 'Error' } } });
    expect(events.at(-1)?.context?.componentStack).toEqual(expect.stringContaining('Exploding'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toHaveProperty('componentStack');
  });

  it('deduplicates a window error for the same error that the boundary already sent', async () => {
    const scope = globalThis as unknown as { addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void };
    let windowErrors = 0;
    const countWindowError = () => {
      windowErrors++;
    };
    scope.addEventListener('error', countWindowError);
    init(options());
    let caught: unknown;

    render(
      <SerenoErrorBoundary fallback={null} onError={(error) => (caught = error)}>
        <Exploding />
      </SerenoErrorBoundary>,
    );
    const reactWindowErrors = windowErrors;
    const ErrorEventClass = (globalThis as unknown as { ErrorEvent: new (type: string, init: object) => Event }).ErrorEvent;
    (scope as unknown as { dispatchEvent(event: Event): void }).dispatchEvent(new ErrorEventClass('error', { error: caught }));
    await flush();
    scope.removeEventListener('error', countWindowError);

    // React 18 in development dispatches the window error during render, before the boundary reports
    expect(reactWindowErrors > 0).toBe(isReact18);
    expect(windowErrors).toBe(reactWindowErrors + 1);
    expect(events).toHaveLength(isReact18 ? 2 : 1);
    expect(events.filter((event) => event.context?.componentStack !== undefined)).toHaveLength(1);
  });

  it('keeps the componentStack when the window error for the same error arrives first', async () => {
    const scope = globalThis as unknown as { dispatchEvent(event: Event): void };
    const ErrorEventClass = (globalThis as unknown as { ErrorEvent: new (type: string, init: object) => Event }).ErrorEvent;
    const error = new Error('render failed early');
    init(options());

    scope.dispatchEvent(new ErrorEventClass('error', { error }));
    render(
      <SerenoErrorBoundary fallback={<p>fallback</p>}>
        <Thrower error={error} />
      </SerenoErrorBoundary>,
    );
    await flush();

    expect(container.textContent).toBe('fallback');
    expect(events).toHaveLength(2);
    expect(events[0]?.context?.componentStack).toBeUndefined();
    expect(events[1]?.context?.componentStack).toEqual(expect.stringContaining('Thrower'));
  });

  it('renders the children again after reset', async () => {
    init(options());
    let setBroken: (value: boolean) => void = () => undefined;

    function App() {
      const [broken, setter] = useState(true);
      setBroken = setter;

      return (
        <SerenoErrorBoundary
          fallback={({ error, reset }: FallbackProps) => (
            <button onClick={reset}>retry after {(error as Error).message}</button>
          )}
        >
          <Exploding when={broken} />
        </SerenoErrorBoundary>
      );
    }

    render(<App />);
    expect(container.textContent).toBe('retry after render failed');

    act(() => setBroken(false));
    act(() => container.querySelector('button')!.click());

    expect(container.textContent).toBe('child ok');
    await flush();
    expect(events).toHaveLength(boundaryEvents);
  });

  it('hands an error thrown by the fallback to the parent boundary', async () => {
    init(options());

    render(
      <SerenoErrorBoundary fallback={<p>outer fallback</p>}>
        <SerenoErrorBoundary
          fallback={() => {
            throw new Error('fallback failed');
          }}
        >
          <Exploding />
        </SerenoErrorBoundary>
      </SerenoErrorBoundary>,
    );
    await flush();

    expect(container.textContent).toBe('outer fallback');
    // React 19 does not report the original error; React 18 also sends 'render failed'
    expect(events.map((event) => event.message).sort()).toEqual(isReact18 ? ['fallback failed', 'render failed'] : ['fallback failed']);
  });

  it('shows the fallback again and calls onError again when reset and the child still fails (same error is deduplicated)', async () => {
    const onError = vi.fn();
    init(options());

    render(
      <SerenoErrorBoundary onError={onError} fallback={({ reset }: FallbackProps) => <button onClick={reset}>retry</button>}>
        <Exploding />
      </SerenoErrorBoundary>,
    );
    act(() => container.querySelector('button')!.click());
    await flush();

    expect(container.textContent).toBe('retry');
    expect(onError).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(boundaryEvents);
  });

  it('sends to the client given in the props', async () => {
    const client = new BrowserClient(options());

    render(
      <SerenoErrorBoundary client={client}>
        <Exploding />
      </SerenoErrorBoundary>,
    );
    await client.flush();

    expect(container.textContent).toBe('');
    expect(events).toHaveLength(1);
  });

  it('renders the fallback without a client and ignores a failing onError', () => {
    expect(() =>
      render(
        <SerenoErrorBoundary
          fallback={<p>fallback</p>}
          onError={() => {
            throw new Error('callback failed');
          }}
        >
          <Exploding />
        </SerenoErrorBoundary>,
      ),
    ).not.toThrow();

    expect(container.textContent).toBe('fallback');
    expect(events).toHaveLength(0);
  });

  it('keeps the main entry free of react', () => {
    for (const file of ['../src/index.ts', '../src/global.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');

      expect(source).not.toMatch(/from '(react|react-dom|\.\/react\.js)'/);
    }
  });
});
