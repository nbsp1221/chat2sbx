import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../domain/types.js';
import type { StateDatabase } from '../state/database.js';
import { createId } from '../domain/ids.js';

export class WorkspaceService {
  readonly #database: StateDatabase;
  readonly #workspaceRoot: string;
  readonly #trashRoot: string;
  readonly #now: () => number;

  constructor(options: {
    database: StateDatabase;
    workspaceRoot: string;
    dataRoot: string;
    now?: () => number;
  }) {
    this.#database = options.database;
    this.#workspaceRoot = options.workspaceRoot;
    this.#trashRoot = path.join(options.dataRoot, 'trash');
    this.#now = options.now ?? Date.now;
    fs.mkdirSync(this.#workspaceRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.#trashRoot, { recursive: true, mode: 0o700 });
  }

  createManaged(ownerId: string): Workspace {
    const id = createId('ws');
    const root = path.join(this.#workspaceRoot, id);
    fs.mkdirSync(root, { recursive: false, mode: 0o700 });
    const workspace: Workspace = {
      id,
      ownerId,
      root,
      status: 'active',
      createdAt: this.#now(),
    };
    try {
      this.#database.insertWorkspace(workspace);
      return workspace;
    } catch (error) {
      fs.rmdirSync(root);
      throw error;
    }
  }

  getAvailable(ownerId: string, workspaceId: string): Workspace {
    const workspace = this.#database.getWorkspace(workspaceId, ownerId);
    if (!workspace || workspace.status === 'trashed') {
      throw new Error(`Unknown or unavailable workspace: ${workspaceId}`);
    }
    return workspace;
  }

  activate(workspace: Workspace): Workspace {
    if (workspace.status !== 'retained') {
      return workspace;
    }
    this.#database.updateWorkspaceStatus(workspace.id, 'active');
    return { ...workspace, status: 'active', retainedUntil: undefined };
  }

  list(ownerId: string): readonly Workspace[] {
    return this.#database.listWorkspaces(ownerId);
  }

  retain(workspace: Workspace, retainedUntil: number): Workspace {
    this.#database.updateWorkspaceStatus(workspace.id, 'retained', retainedUntil);
    return { ...workspace, status: 'retained', retainedUntil };
  }

  trashExpired(now = this.#now()): readonly Workspace[] {
    const trashed: Workspace[] = [];
    for (const workspace of this.#database.listExpiredRetainedWorkspaces(now)) {
      const source = fs.realpathSync.native(workspace.root);
      const workspaceRoot = fs.realpathSync.native(this.#workspaceRoot);
      if (path.dirname(source) !== workspaceRoot || path.basename(source) !== workspace.id) {
        throw new Error(`Refusing to trash unexpected managed path: ${source}`);
      }
      const destination = path.join(this.#trashRoot, `${workspace.id}-${now}`);
      fs.renameSync(source, destination);
      this.#database.updateWorkspaceLocation(workspace.id, destination, 'trashed');
      trashed.push({
        ...workspace,
        root: destination,
        status: 'trashed',
        retainedUntil: undefined,
      });
    }
    return trashed;
  }
}
