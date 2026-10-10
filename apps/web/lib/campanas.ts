import type { CampaignChannel, CampaignPreview } from '@iaxti/sdk';

/**
 * Desconocido tampoco habilita un envío: primero se debe comprobar el número.
 *
 * ## Un canal desconectado NO es un impedimento (#772)
 *
 * Esto decía «hay un número de WhatsApp sin conexión» en cuanto CUALQUIER canal
 * de WhatsApp no estuviera `active`/`degraded`. Con el botón de desconectar
 * (#600), eso significaba que dar de baja un canal —un número quemado, uno que
 * el negocio dejó de usar— **bloqueaba todas las campañas, indefinidamente**, y
 * no había forma de salir desde el producto.
 *
 * Un canal desconectado es un canal que el negocio sacó de servicio a
 * propósito. Lo que importa es que quede AL MENOS UNO en servicio y sano; los
 * que están fuera no opinan.
 *
 * Los números archivados tampoco llegan más (la API los dejó de entregar), pero
 * la regla se escribe sobre los canales EN SERVICIO igual: si mañana vuelven a
 * llegar, esto no se rompe.
 */
export function impedimentoDeCampana(canales: CampaignChannel[] | null, previa: CampaignPreview | null): string | null {
  if (!previa) return 'Revisa primero el conteo y la muestra de destinatarios.';
  if (!canales) return 'No pudimos comprobar la calidad del número. Actualiza la vista previa.';
  const whatsapp = canales.filter((c) => c.kind === 'whatsapp');
  const enServicio = whatsapp.filter((c) => ['active', 'degraded'].includes(c.state));
  if (whatsapp.length > 0 && enServicio.length === 0) {
    return 'Tus canales de WhatsApp están sin conexión. Revisa Canales antes de enviar.';
  }
  const numeros = enServicio.flatMap((c) => c.numbers);
  if (!numeros.length) return 'Conecta un número de WhatsApp antes de enviar.';
  if (numeros.some((n) => n.quality === 'red')) return 'La calidad del número está en rojo. Recupera su calidad antes de enviar campañas.';
  if (numeros.some((n) => !n.quality)) return 'La calidad de un número todavía no está disponible. Actualiza antes de enviar.';
  if (numeros.some((n) => n.businessPausedAt)) return 'Los envíos del negocio están pausados. Revisa el número en Canales.';
  if (previa.total === 0) return 'El segmento no tiene destinatarios. Crea una campaña con otros filtros.';
  if (previa.total > 5000) return 'El segmento supera el máximo de 5.000 destinatarios. Reduce los filtros antes de enviar.';
  return null;
}

export function mismaVistaPrevia(a: CampaignPreview, b: CampaignPreview): boolean {
  return a.total === b.total && a.muestra.length === b.muestra.length &&
    a.muestra.every((persona, i) => persona.id === b.muestra[i].id);
}
