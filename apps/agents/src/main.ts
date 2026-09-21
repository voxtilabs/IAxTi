import './instrument';
import { createServer } from 'node:http';
import { consumerReadiness, enteroDeEntorno } from '@iaxti/core';

const service = process.env.SERVICE ?? 'agents';
const port = enteroDeEntorno('PORT', 3000);

// Stub de fundación: el procesamiento real de colas llega con el issue #47.
// Igual que en workers: `/health` es "el proceso vive" y `/ready` es
// "puede trabajar", que para un consumidor de colas significa Redis (#17).
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service }));
    return;
  }
  if (req.url === '/ready') {
    void consumerReadiness('agents').then(result => {
      res.writeHead(result.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result.body));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Nada por aquí todavía.', requestId: '', details: [] }));
});

server.listen(port);
