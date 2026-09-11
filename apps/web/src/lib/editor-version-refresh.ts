/**
 * Pure decision helper for DOCX version refresh lifecycle.
 * Keeps remount vs in-place vs defer-dirty policy testable and explicit.
 */

export type EditorVersionRefreshAction =
  | "initialize"
  | "reload_inplace"
  | "defer_dirty"
  | "skip";

export type EditorVersionRefreshInput = {
  /** True when the OpenSuite document id just changed (tab switch). */
  readonly documentChanged: boolean;
  /** Editor host is mounted and ready to accept an imperative buffer load. */
  readonly hasReadyEditor: boolean;
  readonly loadedVersionId: string | null;
  readonly targetVersionId: string | null;
  /** Real unsaved human edits (not remount dirty-noise). */
  readonly dirty: boolean;
  /**
   * Brief window after a server/agent load where Casual may emit dirty=true
   * spuriously. When set, a dirty flag must not block adopting the new version.
   */
  readonly suppressDirtyNoise: boolean;
  readonly conflict: boolean;
  readonly saving: boolean;
};

/**
 * Decide how the DOCX surface should react to a desired immutable version.
 *
 * Invariants:
 * - Never overwrite real human dirty edits (`defer_dirty`).
 * - Same-document clean N→N+1 prefers `reload_inplace`.
 * - Document switches / first open use `initialize` (remount/load OK).
 */
export function decideEditorVersionRefresh(
  input: EditorVersionRefreshInput,
): EditorVersionRefreshAction {
  if (!input.targetVersionId) {
    return "skip";
  }

  if (
    input.documentChanged ||
    !input.hasReadyEditor ||
    input.loadedVersionId == null
  ) {
    return "initialize";
  }

  if (input.loadedVersionId === input.targetVersionId) {
    return "skip";
  }

  if (input.conflict || input.saving) {
    return "skip";
  }

  if (input.dirty && !input.suppressDirtyNoise) {
    return "defer_dirty";
  }

  return "reload_inplace";
}
