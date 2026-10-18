# Sereno for the browser

Sends errors and logs from web pages to a Sereno project channel. It posts events to the Sereno ingest endpoint
(`POST {url}/api/ingest/events`) with a public browser key. It captures uncaught errors and unhandled rejections on
its own, flushes when the page is hidden or left, and ships a plugin for Vue 3 and an error boundary for React.
Written in TypeScript, ESM and CommonJS for bundlers (Vite, webpack, Rollup, esbuild), no runtime dependencies besides
`@ascariodev/sereno-core`. There is no prebuilt `<script>` bundle.

## Requirements

- A browser with `fetch` (every current browser)
- Optional, only for the integration you use: `vue` >= 3, `react` >= 18 (with `@types/react` when you use TypeScript)

## Installation

```bash
npm install @ascariodev/sereno-browser
```

### The browser key

Create a project in Sereno, open its Integrations page, choose "Create log source" and pick the type **Browser**. List
the allowed origins: the exact origin your pages are served from, scheme and host plus the port when it is not the
default one, without path or trailing slash, for example `https://app.example.com`. Plain `http` is accepted only for
`localhost` and `127.0.0.1`, so in development add the origin of your dev server, for example `http://localhost:5173` (5173 is only Vite's default
port: the origin must match the port the dev server actually uses). The dialog shows the
key (`wsp_...`) only once; if you lose it, rotate the key.

A browser key is public: it ships in your JavaScript bundle and anyone can read it. What protects it is that Sereno
accepts it only from the listed origins (the `Origin` header the browser sends), at most 30 requests per minute per
IP and source and 120 per minute per source. Never put a server key (`wsk_...`) in front-end code: Sereno rejects a
server key sent with an `Origin` header (403), but the key is still exposed and anyone could use it from a server.

## Quick start

Call `init` once, as early as possible in your entry point:

```js
import { init, captureException, log } from '@ascariodev/sereno-browser';

init({
  url: 'https://your-sereno-api.example.com', // base URL of the Sereno API, without a path
  key: 'wsp_your_public_key',
});

log('warning', 'Checkout is slow', { step: 'payment' });

try {
  await submitOrder();
} catch (error) {
  captureException(error, { step: 'submit' });
}
```

`init` returns the client. Calling it again replaces the previous setup (the buffered events of the old one are sent
first). Without a URL or a key, or with options of the wrong type, `init` still returns a client, but it is inert:
nothing is buffered, no listener is installed and no request is made. Invalid options also print one notice in the
console (the key is never printed). The functions below do nothing before `init`.

Options (all optional):

| Option | Default | Description |
|---|---|---|
| `url`, `key` | none | Base URL of the API and the browser key. |
| `level` | `debug` | Minimum level sent: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`. An invalid value falls back to `debug`. |
| `keepalive` | `'unload'` | `'unload'` sends with `keepalive` only when the page is hidden or left; `'never'` never uses it. See Delivery behavior. |
| `handlers` | `true` | Set to `false` to not install the global listeners described below (and so not flush when the page is hidden). |
| `timeout` | `2` | Seconds per request, capped at `10`. |
| `retry` | `true` | Set to `false` to make a single attempt per batch. |

`InitOptions` inherits the client options `notifier`, `fetch`, `headers` and `fetchOptions`; they are described in the
README of `@ascariodev/sereno-core`.

Functions:

- `captureException(error, context?)`: buffers a thrown value at level `error`. An `Error` is sent with its class,
  message, location and stack; anything else is sent as `String(value)`. When the value is an `Error` the `exception`
  key of the context is reserved for it.
- `log(level, message, context?)`: buffers a record. To group repeated events pass `{ fingerprint: '...' }` in the
  context.
- `flush()`: sends what is buffered and resolves with `{ sent, failed, dropped }`. It never rejects.
- `close()`: removes the global listeners, sends what is buffered and leaves the SDK uninitialized.
- `getClient()`: the active client, or `undefined` before `init`.

### Environment variables

There is no `process.env` in the browser: pass the values from your bundler. With Vite, put them in `.env.local` (or
`.env.production`) with the `VITE_` prefix:

```bash
VITE_SERENO_URL=https://your-sereno-api.example.com
VITE_SERENO_KEY=wsp_your_public_key
```

```ts
init({ url: import.meta.env.VITE_SERENO_URL, key: import.meta.env.VITE_SERENO_KEY });
```

Vite also takes `VITE_*` variables from the environment of the process that runs it, which is handy in CI or Docker
instead of a `.env` file. Vite inlines them in the bundle at build time, which is fine for a `wsp_` key and the reason a `wsk_` key must never
be used here.

### What it captures on the page

Unless you pass `handlers: false`, `init` adds these listeners (with `addEventListener`, so handlers of your own keep
working):

- **Uncaught errors** (`error` on `window`): sent at level `error` with the exception. When the event carries no
  `Error` (for example `Script error.` from a cross-origin script), the message is sent with `file` (without query
  string), `line` and `column` in the context.
- **Unhandled rejections** (`unhandledrejection`): the rejection reason, at level `error`.
- **Page hidden or left** (`visibilitychange` to `hidden`, and `pagehide`): the buffer is flushed with `keepalive`
  (see Delivery behavior). Coming back (`visible`, or `pageshow` from the back-forward cache) returns to plain requests.

Errors in resources (images, scripts that fail to load) are not captured.

## Vue

```ts
// main.ts (Vite)
import { createApp } from 'vue';
import { init } from '@ascariodev/sereno-browser';
import { SerenoVue } from '@ascariodev/sereno-browser/vue';
import App from './App.vue';

init({ url: import.meta.env.VITE_SERENO_URL, key: import.meta.env.VITE_SERENO_KEY });

const app = createApp(App);
app.use(SerenoVue);
app.mount('#app');
```

`SerenoVue` chains `app.config.errorHandler`: it sends the error and then calls the handler that was there before.
The context carries `component` (the component `name`, or the file name for `<script setup>` components) and `info`
(Vue's hook description, such as `setup function`); never props or state.

- Options: `app.use(SerenoVue, { client })` sends to a client of your own, and `app.use(SerenoVue, { init: {...} })`
  calls `init` with those options. Without either, it uses the active client at the moment of each error, so `init`
  may run before or after `app.use`. With no client at all it does nothing.
- Without a previous handler the error is still printed with `console.error`, but Vue no longer prints its own
  `[Vue warn]: Unhandled error during execution of ...` notice in development, and does not rethrow the error.
- Set your own `app.config.errorHandler` before `app.use(SerenoVue)`: one set afterwards replaces Sereno's.

## React

```tsx
import { SerenoErrorBoundary } from '@ascariodev/sereno-browser/react';

<SerenoErrorBoundary
  fallback={({ reset }) => (
    <div>
      <p>Something went wrong.</p>
      <button onClick={reset}>Try again</button>
    </div>
  )}
>
  <Checkout />
</SerenoErrorBoundary>;
```

`SerenoErrorBoundary` catches render errors of its children, sends them with React's `componentStack` in the context
and renders `fallback`: a node (`fallback={<p>Oops</p>}`) or a function of `{ error, reset }`. `reset()` clears the
error and renders the children again. Without `fallback` it renders nothing after an error. Other props: `onError(error,
info)` is called after the error is sent (what it throws is ignored), and `client` sends to a client of your own instead
of the active one. Before `init` (or without `client`) the boundary sends nothing, but it still catches the error and
renders `fallback`. With TypeScript, install `@types/react`. Tested with React 19.3 (the `react` devDependency of this
package) and React 18.3.1 (`npm run test:react18`). In React 18 development builds, React also reports a render error
to `window` before the boundary does, so the same error arrives twice: once without `componentStack` (from the global
listeners) and once with it. The same happens with an error thrown by a `fallback`, which also sends the original
error. React 19 sends one event.

As with any React error boundary, errors in event handlers, timers and promises are not caught by it; the global
listeners above capture them.

## Events

Each record becomes an event with `id`, `level`, `message`, `occurred_at` (UTC), optional `context` and optional
`fingerprint`, formatted by `@ascariodev/sereno-core` with the same limits as the other Sereno SDKs: messages are cut at
8192 characters, context at 32 KB, strings in the context at 2048 characters (the React `componentStack` included) and
stack traces at 2000. When anything is cut, the context carries `_truncated: true`. Errors are grouped by class and
location (class and message when the stack has no location), or by the `fingerprint` you pass.

The URL of the page is added to the context as `url`, without query string or fragment, because they may carry tokens.
A `url` key in your own context wins. Do not put secrets in messages or contexts.

Stack traces of minified bundles point to the minified files; source maps are not applied.

## Delivery behavior

- **Deduplication.** The same error is sent once every 60 seconds; repeats within that window are dropped. Records are
  compared by the `fingerprint` of the context, or by the error class and location (class and message when the stack
  has no location), or else by level and message. It applies to everything: global capture, `captureException`, `log`
  and the Vue and React integrations, so an error that reaches two of them is sent once.
- **Page limit.** At most 100 events are accepted per `init` (normally one page load). Beyond that, records are
  dropped and one notice is printed with `console.error`.
- **Buffered and batched.** Records are buffered and sent in batches of at most 100 events, 1 second after the first
  one. Requests use plain `fetch` while the page is visible, so almost everything leaves before the page goes away.
- **Keepalive on the way out.** When the page is hidden or left, the flush uses `fetch` with `keepalive: true`, so the
  browser can finish the request after the page is gone. Browsers allow about 64 KB of keepalive bodies in flight per
  page; the SDK keeps them under 60,000 bytes: from a batch that does not fit it sends the first events that do and
  drops the rest, with one notice per dropped batch. Failures of these last requests are not reported. This was tested
  in Chrome. If it misbehaves in a browser, `keepalive: 'never'` sends the final flush as a plain request, which the
  browser may cancel when the page closes.
- **One retry, only on transient failures.** A network error, a timeout or a 5xx response is retried once with the
  same event ids, within a budget of 10 seconds. Any 4xx response (`401`, `413`, `422`, `429`) is not retried and its
  events are dropped. Redirects are not followed.
- **Never throws.** No function of the SDK throws or rejects into your code. If a batch is not delivered, a message
  with the status or error is written with `console.error` (never the key). What the SDK logs or triggers while it is
  sending is ignored, so a failure can never loop.

The keepalive budget is applied when a batch leaves the page during the exit, and the notice about cut events is
printed at that moment. A batch that exceeds the budget is cut: the leading events that fit are sent with keepalive,
the rest are dropped, and one notice reports how many. For `flush()`, a cut batch counts all its events as `sent` when
the request carrying the kept events succeeds, because the batch was delivered as a whole. A batch where no event fits
gets a 413 that the SDK creates itself: it is synthetic, no request leaves the page, and it counts as `failed`. The
`dropped` field of the result only counts events refused by the buffer limit, not the ones cut here. The flush started
on exit is not awaited by the SDK, so its result is seen only when you call `flush()` yourself.

## Troubleshooting

- **401 Unauthorized** (in the console as `Sereno log delivery failed: status=401`): Sereno answers the same 401 for
  every rejected key. Check, in this order: the page origin is listed exactly in the source (scheme, host and port,
  no trailing slash, `http://localhost:5173` is not `http://127.0.0.1:5173`); the key is the `wsp_` key of a
  **Browser** source, copied in full; the key was not rotated or revoked; the project is not archived. A server key
  (`wsk_`) is not what you want here: create a Browser source instead.
- **429 Too Many Requests**: more than 30 requests per minute from one IP to the same source, or too many rejected keys
  from that IP. The events of those batches are dropped.
- **Nothing in the console and nothing in Sereno**: check that `init` received a non-empty `url` and `key` (with Vite,
  that the variables have the `VITE_` prefix and the dev server was restarted after editing `.env.local`), and that
  the level of your records is not below `level`.

## License

MIT. See [LICENSE](LICENSE).
