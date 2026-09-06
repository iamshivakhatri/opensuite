/**
 * Clear Casual Docs' browser-local recovery draft so remounting after a
 * server version load does not show "Unsaved changes from … restore them?".
 * DB name / store / key match @casualoffice/docs autosave internals.
 */
export async function clearCasualLocalAutosave(): Promise<void> {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem("docx-editor-autosave");
  } catch {
    // ignore
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const open = window.indexedDB.open("casual-docs", 3);
      open.onerror = () => reject(open.error ?? new Error("idb open failed"));
      open.onsuccess = () => {
        const db = open.result;
        try {
          if (!db.objectStoreNames.contains("autosave")) {
            db.close();
            resolve();
            return;
          }
          const tx = db.transaction("autosave", "readwrite");
          tx.objectStore("autosave").delete("current");
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error ?? new Error("idb clear failed"));
          };
        } catch (error) {
          db.close();
          reject(error);
        }
      };
    });
  } catch {
    // Recovery banner may still appear; editor remains usable.
  }
}
