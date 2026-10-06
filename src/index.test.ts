import { describe, expect, it } from 'vitest';
import {
  BROWSER_LIMITS,
  WORKER_LIMITS,
  decide,
  emptyCounters,
  fingerprint,
  increment,
  isKnownNoise,
  parseCounters,
  utcDay,
  type Counters,
} from './index.js';

const DAY = '2026-10-06';

function counters(total: number, issues: Record<string, number> = {}): Counters {
  return { day: DAY, total, issues };
}

describe('utcDay', () => {
  it('da el día UTC, no el local', () => {
    // 00:30 en Madrid del día 7 es todavía el 6 en UTC.
    expect(utcDay(Date.parse('2026-10-06T23:30:00.000Z'))).toBe('2026-10-06');
    expect(utcDay(Date.parse('2026-10-07T00:01:00.000Z'))).toBe('2026-10-07');
  });
});

describe('isKnownNoise', () => {
  it('descarta el mensaje exacto de un script de otro origen', () => {
    expect(isKnownNoise({ message: 'Script error.' })).toBe(true);
    expect(isKnownNoise({ message: 'Script error' })).toBe(true);
  });

  it('no descarta un mensaje nuestro que CONTENGA el ruido', () => {
    // Anclado a propósito: `Script error.` es el mensaje entero. Si un fallo
    // nuestro menciona la frase, es nuestro y hay que verlo.
    expect(isKnownNoise({ message: 'el proveedor devolvió Script error. al generar' })).toBe(false);
    expect(isKnownNoise({ message: 'Load failed al pedir el audio' })).toBe(false);
  });

  it('descarta el ruido anclado de red y de abortos', () => {
    for (const message of [
      'Load failed',
      'NetworkError when attempting to fetch resource.',
      'The operation was aborted',
      'AbortError: señal abortada',
    ]) {
      expect(isKnownNoise({ message }), message).toBe(true);
    }
  });

  it('descarta ResizeObserver venga en el mensaje o en la pila', () => {
    expect(isKnownNoise({ message: 'ResizeObserver loop limit exceeded' })).toBe(true);
    expect(isKnownNoise({ message: 'x', stack: 'at ResizeObserver loop' })).toBe(true);
  });

  it('descarta lo que viene de una extensión aunque el mensaje parezca nuestro', () => {
    expect(
      isKnownNoise({
        type: 'TypeError',
        message: 'no se puede leer audioUrl',
        stack: 'at inject (chrome-extension://abc/inject.js:1:1)',
      }),
    ).toBe(true);
    expect(isKnownNoise({ message: 'x', stack: 'moz-extension://a/b.js' })).toBe(true);
    expect(isKnownNoise({ message: 'x', stack: 'safari-web-extension://a/b.js' })).toBe(true);
  });

  it('deja pasar un error nuestro de verdad', () => {
    expect(isKnownNoise({ type: 'TypeError', message: 'audioUrl es null' })).toBe(false);
    expect(isKnownNoise({})).toBe(false);
  });
});

describe('fingerprint', () => {
  it('agrupa el mismo fallo con números distintos', () => {
    expect(fingerprint({ type: 'Error', message: 'timeout tras 3000 ms' })).toBe(
      fingerprint({ type: 'Error', message: 'timeout tras 9000 ms' })
    );
  });

  it('separa tipos distintos', () => {
    expect(fingerprint({ type: 'TypeError', message: 'a' })).not.toBe(
      fingerprint({ type: 'RangeError', message: 'a' })
    );
  });

  it('un evento de mensaje sin tipo cuenta como Message', () => {
    expect(fingerprint({ message: 'la mezcla salió muda' })).toMatch(/^Message:/);
  });

  it('un evento vacío no revienta y cuenta como Error', () => {
    expect(fingerprint({})).toBe('Error:');
  });

  it('corta mensajes largos para que la clave no crezca sin límite', () => {
    expect(fingerprint({ type: 'Error', message: 'x'.repeat(500) }).length).toBeLessThanOrEqual(160);
  });
});

describe('decide', () => {
  const limits = { perLoad: 3, perDay: 10, perIssue: 2 };

  it('deja pasar lo normal', () => {
    expect(
      decide({ event: { type: 'Error', message: 'x' }, counters: counters(0), sentThisLoad: 0, limits })
    ).toEqual({ send: true });
  });

  it('el ruido se descarta antes que cualquier tope', () => {
    expect(
      decide({ event: { message: 'Script error.' }, counters: null, sentThisLoad: 99, limits })
    ).toEqual({ send: false, reason: 'noise' });
  });

  it('corta por carga', () => {
    expect(
      decide({ event: { message: 'x' }, counters: counters(0), sentThisLoad: 3, limits })
    ).toEqual({ send: false, reason: 'per_load' });
  });

  it('corta por día', () => {
    expect(
      decide({ event: { message: 'x' }, counters: counters(10), sentThisLoad: 0, limits })
    ).toEqual({ send: false, reason: 'per_day' });
  });

  it('corta por issue', () => {
    const key = fingerprint({ type: 'Error', message: 'igual' });
    expect(
      decide({
        event: { type: 'Error', message: 'igual' },
        counters: counters(2, { [key]: 2 }),
        sentThisLoad: 0,
        limits,
      })
    ).toEqual({ send: false, reason: 'per_issue' });
  });

  it('sin contadores solo queda el tope por carga, y ante la duda deja pasar', () => {
    // Un almacén bloqueado no puede convertirse en silencio total.
    expect(decide({ event: { message: 'x' }, counters: null, sentThisLoad: 0, limits })).toEqual({
      send: true,
    });
    expect(decide({ event: { message: 'x' }, counters: null, sentThisLoad: 3, limits })).toEqual({
      send: false,
      reason: 'per_load',
    });
  });

  it('el orden es carga, día, issue: el tope más barato primero', () => {
    const key = fingerprint({ type: 'Error', message: 'igual' });
    expect(
      decide({
        event: { type: 'Error', message: 'igual' },
        counters: counters(10, { [key]: 99 }),
        sentThisLoad: 3,
        limits,
      })
    ).toEqual({ send: false, reason: 'per_load' });
  });
});

describe('increment', () => {
  it('suma al total y al issue sin mutar la entrada', () => {
    const antes = counters(1, { 'Error:ya': 1 });
    const despues = increment(antes, { type: 'Error', message: 'nuevo' });
    expect(despues.total).toBe(2);
    expect(despues.issues['Error:nuevo']).toBe(1);
    expect(despues.issues['Error:ya']).toBe(1);
    expect(antes.total).toBe(1);
    expect(antes.issues).toEqual({ 'Error:ya': 1 });
  });

  it('el mismo issue dos veces suma dos', () => {
    const uno = increment(emptyCounters(DAY), { type: 'Error', message: 'igual' });
    const dos = increment(uno, { type: 'Error', message: 'igual' });
    expect(dos.issues['Error:igual']).toBe(2);
    expect(dos.total).toBe(2);
  });
});

describe('parseCounters', () => {
  it('lee contadores del mismo día', () => {
    expect(parseCounters({ day: DAY, total: 4, issues: { a: 2 } }, DAY)).toEqual({
      day: DAY,
      total: 4,
      issues: { a: 2 },
    });
  });

  it('los de otro día arrancan de cero', () => {
    expect(parseCounters({ day: '2026-10-05', total: 99, issues: { a: 9 } }, DAY)).toEqual(
      emptyCounters(DAY)
    );
  });

  it('la basura arranca de cero en vez de impedir reportar', () => {
    for (const raw of [null, undefined, 'no-es-json', 42, []]) {
      expect(parseCounters(raw, DAY), String(raw)).toEqual(emptyCounters(DAY));
    }
  });

  it('tolera campos a medias', () => {
    expect(parseCounters({ day: DAY }, DAY)).toEqual(emptyCounters(DAY));
    expect(parseCounters({ day: DAY, total: 'ocho', issues: 'no' }, DAY)).toEqual(emptyCounters(DAY));
  });
});

describe('los topes por defecto', () => {
  it('el navegador es más estricto que el Worker', () => {
    expect(BROWSER_LIMITS.perDay).toBeLessThan(WORKER_LIMITS.perDay);
    expect(BROWSER_LIMITS.perIssue).toBeLessThan(WORKER_LIMITS.perIssue);
  });

  it('ninguno supera por sí solo la cuota mensual del estudio', () => {
    // 5.000 errores al mes compartidos. Un producto no puede gastarlos solo.
    expect(WORKER_LIMITS.perDay * 31).toBeLessThan(5000 / 2);
  });
});
