# slack

Slack interno de MindfulTech: canales, DMs y adjuntos en tiempo real sobre AWS serverless
(Cognito + API Gateway WebSocket + Lambda + DynamoDB + S3 + CloudFront).

El plan completo, la arquitectura y el alcance del MVP están en [BLUEPRINT.md](./BLUEPRINT.md).

> **Versión 0.1.0 (MVP).** Cambios en [CHANGELOG.md](./CHANGELOG.md).

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
stack (`destroy:dev` no compila la web: pasa `-c skipWebBuild=true`). En prod (`SlackProd`)
todo se conserva (`RETAIN`) y el stack tiene protección contra borrado.

## Producción

### 1. Certificado y DNS (a mano, una sola vez)

1. En **ACM `us-east-1`**, solicita un certificado público para `slack.mindfultech.ec` y
   `ws.mindfultech.ec` (un certificado, dos nombres) con validación DNS.
2. En Namecheap, crea los CNAME de validación que muestra ACM y espera al estado _Issued_.

### 2. Primer deploy

```bash
export CERT_ARN=arn:aws:acm:us-east-1:<cuenta>:certificate/<id>
export WEB_USERS="persona1@mindfultech.ec=<sub>,persona2@mindfultech.ec=<sub>"
pnpm deploy:prod
```

Sin `CERT_ARN`, `SlackProd` se despliega igual y se sirve en los hostnames de CloudFront y
execute-api; con él, CloudFront responde en `slack.mindfultech.ec`, el WebSocket en
`wss://ws.mindfultech.ec` y `config.json` apunta a ese dominio.

| Contexto (`-c`)         | Variable de entorno        | Para qué                                     |
| ----------------------- | -------------------------- | -------------------------------------------- |
| `certificateArn`        | `CERT_ARN`                 | Activa los dominios propios                  |
| `appDomain`             | `SLACK_APP_DOMAIN`         | Por defecto `slack.mindfultech.ec` en prod   |
| `wsDomain`              | `SLACK_WS_DOMAIN`          | Por defecto `ws.mindfultech.ec` en prod      |
| `hostedZoneId`          | `HOSTED_ZONE_ID`           | Crea alias en Route 53 (si el DNS está allí) |
| `hostedZoneName`        | `HOSTED_ZONE_NAME`         | Por defecto el dominio padre                 |
| `webUsers`              | `WEB_USERS`                | Directorio de DMs en `config.json`           |
| `githubOidcProviderArn` | `GITHUB_OIDC_PROVIDER_ARN` | Reusar un proveedor OIDC de GitHub existente |

### 3. DNS de la app

Con el DNS en Namecheap, crea dos CNAME con los outputs del deploy:

- `slack` → `AppDnsTarget` (`<id>.cloudfront.net`)
- `ws` → `WsDnsTarget` (`d-<id>.execute-api.us-east-1.amazonaws.com`)

Si el dominio estuviera en Route 53, pasa `HOSTED_ZONE_ID` y CDK crea los registros.

### 4. Usuarios

Crea las dos cuentas con los comandos de [Crear los usuarios en Cognito](#crear-los-usuarios-en-cognito)
usando el `UserPoolId` de `SlackProd`.

### 5. Deploy continuo (GitHub Actions)

`.github/workflows/deploy.yml` despliega `SlackProd` en cada push a `main` (lint + tests →
`pnpm deploy:prod`). Se autentica por **OIDC** con el rol `slack-github-deploy` que crea el
propio stack, sin access keys en GitHub; el rol solo puede asumir los roles de bootstrap de CDK
y sembrar `#general`, y solo desde `main` de `crpozo/slack`.

Tras el primer deploy manual, en _Settings → Secrets and variables → Actions → Variables_:

- `AWS_DEPLOY_ROLE_ARN` = output `GitHubDeployRoleArn` (sin esta variable el workflow no corre)
- `CERT_ARN`, `WEB_USERS` y, si aplica, `HOSTED_ZONE_ID` y `GITHUB_OIDC_PROVIDER_ARN`

Si la cuenta ya tenía un proveedor OIDC de GitHub, el primer `deploy:prod` falla al crearlo:
repite con `GITHUB_OIDC_PROVIDER_ARN=arn:aws:iam::<cuenta>:oidc-provider/token.actions.githubusercontent.com`.

Como todo merge a `main` llega a producción, prueba cada cambio en `SlackDev` antes de aprobar
el PR.

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
(`pnpm lint` + `pnpm test`) corre en cada PR a `main`. Detalle en la sección 3 de
[BLUEPRINT.md](./BLUEPRINT.md).

Las versiones son tags anotados sobre `main` con su entrada en `CHANGELOG.md`:

```bash
git checkout main && git pull
git tag -a v0.1.0 -m "v0.1.0 — MVP"
git push origin v0.1.0
```

## Costos y alertas

Todos los recursos llevan el tag `project=slack`. `SlackProd` crea:

- un **AWS Budget** de USD 5/mes con email al 80 % y 100 %;
- **Cost Anomaly Detection**: un monitor sobre el tag `project=slack` y un resumen diario por
  email cuando una anomalía suma ≥ USD 1.

Ambos avisan a `carlos@mindfultech.ec` (clave de contexto `budgetEmail` en `infra/cdk.json`).
Para que el monitor vea el gasto, activa una vez el tag en _Billing → Cost allocation tags_
(`project`); AWS tarda hasta 24 h en aplicarlo.

## Roadmap v0.2

Hilos · renombrar y archivar canales · reacciones · editar y borrar mensajes · búsqueda ·
presencia online · "escribiendo…" · notificaciones del sistema y menciones `@` · llamadas WebRTC ·
app de escritorio (Tauri) · tests de integración y E2E · agente IA con Bedrock.
