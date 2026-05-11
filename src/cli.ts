#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync, chmodSync } from "node:fs";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const CONFIG_DIR = resolve(HOME, ".agent-mcp");
const LOG_DIR = resolve(CONFIG_DIR, "logs");
const PID_FILE = resolve(CONFIG_DIR, "daemon.pid");
const TOKEN_FILE = resolve(CONFIG_DIR, "token");

function optionValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const args = process.argv.slice(3);
  const withEquals = args.find((arg) => arg.startsWith(prefix));
  if (withEquals) return withEquals.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const INVOKED_AS = basename(process.argv[1] || "agent-mcp");
const DEFAULT_PROFILE = INVOKED_AS === "pi-mcp" ? "full" : "run-only";
const PORT = parseInt(optionValue("--port") ?? process.env.AGENT_MCP_PORT ?? "3939", 10);
const PROFILE = optionValue("--profile") ?? process.env.AGENT_MCP_PROFILE ?? DEFAULT_PROFILE;
const CWD = optionValue("--cwd") ?? process.env.AGENT_MCP_CWD;

function ensureDirs() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getRunningPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid) || !isRunning(pid)) {
    unlinkSync(PID_FILE);
    return null;
  }
  return pid;
}

function getOrCreateToken(): string {
  ensureDirs();
  if (process.env.AGENT_MCP_TOKEN) return process.env.AGENT_MCP_TOKEN;
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf-8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(TOKEN_FILE, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  return token;
}

function getTokenIfPresent(): string | null {
  if (process.env.AGENT_MCP_TOKEN) return process.env.AGENT_MCP_TOKEN;
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf-8").trim();
  return null;
}

function start() {
  ensureDirs();

  const existing = getRunningPid();
  if (existing) {
    console.log(`agent-mcp already running (pid ${existing}) on port ${PORT}`);
    return;
  }

  const logFile = resolve(LOG_DIR, "daemon.log");
  const serverScript = resolve(import.meta.dirname, "index.js");
  const token = getOrCreateToken();

  const logFd = openSync(logFile, "a");

  const child = spawn("node", [serverScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      AGENT_MCP_PORT: String(PORT),
      AGENT_MCP_TOKEN: token,
      AGENT_MCP_PROFILE: PROFILE,
      ...(CWD ? { AGENT_MCP_CWD: CWD } : {}),
    },
  });

  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  console.log(`agent-mcp started (pid ${child.pid}) on http://127.0.0.1:${PORT}/mcp`);
  console.log(`Profile: ${PROFILE}${CWD ? `, cwd: ${CWD}` : ""}`);
  console.log(`Auth: bearer token required (${TOKEN_FILE})`);
  console.log("Connector URL if headers are unavailable: run `agent-mcp url`");
  console.log(`Logs: ${logFile}`);
}

function stop() {
  const pid = getRunningPid();
  if (!pid) {
    console.log("agent-mcp is not running");
    return;
  }
  process.kill(pid, "SIGINT");
  unlinkSync(PID_FILE);
  console.log(`agent-mcp stopped (pid ${pid})`);
}

function status() {
  const pid = getRunningPid();
  const token = getTokenIfPresent();
  if (pid) {
    console.log(`agent-mcp is running (pid ${pid}) on port ${PORT}`);
  } else {
    console.log("agent-mcp is not running");
  }
  console.log(`profile: ${PROFILE}`);
  if (CWD) console.log(`cwd: ${CWD}`);
  console.log(`auth token: ${token ? `present (${TOKEN_FILE})` : "missing"}`);
}

function printToken() {
  console.log(getOrCreateToken());
}

function printUrl() {
  const token = getOrCreateToken();
  console.log(`http://127.0.0.1:${PORT}/mcp?token=${encodeURIComponent(token)}`);
}

const command = process.argv[2];

switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "status":
    status();
    break;
  case "restart":
    stop();
    start();
    break;
  case "token":
    printToken();
    break;
  case "url":
    printUrl();
    break;
  default:
    console.log("Usage: agent-mcp <start|stop|status|restart|token|url> [--profile run-only|full|readonly] [--port 3939] [--cwd /repo]");
    process.exit(1);
}
