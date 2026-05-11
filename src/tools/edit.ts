import { readFileSync, writeFileSync } from "node:fs";
import type { Session } from "../session.js";
import { resolvePath, cwdPrefix } from "../session.js";

export const editSchema = {
  name: "edit",
  description:
    "Apply atomic exact string replacements to a file. Each edit's oldText must appear exactly once. Use absolute paths for repo/project files outside the sandbox; relative paths resolve inside the session sandbox. Prefer read first to inspect context before editing. Editing can be destructive, so use it only when the user has authorized changes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "File path. Use an absolute path for repo/project files outside the sandbox; relative paths resolve inside the session sandbox." },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact text to find; include enough surrounding context so it matches exactly once" },
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["oldText", "newText"],
        },
        description: "Array of {oldText, newText} replacements",
      },
    },
    required: ["path", "edits"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

export function executeEdit(
  session: Session,
  args: { path: string; edits: Array<{ oldText: string; newText: string }> },
): string {
  const resolved = resolvePath(session, args.path);
  const original = readFileSync(resolved, "utf-8");

  if (args.edits.length === 0) {
    return `${cwdPrefix(session)}[error: edits must contain at least one replacement]`;
  }

  // Validate every replacement against the original file before writing anything.
  // This makes edit atomic: any failed match leaves the file unchanged.
  for (let i = 0; i < args.edits.length; i += 1) {
    const edit = args.edits[i];
    if (edit.oldText.length === 0) {
      return `${cwdPrefix(session)}[error: edit ${i + 1} oldText cannot be empty]`;
    }

    const idx = original.indexOf(edit.oldText);
    if (idx === -1) {
      return `${cwdPrefix(session)}[error: edit ${i + 1} oldText not found in file; no changes written]`;
    }

    const secondIdx = original.indexOf(edit.oldText, idx + edit.oldText.length);
    if (secondIdx !== -1) {
      return `${cwdPrefix(session)}[error: edit ${i + 1} oldText matches multiple locations; provide more context; no changes written]`;
    }
  }

  let content = original;
  for (const edit of args.edits) {
    content = content.replace(edit.oldText, edit.newText);
  }

  writeFileSync(resolved, content, "utf-8");
  return `${cwdPrefix(session)}[ok: applied ${args.edits.length} edit${args.edits.length === 1 ? "" : "s"} to ${resolved}]`;
}
