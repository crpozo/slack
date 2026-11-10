import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DYNAMODB_RESERVED_WORDS } from "./dynamoReservedWords";

// ---------------------------------------------------------------------------
// Every DynamoDB expression in the backend, checked against DynamoDB's
// reserved words. The tests mock the client, which accepts anything; the real
// service rejects an expression that names a reserved word unaliased (a
// ValidationException). That is how `external` in the connections listing
// took every WebSocket route down in production (the Phase 59 hotfix).
// ---------------------------------------------------------------------------

const SRC = join(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** The text after `Expression:` up to the end of that property (a `,` or `}` at depth 0). */
function expressionValue(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return text.slice(start, i);
      depth--;
    } else if (c === "," && depth === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

/** The literal text of the string literals in a value (`${…}` interpolations dropped). */
function literals(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(
    /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
  )) {
    const text = match[1] ?? match[2] ?? match[3] ?? "";
    found.push(text.replace(/\$\{[^}]*\}/g, " "));
  }
  return found;
}

/** Words of the expression language itself, never attribute names. */
const LANGUAGE = new Set([
  "SET",
  "REMOVE",
  "ADD",
  "DELETE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "BETWEEN",
  "ATTRIBUTE_EXISTS",
  "ATTRIBUTE_NOT_EXISTS",
  "ATTRIBUTE_TYPE",
  "BEGINS_WITH",
  "CONTAINS",
  "SIZE",
  "IF_NOT_EXISTS",
  "LIST_APPEND",
]);

interface Found {
  file: string;
  property: string;
  word: string;
}

function reservedWordsInExpressions(): { checked: number; found: Found[] } {
  const found: Found[] = [];
  let checked = 0;
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(
      /\b(ProjectionExpression|UpdateExpression|ConditionExpression|KeyConditionExpression|FilterExpression)\s*:/g,
    )) {
      checked++;
      const value = expressionValue(text, match.index + match[0].length);
      for (const literal of literals(value)) {
        for (const token of literal.match(/[#:]?[A-Za-z_][\w]*/g) ?? []) {
          if (token.startsWith("#") || token.startsWith(":")) continue;
          const word = token.toUpperCase();
          if (LANGUAGE.has(word)) continue;
          if (DYNAMODB_RESERVED_WORDS.has(word)) {
            found.push({ file: relative(SRC, path), property: match[1]!, word: token });
          }
        }
      }
    }
  }
  return { checked, found };
}

describe("DynamoDB expressions", () => {
  it("never name a reserved word unaliased (use #name and ExpressionAttributeNames)", () => {
    const { checked, found } = reservedWordsInExpressions();
    expect(checked).toBeGreaterThan(50); // the scan really reads the expressions
    expect(found).toEqual([]);
  });

  it("catch the attribute that broke production (external), and words like it", () => {
    for (const word of ["EXTERNAL", "NAME", "ROLE", "STATUS", "TOKEN", "CONNECTION"]) {
      expect(DYNAMODB_RESERVED_WORDS.has(word), word).toBe(true);
    }
    expect(DYNAMODB_RESERVED_WORDS.has("CALLSCOPE")).toBe(false);
  });
});
