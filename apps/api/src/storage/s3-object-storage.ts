import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { ObjectStorage, PutObjectInput } from "./types.js";

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
