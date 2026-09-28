/**
 * De quién fue el error (#684).
 *
 * `motivoDelProveedor` traduce el error DEL PROVEEDOR a algo que un dueño de
 * pyme pueda leer, y se estaba usando como clasificador de errores en general.
 * Nunca comprobaba de quién era el error que le pasaban, y clasifica por texto
 * con patrones sueltos. El resultado, medido el 27/09:
 *
 *   No tienes permiso para billing.read        -> «tu proveedor se quedó sin saldo»
 *   permission denied: crm.contacts.update     -> «el proveedor rechazó la llave»
 *   No encontramos ese contacto. (404)         -> «el modelo ya no está disponible»
 *   IA_QUOTA_EXHAUSTED (nuestro tope)          -> «cuota del proveedor»
 *
 * `billing` es un módulo, una ruta y un permiso NUESTROS, y está en las 195
 * herramientas del agente general. `permission denied` es nuestra autorización.
 * Un 404 es «no encontramos ese contacto».
 *
 * Y es peor que no explicar nada: el mensaje viene con tono de certeza y con una
 * instrucción concreta —«carga crédito en su panel»—, así que manda a revisar
 * una cuenta que está perfecta mientras el problema real queda invisible. Se
 * fueron horas de madrugada en eso, con la llave contestando 200 todo el tiempo.
 *
 * La marca se pone en UN solo lugar: el puerto del modelo, que es la única
 * puerta al proveedor. Lo que no pasa por ahí no es del proveedor y no se
 * clasifica.
 */

/**
 * El código HTTP, venga como venga en el error.
 *
 * Vive acá y no en `motivo-del-proveedor.ts` porque lo necesitan los dos, y
 * duplicarlo tuvo consecuencia inmediata: al envolver el error, el wrapper
 * copiaba solo el código de primer nivel y perdía el que algunos SDK dejan en
 * `response` o en `cause`. Una prueba que existía desde antes lo cazó.
 */
export function estadoDelProveedor(error: unknown): number | null {
  const valido = (v: unknown): number | null =>
    typeof v === 'number' && v >= 100 && v < 600 ? v : null;
  const e = error as Record<string, unknown> | null;
  for (const campo of ['statusCode', 'status', 'code']) {
    const v = valido(e?.[campo]);
    if (v !== null) return v;
  }
  for (const anidado of [e?.response, e?.cause]) {
    const n = anidado as Record<string, unknown> | undefined;
    if (!n) continue;
    for (const campo of ['statusCode', 'status']) {
      const v = valido(n[campo]);
      if (v !== null) return v;
    }
    // Un nivel más: el wrapper deja el original en `cause`, y el original puede
    // traerlo en su propio `response`.
    const mas = n.response as Record<string, unknown> | undefined;
    if (mas) {
      for (const campo of ['statusCode', 'status']) {
        const v = valido(mas[campo]);
        if (v !== null) return v;
      }
    }
  }
  return null;
}

/** Lo que falló del otro lado: el proveedor de IA. */
export class FalloDelProveedor extends Error {
  readonly delProveedor = true as const;
  readonly status: number | null;
  readonly responseBody: string | null;

  constructor(original: unknown) {
    const e = original as { message?: unknown; statusCode?: unknown; status?: unknown; responseBody?: unknown } | null;
    super(typeof e?.message === 'string' ? e.message : String(original));
    this.name = 'FalloDelProveedor';
    this.cause = original;
    this.status = estadoDelProveedor(original);
    this.responseBody = typeof e?.responseBody === 'string' ? e.responseBody : null;
  }

  /** No envolver dos veces: la segunda perdería el status de la primera. */
  static de(original: unknown): FalloDelProveedor {
    return original instanceof FalloDelProveedor ? original : new FalloDelProveedor(original);
  }
}

/**
 * Lo que falló de este lado: una herramienta.
 *
 * Existe por una trampa concreta: el AI SDK **ejecuta las tools dentro** de la
 * llamada al modelo, así que un error de una tool sale por el mismo `await` que
 * un error del proveedor. Sin distinguirlos, envolver ahí marcaría como «del
 * proveedor» justo los errores que provocaron este issue.
 */
export class FalloDeHerramienta extends Error {
  readonly deHerramienta = true as const;

  constructor(
    readonly herramienta: string,
    original: unknown,
  ) {
    super(
      typeof (original as { message?: unknown })?.message === 'string'
        ? (original as { message: string }).message
        : String(original),
    );
    this.name = 'FalloDeHerramienta';
    this.cause = original;
  }
}

/** Si esto vino del proveedor, con la marca puesta en el puerto del modelo. */
export function esDelProveedor(error: unknown): error is FalloDelProveedor {
  if (error instanceof FalloDelProveedor) return true;
  // La marca sobrevive a un `structuredClone` o a cruzar un `cause`: el SDK a
  // veces reenvuelve, y perder la marca es volver al genérico.
  return (error as { delProveedor?: unknown } | null)?.delProveedor === true;
}

/** Si esto fue una herramienta nuestra, que NO es el proveedor. */
export function esDeHerramienta(error: unknown): error is FalloDeHerramienta {
  if (error instanceof FalloDeHerramienta) return true;
  return (error as { deHerramienta?: unknown } | null)?.deHerramienta === true;
}
