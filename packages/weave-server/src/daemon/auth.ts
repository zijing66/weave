import { randomBytes } from 'node:crypto';

/** Generate a cryptographically random project token (hook 采集 ptoken). */
export function generateToken(): string {
  return randomBytes(24).toString('hex');
}
