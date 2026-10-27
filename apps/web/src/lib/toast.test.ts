import { describe, expect, it } from "vitest";
import { toneOf } from "./toast";

describe("toneOf", () => {
  it.each([
    "Couldn't copy",
    "Couldn't open the image.",
    "Your session expired. Please sign in again.",
    "Couldn't delete the message. Try again.",
    "Too short: hold on a little longer.",
    "Permission denied",
  ])("reads %j as an error", (message) => {
    expect(toneOf(message)).toBe("error");
  });

  it.each(["Copied", "Copied link", "Saved", "Text copied to the clipboard"])(
    "reads %j as a success",
    (message) => expect(toneOf(message)).toBe("success"),
  );

  it.each([
    "That message is further back in the history.",
    "This conversation was deleted.",
    "You're already in a call.",
  ])("reads %j as info", (message) => {
    expect(toneOf(message)).toBe("info");
  });
});
