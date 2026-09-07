import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { readSandboxInstructions } from '../../src/sandbox/instructions.js';

test('reads the exact global sandbox instructions when AGENTS.md exists', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2sbx-instructions-'));
  onTestFinished(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  const instructions = '# Sandbox instructions\n\n- Use Gitmoji.\n';
  fs.writeFileSync(path.join(dataRoot, 'AGENTS.md'), instructions);

  await expect(readSandboxInstructions(dataRoot)).resolves.toBe(instructions);
});

test('returns no instructions only when AGENTS.md does not exist', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2sbx-instructions-'));
  onTestFinished(() => fs.rmSync(dataRoot, { force: true, recursive: true }));

  await expect(readSandboxInstructions(dataRoot)).resolves.toBeUndefined();
});

test('rejects a symbolic link instead of reading outside the data root', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2sbx-instructions-'));
  onTestFinished(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  const outsideFile = path.join(os.tmpdir(), `chat2sbx-outside-${path.basename(dataRoot)}`);
  onTestFinished(() => fs.rmSync(outsideFile, { force: true }));
  fs.writeFileSync(outsideFile, 'outside contents');
  fs.symlinkSync(outsideFile, path.join(dataRoot, 'AGENTS.md'));

  await expect(readSandboxInstructions(dataRoot)).rejects.toMatchObject({ code: 'ELOOP' });
});

test('rejects non-regular AGENTS.md entries', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2sbx-instructions-'));
  onTestFinished(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  fs.mkdirSync(path.join(dataRoot, 'AGENTS.md'));

  await expect(readSandboxInstructions(dataRoot)).rejects.toThrow(
    'AGENTS.md must be a regular file',
  );
});
