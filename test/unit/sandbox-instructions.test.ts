import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { readSandboxInstructions } from '../../src/sandbox/instructions.js';

test('reads the exact global sandbox instructions when AGENTS.md exists', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-instructions-'));
  onTestFinished(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  const instructions = '# Sandbox instructions\n\n- Use Gitmoji.\n';
  fs.writeFileSync(path.join(dataRoot, 'AGENTS.md'), instructions);

  await expect(readSandboxInstructions(dataRoot)).resolves.toBe(instructions);
});

test('returns no instructions only when AGENTS.md does not exist', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-instructions-'));
  onTestFinished(() => fs.rmSync(dataRoot, { force: true, recursive: true }));

  await expect(readSandboxInstructions(dataRoot)).resolves.toBeUndefined();
});

test('does not hide AGENTS.md read failures', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-instructions-'));
  onTestFinished(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  fs.mkdirSync(path.join(dataRoot, 'AGENTS.md'));

  await expect(readSandboxInstructions(dataRoot)).rejects.toMatchObject({ code: 'EISDIR' });
});
