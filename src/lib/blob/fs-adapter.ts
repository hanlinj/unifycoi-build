// Filesystem BlobStore adapter — for tests/CI only.
// Never use STORAGE_DRIVER=filesystem in dev or prod.
import fs from 'fs';
import path from 'path';
import type { BlobStore } from './types';

export function createFsAdapter(basePath: string): BlobStore {
  return {
    async put(key: string, data: Buffer): Promise<void> {
      const fullPath = path.join(basePath, key);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, data);
    },

    async get(key: string): Promise<Buffer> {
      const fullPath = path.join(basePath, key);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`BlobStore: key not found: ${key}`);
      }
      return fs.readFileSync(fullPath);
    },

    async delete(key: string): Promise<void> {
      const fullPath = path.join(basePath, key);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    },
  };
}
