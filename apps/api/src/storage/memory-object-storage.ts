import { Readable } from "node:stream";

import {
  ObjectNotFoundError,
  type GetObjectResult,
  type ObjectStorage,
  type PutObjectInput,
} from "./types.js";

/**
 * In-memory ObjectStorage for automated tests. Never talks to a network.
 */
export function createMemoryObjectStorage(options?: {
  /** When true, every `putObject` rejects. */
  readonly failPuts?: boolean;
  /** When true, every `deleteObject` rejects (cleanup-failure path). */
  readonly failDeletes?: boolean;
}): ObjectStorage & {
  readonly objects: Map<string, { body: Buffer; contentType: string }>;
} {
  const objects = new Map<string, { body: Buffer; contentType: string }>();

  return {
    objects,
    async putObject(input: PutObjectInput): Promise<void> {
      if (options?.failPuts) {
        throw new Error("memory storage putObject forced failure");
      }
      objects.set(input.key, {
        body: Buffer.from(input.body),
        contentType: input.contentType,
      });
    },
    async getObject(key: string): Promise<GetObjectResult> {
      const object = objects.get(key);
      if (!object) {
        throw new ObjectNotFoundError(key);
      }
      return {
        body: Readable.from(object.body),
        contentLength: object.body.byteLength,
        contentType: object.contentType,
      };
    },
    async deleteObject(key: string): Promise<void> {
      if (options?.failDeletes) {
        throw new Error("memory storage deleteObject forced failure");
      }
      objects.delete(key);
    },
  };
}
