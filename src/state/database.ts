import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Sandbox, SandboxStatus, Workspace, WorkspaceStatus } from '../domain/types.js';
import { migrate } from './migrations.js';

type SqlValue = string | number | null;

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function workspaceStatusFromRow(value: unknown): WorkspaceStatus {
  if (value === 'approved') {
    return 'active';
  }
  if (value === 'retained') {
    return value;
  }
  if (value === 'trashed') {
    return 'archived';
  }
  throw new Error(`Invalid managed workspace status: ${String(value)}`);
}

function workspaceStatusForDatabase(status: WorkspaceStatus): 'approved' | 'retained' | 'trashed' {
  if (status === 'active') {
    return 'approved';
  }
  return status === 'archived' ? 'trashed' : status;
}

function workspaceFromRow(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    root: String(row.root),
    status: workspaceStatusFromRow(row.status),
    createdAt: Number(row.created_at),
    retainedUntil: optionalNumber(row.retained_until),
  };
}

function sandboxFromRow(row: Record<string, unknown>): Sandbox {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    workspaceId: String(row.workspace_id),
    runtimeName: String(row.runtime_name),
    runtimeRoot: optionalString(row.runtime_root),
    status: row.status as SandboxStatus,
    endpoint: optionalString(row.endpoint),
    authToken: optionalString(row.auth_token),
    error: optionalString(row.error),
    createdAt: Number(row.created_at),
    lastActivityAt: Number(row.last_activity_at),
    expiresAt: Number(row.expires_at),
    destroyedAt: optionalNumber(row.destroyed_at),
    memoryBytes: optionalNumber(row.memory_bytes),
  };
}

const MANAGED_WORKSPACE = "kind = 'managed' AND mode = 'managed'";

export class StateDatabase {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(databasePath);
    if (databasePath !== ':memory:') {
      fs.chmodSync(databasePath, 0o600);
    }
    try {
      this.#database.exec(
        'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
      );
      migrate(this.#database);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  insertWorkspace(workspace: Workspace): void {
    this.#database
      .prepare(`INSERT INTO workspaces
      (id, owner_id, kind, mode, root, status, created_at, retained_until)
      VALUES (?, ?, 'managed', 'managed', ?, ?, ?, ?)`)
      .run(
        workspace.id,
        workspace.ownerId,
        workspace.root,
        workspaceStatusForDatabase(workspace.status),
        workspace.createdAt,
        workspace.retainedUntil ?? null,
      );
  }

  updateWorkspaceStatus(id: string, status: WorkspaceStatus, retainedUntil?: number): void {
    this.#database
      .prepare(
        `UPDATE workspaces SET status = ?, retained_until = ? WHERE id = ? AND ${MANAGED_WORKSPACE}`,
      )
      .run(workspaceStatusForDatabase(status), retainedUntil ?? null, id);
  }

  updateWorkspaceLocation(
    id: string,
    root: string,
    status: WorkspaceStatus,
    retainedUntil?: number,
  ): void {
    this.#database
      .prepare(
        `UPDATE workspaces SET root = ?, status = ?, retained_until = ? WHERE id = ? AND ${MANAGED_WORKSPACE}`,
      )
      .run(root, workspaceStatusForDatabase(status), retainedUntil ?? null, id);
  }

  getWorkspace(id: string, ownerId?: string): Workspace | undefined {
    const row = ownerId
      ? this.#database
          .prepare(
            `SELECT * FROM workspaces WHERE id = ? AND owner_id = ? AND ${MANAGED_WORKSPACE}`,
          )
          .get(id, ownerId)
      : this.#database
          .prepare(`SELECT * FROM workspaces WHERE id = ? AND ${MANAGED_WORKSPACE}`)
          .get(id);
    return row ? workspaceFromRow(row) : undefined;
  }

  listWorkspaces(ownerId: string): readonly Workspace[] {
    return this.#database
      .prepare(
        `SELECT * FROM workspaces WHERE owner_id = ? AND ${MANAGED_WORKSPACE} ORDER BY created_at DESC`,
      )
      .all(ownerId)
      .map(workspaceFromRow);
  }

  listExpiredRetainedWorkspaces(now: number): readonly Workspace[] {
    return this.#database
      .prepare(`SELECT * FROM workspaces
      WHERE ${MANAGED_WORKSPACE} AND status = 'retained' AND retained_until <= ?
      AND NOT EXISTS (
        SELECT 1 FROM sandboxes
        WHERE sandboxes.workspace_id = workspaces.id
        AND sandboxes.status IN ('creating', 'running', 'destroying', 'failed')
      )`)
      .all(now)
      .map(workspaceFromRow);
  }

  insertSandboxWithinLimit(sandbox: Sandbox, maxActiveSandboxes?: number): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (maxActiveSandboxes !== undefined) {
        const row = this.#database
          .prepare(`SELECT COUNT(*) AS count FROM sandboxes
            JOIN workspaces ON workspaces.id = sandboxes.workspace_id
            WHERE ${MANAGED_WORKSPACE}
            AND (sandboxes.status IN ('creating', 'running', 'destroying')
              OR (sandboxes.status = 'failed' AND sandboxes.destroyed_at IS NULL))`)
          .get();
        if (Number(row?.count ?? 0) >= maxActiveSandboxes) {
          this.#database.exec('ROLLBACK');
          return false;
        }
      }
      this.#database
        .prepare(`INSERT INTO sandboxes
        (id, owner_id, workspace_id, runtime_name, runtime_root, status, endpoint, auth_token, error, created_at, last_activity_at, expires_at, destroyed_at, memory_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...this.#sandboxValues(sandbox));
      this.#database.exec('COMMIT');
      return true;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  saveSandbox(sandbox: Sandbox): void {
    this.#database
      .prepare(`UPDATE sandboxes SET
      owner_id = ?, workspace_id = ?, runtime_name = ?, runtime_root = ?, status = ?, endpoint = ?, auth_token = ?, error = ?,
      created_at = ?, last_activity_at = ?, expires_at = ?, destroyed_at = ?, memory_bytes = ? WHERE id = ?`)
      .run(...this.#sandboxValues(sandbox).slice(1), sandbox.id);
  }

  #sandboxValues(sandbox: Sandbox): SqlValue[] {
    return [
      sandbox.id,
      sandbox.ownerId,
      sandbox.workspaceId,
      sandbox.runtimeName,
      sandbox.runtimeRoot ?? null,
      sandbox.status,
      sandbox.endpoint ?? null,
      sandbox.authToken ?? null,
      sandbox.error ?? null,
      sandbox.createdAt,
      sandbox.lastActivityAt,
      sandbox.expiresAt,
      sandbox.destroyedAt ?? null,
      sandbox.memoryBytes ?? null,
    ];
  }

  getSandbox(id: string, ownerId?: string): Sandbox | undefined {
    const ownerClause = ownerId ? 'AND sandboxes.owner_id = ?' : '';
    const statement = this.#database.prepare(`SELECT sandboxes.* FROM sandboxes
      JOIN workspaces ON workspaces.id = sandboxes.workspace_id
      WHERE sandboxes.id = ? ${ownerClause} AND ${MANAGED_WORKSPACE}`);
    const row = ownerId ? statement.get(id, ownerId) : statement.get(id);
    return row ? sandboxFromRow(row) : undefined;
  }

  findUnfinishedSandbox(ownerId: string, workspaceId: string): Sandbox | undefined {
    const row = this.#database
      .prepare(`SELECT sandboxes.* FROM sandboxes
      JOIN workspaces ON workspaces.id = sandboxes.workspace_id
      WHERE sandboxes.owner_id = ? AND sandboxes.workspace_id = ? AND ${MANAGED_WORKSPACE}
      AND sandboxes.status IN ('creating', 'running', 'destroying', 'failed')
      ORDER BY sandboxes.created_at DESC LIMIT 1`)
      .get(ownerId, workspaceId);
    return row ? sandboxFromRow(row) : undefined;
  }

  listCurrentSandboxes(ownerId: string): readonly Sandbox[] {
    return this.#database
      .prepare(`SELECT sandboxes.* FROM sandboxes
        JOIN workspaces ON workspaces.id = sandboxes.workspace_id
        WHERE sandboxes.owner_id = ? AND sandboxes.status != 'destroyed' AND ${MANAGED_WORKSPACE}
        ORDER BY sandboxes.created_at DESC`)
      .all(ownerId)
      .map(sandboxFromRow);
  }

  listActiveSandboxes(): readonly Sandbox[] {
    return this.#database
      .prepare(`SELECT sandboxes.* FROM sandboxes
        JOIN workspaces ON workspaces.id = sandboxes.workspace_id
        WHERE ${MANAGED_WORKSPACE}
        AND (sandboxes.status IN ('creating', 'running', 'destroying')
          OR (sandboxes.status = 'failed' AND sandboxes.destroyed_at IS NULL))
        ORDER BY sandboxes.created_at DESC`)
      .all()
      .map(sandboxFromRow);
  }

  countActiveSandboxes(): number {
    const row = this.#database
      .prepare(`SELECT COUNT(*) AS count FROM sandboxes
        JOIN workspaces ON workspaces.id = sandboxes.workspace_id
        WHERE ${MANAGED_WORKSPACE}
        AND (sandboxes.status IN ('creating', 'running', 'destroying')
          OR (sandboxes.status = 'failed' AND sandboxes.destroyed_at IS NULL))`)
      .get();
    return Number(row?.count ?? 0);
  }

  listExpiredSandboxes(now: number): readonly Sandbox[] {
    return this.#database
      .prepare(`SELECT sandboxes.* FROM sandboxes
        JOIN workspaces ON workspaces.id = sandboxes.workspace_id
        WHERE sandboxes.status = 'running' AND sandboxes.expires_at <= ? AND ${MANAGED_WORKSPACE}`)
      .all(now)
      .map(sandboxFromRow);
  }
}
