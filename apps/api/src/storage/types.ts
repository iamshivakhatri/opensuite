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

export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<void>;
  deleteObject(key: string): Promise<void>;
}
