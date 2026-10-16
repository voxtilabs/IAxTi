# #64 · Drive personal: verificación local

Snapshot de producto: `eb79b7bdeae49e15848b4bba0538b268a65786e8`.
Base técnica Google Calendar: `11886265348c8880ebbc8619fd0d8cc58165f914` (#57),
con el ajuste de CI `cad386d`. Fundación OAuth compartida `786bcdf`, supresión
CRM `25c341f` y privacidad compartida del Agente General `b721565`, `422e519`,
`e7ed6db`. La rama contiene la dependencia #57; no debe presentarse como un
cambio independiente de ella.

## Criterios de la issue

| Criterio | Implementación y evidencia local |
| --- | --- |
| OAuth incremental personal, Secret Manager, scopes mínimos y revocación | Runner público identity compartido, intentos PKCE por servicio, `drive.file`, referencias a versiones de Secret Manager y revocación durable de todos los servicios. Suite Calendar preservada, incluidas carreras de reconexión y consumo de evento viejo. Google/GCP sustituidos en pruebas. |
| Adjuntar a conversación o ficha; `drive.search` y `drive.attach` | API JWT humana, SDK, Picker, fichas CRM/bandeja y herramientas reales del catálogo. Attach exige confirmación; no cambia ACL ni envía mensajes. SQL prueba propiedad personal, contexto, tenant e idempotencia. |
| Guardar recibidos por contacto si se activa | Opt-in separado, consumidor outbox, intención durable y job minutely `integrations.drive.sync`. IDs remotos persistidos antes de subir. Pruebas sin consentimiento, desactivación, reintento tras rollback, mensaje eliminado, backoff y supresión concurrente. |
| IA consulta documentos autorizados vía knowledge opcional | Permiso por documento y contexto personal, capability opcional, extracción de texto en memoria. Sin índices ni chunks compartidos. Página de cinco archivos, cuatro segundos, dos MiB por documento y 4.800 caracteres máximos. PDF/imágenes adjuntables, sin lectura IA; el límite es visible. |
| Accesos auditados y eventos connected/revoked | Auditoría por preparación de Picker, metadata, contenido, adjuntar y copias; eventos del consentimiento compartido. Mutaciones importantes y auditoría se confirman juntas. Los resultados personales no quedan en corridas/trazas/idempotencia del negocio. |

Los cinco criterios tienen recorrido de software implementado y pruebas locales;
**no equivale a aceptación con una cuenta Google real**. No se enviaron datos a
Google ni se probó IAM, facturación, publicación OAuth/Picker o configuración de
staging. El PR debe usar `Refs #64`, sin cierre automático de aceptación externa.

## Pruebas dirigidas

- Cliente Google HTTP: 59 pruebas (51 previas, ocho de Drive).
- Integrations Drive: 18 pruebas en PostgreSQL efímero con un rol real
  `NOSUPERUSER NOBYPASSRLS`; proveedores Google/Secret Manager sustituidos.
- UI/Pickers/privacidad/controles/guardas de rutas: 29 pruebas DOM.
- API Drive: siete pruebas; privacidad de idempotencia: una.
- Catálogo/ejecución: attach no ejecuta antes de confirmar y respeta permisos;
  solo las tres herramientas personales admitidas quedan fuera del bot autónomo.
- CRM: ocho regresiones de portabilidad/supresión, incluyendo evento durable.
- Navegador: dos pruebas a 360 CSS px, modos día/noche, con aplicación real y
  rutas Google/Picker sustituidas. Diez capturas adjuntas, inspeccionadas.

La suite E2E heredada usa el rol owner para montar la API y lo advierte como
`SIN AISLAMIENTO (e2e)`: **esas capturas no acreditan RLS**. RLS se comprueba en la
suite SQL de Drive, que crea su propia base y rol limitado y los elimina al final.

## Preflight final

El preflight de todo el monorepo (`TODO=1`) terminó con código cero sobre
`d39788e54852f119d5f6511118fb14f416b7c4d3`: 3.075 pruebas correctas y 14
omisiones existentes en 29 paquetes con pruebas. Turbo informó 54 tareas de
pruebas correctas (37 desde caché coherente). Las guardas se repitieron fuera
de caché: 52 de base de datos y 348 de core con diez omisiones, ya contabilizadas
en los totales. Las 105 migraciones pasaron sobre una base nueva. Typecheck:
56 tareas; build: 31. Lint: cero errores y cuatro advertencias previas fuera de
Drive. Depcruise y todas las guardas finales pasaron; catálogo generado limpio.

La corrida dirigida anterior también pasó: 2.250 pruebas y 14 omisiones en
12 paquetes, con 37 tareas de pruebas. Se conserva su registro por separado.
El revisor independiente repitió 18 pruebas SQL con rol limitado, siete de API
y dos de knowledge; no encontró bloqueos restantes en el software revisado.

Las bases de trinquetes no cambiaron: 194 exports sin consumidor, 18 columnas
sin lector, 22 cruces SQL inventariados, 32 listas pendientes y 109 avisos
pendientes. Ninguna excepción nueva oculta cambios de esta issue.

## Reproducir

Desde la raíz del repositorio con PostgreSQL y Redis exclusivos de pruebas:

```sh
pnpm install --frozen-lockfile
pnpm --filter @iaxti/google test
pnpm --filter @iaxti/module-integrations exec vitest run tests/drive.test.ts
pnpm --filter @iaxti/api exec vitest run tests/google-drive.test.ts tests/personal-idempotencia.test.ts
pnpm --filter @iaxti/web exec vitest run tests/google-drive.test.tsx tests/google-picker.test.ts tests/agente-general-personal.test.tsx
pnpm --filter @iaxti/module-agents exec vitest run tests/drive-tools.test.ts tests/tools-que-existen.test.ts tests/google-personal-context.test.ts
TODO=1 bash scripts/antes-de-empujar.sh
E2E_API_PORT=4031 E2E_WEB_PORT=4032 E2E_JWKS_PORT=4033 pnpm --filter @iaxti/web e2e google-drive
```

La corrida local usó PostgreSQL de pruebas en 55432, Redis 56379/12 y las bases
`iaxti_test_64`, `iaxti_test_64_release` y `iaxti_test_64_e2e`. No se recreó ni se
migró la base demo. El helper de entorno carga las URLs sin imprimir secretos.

## Correcciones verificables durante la revisión

La crítica independiente encontró búsqueda sin presupuesto total, un extractor
PDF que eludía la política de IA, supresión CRM no coordinada y el riesgo de
limpiar una reconexión mediante evento viejo. Se añadieron límites y abort,
extracción local de tipos admitidos, marca de supresión/locks/evento y lectura
del grant bajo el lock existente. No se rebajaron pruebas ni baselines.

La revisión compartida de Gmail encontró conservación de contenido personal en
corridas y trazas: sus tres commits se incorporaron y probaron también con
`drive.search`. La política de redacción de PII del tenant se aplica antes del
modelo; desactivar redacción no vuelve a habilitar persistencia del contenido.

Se conservan en el informe local los intentos fallidos: inventarios y catálogo
sin regenerar, una aserción E2E ambigua por texto de toast duplicado y una
aserción síncrona sobre un checkbox controlado que confirma tras la respuesta.
Las reparaciones declaran datos/rutas reales o usan selectores y esperas del
estado final; no aumentan timeouts ni relajan guardas.

## Checklist de revisión del repositorio

1. Fronteras por contratos públicos y capabilities; no imports internos cruzados.
2. Rutas con módulo, permisos, JWT humano y esquemas OpenAPI.
3. Mutaciones y auditoría en la misma transacción; errores auditados por runner.
4. Cuatro tablas propias con tenant, RLS forzada e índices.
5. Migraciones aditivas; consentimiento compartido y marca CRM versionados.
6. Regresiones SQL/API/DOM/HTTP y guardas de combinación de módulos.
7. Tools con identidad humana y permiso vigente; attach requiere confirmación.
8. No inicia mensajes ni correos; copia entrante exige opt-in por contacto.
9. No crea precios, stock, plazos ni compromisos; lectura de contenido acotada.
10. Componentes/tokens Pulso compartidos, sin nuevos efectos locales ni hex.
11. Capturas día/noche360, teclado y foco visible; sin scroll horizontal.
12. Sin credenciales reales en código, capturas o documentación; token GIS solo en memoria.
13. ADR-0027 extendida en la fundación; inventario, compliance y configuración documentados.
14. Commits conventional y referencia #64; publicación/revisión final a cargo del coordinador.
