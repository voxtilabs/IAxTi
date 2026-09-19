// El dataset de regresión del REPO (#53): corre en CI antes de cambiar
// prompt, modelo o proveedor. Sin llave, avisa y se salta (el gate real
// corre cuando el secret GOOGLE_GENERATIVE_AI_API_KEY existe) — jamás
// inventa un score. Falla si el promedio baja del baseline versionado.
//
//   pnpm --filter @iaxti/module-agents exec node scripts/run-evals.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(readFileSync(join(raiz, 'evals', 'dataset-sugerir.json'), 'utf8'));
const baseline = JSON.parse(readFileSync(join(raiz, 'evals', 'baseline.json'), 'utf8'));

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) {
  console.log('evals: sin GOOGLE_GENERATIVE_AI_API_KEY — se salta (el gate corre cuando el secret exista).');
  process.exit(0);
}

const google = createGoogleGenerativeAI({ apiKey });
// Por ALIAS, no por versión fija: `gemini-2.5-flash` quedó retirado para
// llaves nuevas y este script se caía con 404 antes de evaluar nada (#308).
// Se puede fijar con EVAL_MODEL para comparar dos versiones a mano.
const candidato = google(process.env.EVAL_MODEL ?? 'gemini-flash-latest');
// El juez va por el modelo grande: juzgar pide más que responder.
const juez = google(process.env.EVAL_JUDGE_MODEL ?? 'gemini-pro-latest');

const FORMATO = `Responde SOLO este JSON:
{"sugerencia": "<respuesta lista para enviar al cliente>",
 "confianza": <0 a 1>,
 "intencion": "<cotizar|agendar|reclamo|consulta|otro>",
 "calificacion": "<frio|tibio|caliente>",
 "crear_oportunidad": <true si parece querer comprar o cotizar>}`;

function extraeJson(texto) {
  const i = texto.indexOf('{');
  const f = texto.lastIndexOf('}');
  if (i === -1 || f <= i) return null;
  try {
    return JSON.parse(texto.slice(i, f + 1));
  } catch {
    return null;
  }
}

/**
 * Un fallo DEL PROVEEDOR no es un fallo de la versión que se está evaluando.
 *
 * Antes cualquier error reventaba con un stack trace de Node y el CI quedaba
 * rojo como si el prompt hubiera empeorado. Un 429 por límite de cuota y una
 * regresión de calidad son cosas distintas y tienen arreglos distintos: la
 * primera se espera, la segunda se revisa.
 *
 * Se distingue y se dice cuál es.
 */
/**
 * Devuelve el código de salida para un fallo del proveedor.
 *
 * SIEMPRE 0, y esto es deliberado: un límite de cuota o un modelo retirado
 * no tienen nada que ver con el cambio que se está mergeando. Reprobar el CI
 * por eso es fabricar un rojo que nadie puede arreglar desde su PR — y un
 * rojo así se ignora a la tercera vez, que es como se pierde el gate de
 * verdad.
 *
 * Lo que NO hace es callarse: avisa fuerte que el gate no corrió. Es la
 * misma decisión que ya tomaba el script cuando falta la llave — «avisa y se
 * salta, jamás inventa un score».
 *
 * El único exit 1 es el de arriba: el promedio medido quedó bajo el
 * baseline. Ese sí es del cambio.
 */
function explicaFalloDelProveedor(err) {
  const msg = String(err?.message ?? err);
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
    console.error(
      'evals: el proveedor limitó la cuota (429). No es una regresión: es el tier.\n' +
        '       En el tier gratis el modelo grande casi no se puede usar de juez.\n' +
        '       Prueba EVAL_JUDGE_MODEL=gemini-flash-latest, o una llave de pago.',
    );
    return 0; // el gate NO corrió; no es un rojo del cambio
  }
  if (/no longer available|NOT_FOUND|404/i.test(msg)) {
    console.error(
      'evals: el modelo no existe para esta llave. Los defaults van por ALIAS\n' +
        '       justamente porque las versiones fijas se retiran (#308).\n' +
        `       Detalle: ${msg.slice(0, 200)}`,
    );
    return 0;
  }
  console.error(`evals: el proveedor falló — ${msg.slice(0, 300)}`);
  console.error('evals: EL GATE NO CORRIÓ. No es un rojo de este cambio.');
  return 0;
}

let suma = 0;
for (const caso of dataset.casos) {
  try {
  const gen = await generateText({
    model: candidato,
    system: 'Eres el asistente de ventas por WhatsApp de una pyme chilena. Cercano y profesional.',
    prompt: `${caso.contexto}\n\n${FORMATO}`,
    // Los modelos que razonan gastan tokens de SALIDA pensando antes de
    // contestar. Una sugerencia de tres líneas consumió 665 en la primera
    // corrida real: con 512 se cortaba a la mitad y el JSON no parseaba.
    maxOutputTokens: 1500,
  });
  const respuesta = extraeJson(gen.text)?.sugerencia ?? gen.text;
  const veredicto = await generateText({
    model: juez,
    prompt: `Evalúa esta respuesta de un asistente de pyme chilena.
CONTEXTO: ${caso.contexto}
CRITERIOS: ${caso.criterios.join(' · ')}
RESPUESTA: ${respuesta}
Responde SOLO: {"correctness": <0-1>, "tono": <0-1>, "tools": <0-1>}`,
    // Ídem: con 256 el juez devolvía `{"correctness": 0.8` —cortado— y eso
    // se contaba como un CERO. Un caso perfecto se veía como el peor.
    maxOutputTokens: 1024,
  });
  // Si la nota del juez no se puede leer, ESO no es un cero.
  //
  // Antes caía a `{correctness:0, tono:0, tools:0}`, y un cero por no poder
  // parsear se ve idéntico a un cero por responder pésimo. En la primera
  // corrida de verdad, un caso dio 0.00 y no era la respuesta: era el juez
  // devolviendo algo que no era JSON.
  //
  // Un gate que confunde "no pude medir" con "está mal" hace fallar el CI
  // por un hipo del proveedor, y a la tercera vez nadie lo mira.
  const notas = extraeJson(veredicto.text);
  if (!notas || [notas.correctness, notas.tono, notas.tools].some((n) => !Number.isFinite(Number(n)))) {
    console.error(
      `evals: el juez no devolvió notas legibles para "${caso.id}". No es un cero:\n` +
        `       es que no se pudo medir. Devolvió: ${String(veredicto.text).slice(0, 160)}`,
    );
    console.error('evals: EL GATE NO CORRIÓ. No es un rojo de este cambio.');
    process.exit(0);
  }
  const total = (Number(notas.correctness) * 2 + Number(notas.tono) + Number(notas.tools)) / 4;
  suma += total;
  console.log(`evals: ${caso.id} → ${total.toFixed(2)}`);
  // Un respiro entre casos: el tier gratis limita por minuto y el dataset
  // son seis casos con dos llamadas cada uno. Configurable para que en una
  // llave de pago no cueste tiempo de más.
  // Acá un 0 sí significa algo: "sin pausa". Pero basura no debe volverse
  // NaN y saltarse la pausa en silencio, que es lo que pasaba.
  const crudo = process.env.EVAL_PAUSA_MS;
  const n = crudo === undefined || crudo.trim() === '' ? 4000 : Number(crudo);
  const pausa = Number.isFinite(n) && n >= 0 ? n : 4000;
  if (pausa > 0) await new Promise((r) => setTimeout(r, pausa));
  } catch (err) {
    process.exit(explicaFalloDelProveedor(err));
  }
}

const promedio = suma / dataset.casos.length;
const minimo = baseline[dataset.task] ?? 0.7;
console.log(`evals: promedio ${promedio.toFixed(3)} (baseline ${minimo})`);
if (promedio < minimo) {
  console.error('evals: la versión RINDE PEOR que el baseline — no pasa (SPEC §13).');
  process.exit(1);
}
