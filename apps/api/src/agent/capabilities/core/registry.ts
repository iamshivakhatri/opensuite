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
  | (CapabilityBase & Readonly<{
      kind: "instruction";
      toolName?: never;
      instructions: () => string;
      companionCapabilities?: readonly string[];
    }>);

const words = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const PROMPT_STOP_WORDS = new Set(["the", "and", "for", "from", "with", "this", "that", "what", "how", "please", "document", "file", "write", "edit", "make", "create", "update"]);
const promptWords = (value: string) => [...new Set(words(value.replaceAll("%", " percent "))
  .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !PROMPT_STOP_WORDS.has(word)))].slice(0, 20);

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
      const definition = Object.freeze({
        ...source,
        ...(source.aliases ? { aliases: Object.freeze([...source.aliases]) } : {}),
        ...(source.kind === "instruction" && source.companionCapabilities
          ? { companionCapabilities: Object.freeze([...source.companionCapabilities]) }
          : {}),
      });
      if (!definition.id || this.idIndex.has(definition.id)) throw new Error(`Duplicate capability ID: ${definition.id}`);
      if (!definition.title || !definition.description) throw new Error(`Missing capability metadata: ${definition.id}`);
      if (!["group", "tool", "instruction"].includes(definition.kind)) throw new Error(`Invalid capability kind: ${definition.id}`);
      if (definition.projection !== "always" && definition.projection !== "dynamic") throw new Error(`Invalid projection: ${definition.id}`);
      if (definition.kind === "instruction" && definition.projection !== "dynamic") throw new Error(`Instruction must be loaded dynamically: ${definition.id}`);
      if (definition.kind === "instruction" && (definition.companionCapabilities?.length ?? 0) > 4) {
        throw new Error(`Too many companion capabilities: ${definition.id}`);
      }
      if (definition.kind === "instruction" && definition.companionCapabilities &&
        new Set(definition.companionCapabilities).size !== definition.companionCapabilities.length) {
        throw new Error(`Duplicate companion capability: ${definition.id}`);
      }
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
    for (const definition of this.idIndex.values()) {
      if (definition.kind !== "instruction") continue;
      for (const id of definition.companionCapabilities ?? []) {
        const companion = this.idIndex.get(id);
        if (!companion || companion.kind === "instruction") throw new Error(`Invalid companion capability: ${definition.id} -> ${id}`);
      }
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
    const first = terms.map((term) => this.searchIndex.get(term)).sort((a, b) => (a?.size ?? 0) - (b?.size ?? 0))[0];
    if (!first) return [];
    const max = Math.max(0, Math.min(limit, 20));
    const matches: { definition: CapabilityDefinition; score: number }[] = [];
    const normalized = query.toLowerCase().trim();
    let inspected = 0;
    for (const id of first) {
      if (++inspected > 2_000) break;
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

  /** Prompt routing uses only small indexed postings, never a catalog scan. */
  recommend(query: string, limit = 3, isAvailable: (id: string) => boolean = () => true): CapabilityDefinition[] {
    const terms = promptWords(query);
    const postings = terms.map((term) => ({ term, ids: this.searchIndex.get(term) }))
      .filter((entry): entry is { term: string; ids: Set<string> } => !!entry.ids && entry.ids.size <= 256)
      .sort((a, b) => a.ids.size - b.ids.size).slice(0, 8);
    const candidates = new Set<string>();
    for (const { ids } of postings) for (const id of ids) {
      if (candidates.size >= 256) break;
      candidates.add(id);
    }
    const ranked = [...candidates].map((id) => this.idIndex.get(id)!)
      .filter((item) => item.kind !== "group" && item.projection === "dynamic" && isAvailable(item.id))
      .map((item) => {
        const title = words(`${item.title} ${item.aliases?.join(" ") ?? ""}`);
        const description = words(item.description);
        const score = postings.reduce((sum, { term }) => sum + (title.some((word) => word.startsWith(term)) ? 3 : description.some((word) => word.startsWith(term)) ? 1 : 0), 0);
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    // Keep weak one-word matches out when the prompt has stronger matches.
    const minimum = ranked[0] && ranked[0].score >= 6 ? Math.ceil(ranked[0].score * 0.7) : 3;
    return ranked.filter(({ score }) => score >= minimum)
      .slice(0, Math.max(0, Math.min(limit, 5)))
      .map(({ item }) => item);
  }
}
