import { env } from '@/lib/env';
import { createS3Adapter } from './s3-adapter';
import { createFsAdapter } from './fs-adapter';
import type { BlobStore } from './types';

export type { BlobStore };
export { documentKey } from './types';

let _store: BlobStore | null = null;

export function getBlobStore(): BlobStore {
  if (!_store) {
    if (env.storage.driver === 's3') {
      const s3 = env.storage.s3;
      if (!s3.endpoint || !s3.region || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
        throw new Error('S3 BlobStore requires S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
      }
      _store = createS3Adapter({
        endpoint: s3.endpoint,
        region: s3.region,
        bucket: s3.bucket,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      });
    } else {
      _store = createFsAdapter(env.storage.path);
    }
  }
  return _store;
}

/** For tests: reset the cached store instance. */
export function resetBlobStore(): void {
  _store = null;
}
