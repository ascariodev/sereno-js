# Sereno for Node.js

Sends errors and logs from Node.js, Express, NestJS and Next.js to a Sereno project channel. It posts events to the
Sereno ingest endpoint (`POST {SERENO_URL}/api/ingest/events`) with a source API key. It captures uncaught
exceptions and unhandled rejections on its own, and ships an error middleware for Express, an exception filter for
NestJS and an `onRequestError` hook for Next.js. Written in TypeScript, ESM and CommonJS, no runtime dependencies besides
`@ascariodev/sereno-core`.

## Requirements

- Node.js 20 or newer (it uses the global `fetch`)
- Optional, only for the integration you use: `express` >= 4, `@nestjs/common` and `@nestjs/core` >= 9 (with
  `reflect-metadata` and `rxjs`), `next` >= 15

## Installation

Create a project in Sereno, open its Integrations page and choose "Create log source". The dialog shows the source
key (`wsk_...`) only once; if you lose it, rotate the key. Then, in your application:

```bash
npm install @ascariodev/sereno-node
```

Set `SERENO_URL` (the base URL of the Sereno API, without a path) and `SERENO_KEY` in the environment, as described in
Configuration, and check them with `npx @ascariodev/sereno-node test` (see Testing the connection).

## Plain Node.js

Call `init()` once, as early as possible in your entry point:

```js
import { init, captureException, log, flush } from '@ascariodev/sereno-node';

init(); // reads SERENO_URL and SERENO_KEY from the environment

log('warning', 'Payment is slow', { order_id: 42 });

try {
  await chargeCard();
} catch (error) {
  captureException(error, { order_id: 42 });
}
```

With CommonJS: `const { init, captureException } = require('@ascariodev/sereno-node');`.

You can also pass the settings: `init({ url: 'https://your-sereno-api.example.com', key: 'wsk_your_key', level: 'warning' })`.
Options passed in code win over the environment. `init` returns the client, and calling it again replaces the previous
setup (the buffered events of the old one are sent first).

Options (all optional):

| Option | Default | Description |
|---|---|---|
| `url`, `key` | environment | Base URL of the API and the source key. |
| `level` | `debug` | Minimum level sent. |
| `timeout` | `2` | Seconds per request, see Configuration. |
| `handlers` | `true` | Set to `false` to not install the process handlers described below. |
| `retry` | `true` | Set to `false` to make a single attempt per batch. |

`InitOptions` inherits the client options `notifier`, `fetch`, `headers` and `fetchOptions`; they are described in the README of `@ascariodev/sereno-core`.

Functions:

- `captureException(error, context?)`: buffers a thrown value at level `error`. An `Error` is sent with its class,
  message, location and stack; anything else is sent as `String(value)`. The `context` is merged in, but when the captured value is an `Error` the
  `exception` key is reserved for it and overrides yours; with any other value the context is sent as is.
- `log(level, message, context?)`: buffers a record. Levels: `debug`, `info`, `notice`, `warning`, `error`, `critical`,
  `alert`, `emergency`. To group repeated events pass `{ fingerprint: '...' }` in the context; errors are grouped by
  class, file and line.
- `flush()`: sends what is buffered and resolves with `{ sent, failed, dropped }`. It never rejects. Call it before a
  serverless handler returns.
- `close()`: removes the process handlers, sends what is buffered and leaves the SDK uninitialized.

Without a URL or a key, `init` still returns a working client, but it is inert: nothing is buffered, no handler is
installed and no request is made. The functions above do nothing before `init`.

### What it captures in the process

Unless you pass `handlers: false`, `init` installs these listeners without changing how the process ends:

- **Uncaught exceptions** (`uncaughtException`) and **unhandled rejections**: sent at level `error`. If your app has no
  other `uncaughtException` listener, Sereno prints the error, waits up to 10 seconds for the buffer to be sent and
  exits with code 1, as Node does. If your app has one, Sereno only captures and flushes, and your listener decides.
  With the default `--unhandled-rejections=throw` (and `strict`) a rejection reaches Sereno through
  `uncaughtException`; with `warn`, `none` and `warn-with-error-code` Sereno observes `unhandledRejection` instead.
  If your own `unhandledRejection` listener exists in `throw` or `strict` mode, Sereno also observes it.
- **Signals** (`SIGINT`, `SIGTERM`): if your app has no listener for the signal, Sereno sends the buffer (up to 10
  seconds) and then lets the signal take its default action. If you have your own listener, Sereno only flushes.
- **Normal exit** (`beforeExit`): the buffer is flushed when the event loop drains.

Things to know:

- `process.exit()` called directly ends the process at once and loses what is still buffered. Call `await flush()`
  (or `await close()`) first.
- With `--unhandled-rejections=throw` or `strict`, Sereno observes `unhandledRejection` only if a listener of yours exists when `init` runs; otherwise rejections arrive through `uncaughtException`. If you install your own `unhandledRejection` listener, do it before `init` so Sereno still sees the rejection.
- A process killed with `SIGKILL` or by an out-of-memory kill cannot be captured.
- The timers of the SDK never keep the process alive.

## Express

```js
import express from 'express';
import { init } from '@ascariodev/sereno-node';
import { expressErrorHandler } from '@ascariodev/sereno-node/express';

init();

const app = express();

app.get('/boom', () => {
  throw new Error('boom');
});

app.use(expressErrorHandler()); // after the routes

app.listen(3000);
```

The middleware captures the error and passes it on with `next(error)`, so Express still builds the response. It
ignores errors whose `status` or `statusCode` is below 500 (change it with `expressErrorHandler({ minStatus: 400 })`).
The status is resolved as Express does: the error's `status`, then `statusCode`, then the response status, each only if
it is 400-599, otherwise 500. So an error with status 200 is captured.
The context carries only `method` and `route`: the route pattern such as `/users/:id` when matched, otherwise the path;
never the query string, headers or body.

- Register it after all routes and routers. Registered on the app, `route` is relative to the router that handled the
  request, so the prefix where a router is mounted (for example `/api`) is missing.
- Express 4 does not forward errors from `async` handlers or rejected promises to the error middleware, so a rejecting async
  handler becomes an unhandled rejection: Sereno captures it (without `method` and `route`) and, in the default mode
  with no listeners of your own, the process then exits with code 1. Wrap them with `try/catch` and `next(error)`, or
  use Express 5, which forwards them.

## NestJS

Initialize before creating the app, so bootstrap errors are captured too, in `main.ts`:

```ts
import { init } from '@ascariodev/sereno-node';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

init();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
```

Then register the filter, either with the module (recommended):

```ts
import { Module } from '@nestjs/common';
import { SerenoModule } from '@ascariodev/sereno-node/nest';

@Module({ imports: [SerenoModule.forRoot()] })
export class AppModule {}
```

`SerenoModule.forRoot(options?)` registers the filter as a global `APP_FILTER`. If you pass options it also calls
`init(options)`, unless the SDK is already initialized.

or by hand in `main.ts`, passing the HTTP adapter the filter needs:

```ts
import { HttpAdapterHost } from '@nestjs/core';
import { SerenoExceptionFilter } from '@ascariodev/sereno-node/nest';

app.useGlobalFilters(new SerenoExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
```

The filter captures the exception and then answers exactly as Nest would. `HttpException`s with a status below 500 are
not captured, and neither are `RpcException` and `WsException` (matched by class name, so `@nestjs/microservices` and
`@nestjs/websockets` stay optional): they are usually expected client errors. In HTTP the context carries only `method`
and `route`. Any other error in microservice (`rpc`) and WebSocket (`ws`) handlers is captured, without context, and
every exception is answered like Nest's defaults. It is tested with the Express
platform; Fastify is not tested.

## Next.js

Next.js 15 or newer, App Router or Pages Router. Create `instrumentation.ts` at the root of the project (or in `src/`)
and re-export the hooks:

```ts
export { register, onRequestError } from '@ascariodev/sereno-node/next';
```

Set `SERENO_URL` and `SERENO_KEY` in the server environment. Notes:

- `register` is `async` and initializes the SDK only in the Node.js runtime. In the `edge` runtime it does nothing
  (the Node modules are never loaded there). It does not reinitialize a client created earlier with `init`.
- `onRequestError` captures errors from Server Components, route handlers, server actions and, in the Pages Router,
  API routes and `getServerSideProps`; it waits for the event to be sent (at most 10 seconds) and never throws. Redirects, `notFound()` and other control-flow errors are ignored.
  The context carries `method`, `route` (the route pattern such as `/api/users/[id]`), `routeType`, `routerKind` and
  `renderSource`; never the path, query, headers or body.
- Different options: write your own file with `import { register as base, createOnRequestError } from
  '@ascariodev/sereno-node/next'`, export `register = () => base({ level: 'warning' })` and `onRequestError =
  createOnRequestError({ minStatus: 400 })`.
- Inside Next, if you do not want the process handlers (Next manages its own), use
  `register({ handlers: false })` through the custom file above.
- Client-side errors are not captured here. The SDK has no development-specific logic, so `next dev` uses the same
  hooks; it is not tested against a real `next dev` server.

## pino

Install `pino` (8 or newer) next to the SDK and pass the Sereno stream as pino's destination, in the same process:

```js
import pino from 'pino';
import { init } from '@ascariodev/sereno-node';
import { serenoPinoStream } from '@ascariodev/sereno-node/pino';

init();

const logger = pino(serenoPinoStream());
logger.error({ err: new Error('boom'), jobId: 7 }, 'job failed');
```

- Levels: trace and debug go to `debug`, info to `info`, warn to `warning`, error to `error` and fatal to `critical`
  (custom levels by number range).
- The `err` (or `error`) field is sent as the exception; the other fields are the context. `level`, `time`, `pid`,
  `hostname` and `msg` are not.
- To keep your usual output as well, use `pino.multistream([{ stream: process.stdout }, { stream: serenoPinoStream() }])`
  as the second argument of `pino`.
- A custom `messageKey` or `errorKey` is not supported. Its `flush(cb)` sends the buffer; `end()` does nothing.
- It is a plain destination, not a `pino.transport` target: transports run in a worker thread, where the client from
  `init()` does not exist. Pass `serenoPinoStream({ client })` to use your own `Client` instead of the active one.

## winston

Install `winston` (3 or newer) and add the transport:

```js
import winston from 'winston';
import { init } from '@ascariodev/sereno-node';
import { SerenoWinstonTransport } from '@ascariodev/sereno-node/winston';

init();

const logger = winston.createLogger({ transports: [new SerenoWinstonTransport()] });
logger.error('job failed', { error: new Error('boom'), jobId: 7 });
```

- Levels map by name: `warn` to `warning`, `http` to `info`, `verbose` and `silly` to `debug`, and the syslog names
  (`emerg`, `crit`, ...) to their Sereno level. Unknown names are sent as `info`.
- The `error` (or `err`) field, an `Error` logged directly (`logger.error(error)`) or passed as meta (`logger.error('msg', error)`), is sent as the exception; the
  other meta fields are the context.
- It extends winston's own transport, so `level`, `silent` and `format` options work as usual; `handleExceptions` is not supported.
- `new SerenoWinstonTransport({ client })` uses your own `Client` instead of the one from `init()`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SERENO_URL` | none | Base URL of the Sereno API, without a path (for example `https://api.example.com`). |
| `SERENO_KEY` | none | The source API key, sent as a Bearer token. |
| `SERENO_TIMEOUT` | `2` | Seconds per request (a batch makes at most two, see Delivery behavior). Capped at `10`; a missing, non numeric or non positive value falls back to `2`. |
| `SERENO_LEVEL` | `debug` | Minimum level sent. An invalid value falls back to `debug`. |

`init` reads the four variables and the options passed in code win over them. The `test` command reads `SERENO_URL` and
`SERENO_KEY`. Node does not read `.env` files by itself: export the variables or start it with `node --env-file=.env`.

## Testing the connection

```bash
npx @ascariodev/sereno-node test
npx @ascariodev/sereno-node test --key=wsk_your_key --url=https://your-sereno-api.example.com
```

The `test` subcommand is required. It sends one test event (level `info`, message "Sereno connection test") to
`{url}/api/ingest/events` with a 5 second timeout and no retry. Without `--key` and `--url` (also accepted as
`--key value`) it uses `SERENO_KEY` and `SERENO_URL` from the process environment. The outcome is one of:

- Connected: Sereno answered `202`. Exit code 0.
- Unauthorized: `401`, the key is invalid or has been revoked.
- Missing URL or key: nothing is sent.
- Failed: network failure, timeout or any other HTTP status (a redirect hints at a wrong URL scheme).

Every outcome other than "Connected" exits with code 1.

## Events

Each record becomes an event with `id`, `level`, `message`, `occurred_at` (UTC), optional `context` and optional
`fingerprint`. The fingerprint groups repeated events: pass `{ fingerprint: '...' }` in the context, or capture an
`Error`, which uses its class, file and line (`Class|file:line`). Fingerprints over 255 characters are replaced by their
SHA-1. Limits keep the payload valid for the API: messages are cut at 8192 characters, context at 32 KB, 8 levels of
depth and 50 items per array, strings in the context at 2048 characters and stack traces at 2000. When anything is
cut, the context carries `_truncated: true`. An empty message is sent as `-`.

The `id` is a UUID generated once when the record is formatted, so it stays the same when a batch is retried. In the API
the `id` is optional (1 to 64 characters, unique per log source): an event whose `id` was already received from the same
source is accepted but discarded, so resending a batch never duplicates events or inflates the group counters.

Privacy: the SDK sends only what you put in the context, plus the error itself. The framework integrations add only
the method and the route pattern, never the query string, headers, cookies or body. Do not put secrets in messages or
contexts.

## Delivery behavior

- **Buffered and batched.** Records are buffered in memory and sent in batches of at most 100 events per request.
  Reaching 100 buffered events flushes immediately, and otherwise the buffer is flushed 1 second after the first
  record (the timer does not keep the process alive).
- **One retry, only on transient failures.** If a request fails with a network error, a timeout or a 5xx response, the
  same batch, with the same event ids, is sent once more; the server discards the events it already stored. Any 4xx
  response (for example `401`, `413`, `422` or `429`) is not retried. Both attempts share a budget of 10 seconds: the
  retry uses the configured timeout or what is left of the budget, whichever is lower, and is skipped when less than
  half a second is left. Redirects are not followed.
- **Buffer cap.** At most 1000 events are buffered between flushes. Beyond that, new records are dropped and one
  notice with the number of dropped events is reported at the next flush.
- **Never throws.** No function of the SDK throws or rejects into your code. If a batch is not delivered, or an event
  cannot be formatted, a message with the reason is written with `console.error` and the events of that batch are
  dropped. While Sereno is sending or reporting a failure, records logged from inside the SDK's own request or
  notifier are ignored, so a failure can never loop.
- **Flush points.** A full buffer, the 1 second timer, `flush()`, `close()`, a normal exit and the process handlers
  above. Events still buffered when the process is killed are lost.

## License

MIT. See [LICENSE](LICENSE).
