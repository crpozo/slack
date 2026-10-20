import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { emptyCanvas, MAX_CANVAS_BYTES, SaveCanvasSchema, type Canvas } from "@mindfultech/shared";
import { broadcast } from "../lib/broadcast";
import { byteLength, sanitizeCanvas } from "../lib/canvas";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import {
  forbidden,
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";

/**
 * Channel canvas HTTP API (Phase 24): the one document of a conversation,
 * read and saved whole by anyone who can read the channel (an archived
 * channel's is read-only). Saves are last-writer-wins on a version: a save
 * based on an older version is a 409 that carries the current canvas, so
 * the editor can reload it without a second round trip.
 */

async function readCanvas(channelId: string): Promise<Canvas> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.canvases, Key: { channelId } }),
  );
  if (!Item) return emptyCanvas(channelId);
  const row = Item as Partial<Canvas>;
  return {
    channelId,
    content: row.content ?? "",
    version: row.version ?? 0,
    updatedAt: row.updatedAt ?? 0,
    updatedBy: row.updatedBy ?? "",
  };
}

async function channelOf(event: HttpEvent, caller: HttpCaller) {
  const channelId = pathParam(event, "id");
  const channel = await getAccessibleChannel(channelId, caller.userId, { allowArchived: true });
  if (!channel) throw notFound("Channel not found");
  return channel;
}

async function getCanvas(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channel = await channelOf(event, caller);
  return json(200, { canvas: await readCanvas(channel.channelId) });
}

async function saveCanvas(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channel = await channelOf(event, caller);
  if (channel.archived) throw forbidden("This channel is archived: its canvas is read-only");
  const input = parseBody(SaveCanvasSchema, event);
  const content = sanitizeCanvas(input.content);
  if (byteLength(content) > MAX_CANVAS_BYTES) throw new HttpError(400, "The canvas is too long");

  const now = Date.now();
  const next = input.version + 1;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.canvases,
        Key: { channelId: channel.channelId },
        UpdateExpression:
          "SET content = :content, version = :next, updatedAt = :now, updatedBy = :me",
        // Based on the current version: the first save needs no row, later ones the version they saw.
        ConditionExpression:
          input.version === 0 ? "attribute_not_exists(channelId)" : "version = :was",
        ExpressionAttributeValues: {
          ":content": content,
          ":next": next,
          ":now": now,
          ":me": caller.userId,
          ...(input.version > 0 && { ":was": input.version }),
        },
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    const current = await readCanvas(channel.channelId);
    log.info("canvas save refused: stale version", {
      channelId: channel.channelId,
      userId: caller.userId,
      was: input.version,
      current: current.version,
    });
    return json(409, {
      message: "Someone else saved the canvas meanwhile: it was reloaded",
      canvas: current,
    });
  }
  const canvas: Canvas = {
    channelId: channel.channelId,
    content,
    version: next,
    updatedAt: now,
    updatedBy: caller.userId,
  };
  log.info("canvas saved", {
    channelId: channel.channelId,
    userId: caller.userId,
    version: next,
    bytes: byteLength(content),
  });
  // Everyone in the channel learns a new version exists (they fetch it if they show it).
  try {
    const inAudience = channelAudience(channel);
    await broadcast((connection) =>
      inAudience(connection)
        ? {
            type: "canvas.updated",
            channelId: channel.channelId,
            version: next,
            updatedAt: now,
            updatedBy: caller.userId,
          }
        : null,
    );
  } catch (err) {
    log.error("canvas broadcast failed", { channelId: channel.channelId, ...errorFields(err) });
  }
  return json(200, { canvas });
}

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "GET /channels/{id}/canvas": getCanvas,
  "PUT /channels/{id}/canvas": saveCanvas,
};

export const handler = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});
