import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { SbxDriver } from '../../src/sandbox/sbx-driver.js';
import { StateDatabase } from '../../src/state/database.js';

test.each(['SIGTERM', 'SIGINT'] as const)(
  'serve exits on %s with a live sandbox',
  async (signal) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2sbx-shutdown-'));
    const allocator = createServer();
    allocator.listen(0, '127.0.0.1');
    await once(allocator, 'listening');
    const address = allocator.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }
    allocator.close();
    await once(allocator, 'close');
    const databasePath = path.join(root, 'state', 'test.sqlite');
    const child = spawn(process.execPath, ['dist/cli.mjs', 'serve'], {
      env: {
        ...process.env,
        CHAT2SBX_DATA_ROOT: root,
        CHAT2SBX_STATE_DIR: path.join(root, 'state'),
        CHAT2SBX_DATABASE_PATH: databasePath,
        CHAT2SBX_WORKSPACE_ROOT: path.join(root, 'workspaces'),
        CHAT2SBX_HOST: '127.0.0.1',
        CHAT2SBX_PORT: String(address.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    try {
      await expect
        .poll(
          () => {
            if (child.exitCode !== null) {
              throw new Error(output);
            }
            return output.includes('MCP ready');
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'sandbox_create', arguments: { memory: '4g' } },
        }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const data = body.split(/\r?\n/).find((line) => line.startsWith('data:'));
      const result = JSON.parse(data ? data.slice(5) : body) as {
        result: { isError?: boolean; structuredContent: { status: string } };
      };
      expect(result.result.isError, body).not.toBe(true);
      expect(result.result.structuredContent.status).toBe('created');
      child.kill(signal);
      await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(0);
      expect(fs.existsSync(path.join(root, 'state', 'runtime.pid'))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      const database = new StateDatabase(databasePath);
      const driver = new SbxDriver({
        binary: 'sbx',
        template: 'chat2sbx-codexpro:0.30.0',
        sandboxPort: 18787,
      });
      try {
        for (const sandbox of database.listSandboxesForReconciliation()) {
          await driver.remove(sandbox.runtimeName);
        }
      } finally {
        database.close();
      }
      fs.rmSync(root, { recursive: true });
    }
  },
);
