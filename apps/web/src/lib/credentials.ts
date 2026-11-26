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
// The emails in a text, as `/[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi` finds
// them (Phase 69), without retrying from every character of a long run. An
// email starts where the search resumes or after a character that can't be in
// one: one that started inside a run would also match from the run's start.
const EMAIL_HERE = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/iy;
const EMAIL_LATER = /(?<![\w.%+-])[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

function* emailsIn(text: string): Generator<RegExpExecArray> {
  let from = 0;
  for (;;) {
    EMAIL_HERE.lastIndex = from;
    EMAIL_LATER.lastIndex = from;
    const match = EMAIL_HERE.exec(text) ?? EMAIL_LATER.exec(text);
    if (!match) return;
    yield match;
    from = match.index + match[0].length;
  }
}

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

// Letters in any language: "ü", "ñ", "é" are letters, not symbols, so an
// ordinary word like "Averigüe" or "Mañana" is never one of three kinds.
const classesOf = (token: string) => ({
  lower: /\p{Ll}/u.test(token),
  upper: /\p{Lu}/u.test(token),
  digit: /\p{N}/u.test(token),
  symbol: /[^\p{L}\p{N}]/u.test(token),
});

/** A password, key or token is this long: shorter is a word, longer is a document. */
export const MIN_CREDENTIAL_LENGTH = 8;
export const MAX_CREDENTIAL_LENGTH = 200;
/** A signed token (JWT) runs longer than any password, and looks like nothing else. */
const MAX_JWT_LENGTH = 4096;
const JWT = /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*$/;
/** Symbols that join words and numbers ("ISO-27001:2022", "A/B_TEST.2"): not a password's. */
const ONLY_JOINERS = /^[\p{L}\p{N}\-_/.:,]+$/u;

/**
 * A password or key: one string of 8–200 characters, no spaces, with three
 * of lowercase, uppercase, digits and symbols ("MyP@ssw0rd", "Summer2024!",
 * "PASSWORD2026!"), or 20+ random characters of two kinds (API keys,
 * "AKIAIOSFODNN7EXAMPLE"); never a URL, file name, version, issue key,
 * identifier or number. Without lowercase, a code like "ISO-27001:2022" has
 * three kinds too: there the symbol must be more than a joiner.
 */
export function isHighEntropy(token: string): boolean {
  if (
    token.length < MIN_CREDENTIAL_LENGTH ||
    token.length > MAX_CREDENTIAL_LENGTH ||
    /\s/.test(token)
  ) {
    return false;
  }
  if (EMAIL.test(token) || NOT_A_CREDENTIAL.some((re) => re.test(token))) return false;
  const c = classesOf(token);
  const kinds = [c.lower, c.upper, c.digit, c.symbol].filter(Boolean).length;
  const bits = entropyPerChar(token);
  if (kinds >= 3 && bits >= 2.5 && (c.lower || !ONLY_JOINERS.test(token))) return true;
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

/**
 * How a message that is a label and its value begins: the keyword, at most
 * after an article and one word ("the wifi password"). A sentence that gets
 * to a password later ("Here is the password: x") is a sentence: hiding all
 * of it as a secret would hide the message.
 */
const LABEL_START = `^(?:(?:the|my|our|your|el|la|mi|tu|su)\\s+)?(?:[^\\s:=]+\\s+)?`;

/** "password: x", "pwd=x", "la clave es x", "password is x": the value ends the message. */
const KEYWORD_VALUE = new RegExp(
  `${LABEL_START}${KEYWORD.source}\\s*(?:(?<sep>[:=])\\s*|\\s+(?:is|es|was|era|:)?\\s*)(?<value>\\S+)$`,
  "iu",
);

/** "Contraseña del wifi: x": a keyword, up to three more words, then ":" or "=" and the value. */
const KEYWORD_LABEL = new RegExp(
  `${LABEL_START}${KEYWORD.source}(?:\\s+[^\\s:=]+){0,3}?\\s*[:=]\\s*(?<value>\\S+)$`,
  "iu",
);

const strip = (token: string) =>
  token.replace(/^["'`(<[]+/, "").replace(/(?<!["'`)>\],.;!?])["'`)>\],.;!?]+$/, "");

export type CredentialKind = "email-password" | "user-password" | "keyword" | "token" | "url";

/** Why `text` looks like it holds a credential, or `null`. */
export function credentialKind(text: string): CredentialKind | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // A password is one line. Several lines are notes, Markdown, code, a list:
  // sending those as a secret hides a whole message over one word in it.
  if (/[\r\n]/.test(trimmed)) return null;

  // The whole message is one random-looking string (as typed, or without its
  // quotes and final punctuation: "hunter2!" is eight characters with its "!").
  if (!/\s/.test(trimmed)) {
    if (trimmed.length <= MAX_JWT_LENGTH && JWT.test(strip(trimmed))) return "token";
    if (isHighEntropy(strip(trimmed)) || isHighEntropy(trimmed)) return "token";
  }
  // Longer than any login, shorter than any password: not one.
  if (trimmed.length < MIN_CREDENTIAL_LENGTH || trimmed.length > MAX_CREDENTIAL_LENGTH) {
    return null;
  }

  // A URL carrying a login: https://user:pass@host
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(trimmed)) return "url";

  // An email, then (after spaces or a line break) a password.
  for (const match of emailsIn(trimmed)) {
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
    const name = tokens[i]!.replace(/(?<![:/=])[:/=]+$/, "").toLowerCase();
    if (USERNAMES.includes(name) && isCredentialValue(tokens[i + 1]!)) return "user-password";
  }

  // A label and its value, and nothing else: "password: perro", "la clave es
  // Sol2024!". After ":" or "=" any value of 4+ characters counts; without
  // one it has to look like a password ("the password is wrong" doesn't).
  const explicitValue = (match: RegExpMatchArray) => {
    const value = strip(match.groups?.value ?? "");
    return isCredentialValue(value) || value.length >= 4;
  };
  const value = KEYWORD_VALUE.exec(trimmed);
  if (
    value?.groups?.sep
      ? explicitValue(value)
      : value && isCredentialValue(strip(value.groups!.value!))
  ) {
    return "keyword";
  }
  const label = KEYWORD_LABEL.exec(trimmed);
  if (label && explicitValue(label)) return "keyword";
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
  /**
   * A title for the parts under it, not a value to copy (Phase 52): "Acme
   * Store:" above an account's email and password, or a first line that just
   * names what the whole secret is for.
   */
  heading?: true;
}

/** Words only (any language), as an account or company name: no digits, no symbols but & . ' - / ( ). */
const NAME_LIKE = /^[\p{L}][\p{L} &.'\-/()]{0,59}$/u;

/** "Acme Store:": a name ending in a colon, with nothing after it. */
function headingOf(line: string): string | null {
  // What `/^(.+?)\s*:$/u` captured: the line before its final colon, spaces
  // trimmed (Phase 69). A line of spaces only fails NAME_LIKE either way.
  if (!line.endsWith(":")) return null;
  const name = line.slice(0, -1).trimEnd();
  return NAME_LIKE.test(name) ? name : null;
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
 * Password). A lone email or password line is labeled too, a "Name:" line
 * (or a first line that's just a name) is a heading over the parts below it,
 * and anything else stays one part: a single value is shown as before.
 */
export function secretParts(text: string): SecretPart[] {
  const parts: SecretPart[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const heading = headingOf(line);
    if (heading && lines.length > 1) {
      parts.push({ label: null, value: heading, heading: true });
      continue;
    }
    // The first of several lines, just a name: what the secret is for.
    if (
      i === 0 &&
      lines.length > 2 &&
      NAME_LIKE.test(line) &&
      !USERNAMES.includes(line.toLowerCase())
    ) {
      parts.push({ label: null, value: line, heading: true });
      continue;
    }
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
    // One value on its own line, among others: say what it is (an email, a password).
    parts.push({
      label: lines.length > 1 && tokens.length === 1 ? labelFor(line) : null,
      value: line,
    });
  }
  return parts.length > 0 ? parts : [{ label: null, value: text }];
}

// --- A secret message, as a Vault entry (Phase 72) -----------------------------------

export interface VaultDraft {
  name: string;
  username?: string;
  password: string;
}

const PASSWORD_LABEL = /pass|contrase|clave|pwd|secret|token|key|pin\b/i;
const USER_LABEL = /^(?:email|e-mail|correo|mail|user|usuario|username|login|cuenta|account)$/i;

/**
 * What a secret message would be in the Vault: its password, the account it
 * goes with and a name (the message's own title, else the account, else
 * `fallbackName`). `null` when no one value is clearly the password.
 */
export function vaultDraftOf(text: string, fallbackName: string): VaultDraft | null {
  const parts = secretParts(text);
  const values = parts.filter((p) => !p.heading);
  const labeled = values.filter((p) => p.label && PASSWORD_LABEL.test(p.label));
  const password =
    labeled.length === 1
      ? labeled[0]!.value
      : labeled.length === 0 && values.length === 1 && credentialKind(text) === "token"
        ? values[0]!.value.trim()
        : null;
  if (!password) return null;
  const username = values.find((p) => p.label && USER_LABEL.test(p.label))?.value;
  const heading = parts.find((p) => p.heading)?.value;
  return {
    name: (heading ?? username ?? fallbackName).slice(0, 100),
    ...(username && { username: username.slice(0, 200) }),
    password,
  };
}
