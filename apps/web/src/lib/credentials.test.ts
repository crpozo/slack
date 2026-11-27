import { describe, expect, it } from "vitest";
import {
  credentialKind,
  detectCredentials,
  isHighEntropy,
  secretParts,
  vaultDraftOf,
} from "./credentials";

describe("detectCredentials", () => {
  it.each([
    // Email + password (space or line break)
    ["admin@company.com MyP@ssw0rd", "email-password"],
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
    ["P@ssw0rd2026!", "token"],
    ["Nombre123#", "token"],
    ["Password2026!", "token"],
    ["Nombre123", "token"], // three kinds are enough: no symbol needed
    ["Aa1Aa1Aa1", "token"], // complexity, not randomness
    // A password among the words of a sentence
    ["usa Nombre123# para entrar", "inline"],
    ["la contraseña nueva es Nombre123#", "inline"],
    ["try `Tr0ub4dor&3` on staging", "inline"],
    ["it's P@ssw0rd2026!, change it soon", "inline"],
    ["PASSWORD2026!", "token"], // no lowercase: three kinds all the same
    ["hunter2!", "token"], // eight characters with its "!"
    ["`Tr0ub4dor&3`", "token"],
    ["the wifi password: Casa2024", "keyword"],
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
    // A sentence that gets to a password: the whole message isn't a secret
    "Here is the password: password123",
    "the password is hunter22 but change it today",
    "Remember to rotate the API key: AKIAIOSFODNN7EXAMPLE",
    // Several lines: notes, Markdown, code, never one password
    "carlos@mindfultech.ec\nTr0ub4dor&3",
    "password: Casa2024\nuser: admin",
    "# Setup\n\n- Set `API_KEY=sk-ant-api03-xY9fQ2mZ7pLk4rT8vW1`\n- **password**: Sup3rS3cret!\n\n```\nroot Tr0ub4dor&3\n```",
    // Words with three kinds of characters that aren't passwords
    "the new iPhone15 is out, McDonald's later?",
    "Great job on Sprint12! See GitHub-Actions for the run",
    "we use Node.js and TypeScript5.4 with **React19**",
    "it costs USD$1,500.00 or R$7500.50 in Brazil",
    "call useState<Map2>() or set limit=Max10; in the config",
    "see src/components/Sidebar2.tsx and ask @Carlos2024",
    // Codes in capitals aren't passwords
    "ISO-27001:2022",
    "ISO/IEC-27001",
    // Accented letters are letters, not symbols
    "Averigüu",
    "Averigüe",
    "Mañanaaa",
    "Pingüino",
  ])("leaves %j alone", (text) => {
    expect(detectCredentials(text)).toBe(false);
  });

  it("keeps to the length of a password or key: 8 to 200 characters", () => {
    const key = (n: number) => "aB3$xY9!kQ7#mZ2&".repeat(Math.ceil(n / 16)).slice(0, n);
    expect(detectCredentials(key(200))).toBe(true);
    expect(detectCredentials(key(201))).toBe(false);
    expect(detectCredentials("Ab1!xyz")).toBe(false);
    // A long message with a label in it is a message.
    expect(detectCredentials(`password: ${"word ".repeat(45)}Casa2024`)).toBe(false);
    // A signed token (JWT) is longer than that and still one.
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJ${"c3ViIjoiMTIzNDU2Nzg5MCJ9".repeat(20)}.sig-_nature`;
    expect(jwt.length).toBeGreaterThan(200);
    expect(credentialKind(jwt)).toBe("token");
  });

  it("ignores the line break Enter leaves at the end", () => {
    expect(credentialKind("P@ssw0rd2026!\n")).toBe("token");
  });

  it("flags a password of 8 to 64 characters with three of the four kinds", () => {
    expect(detectCredentials("Nombre123#")).toBe(true);
    expect(detectCredentials("Password2026!")).toBe(true);
    expect(isHighEntropy("Nombre123#")).toBe(true);
    expect(isHighEntropy("Nombre12")).toBe(true); // 8
    expect(isHighEntropy("Nombre1")).toBe(false); // 7
    expect(isHighEntropy("nombre123")).toBe(false); // two kinds
    expect(isHighEntropy(`Nombre123#${"a".repeat(54)}`)).toBe(true); // 64
    expect(isHighEntropy(`Nombre123#${"a".repeat(55)}`)).toBe(false); // 65, not random either
    expect(isHighEntropy("Nombre 123#")).toBe(false);
    expect(detectCredentials("Nombre123#\nPassword2026!")).toBe(false);
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

describe("vaultDraftOf (Phase 72)", () => {
  it("reads a name, the account and the password from a secret message", () => {
    expect(vaultDraftOf("Acme\n\nana@example.com\nXk9vRQHDTaLqz", "x")).toEqual({
      name: "Acme",
      username: "ana@example.com",
      password: "Xk9vRQHDTaLqz",
    });
    expect(vaultDraftOf("ana@example.com Xk9vRQHDTaLqz", "Shared in #dev")).toEqual({
      name: "ana@example.com",
      username: "ana@example.com",
      password: "Xk9vRQHDTaLqz",
    });
    expect(vaultDraftOf("Xk9vRQHDTaLqz7Pw2", "Shared in #dev")).toEqual({
      name: "Shared in #dev",
      password: "Xk9vRQHDTaLqz7Pw2",
    });
  });

  it("is nothing when no single value is clearly the password", () => {
    expect(vaultDraftOf("hola equipo, nos vemos mañana", "x")).toBeNull();
    expect(vaultDraftOf("password: abc12345\ntoken: zzz99999", "x")).toBeNull();
  });
});
