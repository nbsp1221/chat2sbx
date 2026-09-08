import type http from 'node:http';
import { once } from 'node:events';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { expect, onTestFinished, test } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { SingleUserAuthProvider } from '../../src/auth/single-user-provider.js';
import { createGateway } from '../../src/mcp/gateway.js';

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address');
  }
  return address.port;
}

function config(): AppConfig {
  return {
    dataRoot: '/tmp/chat2sbx',
    databasePath: ':memory:',
    host: '127.0.0.1',
    idleTimeoutMs: 1_000,
    maxBodyBytes: 1024 * 1024,
    port: 0,
    reaperIntervalMs: 1_000,
    sandboxPort: 18_787,
    sandboxTemplate: 'test:latest',
    sbxBinary: 'sbx',
    stateDir: '/tmp/chat2sbx/state',
    workspaceRetentionMs: 10_000,
    workspaceRoot: '/tmp/chat2sbx/workspaces',
  };
}

const unusedBashSessions = {
  poll() {
    return Promise.reject(new Error('not used'));
  },
  start() {
    return Promise.reject(new Error('not used'));
  },
  stop() {
    return Promise.reject(new Error('not used'));
  },
};

async function rpc(
  url: string,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
    headers: {
      'accept': 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
  return JSON.parse(data ? data.slice(5).trim() : text) as Record<string, unknown>;
}

test('serves management tools itself instead of proxying to a host CodexPro', async () => {
  let listCalls = 0;
  let exposedHost: string | undefined;
  let exposedHostPort: number | undefined;
  let exposedSandboxPort: number | undefined;
  let requestedMemory: string | undefined;
  let sandboxInstructions: string | undefined = '# Global sandbox instructions\n';
  const gateway = createGateway(config(), {
    authProvider: new SingleUserAuthProvider(),
    controlServer: {
      codexPro: {
        call() {
          return Promise.reject(new Error('not used'));
        },
      },
      bashSessions: unusedBashSessions,
      codexProTools: [],
      readSandboxInstructions() {
        return Promise.resolve(sandboxInstructions);
      },
      sandboxes: {
        create(_ownerId, request) {
          requestedMemory = request.memory;
          return Promise.resolve({
            status: 'created' as const,
            sandbox: {
              createdAt: 1,
              expiresAt: 2,
              id: 'sbx_test',
              lastActivityAt: 1,
              memory: '4g',
              status: 'running' as const,
              workspace: {
                createdAt: 1,
                id: 'ws_test',
                ownerId: 'local-owner',
                root: '/tmp/chat2sbx/workspaces/ws_test',
                status: 'active' as const,
              },
            },
          });
        },
        destroy() {
          return Promise.reject(new Error('not used'));
        },
        expose(_ownerId, sandboxId, sandboxPort, host, hostPort) {
          exposedHost = host ?? '127.0.0.1';
          exposedHostPort = hostPort;
          exposedSandboxPort = sandboxPort;
          return Promise.resolve({
            host: exposedHost,
            hostPort: hostPort ?? 32_000,
            sandboxId,
            sandboxPort,
          });
        },
        get() {
          return {
            createdAt: 1,
            expiresAt: 2,
            id: 'sbx_test',
            lastActivityAt: 1,
            memory: '4g',
            status: 'running' as const,
            workspace: {
              createdAt: 1,
              id: 'ws_test',
              ownerId: 'local-owner',
              root: '/tmp/chat2sbx/workspaces/ws_test',
              status: 'active' as const,
            },
          };
        },
        list() {
          listCalls += 1;
          return [];
        },
      },
      workspaces: {
        list() {
          return [];
        },
      },
    },
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        gateway.close(() => resolve());
      }),
  );
  const port = await listen(gateway);
  const url = `http://127.0.0.1:${port}/mcp`;

  const discovery = await rpc(url, 0, 'server/discover');
  expect(discovery.error).toEqual({ code: -32601, message: 'Method not found' });

  await rpc(url, 1, 'initialize', {
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
    protocolVersion: '2025-06-18',
  });
  const listed = await rpc(url, 2, 'tools/list');
  const tools = (
    listed.result as {
      tools: Array<{ inputSchema: { properties?: Record<string, unknown> }; name: string }>;
    }
  ).tools;
  expect(tools.map((tool) => tool.name)).toEqual([
    'sandbox_create',
    'sandbox_list',
    'sandbox_get',
    'sandbox_expose',
    'sandbox_destroy',
    'workspace_list',
  ]);
  expect(
    Object.keys(tools.find((tool) => tool.name === 'sandbox_create')?.inputSchema.properties ?? {}),
  ).toEqual(['workspace_id', 'memory']);

  const called = await rpc(url, 3, 'tools/call', { arguments: {}, name: 'sandbox_list' });
  expect(
    (called.result as { structuredContent: { sandboxes: unknown[] } }).structuredContent.sandboxes,
  ).toHaveLength(0);
  expect(listCalls).toBe(1);

  const exposed = await rpc(url, 4, 'tools/call', {
    arguments: {
      host: '0.0.0.0',
      host_port: 8_080,
      sandbox_id: 'sbx_test',
      sandbox_port: 3_000,
    },
    name: 'sandbox_expose',
  });
  expect((exposed.result as { structuredContent: unknown }).structuredContent).toEqual({
    host: '0.0.0.0',
    hostPort: 8_080,
    sandboxId: 'sbx_test',
    sandboxPort: 3_000,
  });
  expect(exposedHost).toBe('0.0.0.0');
  expect(exposedHostPort).toBe(8_080);
  expect(exposedSandboxPort).toBe(3_000);

  const created = await rpc(url, 5, 'tools/call', {
    arguments: { memory: '4g' },
    name: 'sandbox_create',
  });
  expect((created.result as { isError?: boolean }).isError).not.toBe(true);
  expect(requestedMemory).toBe('4g');
  expect(
    (created.result as { structuredContent: { sandbox_instructions?: string } }).structuredContent
      .sandbox_instructions,
  ).toBe('# Global sandbox instructions\n');

  const opened = await rpc(url, 6, 'tools/call', {
    arguments: { sandbox_id: 'sbx_test' },
    name: 'sandbox_get',
  });
  expect(
    (opened.result as { structuredContent: { sandbox_instructions?: string } }).structuredContent
      .sandbox_instructions,
  ).toBe('# Global sandbox instructions\n');

  sandboxInstructions = '# Updated instructions\n';
  const reopened = await rpc(url, 7, 'tools/call', {
    arguments: { sandbox_id: 'sbx_test' },
    name: 'sandbox_get',
  });
  expect(
    (reopened.result as { structuredContent: { sandbox_instructions?: string } }).structuredContent
      .sandbox_instructions,
  ).toBe('# Updated instructions\n');

  sandboxInstructions = undefined;
  const openedWithoutInstructions = await rpc(url, 8, 'tools/call', {
    arguments: { sandbox_id: 'sbx_test' },
    name: 'sandbox_get',
  });
  expect(
    (openedWithoutInstructions.result as { structuredContent: Record<string, unknown> })
      .structuredContent,
  ).not.toHaveProperty('sandbox_instructions');
});

test('routes CodexPro tools by sandbox_id without forwarding routing fields', async () => {
  const calls: Array<{
    args: Record<string, unknown>;
    ownerId: string;
    sandboxId: string;
    toolName: string;
  }> = [];
  const readTool: Tool = {
    description: 'Read a file',
    inputSchema: {
      additionalProperties: false,
      properties: { path: { type: 'string' } },
      required: ['path'],
      type: 'object',
    },
    name: 'read',
  };
  const gateway = createGateway(config(), {
    authProvider: new SingleUserAuthProvider(),
    controlServer: {
      codexPro: {
        call(ownerId, sandboxId, toolName, args) {
          calls.push({ args, ownerId, sandboxId, toolName });
          return Promise.resolve({ content: [{ text: 'ok', type: 'text' }] });
        },
      },
      bashSessions: unusedBashSessions,
      codexProTools: [readTool],
      readSandboxInstructions() {
        return Promise.resolve(undefined);
      },
      sandboxes: {
        create() {
          return Promise.reject(new Error('not used'));
        },
        destroy() {
          return Promise.reject(new Error('not used'));
        },
        expose() {
          return Promise.reject(new Error('not used'));
        },
        get() {
          throw new Error('not used');
        },
        list() {
          return [];
        },
      },
      workspaces: {
        list() {
          return [];
        },
      },
    },
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        gateway.close(() => resolve());
      }),
  );
  const port = await listen(gateway);
  const url = `http://127.0.0.1:${port}/mcp`;

  await rpc(url, 1, 'initialize', {
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
    protocolVersion: '2025-06-18',
  });

  const called = await rpc(url, 2, 'tools/call', {
    arguments: { path: 'README.md', sandbox_id: 'sbx_test' },
    name: 'read',
  });
  expect((called.result as { isError?: boolean }).isError).not.toBe(true);
  expect(calls).toEqual([
    {
      args: { path: 'README.md' },
      ownerId: 'local-owner',
      sandboxId: 'sbx_test',
      toolName: 'read',
    },
  ]);

  const rejected = await rpc(url, 3, 'tools/call', {
    arguments: { path: 'README.md', sandbox_id: 'sbx_test', workspace_id: 'ws_internal' },
    name: 'read',
  });
  const rejectedResult = rejected.result as {
    content: Array<{ text?: string; type: string }>;
    isError?: boolean;
  };
  expect(rejectedResult.isError).toBe(true);
  expect(rejectedResult.content[0]?.text).toMatch(/workspace_id is internal/);
  expect(calls).toHaveLength(1);
});
