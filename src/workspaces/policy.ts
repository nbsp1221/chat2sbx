import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const blockedNames = new Set([
  '.aws',
  '.azure',
  '.config',
  '.docker',
  '.gnupg',
  '.kube',
  '.local',
  '.secrets',
  '.ssh',
]);

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class HostPathPolicy {
  readonly #allowedRoots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    this.#allowedRoots = allowedRoots.map((root) => fs.realpathSync.native(root));
  }

  resolveAndValidate(requestedPath: string): string {
    if (this.#allowedRoots.length === 0) {
      throw new Error(
        'Host workspaces are disabled; configure CHAT2SBX_ALLOWED_HOST_ROOTS to enable them',
      );
    }
    const expanded =
      requestedPath === '~'
        ? os.homedir()
        : requestedPath.startsWith('~/')
          ? path.join(os.homedir(), requestedPath.slice(2))
          : requestedPath;
    const resolved = fs.realpathSync.native(path.resolve(expanded));
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error('Workspace path must be a directory');
    }
    if (!this.#allowedRoots.some((root) => isWithin(resolved, root))) {
      throw new Error(
        `Workspace must be an allowed host root or below one: ${this.#allowedRoots.join(', ')}`,
      );
    }
    const names = resolved.split(path.sep);
    const blocked = names.find((name) => blockedNames.has(name));
    if (blocked) {
      throw new Error(`Workspace path contains a protected directory: ${blocked}`);
    }
    return resolved;
  }
}
