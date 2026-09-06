import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';

export async function readSandboxInstructions(dataRoot: string): Promise<string | undefined> {
  let file: FileHandle;
  try {
    file = await open(
      path.join(dataRoot, 'AGENTS.md'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  try {
    if (!(await file.stat()).isFile()) {
      throw new Error('AGENTS.md must be a regular file');
    }
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
