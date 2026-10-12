# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [0.1.0] — 2026-10-09

First release (MVP): an internal Slack for two people, serverless on AWS `us-east-1`.

### Added

- **Authentication:** Cognito login (email + password, SRP), persistent session, no
  self-sign-up. WebSocket authorizer that validates the id token and denies by default.
- **Channels:** `#general` by default, creating public channels, 1:1 DMs (private to their two
  participants) and a `Ctrl/⌘ + K` palette to jump between channels.
- **Real-time messaging** over API Gateway WebSocket (< 1 s), optimistic sending with retry,
  basic formatting (bold, italic, code, code blocks and links).
- **History** paginated backwards with infinite scroll that keeps the scroll position.
- **Attachments** up to 25 MB with S3 presigned URLs (PUT with signed type and size, GET only
  if the file exists), inline images and download for everything else.
- **Unread:** badge per channel and a total in the tab title.
- **Reconnection** with exponential backoff and recovery of missed messages.
- **UI** in React + Vite + Tailwind with the MindfulTech design system, responsive.
- **CDK infrastructure:** `SlackDev` and `SlackProd` stacks; Node 22 ARM Lambdas with least
  privilege; on-demand DynamoDB; web app on private S3 + CloudFront (OAC, HTTPS, security
  headers) built by `cdk deploy`, with `config.json` generated on every deploy.
- **Custom domains** (optional: `slack.mindfultech.ec`, `ws.mindfultech.ec`) with an existing
  ACM certificate and optional Route 53 records.
- **CORS** for attachments limited to the app origins and `localhost`.
- **Costs:** `project=slack` tag, a USD 5/month Budget and Cost Anomaly Detection with email
  alerts.
- **CI/CD:** lint + tests on every PR; `SlackProd` deploy on every push to `main` via GitHub
  OIDC (no access keys).

[0.1.0]: https://github.com/crpozo/slack/releases/tag/v0.1.0
