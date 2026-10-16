import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { document, documentVersion } from './product.js';

/** One replaceable autosave per document; version snapshots stay immutable. */
export const documentDraft = pgTable('document_draft', {
  documentId: uuid('document_id').primaryKey().references(() => document.id, { onDelete: 'cascade' }),
  id: uuid('id').notNull(),
  baseVersionId: uuid('base_version_id').notNull().references(() => documentVersion.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
