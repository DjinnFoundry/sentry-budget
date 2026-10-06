/**
 * El tope de eventos de Sentry del estudio.
 *
 * Por qué existe este paquete y no una copia por repo: la organización de
 * Sentry de Djinn Foundry comparte **una** cuota mensual de errores entre todos
 * los productos y su plan no tiene límite por proyecto. El 2026-09-02 el Worker
 * de AudioKids mandó 4.895 eventos de una consulta que fallaba en cada
 * petición, agotó la cuota del mes el primer día, y durante treinta días
 * ninguno de los otros productos vio un solo error propio. Poner `rateLimit` en
 * la clave de cliente no sirve: es del plan Business.
 *
 * O sea: el tope es la única defensa real, tiene que estar en el código de cada
 * producto, y por tanto la política tiene que estar escrita una vez. Se escribió
 * tres veces (yukids, djinncom, audiokids) y en la tercera se repitió el mismo
 * error que la segunda ya documentaba en un comentario. De ahí el paquete.
 *
 * El contrato en prosa, con los números medidos, vive en el vault:
 * `Operations/Sentry.md`. Esto es su implementación.
 *
 * Aquí está solo la decisión, sin E/S: contar y decidir son puros, así que se
 * prueban sin navegador y sin Worker. La persistencia y el transporte van en
 * `./browser` y `./worker`.
 */

/** Los tres topes. Cada producto elige sus números; la forma no se negocia. */
export interface Limits {
  /** Eventos por carga de página o por isolate. Corta el bucle inmediato. */
  perLoad: number;
  /** Eventos por dispositivo (o colo) y día UTC. Acota el total. */
  perDay: number;
  /** Eventos del mismo issue y día. Un fallo repetido informa una vez. */
  perIssue: number;
}

/**
 * Topes por defecto para un frontal público.
 *
 * Son deliberadamente mezquinos: en el navegador el mismo fallo se dispara una
 * vez por visitante, y buena parte de lo que reporta un navegador no es nuestro.
 */
export const BROWSER_LIMITS: Limits = { perLoad: 3, perDay: 20, perIssue: 2 };

/**
 * Topes por defecto para un Worker.
 *
 * Más holgados que los del navegador porque un Worker no se multiplica por
 * visitante, pero el contador de la Cache API es **por colo**: el techo real es
 * `perDay` por colo, no global. Es un límite de verdad y no cuesta nada; un
 * contador exacto exigiría escribir en D1 desde el camino del error, que es
 * justo lo que falla cuando D1 es el problema.
 */
export const WORKER_LIMITS: Limits = { perLoad: 20, perDay: 60, perIssue: 5 };

/**
 * Ruido conocido, en dos listas porque el ámbito no es el mismo.
 *
 * `NOISE_MESSAGE` se compara con el mensaje a secas. Están anclados a propósito
 * —`Script error.` es el mensaje entero y nada más— y compararlos contra un
 * texto concatenado con el tipo y la pila no casaría nunca. Ese fallo estuvo en
 * dos de las tres copias anteriores y dejaba pasar el ruido de otro origen.
 *
 * `NOISE_ANYWHERE` se busca en todo el evento, pila incluida: el delito de una
 * extensión está en el nombre del fichero, no en el mensaje.
 */
export const NOISE_MESSAGE: readonly RegExp[] = [
  /^Script error\.?$/i,
  /^Load failed$/i,
  /^NetworkError/i,
  /^The operation was aborted/i,
  /^AbortError/i,
];

export const NOISE_ANYWHERE: readonly RegExp[] = [
  /ResizeObserver loop/i,
  /-extension:\/\//i,
];

/** Lo mínimo que hace falta saber de un evento para decidir. */
export interface EventLike {
  /** Tipo del error: `TypeError`, `Error`… Agrupa issues distintos. */
  type?: string | undefined;
  /** Mensaje del error. Lo que se compara con el ruido anclado. */
  message?: string | undefined;
  /** Pila o cualquier texto donde pueda verse el origen. */
  stack?: string | undefined;
}

/** Contadores de un día. `null` cuando no hay dónde guardarlos. */
export interface Counters {
  /** Día UTC al que pertenecen, en `YYYY-MM-DD`. */
  day: string;
  total: number;
  issues: Record<string, number>;
}

export type DropReason = 'noise' | 'per_load' | 'per_day' | 'per_issue';

export type Verdict = { send: true } | { send: false; reason: DropReason };

/** El día UTC de un instante. El tope es por día UTC en todos los productos. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** ¿Es ruido que no podemos arreglar y no merece cuota compartida? */
export function isKnownNoise(event: EventLike): boolean {
  const message = event.message ?? '';
  if (NOISE_MESSAGE.some((pattern) => pattern.test(message))) return true;
  const everything = `${event.type ?? ''} ${message} ${event.stack ?? ''}`;
  return NOISE_ANYWHERE.some((pattern) => pattern.test(everything));
}

/**
 * Clave estable del issue: tipo más mensaje con los números aplanados.
 *
 * Aplanar los dígitos es lo que hace que `timeout tras 3000 ms` y `timeout tras
 * 9000 ms` cuenten como un solo issue, que es el comportamiento que se quiere.
 *
 * OJO al escribir tests: por eso mismo `fallo 1` y `fallo 2` son el MISMO
 * issue, y un test que quiera agotar el tope diario con eventos distintos
 * necesita palabras, no números. Esto ha costado un rojo en dos repos.
 */
export function fingerprint(event: EventLike): string {
  const name = event.type || (event.message ? 'Message' : 'Error');
  const text = (event.message ?? '').slice(0, 120);
  return `${name}:${text}`.replace(/\d+/g, 'N').slice(0, 160);
}

export interface DecideInput {
  event: EventLike;
  /** Contadores del día, o `null` si no hay almacén legible. */
  counters: Counters | null;
  /** Cuántos se han mandado en esta carga o isolate. */
  sentThisLoad: number;
  limits: Limits;
}

/**
 * Decide si un evento se manda. Pura: no lee, no escribe, no envía.
 *
 * Sin contadores —`localStorage` bloqueado, Cache API caída— solo queda el tope
 * por carga. Ante la duda deja pasar: perder visibilidad es peor que pasarse un
 * evento, y el tope por carga ya acota el bucle inmediato, que es el que agota
 * una cuota en minutos.
 */
export function decide({ event, counters, sentThisLoad, limits }: DecideInput): Verdict {
  if (isKnownNoise(event)) return { send: false, reason: 'noise' };
  if (sentThisLoad >= limits.perLoad) return { send: false, reason: 'per_load' };
  if (counters) {
    if (counters.total >= limits.perDay) return { send: false, reason: 'per_day' };
    const used = counters.issues[fingerprint(event)] ?? 0;
    if (used >= limits.perIssue) return { send: false, reason: 'per_issue' };
  }
  return { send: true };
}

/** Suma uno a los contadores. Devuelve otros nuevos; no muta los de entrada. */
export function increment(counters: Counters, event: EventLike): Counters {
  const key = fingerprint(event);
  return {
    day: counters.day,
    total: counters.total + 1,
    issues: { ...counters.issues, [key]: (counters.issues[key] ?? 0) + 1 },
  };
}

/** Contadores a cero para un día. */
export function emptyCounters(day: string): Counters {
  return { day, total: 0, issues: {} };
}

/**
 * Normaliza lo que haya guardado un almacén. Devuelve contadores a cero si son
 * de otro día o si no se entienden: basura en el almacén no debe impedir
 * reportar.
 */
export function parseCounters(raw: unknown, day: string): Counters {
  if (!raw || typeof raw !== 'object') return emptyCounters(day);
  const value = raw as Partial<Counters>;
  if (value.day !== day) return emptyCounters(day);
  const issues =
    value.issues && typeof value.issues === 'object' ? (value.issues as Record<string, number>) : {};
  return { day, total: Number(value.total) || 0, issues };
}
