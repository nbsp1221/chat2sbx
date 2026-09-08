import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { BashSessionService } from '../codexpro/bash-sessions.js';
import type { CodexProClientPool } from '../codexpro/client-pool.js';
import type { SandboxService } from '../sandbox/service.js';
import type { WorkspaceService } from '../workspaces/service.js';
import { version } from '../version.js';

const sandboxCreateTool: Tool = {
  name: 'sandbox_create',
  title: 'Create or Reuse Sandbox',
  description:
    'Create an isolated Docker Sandbox with a new managed workspace, or reuse the active sandbox for an existing managed workspace. A created or reused sandbox includes the current global sandbox instructions when AGENTS.md exists in the chat2sbx data directory.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: {
        type: 'string',
        description: 'Existing managed workspace id. Omit to create a new managed workspace.',
      },
      memory: {
        type: 'string',
        pattern: '^[1-9][0-9]*(m|g)$',
        description:
          'Optional sandbox memory limit in binary megabytes or gigabytes, such as 512m or 4g. Omit it to use the Docker Sandbox default.',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  },
};

const sandboxListTool: Tool = {
  name: 'sandbox_list',
  title: 'List Sandboxes',
  description:
    'List all non-destroyed sandboxes owned by the current chat2sbx principal, including creating, running, destroying, and failed records. Running IDs can be reused from other conversations; failed sandboxes must be destroyed.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const sandboxGetTool: Tool = {
  name: 'sandbox_get',
  title: 'Get Sandbox',
  description:
    'Get the current state, workspace, expiration times, and current global sandbox instructions for one sandbox.',
  inputSchema: {
    type: 'object',
    properties: { sandbox_id: { type: 'string' } },
    required: ['sandbox_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const sandboxDestroyTool: Tool = {
  name: 'sandbox_destroy',
  title: 'Destroy Sandbox',
  description:
    'Permanently remove one sandbox microVM. Its managed workspace files are retained for 30 days.',
  inputSchema: {
    type: 'object',
    properties: { sandbox_id: { type: 'string' } },
    required: ['sandbox_id'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
};

const sandboxExposeTool: Tool = {
  name: 'sandbox_expose',
  title: 'Expose Sandbox Port',
  description:
    'Publish one TCP/IPv4 port mapping from a running sandbox. sandbox_port is the port inside the sandbox. host is the host IPv4 bind address and defaults to 127.0.0.1. host_port is the host-side port and is allocated automatically when omitted. The service inside the sandbox must listen on 0.0.0.0. The mapping has no separate authentication or expiration and disappears with the sandbox. Traffic through it does not renew sandbox activity.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox_id: { type: 'string' },
      sandbox_port: {
        type: 'integer',
        minimum: 1,
        maximum: 65_535,
        description: 'TCP port inside the sandbox.',
      },
      host: {
        type: 'string',
        default: '127.0.0.1',
        description: 'Host IPv4 bind address. Use 0.0.0.0 to listen on every host IPv4 interface.',
      },
      host_port: {
        type: 'integer',
        minimum: 1,
        maximum: 65_535,
        description:
          'Optional host-side TCP port. Omit to allocate an available port automatically.',
      },
    },
    required: ['sandbox_id', 'sandbox_port'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
};

const workspaceListTool: Tool = {
  name: 'workspace_list',
  title: 'List Workspaces',
  description:
    'List all known managed workspaces for the current principal, including active, retained, and trashed records.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const managementTools = [
  sandboxCreateTool,
  sandboxListTool,
  sandboxGetTool,
  sandboxExposeTool,
  sandboxDestroyTool,
  workspaceListTool,
] as const;

function objectArgs(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object');
  }
  return value as Record<string, unknown>;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number') {
    throw new Error(`${name} must be a number`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number') {
    throw new Error(`${name} must be a number`);
  }
  return value;
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function withSandboxInstructions<T extends object>(
  value: T,
  instructions: string | undefined,
): T & { sandbox_instructions?: string } {
  return instructions === undefined ? value : { ...value, sandbox_instructions: instructions };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export interface ControlServerDependencies {
  readonly principalId: string;
  readonly sandboxes: Pick<SandboxService, 'create' | 'list' | 'get' | 'expose' | 'destroy'>;
  readonly workspaces: Pick<WorkspaceService, 'list'>;
  readonly codexPro: Pick<CodexProClientPool, 'call'>;
  readonly bashSessions: Pick<BashSessionService, 'start' | 'poll' | 'stop'>;
  readonly codexProTools: readonly Tool[];
  readonly readSandboxInstructions: () => Promise<string | undefined>;
}

export function createControlServer(dependencies: ControlServerDependencies): Server {
  const server = new Server(
    { name: 'chat2sbx', version },
    {
      capabilities: { tools: {} },
      instructions:
        'Create or select an isolated sandbox first. Call sandbox_get before working in an existing sandbox so its current state and global sandbox instructions are loaded. Every sandbox tool requires an explicit sandbox_id. Bash is unrestricted inside the sandbox but never has host shell or host Docker access. Poll a Bash session with bash_poll while status=running or has_more_output=true, or terminate it with bash_stop.',
    },
  );
  const codexTools = dependencies.codexProTools;
  const codexToolNames = new Set(codexTools.map((tool) => tool.name));

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: [...managementTools, ...codexTools] }),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = objectArgs(request.params.arguments);
      switch (request.params.name) {
        case 'sandbox_create': {
          const instructions = await dependencies.readSandboxInstructions();
          const result = await dependencies.sandboxes.create(dependencies.principalId, {
            workspaceId: optionalString(args, 'workspace_id'),
            memory: optionalString(args, 'memory'),
          });
          return jsonResult(withSandboxInstructions(result, instructions));
        }
        case 'sandbox_list':
          return jsonResult({ sandboxes: dependencies.sandboxes.list(dependencies.principalId) });
        case 'sandbox_get': {
          const sandbox = dependencies.sandboxes.get(
            dependencies.principalId,
            optionalString(args, 'sandbox_id') ?? '',
          );
          return jsonResult(
            withSandboxInstructions(sandbox, await dependencies.readSandboxInstructions()),
          );
        }
        case 'sandbox_expose':
          return jsonResult(
            await dependencies.sandboxes.expose(
              dependencies.principalId,
              optionalString(args, 'sandbox_id') ?? '',
              requiredNumber(args, 'sandbox_port'),
              optionalString(args, 'host'),
              optionalNumber(args, 'host_port'),
            ),
          );
        case 'sandbox_destroy':
          return jsonResult(
            await dependencies.sandboxes.destroy(
              dependencies.principalId,
              optionalString(args, 'sandbox_id') ?? '',
            ),
          );
        case 'workspace_list':
          return jsonResult({ workspaces: dependencies.workspaces.list(dependencies.principalId) });
        case 'bash': {
          const sandboxId = optionalString(args, 'sandbox_id');
          if (!sandboxId) {
            throw new Error('sandbox_id is required');
          }
          return dependencies.bashSessions.start(dependencies.principalId, sandboxId, {
            command: optionalString(args, 'command') ?? '',
            cwd: optionalString(args, 'cwd'),
            yieldTimeMs: args.yield_time_ms as number | undefined,
            timeoutMs: args.timeout_ms as number | undefined,
          });
        }
        case 'bash_poll':
          return dependencies.bashSessions.poll(
            dependencies.principalId,
            optionalString(args, 'sandbox_id') ?? '',
            optionalString(args, 'session_id') ?? '',
            { yieldTimeMs: args.yield_time_ms as number | undefined },
          );
        case 'bash_stop':
          return dependencies.bashSessions.stop(
            dependencies.principalId,
            optionalString(args, 'sandbox_id') ?? '',
            optionalString(args, 'session_id') ?? '',
          );
        default: {
          if (!codexToolNames.has(request.params.name)) {
            throw new Error(`Unknown tool: ${request.params.name}`);
          }
          const sandboxId = optionalString(args, 'sandbox_id');
          if (!sandboxId) {
            throw new Error('sandbox_id is required');
          }
          if ('workspace_id' in args) {
            throw new Error('CodexPro workspace_id is internal; select the target with sandbox_id');
          }
          const { sandbox_id: _sandboxId, ...upstreamArgs } = args;
          return await dependencies.codexPro.call(
            dependencies.principalId,
            sandboxId,
            request.params.name,
            upstreamArgs,
          );
        }
      }
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}
