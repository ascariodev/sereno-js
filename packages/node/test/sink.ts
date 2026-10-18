import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SerenoEvent } from '@ascariodev/sereno-core';

export interface Sink {
  url: string;
  events: SerenoEvent[];
  stop: () => Promise<void>;
}

export async function startSink(): Promise<Sink> {
  const events: SerenoEvent[] = [];
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      events.push(...(JSON.parse(raw) as { events: SerenoEvent[] }).events);
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end('{"accepted":1}');
    });
  });
  const url = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

  return {
    url,
    events,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
