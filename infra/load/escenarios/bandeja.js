// #79 escenario 1: la bandeja bajo N usuarios concurrentes.
// Lista → abre conversación → responde (canal simulador).
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://127.0.0.1:4010';
const TOKEN = __ENV.TOKEN;
const TENANT = __ENV.TENANT;

export const options = {
  scenarios: {
    bandeja: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '20s', target: Number(__ENV.VUS || 20) },
        { duration: '40s', target: Number(__ENV.VUS || 20) },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_duration{tipo:lectura}': ['p(95)<300'],
    'http_req_duration{tipo:escritura}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'X-Tenant-Id': TENANT,
  'Content-Type': 'application/json',
};

export default function () {
  const lista = http.get(`${BASE}/v1/conversations?limit=20`, { headers, tags: { tipo: 'lectura' } });
  check(lista, { 'lista 200': (r) => r.status === 200 });
  const items = lista.json('items') || [];
  if (items.length === 0) return sleep(1);

  const conv = items[Math.floor(Math.random() * items.length)];
  const detalle = http.get(`${BASE}/v1/conversations/${conv.id}`, { headers, tags: { tipo: 'lectura' } });
  check(detalle, { 'detalle 200/404': (r) => r.status === 200 || r.status === 404 });
  http.get(`${BASE}/v1/conversations/${conv.id}/messages`, { headers, tags: { tipo: 'lectura' } });

  // 1 de cada 4 iteraciones responde (mezcla realista lectura/escritura).
  if (Math.random() < 0.25 && detalle.status === 200) {
    const r = http.post(
      `${BASE}/v1/conversations/${conv.id}/messages`,
      JSON.stringify({ body: `carga k6 ${Date.now()}` }),
      { headers, tags: { tipo: 'escritura' } },
    );
    check(r, { 'responder 201/4xx': (x) => x.status === 201 || x.status < 500 });
  }
  sleep(Math.random() * 2 + 0.5);
}
