import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/default";
import { resetMocks, sentEvents, wsEvent } from "./helpers";

describe("$default", () => {
  beforeEach(resetMocks);

  it("answers unknown actions with BAD_REQUEST to the sender only", async () => {
    const result = await handler(wsEvent("$default", { action: "dance" }));

    expect(result.statusCode).toBe(400);
    expect(sentEvents()).toEqual([
      ["conn-alice", expect.objectContaining({ type: "error", code: "BAD_REQUEST" })],
    ]);
  });
});
