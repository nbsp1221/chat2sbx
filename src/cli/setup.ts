import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeConfig } from '../config.js';

const execFileAsync = promisify(execFile);

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
  );
}

interface TemplateImage {
  readonly repository: string;
  readonly tag: string;
}

function normalizedImage(value: string): string {
  return value.replace(/^docker\.io\/library\//, '');
}

async function templateExists(config: RuntimeConfig): Promise<boolean> {
  const { stdout } = await execFileAsync(config.sbxBinary, ['template', 'ls', '--json']);
  const parsed = JSON.parse(stdout) as { images: TemplateImage[] };
  return parsed.images.some(
    (image) => normalizedImage(`${image.repository}:${image.tag}`) === config.sandboxTemplate,
  );
}

async function assertSbxAvailable(config: RuntimeConfig): Promise<void> {
  try {
    await execFileAsync(config.sbxBinary, ['version']);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new Error(
        'Docker Sandboxes (sbx) was not found. Install Docker Sandboxes and ensure `sbx` is available on PATH.',
        { cause: error },
      );
    }
    throw error;
  }
}

export async function setup(config: RuntimeConfig): Promise<void> {
  await assertSbxAvailable(config);
  if (await templateExists(config)) {
    console.log(`Sandbox template ready: ${config.sandboxTemplate}`);
    console.log('chat2sbx setup complete');
    return;
  }

  const bootstrapDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat2sbx-template-'));
  const bootstrapName = `c2sbx-template-${Date.now()}`;
  const codexProVersion = config.sandboxTemplate.split(':').at(-1);
  if (!codexProVersion) {
    throw new Error(`Sandbox template has no CodexPro version: ${config.sandboxTemplate}`);
  }
  try {
    console.log(`Creating sandbox template: ${config.sandboxTemplate}`);
    await execFileAsync(config.sbxBinary, [
      'create',
      '--quiet',
      '--name',
      bootstrapName,
      'shell',
      bootstrapDirectory,
    ]);
    await execFileAsync(config.sbxBinary, [
      'exec',
      '-u',
      'root',
      bootstrapName,
      'npm',
      'install',
      '--global',
      '--omit=dev',
      `codexpro@${codexProVersion}`,
    ]);
    await execFileAsync(config.sbxBinary, ['stop', bootstrapName]);
    await execFileAsync(config.sbxBinary, [
      'template',
      'save',
      bootstrapName,
      config.sandboxTemplate,
    ]);
  } finally {
    await execFileAsync(config.sbxBinary, ['rm', '--force', bootstrapName]).catch(() => undefined);
    await rm(bootstrapDirectory, { force: true, recursive: true });
  }
  console.log(`Sandbox template ready: ${config.sandboxTemplate}`);
  console.log('chat2sbx setup complete');
}
