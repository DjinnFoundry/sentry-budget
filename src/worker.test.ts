import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerReporter, fromError, type CacheLike } from './worker.js';

const DSN = 'https://clavepublica@o0000000000000000.ingest.de.sentry.io/2222222222222222';
const NOW = Date.parse('2026-10-06T10:00:00.000Z');

/** Cache API de pega: persiste entre llamadas, como la del colo. */
function cacheFalsa(): CacheLike & { almacen: Map<string, string> } {
  const almacen = new Map<string, string>();
  return {
    almacen,
    async match(request) {
      const valor = almacen.get(request.url);
      return valor === undefined ? undefined : new Response(valor);
    },
    async put(request, response) {
      almacen.set(request.url, await response.text());
    },
  };
}

const PALABRAS = ['alfa', 'bravo', 'charlie', 'delta', 'eco', 'foxtrot', 'golf', 'hotel',
  'india', 'julieta', 'kilo', 'lima', 'mike', 'november', 'oscar'];

describe('fromError', () => {
  it('saca nombre, mensaje y pila de un Error', () => {
    const error = new TypeError('barcode nulo');
    expect(fromError(error)).toMatchObject({ type: 'TypeError', message: 'barcode nulo' });
  });

  it('entiende un objeto con forma de error', () => {
    expect(fromError({ name: 'D1Error', message: 'no responde', stack: 'at q' })).toEqual({
      type: 'D1Error', message: 'no responde', stack: 'at q',
    });
    expect(fromError({})).toMatchObject({ type: 'Error', message: '[object Object]' });
  });

  it('aguanta lo que no es un error', () => {
    expect(fromError('cadena pelada')).toEqual({ type: 'Error', message: 'cadena pelada' });
    expect(fromError(undefined)).toEqual({ type: 'Error', message: 'undefined' });
  });

  it('un Error sin nombre cae en Error', () => {
    const error = new Error('x');
    error.name = '';
    expect(fromError(error).type).toBe('Error');
  });
});

describe('createWorkerReporter', () => {
  let enviados: Array<{ url: string; init: RequestInit }>;
  let fetchFalso: typeof fetch;

  beforeEach(() => {
    enviados = [];
    fetchFalso = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      enviados.push({ url: String(url), init: init ?? {} });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function reportero(extra: Record<string, unknown> = {}) {
    return createWorkerReporter({
      dsn: DSN, name: 'neotral-api', cache: cacheFalsa(), now: () => NOW,
      fetchImpl: fetchFalso, environment: 'production', ...extra,
    });
  }

  it('sin DSN no manda nada', async () => {
    const report = reportero({ dsn: undefined });
    await expect(report(new Error('x'))).resolves.toEqual({ sent: false, reason: 'no_dsn' });
    expect(enviados).toHaveLength(0);
  });

  it('manda un envelope al endpoint del proyecto con la clave en la cabecera', async () => {
    const report = reportero({ release: 'abc123' });
    await expect(
      report(new TypeError('D1 no responde'), {
        request: { url: 'https://api.neotral.org/stories', method: 'GET' },
      }),
    ).resolves.toEqual({ sent: true });

    expect(enviados).toHaveLength(1);
    const { url, init } = enviados[0]!;
    expect(url).toBe('https://o0000000000000000.ingest.de.sentry.io/api/2222222222222222/envelope/');
    expect((init.headers as Record<string, string>)['X-Sentry-Auth']).toContain(
      'sentry_key=clavepublica',
    );

    const [cabecera, item, evento] = String(init.body).trim().split('\n').map((l) => JSON.parse(l));
    expect(cabecera.dsn).toBe(DSN);
    expect(item).toEqual({ type: 'event' });
    expect(evento.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'D1 no responde' });
    expect(evento.request).toEqual({ url: 'https://api.neotral.org/stories', method: 'GET' });
    expect(evento.logger).toBe('neotral-api');
    expect(evento.server_name).toBe('neotral-api');
    expect(evento.environment).toBe('production');
    expect(evento.release).toBe('abc123');
  });

  it('sin petición ni release el evento sale igual', async () => {
    await reportero()(new Error('x'));
    const evento = JSON.parse(String(enviados[0]!.init.body).trim().split('\n')[2]!);
    expect(evento.request).toBeUndefined();
    expect(evento.release).toBeUndefined();
  });

  it('sin environment usa production', async () => {
    await reportero({ environment: undefined })(new Error('x'));
    const evento = JSON.parse(String(enviados[0]!.init.body).trim().split('\n')[2]!);
    expect(evento.environment).toBe('production');
  });

  it('un error sin pila no lleva stacktrace', async () => {
    await reportero()({ name: 'E', message: 'sin pila' });
    const evento = JSON.parse(String(enviados[0]!.init.body).trim().split('\n')[2]!);
    expect(evento.exception.values[0].stacktrace).toBeUndefined();
  });

  it('corta un issue en bucle al llegar a su tope del día', async () => {
    const report = reportero({ limits: { perLoad: 99, perDay: 99, perIssue: 3 } });
    for (let i = 0; i < 3; i += 1) {
      await expect(report(new Error('D1 caído')), `evento ${i + 1}`).resolves.toEqual({ sent: true });
    }
    await expect(report(new Error('D1 caído'))).resolves.toEqual({
      sent: false, reason: 'per_issue',
    });
    expect(enviados).toHaveLength(3);
  });

  it('corta en el tope diario aunque los issues sean distintos', async () => {
    const report = reportero({ limits: { perLoad: 99, perDay: 5, perIssue: 3 } });
    let mandados = 0;
    for (const a of PALABRAS) {
      for (const b of PALABRAS) {
        const r = await report(new Error(`falla ${a} ${b}`));
        if (r.sent) {
          mandados += 1;
          continue;
        }
        expect(r).toEqual({ sent: false, reason: 'per_day' });
        expect(mandados).toBe(5);
        return;
      }
    }
    throw new Error('el tope diario no cortó');
  });

  it('el tope por isolate corta sin tocar la caché', async () => {
    const cache = cacheFalsa();
    const report = reportero({ cache, limits: { perLoad: 2, perDay: 99, perIssue: 99 } });
    await report(new Error('alfa'));
    await report(new Error('bravo'));
    await expect(report(new Error('charlie'))).resolves.toEqual({
      sent: false, reason: 'per_load',
    });
    // Dos enviados, y nada escrito por el tercero: el corte fue en memoria.
    expect(enviados).toHaveLength(2);
  });

  it('los contadores son por día: mañana hay cuota', async () => {
    const cache = cacheFalsa();
    const limits = { perLoad: 99, perDay: 99, perIssue: 1 };
    const ayer = reportero({ cache, limits, now: () => Date.parse('2026-10-06T23:59:00Z') });
    await expect(ayer(new Error('igual'))).resolves.toEqual({ sent: true });
    await expect(ayer(new Error('igual'))).resolves.toEqual({ sent: false, reason: 'per_issue' });

    const hoy = reportero({ cache, limits, now: () => Date.parse('2026-10-07T00:01:00Z') });
    await expect(hoy(new Error('igual'))).resolves.toEqual({ sent: true });
  });

  it('descarta el ruido que no podemos arreglar', async () => {
    const report = reportero();
    for (const mensaje of ['Load failed', 'The operation was aborted']) {
      await expect(report(new Error(mensaje)), mensaje).resolves.toEqual({
        sent: false, reason: 'noise',
      });
    }
    expect(enviados).toHaveLength(0);
  });

  it('sin Cache API reporta igual: perder visibilidad es peor que pasarse un evento', async () => {
    const report = reportero({ cache: null, limits: { perLoad: 99, perDay: 1, perIssue: 1 } });
    await expect(report(new Error('igual'))).resolves.toEqual({ sent: true });
    await expect(report(new Error('igual'))).resolves.toEqual({ sent: true });
  });

  it('una caché que lanza al leer no impide el reporte', async () => {
    const report = reportero({
      cache: {
        match: async () => { throw new Error('caché caída'); },
        put: async () => { throw new Error('caché caída'); },
      },
    });
    await expect(report(new Error('x'))).resolves.toEqual({ sent: true });
  });

  it('una caché que lanza solo al escribir cuenta como que cabe', async () => {
    const report = reportero({
      cache: {
        match: async () => undefined,
        put: async () => { throw new Error('solo falla al escribir'); },
      },
    });
    await expect(report(new Error('x'))).resolves.toEqual({ sent: true });
  });

  it('usa caches.default cuando existe y no se le pasa caché', async () => {
    const cache = cacheFalsa();
    vi.stubGlobal('caches', { default: cache });
    const report = createWorkerReporter({
      dsn: DSN, name: 'geocites', now: () => NOW, fetchImpl: fetchFalso,
      limits: { perLoad: 99, perDay: 99, perIssue: 1 },
    });
    await expect(report(new Error('igual'))).resolves.toEqual({ sent: true });
    await expect(report(new Error('igual'))).resolves.toEqual({ sent: false, reason: 'per_issue' });
    expect([...cache.almacen.keys()].some((k) => k.includes('geocites'))).toBe(true);
  });

  it('sin caches global no lanza', async () => {
    vi.stubGlobal('caches', undefined);
    const report = createWorkerReporter({
      dsn: DSN, name: 'x', now: () => NOW, fetchImpl: fetchFalso,
    });
    await expect(report(new Error('x'))).resolves.toEqual({ sent: true });
  });

  it('un caches sin default no lanza', async () => {
    vi.stubGlobal('caches', {});
    const report = createWorkerReporter({
      dsn: DSN, name: 'x', now: () => NOW, fetchImpl: fetchFalso,
    });
    await expect(report(new Error('x'))).resolves.toEqual({ sent: true });
  });

  it('delega el envío en waitUntil cuando existe, para no retrasar la respuesta', async () => {
    const waitUntil = vi.fn();
    await reportero()(new Error('x'), { ctx: { waitUntil } });
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it('un ctx sin waitUntil no lo impide: espera el envío', async () => {
    await expect(reportero()(new Error('x'), { ctx: {} })).resolves.toEqual({ sent: true });
    expect(enviados).toHaveLength(1);
  });

  it('un DSN con forma inválida no tumba nada', async () => {
    await expect(reportero({ dsn: 'no-es-una-url' })(new Error('x'))).resolves.toEqual({
      sent: false, reason: 'invalid_dsn',
    });
    await expect(reportero({ dsn: 'https://clave@host/' })(new Error('x'))).resolves.toEqual({
      sent: false, reason: 'invalid_dsn',
    });
  });

  it('un fetch que rechaza no propaga: el error de verdad ya iba al cliente', async () => {
    const report = reportero({
      fetchImpl: (() => Promise.reject(new Error('sentry caído'))) as unknown as typeof fetch,
    });
    await expect(report(new Error('x'))).resolves.toEqual({ sent: true });
  });

  it('usa el fetch global si no se le pasa ninguno', async () => {
    const espia = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', espia);
    const report = createWorkerReporter({
      dsn: DSN, name: 'x', cache: null, now: () => NOW,
    });
    await expect(report(new Error('x'))).resolves.toEqual({ sent: true });
    expect(espia).toHaveBeenCalledOnce();
  });

  it('usa Date.now si no se le pasa reloj', async () => {
    const report = createWorkerReporter({
      dsn: DSN, name: 'x', cache: null, fetchImpl: fetchFalso,
    });
    await expect(report(new Error('x'))).resolves.toEqual({ sent: true });
  });
});
