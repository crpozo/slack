import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";

/**
 * `ping`: heartbeat that keeps the WebSocket alive. API Gateway drops
 * connections idle for 10 minutes; any client frame resets that clock, so
 * there is nothing to do here: no reply (a reply would cost a
 * PostToConnection call) and no table access.
 */
export const handler: APIGatewayProxyWebsocketHandlerV2 = () =>
  Promise.resolve({ statusCode: 200 });
