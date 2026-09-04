import type { Readable } from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  ObjectNotFoundError,
  type GetObjectResult,
  type ObjectStorage,
  type PutObjectInput,
} from "./types.js";

export interface S3ObjectStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly forcePathStyle: boolean;
}

/**
 * S3-compatible ObjectStorage using the AWS SDK. Works against MinIO, AWS S3,
 * Cloudflare R2, and other path-/virtual-hosted S3 APIs.
 */
export function createS3ObjectStorage(
  config: S3ObjectStorageConfig,
): ObjectStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async putObject(input: PutObjectInput): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
    },

    async getObject(key: string): Promise<GetObjectResult> {
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
          }),
        );

        if (!response.Body) {
          throw new ObjectNotFoundError(key);
        }

        // AWS SDK v3 Node.js runtime returns a Readable stream body.
        const body = response.Body as Readable;

        return {
          body,
          contentLength:
            typeof response.ContentLength === "number"
              ? response.ContentLength
              : undefined,
          contentType: response.ContentType,
        };
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          throw error;
        }
        if (isS3NotFound(error)) {
          throw new ObjectNotFoundError(key);
        }
        throw error;
      }
    },

    async deleteObject(key: string): Promise<void> {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }),
      );
    },
  };
}

function isS3NotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  const code =
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata
      ? Number(error.$metadata.httpStatusCode)
      : undefined;

  return (
    code === 404 ||
    name === "NoSuchKey" ||
    name === "NotFound" ||
    name === "NoSuchBucket"
  );
}
