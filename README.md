# slack

Slack interno de MindfulTech: canales, DMs y adjuntos en tiempo real sobre AWS serverless
(Cognito + API Gateway WebSocket + Lambda + DynamoDB + S3 + CloudFront).

El plan completo, la arquitectura y el alcance del MVP están en [BLUEPRINT.md](./BLUEPRINT.md).

> **Estado:** Fase 4 (hosting) — la web se compila y se publica en S3 + CloudFront con cada
> `pnpm deploy:dev`, conectada automáticamente al backend del mismo stack.

## Estructura

```
apps/web          SPA React + Vite + Tailwind (design system MindfulTech)
packages/shared   Contrato del protocolo WebSocket (zod) + helpers de ids
backend           Handlers Lambda (Node 22) + tests Vitest
infra             AWS CDK v2: stacks SlackDev y SlackProd
```

## Prerrequisitos

- Node 22 (`nvm use` lee `.nvmrc`)
- pnpm 10 (`corepack enable`)
- AWS CLI v2 con un perfil configurado para la cuenta destino, región `us-east-1`
  (`export AWS_PROFILE=<perfil>`)

## Puesta en marcha

```bash
pnpm install
pnpm lint      # ESLint + typecheck + Prettier
pnpm test      # Vitest (shared + backend)
```

### Primer deploy en dev

```bash
pnpm bootstrap     # solo la primera vez por cuenta/región (cdk bootstrap)
pnpm deploy:dev    # build web → cdk deploy SlackDev → seed de #general
```

`cdk deploy` compila `apps/web` (Vite) durante el synth, sube `dist/` al bucket privado y lo
sirve por CloudFront (HTTPS, OAC, cabeceras de seguridad, rutas SPA). Los assets con hash se
cachean 1 año; `index.html` y `config.json` nunca, y cada deploy invalida CloudFront.

La web no lleva URLs ni ids de Cognito compilados: CDK escribe `/config.json` con el
`WebSocketUrl`, `UserPoolId` y `UserPoolClientId` de **ese** stack, y la SPA lo lee al arrancar
(en `pnpm dev` no existe y se usan las `VITE_*` de `apps/web/.env`). La lista de personas para
DMs sale de `VITE_USERS` en tu `.env` local, o de la variable `WEB_USERS` al desplegar
(`WEB_USERS="a@x.ec=sub,b@x.ec=sub" pnpm deploy:dev`).

Al terminar, CDK imprime 5 outputs: `UserPoolId`, `UserPoolClientId`, `WebSocketUrl`,
`CloudFrontUrl` (la app publicada) y `AttachmentsBucket`. Para volver a verlos:

```bash
aws cloudformation describe-stacks --stack-name SlackDev \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
```

### Crear los usuarios en Cognito

El registro público está deshabilitado: los usuarios se crean a mano. Repite por cada persona
(contraseña de al menos 8 caracteres):

```bash
POOL_ID=<UserPoolId>
EMAIL=<email>

aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --password '<contraseña>' \
  --permanent
```

### Configurar y levantar la web

```bash
cp apps/web/.env.example apps/web/.env
```

| Variable                    | Valor                                      |
| --------------------------- | ------------------------------------------ |
| `VITE_WS_URL`               | output `WebSocketUrl`                      |
| `VITE_COGNITO_USER_POOL_ID` | output `UserPoolId`                        |
| `VITE_COGNITO_CLIENT_ID`    | output `UserPoolClientId`                  |
| `VITE_USERS`                | equipo para los DMs: `email=sub,email=sub` |

El `sub` (id de Cognito) de cada persona sale de:

```bash
aws cognito-idp list-users --user-pool-id <UserPoolId> \
  --query "Users[].[Attributes[?Name=='email'].Value|[0], Attributes[?Name=='sub'].Value|[0]]" \
  --output text
```

Si a alguien le falta el `sub`, su DM aparece deshabilitado hasta que la app lo aprenda de un
mensaje suyo en un canal.

```bash
pnpm dev     # http://localhost:5173
```

La UI: login con email y contraseña (la sesión persiste al recargar), canales y DMs en la barra
lateral con badge de no leídos, `+` para crear canal, `Ctrl/⌘ + K` para saltar de canal, Enter
envía y Shift + Enter hace salto de línea, y se puede arrastrar, pegar o adjuntar archivos de
hasta 25 MB. En móvil la barra lateral es un menú desplegable.

### Probar el WebSocket con `wscat`

Sin token válido la conexión se rechaza:

```bash
npx wscat -c "<WebSocketUrl>?token=basura"   # → 403 (Deny)
npx wscat -c "<WebSocketUrl>"                # → 401 (sin token)
```

Con un id token real (el client de dev acepta `USER_PASSWORD_AUTH` solo para esto):

```bash
TOKEN=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id <UserPoolClientId> \
  --auth-parameters USERNAME=<email>,PASSWORD='<contraseña>' \
  --query AuthenticationResult.IdToken --output text)

npx wscat -c "<WebSocketUrl>?token=$TOKEN"
```

Mensajes de prueba (abre dos terminales para ver el broadcast):

```json
{"action":"channel","op":"list"}
{"action":"message","channelId":"ch_general","text":"hola","clientId":"x"}
{"action":"history","channelId":"ch_general"}
{"action":"presign","op":"put","requestId":"r1","channelId":"ch_general","name":"foto.png","contentType":"image/png","size":12345}
```

Para subir con la URL prefirmada, `Content-Type` y el tamaño deben coincidir con lo pedido:
`curl -X PUT -H "Content-Type: image/png" --upload-file foto.png "<url>"`. Una `action`
desconocida responde `{"type":"error","code":"BAD_REQUEST"}` (ruta `$default`).

### Destruir dev

Cada sesión de trabajo termina con:

```bash
pnpm destroy:dev
```

En dev, tablas, user pool, buckets (con `autoDeleteObjects`) y log groups se eliminan con el
stack (`destroy:dev` no compila la web: pasa `-c skipWebBuild=true`). En prod (`SlackProd`) todo se conserva (`RETAIN`) y el stack tiene protección contra
borrado.

## Scripts

| Script             | Qué hace                                               |
| ------------------ | ------------------------------------------------------ |
| `pnpm dev`         | Vite dev server de la web                              |
| `pnpm build`       | Build de todos los paquetes                            |
| `pnpm lint`        | ESLint + `tsc --noEmit` + Prettier en todo el monorepo |
| `pnpm test`        | Tests unitarios                                        |
| `pnpm deploy:dev`  | Build web + deploy de `SlackDev` + seed de `#general`  |
| `pnpm deploy:prod` | Build web + deploy de `SlackProd` + seed de `#general` |
| `pnpm destroy:dev` | Destruye `SlackDev`                                    |

## Flujo de ramas

`feature/*` (o `fix/*`) nace de `main` y vuelve a `main` por PR con squash merge; no hay
`develop`. Commits convencionales (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `infra:`). CI
(`pnpm lint` + `pnpm test`) corre en cada PR a `main`. Las versiones son tags sobre `main`.
Detalle en la sección 3 de [BLUEPRINT.md](./BLUEPRINT.md).

## Costos

Todos los recursos llevan el tag `project=slack`. `SlackProd` crea un AWS Budget de USD 5/mes
con alertas por email al 80 % y 100 % (el destinatario se puede cambiar con la clave de
contexto `budgetEmail` en `infra/cdk.json`).
