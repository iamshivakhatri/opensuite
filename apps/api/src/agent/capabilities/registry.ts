import { providerSafeToolName } from "@opensuite/agent-core-v3";

type CapabilityBase = Readonly<{
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  projection: "always" | "dynamic";
  aliases?: readonly string[];
}>;
export type CapabilityDefinition =
  | (CapabilityBase & Readonly<{ kind: "group"; toolName?: never; instructions?: never }>)
  | (CapabilityBase & Readonly<{ kind: "tool"; toolName: string; instructions?: never }>)
  | (CapabilityBase & Readonly<{ kind: "instruction"; toolName?: never; instructions: () => string }>);

const words = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Immutable catalog indexes. Building them is a bootstrap cost, not a model-turn cost. */
export class CapabilityRegistry {
  private readonly idIndex = new Map<string, CapabilityDefinition>();
  private readonly childIndex = new Map<string | null, readonly CapabilityDefinition[]>();
  private readonly toolIndex = new Map<string, CapabilityDefinition>();
  private readonly instructionPaths = new Set<string>();
  get byId(): ReadonlyMap<string, CapabilityDefinition> { return this.idIndex; }
  get childrenByParent(): ReadonlyMap<string | null, readonly CapabilityDefinition[]> { return this.childIndex; }
  get byToolName(): ReadonlyMap<string, CapabilityDefinition> { return this.toolIndex; }
  hasInstruction(id: string): boolean { return this.instructionPaths.has(id); }
  private readonly searchIndex = new Map<string, Set<string>>();

  constructor(definitions: readonly CapabilityDefinition[]) {
    const children = new Map<string | null, CapabilityDefinition[]>();
    const providerNames = new Set<string>();
    for (const source of definitions) {
      const definition = Object.freeze({ ...source, ...(source.aliases ? { aliases: Object.freeze([...source.aliases]) } : {}) });
      if (!definition.id || this.idIndex.has(definition.id)) throw new Error(`Duplicate capability ID: ${definition.id}`);
      if (!definition.title || !definition.description) throw new Error(`Missing capability metadata: ${definition.id}`);
      if (!["group", "tool", "instruction"].includes(definition.kind)) throw new Error(`Invalid capability kind: ${definition.id}`);
      if (definition.projection !== "always" && definition.projection !== "dynamic") throw new Error(`Invalid projection: ${definition.id}`);
      if (definition.kind === "instruction" && definition.projection !== "dynamic") throw new Error(`Instruction must be loaded dynamically: ${definition.id}`);
      if (definition.kind === "tool" ? !definition.toolName || definition.instructions !== undefined
        : definition.kind === "instruction" ? typeof definition.instructions !== "function" || definition.toolName !== undefined
          : definition.toolName !== undefined || definition.instructions !== undefined) {
        throw new Error(`Invalid capability payload: ${definition.id}`);
      }
      if (definition.toolName) {
        const safe = providerSafeToolName(definition.toolName);
        if (this.toolIndex.has(definition.toolName) || providerNames.has(safe)) throw new Error(`Conflicting provider tool name: ${safe}`);
        providerNames.add(safe);
        this.toolIndex.set(definition.toolName, definition);
      }
      this.idIndex.set(definition.id, definition);
      const siblings = children.get(definition.parentId) ?? [];
      siblings.push(definition);
      children.set(definition.parentId, siblings);
      const tokens = new Set(words([definition.id, definition.title, definition.description, ...(definition.aliases ?? [])].join(" ")));
      for (const token of tokens) {
        // Prefixes support useful short queries without scanning the full catalog.
        for (let length = 2; length <= token.length; length++) {
          const key = token.slice(0, length);
          const ids = this.searchIndex.get(key) ?? new Set<string>();
          ids.add(definition.id);
          this.searchIndex.set(key, ids);
        }
      }
    }
    for (const definition of this.idIndex.values()) {
      if (definition.parentId === null) {
        if (definition.kind !== "group") throw new Error(`Root must be a group: ${definition.id}`);
        continue;
      }
      const parent = this.idIndex.get(definition.parentId);
      if (!parent) throw new Error(`Missing parent: ${definition.id}`);
      if (parent.kind !== "group") throw new Error(`Leaf capability cannot have children: ${definition.id}`);
    }
    // Every parent chain must reach a root. This also catches cycles.
    const finished = new Set<string>();
    for (const definition of this.idIndex.values()) {
      const path = new Set<string>();
      let current: CapabilityDefinition | undefined = definition;
      while (current && !finished.has(current.id)) {
        if (path.has(current.id)) throw new Error(`Capability cycle: ${current.id}`);
        path.add(current.id);
        current = current.parentId === null ? undefined : this.idIndex.get(current.parentId);
      }
      for (const id of path) finished.add(id);
    }
    for (const [parent, siblings] of children) this.childIndex.set(parent, Object.freeze(siblings.sort((a, b) => a.id.localeCompare(b.id))));
    for (const definition of this.idIndex.values()) {
      if (definition.kind !== "instruction") continue;
      let current: CapabilityDefinition | undefined = definition;
      while (current) {
        this.instructionPaths.add(current.id);
        current = current.parentId === null ? undefined : this.idIndex.get(current.parentId);
      }
    }
  }

  get(id: string) { return this.idIndex.get(id); }
  children(parentId: string | null) { return this.childIndex.get(parentId) ?? []; }
  roots() { return this.children(null); }

  search(query: string, limit = 8, isAvailable: (id: string) => boolean = () => true): CapabilityDefinition[] {
    const terms = [...new Set(words(query).filter((term) => term.length >= 2))].slice(0, 6);
    if (!terms.length) return [];
    const first = this.searchIndex.get(terms[0]!);
    if (!first) return [];
    const max = Math.max(0, Math.min(limit, 20));
    const matches: { definition: CapabilityDefinition; score: number }[] = [];
    const normalized = query.toLowerCase().trim();
    for (const id of first) {
      if (!isAvailable(id) || !terms.every((term) => this.searchIndex.get(term)?.has(id))) continue;
      const definition = this.idIndex.get(id)!;
      const title = definition.title.toLowerCase();
      const score = Number(id === normalized) * 100 + Number(title === normalized) * 80 +
        Number(title.startsWith(normalized)) * 40 + terms.filter((term) => words(title).some((word) => word.startsWith(term))).length * 10;
      matches.push({ definition, score });
      matches.sort((a, b) => b.score - a.score || a.definition.id.localeCompare(b.definition.id));
      if (matches.length > max) matches.pop();
    }
    return matches.map((match) => match.definition);
  }
}
