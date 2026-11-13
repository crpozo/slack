import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The network, mocked: DNS answers, and http(s).get responses the test scripts.
const net = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PassThrough } = require("node:stream") as typeof import("node:stream");
  const state = {
    dns: new Map<string, string[]>(),
    responses: [] as Array<{ status: number; headers: Record<string, string>; body?: string }>,
    requested: [] as string[],
    get: (url: URL, _opts: unknown, onResponse: (res: unknown) => void) => {
      state.requested.push(url.toString());
      const next = state.responses.shift() ?? { status: 404, headers: {} };
      const res = Object.assign(new PassThrough(), {
        statusCode: next.status,
        headers: next.headers,
      });
      queueMicrotask(() => {
        onResponse(res);
        res.end(next.body ?? "");
      });
      return { on: () => {} };
    },
  };
  return state;
});
vi.mock("node:dns", () => ({
  lookup: (host: string, _opts: unknown, cb: (e: Error | null, a: unknown) => void) => {
    const found = net.dns.get(host);
    if (!found) return cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
    cb(
      null,
      found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  },
}));
vi.mock("node:http", () => ({ default: { get: net.get } }));
vi.mock("node:https", () => ({ default: { get: net.get } }));

import { handler } from "../src/handlers/link-preview";
import type { HttpEvent } from "../src/lib/http";
import {
  allowedTarget,
  cacheKey,
  fetchPage,
  isPublicAddress,
  linkPreview,
  parsePreview,
  safeLookup,
} from "../src/lib/linkPreview";
import { ALICE, ddbMock, resetMocks } from "./helpers";

const HTML = `<!doctype html><html><head>
  <title>  Fallback title </title>
  <meta property="og:title" content="Acme &amp; Co launches Zeta">
  <meta property="og:description" content="A   new model,
    cheaper.">
  <meta property="og:image" content="/img/card.png">
  <meta property="og:site_name" content="Acme Blog">
</head><body>${"x".repeat(100)}</body></html>`;

beforeEach(() => {
  resetMocks();
  process.env.LINK_PREVIEWS_TABLE = "slack-test-link-previews";
  net.dns.clear();
  net.responses.length = 0;
  net.requested.length = 0;
  net.dns.set("acme.example", ["93.184.216.34"]);
  ddbMock.on(GetCommand).resolves({});
  ddbMock.on(PutCommand).resolves({});
});

describe("only the public internet is ever fetched (SSRF)", () => {
  it("refuses loopback, private, link-local (metadata), CGNAT, reserved and mapped addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a9fe:a9fe",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::6810:84e5")).toBe(true);
  });

  it("only http(s), default ports, no credentials, no local names or private IPs", () => {
    const ok = (u: string) => allowedTarget(new URL(u));
    expect(ok("https://acme.example/post")).toBe(true);
    expect(ok("http://acme.example:80/")).toBe(true);
    expect(ok("https://acme.example:8443/")).toBe(false);
    expect(ok("ftp://acme.example/")).toBe(false);
    expect(ok("https://user:pw@acme.example/")).toBe(false);
    expect(ok("http://localhost/")).toBe(false);
    expect(ok("http://metadata.google.internal/")).toBe(false);
    expect(ok("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(ok("http://[::1]/")).toBe(false);
  });

  it("the DNS lookup itself refuses a name with any non-public address (no rebinding gap)", async () => {
    net.dns.set("sneaky.example", ["93.184.216.34", "10.0.0.5"]);
    const look = (host: string, all: boolean) =>
      new Promise<{ err: Error | null; result: unknown }>((resolve) =>
        safeLookup(
          host,
          { all } as never,
          ((err: Error | null, result: unknown) => resolve({ err, result })) as never,
        ),
      );
    expect((await look("sneaky.example", true)).err?.name).toBe("BlockedAddressError");
    expect((await look("acme.example", true)).result).toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
    expect((await look("acme.example", false)).result).toBe("93.184.216.34");
  });

  it("a redirect to a private address is never followed", async () => {
    net.responses.push({ status: 302, headers: { location: "http://169.254.169.254/latest/" } });
    expect(await fetchPage("https://acme.example/r")).toBeNull();
    expect(net.requested).toEqual(["https://acme.example/r"]);
  });

  it("at most 3 redirects; only HTML answered 200", async () => {
    for (let i = 0; i < 5; i++) {
      net.responses.push({ status: 301, headers: { location: `/hop${i}` } });
    }
    expect(await fetchPage("https://acme.example/")).toBeNull();
    expect(net.requested).toHaveLength(4);
    net.responses.length = 0;
    net.responses.push({
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: "%PDF",
    });
    expect(await fetchPage("https://acme.example/file.pdf")).toBeNull();
  });
});

describe("reading the card", () => {
  it("Open Graph first, entities decoded, whitespace collapsed, the image made absolute https", () => {
    expect(parsePreview({ url: "https://www.acme.example/post", html: HTML })).toEqual({
      url: "https://www.acme.example/post",
      title: "Acme & Co launches Zeta",
      description: "A new model, cheaper.",
      image: "https://www.acme.example/img/card.png",
      siteName: "Acme Blog",
      domain: "acme.example",
    });
  });

  it("falls back to <title> and the description meta; nothing at all is no card", () => {
    const html = `<head><title>Plain page</title><meta name="description" content="About it"></head>`;
    expect(parsePreview({ url: "http://acme.example/", html })).toMatchObject({
      title: "Plain page",
      description: "About it",
    });
    expect(parsePreview({ url: "http://acme.example/", html: "<head></head>" })).toBeNull();
    // An http image is asked for over https; anything else is dropped.
    const img = `<head><title>x</title><meta property="og:image" content="http://cdn.example/a.png"></head>`;
    expect(parsePreview({ url: "https://acme.example/", html: img })?.image).toBe(
      "https://cdn.example/a.png",
    );
  });

  it("follows a redirect to the real page and keeps its URL", async () => {
    net.responses.push(
      { status: 301, headers: { location: "https://acme.example/final" } },
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: HTML },
    );
    const page = await fetchPage("http://acme.example/short");
    expect(page?.url).toBe("https://acme.example/final");
    expect(parsePreview(page!)?.title).toBe("Acme & Co launches Zeta");
  });
});

describe("the cache", () => {
  it("a fresh entry answers without fetching; the #fragment doesn't matter", async () => {
    expect(cacheKey("https://acme.example/a#x")).toBe(cacheKey("https://acme.example/a"));
    ddbMock.on(GetCommand).resolves({
      Item: {
        urlKey: "k",
        preview: { url: "u", title: "Cached", domain: "acme.example" },
        expiresAt: 9e9,
      },
    });
    expect((await linkPreview("https://acme.example/a"))?.title).toBe("Cached");
    expect(net.requested).toHaveLength(0);
  });

  it("a miss fetches and keeps a day; a page with nothing (or that failed) an hour", async () => {
    const now = 1_700_000_000_000;
    net.responses.push({ status: 200, headers: { "content-type": "text/html" }, body: HTML });
    await linkPreview("https://acme.example/post", now);
    const kept = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(kept.preview.title).toBe("Acme & Co launches Zeta");
    expect(kept.expiresAt).toBe(now / 1000 + 24 * 3600);

    ddbMock.resetHistory();
    expect(await linkPreview("https://nowhere.example/", now)).toBeNull();
    const empty = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(empty.preview).toBeUndefined();
    expect(empty.expiresAt).toBe(now / 1000 + 3600);
  });
});

describe("GET /utils/link-preview", () => {
  const get = (url?: string) =>
    handler({
      routeKey: "GET /utils/link-preview",
      queryStringParameters: url === undefined ? undefined : { url },
      requestContext: {
        authorizer: { jwt: { claims: { sub: ALICE.userId, email: ALICE.email } } },
      },
    } as unknown as HttpEvent) as Promise<{
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    }>;

  it("answers the card, cached by the browser for an hour", async () => {
    net.responses.push({ status: 200, headers: { "content-type": "text/html" }, body: HTML });
    const r = await get("https://acme.example/post");
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, max-age=3600");
    expect(JSON.parse(r.body).preview.title).toBe("Acme & Co launches Zeta");
  });

  it("refuses what isn't an http(s) link", async () => {
    for (const bad of [
      undefined,
      "",
      "javascript:alert(1)",
      "file:///etc/passwd",
      `https://a.example/${"x".repeat(3000)}`,
    ]) {
      expect((await get(bad)).statusCode, String(bad)).toBe(400);
    }
    expect(net.requested).toHaveLength(0);
  });
});
