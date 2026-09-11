import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Workspace } from '../domain/types.js';
import { formatMemory } from './memory.js';

const execFileAsync = promisify(execFile);
const PROCESS_STOP_GRACE_MS = 1_500;
const PROCESS_STDERR_LIMIT = 64 * 1_024;

interface TrackedProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: Buffer;
}

interface SbxPort {
  readonly host_ip: string;
  readonly host_port: number;
  readonly sandbox_port: number;
  readonly protocol: string;
}

function appendTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const next = Buffer.concat([current, chunk]);
  return next.byteLength <= limit ? next : next.subarray(next.byteLength - limit);
}

interface SbxListItem {
  readonly name: string;
  readonly status: string;
}

export interface RuntimeInfo {
  readonly name: string;
  readonly status: string;
}

export interface PublishedPort {
  readonly sandboxPort: number;
  readonly host: string;
  readonly hostPort: number;
}

export interface SandboxDriver {
  assertReady(): Promise<void>;
  create(
    runtimeName: string,
    workspace: Workspace,
    memoryBytes?: number,
  ): Promise<{ endpoint: string; runtimeRoot: string }>;
  startCodexPro(
    runtimeName: string,
    runtimeRoot: string,
    endpoint: string,
    authToken: string,
  ): Promise<void>;
  isHealthy(endpoint: string, authToken: string): Promise<boolean>;
  expose(
    runtimeName: string,
    sandboxPort: number,
    host: string,
    hostPort?: number,
  ): Promise<PublishedPort>;
  remove(runtimeName: string): Promise<void>;
  list(): Promise<readonly RuntimeInfo[]>;
  close(): Promise<void>;
}

export class SbxDriver implements SandboxDriver {
  readonly #binary: string;
  readonly #template: string;
  readonly #sandboxPort: number;
  readonly #codexProProcesses = new Map<string, TrackedProcess>();

  constructor(options: { binary: string; template: string; sandboxPort: number }) {
    this.#binary = options.binary;
    this.#template = options.template;
    this.#sandboxPort = options.sandboxPort;
  }

  async assertReady(): Promise<void> {
    const { stdout } = await this.#run(['template', 'ls', '--json']);
    const images = JSON.parse(stdout) as { images: Array<{ repository: string; tag: string }> };
    const requested = this.#template.replace(/^docker\.io\/library\//, '');
    const present = images.images.some(
      (image) =>
        `${image.repository}:${image.tag}`.replace(/^docker\.io\/library\//, '') === requested,
    );
    if (!present) {
      throw new Error(`Missing sandbox template ${this.#template}. Run chat2sbx setup first.`);
    }
  }

  async create(
    runtimeName: string,
    workspace: Workspace,
    memoryBytes?: number,
  ): Promise<{ endpoint: string; runtimeRoot: string }> {
    const args = [
      'create',
      '--quiet',
      '--name',
      runtimeName,
      '--template',
      this.#template,
      '--publish',
      String(this.#sandboxPort),
    ];
    if (memoryBytes !== undefined) {
      args.push('--memory', formatMemory(memoryBytes));
    }
    args.push('shell', workspace.root);
    await this.#run(args, 180_000);
    const [{ stdout: rootOutput }, { stdout: portsOutput }] = await Promise.all([
      this.#run(['exec', runtimeName, 'pwd']),
      this.#run(['ports', runtimeName, '--json']),
    ]);
    const ports = JSON.parse(portsOutput) as SbxPort[];
    const port = ports.find(
      (candidate) =>
        candidate.host_ip === '127.0.0.1' && candidate.sandbox_port === this.#sandboxPort,
    );
    if (!port) {
      throw new Error(
        `Sandbox ${runtimeName} did not publish port ${this.#sandboxPort} on IPv4 loopback`,
      );
    }
    return { endpoint: `http://127.0.0.1:${port.host_port}/mcp`, runtimeRoot: rootOutput.trim() };
  }

  async startCodexPro(
    runtimeName: string,
    runtimeRoot: string,
    endpoint: string,
    authToken: string,
  ): Promise<void> {
    if (this.#codexProProcesses.has(runtimeName)) {
      throw new Error(`CodexPro is already running in ${runtimeName}`);
    }
    // Docker Sandboxes currently ties a background guest process to the sbx exec scope.
    // Keep one attached exec session so CodexPro and its microVM remain alive.
    const child = spawn(
      this.#binary,
      [
        'exec',
        '-i',
        '-e',
        'CODEXPRO_HTTP_TOKEN',
        runtimeName,
        'codexpro-mcp-http',
        '--root',
        runtimeRoot,
        '--allow-root',
        runtimeRoot,
        '--host',
        '0.0.0.0',
        '--port',
        String(this.#sandboxPort),
        '--bash',
        'full',
        '--write',
        'workspace',
        '--tool-mode',
        'standard',
      ],
      {
        env: { ...process.env, CODEXPRO_HTTP_TOKEN: authToken },
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
    let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const tracked: TrackedProcess = {
      child,
      exited: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      stderr: Buffer.alloc(0),
    };
    this.#codexProProcesses.set(runtimeName, tracked);
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      tracked.stderr = appendTail(tracked.stderr, chunk, PROCESS_STDERR_LIMIT);
    });
    child.once('close', (code, signal) => {
      resolveExit({ code, signal });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    }).catch((error) => {
      this.#codexProProcesses.delete(runtimeName);
      throw error;
    });
    const readiness = new AbortController();
    try {
      const outcome = await Promise.race([
        this.#waitUntilHealthy(endpoint, authToken, readiness.signal).then(
          () => ({ status: 'ready' }) as const,
        ),
        tracked.exited.then((result) => ({ status: 'exited', ...result }) as const),
      ]);
      if (outcome.status === 'exited') {
        const reason =
          outcome.code === null ? `signal ${outcome.signal ?? 'unknown'}` : `code ${outcome.code}`;
        const detail = tracked.stderr.toString('utf8').trim();
        throw new Error(
          `sbx exec for ${runtimeName} exited with ${reason}${detail ? `: ${detail}` : ''}`,
        );
      }
    } finally {
      readiness.abort();
    }
  }

  async #waitUntilHealthy(
    endpoint: string,
    authToken: string,
    signal: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<void> {
    const healthUrl = new URL('/healthz', endpoint);
    const deadline = Date.now() + timeoutMs;
    let lastError = 'not ready';
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        const response = await fetch(healthUrl, {
          headers: { authorization: `Bearer ${authToken}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
        });
        if (response.ok) {
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        signal.throwIfAborted();
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(150, undefined, { signal });
    }
    throw new Error(`CodexPro did not become healthy: ${lastError}`);
  }

  async isHealthy(endpoint: string, authToken: string): Promise<boolean> {
    try {
      return (
        await fetch(new URL('/healthz', endpoint), {
          headers: { authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(1_000),
        })
      ).ok;
    } catch {
      return false;
    }
  }

  async expose(
    runtimeName: string,
    sandboxPort: number,
    host: string,
    hostPort?: number,
  ): Promise<PublishedPort> {
    const existing = await this.#publishedPort(runtimeName, sandboxPort, host, hostPort);
    if (existing) {
      return existing;
    }
    const resolvedHostPort = hostPort ?? (await this.#availableHostPort(host));
    await this.#run([
      'ports',
      runtimeName,
      '--publish',
      `${host}:${resolvedHostPort}:${sandboxPort}/tcp4`,
    ]);
    const published = await this.#publishedPort(runtimeName, sandboxPort, host, resolvedHostPort);
    if (!published) {
      throw new Error(
        `Sandbox ${runtimeName} did not publish ${host}:${resolvedHostPort} to port ${sandboxPort}`,
      );
    }
    return published;
  }

  async remove(runtimeName: string): Promise<void> {
    await this.#stopCodexPro(runtimeName);
    if ((await this.list()).some((runtime) => runtime.name === runtimeName)) {
      await this.#run(['rm', '--force', runtimeName], 120_000);
    }
  }

  async list(): Promise<readonly RuntimeInfo[]> {
    const { stdout } = await this.#run(['ls', '--json']);
    const parsed = JSON.parse(stdout) as { sandboxes: SbxListItem[] };
    return parsed.sandboxes.map(({ name, status }) => ({ name, status }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.#codexProProcesses.keys()].map((name) => this.#stopCodexPro(name)));
  }

  async #stopCodexPro(runtimeName: string): Promise<void> {
    const tracked = this.#codexProProcesses.get(runtimeName);
    if (!tracked) {
      return;
    }
    this.#codexProProcesses.delete(runtimeName);
    const { child } = tracked;
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    const exited = once(child, 'exit').then(() => undefined);
    child.stdin?.end();
    child.kill('SIGTERM');
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), PROCESS_STOP_GRACE_MS);
        timer.unref();
      }),
    ]);
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  async #publishedPort(
    runtimeName: string,
    sandboxPort: number,
    host: string,
    hostPort?: number,
  ): Promise<PublishedPort | undefined> {
    const { stdout } = await this.#run(['ports', runtimeName, '--json']);
    const ports = JSON.parse(stdout) as SbxPort[];
    const port = ports.find(
      (candidate) =>
        candidate.host_ip === host &&
        candidate.sandbox_port === sandboxPort &&
        candidate.protocol === 'tcp4' &&
        (hostPort === undefined || candidate.host_port === hostPort),
    );
    return port
      ? { sandboxPort: port.sandbox_port, host: port.host_ip, hostPort: port.host_port }
      : undefined;
  }

  async #availableHostPort(host: string): Promise<number> {
    const server = createServer();
    return new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        const address = server.address();
        server.close((error) => {
          if (error) {
            reject(error);
          } else if (!address || typeof address === 'string') {
            reject(new Error('Could not allocate a host port'));
          } else {
            resolve(address.port);
          }
        });
      });
    });
  }

  async #run(
    args: readonly string[],
    timeout = 30_000,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(this.#binary, [...args], {
        encoding: 'utf8',
        env,
        timeout,
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (error) {
      const detail = error as Error & { stderr?: string; stdout?: string };
      throw new Error(
        `sbx ${args[0]} failed: ${detail.stderr?.trim() || detail.stdout?.trim() || detail.message}`,
        { cause: error },
      );
    }
  }
}
