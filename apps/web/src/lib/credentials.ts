// ---------------------------------------------------------------------------
// Credentials in messages: spotting them before they're sent in the clear (a
// match goes out as a secret: masked, deleted after 24 hours), and splitting
// a revealed secret into its parts (an email, a password) so each one can be
// copied on its own.
//
// The detector errs on the side of plain text for ordinary messages: a
// false positive hides someone's message and deletes it a day later, so each
// rule needs a credential-looking value, not just a keyword.
// ---------------------------------------------------------------------------

const EMAIL = /^[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}$/i;
const EMAIL_IN_TEXT = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

/** Usernames that mean "an account login" when a password-looking value follows. */
const USERNAMES = [
  "admin",
  "administrator",
  "root",
  "user",
  "usuario",
  "username",
  "login",
  "sa",
  "postgres",
  "ubuntu",
  "ec2-user",
  "guest",
];

/** Words that announce a credential ("password: …", "la clave es …"). */
const KEYWORD =
  /\b(contrase(?:ñ|n)a|password|passwd|passcode|pass|pwd|clave|token|api[ _-]?key|secret|pin)\b/i;

/** Shapes that look random but aren't credentials. */
const NOT_A_CREDENTIAL = [
  /^[a-z][a-z0-9+.-]*:\/\//i, // URLs
  /^www\./i,
  /^[@#]/, // mentions, hashtags
  /^[\w.-]+\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|svg|txt|csv|zip|md|js|ts|tsx|py|json|html?|css)$/i, // files
  /^v?\d+(\.\d+)+([-+][\w.]+)?$/i, // versions
  /^[A-Z][A-Z0-9]{1,9}-\d+$/, // issue keys (PROJ-123)
  /^[a-z]+(_[a-z0-9]+)+$/, // snake_case identifiers
  /^[\d\s.,:/+-]+$/, // numbers, dates, times, phone numbers
];

/** Bits of randomness per character (Shannon entropy). */
function entropyPerChar(token: string): number {
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const classesOf = (token: string) => ({
  lower: /[a-z]/.test(token),
  upper: /[A-Z]/.test(token),
  digit: /\d/.test(token),
  symbol: /[^A-Za-z0-9]/.test(token),
});

/**
 * A password or key: 8+ characters with lowercase and two of uppercase,
 * digits and symbols ("MyP@ssw0rd", "Summer2024!"), or 20+ random characters
 * of two kinds (API keys, "AKIAIOSFODNN7EXAMPLE"); never a URL, file name,
 * version, issue key, identifier or number.
 */
export function isHighEntropy(token: string): boolean {
  if (token.length < 8 || token.length > 256 || /\s/.test(token)) return false;
  if (EMAIL.test(token) || NOT_A_CREDENTIAL.some((re) => re.test(token))) return false;
  const c = classesOf(token);
  const kinds = [c.lower, c.upper, c.digit, c.symbol].filter(Boolean).length;
  const bits = entropyPerChar(token);
  if (c.lower && kinds >= 3 && bits >= 2.5) return true;
  return token.length >= 20 && kinds >= 2 && bits >= 3.5;
}

/**
 * A value after a keyword or username: anything high-entropy, or 6+
 * characters with a digit or symbol ("hola1234", "perro!"); never a plain word.
 */
function isCredentialValue(token: string): boolean {
  if (isHighEntropy(token)) return true;
  if (token.length < 6 || EMAIL.test(token) || NOT_A_CREDENTIAL.some((re) => re.test(token))) {
    return false;
  }
  const c = classesOf(token);
  return (c.lower || c.upper) && (c.digit || c.symbol);
}

/** The value a keyword introduces: "password: x", "pwd=x", "la clave es x", "password is x". */
const KEYWORD_VALUE = new RegExp(
  `${KEYWORD.source}\\s*(?:(?<sep>[:=])\\s*|\\s+(?:is|es|was|era|:)?\\s*)(?<value>\\S+)`,
  "giu",
);

/** "Contraseña del wifi: x": a keyword, up to three more words, then ":" or "=" and the value. */
const KEYWORD_LABEL = new RegExp(
  `${KEYWORD.source}(?:\\s+[^\\s:=]+){0,3}?\\s*[:=]\\s*(?<value>\\S+)`,
  "giu",
);

const strip = (token: string) => token.replace(/^["'`(<[]+|["'`)>\],.;!?]+$/g, "");

export type CredentialKind = "email-password" | "user-password" | "keyword" | "token" | "url";

/** Why `text` looks like it holds a credential, or `null`. */
export function credentialKind(text: string): CredentialKind | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // The whole message is one random-looking string.
  if (!/\s/.test(trimmed) && isHighEntropy(strip(trimmed))) return "token";

  // A URL carrying a login: https://user:pass@host
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(trimmed)) return "url";

  // An email, then (after spaces or a line break) a password.
  for (const match of trimmed.matchAll(EMAIL_IN_TEXT)) {
    const after = trimmed.slice(match.index + match[0].length);
    const next = /^[\s:/|,;-]+(\S+)/.exec(after)?.[1];
    if (next && isCredentialValue(strip(next))) return "email-password";
  }

  // A common username, then a password (separators like "/" skipped).
  const tokens = trimmed
    .split(/\s+/)
    .map(strip)
    .filter((t) => /[\p{L}\d]/u.test(t));
  for (let i = 0; i < tokens.length - 1; i++) {
    const name = tokens[i]!.replace(/[:/=]+$/, "").toLowerCase();
    if (USERNAMES.includes(name) && isCredentialValue(tokens[i + 1]!)) return "user-password";
  }

  // A keyword, then a value. A password-looking value always counts; after ":"
  // or "=", so does any value that ends its line ("password: perro"), but not a
  // sentence going on ("the secret: nobody knows").
  const endsLine = (match: RegExpMatchArray) =>
    trimmed
      .slice(match.index! + match[0].length)
      .split("\n")[0]!
      .trim() === "";
  const explicitValue = (match: RegExpMatchArray) => {
    const value = strip(match.groups?.value ?? "");
    return isCredentialValue(value) || (value.length >= 4 && endsLine(match));
  };
  for (const match of trimmed.matchAll(KEYWORD_VALUE)) {
    if (match.groups?.sep ? explicitValue(match) : isCredentialValue(strip(match.groups!.value!))) {
      return "keyword";
    }
  }
  for (const match of trimmed.matchAll(KEYWORD_LABEL)) {
    if (explicitValue(match)) return "keyword";
  }
  return null;
}

/** Whether `text` likely contains a credential (and should be sent as a secret). */
export function detectCredentials(text: string): boolean {
  return credentialKind(text) !== null;
}

// --- A revealed secret, part by part ------------------------------------------------

export interface SecretPart {
  /** "Email", "User", "Password", or the line's own label ("API key: …"). */
  label: string | null;
  value: string;
}

const LABELED = /^(?<label>[\p{L}][\p{L}\d _.-]{0,29}?)\s*[:=]\s*(?<value>\S.*)$/u;

function labelFor(token: string): string | null {
  if (EMAIL.test(token)) return "Email";
  if (USERNAMES.includes(token.toLowerCase())) return "User";
  if (isCredentialValue(token)) return "Password";
  return null;
}

/**
 * The parts of a secret to copy one by one: each line, a "Label: value" line
 * by its label, and a line of 2–3 tokens with an email, username or password
 * among them split per token ("admin@company.com MyP@ssw0rd" → Email,
 * Password). Anything else stays one part: a single value is shown as before.
 */
export function secretParts(text: string): SecretPart[] {
  const parts: SecretPart[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const labeled = LABELED.exec(line);
    // "https://…" isn't a label "https": a URL stays whole (below).
    if (labeled?.groups && !/^\w+:\/\//.test(line)) {
      parts.push({ label: labeled.groups.label!.trim(), value: labeled.groups.value!.trim() });
      continue;
    }
    const tokens = line.split(/\s+/);
    const labels = tokens.map(labelFor);
    if (tokens.length >= 2 && tokens.length <= 3 && labels.some((l) => l !== null)) {
      tokens.forEach((value, i) => parts.push({ label: labels[i] ?? null, value }));
      continue;
    }
    parts.push({ label: null, value: line });
  }
  return parts.length > 0 ? parts : [{ label: null, value: text }];
}
