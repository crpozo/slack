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

/** `row` after `expr` (a new object; the input is left alone). */
export function applyUpdate(row: Row, expr: string, values: Values = {}, names: Names = {}): Row {
  const next: Row = { ...row };
  const [, setPart = "", removePart = ""] =
    /^(?:SET\s+(.*?))?\s*(?:REMOVE\s+(.*))?$/.exec(expr.trim()) ?? [];
  for (const clause of setPart
    .split(/,(?![^(]*\))/)
    .map((c) => c.trim())
    .filter(Boolean)) {
    const [lhs, rhs] = clause.split(/\s*=\s*/, 2) as [string, string];
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
