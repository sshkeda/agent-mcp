import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  created_at: number;
}

interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  expires_at: number;
}

interface AccessToken {
  token: string;
  client_id: string;
  scope?: string;
  expires_at: number;
}

const CONFIG_DIR = resolve(homedir(), ".agent-mcp");
const OAUTH_STORE_FILE = resolve(CONFIG_DIR, "oauth.json");

const clients = new Map<string, OAuthClient>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();
const refreshTokens = new Map<string, AccessToken>();

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

function loadStore(): void {
  try {
    if (!existsSync(OAUTH_STORE_FILE)) return;
    const store = JSON.parse(readFileSync(OAUTH_STORE_FILE, "utf8"));
    for (const client of store.clients || []) clients.set(client.client_id, client);
    for (const token of store.accessTokens || []) if (Date.now() < token.expires_at) accessTokens.set(token.token, token);
    for (const token of store.refreshTokens || []) refreshTokens.set(token.token, token);
  } catch {
    // Ignore corrupt OAuth cache; clients can dynamically register again.
  }
}

function saveStore(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const store = {
    clients: [...clients.values()],
    accessTokens: [...accessTokens.values()].filter((token) => Date.now() < token.expires_at),
    refreshTokens: [...refreshTokens.values()],
  };
  writeFileSync(OAUTH_STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(OAUTH_STORE_FILE, 0o600);
}

loadStore();

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function publicBaseUrl(req: IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1:3939";
  return `${proto}://${host}`;
}

export function isIssuedOAuthAccessToken(token: string): boolean {
  const item = accessTokens.get(token);
  if (!item) return false;
  if (Date.now() > item.expires_at) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

export function authorizationServerMetadata(req: IncomingMessage): Record<string, unknown> {
  const base = publicBaseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    userinfo_endpoint: `${base}/userinfo`,
    jwks_uri: `${base}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["agent-mcp", "openid", "profile", "email"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: ["sub", "email", "email_verified", "name"],
  };
}

export function handleOAuthUserinfo(req: IncomingMessage, res: ServerResponse): void {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!token || !isIssuedOAuthAccessToken(token)) return json(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": "Bearer" });
  return json(res, 200, {
    sub: "agent-mcp-local-user",
    email: "local@agent-mcp.invalid",
    email_verified: true,
    name: "agent-mcp local user",
  });
}

export function handleOAuthJwks(_req: IncomingMessage, res: ServerResponse): void {
  return json(res, 200, { keys: [] });
}

export function protectedResourceMetadata(req: IncomingMessage): Record<string, unknown> {
  const base = publicBaseUrl(req);
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["agent-mcp"],
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

async function readParams(req: IncomingMessage): Promise<URLSearchParams> {
  const body = await readBody(req);
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(body || "{}");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
      else if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return params;
  }
  return new URLSearchParams(body);
}

export async function handleOAuthRegistration(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  const body = JSON.parse(await readBody(req) || "{}");
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (redirectUris.length === 0) return json(res, 400, { error: "invalid_client_metadata", error_description: "redirect_uris is required" });

  const client: OAuthClient = {
    client_id: `agent_mcp_${randomToken(18)}`,
    client_secret: randomToken(32),
    client_name: typeof body.client_name === "string" ? body.client_name : "MCP Client",
    redirect_uris: redirectUris,
    grant_types: Array.isArray(body.grant_types) ? body.grant_types.map(String) : ["authorization_code", "refresh_token"],
    response_types: Array.isArray(body.response_types) ? body.response_types.map(String) : ["code"],
    scope: typeof body.scope === "string" ? body.scope : "agent-mcp",
    created_at: Math.floor(Date.now() / 1000),
  };
  clients.set(client.client_id, client);
  saveStore();
  return json(res, 201, {
    ...client,
    client_id_issued_at: client.created_at,
    client_secret_expires_at: 0,
    token_endpoint_auth_method: "client_secret_post",
  });
}

function redirectError(res: ServerResponse, redirectUri: string, error: string, state: string | null): void {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  res.writeHead(302, { Location: url.toString(), "Cache-Control": "no-store" });
  res.end();
}

export function handleOAuthAuthorize(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/authorize", publicBaseUrl(req));
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const state = url.searchParams.get("state");
  const client = clients.get(clientId);
  if (!client) return html(res, 400, "OAuth client not found. Recreate or reconnect the MCP client so dynamic client registration can run.");
  if (!client.redirect_uris.includes(redirectUri)) return redirectError(res, redirectUri || client.redirect_uris[0], "invalid_request", state);
  if ((url.searchParams.get("response_type") || "") !== "code") return redirectError(res, redirectUri, "unsupported_response_type", state);

  const code = randomToken(32);
  authCodes.set(code, {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: url.searchParams.get("code_challenge") || undefined,
    code_challenge_method: url.searchParams.get("code_challenge_method") || undefined,
    scope: url.searchParams.get("scope") || "agent-mcp",
    expires_at: Date.now() + AUTH_CODE_TTL_MS,
  });

  const dest = new URL(redirectUri);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);
  res.writeHead(302, { Location: dest.toString(), "Cache-Control": "no-store" });
  res.end();
}

function verifyPkce(code: AuthCode, verifier: string): boolean {
  if (!code.code_challenge) return true;
  if (code.code_challenge_method === "S256") {
    const digest = createHash("sha256").update(verifier).digest("base64url");
    return digest === code.code_challenge;
  }
  return verifier === code.code_challenge;
}

function parseBasicAuth(req: IncomingMessage): { clientId?: string; clientSecret?: string } {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Basic ")) return {};
  const [clientId, clientSecret] = Buffer.from(auth.slice(6), "base64").toString().split(":");
  return { clientId: decodeURIComponent(clientId || ""), clientSecret: decodeURIComponent(clientSecret || "") };
}

export async function handleOAuthToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  const params = await readParams(req);
  const basic = parseBasicAuth(req);
  const clientId = basic.clientId || params.get("client_id") || "";
  const clientSecret = basic.clientSecret || params.get("client_secret") || "";
  const client = clients.get(clientId);
  if (!client) return json(res, 400, { error: "invalid_client", error_description: "OAuth client not found" });
  if (client.client_secret && clientSecret && clientSecret !== client.client_secret) return json(res, 401, { error: "invalid_client" });

  const grantType = params.get("grant_type");
  if (grantType === "authorization_code") {
    const codeValue = params.get("code") || "";
    const code = authCodes.get(codeValue);
    if (!code || code.client_id !== clientId || Date.now() > code.expires_at) return json(res, 400, { error: "invalid_grant" });
    if (params.get("redirect_uri") && params.get("redirect_uri") !== code.redirect_uri) return json(res, 400, { error: "invalid_grant" });
    if (!verifyPkce(code, params.get("code_verifier") || "")) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    authCodes.delete(codeValue);
    return issueTokens(res, clientId, code.scope);
  }

  if (grantType === "refresh_token") {
    const refresh = params.get("refresh_token") || "";
    const existing = refreshTokens.get(refresh);
    if (!existing || existing.client_id !== clientId) return json(res, 400, { error: "invalid_grant" });
    refreshTokens.delete(refresh);
    return issueTokens(res, clientId, existing.scope);
  }

  return json(res, 400, { error: "unsupported_grant_type" });
}

function issueTokens(res: ServerResponse, clientId: string, scope = "agent-mcp"): void {
  const access = randomToken(32);
  const refresh = randomToken(32);
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
  const token: AccessToken = { token: access, client_id: clientId, scope, expires_at: expiresAt };
  accessTokens.set(access, token);
  refreshTokens.set(refresh, { ...token, token: refresh });
  saveStore();
  return json(res, 200, {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope,
  });
}
