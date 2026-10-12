import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import type { z } from "zod";
import { errorFields, log } from "./logger";

export type HttpEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type HttpResult = APIGatewayProxyResultV2<never>;

/** An error that maps to an HTTP status and a message the client may show. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new HttpError(404, what);
export const forbidden = (message: string) => new HttpError(403, message);

export function json(status: number, body?: unknown): HttpResult {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  };
}

export interface HttpCaller {
  userId: string;
  email: string;
}

/** The user behind the request, from the Cognito id token the JWT authorizer verified. */
export function callerOf(event: HttpEvent): HttpCaller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const userId = claims.sub;
  const email = claims.email;
  if (typeof userId !== "string" || !userId) throw new HttpError(401, "Unauthorized");
  return { userId, email: typeof email === "string" ? email : "" };
}

/** Parses the JSON body against `schema`; invalid JSON or shape is a 400. */
export function parseBody<T extends z.ZodType>(schema: T, event: HttpEvent): z.infer<T> {
  let raw: unknown;
  try {
    const text = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    raw = JSON.parse(text || "null");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new HttpError(400, `${where}${issue?.message ?? "Invalid request"}`);
  }
  return result.data;
}

export function pathParam(event: HttpEvent, name: string): string {
  const value = event.pathParameters?.[name];
  if (!value) throw new HttpError(400, `Missing ${name}`);
  return value;
}

/**
 * Wraps an HTTP route handler: `HttpError`s become their status with a JSON
 * `{ message }`; anything else is logged and answered as a 500.
 */
export function httpHandler(fn: (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>) {
  return async (event: HttpEvent): Promise<HttpResult> => {
    const { routeKey } = event;
    try {
      const caller = callerOf(event);
      return await fn(event, caller);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status >= 500) log.error("request failed", { routeKey, ...errorFields(err) });
        return json(err.status, { message: err.message });
      }
      log.error("handler failed", { routeKey, ...errorFields(err) });
      return json(500, { message: "Something went wrong" });
    }
  };
}
