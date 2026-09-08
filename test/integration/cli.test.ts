import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import { loadAppConfig } from '../../src/config.js';
import { StateDatabase } from '../../src/state/database.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function environment(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat2sbx-cli-'));
  roots.push(root);
  vi.stubEnv('CHAT2SBX_DATA_ROOT', path.join(root, 'data'));
  return root;
}

test('lists managed workspaces', async () => {
  await environment();
  const config = loadAppConfig();
  const database = new StateDatabase(config.databasePath);
  const workspaces = new WorkspaceService({
    database,
    dataRoot: config.dataRoot,
    workspaceRoot: config.workspaceRoot,
  });
  const workspace = workspaces.createManaged('local-owner');
  database.close();

  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
  await runCli(['node', 'chat2sbx', 'workspace', 'list']);

  expect(JSON.parse(output.pop() ?? '')).toEqual([
    expect.objectContaining({ id: workspace.id, root: workspace.root, status: 'active' }),
  ]);
});

test('rejects unknown commands and workspace actions', async () => {
  await environment();

  await expect(runCli(['node', 'chat2sbx', 'does-not-exist'])).rejects.toThrow(
    'Unknown command: does-not-exist',
  );
  await expect(runCli(['node', 'chat2sbx', 'workspace', 'add'])).rejects.toThrow(
    'Unknown workspace action: add',
  );
});
