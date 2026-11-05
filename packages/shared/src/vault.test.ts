import { describe, expect, it } from "vitest";
import {
  canAccessVaultSecret,
  canManageVaultSecret,
  CreateVaultSecretSchema,
  generatePassword,
  MAX_VAULT_ALLOWED,
  SetVaultPinSchema,
  VAULT_PIN_MAX_ATTEMPTS,
  vaultLockMs,
  vaultPinProblem,
  VaultPinSchema,
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

describe("who may see a secret (Phase 46)", () => {
  const secret = { createdBy: "u-owner", allowedUserIds: ["u-ana"] };

  it("admins see everything; staff only what they saved or are listed in", () => {
    expect(canAccessVaultSecret(secret, "u-anyone", "admin")).toBe(true);
    expect(canAccessVaultSecret(secret, "u-owner", "member")).toBe(true);
    expect(canAccessVaultSecret(secret, "u-ana", "member")).toBe(true);
    expect(canAccessVaultSecret(secret, "u-bob", "member")).toBe(false);
    expect(
      canAccessVaultSecret({ createdBy: "u-owner", allowedUserIds: [] }, "u-ana", "member"),
    ).toBe(false);
  });

  it("never lets a guest in, even one listed or its saver", () => {
    expect(canAccessVaultSecret(secret, "u-ana", "guest")).toBe(false);
    expect(canAccessVaultSecret(secret, "u-owner", "guest")).toBe(false);
  });

  it("lets only the saver or an admin manage it", () => {
    expect(canManageVaultSecret(secret, "u-owner", "member")).toBe(true);
    expect(canManageVaultSecret(secret, "u-x", "admin")).toBe(true);
    expect(canManageVaultSecret(secret, "u-ana", "member")).toBe(false);
  });

  it("dedupes the access list and caps it", () => {
    const base = { channelId: "c", name: "n", password: "p" };
    expect(
      CreateVaultSecretSchema.parse({ ...base, allowedUserIds: ["a", "b", "a"] }).allowedUserIds,
    ).toEqual(["a", "b"]);
    expect(
      CreateVaultSecretSchema.safeParse({
        ...base,
        allowedUserIds: Array.from({ length: MAX_VAULT_ALLOWED + 1 }, (_, i) => `u${i}`),
      }).success,
    ).toBe(false);
  });
});

describe("the Vault PIN (Phase 46)", () => {
  it("takes exactly four digits, and refuses ones anybody would guess first", () => {
    expect(vaultPinProblem("4821")).toBeNull();
    expect(vaultPinProblem("2580")).toBeNull();
    for (const weak of ["0000", "7777", "1234", "6789", "4321", "9876"]) {
      expect([weak, vaultPinProblem(weak)]).toEqual([weak, expect.stringMatching(/guess/)]);
    }
    expect(vaultPinProblem("123")).toMatch(/4 digits/);
    expect(vaultPinProblem("12a4")).toMatch(/4 digits/);
    expect(SetVaultPinSchema.safeParse({ pin: "1234" }).success).toBe(false);
    expect(SetVaultPinSchema.safeParse({ pin: "4821" }).success).toBe(true);
    // Verifying takes any four digits: a weak PIN set long ago still opens.
    expect(VaultPinSchema.safeParse({ pin: "1234" }).success).toBe(true);
    expect(VaultPinSchema.safeParse({ pin: "12345" }).success).toBe(false);
  });

  it("locks for 15 minutes after five wrong PINs, doubling each time up to a day", () => {
    expect(VAULT_PIN_MAX_ATTEMPTS).toBe(5);
    expect(vaultLockMs(0)).toBe(15 * 60_000);
    expect(vaultLockMs(1)).toBe(30 * 60_000);
    expect(vaultLockMs(3)).toBe(2 * 3_600_000);
    expect(vaultLockMs(20)).toBe(24 * 3_600_000);
  });
});
