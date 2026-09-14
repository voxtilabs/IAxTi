// Variables de los quick replies (SPEC §11): {nombre}, {monto}, lo que sea.
// Puro y tolerante: una variable sin valor queda visible para que quien
// escribe la note antes de enviar — nunca se envía "undefined".

const VARIABLE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export function renderQuickReply(body: string, vars: Record<string, string | null | undefined>): string {
  return body.replace(VARIABLE, (todo, nombre: string) => {
    const valor = vars[nombre];
    return valor === null || valor === undefined || valor === '' ? todo : valor;
  });
}

/** Las variables que usa un cuerpo, para pintarlas en el editor. */
export function quickReplyVariables(body: string): string[] {
  return [...new Set([...body.matchAll(VARIABLE)].map((m) => m[1]))];
}

/** Menciones @usuario en una nota: se extraen como texto; la UI resuelve ids. */
export function extractMentions(body: string): string[] {
  return [...new Set([...body.matchAll(/@([a-zA-Z0-9._-]+)/g)].map((m) => m[1]))];
}
