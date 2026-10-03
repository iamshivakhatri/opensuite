import { CapabilityRegistry } from "./core/registry.js";
import { builtInGroups, builtInTools } from "./definitions/built-in.js";
import { calculatorCapability, createCalculatorTool } from "./definitions/compute/calculator.js";
import { scientificPaperCapability } from "./definitions/skills/scientific-paper.js";

/** Process-wide immutable source catalog. Runtime availability belongs to a session. */
export const capabilityRegistry = new CapabilityRegistry([
  ...builtInGroups,
  calculatorCapability,
  scientificPaperCapability,
  ...builtInTools,
]);

/** Standalone tools whose implementation lives with their capability definition. */
export function createStandaloneCapabilityTools() {
  return { "compute.calculator": createCalculatorTool() };
}
