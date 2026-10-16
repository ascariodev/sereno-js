import type { Client } from '@ascariodev/sereno-core';
import { capture } from './global.js';
import { getClient, init } from './index.js';
import type { InitOptions } from './index.js';

/** Minimal shapes of the Vue 3 objects the plugin touches, so `vue` is not needed at build time. */
export type VueErrorHandler = (error: unknown, instance: never, info: string) => void;

export interface VueAppLike {
  config: { errorHandler?: VueErrorHandler | null | undefined };
}

export interface SerenoVueOptions {
  /** Client to send to; defaults to the active one (`getClient()`) at the moment of each error. */
  client?: Client;
  /** Calls `init` with these options when the plugin is installed, unless `client` is given. */
  init?: InitOptions;
}

function componentName(instance: unknown): string | undefined {
  try {
    const options = (instance as { $options?: { name?: unknown; __name?: unknown } } | null)?.$options;
    const name = options?.name ?? options?.__name;

    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

function vueContext(instance: unknown, info: unknown): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  const component = componentName(instance);

  if (component !== undefined) {
    context.component = component;
  }

  if (typeof info === 'string' && info !== '') {
    context.info = info;
  }

  return context;
}

function logToConsole(error: unknown): void {
  try {
    (globalThis as unknown as { console?: { error(value: unknown): void } }).console?.error(error);
  } catch {
    // nothing else to do
  }
}

/**
 * Vue 3 plugin: `app.use(SerenoVue, options?)`. Chains `app.config.errorHandler`: sends the error with the component
 * name and Vue's hook info, then calls the previous handler, or `console.error` when there was none. Never throws.
 */
export const SerenoVue = {
  install(app: VueAppLike, options: SerenoVueOptions = {}): void {
    try {
      let client = options?.client;

      if (!client && options?.init) {
        client = init(options.init);
      }

      const previous = app.config.errorHandler;

      app.config.errorHandler = (error, instance, info) => {
        try {
          const target = client ?? getClient();

          if (target) {
            capture(target, error, vueContext(instance, info));
          }
        } catch {
          // reporting must never change how the app handles the error
        }

        if (typeof previous === 'function') {
          previous(error, instance, info);
        } else {
          logToConsole(error);
        }
      };
    } catch {
      // installing the plugin must never break the app
    }
  },
};
