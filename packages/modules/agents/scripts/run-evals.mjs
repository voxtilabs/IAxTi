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
const candidato = google(process.env.EVAL_MODEL ?? 'gemini-2.5-flash');
const juez = google(process.env.EVAL_JUDGE_MODEL ?? 'gemini-2.5-pro');

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

let suma = 0;
for (const caso of dataset.casos) {
  const gen = await generateText({
    model: candidato,
    system: 'Eres el asistente de ventas por WhatsApp de una pyme chilena. Cercano y profesional.',
    prompt: `${caso.contexto}\n\n${FORMATO}`,
    maxOutputTokens: 512,
  });
  const respuesta = extraeJson(gen.text)?.sugerencia ?? gen.text;
  const veredicto = await generateText({
    model: juez,
    prompt: `Evalúa esta respuesta de un asistente de pyme chilena.
CONTEXTO: ${caso.contexto}
CRITERIOS: ${caso.criterios.join(' · ')}
RESPUESTA: ${respuesta}
Responde SOLO: {"correctness": <0-1>, "tono": <0-1>, "tools": <0-1>}`,
    maxOutputTokens: 256,
  });
  const notas = extraeJson(veredicto.text) ?? { correctness: 0, tono: 0, tools: 0 };
  const total = (Number(notas.correctness) * 2 + Number(notas.tono) + Number(notas.tools)) / 4;
  suma += total;
  console.log(`evals: ${caso.id} → ${total.toFixed(2)}`);
}

const promedio = suma / dataset.casos.length;
const minimo = baseline[dataset.task] ?? 0.7;
console.log(`evals: promedio ${promedio.toFixed(3)} (baseline ${minimo})`);
if (promedio < minimo) {
  console.error('evals: la versión RINDE PEOR que el baseline — no pasa (SPEC §13).');
  process.exit(1);
}
