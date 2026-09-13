import './instrument';
import { createServer } from 'node:http';

const service = process.env.SERVICE ?? 'agents';
const port = Number(process.env.PORT ?? 3000);

// Stub de fundación: el procesamiento real de colas llega con el issue #47.
const server = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/ready') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Nada por aquí todavía.', requestId: '', details: [] }));
});

server.listen(port);
