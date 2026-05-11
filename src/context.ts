import { isAbsolute, resolve } from "node:path";

export interface CwdPinState {
  cwd: string;
  epoch: number;
  expiresAt: number;
}

let pinState: CwdPinState | null = null;

export function currentCwdPin(): CwdPinState | null {
  if (pinState && pinState.expiresAt <= Date.now()) pinState = null;
  return pinState;
}

export function pinCwd({ cwd, epoch, ttlMs = 5 * 60_000 }: { cwd: string; epoch: number; ttlMs?: number }): CwdPinState {
  if (!isAbsolute(cwd)) throw new Error(`cwd must be absolute: ${cwd}`);
  if (!Number.isFinite(epoch) || epoch <= 0) throw new Error(`epoch must be a positive number: ${epoch}`);
  const current = currentCwdPin();
  if (current && current.epoch >= epoch) throw new Error(`stale epoch ${epoch}; current epoch is ${current.epoch}`);
  pinState = { cwd: resolve(cwd), epoch, expiresAt: Date.now() + Math.max(1_000, Math.min(ttlMs, 30 * 60_000)) };
  return pinState;
}

export function unpinCwd(epoch?: number): { cleared: boolean; alreadyCleared: boolean } {
  const current = currentCwdPin();
  if (!current) return { cleared: false, alreadyCleared: true };
  if (epoch !== undefined && Number.isFinite(epoch) && current.epoch !== epoch) return { cleared: false, alreadyCleared: false };
  pinState = null;
  return { cleared: true, alreadyCleared: false };
}

export function requirePinnedCwd(): CwdPinState {
  const current = currentCwdPin();
  if (!current) throw new Error("native_mcp_unbound: no cwd is pinned for this native MCP session");
  return current;
}
