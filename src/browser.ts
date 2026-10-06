/**
 * Adaptador de navegador: contadores en `localStorage`, dos formas de usarlo.
 *
 * - `createBeforeSend()` para un producto que ya tiene `@sentry/browser`: se
 *   enchufa en `Sentry.init({ beforeSend })` y el SDK se encarga del envío.
 * - `createReporter()` para un producto que no quiere el SDK: manda el envelope
 *   a pelo con `fetch`, sin dependencias y sin tocar el tamaño del bundle.
 *
 * Ninguna de las dos lanza nunca. Un almacén bloqueado —modo privado, datos
 * borrados— deja el tope por carga, que es el que importa en una visita única.
 */

import {
  BROWSER_LIMITS,
  decide,
  emptyCounters,
  increment,
  parseCounters,
  utcDay,
  type Counters,
  type DropReason,
  type EventLike,
  type Limits,
} from './index.js';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrowserBudgetOptions {
  /** Prefijo de la clave en `localStorage`. Uno por producto. */
  key: string;
  limits?: Limits;
  /** `null` para no persistir. Por defecto, el `localStorage` de la ventana. */
  storage?: StorageLike | null;
  now?: () => number;
}

export interface BrowserBudget {
  /** `true` si cabe. Cuenta el evento cuando contesta `true`. */
  allow(event: EventLike): boolean;
  /** Por qué se descartó el último evento. `null` si el último se mandó. */
  lastDrop: DropReason | null;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Un navegador con las cookies de sitio bloqueadas lanza al tocar
    // localStorage, no devuelve undefined.
    return null;
  }
}

function read(storage: StorageLike | null, key: string, day: string): Counters | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return parseCounters(raw ? JSON.parse(raw) : null, day);
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, counters: Counters): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(counters));
  } catch {
    /* un almacén lleno o bloqueado no debe tumbar la página */
  }
}

/**
 * Crea un tope. Uno por carga de página: el contador por carga vive en el
 * cierre, así que recargar da cuota nueva por carga pero no por día.
 */
export function createBrowserBudget(options: BrowserBudgetOptions): BrowserBudget {
  const limits = options.limits ?? BROWSER_LIMITS;
  const now = options.now ?? Date.now;
  const storage = options.storage !== undefined ? options.storage : defaultStorage();
  let sentThisLoad = 0;

  const budget: BrowserBudget = {
    lastDrop: null,
    allow(event) {
      const day = utcDay(now());
      const counters = read(storage, options.key, day);
      const verdict = decide({ event, counters, sentThisLoad, limits });
      if (!verdict.send) {
        budget.lastDrop = verdict.reason;
        return false;
      }
      sentThisLoad += 1;
      budget.lastDrop = null;
      write(storage, options.key, increment(counters ?? emptyCounters(day), event));
      return true;
    },
  };
  return budget;
}

/** Lo que `@sentry/browser` le pasa a `beforeSend`, reducido a lo que se mira. */
export interface SentryEventLike {
  exception?: {
    values?: Array<{ type?: string; value?: string; stacktrace?: unknown }> | undefined;
  };
  message?: string | { formatted?: string } | undefined;
}

/** Traduce un evento del SDK a lo que entiende la política. */
export function fromSentryEvent(event: SentryEventLike): EventLike {
  const first = event.exception?.values?.[0];
  const message =
    typeof event.message === 'string' ? event.message : (event.message?.formatted ?? '');
  return {
    type: first?.type,
    message: first?.value ?? message,
    stack: first?.stacktrace ? JSON.stringify(first.stacktrace) : undefined,
  };
}

/**
 * `beforeSend` para `Sentry.init`. Devuelve `null` cuando no cabe, que es como
 * el SDK entiende «no lo mandes».
 *
 * `scrub` se aplica ANTES de decidir, para que lo que se guarda en los
 * contadores sea lo mismo que se habría enviado.
 */
export function createBeforeSend<T extends SentryEventLike>(
  options: BrowserBudgetOptions & { scrub?: (event: T) => T },
): (event: T) => T | null {
  const budget = createBrowserBudget(options);
  const scrub = options.scrub;
  return (event: T) => {
    const clean = scrub ? scrub(event) : event;
    return budget.allow(fromSentryEvent(clean)) ? clean : null;
  };
}

export interface ReporterOptions extends BrowserBudgetOptions {
  /** DSN del proyecto. Sin él no se manda nada, que es lo que quiere `dev`. */
  dsn: string | undefined;
  environment?: string;
  release?: string;
  /** Nombre del logger en Sentry. Por defecto, el prefijo de la clave. */
  logger?: string;
  pageUrl?: () => string;
  fetchImpl?: typeof fetch;
}

export type ReportResult =
  | { sent: true }
  | { sent: false; reason: DropReason | 'no_dsn' | 'invalid_dsn' };

interface Envelope {
  endpoint: string;
  body: string;
  headers: Record<string, string>;
}

function buildEnvelope(dsn: string, event: EventLike, options: ReporterOptions, nowMs: number): Envelope {
  const url = new URL(dsn);
  const projectId = url.pathname.replace(/^\/+/, '');
  if (!projectId || !url.username) throw new Error('DSN sin proyecto o sin clave');
  const eventId = (globalThis.crypto?.randomUUID?.() ?? String(nowMs)).replace(/-/g, '');
  const client = `djinnfoundry-sentry-budget/1.0.0`;

  const payload = {
    event_id: eventId,
    timestamp: nowMs / 1000,
    platform: 'javascript',
    level: 'error',
    logger: options.logger ?? options.key,
    environment: options.environment ?? 'production',
    ...(options.release ? { release: options.release } : {}),
    exception: {
      values: [
        {
          type: event.type ?? 'Error',
          value: event.message ?? 'unknown',
          ...(event.stack
            ? { stacktrace: { frames: [{ filename: event.stack.slice(0, 2000) }] } }
            : {}),
        },
      ],
    },
    request: { url: options.pageUrl?.() ?? '' },
  };

  const header = JSON.stringify({
    event_id: eventId,
    sent_at: new Date(nowMs).toISOString(),
    dsn,
  });
  return {
    endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
    body: `${header}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(payload)}\n`,
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${url.username}, sentry_client=${client}`,
    },
  };
}

/**
 * Reportero sin SDK: topa y manda el envelope con `fetch`.
 *
 * `keepalive` para que el envío sobreviva a la navegación que a veces provoca
 * el propio error. Un `fetch` que falla se traga en silencio: el error de
 * verdad ya le llegó al usuario y un segundo fallo no ayuda a nadie.
 */
export function createReporter(options: ReporterOptions): (event: EventLike) => ReportResult {
  const budget = createBrowserBudget(options);
  const now = options.now ?? Date.now;

  return (event: EventLike): ReportResult => {
    if (!options.dsn) return { sent: false, reason: 'no_dsn' };
    if (!budget.allow(event)) {
      return { sent: false, reason: budget.lastDrop ?? 'per_load' };
    }
    let envelope: Envelope;
    try {
      envelope = buildEnvelope(options.dsn, event, options, now());
    } catch {
      return { sent: false, reason: 'invalid_dsn' };
    }
    try {
      void (options.fetchImpl ?? fetch)(envelope.endpoint, {
        method: 'POST',
        headers: envelope.headers,
        body: envelope.body,
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      /* un transporte muerto no debe tumbar la página */
    }
    return { sent: true };
  };
}

export interface InstallOptions extends ReporterOptions {
  target?: Pick<Window, 'addEventListener'> & { location?: { href?: string } };
}

/**
 * Engancha los dos eventos que da un navegador. Llamar lo antes posible: un
 * error lanzado antes de esto se pierde.
 *
 * Devuelve el reportero para quien quiera reportar a mano, o `null` si no hay
 * DSN o no hay dónde enganchar.
 */
export function installErrorReporting(
  options: InstallOptions,
): ((event: EventLike) => ReportResult) | null {
  const target = options.target ?? (globalThis as unknown as InstallOptions['target']);
  if (!options.dsn || !target?.addEventListener) return null;

  const pageUrl = options.pageUrl ?? (() => target.location?.href ?? '');
  const report = createReporter({ ...options, pageUrl });

  target.addEventListener('error', (raw: Event) => {
    const event = raw as ErrorEvent;
    const error = event.error as Error | undefined;
    report({
      type: error?.name ?? 'Error',
      message: error?.message ?? event.message,
      stack: error?.stack,
    });
  });

  target.addEventListener('unhandledrejection', (raw: Event) => {
    const reason = (raw as PromiseRejectionEvent).reason;
    const error = reason instanceof Error ? reason : undefined;
    report({
      type: error?.name ?? 'UnhandledRejection',
      message: error?.message ?? String(reason),
      stack: error?.stack,
    });
  });

  return report;
}
