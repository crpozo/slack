// Deterministic environment for every test file (no real AWS calls are made).
Object.assign(process.env, {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
  AWS_SECRET_ACCESS_KEY: "test-secret",
  MESSAGES_TABLE: "slack-test-messages",
  CONNECTIONS_TABLE: "slack-test-connections",
  CHANNELS_TABLE: "slack-test-channels",
  ATTACHMENTS_BUCKET: "slack-test-attachments",
  WS_ENDPOINT: "https://abc123.execute-api.us-east-1.amazonaws.com/prod",
  USER_POOL_ID: "us-east-1_TEST",
  USER_POOL_CLIENT_ID: "test-client",
  LOG_LEVEL: "error",
});
delete process.env.AWS_SESSION_TOKEN;
