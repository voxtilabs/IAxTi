import { defineConfig } from 'vitest/config';

// Seis de sus archivos conceden permisos al MISMO rol `iaxti_app` en su
// fixture. Dos GRANT en paralelo sobre el mismo rol chocan en Postgres con
// «tuple concurrently updated» (XX000, `simple_heap_update`), y el archivo
// se cae antes de correr un solo caso: el error no se parece en nada a la
// causa y aparece y desaparece según la máquina.
//
// Lo mismo que ya hacen conversations, audit, billing y db (#363). Turbo
// serializa paquetes; esto serializa los archivos de este.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
