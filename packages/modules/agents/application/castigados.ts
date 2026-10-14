import { enteroDeEntorno } from '@iaxti/core';
import type { Provider } from '../domain/config';
import type { MotivoDelProveedor } from './motivo-del-proveedor';

/**
 * El proveedor que acaba de fallar por algo que no se arregla reintentando
 * queda apartado un rato (#855).
 *
 * ## Qué costó
 *
 * `hayLlave` es `Boolean(process.env[ENV_KEYS[p]])`: «hay una variable con
 * algo adentro». No «el proveedor contesta». La noche del 11-10 google tenía
 * llave y estaba **sin saldo**, así que contaba como disponible, el respaldo
 * lo eligió, y **las ocho tareas de texto cayeron a un proveedor muerto**
 * mientras el diagnóstico mostraba `ia ✓` porque la credencial existe.
 *
 * El respaldo de #665 existe por una buena razón —«un proveedor sin credencial
 * en este ambiente tampoco puede hacer nada»— y la decisión de no sondearlo
 * antes de elegirlo también: una sonda por mensaje entrante le paga al
 * proveedor y suma latencia a la bandeja.
 *
 * Lo que faltaba era más barato: **recordar que acaba de fallar.** El producto
 * ya sabe distinguir la causa —`motivoDelProveedor` devuelve `sin_saldo` con
 * `reintentable: false`— y esa información se usaba para el mensaje y se tiraba.
 *
 * ## Por qué memoria del proceso y no Redis
 *
 * Redis sería compartido entre los tres procesos y sobreviviría a un reinicio,
 * y sería una dependencia nueva para este módulo, que hoy no usa ninguna.
 *
 * Lo que se pierde midiéndolo: con tres procesos, el primer fallo de cada uno
 * lo aprende por su cuenta — o sea hasta tres llamadas fallidas en vez de una
 * antes de que todos lo sepan. Y un reinicio olvida el castigo, así que se
 * vuelve a probar.
 *
 * Las dos consecuencias caen hacia el lado seguro: **reintentar un poco más
 * seguido**. Y la segunda es incluso correcta — un despliegue puede haber
 * agregado la llave que faltaba, así que empezar de cero es lo que uno quiere.
 * Equivocarse al revés —no reintentar nunca— dejaría a un negocio sin IA
 * después de que el dueño cargó crédito.
 */

/**
 * Cuánto dura el castigo.
 *
 * Cinco minutos, y el número sale de qué cuesta equivocarse en cada dirección.
 * Muy corto: se gasta una llamada fallida por proveedor cada ese rato, que es
 * nada. Muy largo: el dueño carga crédito y la IA sigue muerta sin que él
 * pueda hacer nada — y el mensaje de `sin_saldo` le promete exactamente lo
 * contrario, «el asistente vuelve solo; no hace falta tocar nada acá».
 *
 * Esa promesa es la que fija el techo.
 */
const MINUTOS = () => enteroDeEntorno('IA_CASTIGO_MINUTOS', 5);

/**
 * Los motivos que NO se arreglan reintentando, y por eso apartan.
 *
 * `cuota_agotada` y `no_contesto_a_tiempo` quedan afuera a propósito: son
 * `reintentable: true` y el siguiente intento puede andar. Apartar por un
 * límite de tasa sería tirar al proveedor bueno por estar ocupado.
 */
const NO_SE_ARREGLAN_REINTENTANDO = new Set<MotivoDelProveedor>([
  'sin_saldo',
  'sin_llave',
  'llave_invalida',
  'modelo_no_disponible',
]);

interface Castigo {
  motivo: MotivoDelProveedor;
  cuando: number;
}

const castigos = new Map<Provider, Castigo>();

/** El reloj, inyectable: una prueba no mide el reloj de la máquina. */
let ahora = () => Date.now();

/** Aparta al proveedor si el motivo no se arregla reintentando. */
export function castigar(
  provider: Provider,
  motivo: MotivoDelProveedor,
): boolean {
  if (!NO_SE_ARREGLAN_REINTENTANDO.has(motivo)) return false;
  castigos.set(provider, { motivo, cuando: ahora() });
  return true;
}

/**
 * Lo volvió a hacer bien: se le quita el castigo.
 *
 * Se llama en CADA éxito y no solo cuando hay castigo, porque el caso que
 * importa es justo el de la carrera: dos mensajes a la vez, uno falla y
 * castiga, el otro andaba y perdona. Que gane el que funcionó es lo correcto —
 * el castigo existe para no insistir con algo roto, no para castigar.
 */
export function perdonar(provider: Provider): void {
  castigos.delete(provider);
}

/** Si está apartado AHORA. Un castigo vencido no cuenta y se limpia. */
export function estaCastigado(provider: Provider): boolean {
  const c = castigos.get(provider);
  if (!c) return false;
  if (ahora() - c.cuando >= MINUTOS() * 60_000) {
    castigos.delete(provider);
    return false;
  }
  return true;
}

/** Quiénes están apartados y por qué, para que el diagnóstico lo diga. */
export function losCastigados(): Array<{ provider: Provider; motivo: MotivoDelProveedor }> {
  const vivos: Array<{ provider: Provider; motivo: MotivoDelProveedor }> = [];
  for (const [provider, c] of castigos) {
    if (estaCastigado(provider)) vivos.push({ provider, motivo: c.motivo });
  }
  return vivos;
}

/**
 * Borra todo. Para las pruebas, y no es un detalle de comodidad.
 *
 * Esto es estado de módulo, y el estado de módulo se filtra entre archivos de
 * prueba: ya pasó en este repo con `ultimoFallo`, donde una prueba falló
 * citando un host que su propio caso no usaba nunca. Sin esta función, la
 * primera prueba que castigue a un proveedor se lo deja castigado a todas las
 * que corran después en el mismo proceso.
 */
export function olvidarLosCastigos(reloj?: () => number): void {
  castigos.clear();
  ahora = reloj ?? (() => Date.now());
}
