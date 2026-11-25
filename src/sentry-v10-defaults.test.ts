import type { DataCollection as SdkDataCollection } from '@sentry/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { SENTRY_V10_DATA_COLLECTION, SENTRY_V10_DEFAULTS } from './index.js';

// La base de la v10 que da la guía de migración de Sentry 11.
const IDENTIFICADORAS = { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] };

describe('valores por defecto de Sentry 10', () => {
  it('dataCollection es el de la guía de migración, campo a campo', () => {
    expect(SENTRY_V10_DATA_COLLECTION).toStrictEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: IDENTIFICADORAS, response: IDENTIFICADORAS },
      httpBodies: [],
      urlQueryParams: IDENTIFICADORAS,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    });
  });

  it('las listas de claves no se comparten: cambiar una no toca las demás', () => {
    const { httpHeaders, urlQueryParams } = SENTRY_V10_DATA_COLLECTION;
    expect(httpHeaders.request).not.toBe(httpHeaders.response);
    expect(httpHeaders.request).not.toBe(urlQueryParams);
  });

  it('SENTRY_V10_DEFAULTS añade la pila y el ciclo de trazas de la v10', () => {
    expect(SENTRY_V10_DEFAULTS).toStrictEqual({
      dataCollection: SENTRY_V10_DATA_COLLECTION,
      attachStacktrace: false,
      traceLifecycle: 'static',
    });
    expect(SENTRY_V10_DEFAULTS).not.toHaveProperty('sendDefaultPii');
  });

  it('encaja con el tipo dataCollection del SDK', () => {
    expectTypeOf(SENTRY_V10_DATA_COLLECTION).toExtend<SdkDataCollection>();
  });
});
