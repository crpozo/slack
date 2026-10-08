# BLUEPRINT — Slack interno MindfulTech (MVP v0.1.0)

**Fecha:** 2026-10-08 · **Entrega MVP:** 2026-10-09 · **Repo:** https://github.com/crpozo/slack.git
**Uso de este documento:** cada "Fase" de la sección 4 es un prompt autocontenido para Claude Opus 5.5. Dáselas en orden, una por una, y pídele que no avance a la siguiente hasta que la actual compile y pase tests.

---

## 0. Decisiones de alcance para llegar mañana

El documento de requerimientos describe el producto completo. En 24 horas entra lo que hace que la app sea *usable entre dos personas*; todo lo demás queda explícitamente fuera y se agenda para v0.2.

| Entra en el MVP (mañana) | Queda para v0.2+ |
|---|---|
| Login Cognito (email + password), sesión persistente | Hilos |
| Canales públicos: `#general` por defecto, crear, listar | Renombrar / archivar canales |
| DM 1 a 1 (es un canal con `type=dm`) | Reacciones |
| Mensajes en tiempo real por WebSocket (< 1 s) | Edición y borrado de mensajes |
| Formato básico (negrita, cursiva, código, links) vía markdown ligero | Búsqueda de texto |
| Historial paginado hacia atrás (scroll infinito) | Presencia online/offline |
| Adjuntos: subida con URL prefirmada (PUT), preview inline de imágenes, descarga (GET firmado), límite 25 MB | "Escribiendo..." (dejar la ruta `typing` creada pero sin UI) |
| Badge de no leídos por canal (calculado en cliente, `lastReadTs` en localStorage) | Notificaciones del sistema, menciones `@` |
| Reconexión con backoff | Llamadas WebRTC + TURN |
| Deploy a producción en `slack.mindfultech.ec` / `ws.mindfultech.ec` | Desktop app Tauri (Fase 5 opcional si sobra tiempo) |
| Tests unitarios de handlers + CI en PR | Tests de integración contra stack dev, E2E Playwright |
| AWS Budgets, tags, retención de logs | Agente IA con Bedrock |

**Regla de oro:** no se construye nada que no esté en la columna izquierda. Si Opus propone algo de la derecha, se rechaza.

---

## 1. Resumen de la Arquitectura

Se respeta exactamente el diagrama: 7 componentes, todo serverless, región `us-east-1`.

```
Clientes (navegador / Tauri)
   │ https                     │ login (SRP)              │ wss?token=<idToken>
   ▼                           ▼                          ▼
S3 + CloudFront          Cognito User Pool         API Gateway WebSocket
(SPA estática)           (2 usuarios, sin          ws.mindfultech.ec
slack.mindfultech.ec      self-signup)                    │ invoca
                                                          ▼
                                                   Lambda (Node 20, ARM, 256 MB)
                                                   authorizer · connect · disconnect
                                                   message · history · presign · channel
                                                     │ lee/escribe          │ firma URLs
                                                     ▼                      ▼
                                                 DynamoDB              S3 adjuntos
                                                 messages              (privado, PUT/GET
                                                 connections (TTL)      prefirmados)
                                                 channels
```

### Flujo de una sesión

1. El navegador carga la SPA desde CloudFront (bucket privado con OAC).
2. Login contra Cognito con `aws-amplify/auth`. Amplify guarda tokens en localStorage y refresca solo → sesión persistente.
3. El cliente abre **un solo** WebSocket a `wss://ws.mindfultech.ec?token=<idToken>`.
4. `$connect` pasa por el **Lambda REQUEST authorizer**, que valida el JWT con `aws-jwt-verify` y devuelve `userId`/`email` en el contexto. Sin JWT válido → 401, nunca se abre la conexión.
5. `connect` guarda `{connectionId, userId, ttl}` en `connections`.
6. Cada mensaje del cliente es un JSON `{ "action": "...", ... }`. API Gateway enruta por `$request.body.action` a la Lambda correspondiente.
7. `message` escribe en `messages` y hace fan-out con `@connections` (PostToConnection) a todas las conexiones vivas. Si una conexión devuelve 410 Gone, se borra de `connections`.
8. `history` consulta `messages` por `channelId` con `ScanIndexForward=false`, `Limit=50` y `ExclusiveStartKey` para paginar hacia atrás.
9. `presign` genera una URL PUT (subida) o GET (descarga) de S3 con expiración de 5 min. El cliente sube/descarga directo a S3; Lambda nunca toca el binario.
10. `$disconnect` borra la fila de `connections` (y TTL de 2 h como red de seguridad).

### Modelo de datos (DynamoDB on-demand, sin GSIs, sin streams, sin PITR)

| Tabla | PK | SK | Atributos |
|---|---|---|---|
| `slack-messages` | `channelId` (S) | `sk` (S) = `${epochMs}#${ulid}` | `messageId`, `userId`, `userEmail`, `text`, `attachments[]` (`{key, name, size, contentType}`), `createdAt` |
| `slack-connections` | `connectionId` (S) | — | `userId`, `userEmail`, `connectedAt`, `ttl` (N, epoch s, +2 h) |
| `slack-channels` | `channelId` (S) | — | `name`, `type` (`public` \| `dm`), `createdBy`, `createdAt`, `archived` (bool) |

- `channelId` de un público: `ch_<ulid>`; `#general` tiene id fijo `ch_general` (seed en el deploy).
- `channelId` de un DM: `dm_<userIdA>_<userIdB>` con los ids ordenados alfabéticamente → siempre el mismo id para el par.
- Adjuntos en S3: key `attachments/<channelId>/<ulid>-<nombreSaneado>`. Bucket con lifecycle a Glacier IR a 90 días y CORS para PUT desde el origen de la SPA.

### Protocolo WebSocket (contrato compartido en `packages/shared`)

**Cliente → servidor** (`action` es la route key):

| action | payload | respuesta |
|---|---|---|
| `message` | `{ channelId, text, attachments?, clientId }` | broadcast `message.new` a todos (incluido emisor) |
| `history` | `{ channelId, cursor? }` | `history.page { channelId, items[], nextCursor }` solo al emisor |
| `channel` | `{ op: "list" }` \| `{ op: "create", name }` \| `{ op: "dm", withUserId }` | `channel.list { channels[] }` broadcast tras create/dm |
| `presign` | `{ op: "put", channelId, name, contentType, size }` \| `{ op: "get", key }` | `presign.result { url, key, requestId }` solo al emisor |
| `typing` | `{ channelId }` | (ruta creada, handler no-op en MVP) |

**Servidor → cliente:** `{ "type": "message.new" | "history.page" | "channel.list" | "presign.result" | "error", ...payload }`.

Todo payload se valida con **zod** en el handler; payload inválido → `{type:"error", code:"BAD_REQUEST"}` al emisor.

### Restricciones de costo que el stack debe cumplir desde el primer `cdk deploy`

- Lambda: `architecture: ARM_64`, `memorySize: 256`, `runtime: NODEJS_20_X`, bundling esbuild (`NodejsFunction`), sin VPC, sin provisioned concurrency.
- CloudWatch: `logRetention: 7 días`, nivel INFO (nunca DEBUG en prod).
- CloudFront: `PriceClass.PRICE_CLASS_100`, compresión, cache 1 año para assets con hash, `index.html` sin cache.
- DynamoDB: `BillingMode.PAY_PER_REQUEST`, TTL en `connections`, sin PITR.
- Cognito: user pool estándar, `selfSignUpEnabled: false`, sin advanced security.
- `Tags.of(app).add("project", "slack")` en toda la app CDK.
- `aws_budgets.CfnBudget` de USD 5 con alertas al 80 % y 100 % a carlos@mindfultech.ec.
- Secrets/config en SSM Parameter Store estándar (si hiciera falta); nada en Secrets Manager.
- Dos stacks del mismo código: `SlackDev` (se destruye al terminar la sesión) y `SlackProd` (único permanente).

---

## 2. Estructura del Proyecto (Scaffolding)

Monorepo con **pnpm workspaces**. Un solo `pnpm install`, un solo `pnpm deploy:prod`.

```
slack/
├── .github/
│   └── workflows/
│       ├── ci.yml                 # lint + typecheck + unit tests en cada PR
│       └── deploy.yml             # merge a main → cdk deploy SlackProd + sync S3 + invalidación CloudFront
├── apps/
│   ├── web/                       # React 18 + Vite + TypeScript + Tailwind (SPA, sin SSR)
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── .env.example           # VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx            # router: /login | /app/:channelId
│   │       ├── lib/
│   │       │   ├── auth.ts        # wrapper de aws-amplify/auth: signIn, getToken, signOut
│   │       │   ├── ws.ts          # cliente WebSocket: conexión, backoff, send(action), on(type)
│   │       │   ├── upload.ts      # presign → PUT a S3 → devuelve attachment
│   │       │   └── markdown.ts    # negrita/cursiva/código/links (regex, sin lib pesada)
│   │       ├── store/
│   │       │   └── index.ts       # zustand: user, channels, messagesByChannel, cursors, unread, activeChannel
│   │       ├── components/
│   │       │   ├── LoginPage.tsx
│   │       │   ├── Sidebar.tsx    # lista de canales + DMs + badge no leídos + crear canal
│   │       │   ├── ChannelView.tsx# header + MessageList + Composer
│   │       │   ├── MessageList.tsx# scroll infinito hacia arriba, IntersectionObserver
│   │       │   ├── MessageItem.tsx# avatar inicial, nombre, hora, texto renderizado, adjuntos
│   │       │   ├── Composer.tsx   # textarea, Enter envía, Shift+Enter salto, drag&drop + paste
│   │       │   └── Attachment.tsx # img inline (GET firmado) o chip de descarga
│   │       └── styles.css
│   └── desktop/                   # (Fase 5, opcional) Tauri que carga https://slack.mindfultech.ec
├── packages/
│   └── shared/                    # tipos + schemas zod del protocolo, usados por web y backend
│       └── src/
│           ├── protocol.ts        # ClientAction (zod), ServerEvent (types), constantes
│           └── ids.ts             # dmChannelId(a,b), isDm(), GENERAL_CHANNEL_ID
├── backend/
│   ├── src/
│   │   ├── handlers/
│   │   │   ├── authorizer.ts      # REQUEST authorizer: valida ?token= con aws-jwt-verify
│   │   │   ├── connect.ts
│   │   │   ├── disconnect.ts
│   │   │   ├── message.ts
│   │   │   ├── history.ts
│   │   │   ├── channel.ts
│   │   │   ├── presign.ts
│   │   │   └── typing.ts          # no-op que responde 200
│   │   └── lib/
│   │       ├── ddb.ts             # DocumentClient + nombres de tabla desde env
│   │       ├── broadcast.ts       # postToAll(event) con limpieza de 410 Gone
│   │       ├── s3.ts              # presign put/get
│   │       ├── response.ts        # ok(), badRequest(), reply(connectionId, event)
│   │       └── logger.ts          # console JSON, nivel por env LOG_LEVEL
│   ├── test/                      # Vitest + aws-sdk-client-mock
│   │   ├── message.test.ts
│   │   ├── history.test.ts
│   │   ├── channel.test.ts
│   │   ├── presign.test.ts
│   │   ├── connect.test.ts
│   │   └── authorizer.test.ts
│   └── vitest.config.ts
├── infra/                         # AWS CDK v2 (TypeScript)
│   ├── bin/slack.ts               # instancia SlackStack con stage = dev | prod
│   ├── lib/
│   │   ├── slack-stack.ts         # orquesta los constructs
│   │   ├── auth.ts                # Cognito User Pool + client
│   │   ├── data.ts                # 3 tablas DynamoDB
│   │   ├── storage.ts             # bucket adjuntos (CORS, lifecycle) + bucket web
│   │   ├── api.ts                 # WebSocketApi + rutas + Lambdas + authorizer + custom domain
│   │   ├── web.ts                 # CloudFront + OAC + BucketDeployment + custom domain
│   │   └── cost.ts                # Budget USD 5, tags
│   ├── cdk.json
│   └── scripts/seed-general.ts    # crea ch_general si no existe (se corre post-deploy)
├── docs/
│   └── requerimientos.md          # el documento original
├── BLUEPRINT.md                   # este archivo
├── README.md                      # git clone + README = proyecto levantado
├── package.json                   # scripts raíz: dev, test, lint, deploy:dev, deploy:prod, destroy:dev
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .gitignore
```

**Scripts raíz (package.json):**

```json
{
  "scripts": {
    "dev": "pnpm --filter web dev",
    "build": "pnpm -r build",
    "test": "pnpm --filter backend test",
    "lint": "pnpm -r lint && pnpm -r typecheck",
    "deploy:dev": "pnpm --filter infra cdk deploy SlackDev --require-approval never",
    "deploy:prod": "pnpm --filter infra cdk deploy SlackProd --require-approval never",
    "destroy:dev": "pnpm --filter infra cdk destroy SlackDev --force"
  }
}
```

---

## 3. Estrategia Git Flow (versión acelerada, 24 h)

Git Flow clásico tiene `main`, `develop`, `feature/*`, `release/*`, `hotfix/*`. Lo usamos completo pero con ramas que viven **horas, no días**.

### Ramas

| Rama | Rol | Protección |
|---|---|---|
| `main` | Lo que está en producción. Solo recibe merges de `release/*` o `hotfix/*`. | Protegida: PR obligatorio, CI verde, 1 aprobación (Carlos o Rene) |
| `develop` | Integración. Todo feature se mezcla aquí. Siempre debe compilar. | PR obligatorio, CI verde |
| `feature/<fase>-<nombre>` | Una rama por Fase del plan (sección 4). Nace de `develop`, muere al mezclarse. | — |
| `release/v0.1.0` | Se abre mañana al mediodía desde `develop`. Solo fixes, README, versión. Se mezcla a `main` **y** a `develop`, se etiqueta `v0.1.0`. | — |
| `hotfix/<nombre>` | Solo después del release, desde `main`. Se mezcla a `main` y `develop`. | — |

### Cronograma de commits

```
HOY (8 oct)
  main ──●  "chore: initial commit" (ya existe)
          └── develop ──●  "chore: scaffold monorepo"            ← Fase 1
                        ├── feature/f1-scaffold-infra  ──PR──►  develop
                        ├── feature/f2-backend-handlers ──PR──►  develop
                        └── feature/f3-web-client       ──PR──►  develop

MAÑANA (9 oct)
  develop ──● feature/f4-prod-deploy ──PR──► develop
          └── release/v0.1.0  ──PR──►  main  (tag v0.1.0)  +  merge back a develop
                                        └── GitHub Actions deploy.yml → SlackProd
```

### Reglas operativas

1. **Convencional commits**: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `infra:`. Un commit por unidad lógica; Opus debe commitear al cerrar cada sub-paso de una Fase.
2. **Squash merge** de `feature/*` → `develop` (historial limpio). **Merge commit** (no squash) de `release/*` → `main` para conservar la trazabilidad.
3. **CI (`ci.yml`) corre en cada PR**: `pnpm lint` + `pnpm test`. Nada se mezcla en rojo.
4. **Deploy (`deploy.yml`) corre solo en push a `main`**: build web → `cdk deploy SlackProd` → `aws s3 sync` → invalidación CloudFront. Credenciales por OIDC (rol IAM asumible por GitHub Actions), nunca access keys en secrets.
5. **Stack dev**: cada sesión de trabajo termina con `pnpm destroy:dev`. Está en el checklist del PR.
6. Carlos y Rene trabajan en features distintas al mismo tiempo (p. ej. Rene F2 backend, Carlos F3 web) y se sincronizan por el contrato de `packages/shared` (F1 lo deja cerrado primero).
7. Cada bug encontrado en la prueba manual → issue en GitHub → rama `fix/<issue>` desde `develop` (antes del release) o `hotfix/` desde `main` (después).

### Comandos de arranque (hoy)

```bash
git clone https://github.com/crpozo/slack.git && cd slack
git checkout -b develop && git push -u origin develop
# en GitHub: Settings → Branches → proteger main y develop (require PR + status checks)
git checkout -b feature/f1-scaffold-infra
```

---

## 4. Plan de Acción para Opus 5.5 — Fases de Código

Cada fase es un prompt. Pégalo tal cual, precedido de: *"Lee BLUEPRINT.md en la raíz del repo. Estás en la rama `feature/<...>`. Implementa exactamente la Fase N. No implementes nada de las fases siguientes ni de la columna 'Queda para v0.2'. Al terminar, ejecuta los criterios de aceptación y haz commits convencionales."*

Tiempos estimados asumiendo que Opus genera el código y tú supervisas: F1 2 h · F2 3 h · F3 5 h · F4 2 h · F5 2 h (opcional). Total ≈ 12–14 h de trabajo efectivo.

---

### FASE 1 — Scaffold del monorepo + contrato compartido + infraestructura CDK desplegable

**Rama:** `feature/f1-scaffold-infra` · **Entrega:** `pnpm deploy:dev` levanta todo el stack vacío en AWS.

**Instrucciones para Opus:**

1. Crea el monorepo con pnpm workspaces siguiendo el árbol de la sección 2 (todas las carpetas, aunque algunos archivos queden como stubs). `tsconfig.base.json` estricto, ESLint + Prettier mínimos, Node 20.
2. `packages/shared/src/protocol.ts`: define con **zod** los schemas de cada `action` del cliente (`message`, `history`, `channel`, `presign`, `typing`) y los tipos TypeScript de cada evento del servidor (`message.new`, `history.page`, `channel.list`, `presign.result`, `error`). Exporta `Message`, `Channel`, `Attachment`. Límites: `text` máx. 4000 chars, `size` máx. 25 MB, `name` de canal `^[a-z0-9-]{1,32}$`.
3. `packages/shared/src/ids.ts`: `GENERAL_CHANNEL_ID = "ch_general"`, `dmChannelId(a, b)` (ordena alfabéticamente), `isDmChannel(id)`, `newMessageSk()` → `${Date.now()}#${ulid()}`.
4. `infra/` con CDK v2 TypeScript. Un `SlackStack` parametrizado por `stage` (`dev` | `prod`). Constructs:
   - **auth.ts**: `UserPool` con `selfSignUpEnabled: false`, login por email, password policy mínima 8 chars, `UserPoolClient` sin secret, auth flows `USER_SRP_AUTH` y `REFRESH_TOKEN_AUTH`. Sin advanced security.
   - **data.ts**: tablas `slack-${stage}-messages` (PK `channelId` S, SK `sk` S), `slack-${stage}-connections` (PK `connectionId` S, TTL attr `ttl`), `slack-${stage}-channels` (PK `channelId` S). Todas `PAY_PER_REQUEST`, `RemovalPolicy.DESTROY` en dev y `RETAIN` en prod.
   - **storage.ts**: bucket `attachments` privado, `blockPublicAccess: ALL`, CORS `PUT, GET` desde `*` (se restringe al dominio en F4), lifecycle → `GLACIER_INSTANT_RETRIEVAL` a los 90 días. Bucket `web` privado para la SPA.
   - **api.ts**: `WebSocketApi` con `routeSelectionExpression: "$request.body.action"`. Un `NodejsFunction` por handler de `backend/src/handlers/*.ts` (ARM_64, 256 MB, NODEJS_20_X, `logRetention: ONE_WEEK`, env con nombres de tablas, bucket y `WS_ENDPOINT`). `WebSocketLambdaAuthorizer` tipo REQUEST sobre `$connect` con `identitySource: ["route.request.querystring.token"]`. Rutas: `$connect`, `$disconnect`, `message`, `history`, `channel`, `presign`, `typing`. Stage `prod` con auto-deploy. Permisos: `grantManageConnections` a message/channel; lectura/escritura de tablas según necesidad; `grantPut`/`grantRead` del bucket a presign.
   - **web.ts**: `Distribution` con origen S3 vía **OAC**, `PriceClass.PRICE_CLASS_100`, `defaultRootObject: index.html`, error 403/404 → `/index.html` 200 (SPA routing), compresión on. `BucketDeployment` que sube `apps/web/dist` con `cacheControl` 1 año para `/assets/*` y `no-cache` para `index.html`. (El custom domain y certificado se añaden en F4.)
   - **cost.ts**: `Tags.of(this).add("project","slack")`; `CfnBudget` de USD 5 mensual con notificaciones a `carlos@mindfultech.ec` al 80 % y 100 % (solo en `prod`).
   - `CfnOutput` de: `UserPoolId`, `UserPoolClientId`, `WebSocketUrl`, `CloudFrontUrl`, `AttachmentsBucket`.
5. `backend/src/handlers/*.ts`: **stubs** que devuelven `{statusCode: 200}` para que el stack compile y despliegue. La lógica real es F2.
6. `infra/scripts/seed-general.ts`: PutItem condicional de `ch_general` (`name: "general"`, `type: "public"`). Scripts `deploy:dev` / `deploy:prod` lo ejecutan tras el deploy.
7. `.github/workflows/ci.yml`: en PR a `develop` y `main` → `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`. Node 20, cache pnpm.
8. `README.md` inicial: prerequisitos (Node 20, pnpm, AWS CLI con perfil), `pnpm install`, `pnpm deploy:dev`, cómo crear los dos usuarios en Cognito desde consola (`aws cognito-idp admin-create-user` + `admin-set-user-password --permanent`), cómo copiar outputs a `apps/web/.env`.

**Criterios de aceptación F1:**
- `pnpm install && pnpm lint` en verde.
- `pnpm deploy:dev` termina sin errores y muestra los 5 outputs.
- `wscat -c "<WebSocketUrl>?token=basura"` es rechazado (401/403) — el authorizer stub debe devolver **Deny** por defecto.
- Se pueden crear los dos usuarios en Cognito con los comandos del README.
- `pnpm destroy:dev` destruye todo sin dejar recursos huérfanos (verificar que los buckets tienen `autoDeleteObjects` en dev).

---

### FASE 2 — Handlers de Lambda con lógica real + tests unitarios

**Rama:** `feature/f2-backend-handlers` · **Entrega:** backend completo testeado contra mocks; verificable con `wscat` contra el stack dev.

**Instrucciones para Opus:**

1. **`lib/`** en `backend/src`:
   - `ddb.ts`: `DynamoDBDocumentClient` singleton; nombres de tabla desde `process.env`.
   - `response.ts`: `ok()`, `badRequest()`, `reply(connectionId, event)` (usa `ApiGatewayManagementApiClient` con `endpoint = WS_ENDPOINT`).
   - `broadcast.ts`: `broadcast(event)` → Scan de `connections` (son ≤ 2 filas, un Scan es aceptable a esta escala), `PostToConnection` en paralelo con `Promise.allSettled`; en `GoneException` (410) borra la conexión.
   - `s3.ts`: `presignPut(key, contentType, size)` y `presignGet(key)` con `@aws-sdk/s3-request-presigner`, `expiresIn: 300`.
   - `logger.ts`: `log.info/warn/error` en JSON; `debug` solo si `LOG_LEVEL=debug`.
2. **`authorizer.ts`**: `CognitoJwtVerifier.create({ userPoolId, tokenUse: "id", clientId })` de `aws-jwt-verify`. Lee `event.queryStringParameters.token`. Devuelve policy `Allow` con `context: { userId: sub, email }`; cualquier error → `Deny`. Cachea el verifier fuera del handler.
3. **`connect.ts`**: lee `userId`/`email` de `event.requestContext.authorizer`, PutItem en `connections` con `ttl = now + 2h`.
4. **`disconnect.ts`**: DeleteItem de `connections`.
5. **`message.ts`**: parsea `JSON.parse(event.body)` con el schema zod de `shared`; construye `Message` con `messageId = ulid()`, `sk = newMessageSk()`, `userId`, `userEmail` (del authorizer context guardado en `connections` — hacer GetItem de la conexión para obtener `userId`/`email`), `createdAt`; PutItem en `messages`; `broadcast({ type: "message.new", message, clientId })`. Si el `channelId` no existe en `channels` → error `CHANNEL_NOT_FOUND`.
6. **`history.ts`**: Query `channelId = :c`, `ScanIndexForward: false`, `Limit: 50`, `ExclusiveStartKey` decodificado desde `cursor` (base64 del LastEvaluatedKey). Responde `history.page { channelId, items (en orden cronológico ascendente), nextCursor }` solo al emisor.
7. **`channel.ts`**: `op: "list"` → Scan de `channels` filtrando `archived <> true`, incluye públicos y los DMs donde el `userId` participe; `op: "create"` → valida nombre único (GetItem por `ch_<ulid>` no sirve para unicidad por nombre: hacer Scan y comparar `name`, aceptable con < 50 canales), PutItem, broadcast `channel.list`; `op: "dm"` → PutItem condicional de `dm_<a>_<b>` con `type: "dm"`, `members: [a, b]`, broadcast `channel.list`.
8. **`presign.ts`**: `op: "put"` → valida `size ≤ 25 MB`, sanea `name` (solo `[a-zA-Z0-9._-]`), key `attachments/${channelId}/${ulid()}-${name}`, responde `presign.result { url, key, requestId }`; `op: "get"` → valida que `key` empiece por `attachments/`, responde URL GET.
9. **`typing.ts`**: responde 200, sin broadcast (se activa en v0.2).
10. **Tests (Vitest + `aws-sdk-client-mock`)** en `backend/test/`: un archivo por handler. Cubrir: payload inválido → error BAD_REQUEST; `message` persiste y hace broadcast; `history` pagina y devuelve `nextCursor`; `channel.create` rechaza nombre duplicado; `dm` genera el mismo id sin importar el orden; `presign.put` rechaza > 25 MB; `authorizer` deniega token inválido (mockear `CognitoJwtVerifier`). Objetivo: todos los handlers con al menos un caso feliz y uno de error.
11. Actualiza `infra/lib/api.ts` si algún handler necesita permisos adicionales (p. ej. `message` necesita `GetItem` en `connections` y `channels`).

**Criterios de aceptación F2:**
- `pnpm test` en verde, cobertura de todos los handlers.
- Contra el stack dev, con dos terminales `wscat -c "<url>?token=<idToken real>"`:
  - `{"action":"channel","op":"list"}` devuelve `#general`.
  - `{"action":"message","channelId":"ch_general","text":"hola","clientId":"x"}` en la terminal A aparece como `message.new` en la terminal B en < 1 s.
  - `{"action":"history","channelId":"ch_general"}` devuelve el mensaje.
  - `{"action":"presign","op":"put",...}` devuelve una URL con la que `curl -X PUT --upload-file foto.png "<url>"` responde 200.
- Logs en CloudWatch en JSON nivel INFO, retención 7 días.

> Para obtener un `idToken` real en pruebas: `aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH ...` (habilitar `USER_PASSWORD_AUTH` en el client solo en dev) o un script `backend/scripts/get-token.ts` con `amazon-cognito-identity-js`.

---

### FASE 3 — Cliente web (React + Vite): login, canales, mensajes en tiempo real, historial, adjuntos

**Rama:** `feature/f3-web-client` · **Entrega:** la SPA funciona en `pnpm dev` contra el stack dev y en el CloudFront de dev.

**Instrucciones para Opus:**

1. **Setup**: Vite + React 18 + TypeScript + Tailwind. Dependencias: `aws-amplify` (solo `aws-amplify/auth`), `zustand`, `react-router-dom`, `ulid`, `@mindfultech/shared` (workspace). Configura Amplify en `main.tsx` con `VITE_COGNITO_USER_POOL_ID` y `VITE_COGNITO_CLIENT_ID`.
2. **`lib/auth.ts`**: `signIn(email, password)`, `getIdToken()` (usa `fetchAuthSession`, que refresca solo), `signOut()`, `getCurrentUser()`. Ruta protegida: si no hay sesión → `/login`.
3. **`lib/ws.ts`** — clase `WsClient`:
   - `connect()`: obtiene idToken, abre `new WebSocket(`${VITE_WS_URL}?token=${token}`)`.
   - `send(action, payload)`: `JSON.stringify({ action, ...payload })`; si el socket no está abierto, encola y envía al reconectar.
   - `on(type, handler)` para eventos del servidor.
   - **Reconexión con backoff exponencial** (1 s, 2 s, 4 s… máx. 30 s, con jitter) en `onclose`; nunca en bucle apretado. Al reconectar, vuelve a pedir `channel.list` y el `history` del canal activo.
   - Heartbeat: nada (API Gateway cierra a los 10 min de inactividad / 2 h máx.; la reconexión lo cubre).
4. **`store/index.ts`** (zustand): `user`, `channels[]`, `activeChannelId`, `messagesByChannel: Record<id, Message[]>`, `cursors: Record<id, string|null>`, `lastReadTs: Record<id, number>` (persistido en localStorage), `unreadCount(id)` = mensajes con `createdAt > lastReadTs[id]` que no son míos. Al recibir `message.new`: si es del canal activo y la ventana tiene foco → marca leído; si no → incrementa unread.
5. **Componentes**:
   - `LoginPage`: email + password, errores de Cognito en español, redirige a `/app/ch_general`.
   - `Sidebar`: secciones "Canales" y "Mensajes directos"; cada ítem con badge de no leídos; botón "+" abre un prompt para crear canal (`channel create`); el DM se crea con `channel dm` hacia el otro usuario (lista de usuarios: hardcodear los dos emails en `VITE_USERS` por ahora — es un MVP de 2 personas). Resalta canal activo. Cmd/Ctrl+K: paleta rápida para saltar de canal (filtra por nombre).
   - `ChannelView`: header con `#nombre` o email del DM; `MessageList`; `Composer`.
   - `MessageList`: al montar pide `history`; renderiza ascendente; `IntersectionObserver` en el primer elemento → si `cursors[id]` no es null, pide la siguiente página y **conserva la posición de scroll** al prepender. Al llegar `message.new` con el scroll al fondo → auto-scroll; si no, muestra pill "↓ mensajes nuevos". Agrupa mensajes consecutivos del mismo autor en < 5 min.
   - `MessageItem`: avatar = inicial del email, nombre (parte local del email), hora `HH:mm`, texto por `markdown.ts`, lista de `Attachment`.
   - `Composer`: `textarea` auto-height; Enter envía, Shift+Enter salto de línea; drag & drop y `onPaste` de imágenes/archivos → `upload.ts`; muestra chips de adjuntos pendientes con progreso; deshabilita envío mientras sube. Envía `message` con `clientId = ulid()` y hace **optimistic insert** (estado `pending`), que se reconcilia cuando llega el `message.new` con el mismo `clientId`.
   - `Attachment`: si `contentType` empieza por `image/` → pide `presign get` y renderiza `<img>` (máx. 320 px de alto, click abre en nueva pestaña); si no → chip con nombre, tamaño y botón de descarga (pide `presign get` al hacer click y abre la URL).
   - `markdown.ts`: `**negrita**`, `_cursiva_`, `` `código` ``, bloques ``` ```, URLs → `<a target=_blank rel=noopener>`. Escapar HTML **antes** de aplicar las regex (nunca `dangerouslySetInnerHTML` con texto sin escapar). Emojis: el usuario los escribe con el teclado del SO; no se incluye picker.
6. **`lib/upload.ts`**: `uploadFile(file, channelId)` → valida 25 MB en cliente → `presign put` → `fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type } })` → devuelve `Attachment { key, name, size, contentType }`.
7. **UI**: estilo tipo Slack (sidebar oscura, área de mensajes clara), pero sin perder tiempo en pixel-perfect. Tailwind utilitario, sin librería de componentes.
8. **Build**: `pnpm --filter web build` genera `dist/` con assets hasheados; `infra` lo despliega.

**Criterios de aceptación F3:**
- Login con cada usuario; recargar la página mantiene la sesión.
- Dos navegadores (Carlos / Rene): un mensaje aparece en el otro en < 1 s.
- Scroll hacia arriba carga páginas anteriores sin saltos.
- Arrastrar una imagen de 5 MB → se sube, aparece inline en ambos lados; un PDF de 20 MB → chip descargable; un archivo de 30 MB → error en cliente antes de subir.
- Cerrar el Wi-Fi 20 s y reabrirlo → reconecta solo y recupera los mensajes perdidos (vía `history`).
- Badge de no leídos sube en canales no activos y se limpia al entrar.
- Usuario sin cuenta → Cognito rechaza, no se abre socket.

---

### FASE 4 — Producción: dominios, certificado, pipeline de deploy, README final → release v0.1.0

**Rama:** `feature/f4-prod-deploy` → luego `release/v0.1.0` · **Entrega:** `https://slack.mindfultech.ec` funcionando con `wss://ws.mindfultech.ec`.

**Instrucciones para Opus:**

1. **Certificado**: en `infra/lib/web.ts` y `api.ts`, para `stage === "prod"`, importar un certificado ACM por ARN (`CERT_ARN` desde contexto CDK). El certificado se crea **a mano** en ACM `us-east-1` para `slack.mindfultech.ec` y `ws.mindfultech.ec` (un solo cert con dos SANs), validación DNS → Carlos crea los CNAMEs de validación en Namecheap. Documentar en README el paso exacto.
2. **CloudFront custom domain**: `domainNames: ["slack.mindfultech.ec"]`, `certificate`. Output `CloudFrontDomain`.
3. **API Gateway custom domain**: `DomainName` para `ws.mindfultech.ec` con el mismo cert, `ApiMapping` al stage. Output `WsDomainTarget` (el `regionalDomainName`).
4. **DNS en Namecheap** (manual, Carlos): `slack` CNAME → `<dist>.cloudfront.net`; `ws` CNAME → `<regionalDomainName>`. Documentar.
5. **CORS del bucket de adjuntos**: restringir `allowedOrigins` a `https://slack.mindfultech.ec` en prod (y `http://localhost:5173` + dominio CloudFront en dev).
6. **`deploy.yml`**: en push a `main`: OIDC → `aws-actions/configure-aws-credentials` con rol `GitHubDeployRole` (crearlo en `infra/lib/cost.ts` o un construct `ci.ts`: trust policy con `token.actions.githubusercontent.com`, condición `repo:crpozo/slack:ref:refs/heads/main`); `pnpm install`; `pnpm build` (web lee `.env.production` con las URLs de prod); `pnpm deploy:prod`; el `BucketDeployment` ya invalida CloudFront (`distribution` + `distributionPaths: ["/*"]`).
7. **Hardening mínimo**: `message` rechaza `text` vacío sin adjuntos; `presign get` solo si el `key` existe; `authorizer` loguea el `sub` en INFO pero nunca el token.
8. **Cost Anomaly Detection**: `CfnAnomalyMonitor` + `CfnAnomalySubscription` (email a Carlos) en `cost.ts`, solo prod.
9. **README final** con las secciones: Qué es · Arquitectura (enlazar BLUEPRINT.md) · Prerrequisitos · Primer deploy (cert → CNAMEs → `deploy:prod` → crear usuarios) · Desarrollo local (`deploy:dev`, `.env`, `pnpm dev`, `destroy:dev`) · Git Flow · Tests · Costos y alertas · Roadmap v0.2 (la columna derecha de la sección 0).
10. Bump de versión `0.1.0` en todos los `package.json`. `CHANGELOG.md` con lo incluido.

**Criterios de aceptación F4 (= criterios de aceptación del MVP):**
- `https://slack.mindfultech.ec` carga con candado verde; `wss://ws.mindfultech.ec` conecta.
- Un mensaje llega al otro usuario en < 1 s desde dos computadoras distintas.
- Recargar muestra el historial completo.
- Adjunto de 25 MB sube, se ve y se descarga; acceder a la URL del objeto sin firma → 403.
- Conexión sin JWT → rechazada. Usuario inexistente → no entra.
- `git clone` + README son suficientes para levantar un stack dev desde cero.
- Budget de USD 5 y Anomaly Detection visibles en la consola de Billing; todos los recursos con tag `project=slack`.
- Sesión manual de 30 min entre Carlos y Rene; fallos anotados como issues.
- Merge `release/v0.1.0` → `main`, tag `v0.1.0`, pipeline en verde, merge back a `develop`.

---

### FASE 5 (opcional, solo si el MVP está en `main` antes de las 15:00) — Desktop app con Tauri

**Rama:** `feature/f5-tauri` (nace de `develop` después del release; va a v0.1.1).

**Instrucciones para Opus:**

1. `apps/desktop` con Tauri 2: ventana única que carga `https://slack.mindfultech.ec` (config `app.windows[0].url`), tamaño 1200×800, título "MindfulTech Slack". **Sin** segundo frontend.
2. Plugins: `tauri-plugin-notification` (notificación nativa cuando llega `message.new` y la ventana no tiene foco — el frontend web detecta `window.__TAURI__` y lo usa; si no existe, usa la Notification API del navegador), `tauri-plugin-autostart`. Bandeja del sistema con "Abrir" y "Salir"; cerrar la ventana la oculta en lugar de salir.
3. `.github/workflows/desktop.yml`: en tag `v*`, matriz `macos-latest` + `windows-latest`, `tauri-apps/tauri-action` publica `.dmg` y `.msi` como assets del release. Sin firma de código por ahora (documentar el aviso de Gatekeeper/SmartScreen en README).
4. Badge en dock/taskbar y Cmd/Ctrl+F quedan para v0.2.

**Criterio de aceptación F5:** el `.dmg` y el `.msi` del release abren la app, muestran el login y reciben una notificación nativa con la ventana en segundo plano.

---

## 5. Checklist de cierre de mañana

- [ ] `main` = `v0.1.0`, protegida, CI y deploy en verde
- [ ] Stack `SlackProd` único; `SlackDev` destruido
- [ ] Dos usuarios creados en Cognito, ambos han hecho login desde su computadora
- [ ] Prueba manual de 30 min hecha, issues abiertos con etiqueta `v0.2`
- [ ] README verificado por la persona que **no** escribió el código
- [ ] Carlos revisa Cost Explorer filtrando por `project=slack` (debe mostrar centavos)
