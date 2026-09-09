import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, onTestFinished, test, vi } from 'vitest';
import { loadAppConfig } from '../../src/config.js';
import { SbxDriver } from '../../src/sandbox/sbx-driver.js';
import { SandboxService } from '../../src/sandbox/service.js';
import { StateDatabase } from '../../src/state/database.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

function databasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2sbx-migration-'));
  onTestFinished(() => fs.rmSync(root, { force: true, recursive: true }));
  return path.join(root, 'chat2sbx.sqlite');
}

test.each([false, true])(
  'reconciles hidden host runtimes without touching host files (cleanup failure=%s)',
  async (fail) => {
    const file = databasePath();
    const config = loadAppConfig({ CHAT2SBX_DATA_ROOT: path.dirname(file) });
    const database = new StateDatabase(file);
    const raw = new DatabaseSync(file);
    onTestFinished(() => {
      raw.close();
      database.close();
    });
    const hostRoot = path.join(path.dirname(file), 'host');
    fs.mkdirSync(hostRoot);
    fs.writeFileSync(path.join(hostRoot, 'keep.txt'), 'host data');
    raw
      .prepare(`INSERT INTO workspaces (id,owner_id,kind,mode,root,status,created_at)
    VALUES ('legacy','owner','host','direct',?,'approved',1)`)
      .run(hostRoot);
    raw.exec(`INSERT INTO sandboxes (id,owner_id,workspace_id,runtime_name,status,created_at,last_activity_at,expires_at)
    VALUES ('old','owner','legacy','old-runtime','running',1,1,99999)`);
    const workspaces = new WorkspaceService({
      database,
      dataRoot: config.dataRoot,
      workspaceRoot: config.workspaceRoot,
    });
    const driver = new SbxDriver({ binary: 'unused', template: 'unused', sandboxPort: 18787 });
    vi.spyOn(driver, 'list').mockResolvedValue([
      { name: 'old-runtime', status: 'running' },
      { name: 'unrelated', status: 'running' },
    ]);
    const remove = vi.spyOn(driver, 'remove');
    if (fail) {
      remove.mockRejectedValue(new Error('cleanup failed'));
    } else {
      remove.mockResolvedValue();
    }
    const service = new SandboxService({ database, workspaces, driver, config });
    await service.reconcile();
    expect(remove.mock.calls).toEqual([['old-runtime']]);
    expect(raw.prepare('SELECT status FROM sandboxes').get()?.status).toBe(
      fail ? 'failed' : 'destroyed',
    );
    expect(database.listSandboxesForReconciliation()).toHaveLength(fail ? 1 : 0);
    expect(database.listCurrentSandboxes('owner')).toEqual([]);
    if (fail) {
      remove.mockResolvedValue();
      await service.reconcile();
      expect(database.listSandboxesForReconciliation()).toHaveLength(0);
    }
    expect(fs.readFileSync(path.join(hostRoot, 'keep.txt'), 'utf8')).toBe('host data');
    expect(raw.prepare('SELECT root FROM workspaces').get()?.root).toBe(hostRoot);
  },
);

function version(database: DatabaseSync): number {
  return Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

function columns(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

function createVersionZeroDatabase(file: string, includeMemory = false): void {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE sandboxes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      runtime_name TEXT NOT NULL UNIQUE,
      runtime_root TEXT,
      status TEXT NOT NULL CHECK (status IN ('creating', 'running', 'destroying', 'destroyed', 'failed')),
      endpoint TEXT,
      auth_token TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      destroyed_at INTEGER${includeMemory ? ', memory_bytes INTEGER' : ''}
    );
    INSERT INTO sandboxes
      (id, owner_id, workspace_id, runtime_name, status, created_at, last_activity_at, expires_at)
    VALUES ('sbx_existing', 'owner', 'ws_existing', 'c2s-existing', 'failed', 1, 2, 3);
  `);
  database.close();
}

test('creates a fresh database at the latest schema version', () => {
  const file = databasePath();
  new StateDatabase(file).close();

  const database = new DatabaseSync(file, { readOnly: true });
  expect(version(database)).toBe(2);
  expect(columns(database, 'sandboxes')).toContain('memory_bytes');
  database.close();
});

test('upgrades the version-zero production schema without losing existing rows', () => {
  const file = databasePath();
  createVersionZeroDatabase(file);

  const migrated = new StateDatabase(file);
  expect(migrated.getSandbox('sbx_existing')).toBeUndefined();
  migrated.close();

  const database = new DatabaseSync(file, { readOnly: true });
  expect(version(database)).toBe(2);
  expect(columns(database, 'sandboxes')).toContain('memory_bytes');
  expect(database.prepare('SELECT COUNT(*) AS count FROM sandboxes').get()?.count).toBe(1);
  database.close();

  new StateDatabase(file).close();
});

test('keeps legacy host capability rows inert while preserving them in the database', () => {
  const file = databasePath();
  new StateDatabase(file).close();

  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO workspaces
      (id, owner_id, kind, mode, root, status, created_at, retained_until)
    VALUES ('ws_legacy_host', 'owner', 'host', 'direct', '/tmp/legacy-host', 'approved', 1, NULL);
    INSERT INTO approvals
      (id, owner_id, requested_path, mode, status, workspace_id, created_at, decided_at)
    VALUES ('approval_legacy', 'owner', '/tmp/legacy-host', 'direct', 'approved', 'ws_legacy_host', 1, 2);
    INSERT INTO sandboxes
      (id, owner_id, workspace_id, runtime_name, status, created_at, last_activity_at, expires_at)
    VALUES ('sbx_legacy_host', 'owner', 'ws_legacy_host', 'c2s-legacy-host', 'running', 1, 1, 999999);
  `);
  raw.close();

  const database = new StateDatabase(file);
  expect(database.getWorkspace('ws_legacy_host', 'owner')).toBeUndefined();
  expect(database.getSandbox('sbx_legacy_host', 'owner')).toBeUndefined();
  expect(database.listWorkspaces('owner')).toEqual([]);
  expect(database.listCurrentSandboxes('owner')).toEqual([]);
  expect(database.listActiveSandboxes()).toEqual([]);
  expect(database.countActiveSandboxes()).toBe(0);
  database.close();

  const preserved = new DatabaseSync(file, { readOnly: true });
  expect(
    preserved.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE kind = 'host'").get()?.count,
  ).toBe(1);
  expect(preserved.prepare('SELECT COUNT(*) AS count FROM approvals').get()?.count).toBe(1);
  expect(
    preserved.prepare("SELECT COUNT(*) AS count FROM sandboxes WHERE id = 'sbx_legacy_host'").get()
      ?.count,
  ).toBe(1);
  preserved.close();
});

test('rolls back every pending migration and its version when one fails', () => {
  const file = databasePath();
  createVersionZeroDatabase(file, true);

  expect(() => new StateDatabase(file)).toThrow(/duplicate column name/);

  const database = new DatabaseSync(file, { readOnly: true });
  expect(version(database)).toBe(0);
  expect(
    database.prepare("SELECT name FROM sqlite_schema WHERE name = 'workspaces'").get(),
  ).toBeUndefined();
  database.close();
});

test('rejects a database created by a newer chat2sbx version', () => {
  const file = databasePath();
  const database = new DatabaseSync(file);
  database.exec('PRAGMA user_version = 3');
  database.close();

  expect(() => new StateDatabase(file)).toThrow(/newer than supported version 2/);
});
