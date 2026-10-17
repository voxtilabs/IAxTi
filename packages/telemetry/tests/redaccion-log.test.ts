import { describe, expect, it } from 'vitest';
import { argumentoDeLog, textoDeLog } from '../src/redaccion-log';

describe('minimización del mismo sobre local y remoto (#17)', () => {
  it('redacta autorización, contraseña, parámetros y correo conservando diagnóstico', () => {
    const texto = textoDeLog('timeout Bearer credencial-ficticia password=clave-ficticia password="clave con espacios" https://user:pass@host.invalid/path?token=valor&email=ana@example.invalid ana@example.invalid +56 9 1234 5678');
    for (const secreto of ['credencial-ficticia','clave-ficticia','con espacios','user:pass','ana@example.invalid','valor','1234 5678']) expect(texto).not.toContain(secreto);
    expect(texto).toContain('timeout');
    expect(texto).toContain('/path?token=[REDACTADO]&email=[REDACTADO]');
  });
  it('recorre meta/cause sin enviar objetos sensibles ni ejecutar toJSON', () => {
    const texto = argumentoDeLog({ meta: { password: 'no-enviar', cause: { authorization: 'oculto', body: 'conversación' } }, toJSON: () => ({ secret: 'escape' }), code: 'TIMEOUT', requestId: 'req_17' });
    for (const secreto of ['no-enviar','oculto','conversación','escape']) expect(texto).not.toContain(secreto);
    expect(texto).toContain('TIMEOUT'); expect(texto).toContain('req_17');
  });
  it('acota profundidad, ciclos y longitud sin perder la línea', () => {
    const objeto: Record<string, unknown> = {}; objeto.yo = objeto;
    expect(argumentoDeLog(objeto)).toContain('CIRCULAR');
    expect(textoDeLog('a'.repeat(10000))).toHaveLength(8192);
    expect(textoDeLog('trace=0af7651916cd43dd8448eb211c80319c req_abc')).toContain('0af7651916cd43dd8448eb211c80319c');
  });
  it('omite cuerpos HTTP/LLM anidados y conserva status, code y requestId', () => {
    const texto = argumentoDeLog({ code: 'ERR_BAD_RESPONSE', requestId: 'req_17',
      config: { method: 'post', data: JSON.stringify({ messages: [{ content: 'mensaje privado sin patrón PII' }] }), headers: { Authorization: 'Bearer clave' } },
      request: { raw: 'solicitud privada' }, response: { status: 502, data: 'respuesta privada', headers: { 'x-customer': 'nombre privado' } },
      meta: { cause: { payload: { prompt: 'prompt privado' } } },
    });
    for (const privado of ['mensaje privado','solicitud privada','respuesta privada','nombre privado','prompt privado','Bearer clave']) expect(texto).not.toContain(privado);
    expect(texto).toContain('502'); expect(texto).toContain('ERR_BAD_RESPONSE'); expect(texto).toContain('req_17');
  });
});
