export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Build the canonical object key for a vendor document. */
export function documentKey(tenantId: string, vendorId: string, documentId: string): string {
  return `tenants/${tenantId}/vendors/${vendorId}/${documentId}`;
}
