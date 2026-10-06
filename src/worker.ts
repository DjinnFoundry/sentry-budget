/**
 * Adaptador de Cloudflare Workers: contadores en la Cache API, envío en
 * `waitUntil`.
 *
 * La Cache API persiste entre isolates pero es **de cada colo**, así que el
 * techo real es `perDay` por colo y no `perDay` global. Es un límite de verdad
 * y no cuesta nada. Un contador exacto exigiría D1, y escribir en D1 desde el
 * camino del error es justo lo que falla cuando D1 es el problema.
 *
 * Nunca lanza y nunca retrasa la respuesta: el POST va en `ctx.waitUntil`.
 */

import {
  WORKER_LIMITS,
  decide,
  fingerprint,
  isKnownNoise,
  utcDay,
  type DropReason,
  type EventLike,
  type Limits,
} from './index.js';

/** Lo que se usa de la Cache API, para poder probarlo sin un colo. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface WorkerReporterOptions {
  /** DSN del proyecto. Sin él no se manda nada: eso quiere `dev` y los tests. */
  dsn: string | undefined;
  /** Nombre del producto. Va al origen de las claves y al `logger` de Sentry. */
  name: string;
  environment?: string | undefined;
  release?: string | undefined;
  limits?: Limits;
  /** `null` para no contar. Por defecto, `caches.default` si existe. */
  cache?: CacheLike | null;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface WorkerReportContext {
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
  request?: { url: string; method: string } | undefined;
}

export type WorkerReportResult =
  | { sent: true }
  | { sent: false; reason: DropReason | 'no_dsn' | 'invalid_dsn' };

const DAY_SECONDS = 86_400;

function defaultCache(): CacheLike | null {
  if (typeof caches === 'undefined') return null;
  return (caches as unknown as { default?: CacheLike }).default ?? null;
}

/**
 * Suma uno al contador de `key` y dice si cabe en `limit`.
 *
 * Una caché ilegible nunca debe impedir el reporte: ante la duda deja pasar,
 * porque perder visibilidad es peor que pasarse un evento.
 */
async function fits(
  cache: CacheLike | null,
  origin: string,
  key: string,
  limit: number,
): Promise<boolean> {
  if (!cache) return true;
  const request = new Request(`${origin}/${encodeURIComponent(key)}`);
  let used = 0;
  try {
    const hit = await cache.match(request);
    if (hit) used = Number(await hit.text()) || 0;
  } catch {
    return true;
  }
  if (used >= limit) return false;
  try {
    await cache.put(
      request,
      new Response(String(used + 1), { headers: { 'Cache-Control': `max-age=${DAY_SECONDS}` } }),
    );
  } catch {
    /* si no se puede contar, se reporta igual */
  }
  return true;
}

function buildEnvelope(
  dsn: string,
  event: EventLike,
  options: WorkerReporterOptions,
  context: WorkerReportContext,
  nowMs: number,
): { endpoint: string; body: string; headers: Record<string, string> } {
  const url = new URL(dsn);
  const projectId = url.pathname.replace(/^\/+/, '');
  if (!projectId || !url.username) throw new Error('DSN sin proyecto o sin clave');
  const eventId = crypto.randomUUID().replace(/-/g, '');

  const payload = {
    event_id: eventId,
    timestamp: nowMs / 1000,
    platform: 'javascript',
    level: 'error',
    logger: options.name,
    server_name: options.name,
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
    ...(context.request
      ? { request: { url: context.request.url, method: context.request.method } }
      : {}),
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
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${url.username}, sentry_client=djinnfoundry-sentry-budget/1.0.0`,
    },
  };
}

/** Pasa un `Error` (o lo que sea) a lo que entiende la política. */
export function fromError(error: unknown): EventLike {
  if (error instanceof Error) {
    return { type: error.name || 'Error', message: error.message, stack: error.stack };
  }
  if (error && typeof error === 'object') {
    const value = error as { name?: string; message?: string; stack?: string };
    return {
      type: value.name ?? 'Error',
      message: value.message ?? String(error),
      stack: value.stack,
    };
  }
  return { type: 'Error', message: String(error) };
}

/**
 * Crea el reportero del Worker.
 *
 * `perLoad` no aplica aquí —un isolate no es una carga de página— así que el
 * tope por isolate se cuenta igual en memoria: corta un bucle dentro de una
 * misma invocación sin esperar a la caché.
 */
export function createWorkerReporter(options: WorkerReporterOptions) {
  const limits = options.limits ?? WORKER_LIMITS;
  const now = options.now ?? Date.now;
  const cache = options.cache !== undefined ? options.cache : defaultCache();
  const origin = `https://sentry-budget.${options.name}.internal`;
  let sentThisIsolate = 0;

  return async function report(
    error: unknown,
    context: WorkerReportContext = {},
  ): Promise<WorkerReportResult> {
    if (!options.dsn) return { sent: false, reason: 'no_dsn' };
    const event = fromError(error);

    // La parte pura decide el ruido y el tope por isolate sin tocar la caché;
    // los contadores de día e issue son asíncronos y van después.
    const local = decide({ event, counters: null, sentThisLoad: sentThisIsolate, limits });
    if (!local.send) return { sent: false, reason: local.reason };

    const day = utcDay(now());
    if (!(await fits(cache, origin, `day:${day}`, limits.perDay))) {
      return { sent: false, reason: 'per_day' };
    }
    if (!(await fits(cache, origin, `issue:${day}:${fingerprint(event)}`, limits.perIssue))) {
      return { sent: false, reason: 'per_issue' };
    }

    let envelope: ReturnType<typeof buildEnvelope>;
    try {
      envelope = buildEnvelope(options.dsn, event, options, context, now());
    } catch {
      return { sent: false, reason: 'invalid_dsn' };
    }

    sentThisIsolate += 1;
    const send = (options.fetchImpl ?? fetch)(envelope.endpoint, {
      method: 'POST',
      headers: envelope.headers,
      body: envelope.body,
    }).catch(() => undefined);

    if (context.ctx?.waitUntil) context.ctx.waitUntil(send);
    else await send;

    return { sent: true };
  };
}

export { isKnownNoise };
