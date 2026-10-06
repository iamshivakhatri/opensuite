import { styleProfileCapabilities } from "./definitions/style-profiles.js";
import { CapabilityRegistry } from "./core/registry.js";
import { builtInGroups, builtInTools } from "./definitions/built-in.js";
import { calculatorCapability, createCalculatorTool } from "./definitions/compute/calculator.js";
import { documentSkills } from "./definitions/skills/index.js";
import { documentStyles } from "./definitions/styles/index.js";

/** Process-wide immutable source catalog. Runtime availability belongs to a session. */
export const capabilityRegistry = new CapabilityRegistry([
  ...builtInGroups,
  ...styleProfileCapabilities,
  calculatorCapability,
  ...documentSkills,
  ...documentStyles,
  ...builtInTools,
]);

/** Standalone tools whose implementation lives with their capability definition. */
export function createStandaloneCapabilityTools() {
  return { "compute.calculator": createCalculatorTool() };
}
