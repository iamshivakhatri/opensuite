import { and, desc, eq } from 'drizzle-orm';
import { schema, type Db } from '@opensuite/db';
import type { StyleProfile, StyleProfileData, StyleProfileSummary } from '@opensuite/contracts';
import { inspectDocxStyleSnapshot, type DocxStyleSnapshot } from '@opensuite/engine-client';
import { type DocumentService } from '../documents/service.js';
import { normalizeStyleSnapshot } from './normalize.js';

export class StyleProfileError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

type SavedData = Pick<StyleProfile, 'source' | 'style'>;
function toProfile(row: typeof schema.styleProfile.$inferSelect): StyleProfile {
  return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), ...(row.data as SavedData) };
}
export function styleProfileSummary(profile: StyleProfile) {
  return {
    id: profile.id, name: profile.name, schemaVersion: profile.style.schemaVersion,
    source: profile.source,
    body: profile.style.body, title: profile.style.title,
    headings: profile.style.headings, palette: profile.style.palette,
    lists: profile.style.lists, table: profile.style.table, page: profile.style.page,
    headersFooters: { present: profile.style.headersFooters.present },
    diagnostics: profile.style.diagnostics.slice(0, 8),
    unresolvedThemeReferenceCount: profile.style.unresolvedThemeReferences.length,
  };
}
export function profileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 160) throw new StyleProfileError(400, 'INVALID_PROFILE_NAME', 'Profile name must contain 1 to 160 characters');
  return trimmed;
}

export function createStyleProfileService(
  db: Db,
  documents: Pick<DocumentService, 'getOwnedDocument' | 'readExactVersionBytes'>,
  inspect: (bytes: Uint8Array) => Promise<DocxStyleSnapshot> = inspectDocxStyleSnapshot,
) {
  const owned = (ownerUserId: string, id: string) => and(eq(schema.styleProfile.id, id), eq(schema.styleProfile.ownerUserId, ownerUserId));
  function requireRow(row: typeof schema.styleProfile.$inferSelect | undefined) {
    if (!row) throw new StyleProfileError(404, 'STYLE_PROFILE_NOT_FOUND', 'Style profile not found');
    return toProfile(row);
  }
  return {
    async learnFromDocument(input: { ownerUserId: string; documentId: string; versionId?: string; workspaceId?: string; name?: string }): Promise<StyleProfile> {
      const name = input.name === undefined ? undefined : profileName(input.name);
      const document = await documents.getOwnedDocument(input);
      if (input.workspaceId && document.workspaceId !== input.workspaceId) throw new StyleProfileError(404, 'DOCUMENT_NOT_FOUND', 'Document not found in this workspace');
      if (document.format !== 'docx') throw new StyleProfileError(400, 'STYLE_REQUIRES_DOCX', 'Style learning requires a DOCX document');
      // Capture the tip once, then read that exact immutable version; never read working bytes.
      const versionId = input.versionId ?? document.latestVersion.id;
      const bytes = await documents.readExactVersionBytes({ ...input, versionId });
      const snapshot = await inspect(bytes);
      if (!snapshot.ok) throw new StyleProfileError(422, 'STYLE_INSPECTION_FAILED', 'Could not inspect document style');
      const style: StyleProfileData = normalizeStyleSnapshot(snapshot);
      const source: StyleProfile['source'] = { type: 'docx', documentId: document.id, versionId, workspaceId: document.workspaceId, fileName: document.name, extractedAt: new Date().toISOString(), snapshotSchemaVersion: snapshot.schemaVersion, normalizerVersion: 1 };
      const [row] = await db.insert(schema.styleProfile).values({ ownerUserId: input.ownerUserId, name: name ?? `${document.name.replace(/\.docx$/i, '').slice(0, 154)} Style`, data: { source, style } satisfies SavedData }).returning();
      return requireRow(row);
    },
    async get(ownerUserId: string, id: string) {
      const [row] = await db.select().from(schema.styleProfile).where(owned(ownerUserId, id)).limit(1);
      return requireRow(row);
    },
    async list(ownerUserId: string, limit = 20, offset = 0): Promise<StyleProfileSummary[]> {
      const rows = await db.select().from(schema.styleProfile).where(eq(schema.styleProfile.ownerUserId, ownerUserId)).orderBy(desc(schema.styleProfile.createdAt), desc(schema.styleProfile.id)).limit(Math.min(50, Math.max(1, limit))).offset(Math.max(0, offset));
      return rows.map(row => {
        const profile = toProfile(row);
        return { id: profile.id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt, source: profile.source, body: profile.style.body.text, headingLevels: profile.style.headings.map(h => h.level), diagnosticCodes: profile.style.diagnostics.slice(0, 8).map(d => d.code) };
      });
    },
    async rename(ownerUserId: string, id: string, name: string) {
      const [row] = await db.update(schema.styleProfile).set({ name: profileName(name), updatedAt: new Date() }).where(owned(ownerUserId, id)).returning();
      return requireRow(row);
    },
    async delete(ownerUserId: string, id: string) {
      const [row] = await db.delete(schema.styleProfile).where(owned(ownerUserId, id)).returning();
      requireRow(row);
    },
  };
}
export type StyleProfileService = ReturnType<typeof createStyleProfileService>;
