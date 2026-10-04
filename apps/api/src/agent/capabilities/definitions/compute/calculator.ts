import { jsonSchema } from "ai";
import { defineTool } from "@opensuite/agent-core-v3";
import type { CapabilityDefinition } from "../../core/registry.js";

export const calculatorCapability: CapabilityDefinition = {
  id: "compute.calculator", parentId: "compute", kind: "tool", title: "Calculator",
  description: "Deterministic arithmetic, percentages, powers, roots, and grouped expressions",
  aliases: ["calculate math percentage percent compound annual growth rate CAGR"],
  projection: "dynamic", toolName: "compute.calculator",
};

type CalculatorResult =
  | { ok: true; expression: string; resultType: "exact_integer"; exactResult: string }
  | { ok: true; expression: string; resultType: "approximate_decimal"; approximateResult: number }
  | { ok: false; expression: string; errorCode: string; message: string };

type Value = bigint | number;
const MAX_EXACT_DIGITS = 10_000;

class CalculatorError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Arithmetic only: no JavaScript evaluation, names, property access, or functions except sqrt. */
export function calculate(expression: string): CalculatorResult {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 200) {
    return { ok: false, expression: String(expression ?? ""), errorCode: "INVALID_EXPRESSION", message: "Enter an arithmetic expression up to 200 characters." };
  }
  try {
    const tokens: string[] = [];
    for (let pos = 0; pos < expression.length;) {
      if (/\s/.test(expression[pos]!)) { pos++; continue; }
      const rest = expression.slice(pos);
      const number = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?(?:[eE][+-]?\d+)?|^\.\d+(?:[eE][+-]?\d+)?/.exec(rest)?.[0];
      const name = /^(?:sqrt|of)\b/i.exec(rest)?.[0];
      const token = number ?? name?.toLowerCase() ?? ("+-*/^()%√".includes(rest[0]!) ? rest[0] : undefined);
      if (!token) throw new CalculatorError("INVALID_EXPRESSION", `Unexpected input at character ${pos + 1}.`);
      tokens.push(token === "√" ? "sqrt" : token);
      pos += token.length;
      if (tokens.length > 100) throw new CalculatorError("INVALID_EXPRESSION", "Expression is too long.");
    }
    let index = 0;
    let depth = 0;
    const peek = () => tokens[index];
    const take = () => tokens[index++];
    const finite = (value: number) => {
      if (!Number.isFinite(value)) throw new CalculatorError("INVALID_RESULT", "Result is outside the supported numeric range.");
      return value;
    };
    const exact = (value: bigint) => {
      if (value.toString().replace("-", "").length > MAX_EXACT_DIGITS) {
        throw new CalculatorError("INVALID_RESULT", "Exact integer result is too large.");
      }
      return value;
    };
    const asNumber = (value: Value) => finite(Number(value));
    const combine = (operator: string, left: Value, right: Value): Value => {
      if (operator === "/") {
        if (right === 0 || right === 0n) throw new CalculatorError("DIVISION_BY_ZERO", "Cannot divide by zero.");
        if (typeof left === "bigint" && typeof right === "bigint" && left % right === 0n) return exact(left / right);
        return finite(asNumber(left) / asNumber(right));
      }
      if (typeof left === "bigint" && typeof right === "bigint") {
        if (operator === "+") return exact(left + right);
        if (operator === "-") return exact(left - right);
        return exact(left * right);
      }
      const a = asNumber(left);
      const b = asNumber(right);
      return finite(operator === "+" ? a + b : operator === "-" ? a - b : a * b);
    };
    const parseExpression = (): Value => {
      let value = parseTerm();
      while (peek() === "+" || peek() === "-") value = combine(take()!, value, parseTerm());
      return value;
    };
    const parseTerm = (): Value => {
      let value = parseUnary();
      while (peek() === "*" || peek() === "/" || peek() === "of") {
        const operator = take();
        value = combine(operator === "of" ? "*" : operator!, value, parseUnary());
      }
      return value;
    };
    const parseUnary = (): Value => {
      if (++depth > 20) throw new CalculatorError("INVALID_EXPRESSION", "Expression is nested too deeply.");
      try {
        if (peek() === "+") { take(); return parseUnary(); }
        if (peek() === "-") { take(); return -parseUnary(); }
        if (peek() === "sqrt") {
          take();
          if (take() !== "(") throw new CalculatorError("INVALID_EXPRESSION", "Use sqrt(number)." );
          const value = asNumber(parseExpression());
          if (take() !== ")") throw new CalculatorError("INVALID_EXPRESSION", "Missing closing parenthesis.");
          if (value < 0) throw new CalculatorError("INVALID_RESULT", "Square root needs a nonnegative number.");
          return finite(Math.sqrt(value));
        }
        return parsePower();
      } finally { depth--; }
    };
    const parsePower = (): Value => {
      let value = parsePrimary();
      while (peek() === "%") { take(); value = finite(asNumber(value) / 100); }
      if (peek() === "^") {
        take();
        const exponent = parseUnary();
        if (typeof value === "bigint" && typeof exponent === "bigint" && exponent >= 0n) {
          const digits = value.toString().replace("-", "").length;
          if (exponent > 10_000n || (value !== 0n && value !== 1n && value !== -1n && BigInt(digits) * exponent > BigInt(MAX_EXACT_DIGITS))) {
            throw new CalculatorError("INVALID_RESULT", "Exact integer power is too large.");
          }
          value = exact(value ** exponent);
        } else value = finite(asNumber(value) ** asNumber(exponent));
      }
      return value;
    };
    const parsePrimary = (): Value => {
      const token = take();
      if (token === "(") {
        const value = parseExpression();
        if (take() !== ")") throw new CalculatorError("INVALID_EXPRESSION", "Missing closing parenthesis.");
        return value;
      }
      if (token && /^(?:\d|\.)/.test(token)) {
        const plain = token.replaceAll(",", "");
        return /^\d+$/.test(plain) ? exact(BigInt(plain)) : finite(Number(plain));
      }
      throw new CalculatorError("INVALID_EXPRESSION", "Expected a number or grouped expression.");
    };
    const result = parseExpression();
    if (index !== tokens.length) throw new CalculatorError("INVALID_EXPRESSION", "Unexpected input after the expression.");
    return typeof result === "bigint"
      ? { ok: true, expression, resultType: "exact_integer", exactResult: result.toString() }
      : { ok: true, expression, resultType: "approximate_decimal", approximateResult: result };
  } catch (error) {
    const failure = error instanceof CalculatorError ? error : new CalculatorError("INVALID_EXPRESSION", "Invalid arithmetic expression.");
    return { ok: false, expression, errorCode: failure.code, message: failure.message };
  }
}

export function createCalculatorTool() {
  return defineTool<{ expression: string }, CalculatorResult>({
    kind: "read",
    description: "Evaluate arithmetic: +, -, *, /, percentages, powers (^), sqrt(...), and parentheses. Use 'of' for percentage multiplication. Trust exactResult for exact integers; do not reconstruct them manually. Other results are approximate.",
    inputSchema: jsonSchema({ type: "object", properties: { expression: { type: "string", minLength: 1, maxLength: 200 } }, required: ["expression"], additionalProperties: false }),
    execute: ({ expression }) => calculate(expression),
  });
}
