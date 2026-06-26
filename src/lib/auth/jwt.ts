import jwt from 'jsonwebtoken';
import { env } from '@/lib/env';

export interface TokenPayload {
  sub: string;
  tenantId: string | null;  // null for platform users
  role: string;
  type: 'tenant' | 'platform';
}

interface SignedPayload extends TokenPayload {
  iat: number;
  exp: number;
}

export function issueToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.auth.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: env.auth.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): SignedPayload {
  try {
    const decoded = jwt.verify(token, env.auth.jwtSecret, { algorithms: ['HS256'] });
    return decoded as SignedPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new Error('Token expired');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid token');
    }
    throw err;
  }
}

/** Extract Bearer token from an Authorization header value. */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}
