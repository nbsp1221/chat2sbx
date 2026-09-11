import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import type { Sandbox, SandboxCreateResult, SandboxSummary } from '../../src/domain/types.js';
import type { PublishedPort, RuntimeInfo, SandboxDriver } from '../../src/sandbox/sbx-driver.js';
import { SandboxService } from '../../src/sandbox/service.js';
import { StateDatabase } from '../../src/state/database.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

class FakeDriver implements SandboxDriver {
  readonly runtimes = new Map<string, RuntimeInfo>();
  createCalls = 0;
  createWait: Promise<void> | undefined;
  readonly memoryCalls: Array<number | undefined> = [];
  healthy = true;
  healthError: Error | undefined;
  removeError: Error | undefined;
  removeWait: Promise<void> | undefined;
  removeCalls = 0;
  startCalls = 0;

  assertReady(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async create(
    name: string,
    _workspace: unknown,
    memoryBytes?: number,
  ): Promise<{ endpoint: string; runtimeRoot: string }> {
    this.createCalls += 1;
    this.memoryCalls.push(memoryBytes);
    this.runtimes.set(name, { name, status: 'running' });
    await this.createWait;
    return { endpoint: 'http://127.0.0.1:1234/mcp', runtimeRoot: '/workspace' };
  }

  expose(
    _name: string,
    sandboxPort: number,
    host: string,
    hostPort?: number,
  ): Promise<PublishedPort> {
    return Promise.resolve({ host, hostPort: hostPort ?? 32_000, sandboxPort });
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.healthy);
  }

  list(): Promise<readonly RuntimeInfo[]> {
    return Promise.resolve([...this.runtimes.values()]);
  }

  async remove(name: string): Promise<void> {
    this.removeCalls += 1;
    const wait = this.removeWait;
    this.removeWait = undefined;
    await wait;
    if (this.removeError) {
      throw this.removeError;
    }
    this.runtimes.delete(name);
  }

  startCodexPro(): Promise<void> {
    this.startCalls += 1;
    return this.healthError ? Promise.reject(this.healthError) : Promise.resolve();
  }
}

function config(base: string): AppConfig {
  return {
    dataRoot: path.join(base, 'data'),
    databasePath: ':memory:',
    host: '127.0.0.1',
    idleTimeoutMs: 1_000,
    maxBodyBytes: 1_024,
    port: 0,
    reaperIntervalMs: 100,
    sandboxPort: 18_787,
    sandboxTemplate: 'test:latest',
    sbxBinary: 'sbx',
    stateDir: path.join(base, 'state'),
    workspaceRetentionMs: 7_000,
    workspaceRoot: path.join(base, 'data', 'workspaces'),
  };
}

function fixture(
  prefix: string,
  now?: () => number,
): {
  appConfig: AppConfig;
  base: string;
  database: StateDatabase;
  driver: FakeDriver;
  service: SandboxService;
  workspaces: WorkspaceService;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const database = new StateDatabase(':memory:');
  const appConfig = config(base);
  const workspaces = new WorkspaceService({
    dataRoot: appConfig.dataRoot,
    database,
    workspaceRoot: appConfig.workspaceRoot,
  });
  const driver = new FakeDriver();
  const service = new SandboxService({ config: appConfig, database, driver, now, workspaces });

  onTestFinished(() => {
    database.close();
    fs.rmSync(base, { force: true, recursive: true });
  });

  return { appConfig, base, database, driver, service, workspaces };
}

function sandboxFrom(result: SandboxCreateResult): SandboxSummary {
  return result.sandbox;
}

test('explicit sandbox ids are reusable and one active sandbox is kept per workspace', async () => {
  const { driver, service, workspaces } = fixture('chat2sbx-sandbox-');

  const firstResult = await service.create('owner', {});
  expect(firstResult.status).toBe('created');
  const first = sandboxFrom(firstResult);

  const secondResult = await service.create('owner', { workspaceId: first.workspace.id });
  expect(secondResult.status).toBe('reused');
  expect(sandboxFrom(secondResult).id).toBe(first.id);
  expect(driver.createCalls).toBe(1);

  const destroyed = await service.destroy('owner', first.id);
  expect(destroyed.status).toBe('destroyed');
  expect(driver.removeCalls).toBe(1);
  expect(workspaces.list('owner')[0]?.status).toBe('retained');

  const replacement = sandboxFrom(
    await service.create('owner', { workspaceId: first.workspace.id }),
  );
  expect(replacement.workspace.status).toBe('active');
});

test('applies an optional active sandbox limit without blocking reuse or later creation', async () => {
  const { appConfig, database, driver, workspaces } = fixture('chat2sbx-limit-');
  const limited = new SandboxService({
    config: { ...appConfig, maxActiveSandboxes: 1 },
    database,
    driver,
    workspaces,
  });

  const first = sandboxFrom(await limited.create('owner', {}));
  await expect(limited.create('owner', { workspaceId: first.workspace.id })).resolves.toMatchObject(
    {
      status: 'reused',
    },
  );
  await expect(limited.create('owner', {})).rejects.toThrow(/1 maximum/);
  expect(workspaces.list('owner')).toHaveLength(1);

  await limited.destroy('owner', first.id);
  await expect(limited.create('owner', {})).resolves.toMatchObject({ status: 'created' });
});

test('a sandbox limit failure preserves a retained workspace and its deadline', async () => {
  const { appConfig, database, driver, service, workspaces } = fixture('chat2sbx-retained-limit-');
  const retainedSandbox = sandboxFrom(await service.create('owner', {}));
  await service.destroy('owner', retainedSandbox.id);
  const retained = workspaces.getAvailable('owner', retainedSandbox.workspace.id);
  const retainedUntil = retained.retainedUntil;

  const occupyingSandbox = await service.create('owner', {});
  expect(occupyingSandbox.status).toBe('created');
  const limited = new SandboxService({
    config: { ...appConfig, maxActiveSandboxes: 1 },
    database,
    driver,
    workspaces,
  });

  await expect(
    limited.create('owner', { workspaceId: retainedSandbox.workspace.id }),
  ).rejects.toThrow(/1 maximum/);
  expect(workspaces.getAvailable('owner', retainedSandbox.workspace.id)).toMatchObject({
    retainedUntil,
    status: 'retained',
  });
});

test('passes an explicit memory limit and rejects changing it on reuse', async () => {
  const { driver, service } = fixture('chat2sbx-memory-');
  const first = sandboxFrom(await service.create('owner', { memory: '4g' }));

  expect(first.memory).toBe('4g');
  expect(driver.memoryCalls).toEqual([4 * 1024 * 1024 * 1024]);
  await expect(service.create('owner', { workspaceId: first.workspace.id })).resolves.toMatchObject(
    { status: 'reused' },
  );
  await expect(
    service.create('owner', { memory: '4096m', workspaceId: first.workspace.id }),
  ).resolves.toMatchObject({ status: 'reused' });
  await expect(
    service.create('owner', { memory: '8g', workspaceId: first.workspace.id }),
  ).rejects.toThrow(/destroy it before changing memory/);
  await expect(service.create('owner', { memory: '4GB' })).rejects.toThrow(/512m or 4g/);
});

test('exposes a running sandbox port with direct host mapping controls', async () => {
  const { service } = fixture('chat2sbx-expose-');
  const created = sandboxFrom(await service.create('owner', {}));

  await expect(service.expose('owner', created.id, 3_000)).resolves.toEqual({
    host: '127.0.0.1',
    hostPort: 32_000,
    sandboxId: created.id,
    sandboxPort: 3_000,
  });
  await expect(service.expose('owner', created.id, 3_000, '0.0.0.0', 8_080)).resolves.toEqual({
    host: '0.0.0.0',
    hostPort: 8_080,
    sandboxId: created.id,
    sandboxPort: 3_000,
  });
  await expect(service.expose('owner', created.id, 0)).rejects.toThrow(/sandbox_port/);
  await expect(service.expose('owner', created.id, 3_000, 'localhost')).rejects.toThrow(/IPv4/);
  await expect(service.expose('owner', created.id, 3_000, '127.0.0.1', 0)).rejects.toThrow(
    /host_port/,
  );
});

test('an unavailable runtime becomes an explicit failed sandbox without automatic restart', async () => {
  const { driver, service } = fixture('chat2sbx-failed-');
  const created = sandboxFrom(await service.create('owner', {}));
  driver.healthy = false;

  await expect(service.readyForTool('owner', created.id)).rejects.toThrow(
    /destroy this sandbox and create a new one/,
  );
  expect(driver.startCalls).toBe(1);
  expect(driver.removeCalls).toBe(1);
  expect(driver.runtimes.size).toBe(0);
  expect(service.list('owner')[0]?.status).toBe('failed');
});

test('a failed creation remains pending when runtime cleanup fails', async () => {
  const { appConfig, database, driver, workspaces } = fixture('chat2sbx-create-cleanup-');
  const limited = new SandboxService({
    config: { ...appConfig, maxActiveSandboxes: 1 },
    database,
    driver,
    workspaces,
  });
  driver.healthError = new Error('health failed');
  driver.removeError = new Error('cleanup failed');

  await expect(limited.create('owner', {})).rejects.toThrow('health failed');

  const failed = limited.list('owner')[0];
  expect(failed).toMatchObject({
    status: 'failed',
    error: 'health failed; runtime cleanup failed: cleanup failed',
  });
  expect(failed?.destroyedAt).toBeUndefined();
  expect(database.countActiveSandboxes()).toBe(1);
  expect(driver.runtimes.size).toBe(1);
});

test('destroy waits for sandbox creation before removing it', async () => {
  const { driver, service } = fixture('chat2sbx-create-destroy-');
  let finishCreation: (() => void) | undefined;
  driver.createWait = new Promise<void>((resolve) => {
    finishCreation = resolve;
  });

  const creation = service.create('owner', {});
  while (driver.createCalls === 0) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  const creating = service.list('owner')[0];
  if (!creating || !finishCreation) {
    throw new Error('Expected sandbox creation to be pending');
  }
  let destroyCompleted = false;
  const destruction = service.destroy('owner', creating.id).then((result) => {
    destroyCompleted = true;
    return result;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(destroyCompleted).toBe(false);

  finishCreation();
  await expect(creation).resolves.toMatchObject({ status: 'created' });
  await expect(destruction).resolves.toMatchObject({ status: 'destroyed' });
  expect(service.get('owner', creating.id).status).toBe('destroyed');
});

test('destroy waits for failed creation cleanup before removing its record', async () => {
  const { driver, service } = fixture('chat2sbx-create-failure-destroy-');
  driver.healthError = new Error('health failed');
  let finishCleanup: (() => void) | undefined;
  driver.removeWait = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });

  const creation = service.create('owner', {});
  while (driver.removeCalls === 0) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  const failed = service.list('owner')[0];
  if (!failed || !finishCleanup) {
    throw new Error('Expected failed sandbox cleanup to be pending');
  }
  let destroyCompleted = false;
  const destruction = service.destroy('owner', failed.id).then((result) => {
    destroyCompleted = true;
    return result;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(destroyCompleted).toBe(false);

  finishCleanup();
  await expect(creation).rejects.toThrow('health failed');
  await expect(destruction).resolves.toMatchObject({ status: 'destroyed' });
  expect(service.get('owner', failed.id).status).toBe('destroyed');
});

test('an unhealthy sandbox cannot be reused while its runtime is being removed', async () => {
  const { appConfig, database, driver, workspaces } = fixture('chat2sbx-unhealthy-race-');
  const limited = new SandboxService({
    config: { ...appConfig, maxActiveSandboxes: 1 },
    database,
    driver,
    workspaces,
  });
  const created = sandboxFrom(await limited.create('owner', {}));
  let finishRemoval: (() => void) | undefined;
  driver.removeWait = new Promise<void>((resolve) => {
    finishRemoval = resolve;
  });
  driver.healthy = false;

  const healthCheck = limited.readyForTool('owner', created.id);
  while (driver.removeCalls === 0) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  await expect(limited.create('owner', {})).rejects.toThrow(/Active sandbox limit reached/);
  await expect(limited.create('owner', { workspaceId: created.workspace.id })).rejects.toThrow(
    /sandbox in failed state/,
  );
  if (!finishRemoval) {
    throw new Error('Expected runtime removal to be waiting');
  }
  finishRemoval();
  await expect(healthCheck).rejects.toThrow(/destroy this sandbox and create a new one/);
});

test('restart preserves a failed sandbox while its unhealthy runtime cleanup is pending', async () => {
  const { appConfig, database, driver, service, workspaces } = fixture(
    'chat2sbx-unhealthy-restart-',
  );
  const created = sandboxFrom(await service.create('owner', {}));
  database.saveSandbox({
    ...database.getSandbox(created.id, 'owner')!,
    status: 'failed',
    endpoint: undefined,
    authToken: undefined,
    error: 'CodexPro is unavailable; destroy this sandbox and create a new one',
  });

  const restarted = new SandboxService({ config: appConfig, database, driver, workspaces });
  await restarted.reconcile();

  const reconciled = restarted.get('owner', created.id);
  expect(reconciled).toMatchObject({
    status: 'failed',
    error: 'CodexPro is unavailable; destroy this sandbox and create a new one',
  });
  expect(typeof reconciled.destroyedAt).toBe('number');
});

test('a failed sandbox blocks only its workspace until explicit destruction', async () => {
  const { driver, service } = fixture('chat2sbx-failed-workspace-');
  const failed = sandboxFrom(await service.create('owner', {}));
  driver.healthy = false;
  await expect(service.readyForTool('owner', failed.id)).rejects.toThrow(/destroy this sandbox/);
  driver.healthy = true;

  await expect(service.create('owner', { workspaceId: failed.workspace.id })).rejects.toThrow(
    /sandbox in failed state/,
  );
  await expect(service.create('owner', {})).resolves.toMatchObject({ status: 'created' });

  await service.destroy('owner', failed.id);
  await expect(
    service.create('owner', { workspaceId: failed.workspace.id }),
  ).resolves.toMatchObject({ status: 'created' });
});

test('destroying a legacy failed record does not conflict with its running replacement', async () => {
  let now = 1_000;
  const { appConfig, database, service, workspaces } = fixture(
    'chat2sbx-legacy-failed-',
    () => now,
  );
  const workspace = workspaces.createManaged('owner');
  const base: Omit<Sandbox, 'id' | 'runtimeName' | 'status'> = {
    ownerId: 'owner',
    workspaceId: workspace.id,
    createdAt: 1_000,
    lastActivityAt: 1_000,
    expiresAt: 2_000,
  };
  const failed: Sandbox = {
    ...base,
    id: 'sbx_failed',
    runtimeName: 'runtime-failed',
    status: 'failed',
  };
  const running: Sandbox = {
    ...base,
    id: 'sbx_running',
    runtimeName: 'runtime-running',
    runtimeRoot: '/workspace',
    endpoint: 'http://127.0.0.1:1234/mcp',
    authToken: 'token',
    status: 'running',
  };
  database.insertSandboxWithinLimit(failed);
  database.insertSandboxWithinLimit(running);

  await expect(service.destroy('owner', failed.id)).resolves.toMatchObject({ status: 'destroyed' });
  expect(service.get('owner', running.id).status).toBe('running');
  expect(workspaces.getAvailable('owner', workspace.id).status).toBe('active');

  now = 50_000;
  await service.destroy('owner', running.id);
  expect(workspaces.getAvailable('owner', workspace.id)).toMatchObject({
    retainedUntil: now + appConfig.workspaceRetentionMs,
    status: 'retained',
  });
});

test('every completed tool call renews the idle deadline without an absolute lifetime', async () => {
  let now = 1_000;
  const { appConfig, service } = fixture('chat2sbx-activity-', () => now);
  const created = sandboxFrom(await service.create('owner', {}));

  for (let call = 0; call < 30; call += 1) {
    now += 500;
    await service.withReady('owner', created.id, () => Promise.resolve());
  }
  expect(service.get('owner', created.id).expiresAt).toBe(now + appConfig.idleTimeoutMs);

  now += 500;
  await expect(
    service.withReady('owner', created.id, () => Promise.reject(new Error('tool failed'))),
  ).rejects.toThrow(/tool failed/);
  const afterFailure = service.get('owner', created.id);
  expect(afterFailure.lastActivityAt).toBe(now);
  expect(afterFailure.expiresAt).toBe(now + appConfig.idleTimeoutMs);
});

test('idle removal retains its managed workspace for the configured period', async () => {
  let now = 1_000;
  const { appConfig, service, workspaces } = fixture('chat2sbx-expiry-', () => now);
  const created = sandboxFrom(await service.create('owner', {}));
  now += appConfig.idleTimeoutMs;

  const result = await service.reap();
  const workspace = workspaces.list('owner')[0];
  expect(result.destroyed).toEqual([created.id]);
  expect(workspace?.status).toBe('retained');
  expect(workspace?.retainedUntil).toBe(now + appConfig.workspaceRetentionMs);
});

test('idle cleanup rechecks activity after an in-flight call', async () => {
  let now = 1_000;
  const { appConfig, service } = fixture('chat2sbx-reaper-race-', () => now);
  const created = sandboxFrom(await service.create('owner', {}));
  let finishCall: (() => void) | undefined;
  const inFlightCall = service.withReady('owner', created.id, async () => {
    await new Promise<void>((resolve) => {
      finishCall = resolve;
    });
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  now += appConfig.idleTimeoutMs;
  const cleanup = service.reap();
  if (!finishCall) {
    throw new Error('Expected the in-flight call to start');
  }
  finishCall();
  await inFlightCall;

  expect((await cleanup).destroyed).toEqual([]);
  expect(service.get('owner', created.id).status).toBe('running');
});

test('a controller restart retires the previous runtime and allows immediate workspace reuse', async () => {
  const { appConfig, database, driver, service, workspaces } = fixture('chat2sbx-reconcile-');
  const created = sandboxFrom(await service.create('owner', {}));
  expect(created.status).toBe('running');

  const restartedController = new SandboxService({
    config: appConfig,
    database,
    driver,
    workspaces,
  });
  await restartedController.reconcile();

  expect(driver.removeCalls).toBe(1);
  expect(restartedController.get('owner', created.id).status).toBe('destroyed');
  expect(restartedController.list('owner')).toEqual([]);
  expect(workspaces.getAvailable('owner', created.workspace.id).status).toBe('retained');

  const replacement = sandboxFrom(
    await restartedController.create('owner', { workspaceId: created.workspace.id }),
  );
  expect(replacement.status).toBe('running');
  expect(replacement.workspace.status).toBe('active');
});

test('controller reconciliation records cleanup failures without blocking service startup', async () => {
  const { appConfig, database, driver, service, workspaces } = fixture(
    'chat2sbx-reconcile-failure-',
  );
  const created = sandboxFrom(await service.create('owner', {}));
  driver.removeError = new Error('sbx rm failed');

  const restartedController = new SandboxService({
    config: appConfig,
    database,
    driver,
    workspaces,
  });
  await expect(restartedController.reconcile()).resolves.toBeUndefined();

  expect(restartedController.get('owner', created.id)).toMatchObject({
    status: 'failed',
    destroyedAt: undefined,
  });
  expect(restartedController.get('owner', created.id).error ?? '').toMatch(/sbx rm failed/);
  expect(workspaces.getAvailable('owner', created.workspace.id).status).toBe('active');
  await expect(
    restartedController.create('owner', { workspaceId: created.workspace.id }),
  ).rejects.toThrow(/sandbox in failed state/);

  driver.removeError = undefined;
  await restartedController.destroy('owner', created.id);
  await expect(
    restartedController.create('owner', { workspaceId: created.workspace.id }),
  ).resolves.toMatchObject({ status: 'created' });
});
