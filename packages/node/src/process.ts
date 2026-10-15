import { BUDGET_SECONDS } from '@ascariodev/sereno-core';
import type { Client } from '@ascariodev/sereno-core';
import { inspect } from 'node:util';
import { capture } from './capture.js';

/** Longest a dying process waits for the buffer to be sent: the delivery budget of the contract. */
export const SHUTDOWN_WAIT_MS = BUDGET_SECONDS * 1000;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type RejectionMode = 'throw' | 'strict' | 'warn' | 'none' | 'warn-with-error-code';

export function rejectionMode(args: readonly string[] = process.execArgv, nodeOptions: string = process.env.NODE_OPTIONS ?? ''): RejectionMode {
  const tokens = [...nodeOptions.split(/\s+/).filter(Boolean), ...args];
  let mode = 'throw';

  tokens.forEach((token, index) => {
    if (token === '--unhandled-rejections') {
      mode = tokens[index + 1] ?? mode;
    } else if (token.startsWith('--unhandled-rejections=')) {
      mode = token.slice('--unhandled-rejections='.length);
    }
  });

  return ['strict', 'warn', 'none', 'warn-with-error-code'].includes(mode) ? (mode as RejectionMode) : 'throw';
}

async function flushWithin(client: Client, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });

  try {
    await Promise.race([client.flush().then(() => undefined), limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * With the default modes a non-Error rejection reaches `uncaughtException` wrapped in an ERR_UNHANDLED_REJECTION error
 * that does not expose the value; only its message carries it, as the string V8 prints (`#<Object>` for objects).
 */
function rejectedValue(error: unknown, origin: string): unknown {
  if (origin !== 'unhandledRejection' || typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ERR_UNHANDLED_REJECTION') {
    return error;
  }

  const match = /The promise rejected with the reason "([\s\S]*)"\.$/.exec(String((error as { message?: unknown }).message));

  return match ? match[1] : error;
}

/**
 * Captures uncaught exceptions, unhandled rejections and signals, and flushes on `beforeExit`, without changing how
 * the process ends. The `uncaughtException` listener replaces Node's default only when no other listener exists: then
 * it prints the error and exits with 1 once the buffer is sent (or `waitMs` passes). Signals are handled the same
 * way and end with the default action. Returns the uninstaller.
 */
export function installProcessHandlers(client: Client, waitMs: number = SHUTDOWN_WAIT_MS): () => void {
  let dying = false;

  const onUncaught = (error: unknown, origin: string): void => {
    try {
      if (dying) {
        return;
      }

      capture(client, rejectedValue(error, origin));

      if (process.listenerCount('uncaughtException') > 1) {
        void client.flush();

        return;
      }

      dying = true;
      process.stderr.write(`${inspect(error)}\n\nNode.js ${process.version}\n`);
      void flushWithin(client, waitMs).then(() => process.exit(1));
    } catch {
      process.exit(1);
    }
  };

  const mode = rejectionMode();
  const onRejection = (reason: unknown): void => {
    capture(client, reason);

    if (mode === 'warn-with-error-code' && process.listenerCount('unhandledRejection') === 1) {
      process.exitCode = 1;
      process.emitWarning(`Unhandled promise rejection: ${inspect(reason)}`, 'UnhandledPromiseRejectionWarning');
    }
  };
  // In the default 'throw' and 'strict' modes a listener would turn "crash" into "the app handles it", so ours is
  // only added where it changes nothing, or as a plain observer when the app already has one. The default modes
  // reach onUncaught instead.
  const observeRejections = (mode !== 'throw' && mode !== 'strict') || process.listenerCount('unhandledRejection') > 0;

  const onBeforeExit = (): void => {
    void client.flush();
  };

  const signalHandlers = SIGNALS.map((signal) => {
    let waiting = false;
    const finish = (): void => {
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    const handler = (): void => {
      if (process.listenerCount(signal) > 1) {
        void client.flush();

        return;
      }

      if (waiting) {
        finish();

        return;
      }

      waiting = true;
      void flushWithin(client, waitMs).then(finish);
    };

    return [signal, handler] as const;
  });

  process.on('uncaughtException', onUncaught);
  process.on('beforeExit', onBeforeExit);

  if (observeRejections) {
    process.on('unhandledRejection', onRejection);
  }

  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }

  return () => {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('beforeExit', onBeforeExit);
    process.removeListener('unhandledRejection', onRejection);

    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  };
}
