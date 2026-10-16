# @ascariodev/sereno-core

Shared core of the Sereno SDKs for JavaScript: the event formatter and the batching transport that talk to the Sereno
ingest endpoint (`POST {url}/api/ingest/events`). It has no runtime dependencies and uses the global `fetch`, so it runs in
Node.js 20+ and in the browser.

You normally do not install it directly: use `@ascariodev/sereno-node` (Node.js, Express, NestJS, Next.js) or
`@ascariodev/sereno-browser`, which depend on it. Use the core only to integrate by hand.

```bash
npm install @ascariodev/sereno-core
```

## API

- `formatEvent(record)`: turns `{ level, message, context?, time? }` into an ingest event (`id`, `level`, `message`,
  `occurred_at`, `context?`, `fingerprint?`). It applies the API limits (message 8192 characters, context 32 KB, depth 8,
  50 items per array) and serializes `Error` values found under the `exception` context key. It never throws.
- `new Client(options)`: buffers records and sends them in batches. Options: `url`, `key`, `level` (default `debug`),
  `timeout` (seconds, default 2, max 10), `retry` (default `true`), `notifier` (receives failure notices, default
  `console.error`), `fetch`, `headers`, `fetchOptions`. Methods: `log(record)`, `flush()` (resolves with `{ sent, failed,
  dropped }`, never rejects) and the `configured` flag. Without `url` and `key` it is inert.
- `new Transport(url, key, options?)`: sends one batch with `send(events)`, with one retry on network error, timeout or
  5xx within a 10 second budget. It resolves with `{ status: 'sent' | 'rejected' | 'error', ... }` and never rejects.

```js
import { Client } from '@ascariodev/sereno-core';

const client = new Client({ url: 'https://your-sereno-api.example.com', key: 'wsk_your_key' });

client.log({ level: 'error', message: 'Payment failed', context: { order_id: 42 } });
await client.flush();
```

Delivery rules (batches of 100, a 1 second flush timer, a buffer cap of 1000, one retry) are described in the
`@ascariodev/sereno-node` README.

## License

MIT. See [LICENSE](LICENSE).
