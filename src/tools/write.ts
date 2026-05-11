import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Session } from "../session.js";
import { resolvePath, cwdPrefix } from "../session.js";

export const writeSchema = {
  name: "write",
  description:
    "Create or overwrite a file. Parent directories are created automatically. Use absolute paths for repo/project files outside the sandbox; relative paths resolve inside the session sandbox. This can overwrite data, so use it only when the user has authorized creating or replacing the file.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "File path. Use an absolute path for repo/project files outside the sandbox; relative paths resolve inside the session sandbox." },
      content: { type: "string", description: "Complete file content to write" },
    },
    required: ["path", "content"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

export function executeWrite(
  session: Session,
  args: { path: string; content: string },
): string {
  const resolved = resolvePath(session, args.path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, args.content, "utf-8");
  return `${cwdPrefix(session)}[wrote ${args.content.length} bytes to ${resolved}]`;
}
