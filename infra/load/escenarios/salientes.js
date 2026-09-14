// #79 escenario 3: la "campaña" — salientes masivos por API.
// Con canal simulador el delivery es inline: mide API → DB → entrega.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://127.0.0.1:4010';
const TOKEN = __ENV.TOKEN;
const TENANT = __ENV.TENANT;
const CONVS = (__ENV.CONVS || '').split(','); // ids sembrados

export const options = {
  scenarios: {
    campania: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 20), // envíos por segundo
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.02'],
  },
};

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'X-Tenant-Id': TENANT,
  'Content-Type': 'application/json',
};

export default function () {
  const conv = CONVS[Math.floor(Math.random() * CONVS.length)];
  const r = http.post(
    `${BASE}/v1/conversations/${conv}/messages`,
    JSON.stringify({ body: `campaña k6 ${__ITER}` }),
    { headers },
  );
  check(r, { 'saliente 201': (x) => x.status === 201 });
  sleep(0.1);
}
