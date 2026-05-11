import { timingSafeEqual, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  deleteExpiredSessions,
  deleteSession,
  getOrCreateSession,
  sessionCount,
} from "./session.js";
import { currentCwdPin, pinCwd, unpinCwd } from "./context.js";
import { executeRun } from "./tools/run.js";
import { executeBash } from "./tools/bash.js";
import { executeRead } from "./tools/read.js";
import { executeWrite } from "./tools/write.js";
import { executeEdit } from "./tools/edit.js";
import {
  authorizationServerMetadata,
  handleOAuthAuthorize,
  handleOAuthJwks,
  handleOAuthRegistration,
  handleOAuthToken,
  handleOAuthUserinfo,
  isIssuedOAuthAccessToken,
  protectedResourceMetadata,
} from "./oauth.js";

const PORT = parseInt(process.env.AGENT_MCP_PORT ?? "3939", 10);
const AUTH_TOKEN = process.env.AGENT_MCP_TOKEN || "";
const TOOL_SESSION_KEY = process.env.AGENT_MCP_TOOL_SESSION_KEY || "default";
const SESSION_IDLE_TIMEOUT_MS = parseInt(
  process.env.AGENT_MCP_SESSION_IDLE_TIMEOUT_MS ?? String(6 * 60 * 60 * 1000),
  10,
);
const PROFILE = normalizeProfile(process.env.AGENT_MCP_PROFILE ?? "run-only");
const INITIAL_CWD = process.env.AGENT_MCP_CWD;
const LOG_DIR = resolve(homedir(), ".agent-mcp", "logs");
const TOOL_CALL_LOG = resolve(LOG_DIR, "tool-calls.jsonl");

type AgentMcpProfile = "run-only" | "full" | "readonly";

function normalizeProfile(raw: string): AgentMcpProfile {
  const value = raw.trim().toLowerCase();
  if (value === "full") return "full";
  if (value === "readonly" || value === "read-only" || value === "read")
    return "readonly";
  return "run-only";
}

function truncateForLog(value: unknown, max = 4000): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return value;
  return text.length > max
    ? `${text.slice(0, max)}...[truncated ${text.length - max} chars]`
    : value;
}

function logToolEvent(event: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(
      TOOL_CALL_LOG,
      `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`,
    );
  } catch {
    // Logging must never break MCP tool execution.
  }
}

function addNonEnumerableToolAliases(
  server: McpServer,
  canonicalName: string,
  aliases: string[],
): void {
  const registeredTools = (server as any)._registeredTools;
  const canonicalTool = registeredTools?.[canonicalName];
  if (!registeredTools || !canonicalTool) return;
  for (const alias of aliases) {
    if (alias === canonicalName || registeredTools[alias]) continue;
    Object.defineProperty(registeredTools, alias, {
      value: canonicalTool,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
}

function registerReadTool(server: McpServer): void {
  server.tool(
    "read",
    "Read a text file's contents. Prefer this over bash/cat/sed for file inspection. Use absolute paths for repo/project files outside the sandbox; relative paths resolve inside the session sandbox. Use offset and limit for large files instead of reading everything at once.",
    {
      path: z
        .string()
        .describe(
          "File path. Use an absolute path for repo/project files outside the sandbox; relative paths resolve inside the session sandbox.",
        ),
      offset: z
        .number()
        .optional()
        .describe(
          "0-based line number to start from; use with limit for large files",
        ),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of lines to return; use for large files"),
    },
    {
      title: "Read File",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (args) => {
      const session = getOrCreateSession(TOOL_SESSION_KEY);
      logToolEvent("tool_call_start", {
        tool: "read",
        session: session.id,
        cwd: session.cwd,
        args: truncateForLog(args),
      });
      try {
        const result = executeRead(session, args);
        logToolEvent("tool_call_end", {
          tool: "read",
          session: session.id,
          cwd: session.cwd,
          result: truncateForLog(result),
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        logToolEvent("tool_call_error", {
          tool: "read",
          session: session.id,
          cwd: session.cwd,
          error: err.message,
        });
        return {
          content: [{ type: "text", text: `[error: ${err.message}]` }],
          isError: true,
        };
      }
    },
  );
}

function registerLowLevelTools(server: McpServer): void {
  server.tool(
    "bash",
    "Execute a shell command. Commands run in the session sandbox by default. For repo/project work, start with `cd /absolute/repo && ...`; use absolute paths for files outside the sandbox. Prefer the read tool for file inspection; use bash for commands, search, tests, logs, and shell pipelines. Bash can be destructive; use it only when the user has authorized the action. Returns stdout, stderr, and exit code.",
    {
      command: z
        .string()
        .describe(
          "Shell command to execute. For repo/project commands, start with `cd /absolute/repo && ...` because the default cwd is the session sandbox.",
        ),
      timeout_seconds: z
        .number()
        .optional()
        .describe("Timeout in seconds (default: 120)"),
    },
    {
      title: "Execute Bash",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const session = getOrCreateSession(TOOL_SESSION_KEY);
      logToolEvent("tool_call_start", {
        tool: "bash",
        session: session.id,
        cwd: session.cwd,
        args: truncateForLog(args),
      });
      const result = await executeBash(session, args);
      logToolEvent("tool_call_end", {
        tool: "bash",
        session: session.id,
        cwd: session.cwd,
        result: truncateForLog(result),
      });
      return { content: [{ type: "text", text: result }] };
    },
  );

  registerReadTool(server);

  server.tool(
    "write",
    "Create or overwrite a file. Parent directories are created automatically. Use absolute paths for repo/project files outside the sandbox; relative paths resolve inside the session sandbox. This can overwrite data, so use it only when the user has authorized creating or replacing the file.",
    {
      path: z
        .string()
        .describe(
          "File path. Use an absolute path for repo/project files outside the sandbox; relative paths resolve inside the session sandbox.",
        ),
      content: z.string().describe("Complete file content to write"),
    },
    {
      title: "Write File",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    async (args) => {
      const session = getOrCreateSession(TOOL_SESSION_KEY);
      logToolEvent("tool_call_start", {
        tool: "write",
        session: session.id,
        cwd: session.cwd,
        args: truncateForLog(args),
      });
      try {
        const result = executeWrite(session, args);
        logToolEvent("tool_call_end", {
          tool: "write",
          session: session.id,
          cwd: session.cwd,
          result: truncateForLog(result),
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        logToolEvent("tool_call_error", {
          tool: "write",
          session: session.id,
          cwd: session.cwd,
          error: err.message,
        });
        return {
          content: [{ type: "text", text: `[error: ${err.message}]` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "edit",
    "Apply atomic exact string replacements to a file. Each edit's oldText must appear exactly once. Use absolute paths for repo/project files outside the sandbox; relative paths resolve inside the session sandbox. Prefer read first to inspect context before editing. Editing can be destructive, so use it only when the user has authorized changes.",
    {
      path: z
        .string()
        .describe(
          "File path. Use an absolute path for repo/project files outside the sandbox; relative paths resolve inside the session sandbox.",
        ),
      edits: z
        .array(
          z.object({
            oldText: z
              .string()
              .describe(
                "Exact text to find; include enough surrounding context so it matches exactly once",
              ),
            newText: z.string().describe("Replacement text"),
          }),
        )
        .describe("Array of {oldText, newText} replacements"),
    },
    {
      title: "Edit File",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    async (args) => {
      const session = getOrCreateSession(TOOL_SESSION_KEY);
      logToolEvent("tool_call_start", {
        tool: "edit",
        session: session.id,
        cwd: session.cwd,
        args: truncateForLog(args),
      });
      try {
        const result = executeEdit(session, args);
        logToolEvent("tool_call_end", {
          tool: "edit",
          session: session.id,
          cwd: session.cwd,
          result: truncateForLog(result),
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        logToolEvent("tool_call_error", {
          tool: "edit",
          session: session.id,
          cwd: session.cwd,
          error: err.message,
        });
        return {
          content: [{ type: "text", text: `[error: ${err.message}]` }],
          isError: true,
        };
      }
    },
  );
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "agent-mcp",
    version: "0.1.0",
  });

  server.tool(
    "run",
    "Run sandboxed JavaScript code with a small agent SDK for local repo/Mac work. This is the preferred tool for multi-step inspection: use repo.search(), repo.files(), repo.read(), repo.write(), repo.edit(), npm.scripts(), npm.findScripts(), shell.run(), and return JSON-serializable results. Code is an async JavaScript function body; do not include markdown fences. IMPORTANT: use an explicit return statement; a bare final expression returns null. Do not use Node globals such as require or direct fs imports; use the provided SDK globals.",
    {
      code: z
        .string()
        .describe(
          "Async JavaScript function body. Available globals: repo, npm, shell, ui. repo.files(pattern) returns string paths. repo.read() accepts a string path or an object with a path/absolutePath field. Use repo.write(path, content) and repo.edit(path, { oldText, newText }) for file changes. Use an explicit return statement; a bare final expression returns null. Example: const scripts = await npm.findScripts('mcp debug'); const matches = await repo.search('buildNativeMcpPrompt'); return { script: scripts[0]?.name, file: matches[0]?.path ?? null };",
        ),
      timeout_seconds: z
        .number()
        .optional()
        .describe("Execution timeout in seconds (default 30, max 120)"),
    },
    {
      title: "Run Agent SDK Code",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const session = getOrCreateSession(TOOL_SESSION_KEY);
      logToolEvent("tool_call_start", {
        tool: "run",
        session: session.id,
        cwd: currentCwdPin()?.cwd || session.cwd,
        pin: currentCwdPin(),
        args: truncateForLog(args),
      });
      try {
        const result = executeRun(session, args);
        logToolEvent("tool_call_end", {
          tool: "run",
          session: session.id,
          cwd: session.cwd,
          result: truncateForLog(result),
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        logToolEvent("tool_call_error", {
          tool: "run",
          session: session.id,
          cwd: session.cwd,
          error: err.message,
        });
        return {
          content: [{ type: "text", text: `[error: ${err.message}]` }],
          isError: true,
        };
      }
    },
  );

  addNonEnumerableToolAliases(server, "run", [
    "agent-mcp.run",
    "agent-mcp/run",
    "/agent-mcp/run",
  ]);

  if (PROFILE === "full") registerLowLevelTools(server);
  if (PROFILE === "readonly") registerReadTool(server);

  return server;
}

// Map of MCP session ID -> transport/server
const transports: Record<string, StreamableHTTPServerTransport> = {};
const mcpServers: Record<string, McpServer> = {};

function writeCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, X-Agent-MCP-Token, X-My-MCP-Token, X-PI-MCP-Token, Content-Type, MCP-Session-Id, mcp-session-id",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "MCP-Session-Id, mcp-session-id",
  );
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
}

function isLocalAdminRequest(req: IncomingMessage): boolean {
  const host = String(req.headers.host || "").toLowerCase();
  return (
    host.startsWith("127.0.0.1") ||
    host.startsWith("localhost") ||
    host.startsWith("[::1]")
  );
}

function tokenFromRequest(req: IncomingMessage, url = requestUrl(req)): string {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  for (const name of ["x-agent-mcp-token"]) {
    const header = req.headers[name];
    if (typeof header === "string") return header;
    if (Array.isArray(header) && header[0]) return header[0];
  }
  return url.searchParams.get("token") || "";
}

function isAuthorized(req: IncomingMessage, url = requestUrl(req)): boolean {
  const token = tokenFromRequest(req, url);
  if (token && isIssuedOAuthAccessToken(token)) return true;
  if (!AUTH_TOKEN) return true;
  return Boolean(token) && safeEqual(token, AUTH_TOKEN);
}

function rejectUnauthorized(res: ServerResponse): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="agent-mcp"');
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function getSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  return Array.isArray(header) ? header[0] : header;
}

function deleteTransport(sessionId: string): void {
  delete transports[sessionId];
  delete mcpServers[sessionId];
  deleteSession(sessionId);
}

async function closeTransport(sessionId: string): Promise<void> {
  const transport = transports[sessionId];
  if (!transport) return;
  await transport.close();
  deleteTransport(sessionId);
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  return JSON.parse(raw);
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleAdminPin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isLocalAdminRequest(req))
    return jsonResponse(res, 403, {
      ok: false,
      error: "admin endpoint is local-only",
    });
  let body: any;
  try {
    body = await parseJsonBody(req);
  } catch {
    return jsonResponse(res, 400, {
      ok: false,
      error: "request body must be JSON",
    });
  }
  try {
    const state = pinCwd({
      cwd: String(body.cwd || ""),
      epoch: Number(body.epoch),
      ttlMs: Number(body.ttlMs || 5 * 60_000),
    });
    logToolEvent("cwd_pin", {
      cwd: state.cwd,
      epoch: state.epoch,
      expiresAt: state.expiresAt,
    });
    return jsonResponse(res, 200, { ok: true, ...state });
  } catch (error: any) {
    return jsonResponse(res, 400, { ok: false, error: error.message });
  }
}

async function handleAdminUnpin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isLocalAdminRequest(req))
    return jsonResponse(res, 403, {
      ok: false,
      error: "admin endpoint is local-only",
    });
  let body: any;
  try {
    body = await parseJsonBody(req);
  } catch {
    return jsonResponse(res, 400, {
      ok: false,
      error: "request body must be JSON",
    });
  }
  const epoch = body.epoch === undefined ? undefined : Number(body.epoch);
  const result = unpinCwd(epoch);
  logToolEvent("cwd_unpin", { epoch, ...result });
  return jsonResponse(res, 200, { ok: true, ...result });
}

function toolNamesForDebug(): string[] {
  const server = createMcpServer();
  const registeredTools = (server as any)._registeredTools;
  return Object.keys(registeredTools || {}).sort();
}

async function handleAdminRefreshTools(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isLocalAdminRequest(req))
    return jsonResponse(res, 403, {
      ok: false,
      error: "admin endpoint is local-only",
    });
  const results = await Promise.allSettled(
    Object.values(mcpServers).map((server) => server.sendToolListChanged()),
  );
  const notified = results.filter(
    (result) => result.status === "fulfilled",
  ).length;
  const failed = results.length - notified;
  logToolEvent("tools_list_changed", { notified, failed });
  return jsonResponse(res, 200, {
    ok: true,
    notified,
    failed,
    activeServers: Object.keys(mcpServers).length,
    tools: toolNamesForDebug(),
  });
}

function handleAdminDebug(req: IncomingMessage, res: ServerResponse): void {
  if (!isLocalAdminRequest(req))
    return jsonResponse(res, 403, {
      ok: false,
      error: "admin endpoint is local-only",
    });
  return jsonResponse(res, 200, {
    ok: true,
    name: "agent-mcp",
    version: "0.1.0",
    profile: PROFILE,
    authRequired: Boolean(AUTH_TOKEN),
    oauthSupported: true,
    activeTransports: Object.keys(transports).length,
    activeServers: Object.keys(mcpServers).length,
    activeSessions: sessionCount(),
    transportSessionIds: Object.keys(transports).sort(),
    pinnedCwd: currentCwdPin()?.cwd || null,
    tools: toolNamesForDebug(),
    toolLogFile: TOOL_CALL_LOG,
  });
}

async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Parse error: request body must be valid JSON",
        },
        id: null,
      }),
    );
    return;
  }

  const sessionId = getSessionId(req);

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, body);
    return;
  }

  if (!sessionId && isInitializeRequest(body)) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        transports[sid] = transport;
        mcpServers[sid] = server;
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) deleteTransport(sid);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    }),
  );
}

async function handleMcpGet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = getSessionId(req);
  if (!sessionId || !transports[sessionId]) {
    res.writeHead(400);
    res.end("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

async function handleMcpDelete(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = getSessionId(req);
  if (!sessionId || !transports[sessionId]) {
    res.writeHead(400);
    res.end("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
  deleteTransport(sessionId);
}

const httpServer = createServer(async (req, res) => {
  writeCorsHeaders(res);
  const url = requestUrl(req);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        version: "0.1.0",
        profile: PROFILE,
        authRequired: Boolean(AUTH_TOKEN),
        oauthSupported: true,
        activeTransports: Object.keys(transports).length,
        activeSessions: sessionCount(),
        pinnedCwd: currentCwdPin()?.cwd || null,
      }),
    );
    return;
  }

  if (url.pathname === "/admin/pin" && req.method === "POST") {
    await handleAdminPin(req, res);
    return;
  }

  if (url.pathname === "/admin/unpin" && req.method === "POST") {
    await handleAdminUnpin(req, res);
    return;
  }

  if (url.pathname === "/admin/refresh-tools" && req.method === "POST") {
    await handleAdminRefreshTools(req, res);
    return;
  }

  if (
    (url.pathname === "/admin/debug" ||
      url.pathname === "/admin/sessions" ||
      url.pathname === "/admin/tools") &&
    req.method === "GET"
  ) {
    handleAdminDebug(req, res);
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration")
  ) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(authorizationServerMetadata(req)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/jwks") {
    handleOAuthJwks(req, res);
    return;
  }

  if (url.pathname === "/userinfo") {
    handleOAuthUserinfo(req, res);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/.well-known/oauth-protected-resource"
  ) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(protectedResourceMetadata(req)));
    return;
  }

  if (url.pathname === "/register") {
    await handleOAuthRegistration(req, res);
    return;
  }

  if (url.pathname === "/authorize") {
    handleOAuthAuthorize(req, res);
    return;
  }

  if (url.pathname === "/token") {
    await handleOAuthToken(req, res);
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (!isAuthorized(req, url)) {
    rejectUnauthorized(res);
    return;
  }

  try {
    if (req.method === "POST") {
      await handleMcpPost(req, res);
    } else if (req.method === "GET") {
      await handleMcpGet(req, res);
    } else if (req.method === "DELETE") {
      await handleMcpDelete(req, res);
    } else {
      res.writeHead(405);
      res.end("Method not allowed");
    }
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  }
});

const cleanupTimer = setInterval(
  () => {
    const expiredSessionIds = deleteExpiredSessions(SESSION_IDLE_TIMEOUT_MS);
    for (const sessionId of expiredSessionIds) {
      void closeTransport(sessionId).catch((error) => {
        console.error(
          `Failed to close expired MCP transport ${sessionId}:`,
          error,
        );
      });
    }
  },
  Math.min(SESSION_IDLE_TIMEOUT_MS, 10 * 60 * 1000),
);
cleanupTimer.unref();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`Received ${signal}; shutting down...`);
  clearInterval(cleanupTimer);
  await Promise.all(Object.keys(transports).map((sid) => closeTransport(sid)));
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

if (INITIAL_CWD) {
  try {
    pinCwd({ cwd: INITIAL_CWD, epoch: Date.now(), ttlMs: 30 * 60_000 });
  } catch (error) {
    console.error(`Failed to pin AGENT_MCP_CWD=${INITIAL_CWD}:`, error);
    process.exit(1);
  }
}

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`agent-mcp daemon listening on http://127.0.0.1:${PORT}/mcp`);
  console.log(`Profile: ${PROFILE}`);
  console.log(`Health check: http://127.0.0.1:${PORT}/health`);
});

process.on("SIGINT", (signal) => void shutdown(signal));
process.on("SIGTERM", (signal) => void shutdown(signal));
