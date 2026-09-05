import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readSandboxInstructions(dataRoot: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(dataRoot, 'AGENTS.md'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
