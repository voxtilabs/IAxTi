# identity → organizations · #901

Decisión: **`optional`**.

organizations pertenece al núcleo que siempre permanece activo. La lectura de nombre del negocio no exige inicializar organizations antes de identity: se usa después de migrar y arrancar el núcleo. organizations ya requiere identity; añadir la arista required inversa crearía un ciclo en registry y migraciones. Optional declara la lectura sin ese ciclo y no permite apagar organizations: la regla del núcleo lo sigue prohibiendo.

## Evidencia de código

- `packages/modules/identity/application/invitations.ts:128` — tenantsOf une pertenencias con nombre del tenant.
- `packages/modules/organizations/module.yaml:6` — organizations requiere identity.
- `packages/core/src/registry.ts:4` — organizations es núcleo.
- `packages/core/src/registry.ts:153` — disable rechaza el núcleo antes de mirar dependientes.

## Verificación

`packages/modules/identity/tests/dependencia-organizations.test.ts` carga los
manifiestos reales, conserva solo el consumidor, sus requeridos transitivos y
el núcleo, y ejerce la lectura o la protección que justifica la dependencia.
Compara el orden de registry con `topologicalOrder` y repite migraciones reales
para comprobar idempotencia. Se ejecuta con PostgreSQL real en una base aislada.

```sh
pnpm --filter @iaxti/module-identity test tests/dependencia-organizations.test.ts
pnpm --filter @iaxti/core test tests/registry.test.ts tests/consultas-entre-modulos.test.ts
node scripts/consultas-entre-modulos.mjs --escribir
node scripts/consultas-entre-modulos.mjs
```

La regeneración baja **22 → 21** desde la base de esta rama y elimina únicamente
`identity→organizations`. Cada uno de los nueve pares de #901 tiene su propio PR;
esta rama no completa por sí sola la issue.

Se verifica apagado lógico con esquema conservado, no desinstalación física ni proveedor externo. Las consultas usan PostgreSQL real con el rol de fixture; esta prueba no certifica RLS de producción. La lectura de pertenencias sin tenant con rol sin bypass es el alcance de #902; el fixture con propietario no la certifica.
