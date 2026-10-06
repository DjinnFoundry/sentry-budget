# @djinnfoundry/sentry-budget

El tope de eventos de Sentry del estudio, escrito una vez.

## Por qué existe

La organización de Sentry de Djinn Foundry comparte **una** cuota mensual de
errores entre todos los productos, y su plan no tiene límite por proyecto.

El 2026-09-02, primer día del periodo, el Worker de AudioKids mandó 4.895
eventos de una consulta a D1 que fallaba en cada petición. Agotó la cuota del
mes ese día. Hasta el 2026-10-01 Sentry descartó unos 32.000 errores y **nadie
vio los suyos durante un mes**: 1.016 de Brân, 365 de ZetaRead, 245 de Neotral,
y así. Poner `rateLimit` en una clave de cliente no sirve — es del plan Business
y el plan actual lo ignora en silencio.

De ahí la regla: **sin tope en el código, un proyecto ruidoso ciega a todos los
demás.** Añadir un DSN sin tope no mejora la observabilidad del estudio, la
empeora.

Esa política se escribió tres veces en tres repos (yukids, djinncom, audiokids)
y en la tercera se repitió el mismo error que la segunda ya documentaba en un
comentario: la huella aplana los dígitos, así que un test que agote el tope
diario con `fallo 1`, `fallo 2`… topa antes por issue y pasa por las razones
equivocadas. Tres copias de 150 líneas con el mismo bug es lo que este paquete
viene a terminar.

El contrato en prosa, con los números medidos y quién cumple hoy, vive en el
vault: `Operations/Sentry.md`. Esto es su implementación.

## Qué garantiza

| Tope | Qué corta |
|---|---|
| por carga / isolate | el bucle inmediato, sin tocar almacén ni caché |
| por día | que un dispositivo o un colo gaste el mes del estudio |
| por issue y día | el evento 500 del mismo fallo, que no informa más que el 5 |
| ruido conocido | extensiones, `Script error.` de otro origen, ResizeObserver, abortos |

Nunca lanza. Sin DSN no hace nada, que es lo que quieren `dev` y los tests.

## Uso

### Un Worker de Cloudflare

```ts
import { createWorkerReporter } from '@djinnfoundry/sentry-budget/worker';

const report = createWorkerReporter({
  dsn: env.SENTRY_DSN,
  name: 'neotral-api',
  environment: env.ENVIRONMENT,
});

// En el `catch` de la frontera, o en el onError del router:
await report(error, { ctx, request });
```

El contador vive en la Cache API, que persiste entre isolates pero es **de cada
colo**: el techo real es `perDay` por colo, no global. Es un límite de verdad y
no cuesta nada; un contador exacto exigiría escribir en D1 desde el camino del
error, que es justo lo que falla cuando D1 es el problema.

### Un navegador, sin el SDK de Sentry

```ts
import { installErrorReporting } from '@djinnfoundry/sentry-budget/browser';

installErrorReporting({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  key: 'djinnchat:sentry',
  release: import.meta.env.VITE_APP_RELEASE,
});
```

Engancha `error` y `unhandledrejection`, manda el envelope con `fetch` y
`keepalive`, y no añade ni una dependencia al bundle.

### Un navegador que ya tiene `@sentry/browser`

```ts
import { createBeforeSend } from '@djinnfoundry/sentry-budget/browser';

Sentry.init({
  dsn,
  beforeSend: createBeforeSend({ key: 'audiokids:sentry', scrub: scrubEvent }),
});
```

`scrub` se aplica **antes** de decidir, para que lo que se cuenta sea lo mismo
que se habría enviado.

### Topes a medida

```ts
import { BROWSER_LIMITS, WORKER_LIMITS } from '@djinnfoundry/sentry-budget';

createWorkerReporter({ ..., limits: { perLoad: 10, perDay: 30, perIssue: 3 } });
```

Los valores por defecto son `BROWSER_LIMITS` (3 / 20 / 2) y `WORKER_LIMITS`
(20 / 60 / 5). El navegador es más estricto a propósito: un fallo de página se
dispara una vez por visitante y buena parte de lo que reporta no es nuestro.

## La cuarentena de 4 días

El estudio bloquea instalar cualquier versión publicada hace menos de 4 días
(`minimumReleaseAge` en pnpm). Se aplica también a este paquete, así que una
corrección del tope tarda 4 días en poder instalarse en los consumidores.

Cada repo consumidor se exime **solo del scope propio**, no de la cuarentena:

```yaml
# pnpm-workspace.yaml
minimumReleaseAgeExclude:
  - '@djinnfoundry/*'
```

La cuarentena existe para que un paquete público comprometido tenga tiempo de
detectarse y retirarse del registro. Un paquete que publica este mismo estudio
desde su propio repo no gana nada esperando: nadie ajeno lo audita en esos
cuatro días. La exención es del scope y de nada más.

## Publicar

```
pnpm version patch   # o minor / major
git push --follow-tags
```

El tag dispara `.github/workflows/publish.yml`, que vuelve a pasar typecheck,
tests y build antes de publicar en GitHub Packages. Nada se publica a mano.

Los consumidores fijan versión exacta, sin `^` ni `~`:

```
pnpm add @djinnfoundry/sentry-budget@1.0.0
```
