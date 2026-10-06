import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getRequestUser, type SessionAuth } from '../auth/session.js';
import { DocumentAccessError } from '../documents/service.js';
import { StyleProfileError, type StyleProfileService } from '../style-profiles/service.js';

const idSchema = z.object({ id: z.uuid() });
const nameSchema = z.object({ name: z.string().trim().min(1).max(160) }).strict();
const learnSchema = z.object({ documentId: z.uuid(), versionId: z.uuid().optional(), name: z.string().trim().min(1).max(160).optional() }).strict();
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0) });

export function registerStyleProfileRoutes(app: FastifyInstance, auth: SessionAuth, profiles: StyleProfileService) {
  const handler = (action: (request: FastifyRequest, reply: FastifyReply, userId: string) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await getRequestUser(auth, request);
    if (!user) return reply.status(401).send({ error: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Unauthorized' } });
    try { return await action(request, reply, user.id); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: { statusCode: 400, code: 'INVALID_STYLE_PROFILE_REQUEST', message: 'Invalid style profile request' } });
      if (error instanceof DocumentAccessError || error instanceof StyleProfileError) return reply.status(error.statusCode).send({ error: { statusCode: error.statusCode, code: error.code, message: error.message } });
      throw error;
    }
  };
  app.post('/api/style-profiles', handler(async (request, reply, ownerUserId) => reply.status(201).send({ profile: await profiles.learnFromDocument({ ...learnSchema.parse(request.body), ownerUserId }) })));
  app.get('/api/style-profiles', handler(async (request, reply, userId) => {
    const { limit, offset } = listSchema.parse(request.query);
    return reply.send({ profiles: await profiles.list(userId, limit, offset), limit, offset });
  }));
  app.get('/api/style-profiles/:id', handler(async (request, reply, userId) => reply.send({ profile: await profiles.get(userId, idSchema.parse(request.params).id) })));
  app.patch('/api/style-profiles/:id', handler(async (request, reply, userId) => reply.send({ profile: await profiles.rename(userId, idSchema.parse(request.params).id, nameSchema.parse(request.body).name) })));
  app.delete('/api/style-profiles/:id', handler(async (request, reply, userId) => {
    await profiles.delete(userId, idSchema.parse(request.params).id);
    return reply.status(204).send();
  }));
}
