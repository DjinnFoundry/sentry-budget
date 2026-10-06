# @djinnfoundry/sentry-budget

El tope de eventos de Sentry del estudio, escrito una vez.

## Por qué existe

Una organización de Sentry en plan Developer o Team comparte **una** cuota
mensual de errores entre todos sus proyectos y **no tiene límite por proyecto**:
eso es del plan Business. Poner `rateLimit` en una clave de cliente no sirve, el
plan lo ignora en silencio.

La consecuencia, medida: un Worker con una consulta que fallaba en cada petición
mandó 4.895 eventos el primer día del periodo y agotó la cuota del mes. Durante
los treinta días siguientes Sentry descartó unos 32.000 errores y ningún otro
proyecto de la organización vio los suyos. Un fallo en un sitio dejó ciego todo
lo demás.

De ahí la regla: **sin tope en el código, un proyecto ruidoso ciega a todos los
demás.** Añadir un DSN sin tope no mejora la observabilidad, la empeora.

Y de ahí el paquete: esa política se había escrito cuatro veces en cuatro repos,
y en la cuarta se repitió el mismo error que la segunda ya documentaba en un
comentario. La huella aplana los dígitos, así que un test que quiera agotar el
tope diario con `fallo 1`, `fallo 2` y así topa antes por issue y pasa por las
razones equivocadas. Cuatro copias de 150 líneas con el mismo bug es lo que esto
viene a terminar.

## Qué garantiza

| Tope | Qué corta |
|---|---|
| por carga / isolate | el bucle inmediato, sin tocar almacén ni caché |
| por día | que un dispositivo o un colo gaste el mes del estudio |
| por issue y día | el evento 500 del mismo fallo, que no informa más que el 5 |
| ruido conocido | extensiones, `Script error.` de otro origen, ResizeObserver, abortos |

Nunca lanza, nunca retrasa la respuesta que lo origina y no añade dependencias.
Sin DSN no hace nada, que es lo que quieren `dev` y los tests.

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

Si tienes una cuarentena de publicación (`minimumReleaseAge` en pnpm, por
defecto 1.440 minutos desde pnpm 11), se aplica también a este paquete: una
corrección del tope tarda ese tiempo en poder instalarse en los consumidores.

Cada repo consumidor se exime **solo del scope propio**, no de la cuarentena:

```yaml
# pnpm-workspace.yaml
minimumReleaseAgeExclude:
  - '@djinnfoundry/*'
```

La cuarentena existe para que un paquete comprometido de un tercero tenga tiempo
de detectarse y retirarse del registro. Un paquete que publicas tú desde tu
propio repo no gana nada esperando. La exención es del scope y de nada más.

## Publicar

```
pnpm version patch   # o minor / major
git push --follow-tags
```

El tag dispara `.github/workflows/publish.yml`, que vuelve a pasar typecheck,
tests y build antes de publicar. Nada se publica a mano.

No hay `NPM_TOKEN`. Se publica con **trusted publishing** (OIDC): el runner
presenta una identidad firmada por GitHub y npm la valida contra el publicador de
confianza declarado en los ajustes del paquete. npm revocó todos los tokens
clásicos el 2025-12-09 y los granulares con permiso de escritura caducan a los 90
días, así que un token guardado aquí sería una cita en el calendario cuatro veces
al año y un paquete sin publicar el día que se olvide. Con OIDC la procedencia se
genera sola, sin pedir `--provenance`.

Los consumidores fijan versión exacta, sin `^` ni `~`:

```
pnpm add @djinnfoundry/sentry-budget@1.0.0
```

Se publica en npmjs como paquete público, así que **no hace falta ningún token
para instalarlo**: ni en GitHub Actions, ni en el entorno de build de Cloudflare
Pages, ni en un Dockerfile, ni en tu portátil. El registro npm de GitHub se
descartó por lo contrario: devuelve 401 sin token incluso para un paquete de un
repo público, y varios consumidores los construye Cloudflare Pages, donde no hay
token de GitHub que ofrecer.

## Licencia

MIT. Es una utilidad pequeña y genérica: el problema que resuelve lo tiene
cualquiera con una organización de Sentry en un plan sin límite por proyecto.
