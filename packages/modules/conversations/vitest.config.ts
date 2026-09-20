import { defineConfig } from 'vitest/config';

// #363: los fixtures conceden permisos al mismo rol iaxti_app sobre public
// y tablas compartidas. GRANT paralelo puede fallar con «tuple concurrently
// updated» antes de ejecutar los casos. Turbo serializa paquetes; esta
// opción serializa sus archivos, igual que audit, billing y db.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
