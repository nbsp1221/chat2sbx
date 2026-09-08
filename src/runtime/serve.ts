import type { Server } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { SingleUserAuthProvider } from '../auth/single-user-provider.js';
import { BashSessionService } from '../codexpro/bash-sessions.js';
import { CodexProClientPool } from '../codexpro/client-pool.js';
import { publicCodexProTools } from '../codexpro/tool-manifest.js';
import { type RuntimeConfig, loadRuntimeConfig } from '../config.js';
import { createGateway } from '../mcp/gateway.js';
import { readSandboxInstructions } from '../sandbox/instructions.js';
import { SbxDriver } from '../sandbox/sbx-driver.js';
import { SandboxService } from '../sandbox/service.js';
import { StateDatabase } from '../state/database.js';
import { WorkspaceService } from '../workspaces/service.js';

async function claimRuntime(config: RuntimeConfig): Promise<void> {
  await mkdir(config.stateDir, { mode: 0o700, recursive: true });
  await chmod(config.stateDir, 0o700);
  let existingPid: number | undefined;
  try {
    existingPid = Number((await readFile(config.runtimePidPath, 'utf8')).trim());
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error;
    }
  }
  if (Number.isSafeInteger(existingPid) && existingPid && existingPid > 0) {
    try {
      process.kill(existingPid, 0);
      throw new Error(`chat2sbx is already running with PID ${existingPid}`);
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) {
        throw error;
      }
    }
  }
  await writeFile(config.runtimePidPath, `${process.pid}\n`, { mode: 0o600 });
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
  );
}

async function releaseRuntime(config: RuntimeConfig): Promise<void> {
  await rm(config.runtimePidPath, { force: true });
}

async function runRuntime(config: RuntimeConfig): Promise<void> {
  const database = new StateDatabase(config.databasePath);
  const workspaces = new WorkspaceService({
    database,
    workspaceRoot: config.workspaceRoot,
    dataRoot: config.dataRoot,
  });
  const driver = new SbxDriver({
    binary: config.sbxBinary,
    template: config.sandboxTemplate,
    sandboxPort: config.sandboxPort,
  });
  let server: Server | undefined;
  let codexPro: CodexProClientPool | undefined;
  let reaper: NodeJS.Timeout | undefined;

  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });

  const onSignal = (): void => requestStop();

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await driver.assertReady();
    console.log('[chat2sbx] reconciling previous sandbox state');
    const sandboxes = new SandboxService({ database, workspaces, driver, config });
    await sandboxes.reconcile();

    codexPro = new CodexProClientPool(sandboxes);
    const bashSessions = new BashSessionService(codexPro, (listener) =>
      sandboxes.onDestroy(listener),
    );
    const codexProTools = publicCodexProTools();
    server = createGateway(config, {
      authProvider: new SingleUserAuthProvider(),
      controlServer: {
        sandboxes,
        workspaces,
        codexPro,
        bashSessions,
        codexProTools,
        readSandboxInstructions: () => readSandboxInstructions(config.dataRoot),
      },
    });
    await listen(server, config);
    console.log(`[chat2sbx] MCP ready at http://${config.host}:${config.port}/mcp`);
    console.log(`[chat2sbx] ${codexProTools.length} CodexPro tools are sandbox-scoped`);

    reaper = setInterval(() => {
      sandboxes.reap().catch((error) => console.error('[chat2sbx] reaper failed', error));
    }, config.reaperIntervalMs);
    reaper.unref();

    await stopRequested;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (reaper) {
      clearInterval(reaper);
    }
    if (server) {
      await closeServer(server);
    }
    await codexPro?.closeAll();
    database.close();
  }
}

export async function serve(config: RuntimeConfig = loadRuntimeConfig()): Promise<void> {
  await claimRuntime(config);
  try {
    await runRuntime(config);
  } finally {
    await releaseRuntime(config);
  }
}

async function listen(server: Server, config: RuntimeConfig): Promise<void> {
  server.listen(config.port, config.host);
  await once(server, 'listening');
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
