import { describe, expect, it } from "vitest";
import { credentialKind, detectCredentials, isHighEntropy, secretParts } from "./credentials";

describe("detectCredentials", () => {
  it.each([
    // Email + password (space or line break)
    ["admin@company.com MyP@ssw0rd", "email-password"],
    ["carlos@mindfultech.ec\nTr0ub4dor&3", "email-password"],
    ["usuario: ana.perez@empresa.ec / Clave2024!", "email-password"],
    // Username + password
    ["root Tr0ub4dor&3", "user-password"],
    ["admin / S3cret!!", "user-password"],
    ["usuario: admin123 pass: hunter22", "user-password"],
    // Keywords
    ["contraseña: hola1234", "keyword"],
    ["la clave es Sol2024!", "keyword"],
    ["password: perro", "keyword"],
    ["pwd = Xy7#kq", "keyword"],
    ["pwd=Xy7#kq", "token"], // no spaces: the whole message is one value
    ["Contraseña del wifi: Casa2024", "keyword"],
    ["API key: AKIAIOSFODNN7EXAMPLE", "keyword"],
    // The whole message is one random-looking string
    ["MyP@ssw0rd", "token"],
    ["Summer2024!", "token"],
    ["Pingüino2024!", "token"], // an accented password still counts
    ["sk-ant-api03-xY9fQ2mZ7pLk4rT8vW1", "token"],
    ["AKIAIOSFODNN7EXAMPLE", "token"],
    // A URL carrying a login
    ["db: postgres://app:S3cr3tPw@db.internal:5432/main", "url"],
  ])("flags %j (%s)", (text, kind) => {
    expect(credentialKind(text)).toBe(kind);
    expect(detectCredentials(text)).toBe(true);
  });

  it.each([
    "hola, ¿cómo estás?",
    "the password is wrong",
    "I forgot my password again",
    "Necesito resetear mi password: ¿cómo lo hago?",
    "the secret: nobody knows it",
    "write to carlos@mindfultech.ec tomorrow",
    "carlos@mindfultech.ec, ana@mindfultech.ec",
    "the root cause is the cache",
    "admin panel is down",
    "PROJ-1234",
    "COVID-19",
    "v2.10.3-beta",
    "report_v2.pdf",
    "user_id_2",
    "https://github.com/crpozo/slack/pull/62",
    "2026-10-27",
    "+593 99 123 4567",
    "Kubernetes",
    "#general",
    "@carlos",
    "ok",
    "",
    "Meeting at 10:30, room B2",
    "I'll pass on that",
    // Accented letters are letters, not symbols
    "Averigüu",
    "Averigüe",
    "Mañanaaa",
    "Pingüino",
  ])("leaves %j alone", (text) => {
    expect(detectCredentials(text)).toBe(false);
  });

  it("measures randomness: mixed character kinds, not just length", () => {
    expect(isHighEntropy("aaaaaaaaaaaaaaaa")).toBe(false);
    expect(isHighEntropy("password")).toBe(false);
    expect(isHighEntropy("Passw0rd")).toBe(true);
    expect(isHighEntropy("Short1!")).toBe(false); // 7 characters
  });
});

describe("secretParts", () => {
  it("splits an email and a password on one line", () => {
    expect(secretParts("admin@company.com MyP@ssw0rd")).toEqual([
      { label: "Email", value: "admin@company.com" },
      { label: "Password", value: "MyP@ssw0rd" },
    ]);
  });

  it("splits a username and a password, and lines by their own labels", () => {
    expect(secretParts("root Tr0ub4dor&3")).toEqual([
      { label: "User", value: "root" },
      { label: "Password", value: "Tr0ub4dor&3" },
    ]);
    expect(secretParts("Email: ana@empresa.ec\nContraseña: Sol2024!\n\nhost=db.internal")).toEqual([
      { label: "Email", value: "ana@empresa.ec" },
      { label: "Contraseña", value: "Sol2024!" },
      { label: "host", value: "db.internal" },
    ]);
  });

  it("keeps a single value, a URL and a sentence whole", () => {
    expect(secretParts("MyP@ssw0rd")).toEqual([{ label: null, value: "MyP@ssw0rd" }]);
    expect(secretParts("postgres://app:S3cr3t@db/main")).toEqual([
      { label: null, value: "postgres://app:S3cr3t@db/main" },
    ]);
    expect(secretParts("the wifi password is on the fridge")).toEqual([
      { label: null, value: "the wifi password is on the fridge" },
    ]);
  });

  it("gives one part per line for several values, labeled when it can tell", () => {
    expect(secretParts("abc123XYZ\nsecond-Token-9\nnotes here")).toEqual([
      { label: "Password", value: "abc123XYZ" },
      { label: "Password", value: "second-Token-9" },
      { label: null, value: "notes here" },
    ]);
  });

  it("groups accounts under their names: 'Name:' lines and a first-line title are headings", () => {
    const text = [
      "Example Group",
      "Acme Store:",
      "ana@example.com",
      "Sample123!",
      "Bob Smith:",
      "bob@example.org",
      "Demo2020!!",
    ].join("\n");
    expect(secretParts(text)).toEqual([
      { label: null, value: "Example Group", heading: true },
      { label: null, value: "Acme Store", heading: true },
      { label: "Email", value: "ana@example.com" },
      { label: "Password", value: "Sample123!" },
      { label: null, value: "Bob Smith", heading: true },
      { label: "Email", value: "bob@example.org" },
      { label: "Password", value: "Demo2020!!" },
    ]);
    // A label with its value on the next line: the label heads it, the value stays copyable.
    expect(secretParts("API key:\nexample-Key-123")).toEqual([
      { label: null, value: "API key", heading: true },
      { label: "Password", value: "example-Key-123" },
    ]);
  });
});
