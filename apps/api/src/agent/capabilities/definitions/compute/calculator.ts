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
  | { ok: true; expression: string; result: number }
  | { ok: false; expression: string; errorCode: string; message: string };

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
    const parseExpression = (): number => {
      let value = parseTerm();
      while (peek() === "+" || peek() === "-") value = finite(take() === "+" ? value + parseTerm() : value - parseTerm());
      return value;
    };
    const parseTerm = (): number => {
      let value = parseUnary();
      while (peek() === "*" || peek() === "/" || peek() === "of") {
        const operator = take();
        const right = parseUnary();
        if (operator === "/" && right === 0) throw new CalculatorError("DIVISION_BY_ZERO", "Cannot divide by zero.");
        value = finite(operator === "/" ? value / right : value * right);
      }
      return value;
    };
    const parseUnary = (): number => {
      if (++depth > 20) throw new CalculatorError("INVALID_EXPRESSION", "Expression is nested too deeply.");
      try {
        if (peek() === "+") { take(); return parseUnary(); }
        if (peek() === "-") { take(); return -parseUnary(); }
        if (peek() === "sqrt") {
          take();
          if (take() !== "(") throw new CalculatorError("INVALID_EXPRESSION", "Use sqrt(number)." );
          const value = parseExpression();
          if (take() !== ")") throw new CalculatorError("INVALID_EXPRESSION", "Missing closing parenthesis.");
          if (value < 0) throw new CalculatorError("INVALID_RESULT", "Square root needs a nonnegative number.");
          return finite(Math.sqrt(value));
        }
        return parsePower();
      } finally { depth--; }
    };
    const parsePower = (): number => {
      let value = parsePrimary();
      while (peek() === "%") { take(); value /= 100; }
      if (peek() === "^") { take(); value = finite(value ** parseUnary()); }
      return value;
    };
    const parsePrimary = (): number => {
      const token = take();
      if (token === "(") {
        const value = parseExpression();
        if (take() !== ")") throw new CalculatorError("INVALID_EXPRESSION", "Missing closing parenthesis.");
        return value;
      }
      if (token && /^(?:\d|\.)/.test(token)) return finite(Number(token.replaceAll(",", "")));
      throw new CalculatorError("INVALID_EXPRESSION", "Expected a number or grouped expression.");
    };
    const result = parseExpression();
    if (index !== tokens.length) throw new CalculatorError("INVALID_EXPRESSION", "Unexpected input after the expression.");
    return { ok: true, expression, result };
  } catch (error) {
    const failure = error instanceof CalculatorError ? error : new CalculatorError("INVALID_EXPRESSION", "Invalid arithmetic expression.");
    return { ok: false, expression, errorCode: failure.code, message: failure.message };
  }
}

export function createCalculatorTool() {
  return defineTool<{ expression: string }, CalculatorResult>({
    kind: "read",
    description: "Evaluate deterministic arithmetic: +, -, *, /, percentages, powers (^), sqrt(...), and parentheses. Use 'of' for percentage multiplication.",
    inputSchema: jsonSchema({ type: "object", properties: { expression: { type: "string", minLength: 1, maxLength: 200 } }, required: ["expression"], additionalProperties: false }),
    execute: ({ expression }) => calculate(expression),
  });
}
