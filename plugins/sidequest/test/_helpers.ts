import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

type UnknownRecord = Record<string, unknown>;

interface CliRunnerOptions {
  cwd?: string;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface McpContent {
  text?: string;
}

interface McpToolResult {
  isError?: boolean;
  content?: McpContent[];
}

interface McpResponse {
  result?: McpToolResult;
}

interface McpModule {
  handleRequest(request: UnknownRecord): unknown;
}

export function makeCliRunner(bin: string, envOverrides?: NodeJS.ProcessEnv, options?: CliRunnerOptions) {
  function runCli(args: string[]): CliResult {
    const env = Object.assign({}, process.env, envOverrides || {});
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      env,
      cwd: options?.cwd || process.cwd(),
    });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  function cliJson<T>(args: string[]): T {
    const result = runCli(args);
    assert.strictEqual(result.status, 0, `expected success: ${args.join(' ')}\n${result.stderr}${result.stdout}`);
    return JSON.parse(result.stdout) as T;
  }

  return { runCli, cliJson };
}

export function makeMcpCaller(mcp: McpModule) {
  let id = 0;

  function callToolRaw(name: string, args?: UnknownRecord): McpToolResult | undefined {
    const response = mcp.handleRequest({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name, arguments: args || {} },
    }) as McpResponse | null;
    return response?.result;
  }

  function callTool<T>(name: string, args?: UnknownRecord): T {
    const result = callToolRaw(name, args);
    assert.ok(result, `tool ${name} returned a result`);
    assert.ok(!result.isError, `tool ${name} errored: ${result.content?.[0]?.text}`);
    return JSON.parse(result.content?.[0]?.text || '') as T;
  }

  return { callTool, callToolRaw };
}
