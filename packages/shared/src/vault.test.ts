import { describe, expect, it } from "vitest";
import {
  CreateVaultSecretSchema,
  generatePassword,
  MAX_VAULT_PASSWORD,
  normalizeWebsite,
  parseSecretCommand,
  vaultCardText,
} from "./vault";

describe("the /secret command", () => {
  it("saves `/secret <title> <password>`: the password is the last word", () => {
    expect(parseSecretCommand("/secret AWS prod console S3cr3t!pw")).toEqual({
      kind: "vault",
      name: "AWS prod console",
      password: "S3cr3t!pw",
    });
    expect(parseSecretCommand("  /SECRET Stripe sk_live_123  ")).toEqual({
      kind: "vault",
      name: "Stripe",
      password: "sk_live_123",
    });
  });

  it("drops quotes or brackets around the title and the password", () => {
    expect(parseSecretCommand('/secret "Grafana admin" hunter22')).toMatchObject({
      name: "Grafana admin",
      password: "hunter22",
    });
    expect(parseSecretCommand("/secret [Staging DB] [p@ss]")).toMatchObject({
      name: "Staging DB",
      password: "p@ss",
    });
  });

  it("is the secret mode alone, incomplete with a title only, and nothing else otherwise", () => {
    expect(parseSecretCommand("/secret")).toEqual({ kind: "mode" });
    expect(parseSecretCommand("/secret   ")).toEqual({ kind: "mode" });
    expect(parseSecretCommand("/secret hunter2")).toEqual({ kind: "incomplete" });
    expect(parseSecretCommand("/secrets a b")).toBeNull();
    expect(parseSecretCommand("my /secret a b")).toBeNull();
    expect(parseSecretCommand("/shrug")).toBeNull();
  });

  it("titles the chat card", () => {
    expect(vaultCardText({ name: "AWS prod" })).toBe("🔒 Shared a Secret: AWS prod");
  });
});

describe("generatePassword", () => {
  it("draws every class at least once, at the length asked (16–128)", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(24);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/\d/);
      expect(pw).toMatch(/[!@#$%^&*\-_=+?]/);
      expect(pw).not.toMatch(/[lIO01\s]/);
    }
    expect(generatePassword(4)).toHaveLength(16);
    expect(generatePassword(500)).toHaveLength(128);
    expect(generatePassword(40)).toHaveLength(40);
  });

  it("uses the random source it's given, redrawing bytes that would bias it", () => {
    const counter = () => {
      let n = 0;
      return (bytes: Uint8Array) => {
        bytes[0] = (n++ * 37) % 256;
        return bytes;
      };
    };
    expect(generatePassword(16, counter())).toBe(generatePassword(16, counter()));
    // 25 lowercase letters: bytes 250–255 would favor a–f, so they're drawn again.
    const draws: number[] = [];
    const biased = (bytes: Uint8Array) => {
      bytes[0] = draws.length < 1 ? 252 : 0;
      draws.push(bytes[0]);
      return bytes;
    };
    expect(generatePassword(16, biased)[0]).toBeDefined();
    expect(draws.slice(0, 2)).toEqual([252, 0]);
  });

  it("doesn't repeat itself", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(seen.size).toBe(500);
  });
});

describe("normalizeWebsite", () => {
  it("keeps http(s) links and adds https:// to a bare domain", () => {
    expect(normalizeWebsite("https://console.aws.amazon.com/")).toBe(
      "https://console.aws.amazon.com/",
    );
    expect(normalizeWebsite("grafana.mindfultech.ec/login")).toBe(
      "https://grafana.mindfultech.ec/login",
    );
    expect(normalizeWebsite("http://localhost:3000")).toBe("http://localhost:3000/");
  });

  it("refuses scripts, other schemes and things that aren't addresses", () => {
    expect(normalizeWebsite("javascript:alert(1)")).toBeNull();
    expect(normalizeWebsite("JAVASCRIPT:alert(1)")).toBeNull();
    expect(normalizeWebsite("data:text/html,<b>x</b>")).toBeNull();
    expect(normalizeWebsite("ftp://files.example.com")).toBeNull();
    expect(normalizeWebsite("not a url")).toBeNull();
    expect(normalizeWebsite("intranet")).toBeNull();
    expect(normalizeWebsite("")).toBeNull();
  });
});

describe("CreateVaultSecretSchema", () => {
  const base = { channelId: "ch_general", name: " AWS ", password: " pw with spaces " };

  it("trims the fields but keeps the password exactly as typed", () => {
    expect(
      CreateVaultSecretSchema.parse({ ...base, username: "  ", website: "aws.amazon.com" }),
    ).toEqual({
      channelId: "ch_general",
      name: "AWS",
      username: undefined,
      website: "aws.amazon.com",
      password: " pw with spaces ",
    });
  });

  it("refuses an empty or oversized password and an unsafe website", () => {
    expect(CreateVaultSecretSchema.safeParse({ ...base, password: "   " }).success).toBe(false);
    expect(
      CreateVaultSecretSchema.safeParse({ ...base, password: "x".repeat(MAX_VAULT_PASSWORD + 1) })
        .success,
    ).toBe(false);
    expect(
      CreateVaultSecretSchema.safeParse({ ...base, website: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(CreateVaultSecretSchema.safeParse({ ...base, name: "" }).success).toBe(false);
  });
});
