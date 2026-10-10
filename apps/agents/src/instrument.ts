// SIEMPRE la primera importación del entrypoint (ver apps/api/src/instrument.ts).
import { initObservability } from '@iaxti/telemetry';

// `?? ` no atrapa la cadena vacía (#575): con SERVICE declarada sin valor
// el servicio se reportaba a OTel con el nombre vacío y las trazas no se
// podían filtrar por servicio. Acá no se importa el ayudante de `core`
// porque este archivo corre ANTES de todo, a propósito.
initObservability(process.env.SERVICE?.trim() || 'agents');
