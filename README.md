# agent-mcp

**agent-mcp** is a production-minded local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for AI agents that need safe, inspectable access to a developer machine or codebase.

It gives MCP clients one high-level `run` tool by default, plus optional low-level computer-control tools when you explicitly opt in.

`agent-mcp` supersedes the earlier `my-mcp` and `pi-mcp` experiments:

- `my-mcp` → `agent-mcp --profile run-only`
- `pi-mcp` → `agent-mcp --profile full`

## Why agent-mcp?

Most local MCP servers expose a pile of low-level tools. `agent-mcp` defaults to one agent-grade primitive:

- `run` executes JavaScript with a small SDK: `repo`, `npm`, `shell`, and `ui`
- cwd can be pinned server-side, so clients do not smuggle working directories into tool args
- every tool call is logged as JSONL for debugging and auditability
- bearer-token auth and OAuth endpoints are built in
- profiles let you choose the exact tool surface exposed to a client

Useful search terms: **local MCP server**, **Model Context Protocol server**, **MCP computer control**, **AI agent repo access**, **Claude Desktop MCP**, **Cursor MCP**, **ChatGPT MCP tools**.

## Install

From source today:

```bash
git clone https://github.com/sshkeda/agent-mcp
cd agent-mcp
npm install
npm run check
```

After building, run the CLI directly:

```bash
npm run build
node dist/src/cli.js start --profile run-only --cwd /absolute/repo
node dist/src/cli.js url
```

When published to npm, the intended usage is:

```bash
npx agent-mcp start --profile run-only --cwd /absolute/repo
```

## Quick start

Start the default run-only server pinned to a repo:

```bash
agent-mcp start --profile run-only --cwd /absolute/repo
agent-mcp url
```

Configure your MCP client with the printed URL or with:

```text
http://127.0.0.1:3939/mcp
```

and send the bearer token from:

```bash
agent-mcp token
```

Health check:

```bash
curl http://127.0.0.1:3939/health
```

Stop the daemon:

```bash
agent-mcp stop
```

## Profiles

### `run-only` (default)

The recommended production default. Exposes only:

- `run` — execute sandboxed JavaScript with agent SDK globals: `repo`, `npm`, `shell`, and `ui`

`run` uses a server-pinned cwd. Pin with `--cwd`, `AGENT_MCP_CWD`, or the local `/admin/pin` endpoint.

### `full`

Compatibility/profile for `pi-mcp`-style clients. Exposes:

- `run`
- `bash`
- `read`
- `write`
- `edit`

Use this only for clients you trust with direct computer-control tools.

### `readonly`

Exposes:

- `run`
- `read`

This is useful for metadata/client testing. It is **not** a strict read-only security sandbox because `run` can still call `shell.run`.

## Tool: `run`

```ts
run({ code, timeout_seconds? })
```

`code` is an async JavaScript function body. Do not include markdown fences. Use an explicit `return` statement unless you pass an async function expression.

Example:

```js
const scripts = await npm.findScripts("test");
const matches = await repo.search("createMcpServer", { filePattern: "src/**/*.ts" });
return { scripts, firstMatch: matches[0]?.path ?? null };
```

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

## CLI

```bash
agent-mcp start [--profile run-only|full|readonly] [--port 3939] [--cwd /absolute/repo]
agent-mcp stop
agent-mcp restart
agent-mcp status
agent-mcp token
agent-mcp url
```

Compatibility binaries are also exposed by the package:

- `my-mcp` defaults to `run-only`
- `pi-mcp` defaults to `full`

All binaries run the same `agent-mcp` daemon implementation.

## Environment variables

```text
AGENT_MCP_PORT=3939
AGENT_MCP_TOKEN=<bearer-token>
AGENT_MCP_PROFILE=run-only|full|readonly
AGENT_MCP_CWD=/absolute/repo
AGENT_MCP_TOOL_SESSION_KEY=default
AGENT_MCP_SESSION_IDLE_TIMEOUT_MS=21600000
```

## Auth

`agent-mcp start` creates a bearer token at:

```text
~/.agent-mcp/token
```

MCP requests may include one of:

```text
Authorization: Bearer <token>
X-Agent-MCP-Token: <token>
http://127.0.0.1:3939/mcp?token=<token>
```

Prefer headers when the MCP client supports them. The query-token form is a compatibility fallback.

Compatibility headers are accepted while migrating older clients:

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

## Logs and state

Daemon metadata and logs live in:

```text
~/.agent-mcp/
```

Tool calls are appended to:

```text
~/.agent-mcp/logs/tool-calls.jsonl
```

Each daemon logical tool session gets a scratch directory under:

```text
~/Documents/agent-mcp/YYYY-MM-DD/session-...
```

## Local admin endpoints

Admin endpoints are local-only (`127.0.0.1`, `localhost`, or `[::1]`):

```bash
curl http://127.0.0.1:3939/admin/debug
curl http://127.0.0.1:3939/admin/tools
curl http://127.0.0.1:3939/admin/sessions
curl -X POST http://127.0.0.1:3939/admin/refresh-tools
curl -X POST http://127.0.0.1:3939/admin/pin \
  -H 'content-type: application/json' \
  -d '{"cwd":"/absolute/repo","epoch":1}'
curl -X POST http://127.0.0.1:3939/admin/unpin \
  -H 'content-type: application/json' \
  -d '{}'
```

## ChatGPT Pro note

Concrete ChatGPT Pro-family models currently do **not** reliably receive ChatGPT Apps/MCP tools in Stephen's account. `agent-mcp` is for MCP clients and model modes that demonstrably call MCP tools. For reliable GPT Pro review, gather evidence outside Pro and pass it in as prompt context.

## Security model

`agent-mcp` is local-first and binds to `127.0.0.1` by default. It is intended for trusted local MCP clients.

Important limits:

- This is not a hardened OS sandbox.
- `run` can execute shell commands through `shell.run`.
- `full` exposes direct write/edit/bash tools.
- Only expose it to clients you trust with local machine access.
- Keep bearer tokens private.

## Development

```bash
npm install
npm run build
npm run smoke
npm run check
npm audit --omit=dev
```

CI runs:

- `npm ci`
- `npm audit --omit=dev`
- `npm run check`

## Roadmap

- npm publish
- generated MCP descriptors from an `agent-affordances` catalog
- semantic parity snapshots against the old `my-mcp` and `pi-mcp` tool descriptors
- stricter profile-level policy controls
- optional signed releases

## License

MIT
