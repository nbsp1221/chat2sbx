import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import type { Sandbox, SandboxStatus } from '../../src/domain/types.js';
import { StateDatabase } from '../../src/state/database.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

function fixture(): { base: string; database: StateDatabase; service: WorkspaceService } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2sbx-workspaces-'));
  const database = new StateDatabase(':memory:');
  const service = new WorkspaceService({
    dataRoot: path.join(base, 'data'),
    database,
    now: () => 1_000,
    workspaceRoot: path.join(base, 'data', 'workspaces'),
  });
  onTestFinished(() => {
    database.close();
    fs.rmSync(base, { force: true, recursive: true });
  });
  return { base, database, service };
}

test('managed workspaces have an independent stable id and private directory', () => {
  const { service } = fixture();
  const workspace = service.createManaged('owner');

  expect(workspace.id).toMatch(/^ws_/);
  expect(path.basename(workspace.root)).toBe(workspace.id);
  expect(workspace.status).toBe('active');
  expect(fs.statSync(workspace.root).mode & 0o777).toBe(0o700);
});

test('retained managed workspaces remain retained until explicitly activated', () => {
  const { service } = fixture();
  const workspace = service.createManaged('owner');
  service.retain(workspace, 10_000);

  const available = service.getAvailable('owner', workspace.id);
  expect(available.status).toBe('retained');
  expect(available.retainedUntil).toBe(10_000);

  const activated = service.activate(available);
  expect(activated.status).toBe('active');
  expect(activated.retainedUntil).toBeUndefined();
  expect(service.getAvailable('owner', workspace.id).status).toBe('active');
});

test.each<SandboxStatus>(['creating', 'running', 'destroying', 'failed'])(
  'expired retained workspaces with a %s sandbox are not archived',
  (status) => {
    const { database, service } = fixture();
    const workspace = service.createManaged('owner');
    service.retain(workspace, 1_000);
    const unfinished: Sandbox = {
      id: `sbx_${status}`,
      ownerId: 'owner',
      workspaceId: workspace.id,
      runtimeName: `runtime-${status}`,
      status,
      createdAt: 900,
      lastActivityAt: 900,
      expiresAt: 2_000,
    };
    database.insertSandboxWithinLimit(unfinished);

    expect(service.archiveExpired(1_000)).toEqual([]);
    expect(service.getAvailable('owner', workspace.id).status).toBe('retained');
    expect(fs.existsSync(workspace.root)).toBe(true);
  },
);

test('expired retained workspaces are archived indefinitely after their sandbox is destroyed', () => {
  const { database, service } = fixture();
  const workspace = service.createManaged('owner');
  service.retain(workspace, 1_000);
  database.insertSandboxWithinLimit({
    id: 'sbx_destroyed',
    ownerId: 'owner',
    workspaceId: workspace.id,
    runtimeName: 'runtime-destroyed',
    status: 'destroyed',
    createdAt: 900,
    lastActivityAt: 900,
    expiresAt: 950,
    destroyedAt: 975,
  });

  const archived = service.archiveExpired(1_000);
  expect(archived).toEqual([expect.objectContaining({ id: workspace.id, status: 'archived' })]);
  expect(path.basename(path.dirname(archived[0]!.root))).toBe('archive');
  expect(fs.existsSync(archived[0]!.root)).toBe(true);
  expect(service.list('owner')[0]?.status).toBe('archived');
  expect(() => service.getAvailable('owner', workspace.id)).toThrow(/unavailable workspace/);
  expect(service.archiveExpired(100_000)).toEqual([]);
  expect(fs.existsSync(archived[0]!.root)).toBe(true);
});
