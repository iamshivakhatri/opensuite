/** Track edits across asynchronous export/upload without losing newer changes. */
export function createEditorSaveState() {
  let revision = 0;
  let savedRevision = 0;
  let versionRevision = 0;
  let pending: Promise<boolean> | null = null;
  async function save(write: () => Promise<void>, createVersion = false): Promise<boolean> {
    if (pending) {
      if (!createVersion) return pending;
      if (!await pending) return false;
      return save(write, createVersion);
    }
    if (revision === savedRevision && (!createVersion || revision === versionRevision)) return true;
    const savingRevision = revision;
    pending = Promise.resolve().then(write).then(
      () => {
        savedRevision = savingRevision;
        if (createVersion) versionRevision = savingRevision;
        return true;
      },
      () => false,
    ).finally(() => { pending = null; });
    return pending;
  }
  return {
    get revision() { return revision; },
    changed() { revision++; },
    reset(hasDraft = false) { savedRevision = revision; versionRevision = hasDraft ? revision - 1 : revision; },
    isDirty() { return revision !== savedRevision; },
    save,
  };
}
