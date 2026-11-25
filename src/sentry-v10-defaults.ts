/**
 * Los valores por defecto del SDK de Sentry 10 que Sentry 11 cambió.
 *
 * Sentry 11 quitó `sendDefaultPii` y, sin `dataCollection`, recoge datos del
 * usuario e IP, cookies, cabeceras sin filtrar, cuerpos de petición y
 * respuesta, consultas de base de datos, mensajes de colas y entradas y
 * salidas de IA. Además pone `attachStacktrace: true` y manda los spans por
 * lotes (`traceLifecycle: 'stream'`) en vez de una transacción por carga.
 *
 * Aquí está la base de la v10 tal como la da la guía de migración
 * («If you want to keep the v10 default behavior»):
 * https://github.com/getsentry/sentry-javascript/blob/11.16.0/MIGRATION.md
 *
 * Los tipos son estructurales: el paquete no depende del SDK y el test de
 * tipos comprueba que encajan con los de `@sentry/core`.
 */

/** Cómo se recoge un grupo de claves (cabeceras, cookies, query). */
export type CollectBehavior = boolean | { allow: string[] } | { deny: string[] };

/** Los cuerpos HTTP que el SDK puede adjuntar. */
export type HttpBodyCollectionTarget =
  | 'incomingRequest'
  | 'outgoingRequest'
  | 'incomingResponse'
  | 'outgoingResponse';

/** El subconjunto de `dataCollection` de Sentry 11 que fija la base de la v10. */
export interface DataCollection {
  userInfo: boolean;
  cookies: CollectBehavior;
  httpHeaders: { request: CollectBehavior; response: CollectBehavior };
  httpBodies: HttpBodyCollectionTarget[];
  urlQueryParams: CollectBehavior;
  genAI: { inputs: boolean; outputs: boolean };
  databaseQueryData: boolean;
  queues: boolean;
  graphQL: { document: boolean; variables: boolean };
}

/** Claves de cabeceras y query que identifican a una persona, como las filtraba la v10. */
const IDENTIFICADORAS = (): CollectBehavior => ({ deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] });

/**
 * `dataCollection` con lo que recogía Sentry 10 sin `sendDefaultPii`. Es la
 * opción de privacidad: va en todo `Sentry.init` de la v11.
 */
export const SENTRY_V10_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: IDENTIFICADORAS(), response: IDENTIFICADORAS() },
  httpBodies: [],
  urlQueryParams: IDENTIFICADORAS(),
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
};

/**
 * Los tres valores por defecto de la v10 que cambiaron:
 *
 * - `dataCollection`: el de arriba.
 * - `attachStacktrace: false`: con `true`, cada `captureMessage` lleva pila,
 *   agrupa distinto y en el navegador marca la sesión como errónea.
 * - `traceLifecycle: 'static'`: una transacción por carga, como en la v10. El
 *   modelo por lotes cambia cuántos eventos de trazas se envían y deja las
 *   etiquetas del scope fuera de los spans. Sentry anuncia que el modo
 *   `static` se quitará en una major futura.
 *
 * Se esparce en `Sentry.init({ dsn, ...SENTRY_V10_DEFAULTS })`. Quien solo
 * quiera la parte de privacidad usa `SENTRY_V10_DATA_COLLECTION`.
 */
export const SENTRY_V10_DEFAULTS: {
  dataCollection: DataCollection;
  attachStacktrace: false;
  traceLifecycle: 'static';
} = {
  dataCollection: SENTRY_V10_DATA_COLLECTION,
  attachStacktrace: false,
  traceLifecycle: 'static',
};
