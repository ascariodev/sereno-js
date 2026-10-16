import type { InitOptions } from './index.js';

/** The request Next passes to `onRequestError`. Only `method` is read: `path` carries the query string. */
export interface NextErrorRequest {
  path?: string;
  method?: string;
  headers?: unknown;
}

/** The context Next passes to `onRequestError` (`RequestErrorContext` in `next`). */
export interface NextRequestErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
  revalidateReason?: string;
}

export type NextOnRequestError = (error: unknown, request: Readonly<NextErrorRequest>, context: Readonly<NextRequestErrorContext>) => Promise<void>;

export interface NextOnRequestErrorOptions {
  /** Errors whose `status`/`statusCode` is below this value are not captured. Defaults to 500. */
  minStatus?: number;
}

/** Digests of the errors Next throws to drive navigation and rendering (redirect, notFound, forbidden, bailouts). */
const CONTROL_FLOW_DIGEST = /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|BAILOUT_TO_CLIENT_SIDE_RENDERING|DYNAMIC_SERVER_USAGE)(;|$)/;

function isIgnored(error: unknown, minStatus: number): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { digest, status, statusCode } = error as { digest?: unknown; status?: unknown; statusCode?: unknown };

  if (typeof digest === 'string' && CONTROL_FLOW_DIGEST.test(digest)) {
    return true;
  }

  const value = typeof status === 'number' ? status : statusCode;

  return typeof value === 'number' && value < minStatus;
}

function contextOf(request: Readonly<NextErrorRequest>, context: Readonly<NextRequestErrorContext>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    method: request?.method,
    route: context?.routePath,
    routeType: context?.routeType,
    routerKind: context?.routerKind,
  };

  if (context?.renderSource !== undefined) {
    result.renderSource = context.renderSource;
  }

  return result;
}

/**
 * Builds an `onRequestError` for `instrumentation.ts`. It captures the error and waits for it to be sent (at most the
 * delivery budget of the contract) before resolving; it never rejects. The context carries `method`, `route` (the route
 * pattern such as `/api/users/[id]`), `routeType`, `routerKind` and `renderSource`; never the path, query, headers or body.
 * Outside the Node.js runtime it does nothing; the Node modules of the SDK are loaded lazily so the edge bundle never needs them.
 */
export function createOnRequestError(options: NextOnRequestErrorOptions = {}): NextOnRequestError {
  const minStatus = options.minStatus ?? 500;

  return async (error, request, context) => {
    try {
      // Written literally so Next can replace it at build time and drop the imports from the edge bundle.
      if (process.env.NEXT_RUNTIME === 'nodejs') {
        if (isIgnored(error, minStatus)) {
          return;
        }

        const { getClient } = await import('./index.js');
        const client = getClient();

        if (!client) {
          return;
        }

        const [{ capture }, { flushWithin, SHUTDOWN_WAIT_MS }] = await Promise.all([import('./capture.js'), import('./process.js')]);
        capture(client, error, contextOf(request, context));
        await flushWithin(client, SHUTDOWN_WAIT_MS);
      }
    } catch {
      // reporting must never change how Next handles the error
    }
  };
}

/** Ready to re-export from `instrumentation.ts`: `export { register, onRequestError } from '@ascariodev/sereno-node/next'`. */
export const onRequestError: NextOnRequestError = createOnRequestError();

/**
 * Initializes the SDK from `instrumentation.ts` only in the Node.js runtime (never in `edge`) and only once, so a
 * client created earlier with `init` is kept. Without options it reads `SERENO_URL`, `SERENO_KEY` and friends.
 */
export async function register(options?: InitOptions): Promise<void> {
  try {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
      const { getClient, init } = await import('./index.js');

      if (!getClient()) {
        init(options);
      }
    }
  } catch {
    // a broken setup must never stop the Next server from starting
  }
}
