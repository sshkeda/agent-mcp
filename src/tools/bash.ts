import { spawn } from "node:child_process";
import type { Session } from "../session.js";
import { cwdPrefix } from "../session.js";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes

export const bashSchema = {
  name: "bash",
  description:
    "Execute a shell command. Commands run in the session sandbox by default. For repo/project work, start with `cd /absolute/repo && ...`; use absolute paths for files outside the sandbox. Prefer the read tool for file inspection; use bash for commands, search, tests, logs, and shell pipelines. Bash can be destructive; use it only when the user has authorized the action. Returns stdout, stderr, and exit code.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description:
          "Shell command to execute. For repo/project commands, start with `cd /absolute/repo && ...` because the default cwd is the session sandbox.",
      },
      timeout_seconds: {
        type: "number",
        description: "Timeout in seconds (default: 120)",
      },
    },
    required: ["command"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
};

export async function executeBash(
  session: Session,
  args: { command: string; timeout_seconds?: number },
): Promise<string> {
  const timeout = (args.timeout_seconds ?? 120) * 1000;
  const capped = Math.min(timeout, DEFAULT_TIMEOUT);

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", args.command], {
      cwd: session.cwd,
      env: { ...process.env, HOME: process.env.HOME },
      timeout: capped,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      let result = cwdPrefix(session);
      if (stdout) result += stdout;
      if (stderr) result += `\n[stderr]\n${stderr}`;
      result += `\n[exit code: ${code ?? 1}]`;
      resolve(result);
    });

    proc.on("error", (err) => {
      resolve(`${cwdPrefix(session)}[error: ${err.message}]`);
    });
  });
}
