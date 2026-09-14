// #79 escenario 2: ráfaga de webhooks entrantes firmados (simulador).
// El criterio del webhook es responder < 1 s SIEMPRE: verifica y encola.
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';

const BASE = __ENV.BASE || 'http://127.0.0.1:4010';
const ACCOUNT = __ENV.ACCOUNT; // channel_account del simulador
const SECRET = __ENV.WEBHOOK_SECRET;

export const options = {
  scenarios: {
    rafaga: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50), // entrantes por segundo
      timeUnit: '1s',
      duration: '45s',
      preAllocatedVUs: 30,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const wamid = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const body = JSON.stringify({
    messages: [
      {
        id: wamid,
        phone: `+5699${String(__VU).padStart(3, '0')}${String(__ITER % 10000).padStart(4, '0')}`,
        body: `mensaje de carga ${__ITER}`,
      },
    ],
  });
  const firma = crypto.hmac('sha256', SECRET, body, 'hex');
  const r = http.post(`${BASE}/webhooks/channels/${ACCOUNT}`, body, {
    headers: { 'Content-Type': 'application/json', 'X-Iaxti-Signature': firma },
  });
  check(r, { 'webhook 2xx': (x) => x.status >= 200 && x.status < 300 });
}
