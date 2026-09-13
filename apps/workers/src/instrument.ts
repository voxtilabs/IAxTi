// SIEMPRE la primera importación del entrypoint (ver apps/api/src/instrument.ts).
import { initObservability } from '@iaxti/telemetry';

initObservability(process.env.SERVICE ?? 'workers');
