import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Generate a cryptographically random local auth token. */
export function generateToken(): string {
  return randomBytes(24).toString('hex');
}

/** Extract a bearer token from the `Authorization` header, or `null`. */
export function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}
