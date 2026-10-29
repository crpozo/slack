import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelIcon, channelGlyph } from "./ChannelIcon";
import {
  BrowserIcon,
  CodeIcon,
  CoinsIcon,
  HashIcon,
  KanbanIcon,
  LayersIcon,
  LockIcon,
  NewspaperIcon,
  PenToolIcon,
  UsersIcon,
} from "./icons";

const inner = (markup: string) => markup.replace(/<svg[^>]*>/, "");
const lock = inner(renderToStaticMarkup(createElement(LockIcon)));
const hash = inner(renderToStaticMarkup(createElement(HashIcon)));
const icon = (type: "public" | "private", name = "x") =>
  renderToStaticMarkup(createElement(ChannelIcon, { channel: { type, name } }));

describe("ChannelIcon", () => {
  it("public is the hash; private is never the padlock any more, but still says so", () => {
    expect(icon("public", "Nasca Website")).toContain(hash);
    expect(icon("private", "Nasca Website")).not.toContain(lock);
    expect(icon("private", "Nasca Website")).toContain('aria-label="Private channel"');
    expect(icon("private", "Nasca Website")).not.toContain(hash);
  });

  it("reads what a private channel is about from its name", () => {
    const glyph = (name: string, isProject = false) =>
      channelGlyph({ type: "private", name, isProject });
    expect(glyph("AI-News")).toBe(NewspaperIcon);
    expect(glyph("Paymerch Website")).toBe(BrowserIcon);
    expect(glyph("MindfulTech Website")).toBe(BrowserIcon);
    expect(glyph("Cambridge Platform")).toBe(LayersIcon);
    expect(glyph("WFS Draw My Fence")).toBe(PenToolIcon);
    expect(glyph("backend_api")).toBe(CodeIcon);
    expect(glyph("pagos")).toBe(CoinsIcon);
    // Word boundaries: "renewal" isn't news.
    expect(glyph("renewal-team")).toBe(UsersIcon);
    // No telling word: a board for a project channel, people otherwise.
    expect(glyph("Acme", true)).toBe(KanbanIcon);
    expect(glyph("Acme")).toBe(UsersIcon);
    expect(channelGlyph({ type: "private" })).toBe(UsersIcon);
    expect(channelGlyph({ type: "public", name: "AI-News" })).toBe(HashIcon);
  });
});
