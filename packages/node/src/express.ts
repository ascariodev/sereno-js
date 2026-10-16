import { capture } from './capture.js';
import { getClient } from './index.js';

/** The slice of an Express request this integration reads, so consumers need no `@types/express`. */
export interface ExpressRequestLike {
  method?: string;
  baseUrl?: string;
  path?: string;
  route?: { path?: unknown };
}

export interface ExpressResponseLike {
  headersSent?: boolean;
}

export type ExpressErrorHandler = (error: unknown, request: ExpressRequestLike, response: ExpressResponseLike, next: (error?: unknown) => void) => void;

export interface ExpressErrorHandlerOptions {
  /** Errors whose `status`/`statusCode` is below this value are not captured. Defaults to 500. */
  minStatus?: number;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;

  return typeof value === 'number' ? value : undefined;
}

function routeOf(request: ExpressRequestLike): string {
  const pattern = request.route?.path;

  return typeof pattern === 'string' ? `${request.baseUrl ?? ''}${pattern}` : `${request.baseUrl ?? ''}${request.path ?? ''}`;
}

/**
 * Express error middleware: captures the error and passes it on with `next(error)`, leaving the response to Express.
 * Register it after the routes. The context carries only `method` and `route` (the route pattern such as
 * `/users/:id` when matched, otherwise the path); never the query string, headers or body.
 */
export function expressErrorHandler(options: ExpressErrorHandlerOptions = {}): ExpressErrorHandler {
  const minStatus = options.minStatus ?? 500;

  return (error, request, _response, next) => {
    try {
      const client = getClient();
      const status = statusOf(error);

      if (client && (status === undefined || status >= minStatus)) {
        capture(client, error, { method: request.method, route: routeOf(request) });
      }
    } catch {
      // capturing must never change the response
    }

    next(error);
  };
}
