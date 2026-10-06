import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/** Personal reusable profiles survive source deletion. Source IDs are immutable provenance in data, not live foreign keys. */
export const styleProfile = pgTable('style_profile', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, table => [index('style_profile_owner_created_idx').on(table.ownerUserId, table.createdAt)]);
