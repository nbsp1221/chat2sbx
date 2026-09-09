import { randomBytes } from 'node:crypto';

export type IdPrefix = 'ws' | 'sbx';

export function createId(prefix: IdPrefix): string {
  const timestamp = Date.now().toString(36).padStart(9, '0');
  const random = randomBytes(8).toString('hex');
  return `${prefix}_${timestamp}${random}`;
}
