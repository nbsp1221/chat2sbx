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

test('uses the local MCP gateway for sandbox list and destroy', async () => {
  await environment();
  const requests: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    if (typeof init?.body !== 'string') {
      throw new Error('Expected a JSON request body');
    }
    const request = JSON.parse(init.body) as Record<string, unknown>;
    requests.push(request);
    const params = request.params as { name: string };
    const structuredContent =
      params.name === 'sandbox_list'
        ? { sandboxes: [{ id: 'sbx_test', status: 'failed' }] }
        : { id: 'sbx_test', status: 'destroyed' };
    return Promise.resolve(
      new Response(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent } })}\n\n`,
        { status: 200 },
      ),
    );
  });
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));

  await runCli(['node', 'chat2sbx', 'sandbox', 'list']);
  await runCli(['node', 'chat2sbx', 'sandbox', 'destroy', 'sbx_test']);

  expect(JSON.parse(output[0] ?? '')).toEqual({
    sandboxes: [{ id: 'sbx_test', status: 'failed' }],
  });
  expect(JSON.parse(output[1] ?? '')).toEqual({ id: 'sbx_test', status: 'destroyed' });
  expect(requests.map((request) => (request.params as { name: string }).name)).toEqual([
    'sandbox_list',
    'sandbox_destroy',
  ]);
  const destroyRequest = requests[1];
  if (!destroyRequest) {
    throw new Error('Expected a sandbox_destroy request');
  }
  expect((destroyRequest.params as { arguments: Record<string, unknown> }).arguments).toEqual({
    sandbox_id: 'sbx_test',
  });
});

test('reports local MCP tool errors without hiding the lifecycle failure', async () => {
  await environment();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'Unknown sandbox: sbx_missing' }],
        },
      })}\n\n`,
      { status: 200 },
    ),
  );

  await expect(runCli(['node', 'chat2sbx', 'sandbox', 'destroy', 'sbx_missing'])).rejects.toThrow(
    'Unknown sandbox: sbx_missing',
  );
});

test('reports an actionable error when the local MCP gateway is unavailable', async () => {
  await environment();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection refused'));

  await expect(runCli(['node', 'chat2sbx', 'sandbox', 'list'])).rejects.toThrow(
    /start chat2sbx serve first/,
  );
});

test('rejects unknown commands and management actions', async () => {
  await environment();

  await expect(runCli(['node', 'chat2sbx', 'does-not-exist'])).rejects.toThrow(
    'Unknown command: does-not-exist',
  );
  await expect(runCli(['node', 'chat2sbx', 'workspace', 'add'])).rejects.toThrow(
    'Unknown workspace action: add',
  );
  await expect(runCli(['node', 'chat2sbx', 'sandbox', 'remove'])).rejects.toThrow(
    'Unknown sandbox action: remove',
  );
  await expect(runCli(['node', 'chat2sbx', 'sandbox', 'destroy'])).rejects.toThrow(
    'sandbox destroy requires an ID',
  );
  await expect(runCli(['node', 'chat2sbx', 'sandbox', 'list', 'sbx_test'])).rejects.toThrow(
    'sandbox list does not accept an ID',
  );
});
