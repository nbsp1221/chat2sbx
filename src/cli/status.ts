import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeConfig } from '../config.js';
import { gatewayUrl } from '../runtime/gateway-url.js';

async function isReady(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

async function runningPid(config: RuntimeConfig): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(config.runtimePidPath, 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return undefined;
    }
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

export async function status(config: RuntimeConfig): Promise<boolean> {
  const activeSandboxes = countActiveSandboxes(config.databasePath);
  const sandboxLimit = config.maxActiveSandboxes ?? 'unlimited';
  const pid = await runningPid(config);
  if (!pid) {
    console.log('Service  stopped');
    console.log(`Sandboxes ${activeSandboxes} active / ${sandboxLimit} max`);
    return false;
  }

  const mcpReady = await isReady(gatewayUrl(config, '/healthz'));

  console.log(`Service  running (PID ${pid})`);
  console.log(`MCP      ${mcpReady ? `ready at ${config.host}:${config.port}` : 'not ready'}`);
  console.log(`Sandboxes ${activeSandboxes} active / ${sandboxLimit} max`);
  return mcpReady;
}

function countActiveSandboxes(databasePath: string): number {
  if (databasePath !== ':memory:' && !existsSync(databasePath)) {
    return 0;
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM sandboxes
        JOIN workspaces ON workspaces.id = sandboxes.workspace_id
        WHERE workspaces.kind = 'managed' AND workspaces.mode = 'managed'
        AND (sandboxes.status IN ('creating', 'running', 'destroying')
          OR (sandboxes.status = 'failed' AND sandboxes.destroyed_at IS NULL))`)
      .get();
    return Number(row?.count ?? 0);
  } finally {
    database.close();
  }
}
