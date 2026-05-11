import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function waitForHealth(port, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy. Output:\n${output()}`);
}

async function startServer(profile) {
  const port = 41000 + Math.floor(Math.random() * 1000);
  const token = `smoke-token-${profile}`;
  const scratchHome = mkdtempSync(
    join(tmpdir(), `agent-mcp-${profile}-smoke-`),
  );
  const server = spawn(process.execPath, ["dist/src/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      AGENT_MCP_PORT: String(port),
      AGENT_MCP_TOKEN: token,
      AGENT_MCP_PROFILE: profile,
      HOME: scratchHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  await waitForHealth(port, () => output);

  async function stop() {
    server.kill("SIGTERM");
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    rmSync(scratchHome, { recursive: true, force: true });
  }

  return { port, token, scratchHome, stop };
}

async function connect(port, token, name) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp?token=${token}`),
  );
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function pin(port, cwd, epoch) {
  const res = await fetch(`http://127.0.0.1:${port}/admin/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, epoch, ttlMs: 60_000 }),
  });
  if (!res.ok) throw new Error(`pin failed: ${res.status} ${await res.text()}`);
}

async function smokeRunOnly() {
  const server = await startServer("run-only");
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      body: "{}",
    });
    if (unauthorized.status !== 401)
      throw new Error(
        `expected unauthorized MCP request to return 401, got ${unauthorized.status}`,
      );

    const client = await connect(
      server.port,
      server.token,
      "agent-mcp-run-only-smoke",
    );
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(["run"]))
      throw new Error(`unexpected run-only tools: ${names.join(",")}`);
    const runTool = tools.tools.find((tool) => tool.name === "run");
    if (runTool?.annotations?.readOnlyHint !== false)
      throw new Error("expected run to have readOnlyHint: false");
    if (runTool.inputSchema.properties.cwd)
      throw new Error("run schema must not expose cwd");

    let result = await client.callTool({
      name: "run",
      arguments: { code: "return {shouldNotRun: true};" },
    });
    if (
      !result.isError &&
      !result.content[0].text.includes("native_mcp_unbound")
    )
      throw new Error(
        `expected unbound run to fail: ${result.content[0].text}`,
      );

    await pin(server.port, new URL("..", import.meta.url).pathname, 1);
    result = await client.callTool({
      name: "run",
      arguments: {
        code: "const scripts = await npm.scripts(); const matches = await repo.search('agent-mcp'); return { hasBuild: Boolean(scripts.build), matchCount: matches.length, cwd: repo.cwd() };",
      },
    });
    if (!result.content[0].text.includes('"hasBuild": true'))
      throw new Error(result.content[0].text);

    result = await client.callTool({
      name: "run",
      arguments: {
        code: "async () => { const out = await shell.run('printf wrapped'); return out.stdout; }",
      },
    });
    if (!result.content[0].text.includes('"result": "wrapped"'))
      throw new Error(result.content[0].text);

    const runScratchFile = join(server.scratchHome, "tmp-smoke.txt");
    result = await client.callTool({
      name: "run",
      arguments: {
        code: `const filePath = ${JSON.stringify(runScratchFile)}; await repo.write(filePath, 'alpha beta'); const edit = await repo.edit(filePath, { oldText: 'beta', newText: 'gamma' }); const file = await repo.read(filePath); return { edit, content: file.content, stringLike: file.includes('alpha') && file.match(/gamma/)[0] };`,
      },
    });
    if (!result.content[0].text.includes('"content": "alpha gamma"'))
      throw new Error(result.content[0].text);
    if (!result.content[0].text.includes('"stringLike": "gamma"'))
      throw new Error(result.content[0].text);

    await client.close();
  } finally {
    await server.stop();
  }
}

async function smokeFull() {
  const server = await startServer("full");
  try {
    const client = await connect(
      server.port,
      server.token,
      "agent-mcp-full-smoke",
    );
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    const expected = ["bash", "edit", "read", "run", "write"];
    if (JSON.stringify(names) !== JSON.stringify(expected))
      throw new Error(`unexpected full tools: ${names.join(",")}`);

    for (const tool of tools.tools) {
      if (tool.name === "read") {
        if (tool.annotations?.readOnlyHint !== true)
          throw new Error("expected read to have readOnlyHint: true");
      } else if (["bash", "write", "edit", "run"].includes(tool.name)) {
        if (tool.annotations?.readOnlyHint !== false)
          throw new Error(`expected ${tool.name} to have readOnlyHint: false`);
      }
    }

    let result = await client.callTool({
      name: "bash",
      arguments: { command: "pwd && echo hello" },
    });
    if (
      !result.content[0].text.includes("hello") ||
      !result.content[0].text.startsWith("[cwd: ")
    )
      throw new Error(result.content[0].text);

    result = await client.callTool({
      name: "write",
      arguments: { path: "note.txt", content: "one\ntwo\n" },
    });
    if (!result.content[0].text.includes("[wrote 8 bytes"))
      throw new Error(result.content[0].text);

    result = await client.callTool({
      name: "read",
      arguments: { path: "note.txt" },
    });
    if (
      !result.content[0].text.includes("1\tone") ||
      !result.content[0].text.includes("2\ttwo")
    )
      throw new Error(result.content[0].text);

    result = await client.callTool({
      name: "edit",
      arguments: {
        path: "note.txt",
        edits: [{ oldText: "two", newText: "TWO" }],
      },
    });
    if (!result.content[0].text.includes("[ok: applied 1 edit"))
      throw new Error(result.content[0].text);

    await client.close();
  } finally {
    await server.stop();
  }
}

await smokeRunOnly();
await smokeFull();
console.log("smoke ok");
