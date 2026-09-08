import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import type { Sandbox, SandboxStatus } from '../../src/domain/types.js';
import { StateDatabase } from '../../src/state/database.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

function fixture(): { base: string; database: StateDatabase; service: WorkspaceService } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2sbx-workspaces-'));
  const allowedRoot = path.join(base, 'allowed');
  fs.mkdirSync(allowedRoot);
  const database = new StateDatabase(':memory:');
  const service = new WorkspaceService({
    allowedHostRoots: [allowedRoot],
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
  expect(fs.statSync(workspace.root).mode & 0o777).toBe(0o700);
});

test('a host path becomes only a pending approval until approved locally', () => {
  const { base, service } = fixture();
  const repository = path.join(base, 'allowed', 'repo');
  fs.mkdirSync(repository);

  const request = service.requestHost('owner', repository, 'direct');
  expect(request.status).toBe('pending');
  expect('requestedPath' in request).toBe(true);

  const workspace = service.approve(request.id);
  expect(workspace.kind).toBe('host');
  expect(workspace.mode).toBe('direct');
  expect(workspace.root).toBe(repository);
});

test('an allowed host root can itself be registered as a workspace', () => {
  const { base, service } = fixture();
  const allowedRoot = path.join(base, 'allowed');

  const workspace = service.registerHost('owner', allowedRoot, 'direct');

  expect(workspace.root).toBe(allowedRoot);
  expect(workspace.mode).toBe('direct');
});

test('paths outside allow roots and protected paths are rejected', () => {
  const { base, service } = fixture();
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);

  expect(() => service.requestHost('owner', outside, 'clone')).toThrow(/allowed host root/);

  const protectedPath = path.join(base, 'allowed', '.ssh', 'repo');
  fs.mkdirSync(protectedPath, { recursive: true });
  expect(() => service.requestHost('owner', protectedPath, 'direct')).toThrow(
    /protected directory/,
  );
});

test('retained managed workspaces remain retained until explicitly activated', () => {
  const { service } = fixture();
  const workspace = service.createManaged('owner');
  service.retainManaged(workspace, 10_000);

  const available = service.getAvailable('owner', workspace.id);
  expect(available.status).toBe('retained');
  expect(available.retainedUntil).toBe(10_000);

  const activated = service.activate(available);
  expect(activated.status).toBe('approved');
  expect(activated.retainedUntil).toBeUndefined();
  expect(service.getAvailable('owner', workspace.id).status).toBe('approved');
});

test('host workspaces are disabled without an explicit allowed root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2sbx-disabled-host-'));
  const database = new StateDatabase(':memory:');
  const service = new WorkspaceService({
    allowedHostRoots: [],
    dataRoot: path.join(base, 'data'),
    database,
    workspaceRoot: path.join(base, 'data', 'workspaces'),
  });

  try {
    expect(() => service.requestHost('owner', path.join(base, 'missing'), 'clone')).toThrow(
      /Host workspaces are disabled/,
    );
  } finally {
    database.close();
    fs.rmSync(base, { force: true, recursive: true });
  }
});

test('existing host workspaces follow the current allowed roots', () => {
  const { base, database, service } = fixture();
  const repository = path.join(base, 'allowed', 'existing');
  fs.mkdirSync(repository);
  const workspace = service.registerHost('owner', repository, 'direct');
  const disabled = new WorkspaceService({
    allowedHostRoots: [],
    dataRoot: path.join(base, 'disabled-data'),
    database,
    workspaceRoot: path.join(base, 'disabled-data', 'workspaces'),
  });

  expect(() => disabled.getAvailable('owner', workspace.id)).toThrow(
    /Host workspaces are disabled/,
  );
});

test.each<SandboxStatus>(['creating', 'running', 'destroying', 'failed'])(
  'expired retained workspaces with a %s sandbox are not trashed',
  (status) => {
    const { database, service } = fixture();
    const workspace = service.createManaged('owner');
    service.retainManaged(workspace, 1_000);
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

    expect(service.trashExpired(1_000)).toEqual([]);
    expect(service.getAvailable('owner', workspace.id).status).toBe('retained');
    expect(fs.existsSync(workspace.root)).toBe(true);
  },
);

test('expired retained workspaces are trashed after their sandbox is destroyed', () => {
  const { database, service } = fixture();
  const workspace = service.createManaged('owner');
  service.retainManaged(workspace, 1_000);
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

  expect(service.trashExpired(1_000)).toEqual([
    expect.objectContaining({ id: workspace.id, status: 'trashed' }),
  ]);
  expect(service.list('owner')[0]?.status).toBe('trashed');
});
