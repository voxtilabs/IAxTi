import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Un mensaje que no llegó se puede reintentar (#445).
 *
 * La recuperación existe entera desde #380: `retryOutboundDelivery` retoma
 * el MISMO pedido sin crear otro mensaje, y su endpoint tiene permisos y
 * conflicto bien manejados. No la llamaba nadie — la bandeja mostraba el
 * ícono rojo y ninguna acción, y la única salida era escribir otro mensaje
 * a mano, que duplica si el original sí había salido.
 */
const CHAT = readFileSync(join(__dirname, '..', 'components', 'bandeja', 'chat.tsx'), 'utf8');
const BANDEJA = readFileSync(join(__dirname, '..', 'components', 'bandeja', 'bandeja.tsx'), 'utf8');

describe('el saliente que falló', () => {
  it('ofrece reintentar, y solo cuando falló', () => {
    expect(CHAT).toMatch(/deliveryStatus === 'failed'/);
    expect(CHAT).toContain('Reintentar');
    // En un mensaje entregado no hay nada que reintentar: el botón siempre
    // visible convierte una acción de rescate en ruido.
    expect(CHAT).toMatch(/m\.direction === 'out' && m\.deliveryStatus === 'failed'/);
  });

  it('llama a la recuperación, no manda otro mensaje', () => {
    // Mandar uno nuevo duplicaría cuando el original sí había salido y lo
    // que falló fue el aviso de entrega.
    expect(BANDEJA).toContain('retry-delivery');
    expect(BANDEJA).not.toMatch(/retry-delivery[\s\S]{0,200}body: JSON\.stringify\(\{ body/);
  });

  it('no se puede pedir dos veces el mismo', () => {
    expect(BANDEJA).toMatch(/setReintentando\(messageId\)/);
    expect(CHAT).toMatch(/disabled=\{reintentando === m\.id\}/);
  });

  it('después de reintentar se recarga: el estado lo decide el despacho', () => {
    expect(BANDEJA).toMatch(/retry-delivery[\s\S]{0,400}cargarConversacion\(seleccion\)/);
  });
});
