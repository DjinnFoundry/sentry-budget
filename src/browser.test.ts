import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBeforeSend,
  createBrowserBudget,
  createReporter,
  fromSentryEvent,
  installErrorReporting,
  type StorageLike,
} from './browser.js';

const DSN = 'https://clavepublica@o4510816747978752.ingest.de.sentry.io/4511186679824464';
const NOW = Date.parse('2026-10-06T10:00:00.000Z');

/** `localStorage` de pega, con la opción de fallar como en modo privado. */
function memoria({ roto = false } = {}): StorageLike {
  const mapa = new Map<string, string>();
  return {
    getItem(clave) {
      if (roto) throw new Error('storage blocked');
      return mapa.get(clave) ?? null;
    },
    setItem(clave, valor) {
      if (roto) throw new Error('storage blocked');
      mapa.set(clave, valor);
    },
  };
}

// Palabras y no números: la huella aplana los dígitos, así que `fallo 1` y
// `fallo 2` son el mismo issue y toparían por issue antes que por día.
const PALABRAS = ['alfa', 'bravo', 'charlie', 'delta', 'eco', 'foxtrot', 'golf', 'hotel',
  'india', 'julieta', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec',
  'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whisky', 'xray', 'yanqui'];

describe('createBrowserBudget', () => {
  it('deja pasar lo normal y lo cuenta', () => {
    const budget = createBrowserBudget({ key: 'p', storage: memoria(), now: () => NOW });
    expect(budget.allow({ type: 'TypeError', message: 'x' })).toBe(true);
    expect(budget.lastDrop).toBeNull();
  });

  it('corta un issue en bucle, y dice por qué', () => {
    const budget = createBrowserBudget({
      key: 'p', storage: memoria(), now: () => NOW,
      limits: { perLoad: 10, perDay: 10, perIssue: 2 },
    });
    expect(budget.allow({ type: 'Error', message: 'igual' })).toBe(true);
    expect(budget.allow({ type: 'Error', message: 'igual' })).toBe(true);
    expect(budget.allow({ type: 'Error', message: 'igual' })).toBe(false);
    expect(budget.lastDrop).toBe('per_issue');
  });

  it('el tope diario sobrevive a recargar la página', () => {
    const storage = memoria();
    const limits = { perLoad: 5, perDay: 6, perIssue: 3 };
    let enviados = 0;

    for (let carga = 0; carga < 10; carga += 1) {
      const budget = createBrowserBudget({ key: 'p', storage, now: () => NOW, limits });
      for (let i = 0; i < limits.perLoad; i += 1) {
        if (budget.allow({ type: 'Error', message: `falla ${PALABRAS[carga]} ${PALABRAS[i]}` })) {
          enviados += 1;
          continue;
        }
        expect(budget.lastDrop).toBe('per_day');
        expect(enviados).toBe(limits.perDay);
        return;
      }
    }
    throw new Error('el tope diario no cortó');
  });

  it('una carga nueva recupera cuota por carga pero no por día', () => {
    const storage = memoria();
    const limits = { perLoad: 2, perDay: 10, perIssue: 5 };
    const primera = createBrowserBudget({ key: 'p', storage, now: () => NOW, limits });
    expect(primera.allow({ type: 'A', message: 'x' })).toBe(true);
    expect(primera.allow({ type: 'B', message: 'x' })).toBe(true);
    expect(primera.allow({ type: 'C', message: 'x' })).toBe(false);
    expect(primera.lastDrop).toBe('per_load');

    const segunda = createBrowserBudget({ key: 'p', storage, now: () => NOW, limits });
    expect(segunda.allow({ type: 'C', message: 'x' })).toBe(true);
  });

  it('mañana hay cuota nueva', () => {
    const storage = memoria();
    const limits = { perLoad: 9, perDay: 1, perIssue: 9 };
    const hoy = createBrowserBudget({ key: 'p', storage, now: () => NOW, limits });
    expect(hoy.allow({ type: 'Error', message: 'x' })).toBe(true);
    expect(hoy.allow({ type: 'Error', message: 'y' })).toBe(false);
    expect(hoy.lastDrop).toBe('per_day');

    const manana = createBrowserBudget({
      key: 'p', storage, limits, now: () => Date.parse('2026-10-07T00:01:00.000Z'),
    });
    expect(manana.allow({ type: 'Error', message: 'x' })).toBe(true);
  });

  it('con el almacén bloqueado sigue reportando bajo el tope por carga', () => {
    const budget = createBrowserBudget({
      key: 'p', storage: memoria({ roto: true }), now: () => NOW,
      limits: { perLoad: 2, perDay: 1, perIssue: 1 },
    });
    expect(budget.allow({ type: 'Error', message: 'x' })).toBe(true);
    expect(budget.allow({ type: 'Error', message: 'x' })).toBe(true);
    expect(budget.allow({ type: 'Error', message: 'x' })).toBe(false);
    expect(budget.lastDrop).toBe('per_load');
  });

  it('sin almacén no lanza', () => {
    const budget = createBrowserBudget({ key: 'p', storage: null, now: () => NOW });
    expect(() => budget.allow({ message: 'x' })).not.toThrow();
  });

  it('basura en el almacén no impide reportar', () => {
    const storage = memoria();
    storage.setItem('p', '{no es json');
    const budget = createBrowserBudget({ key: 'p', storage, now: () => NOW });
    expect(budget.allow({ type: 'Error', message: 'x' })).toBe(true);
  });

  it('usa el localStorage de la ventana si no se le pasa ninguno', () => {
    const real = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => real.get(k) ?? null,
      setItem: (k: string, v: string) => real.set(k, v),
    });
    const budget = createBrowserBudget({ key: 'auto', now: () => NOW });
    expect(budget.allow({ type: 'Error', message: 'x' })).toBe(true);
    expect(real.get('auto')).toContain('"total":1');
    vi.unstubAllGlobals();
  });

  it('un localStorage que lanza al tocarlo no tumba nada', () => {
    vi.stubGlobal('localStorage', undefined);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('site data blocked'); },
    });
    expect(() => createBrowserBudget({ key: 'p', now: () => NOW })).not.toThrow();
    // @ts-expect-error se limpia la propiedad trucada
    delete globalThis.localStorage;
  });
});

describe('fromSentryEvent', () => {
  it('saca tipo, mensaje y pila de una excepción', () => {
    expect(
      fromSentryEvent({
        exception: { values: [{ type: 'TypeError', value: 'x', stacktrace: { frames: [] } }] },
      }),
    ).toMatchObject({ type: 'TypeError', message: 'x' });
  });

  it('entiende un mensaje suelto, en cadena o formateado', () => {
    expect(fromSentryEvent({ message: 'plano' }).message).toBe('plano');
    expect(fromSentryEvent({ message: { formatted: 'con formato' } }).message).toBe('con formato');
    expect(fromSentryEvent({}).message).toBe('');
  });
});

describe('createBeforeSend', () => {
  it('devuelve el evento cuando cabe y null cuando no', () => {
    const beforeSend = createBeforeSend({
      key: 'p', storage: memoria(), now: () => NOW,
      limits: { perLoad: 1, perDay: 9, perIssue: 9 },
    });
    const evento = { exception: { values: [{ type: 'Error', value: 'x' }] } };
    expect(beforeSend(evento)).toBe(evento);
    expect(beforeSend({ exception: { values: [{ type: 'Error', value: 'y' }] } })).toBeNull();
  });

  it('limpia antes de decidir, para contar lo que de verdad se enviaría', () => {
    const vistos: unknown[] = [];
    const beforeSend = createBeforeSend<{ message: string; extra?: unknown }>({
      key: 'p', storage: memoria(), now: () => NOW,
      scrub: (event) => {
        vistos.push(event);
        // Devuelve el evento SIN `extra`: es lo que hace un scrub de verdad.
        return { message: event.message };
      },
    });
    const salida = beforeSend({ message: 'x', extra: { token: 'secreto' } });
    expect(vistos).toHaveLength(1);
    expect(salida).toEqual({ message: 'x' });
  });

  it('el ruido nunca llega a Sentry', () => {
    const beforeSend = createBeforeSend({ key: 'p', storage: memoria(), now: () => NOW });
    expect(beforeSend({ message: 'Script error.' })).toBeNull();
  });
});

describe('createReporter', () => {
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
    return createReporter({
      dsn: DSN, key: 'p', storage: memoria(), now: () => NOW,
      fetchImpl: fetchFalso, pageUrl: () => 'https://djinnchat.com/login',
      environment: 'production', release: '1.2.3', ...extra,
    });
  }

  it('sin DSN no manda nada, que es lo que quiere dev', () => {
    const report = reportero({ dsn: undefined });
    expect(report({ message: 'x' })).toEqual({ sent: false, reason: 'no_dsn' });
    expect(enviados).toHaveLength(0);
  });

  it('manda un envelope al endpoint del proyecto con la clave en la cabecera', () => {
    expect(reportero()({ type: 'TypeError', message: 'x', stack: 'at f' })).toEqual({ sent: true });
    expect(enviados).toHaveLength(1);
    const { url, init } = enviados[0]!;
    expect(url).toBe('https://o4510816747978752.ingest.de.sentry.io/api/4511186679824464/envelope/');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sentry-Auth']).toContain('sentry_key=clavepublica');
    expect(init.keepalive).toBe(true);

    const [cabecera, item, evento] = String(init.body).trim().split('\n').map((l) => JSON.parse(l));
    expect(cabecera.dsn).toBe(DSN);
    expect(item).toEqual({ type: 'event' });
    expect(evento.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'x' });
    expect(evento.request.url).toBe('https://djinnchat.com/login');
    expect(evento.environment).toBe('production');
    expect(evento.release).toBe('1.2.3');
    expect(evento.logger).toBe('p');
  });

  it('un evento sin tipo ni mensaje se manda igual, con valores por defecto', () => {
    reportero()({});
    const evento = JSON.parse(String(enviados[0]!.init.body).trim().split('\n')[2]!);
    expect(evento.exception.values[0]).toMatchObject({ type: 'Error', value: 'unknown' });
    expect(evento.exception.values[0].stacktrace).toBeUndefined();
    expect(evento.request.url).toBe('https://djinnchat.com/login');
  });

  it('sin pageUrl ni release no revienta', () => {
    const report = createReporter({
      dsn: DSN, key: 'p', storage: memoria(), now: () => NOW, fetchImpl: fetchFalso,
    });
    expect(report({ message: 'x' })).toEqual({ sent: true });
    const evento = JSON.parse(String(enviados[0]!.init.body).trim().split('\n')[2]!);
    expect(evento.request.url).toBe('');
    expect(evento.release).toBeUndefined();
    expect(evento.environment).toBe('production');
  });

  it('respeta el logger explícito por encima de la clave', () => {
    reportero({ logger: 'djinnchat-site' })({ message: 'x' });
    const evento = JSON.parse(String(enviados[0]!.init.body).trim().split('\n')[2]!);
    expect(evento.logger).toBe('djinnchat-site');
  });

  it('un DSN con forma inválida no tumba nada', () => {
    expect(reportero({ dsn: 'no-es-una-url' })({ message: 'x' })).toEqual({
      sent: false, reason: 'invalid_dsn',
    });
    expect(reportero({ dsn: 'https://sinclave@host/42' })({ message: 'x' })).toEqual({ sent: true });
    expect(reportero({ dsn: 'https://clave@host/' })({ message: 'x' })).toEqual({
      sent: false, reason: 'invalid_dsn',
    });
  });

  it('un fetch que lanza en síncrono no propaga', () => {
    const report = reportero({
      fetchImpl: (() => { throw new Error('transporte muerto'); }) as unknown as typeof fetch,
    });
    expect(report({ message: 'x' })).toEqual({ sent: true });
  });

  it('un fetch que rechaza no propaga', async () => {
    const report = reportero({
      fetchImpl: (() => Promise.reject(new Error('sentry caído'))) as unknown as typeof fetch,
    });
    expect(report({ message: 'x' })).toEqual({ sent: true });
    await Promise.resolve();
  });

  it('usa el fetch global si no se le pasa ninguno', () => {
    const espia = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', espia);
    const report = createReporter({ dsn: DSN, key: 'p', storage: memoria(), now: () => NOW });
    expect(report({ message: 'x' })).toEqual({ sent: true });
    expect(espia).toHaveBeenCalledOnce();
  });

  it('propaga el motivo del tope en vez de inventarse uno', () => {
    const report = reportero({ limits: { perLoad: 9, perDay: 9, perIssue: 1 } });
    expect(report({ type: 'Error', message: 'igual' })).toEqual({ sent: true });
    expect(report({ type: 'Error', message: 'igual' })).toEqual({
      sent: false, reason: 'per_issue',
    });
    expect(report({ message: 'Script error.' })).toEqual({ sent: false, reason: 'noise' });
  });

  it('sin crypto.randomUUID sigue mandando', () => {
    vi.stubGlobal('crypto', {});
    expect(reportero()({ message: 'x' })).toEqual({ sent: true });
    const [cabecera] = String(enviados[0]!.init.body).trim().split('\n').map((l) => JSON.parse(l));
    expect(String(cabecera.event_id).length).toBeGreaterThan(0);
  });
});

describe('installErrorReporting', () => {
  it('engancha error y unhandledrejection, y reporta los dos', () => {
    const oyentes = new Map<string, (event: unknown) => void>();
    const enviados: unknown[] = [];
    const report = installErrorReporting({
      dsn: DSN, key: 'p', storage: memoria(), now: () => NOW,
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        enviados.push(JSON.parse(String(init.body).trim().split('\n')[2]!));
        return new Response('{}');
      }) as unknown as typeof fetch,
      target: {
        addEventListener: (tipo: string, fn: unknown) => {
          oyentes.set(tipo, fn as (event: unknown) => void);
        },
        location: { href: 'https://djinnchat.com/signup' },
      },
    });
    expect(report).not.toBeNull();
    expect([...oyentes.keys()]).toEqual(['error', 'unhandledrejection']);

    oyentes.get('error')!({ error: new TypeError('se rompió el formulario') });
    oyentes.get('unhandledrejection')!({ reason: new RangeError('fuera de rango') });
    expect(enviados).toHaveLength(2);
    expect((enviados[0] as any).exception.values[0]).toMatchObject({
      type: 'TypeError', value: 'se rompió el formulario',
    });
    expect((enviados[1] as any).exception.values[0].type).toBe('RangeError');
    expect((enviados[0] as any).request.url).toBe('https://djinnchat.com/signup');
  });

  it('un ErrorEvent sin `error` usa su mensaje, y un rechazo sin Error su texto', () => {
    const oyentes = new Map<string, (event: unknown) => void>();
    const enviados: unknown[] = [];
    installErrorReporting({
      dsn: DSN, key: 'p', storage: memoria(), now: () => NOW,
      limits: { perLoad: 9, perDay: 9, perIssue: 9 },
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        enviados.push(JSON.parse(String(init.body).trim().split('\n')[2]!));
        return new Response('{}');
      }) as unknown as typeof fetch,
      target: {
        addEventListener: (tipo: string, fn: unknown) => {
          oyentes.set(tipo, fn as (event: unknown) => void);
        },
      },
    });

    oyentes.get('error')!({ message: 'fallo sin objeto Error' });
    oyentes.get('unhandledrejection')!({ reason: 'una cadena pelada' });
    expect((enviados[0] as any).exception.values[0]).toMatchObject({
      type: 'Error', value: 'fallo sin objeto Error',
    });
    expect((enviados[1] as any).exception.values[0]).toMatchObject({
      type: 'UnhandledRejection', value: 'una cadena pelada',
    });
    expect((enviados[0] as any).request.url).toBe('');
  });

  it('sin DSN no engancha nada', () => {
    const addEventListener = vi.fn();
    expect(
      installErrorReporting({ dsn: undefined, key: 'p', target: { addEventListener } }),
    ).toBeNull();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('sin dónde enganchar devuelve null en vez de lanzar', () => {
    expect(
      installErrorReporting({ dsn: DSN, key: 'p', target: {} as never }),
    ).toBeNull();
  });

  it('por defecto engancha en el global', () => {
    const addEventListener = vi.fn();
    vi.stubGlobal('addEventListener', addEventListener);
    vi.stubGlobal('location', { href: 'https://djinnchat.com/' });
    expect(installErrorReporting({ dsn: DSN, key: 'p', storage: null })).not.toBeNull();
    expect(addEventListener).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
