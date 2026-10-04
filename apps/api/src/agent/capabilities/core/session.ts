import { requestsSavedStyle } from "../definitions/style-profiles.js";
import type { AgentToolSet } from "@opensuite/agent-core-v3";
import { CapabilityRegistry, type CapabilityDefinition } from "./registry.js";

export type CapabilityEventType = "recommended" | "discovered" | "loaded" | "executed" | "succeeded" | "failed";
export type CapabilityEvent = Readonly<{ capabilityId: string; kind: CapabilityDefinition["kind"]; type: CapabilityEventType; turn?: number; latencyMs?: number; errorCode?: string }>;
type Emit = (event: CapabilityEvent) => void;
const compact = (item: CapabilityDefinition) => ({ id: item.id, kind: item.kind, title: item.title, description: item.description });
export type CapabilityRecommendation = ReturnType<typeof compact> & Readonly<{
  companionCapabilities?: readonly ReturnType<typeof compact>[];
}>;

/** One run's available and loaded capabilities; the registry itself never changes. */
export class CapabilitySession {
  private savedStyleRequested = false;
  readonly available = new Set<string>();
  readonly loaded = new Set<string>();
  private readonly loadedInstructions = new Map<string, string>();
  private readonly availableToolsByGroup = new Map<string, string[]>();
  private readonly activeToolNames = new Set<string>();
  private exposedToolNames = new Set<string>();

  constructor(readonly registry: CapabilityRegistry, readonly tools: AgentToolSet, private readonly emit?: Emit) {
    for (const name of Object.keys(tools)) {
      const definition = registry.byToolName.get(name);
      if (!definition) throw new Error(`Unregistered capability tool: ${name}`);
      this.available.add(definition.id);
      if (definition.projection === "always") this.activeToolNames.add(name);
      let parentId = definition.parentId;
      while (parentId !== null) {
        this.available.add(parentId);
        const members = this.availableToolsByGroup.get(parentId) ?? [];
        members.push(name);
        this.availableToolsByGroup.set(parentId, members);
        parentId = registry.get(parentId)!.parentId;
      }
    }
  }

  private isAvailable(id: string) { return this.available.has(id) || this.registry.hasInstruction(id); }

  private isLoadable(id: string) {
    if (!this.isAvailable(id)) return false;
    const definition = this.registry.get(id);
    return !!definition && !(definition.kind === "group" &&
      (definition.parentId === null || this.registry.children(id).some((child) => child.kind === "group" && this.isAvailable(child.id))));
  }

  roots() { return this.registry.roots().filter((item) => this.isAvailable(item.id)).map(compact); }

  list(parentId: string | null, turn?: number) {
    if (parentId !== null && !this.isAvailable(parentId)) return { ok: false as const, reasonCode: "CAPABILITY_UNAVAILABLE" };
    const children = this.registry.children(parentId).filter((item) => this.isAvailable(item.id));
    for (const item of children) this.emit?.({ capabilityId: item.id, kind: item.kind, type: "discovered", turn });
    return { ok: true as const, capabilities: children.map(compact) };
  }

  search(query: string, turn?: number) {
    const matches = this.registry.search(query, 8, (id) => this.isAvailable(id));
    for (const item of matches) this.emit?.({ capabilityId: item.id, kind: item.kind, type: "discovered", turn });
    return { ok: true as const, capabilities: matches.map(compact) };
  }

  recommend(query: string, turn = 1) {
    this.savedStyleRequested = requestsSavedStyle(query);
    const matches = this.savedStyleRequested
      ? [
          ...['style.list_profiles', 'style.get_profile', 'style.apply_profile'].filter(id => this.isAvailable(id)).map(id => this.registry.get(id)!),
          ...this.registry.recommend(query, 3, (id) => this.isAvailable(id))
            .filter((item) => item.kind === 'instruction' && item.id.startsWith('skills.')).slice(0, 1),
        ]
      : this.registry.recommend(query, 3, (id) => this.isAvailable(id));
    const recommendedCompanions = new Set<string>();
    const recommendations: CapabilityRecommendation[] = matches.map((item) => {
      const companions = item.kind === "instruction"
        ? (item.companionCapabilities ?? [])
            .filter((id) => this.isLoadable(id))
            .map((id) => this.registry.get(id)!)
        : [];
      for (const companion of companions) recommendedCompanions.add(companion.id);
      return { ...compact(item), ...(companions.length ? { companionCapabilities: companions.map(compact) } : {}) };
    });
    for (const item of matches) this.emit?.({ capabilityId: item.id, kind: item.kind, type: "recommended", turn });
    for (const id of recommendedCompanions) {
      const item = this.registry.get(id)!;
      this.emit?.({ capabilityId: item.id, kind: item.kind, type: "recommended", turn });
    }
    return recommendations;
  }

  load(ids: readonly string[], turn?: number) {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !this.isAvailable(id))) {
      return { ok: false as const, reasonCode: "CAPABILITY_UNAVAILABLE" };
    }
    if (this.savedStyleRequested && ids.some(id => id === 'styles' || id.startsWith('styles.'))) {
      return { ok: false as const, reasonCode: 'SAVED_STYLE_REQUIRED', message: 'This request names a saved style. Load style.list_profiles, style.get_profile, and style.apply_profile. A document skill can still help with content.' };
    }
    if (ids.some((id) => !this.isLoadable(id))) return { ok: false as const, reasonCode: "CAPABILITY_NOT_LOADABLE" };
    const requested = new Set(ids);
    for (const id of ids) {
      if (this.registry.get(id)?.kind !== "group") continue;
      for (const child of this.registry.children(id)) if (child.kind === "instruction" && this.isAvailable(child.id)) requested.add(child.id);
    }
    // Resolve bodies before changing run state, so a bad skill cannot partially load a batch.
    const bodies = new Map<string, string>();
    for (const id of requested) {
      const definition = this.registry.get(id)!;
      if (definition.kind !== "instruction" || this.loaded.has(id)) continue;
      const body = definition.instructions();
      if (typeof body !== "string" || !body.trim()) return { ok: false as const, reasonCode: "CAPABILITY_LOAD_FAILED" };
      bodies.set(id, body.trim());
    }
    for (const id of requested) {
      if (this.loaded.has(id)) continue;
      this.loaded.add(id);
      const definition = this.registry.get(id)!;
      if (definition.kind === "tool") {
        this.activeToolNames.add(definition.toolName);
      } else if (definition.kind === "group") {
        for (const name of this.availableToolsByGroup.get(id) ?? []) this.activeToolNames.add(name);
      } else {
        this.loadedInstructions.set(id, bodies.get(id)!);
      }
      this.emit?.({ capabilityId: id, kind: definition.kind, type: "loaded", turn });
    }
    return { ok: true as const, loadedIds: [...this.loaded].sort() };
  }

  projectTools(): AgentToolSet {
    this.exposedToolNames = new Set(this.activeToolNames);
    return Object.fromEntries([...this.exposedToolNames].sort().map((name) => [name, this.tools[name]!])) as AgentToolSet;
  }

  projectInstructions() {
    return [...this.loadedInstructions].sort(([a], [b]) => a.localeCompare(b)).map(([id, content]) => ({ id, title: this.registry.get(id)!.title, content }));
  }

  capabilityForTool(name: string) { return this.exposedToolNames.has(name) ? this.registry.byToolName.get(name)?.id : undefined; }
}
