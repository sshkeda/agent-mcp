# agent-mcp

Production local MCP server for agent-grade computer and repo access.

`agent-mcp` supersedes the earlier `my-mcp` and `pi-mcp` experiments by combining:

- the clean run-only `my-mcp` surface (`run` with a small agent SDK)
- the optional low-level `pi-mcp` tool surface (`bash`, `read`, `write`, `edit`)
- one daemon, one auth/logging/session implementation, and profile-based tool exposure

> Note: concrete ChatGPT Pro-family models currently do not reliably receive ChatGPT Apps/MCP tools in Stephen's account. Use `agent-mcp` with MCP clients that do support tools, or with ChatGPT model families/modes that demonstrably call MCP tools.

## Profiles

### `run-only` (default)

Exposes one high-level tool:

- `run` — execute sandboxed JavaScript with agent SDK globals: `repo`, `npm`, `shell`, and `ui`.

`run` uses a server-pinned cwd. Pin with the local admin endpoint or start with `--cwd` / `AGENT_MCP_CWD`.

### `full`

Exposes the run tool plus lower-level computer-control tools:

- `run`
- `bash`
- `read`
- `write`
- `edit`

### `readonly`

Exposes:

- `run`
- `read`

This is intended for metadata/client testing; `run` can still call `shell.run`, so do not treat it as a strict security sandbox.

## Run tool

```ts
run({ code, timeout_seconds? })
```

`code` is an async JavaScript function body. Do not include markdown fences. Use an explicit `return` statement unless you pass an async function expression.

Available globals:

```ts
declare const repo: {
  cwd(): string;
  read(path: string | { path?: string; absolutePath?: string }, options?: { offset?: number; limit?: number }): Promise<{ path: string; absolutePath: string; content: string; offset?: number; limit?: number }>;
  write(path: string, content: string, options?: { append?: boolean; createDirs?: boolean }): Promise<{ path: string; absolutePath: string; bytes: number; appended: boolean }>;
  edit(path: string, edit: { oldText: string; newText: string; replaceAll?: boolean }): Promise<{ path: string; absolutePath: string; replacements: number }>;
  files(pattern?: string): Promise<string[]>;
  search(query: string, options?: { filePattern?: string; maxResults?: number; timeoutSeconds?: number }): Promise<Array<{ path: string; filePath: string; absolutePath: string; line: number | null; snippet: string; text: string; lines: string[] }>>;
};

declare const npm: {
  scripts(path?: string): Promise<Record<string, string>>;
  findScripts(query: string, path?: string): Promise<Array<{ name: string; command: string }>>;
};

declare const shell: {
  run(command: string, options?: { cwd?: string; timeoutSeconds?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
};

declare const ui: {
  status(message: string): void;
};
```

Example:

```js
const scripts = await npm.findScripts("test");
const matches = await repo.search("createMcpServer", { filePattern: "src/**/*.ts" });
return { scripts, firstMatch: matches[0]?.path ?? null };
```

## Development

```bash
npm install
npm run build
npm run smoke
```

## Run the daemon

```bash
npm run build
node dist/src/cli.js start
node dist/src/cli.js status
node dist/src/cli.js token
node dist/src/cli.js url
node dist/src/cli.js stop
```

Or with profiles:

```bash
agent-mcp start --profile run-only --cwd /absolute/repo
agent-mcp start --profile full
agent-mcp start --profile readonly --port 3940
```

Environment variables:

```text
AGENT_MCP_PORT=3939
AGENT_MCP_TOKEN=<bearer-token>
AGENT_MCP_PROFILE=run-only|full|readonly
AGENT_MCP_CWD=/absolute/repo
```

Default local endpoint:

```text
http://127.0.0.1:3939/mcp
```

Daemon metadata and logs live in:

```text
~/.agent-mcp/
```

Tool calls are appended to:

```text
~/.agent-mcp/logs/tool-calls.jsonl
```

## Local admin endpoints

Admin endpoints are local-only:

```bash
curl http://127.0.0.1:3939/admin/debug
curl http://127.0.0.1:3939/admin/tools
curl -X POST http://127.0.0.1:3939/admin/refresh-tools
curl -X POST http://127.0.0.1:3939/admin/pin \
  -H 'content-type: application/json' \
  -d '{"cwd":"/absolute/repo","epoch":1}'
curl -X POST http://127.0.0.1:3939/admin/unpin -H 'content-type: application/json' -d '{}'
```

## Auth

`agent-mcp start` creates a bearer token at `~/.agent-mcp/token`. MCP requests may include one of:

```text
Authorization: Bearer <token>
X-Agent-MCP-Token: <token>
https://127.0.0.1:3939/mcp?token=<token>
```

Compatibility headers are also accepted while migrating older clients:

```text
X-My-MCP-Token
X-PI-MCP-Token
```

OAuth endpoints are exposed for MCP clients that support OAuth:

- `/.well-known/oauth-authorization-server`
- `/.well-known/openid-configuration`
- `/.well-known/oauth-protected-resource`
- `/register`
- `/authorize`
- `/token`
- `/userinfo`
- `/jwks`

OAuth clients/tokens are cached in `~/.agent-mcp/oauth.json` with mode `0600`.
