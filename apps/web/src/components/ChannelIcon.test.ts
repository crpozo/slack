import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelIcon } from "./ChannelIcon";
import { HashIcon, LockIcon } from "./icons";

const inner = (markup: string) => markup.replace(/<svg[^>]*>/, "");
const lock = inner(renderToStaticMarkup(createElement(LockIcon)));
const hash = inner(renderToStaticMarkup(createElement(HashIcon)));
const icon = (type: "public" | "private") =>
  renderToStaticMarkup(createElement(ChannelIcon, { channel: { type } }));

describe("ChannelIcon", () => {
  it("private is always the padlock, whatever else the channel is; public is the hash", () => {
    expect(icon("private")).toContain(lock);
    expect(icon("private")).toContain('aria-label="Private channel"');
    expect(icon("private")).not.toContain(hash);
    expect(icon("public")).toContain(hash);
    expect(icon("public")).not.toContain(lock);
  });
});
