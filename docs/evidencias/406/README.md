# #406 · login ajustado a la altura

Capturas antes/después con Playwright sobre navegador real, viewport exacto
(sin `fullPage`), densidad 1 y movimiento reducido. El antes corresponde a
staging `a40ab4d`; el después al build standalone de esta rama.

- `before.json`: alturas originales de web/admin en seis tamaños.
- `after.json`: web/admin × día/noche × diez tamaños × cuatro estados.
- `comparacion-360.png`: móvil a escala 1:1, antes y después.
- `comparacion-1366.png`: notebook, ambos lados a escala 0,5.
- `after-*.png`: capturas sin escalar, incluidas noche, admin y código vencido.

El login inicial cabe completo en los diez tamaños. Los cuatro estados caben
en los nueve tamaños de 600 px de alto o más; a 844×390 los mensajes largos
permiten scroll, conservando todos los controles. No se oculta el overflow
de la página. Correo y código son ficticios y las respuestas OTP se simulan.

Regresión persistente: `apps/web/e2e/pulso-vivo.spec.ts`, ejecutada por
`node apps/web/e2e/run-e2e.mjs` después del build y con PostgreSQL/Redis locales.
Comprueba también alturas cercanas a los cambios de distribución y el acceso
por teclado cuando el viewport se reduce a 360×320.

El informe visual completo se encuentra en `design-qa.md` en la raíz.
