# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones según
[SemVer](https://semver.org/lang/es/).

## [0.1.0] — 2026-10-09

Primera versión (MVP): un Slack interno para dos personas, serverless en AWS `us-east-1`.

### Añadido

- **Autenticación:** login con Cognito (email + contraseña, SRP), sesión persistente, sin
  auto-registro. Authorizer del WebSocket que valida el id token y deniega por defecto.
- **Canales:** `#general` por defecto, crear canales públicos, DMs 1 a 1 (privados para sus dos
  participantes) y paleta `Ctrl/⌘ + K` para saltar de canal.
- **Mensajería en tiempo real** por API Gateway WebSocket (< 1 s), envío optimista con
  reintento, formato básico (negrita, cursiva, código, bloques y links).
- **Historial** paginado hacia atrás con scroll infinito que conserva la posición.
- **Adjuntos** de hasta 25 MB con URLs prefirmadas de S3 (PUT con tipo y tamaño firmados, GET
  solo si el archivo existe), imágenes inline y descarga del resto.
- **No leídos:** badge por canal y total en el título de la pestaña.
- **Reconexión** con backoff exponencial y recuperación de los mensajes perdidos.
- **Interfaz** React + Vite + Tailwind con el design system de MindfulTech, responsive.
- **Infraestructura CDK:** stacks `SlackDev` y `SlackProd`; Lambdas Node 22 ARM con permisos
  mínimos; DynamoDB on-demand; web en S3 privado + CloudFront (OAC, HTTPS, cabeceras de
  seguridad) compilada por `cdk deploy`, con `config.json` generado en cada deploy.
- **Dominios propios** opcionales (`slack.mindfultech.ec`, `ws.mindfultech.ec`) con certificado
  ACM existente y registros Route 53 opcionales.
- **CORS** de adjuntos limitado a los orígenes de la app y `localhost`.
- **Costos:** tag `project=slack`, Budget de USD 5/mes y Cost Anomaly Detection con alertas por
  email.
- **CI/CD:** lint + tests en cada PR; deploy de `SlackProd` en cada push a `main` vía GitHub
  OIDC (sin access keys).

[0.1.0]: https://github.com/crpozo/slack/releases/tag/v0.1.0
