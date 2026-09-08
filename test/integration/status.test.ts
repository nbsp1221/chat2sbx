import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { status } from '../../src/cli/status.js';
import { loadRuntimeConfig } from '../../src/config.js';
import { StateDatabase } from '../../src/state/database.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('reports a stopped service when no live PID exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat2sbx-status-'));
  roots.push(root);
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));

  const ready = await status(
    loadRuntimeConfig({
      CHAT2SBX_DATA_ROOT: path.join(root, '.chat2sbx'),
      CHAT2SBX_MAX_ACTIVE_SANDBOXES: '2',
    }),
  );

  expect(ready).toBe(false);
  expect(output).toEqual(['Service  stopped', 'Sandboxes 0 active / 2 max']);
});

test('ignores legacy host sandboxes in the active count', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat2sbx-status-'));
  roots.push(root);
  const config = loadRuntimeConfig({ CHAT2SBX_DATA_ROOT: path.join(root, '.chat2sbx') });
  new StateDatabase(config.databasePath).close();

  const database = new DatabaseSync(config.databasePath);
  database.exec(`
    INSERT INTO workspaces
      (id, owner_id, kind, mode, root, status, created_at, retained_until)
    VALUES ('ws_legacy', 'owner', 'host', 'direct', '/tmp/legacy', 'approved', 1, NULL);
    INSERT INTO sandboxes
      (id, owner_id, workspace_id, runtime_name, status, created_at, last_activity_at, expires_at)
    VALUES ('sbx_legacy', 'owner', 'ws_legacy', 'c2s-legacy', 'running', 1, 1, 999999);
  `);
  database.close();

  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
  expect(await status(config)).toBe(false);
  expect(output).toContain('Sandboxes 0 active / unlimited max');
});

test('checks the running process and MCP health', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat2sbx-status-'));
  roots.push(root);
  const server = http.createServer((_request, response) => {
    response.writeHead(200).end('{"status":"ok"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP listener');
  }

  const config = loadRuntimeConfig({
    CHAT2SBX_DATA_ROOT: path.join(root, '.chat2sbx'),
    CHAT2SBX_PORT: String(address.port),
  });
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(config.runtimePidPath, `${process.pid}\n`);
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));

  try {
    expect(await status(config)).toBe(true);
    expect(output).toEqual([
      `Service  running (PID ${process.pid})`,
      `MCP      ready at 127.0.0.1:${address.port}`,
      'Sandboxes 0 active / unlimited max',
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
