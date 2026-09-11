import { expect, test, vi } from 'vitest';
import { SbxDriver } from '../../src/sandbox/sbx-driver.js';

test('reports an attached exec that exits before CodexPro is ready', async () => {
  const driver = new SbxDriver({
    binary: process.execPath,
    template: 'unused',
    sandboxPort: 18_787,
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  try {
    await expect(
      driver.startCodexPro('launch-failure', '/workspace', 'http://127.0.0.1:1/mcp', 'token'),
    ).rejects.toThrow(/sbx exec.*exited with code 1.*cannot find module/is);
  } finally {
    await driver.close();
    stderr.mockRestore();
  }
});
