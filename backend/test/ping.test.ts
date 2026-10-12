import { describe, expect, it } from "vitest";
import { handler } from "../src/handlers/ping";
import { apiMock, ddbMock, resetMocks, wsEvent } from "./helpers";

describe("ping", () => {
  it("answers 200 without replying or touching any table", async () => {
    resetMocks();
    const result = await handler(wsEvent("ping", { action: "ping" }), {} as never, () => {});

    expect(result).toEqual({ statusCode: 200 });
    expect(apiMock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });
});
