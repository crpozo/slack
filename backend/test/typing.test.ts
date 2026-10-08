import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/typing";
import { resetMocks, sentEvents, wsEvent } from "./helpers";

describe("typing", () => {
  beforeEach(resetMocks);

  it("is a no-op in the MVP", async () => {
    const result = await handler(
      wsEvent("typing", { action: "typing", channelId: "ch_general" }),
      {} as never,
      () => {},
    );
    expect(result).toEqual({ statusCode: 200 });
    expect(sentEvents()).toHaveLength(0);
  });
});
