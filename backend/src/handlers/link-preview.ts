import { isPreviewableUrl, type LinkPreviewResponse } from "@mindfultech/shared";
import { HttpError, httpHandler, notFound, type HttpResult } from "../lib/http";
import { linkPreview } from "../lib/linkPreview";

/**
 * Link previews (Phase 64), on the HTTP API behind the Cognito JWT authorizer:
 *   GET /utils/link-preview?url=…  → `{ preview }` (`null`: nothing to show)
 * Anyone signed in (guests see links in their channels too). The server
 * fetches the page so the browser doesn't run into CORS; see lib/linkPreview
 * for what it will and won't fetch.
 */
export const handler = httpHandler(async (event): Promise<HttpResult> => {
  if (event.routeKey !== "GET /utils/link-preview")
    throw notFound(`No route for ${event.routeKey}`);
  const url = event.queryStringParameters?.url ?? "";
  if (!isPreviewableUrl(url)) throw new HttpError(400, "`url` must be an http(s) link");
  const preview = await linkPreview(url);
  return {
    statusCode: 200,
    // The browser keeps it an hour too: scrolling back up asks nothing again.
    headers: { "content-type": "application/json", "cache-control": "private, max-age=3600" },
    body: JSON.stringify({ preview } satisfies LinkPreviewResponse),
  };
});
