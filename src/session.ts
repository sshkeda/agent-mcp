import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";

const HOME = homedir();

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function generateSlug(): string {
  return `session-${Date.now().toString(36)}`;
}

export interface Session {
  id: string;
  cwd: string;
  scratchDir: string;
  createdAt: number;
  lastAccessedAt: number;
}

const sessions = new Map<string, Session>();

export function getOrCreateSession(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (session) {
    session.lastAccessedAt = Date.now();
    return session;
  }

  const slug = generateSlug();
  const scratchDir = resolve(HOME, "Documents", "agent-mcp", today(), slug);
  mkdirSync(scratchDir, { recursive: true });

  const now = Date.now();
  session = {
    id: sessionId,
    cwd: scratchDir,
    scratchDir,
    createdAt: now,
    lastAccessedAt: now,
  };
  sessions.set(sessionId, session);
  return session;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function deleteExpiredSessions(maxIdleMs: number): string[] {
  const now = Date.now();
  const deleted: string[] = [];
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccessedAt > maxIdleMs) {
      sessions.delete(sessionId);
      deleted.push(sessionId);
    }
  }
  return deleted;
}

export function sessionCount(): number {
  return sessions.size;
}

export function resolvePath(session: Session, path: string): string {
  const expanded = path.startsWith("~") ? resolve(HOME, path.slice(2)) : path;
  if (isAbsolute(expanded)) return expanded;
  return resolve(session.cwd, expanded);
}

export function cwdPrefix(session: Session): string {
  return `[cwd: ${session.cwd}]\n`;
}
