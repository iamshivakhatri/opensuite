import type { Readable } from "node:stream";

/**
 * Minimal object-storage boundary. Application code depends only on this —
 * never on MinIO- or AWS-specific types. Implementations may talk to any
 * S3-compatible backend (MinIO, AWS S3, R2, …).
 */
export interface PutObjectInput {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

/**
 * Streaming object payload. Callers must consume or destroy `body`.
 * Provider SDKs stay behind the storage implementations.
 */
export interface GetObjectResult {
  readonly body: Readable;
  readonly contentLength: number | undefined;
  readonly contentType: string | undefined;
}

export class ObjectNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super("Object not found in storage");
    this.name = "ObjectNotFoundError";
    this.key = key;
  }
}

export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<void>;
  getObject(key: string): Promise<GetObjectResult>;
  deleteObject(key: string): Promise<void>;
}
