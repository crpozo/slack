// A small evaluator for the DynamoDB expressions the Vault uses, so tests can
// run the real UpdateItem / ConditionExpression semantics (counters, locks,
// races) against an in-memory row instead of mocking each call's answer.
//
// Supported: `SET a = :v, b = if_not_exists(b, :z) + :one`, `REMOVE a, b`;
// conditions with attribute_exists / attribute_not_exists, = < <= > >=,
// AND / OR and parentheses. `#name` placeholders are resolved.

type Row = Record<string, unknown>;
type Values = Record<string, unknown>;
type Names = Record<string, string>;

const name = (token: string, names: Names) => (token.startsWith("#") ? names[token]! : token);

function tokenize(expr: string): string[] {
  return expr.match(/attribute_not_exists|attribute_exists|<=|>=|[()=<>,]|[#:]?[\w]+/g) ?? [];
}

export function evaluateCondition(
  expr: string | undefined,
  row: Row | undefined,
  values: Values = {},
  names: Names = {},
): boolean {
  if (!expr) return true;
  const item = row ?? {};
  const tokens = tokenize(expr);
  let i = 0;
  const operand = (t: string) => (t.startsWith(":") ? values[t] : item[name(t, names)]);
  function primary(): boolean {
    const t = tokens[i++]!;
    if (t === "(") {
      const v = or();
      i++; // ")"
      return v;
    }
    if (t === "attribute_exists" || t === "attribute_not_exists") {
      i++; // "("
      const attr = name(tokens[i++]!, names);
      i++; // ")"
      const exists = attr in item && item[attr] !== undefined;
      return t === "attribute_exists" ? exists : !exists;
    }
    const left = operand(t);
    const op = tokens[i++]!;
    const right = operand(tokens[i++]!);
    if (left === undefined || right === undefined) return false;
    switch (op) {
      case "=":
        return left === right;
      case "<":
        return (left as number) < (right as number);
      case "<=":
        return (left as number) <= (right as number);
      case ">":
        return (left as number) > (right as number);
      case ">=":
        return (left as number) >= (right as number);
      default:
        throw new Error(`unsupported operator ${op} in ${expr}`);
    }
  }
  function and(): boolean {
    let v = primary();
    while (tokens[i] === "AND") {
      i++;
      v = primary() && v;
    }
    return v;
  }
  function or(): boolean {
    let v = and();
    while (tokens[i] === "OR") {
      i++;
      v = and() || v;
    }
    return v;
  }
  return or();
}

// Phase 69: the parts of an update are found by scanning, not by one regex
// that backtracks quadratically on long input; each helper says which regex
// it stands for.

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * The `SET` and `REMOVE` parts of `expr`: what
 * `/^(?:SET\s+(.*?))?\s*(?:REMOVE\s+(.*))?$/` captures (`""` when absent).
 */
function updateParts(expr: string): [set: string, remove: string] {
  const isSpace = (at: number) => /\s/.test(expr[at] ?? "");
  // `\s*(?:REMOVE\s+(.*))?$` from `at`: the REMOVE part, `""` without one, or null.
  const tail = (at: number): string | null => {
    let p = at;
    while (isSpace(p)) p++;
    if (p === expr.length) return "";
    if (!expr.startsWith("REMOVE", p) || !isSpace(p + 6)) return null;
    let start = p + 6;
    while (isSpace(start)) start++;
    const remove = expr.slice(start);
    return LINE_BREAK.test(remove) ? null : remove;
  };
  if (expr.startsWith("SET") && isSpace(3)) {
    let start = 3;
    while (isSpace(start)) start++;
    const lineBreak = expr.slice(start).search(LINE_BREAK);
    const last = lineBreak < 0 ? expr.length : start + lineBreak;
    // The shortest SET part after which the rest fits; inside a run of spaces
    // the rest fits as it does from the run's start.
    for (let end = start; end <= last; end++) {
      if (end > start && isSpace(end - 1)) continue;
      const remove = tail(end);
      if (remove !== null) return [expr.slice(start, end), remove];
    }
  }
  return ["", tail(0) ?? ""];
}

/** `set` split at its top-level commas: what `set.split(/,(?![^(]*\))/)` returns. */
function splitClauses(set: string): string[] {
  const parts: string[] = [];
  let end = set.length;
  let nextParen: string | undefined;
  for (let i = set.length - 1; i >= 0; i--) {
    const c = set[i];
    if (c === "(" || c === ")") nextParen = c;
    else if (c === "," && nextParen !== ")") {
      parts.push(set.slice(i + 1, end));
      end = i;
    }
  }
  parts.push(set.slice(0, end));
  return parts.reverse();
}

/** `row` after `expr` (a new object; the input is left alone). */
export function applyUpdate(row: Row, expr: string, values: Values = {}, names: Names = {}): Row {
  const next: Row = { ...row };
  const [setPart, removePart] = updateParts(expr.trim());
  for (const clause of splitClauses(setPart)
    .map((c) => c.trim())
    .filter(Boolean)) {
    // Same pieces as `/\s*=\s*/`; spaces right after a previous `=` belong to it.
    const [lhs, rhs] = clause.split(/(?<!\s)\s*=\s*|=\s*/, 2) as [string, string];
    const target = name(lhs, names);
    const ifNotExists = /^if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)(?:\s*\+\s*(:\w+))?$/.exec(
      rhs,
    );
    if (ifNotExists) {
      const current = next[name(ifNotExists[1]!, names)] ?? values[ifNotExists[2]!];
      next[target] = ifNotExists[3]
        ? (current as number) + (values[ifNotExists[3]] as number)
        : current;
    } else {
      next[target] = values[rhs];
    }
  }
  for (const attr of removePart
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)) {
    delete next[name(attr, names)];
  }
  return next;
}
