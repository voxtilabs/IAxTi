import type { CampaignChannel, CampaignPreview } from '@iaxti/sdk';

/** Desconocido tampoco habilita un envío: primero se debe comprobar el número. */
export function impedimentoDeCampana(canales: CampaignChannel[] | null, previa: CampaignPreview | null): string | null {
  if (!previa) return 'Revisa primero el conteo y la muestra de destinatarios.';
  if (!canales) return 'No pudimos comprobar la calidad del número. Actualiza la vista previa.';
  const whatsapp = canales.filter((c) => c.kind === 'whatsapp');
  const numeros = whatsapp.flatMap((c) => c.numbers);
  if (!numeros.length) return 'Conecta un número de WhatsApp antes de enviar.';
  if (numeros.some((n) => n.quality === 'red')) return 'La calidad del número está en rojo. Recupera su calidad antes de enviar campañas.';
  if (numeros.some((n) => !n.quality)) return 'La calidad de un número todavía no está disponible. Actualiza antes de enviar.';
  if (numeros.some((n) => n.businessPausedAt)) return 'Los envíos del negocio están pausados. Revisa el número en Canales.';
  if (whatsapp.some((c) => !['active', 'degraded'].includes(c.state))) return 'Hay un número de WhatsApp sin conexión. Revisa Canales antes de enviar.';
  if (previa.total === 0) return 'El segmento no tiene destinatarios. Crea una campaña con otros filtros.';
  if (previa.total > 5000) return 'El segmento supera el máximo de 5.000 destinatarios. Reduce los filtros antes de enviar.';
  return null;
}

export function mismaVistaPrevia(a: CampaignPreview, b: CampaignPreview): boolean {
  return a.total === b.total && a.muestra.length === b.muestra.length &&
    a.muestra.every((persona, i) => persona.id === b.muestra[i].id);
}
