import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";

/** No-op in the MVP: typing indicators are enabled in v0.2. */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async () => ({ statusCode: 200 });
