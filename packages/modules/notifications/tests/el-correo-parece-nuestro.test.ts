import { describe, expect, it } from 'vitest';
import { renderEmail } from '../application/email';

/**
 * El correo que mandamos (#1258).
 *
 * Antes eran cuatro líneas con estilos sueltos y un enlace azul del
 * navegador. Lo que se fija acá no es el gusto —eso cambia— sino las reglas
 * que vienen de cómo funcionan los clientes de correo, que son las que un
 * rediseño futuro podría romper sin notarlo.
 */
describe('la plantilla de correo (#1258)', () => {
  const base = { title: 'Te invitaron a IAxTi', body: 'Entra cuando quieras.', link: '/invitaciones' };

  /**
   * Gmail borra `<style>`, Outlook usa el motor de Word y los dos bloquean
   * imágenes por omisión. Un correo que dependa de cualquiera de esas tres
   * cosas llega roto y nadie se entera, porque quien lo manda lo ve bien.
   */
  it('no depende de nada externo: ni hoja de estilos, ni fuente, ni imagen', () => {
    const { html } = renderEmail(base);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/i);
  });

  it('siempre sale con versión en texto', () => {
    const r = renderEmail(base);
    expect(r.text).toContain('Te invitaron a IAxTi');
    expect(r.text).toContain('Entra cuando quieras.');
    expect(r.text.trim().length).toBeGreaterThan(20);
  });

  /**
   * A quien todavía no tiene cuenta, «elige qué avisos recibir en Ajustes» no
   * le dice nada: no tiene Ajustes. Lo que necesita es saber de dónde salió
   * ese correo.
   */
  it('el pie cambia según a quién se le escribe', () => {
    expect(renderEmail({ ...base, destinatario: 'usuario' }).html).toContain('Ajustes');
    const invitado = renderEmail({ ...base, destinatario: 'invitado' }).html;
    expect(invitado).not.toContain('Ajustes');
    expect(invitado).toContain('Si no lo esperabas');
  });

  /**
   * El enlace del alta de WhatsApp vive en Zavu, no en nuestra aplicación:
   * pegarle la base de IAxTi delante lo rompería. Esta prueba existe porque
   * el comportamiento por omisión —concatenar— es justamente el equivocado
   * para ese caso.
   */
  it('un enlace absoluto no se le pega la base de la aplicación', () => {
    const r = renderEmail({
      title: 'Conecta tu WhatsApp',
      enlaceAbsoluto: 'https://dashboard.zavu.dev/invite/abc123',
      appUrl: 'https://app.iaxti.cl',
    });
    expect(r.html).toContain('https://dashboard.zavu.dev/invite/abc123');
    expect(r.html).not.toContain('https://app.iaxti.clhttps://');
    expect(r.text).toContain('https://dashboard.zavu.dev/invite/abc123');
  });

  /** Un `&` en el nombre de un negocio no puede romper el HTML del correo. */
  it('escapa lo que viene del negocio', () => {
    const r = renderEmail({ title: 'Ferretería "El Clavo" & Cía <b>', body: '1 < 2' });
    expect(r.html).toContain('&amp;');
    expect(r.html).toContain('&lt;b&gt;');
    expect(r.html).not.toContain('<b>');
  });

  /**
   * Varios clientes en modo oscuro invierten lo que no tiene color
   * declarado, y un texto sin color termina blanco sobre blanco. Todo texto
   * lleva el suyo.
   */
  it('declara color en el texto, para que el modo oscuro no lo invente', () => {
    const { html } = renderEmail(base);
    const parrafos = html.match(/<p [^>]*>/g) ?? [];
    expect(parrafos.length).toBeGreaterThan(0);
    for (const p of parrafos) expect(p).toMatch(/color:#[0-9A-Fa-f]{6}/);
  });
});
