import { AgentCoreError } from "./errors.js";
import {
  toModelToolDefinition,
  type AgentTool,
  type ModelToolDefinition,
} from "./model.js";

/**
 * Deterministic in-memory tool set. No plugin discovery or dynamic loading.
 */
export class ToolRegistry {
  private readonly byName: ReadonlyMap<string, AgentTool>;

  private constructor(tools: readonly AgentTool[]) {
    const map = new Map<string, AgentTool>();
    for (const tool of tools) {
      if (map.has(tool.name)) {
        throw new AgentCoreError(
          "DUPLICATE_TOOL_NAME",
          `Duplicate tool name: ${tool.name}`,
        );
      }
      map.set(tool.name, tool);
    }
    this.byName = map;
  }

  static create(tools: readonly AgentTool[] = []): ToolRegistry {
    return new ToolRegistry(tools);
  }

  get(name: string): AgentTool | undefined {
    return this.byName.get(name);
  }

  require(name: string): AgentTool {
    const tool = this.byName.get(name);
    if (!tool) {
      throw new AgentCoreError(
        "TOOL_NOT_FOUND",
        `Unknown tool: ${name}`,
      );
    }
    return tool;
  }

  list(): readonly AgentTool[] {
    return [...this.byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Stable, sorted definitions for the model boundary. */
  definitions(): readonly ModelToolDefinition[] {
    return this.list().map(toModelToolDefinition);
  }

  get size(): number {
    return this.byName.size;
  }
}
