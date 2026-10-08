import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";

/** F1 stub — the real `channel` logic lands in F2. */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async () => ({ statusCode: 200 });
