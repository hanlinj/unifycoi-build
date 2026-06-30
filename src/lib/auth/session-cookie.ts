// The session cookie name, in a dependency-free module so edge middleware can import it
// without pulling in jsonwebtoken (which is not edge-compatible). lib/api re-exports it.
export const SESSION_COOKIE = 'uc_session';
