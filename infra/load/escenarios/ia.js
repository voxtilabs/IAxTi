// #79 escenario 4: el camino de IA en paralelo SIN modelo (sin llaves el
// endpoint corta claro): mide NUESTRO overhead — guards, cuota, DB. Con
// llaves reales, la latencia del proveedor domina.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://127.0.0.1:4010';
const TOKEN = __ENV.TOKEN;
const TENANT = __ENV.TENANT;
const AGENT = __ENV.AGENT;
const CONV = __ENV.CONV;

export const options = {
  scenarios: {
    ia: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '15s', target: Number(__ENV.VUS || 10) },
        { duration: '30s', target: Number(__ENV.VUS || 10) },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<250'],
    // Sin llaves, /run responde 503 a propósito: no cuenta como fallo.
    'checks{camino:run}': ['rate>0.99'],
  },
};

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'X-Tenant-Id': TENANT,
  'Content-Type': 'application/json',
};

export default function () {
  const run = http.post(
    `${BASE}/v1/agents/${AGENT}/run`,
    JSON.stringify({ task: 'sugerir', prompt: 'hola' }),
    { headers },
  );
  check(run, { 'run responde claro': (r) => r.status === 503 || r.status === 201 }, { camino: 'run' });

  http.get(`${BASE}/v1/conversations/${CONV}/analisis`, { headers });
  http.get(`${BASE}/v1/conversations/${CONV}/suggestion`, { headers });
  http.get(`${BASE}/v1/agents/usage`, { headers });
  sleep(Math.random() + 0.5);
}
