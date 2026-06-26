import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import type { BlobStore } from './types';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks);
}

export function createS3Adapter(opts: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): BlobStore {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
    // Backblaze B2 requires path-style addressing
    forcePathStyle: true,
  });

  return {
    async put(key: string, data: Buffer): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          Body: data,
          ContentType: 'application/octet-stream',
        })
      );
    },

    async get(key: string): Promise<Buffer> {
      const response = await client.send(
        new GetObjectCommand({ Bucket: opts.bucket, Key: key })
      );
      if (!response.Body) {
        throw new Error(`BlobStore: empty body for key ${key}`);
      }
      return streamToBuffer(response.Body as Readable);
    },

    async delete(key: string): Promise<void> {
      await client.send(
        new DeleteObjectCommand({ Bucket: opts.bucket, Key: key })
      );
    },
  };
}
