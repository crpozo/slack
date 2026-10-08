# slack

Slack interno de MindfulTech: canales, DMs y adjuntos en tiempo real sobre AWS serverless
(Cognito + API Gateway WebSocket + Lambda + DynamoDB + S3 + CloudFront).

El plan completo, la arquitectura y el alcance del MVP están en [BLUEPRINT.md](./BLUEPRINT.md).

> **Estado:** Fase 1 — scaffold, contrato compartido e infraestructura. Los handlers son stubs
> (el authorizer **deniega** toda conexión) y la web es un placeholder.

## Estructura

```
apps/web          SPA React + Vite (placeholder hasta F3)
packages/shared   Contrato del protocolo WebSocket (zod) + helpers de ids
backend           Handlers Lambda (stubs hasta F2) + tests Vitest
infra             AWS CDK v2: stacks SlackDev y SlackProd
```

## Prerrequisitos

- Node 20.19+ (`nvm use` lee `.nvmrc`)
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

Al terminar, CDK imprime 5 outputs: `UserPoolId`, `UserPoolClientId`, `WebSocketUrl`,
`CloudFrontUrl` y `AttachmentsBucket`. Para volver a verlos:

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

### Configurar la web

```bash
cp apps/web/.env.example apps/web/.env
```

Rellena `VITE_WS_URL` con `WebSocketUrl`, `VITE_COGNITO_USER_POOL_ID` con `UserPoolId` y
`VITE_COGNITO_CLIENT_ID` con `UserPoolClientId`. Luego `pnpm dev` (http://localhost:5173).

### Comprobar el authorizer

```bash
npx wscat -c "<WebSocketUrl>?token=basura"   # → error 403 (Deny)
npx wscat -c "<WebSocketUrl>"                # → error 401 (sin token)
```

### Destruir dev

Cada sesión de trabajo termina con:

```bash
pnpm destroy:dev
```

En dev, tablas, user pool, buckets (con `autoDeleteObjects`) y log groups se eliminan con el
stack. En prod (`SlackProd`) todo se conserva (`RETAIN`) y el stack tiene protección contra
borrado.

## Scripts

| Script             | Qué hace                                               |
| ------------------ | ------------------------------------------------------ |
| `pnpm dev`         | Vite dev server de la web                              |
| `pnpm build`       | Build de todos los paquetes                            |
| `pnpm lint`        | ESLint + `tsc --noEmit` + Prettier en todo el monorepo |
| `pnpm test`        | Tests unitarios                                        |
| `pnpm deploy:dev`  | Deploy de `SlackDev` + seed de `#general`              |
| `pnpm deploy:prod` | Deploy de `SlackProd` + seed de `#general`             |
| `pnpm destroy:dev` | Destruye `SlackDev`                                    |

## Git Flow

`main` (producción) ← `release/*` ← `develop` (integración) ← `feature/*`. Commits
convencionales (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `infra:`). CI (`pnpm lint` +
`pnpm test`) corre en cada PR a `develop` y `main`. Detalle en la sección 3 de
[BLUEPRINT.md](./BLUEPRINT.md).

## Costos

Todos los recursos llevan el tag `project=slack`. `SlackProd` crea un AWS Budget de USD 5/mes
con alertas por email al 80 % y 100 % (el destinatario se puede cambiar con la clave de
contexto `budgetEmail` en `infra/cdk.json`).
