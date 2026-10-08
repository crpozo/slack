import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";

/** F1 stub — the real `disconnect` logic lands in F2. */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async () => ({ statusCode: 200 });
