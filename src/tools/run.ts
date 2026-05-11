import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { Session } from "../session.js";
import { requirePinnedCwd } from "../context.js";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_OUTPUT_CHARS = 50_000;

export const runSchema = {
  name: "run",
  description:
    "Run sandboxed JavaScript code with a small agent SDK for local repo/Mac work. This is the preferred tool for multi-step inspection: use repo.search(), repo.files(), repo.read(), repo.write(), repo.edit(), npm.scripts(), npm.findScripts(), shell.run(), and return JSON-serializable results. Code is an async JavaScript function body; do not include markdown fences. IMPORTANT: use an explicit return statement; a bare final expression returns null.",
  inputSchema: {
    type: "object" as const,
    properties: {
      code: {
        type: "string",
        description:
          "Async JavaScript function body. Available globals: repo, npm, shell, ui. repo.files(pattern) returns string paths. Use repo.write(path, content) and repo.edit(path, { oldText, newText }) for file writes/edits. Use an explicit return statement; a bare final expression returns null. Example: const scripts = await npm.findScripts('mcp debug'); const matches = await repo.search('buildNativeMcpPrompt'); return { script: scripts[0]?.name, file: matches[0]?.path ?? null };",
      },
      timeout_seconds: {
        type: "number",
        description: "Execution timeout in seconds (default 30, max 120)",
      },
    },
    required: ["code"],
  },
};

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}...[truncated ${text.length - max} chars]` : text;
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function normalizeRunCode(code: string): string {
  const trimmed = code.trim();
  if (/^(?:async\s*)?\([^)]*\)\s*=>/.test(trimmed) || /^(?:async\s+)?function\b/.test(trimmed)) {
    const callable = trimmed.replace(/\s*\(\s*\)\s*;?\s*$/, '');
    return `return await (${callable})();`;
  }
  return code;
}

function buildRunnerModule(code: string, cwd: string): string {
  const normalizedCode = normalizeRunCode(code);
  return `
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { spawn } from "node:child_process";

const cwd = ${jsString(cwd)};
const statuses = [];

function cleanRel(path) {
  return path.split('/').filter((part) => part && part !== '.').join('/');
}

function repoPathValue(path = ".") {
  if (path && typeof path === 'object') {
    if (typeof path.path === 'string') return path.path;
    if (typeof path.absolutePath === 'string') return path.absolutePath;
    if (typeof path.content === 'string' && typeof path.toString === 'function') return path.toString();
  }
  return String(path ?? '.');
}

function resolveRepoPath(path = ".") {
  return resolve(cwd, repoPathValue(path));
}

function toRepoRelative(path) {
  const rel = relative(cwd, path).split('\\\\').join('/');
  return rel && !rel.startsWith('..') ? rel : path;
}

function truncate(value, max = 4000) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) + \`...[truncated \${text.length - max} chars]\` : text;
}

function searchLineExtras(lineNumber, snippet) {
  const zeroBasedLine = Math.max(0, Number(lineNumber || 1) - 1);
  const result = { range: { start: { line: zeroBasedLine, column: 0 }, end: { line: zeroBasedLine, column: String(snippet || '').length } } };
  const assignment = String(snippet || '').match(/\\b([A-Z0-9_]{3,})\\b\\s*=\\s*[^\\n]*?([0-9][0-9_]*)(?![\\w_])/);
  if (assignment) result.value = Number(assignment[2].replaceAll('_', ''));
  return result;
}

function searchTokens(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !['the', 'and', 'for', 'with', 'that', 'this', 'file', 'source', 'defines', 'define', 'builder'].includes(token));
}

function uniqueValues(values) {
  return [...new Set(values)];
}

function tokenScore(queryTokens, haystack) {
  const tokens = uniqueValues(queryTokens);
  if (!tokens.length) return 0;
  const hay = searchTokens(haystack).join(' ');
  const matched = tokens.filter((token) => hay.includes(token)).length;
  return matched / tokens.length;
}

function expandBracePatterns(pattern) {
  const p = String(pattern || '');
  const match = /\{([^{}]+)\}/.exec(p);
  if (!match) return [p];
  return match[1].split(',').flatMap((part) => expandBracePatterns(p.slice(0, match.index) + part + p.slice(match.index + match[0].length)));
}

function globToRegExp(pattern) {
  const specials = '.+^' + '$' + '{}()|[]\\\\';
  let out = '';
  const p = String(pattern || '');
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*' && p[i + 2] === '/') {
      out += '(?:.*/)?';
      i += 2;
    } else if (ch === '*' && p[i + 1] === '*') {
      out += '.*';
      i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += specials.includes(ch) ? '\\\\' + ch : ch;
    }
  }
  return new RegExp('^' + out + '$', 'i');
}

function fileMatchesPattern(rel, pattern) {
  const p = String(pattern || '');
  if (!p) return true;
  const normalized = rel.split('\\\\').join('/');
  return expandBracePatterns(p).some((candidate) => {
    const basename = normalized.split('/').pop() || normalized;
    if (!candidate.includes('*') && !candidate.includes('?')) return normalized.toLowerCase().includes(candidate.toLowerCase());
    const re = globToRegExp(candidate);
    return re.test(normalized) || (!candidate.includes('/') && re.test(basename));
  });
}

function jsonReplacer(_key, value) {
  return value === undefined ? null : value;
}

function normalizedIncludes(haystack, needle) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return String(haystack).includes(String(needle)) || normalize(haystack).includes(normalize(needle));
}

class ReadResult {
  constructor(fields) {
    Object.assign(this, fields);
  }
  toString() { return String(this.content ?? ''); }
  valueOf() { return this.toString(); }
  toJSON() { return { path: this.path, absolutePath: this.absolutePath, content: this.content, ...(this.offset !== undefined ? { offset: this.offset, limit: this.limit } : {}) }; }
  includes(...args) { return this.toString().includes(...args); }
  match(...args) { return this.toString().match(...args); }
  split(...args) { return this.toString().split(...args); }
  trim() { return this.toString().trim(); }
  slice(...args) { return this.toString().slice(...args); }
}

class ScriptCommand extends String {
  includes(searchString, position) {
    return super.includes(searchString, position) || normalizedIncludes(this.toString().slice(position || 0), searchString);
  }
  toJSON() {
    return this.toString();
  }
}

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.turbo') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function runCommand(command, options = {}) {
  const timeout = Math.min(Number(options.timeoutSeconds ?? 30), 120) * 1000;
  const commandCwd = options.cwd ? resolve(cwd, options.cwd) : cwd;
  return new Promise((resolvePromise) => {
    const proc = spawn('bash', ['-c', command], { cwd: commandCwd, env: { ...process.env, HOME: process.env.HOME }, timeout });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolvePromise({ stdout: truncate(stdout, 20000), stderr: truncate(stderr, 20000), exitCode: code ?? 1 }));
    proc.on('error', (err) => resolvePromise({ stdout: '', stderr: err.message, exitCode: 1 }));
  });
}

const repo = Object.freeze({
  cwd: () => cwd,
  async read(path, options = {}) {
    const full = resolveRepoPath(path);
    const content = await readFile(full, 'utf8');
    const lines = content.split('\\n');
    if (options.offset !== undefined || options.limit !== undefined) {
      const offset = Math.max(0, Number(options.offset ?? 0));
      const limit = Math.max(0, Number(options.limit ?? lines.length));
      return new ReadResult({ path: toRepoRelative(full), absolutePath: full, content: lines.slice(offset, offset + limit).join('\\n'), offset, limit });
    }
    return new ReadResult({ path: toRepoRelative(full), absolutePath: full, content });
  },
  async write(path, content, options = {}) {
    const full = resolveRepoPath(path);
    if (options.createDirs !== false) await mkdir(dirname(full), { recursive: true });
    const text = String(content ?? '');
    await writeFile(full, text, options.append ? { flag: 'a' } : undefined);
    return { path: toRepoRelative(full), absolutePath: full, bytes: Buffer.byteLength(text, 'utf8'), appended: Boolean(options.append) };
  },
  async edit(path, { oldText, newText, replaceAll = false } = {}) {
    if (typeof oldText !== 'string' || oldText.length === 0) throw new Error('repo.edit requires non-empty oldText');
    if (typeof newText !== 'string') throw new Error('repo.edit requires newText string');
    const full = resolveRepoPath(path);
    const content = await readFile(full, 'utf8');
    const first = content.indexOf(oldText);
    if (first === -1) throw new Error('repo.edit oldText not found');
    const second = content.indexOf(oldText, first + oldText.length);
    if (!replaceAll && second !== -1) throw new Error('repo.edit oldText is not unique; pass replaceAll: true to replace all occurrences');
    const updated = replaceAll ? content.split(oldText).join(newText) : content.slice(0, first) + newText + content.slice(first + oldText.length);
    await writeFile(full, updated);
    return { path: toRepoRelative(full), absolutePath: full, replacements: replaceAll ? content.split(oldText).length - 1 : 1 };
  },
  async files(pattern = '') {
    const files = await walk(cwd);
    const needle = String(pattern || '').toLowerCase().replaceAll('*', '').replaceAll('{', '').replaceAll('}', '').replaceAll(',', '');
    const paths = files.map((full) => toRepoRelative(full));
    let matches = paths.filter((path) => !pattern || fileMatchesPattern(path, pattern) || path.toLowerCase().includes(needle));
    if (matches.length === 0 && String(pattern || '').toLowerCase().includes('e2e')) {
      matches = paths.filter((path) => /(^|[/.-])e2e([/.-]|$)/i.test(path));
    }
    return matches.slice(0, 500);
  },
  async search(query, options = {}) {
    const q = String(query || '');
    if (!q) return [];
    const maxResults = Math.max(1, Math.min(Number(options.maxResults ?? 20), 100));
    let files = (await walk(cwd)).filter((full) => fileMatchesPattern(toRepoRelative(full), options.filePattern));
    const queryTokens = searchTokens(q);
    const candidates = [];
    const seen = new Set();
    function add(result, score) {
      if (!existsSync(result.absolutePath)) return;
      const key = result.line === null ? result.path : result.path + ':' + result.line;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ ...result, score });
    }

    function resultBoost(rel, filePattern) {
      let boost = 0;
      if (rel.startsWith('src/') || rel.startsWith('tests/') || rel.startsWith('scripts/')) boost += 20;
      if (rel.startsWith('dist/') || rel.startsWith('node_modules/')) boost -= 50;
      const wantsTests = String(filePattern || '').toLowerCase().includes('e2e') || String(filePattern || '').toLowerCase().includes('test');
      if (wantsTests && (rel.startsWith('test/') || rel.startsWith('tests/') || rel.includes('/e2e') || rel.startsWith('e2e'))) boost += 60;
      return boost;
    }

    async function addRipgrepMatches(filePattern, baseScore, scoringPattern = filePattern) {
      const globs = ['-g', '!dist/**', '-g', '!node_modules/**', '-g', '!.git/**'];
      if (filePattern) globs.push('-g', String(filePattern));
      const rg = await runCommand(['rg', '-n', '--no-heading', '--color', 'never', '--ignore-case', ...globs, q, '.'].map((part) => JSON.stringify(part)).join(' '), { timeoutSeconds: options.timeoutSeconds ?? 30 });
      if (rg.exitCode !== 0 || !rg.stdout.trim()) return false;
      for (const line of rg.stdout.trim().split('\\n')) {
        const parts = line.split(':');
        const path = parts.shift() || '';
        const lineNumber = Number(parts.shift() || 0);
        const snippet = parts.join(':');
        const absolutePath = resolveRepoPath(path);
        const rel = toRepoRelative(absolutePath);
        const shortSnippet = truncate(snippet, 1000);
        add({ path: rel, filePath: rel, absolutePath, line: lineNumber, snippet: shortSnippet, text: shortSnippet, lines: [shortSnippet], ...searchLineExtras(lineNumber, snippet) }, baseScore + resultBoost(rel, scoringPattern) + tokenScore(queryTokens, rel + ' ' + snippet));
      }
      return true;
    }

    const hadPatternMatches = await addRipgrepMatches(options.filePattern, 100);
    if (!hadPatternMatches && options.filePattern) {
      files = await walk(cwd);
      await addRipgrepMatches(undefined, 80, options.filePattern);
    }

    for (const full of files) {
      const rel = toRepoRelative(full);
      const score = tokenScore(queryTokens, rel);
      if (score > 0) add({ path: rel, filePath: rel, absolutePath: full, line: null, snippet: '', text: '', lines: [] }, 10 + resultBoost(rel, options.filePattern) + score);
    }

    if (candidates.length === 0 && queryTokens.length > 0) {
      for (const full of files) {
        const rel = toRepoRelative(full);
        let content = '';
        try { content = await readFile(full, 'utf8'); } catch { continue; }
        const score = Math.max(tokenScore(queryTokens, rel), tokenScore(queryTokens, content));
        if (score > 0) add({ path: rel, filePath: rel, absolutePath: full, line: null, snippet: '', text: '', lines: [] }, score);
      }
    }

    return candidates
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || Number(a.line ?? 0) - Number(b.line ?? 0))
      .slice(0, maxResults)
      .map(({ score, ...result }) => result);
  },
});

const npm = Object.freeze({
  async scripts(path = 'package.json') {
    const file = await repo.read(path);
    const parsed = JSON.parse(file.content);
    return Object.fromEntries(Object.entries(parsed.scripts || {}).map(([name, command]) => [name, new ScriptCommand(command)]));
  },
  async findScripts(query, path = 'package.json') {
    const scripts = await npm.scripts(path);
    const queryTokens = searchTokens(query);
    return Object.entries(scripts)
      .map(([name, command]) => ({
        name,
        command,
        score: Math.max(tokenScore(queryTokens, name), tokenScore(queryTokens, name + ' ' + command)),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map(({ score, ...entry }) => entry);
  },
});

const shell = Object.freeze({ run: runCommand });
const ui = Object.freeze({ status(message) { statuses.push(String(message)); } });

async function main() {
${normalizedCode}
}

try {
  const result = await main();
  console.log(JSON.stringify({ ok: true, result: result ?? null, statuses }, jsonReplacer, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: { name: err?.name || 'Error', message: err?.message || String(err) }, statuses }, jsonReplacer, 2));
  process.exitCode = 1;
}
`;
}

export function executeRun(
  session: Session,
  args: { code: string; timeout_seconds?: number },
): string {
  const pin = requirePinnedCwd();
  const cwd = pin.cwd;
  const timeoutSeconds = Math.min(Math.max(Number(args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS), 1), MAX_TIMEOUT_SECONDS);
  const dir = mkdtempSync(join(tmpdir(), "agent-mcp-run-"));
  const modulePath = join(dir, "run.mjs");
  try {
    writeFileSync(modulePath, buildRunnerModule(args.code, cwd));
    const child = spawnSync(process.execPath, [modulePath], {
      cwd,
      env: { ...process.env, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: timeoutSeconds * 1000,
      maxBuffer: MAX_OUTPUT_CHARS * 2,
    });
    const stdout = truncate(child.stdout || "");
    const stderr = truncate(child.stderr || "");
    const relCwd = cwd === session.cwd ? session.cwd : `${cwd} (${relative(session.cwd, cwd)})`;
    let result = `[cwd: ${relCwd}; epoch: ${pin.epoch}]\n`;
    if (stdout) result += stdout;
    if (stderr) result += `\n[stderr]\n${stderr}`;
    result += `\n[exit code: ${child.status ?? (child.error ? 1 : 0)}]`;
    if (child.error) result += `\n[error: ${child.error.message}]`;
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
