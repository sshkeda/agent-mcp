import { readFileSync, statSync } from "node:fs";
import type { Session } from "../session.js";
import { resolvePath, cwdPrefix } from "../session.js";

export const readSchema = {
  name: "read",
  description:
    "Read a text file's contents. Prefer this over bash/cat/sed for file inspection. Use absolute paths for repo/project files outside the sandbox; relative paths resolve inside the session sandbox. Use offset and limit for large files instead of reading everything at once.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description:
          "File path. Use an absolute path for repo/project files outside the sandbox; relative paths resolve inside the session sandbox.",
      },
      offset: {
        type: "number",
        description:
          "0-based line number to start from; use with limit for large files",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return; use for large files",
      },
    },
    required: ["path"],
  },
};

export function executeRead(
  session: Session,
  args: { path: string; offset?: number; limit?: number },
): string {
  const resolved = resolvePath(session, args.path);
  const stat = statSync(resolved);

  if (stat.isDirectory()) {
    return `${cwdPrefix(session)}[error: path is a directory, not a file: ${resolved}]`;
  }

  const content = readFileSync(resolved, "utf-8");
  const lines = content.split("\n");

  const offset = args.offset ?? 0;
  const limit = args.limit ?? lines.length;
  const sliced = lines.slice(offset, offset + limit);

  const numbered = sliced
    .map((line, i) => `${offset + i + 1}\t${line}`)
    .join("\n");

  return `${cwdPrefix(session)}${numbered}`;
}
