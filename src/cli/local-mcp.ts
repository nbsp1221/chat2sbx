import type { AppConfig } from '../config.js';
import { gatewayUrl } from '../runtime/gateway-url.js';

interface RpcError {
  readonly message?: string;
}

interface ToolCallResult {
  readonly content?: ReadonlyArray<{ readonly text?: string; readonly type?: string }>;
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

interface RpcResponse {
  readonly error?: RpcError;
  readonly result?: ToolCallResult;
}

function responseData(text: string): RpcResponse {
  const data = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
  return JSON.parse(data ? data.slice(5).trim() : text) as RpcResponse;
}

function toolError(result: ToolCallResult): string {
  return (
    result.content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text ??
    'Local MCP tool call failed'
  );
}

export async function callLocalTool(
  config: AppConfig,
  name: 'sandbox_destroy' | 'sandbox_list',
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const url = gatewayUrl(config, '/mcp');
  let response: Response;
  try {
    response = await fetch(url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: args, name },
      }),
      headers: {
        'accept': 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      method: 'POST',
    });
  } catch {
    throw new Error(`Local chat2sbx MCP is unavailable at ${url}; start chat2sbx serve first`);
  }

  if (!response.ok) {
    throw new Error(`Local chat2sbx MCP returned HTTP ${String(response.status)}`);
  }

  const payload = responseData(await response.text());
  if (payload.error) {
    throw new Error(payload.error.message ?? 'Local MCP request failed');
  }
  if (!payload.result) {
    throw new Error('Local MCP response did not include a tool result');
  }
  if (payload.result.isError) {
    throw new Error(toolError(payload.result));
  }
  return payload.result.structuredContent;
}
