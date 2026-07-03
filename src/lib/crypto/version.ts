// Current key version for envelope + field encryption. A HOOK for future key rotation —
// there is exactly ONE key version today and no rotation is performed. New ciphertext is
// stamped v1; legacy/unversioned ciphertext is treated as v1 on decrypt. A future rotation
// bumps this and maps version → key material in the crypto modules.
export const CURRENT_KEY_VERSION = 1;
