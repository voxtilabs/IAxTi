// SIEMPRE la primera importación del entrypoint: en CJS este módulo corre
// completo antes del siguiente require, así la auto-instrumentación de OTel
// alcanza a parchar http/express/pg/ioredis antes de que Nest los cargue.
import { initObservability } from '@iaxti/telemetry';

initObservability('api');
