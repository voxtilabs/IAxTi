import { defineConfig } from 'vitest/config';

// Las suites de billing manejan el barrido diario, que trabaja sobre TODA la
// tabla de tenants: es un barrido de plataforma, no de un tenant. Dos
// archivos corriendo a la vez se comen los tenants del otro —y las cuentas
// del otro— exactamente como pasaba con el despachador del outbox (#207).
//
// En serie, cada archivo ve el mundo que él preparó.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
