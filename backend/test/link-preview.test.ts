import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPublicAddress,
  linkPreview,
  previewOf,
  publicHttpsUrl,
  resetLinkPreviews,
} from "../src/lib/linkPreview";

// Phase 63: a shared link's preview, read by the server from a hostile address.

const PUBLIC = async () => ["93.184.216.34"];
const page = (head: string) =>
  new Response(`<html><head>${head}</head><body>x</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

beforeEach(() => resetLinkPreviews());

describe("which addresses may be read", () => {
  it("only public ones", () => {
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) {
      expect(isPublicAddress(a), a).toBe(true);
    }
    for (const a of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.4.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it("https, a public host name, no credentials, no odd port, nothing that resolves inside", async () => {
    expect((await publicHttpsUrl("https://example.com/a?b=1", PUBLIC))?.href).toBe(
      "https://example.com/a?b=1",
    );
    for (const url of [
      "http://example.com/",
      "https://user:pass@example.com/",
      "https://example.com:8443/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "https://printer.local/",
      "ftp://example.com/",
      "not a url",
    ]) {
      expect(await publicHttpsUrl(url, PUBLIC), url).toBeNull();
    }
    // A public-looking name that points inside (DNS rebinding's first step).
    expect(await publicHttpsUrl("https://evil.example.com/", async () => ["10.0.0.7"])).toBeNull();
    expect(
      await publicHttpsUrl("https://mixed.example.com/", async () => [
        "93.184.216.34",
        "127.0.0.1",
      ]),
    ).toBeNull();
  });
});

describe("a page's preview", () => {
  it("comes from its Open Graph tags, else its title and description", () => {
    expect(
      previewOf(
        `<meta property="og:title" content="Hola &amp; adiós">
         <meta property="og:description" content="  Una   descripción. ">
         <meta property="og:image" content="/img/cover.jpg">
         <meta property="og:site_name" content="Ejemplo">`,
        "https://www.example.com/post",
      ),
    ).toEqual({
      url: "https://www.example.com/post",
      title: "Hola & adiós",
      description: "Una descripción.",
      image: "https://www.example.com/img/cover.jpg",
      site: "Ejemplo",
    });
    expect(
      previewOf(
        `<title>Solo título</title><meta name="description" content="Desc">`,
        "https://www.example.com/x",
      ),
    ).toEqual({
      url: "https://www.example.com/x",
      title: "Solo título",
      description: "Desc",
      site: "example.com",
    });
    expect(previewOf("<p>nada</p>", "https://example.com/")).toBeNull();
  });

  it("is read once and remembered; a redirect to an inside address is refused", async () => {
    const fetchImpl = vi.fn(async (_url: URL, _init: RequestInit) =>
      page(`<meta property="og:title" content="Título">`),
    );
    const first = await linkPreview("https://example.com/a", fetchImpl as never, PUBLIC);
    expect(first).toMatchObject({ title: "Título", site: "example.com" });
    await linkPreview("https://example.com/a", fetchImpl as never, PUBLIC);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });

    const redirecting = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://inside.example.com/" } }),
    );
    const lookup = async (host: string) =>
      host === "inside.example.com" ? ["10.0.0.1"] : ["93.184.216.34"];
    expect(await linkPreview("https://example.com/r", redirecting as never, lookup)).toBeNull();
    expect(redirecting).toHaveBeenCalledTimes(1);
  });

  it("never throws: an address that isn't allowed, or a page that fails, has no preview", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await linkPreview("https://example.com/down", fetchImpl as never, PUBLIC)).toBeNull();
    expect(
      await linkPreview("http://169.254.169.254/latest", fetchImpl as never, PUBLIC),
    ).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads a post on X from its public oEmbed", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("https://publish.twitter.com/oembed?");
      return Response.json({
        author_name: "Ejemplo (@ejemplo)",
        html: `<blockquote><p lang="en">Presentamos algo nuevo<br>para equipos <a href="https://t.co/x">t.co/x</a></p>&mdash; Ejemplo</blockquote>`,
      });
    });
    expect(await linkPreview("https://x.com/ejemplo/status/1", fetchImpl as never, PUBLIC)).toEqual(
      {
        url: "https://x.com/ejemplo/status/1",
        title: "Ejemplo (@ejemplo) on X",
        description: "Presentamos algo nuevo para equipos t.co/x",
        site: "x.com",
      },
    );
  });
});
