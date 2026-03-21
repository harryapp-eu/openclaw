import { GoogleAuth, OAuth2Client } from "google-auth-library";
import type { ResolvedGoogleChatAccount, ResolvedGoogleChatUserAuth } from "./accounts.js";

const CHAT_SCOPES = [
  "https://www.googleapis.com/auth/chat.bot",
  "https://www.googleapis.com/auth/chat.messages.create",
];
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
// Google Workspace Add-ons use a different service account pattern
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Size-capped to prevent unbounded growth in long-running deployments (#4948)
const MAX_AUTH_CACHE_SIZE = 32;
const authCache = new Map<string, { key: string; auth: GoogleAuth }>();
const userAuthCache = new Map<
  string,
  { key: string; credentials: ResolvedGoogleChatUserAuth; token?: string; expiresAt?: number }
>();
const verifyClient = new OAuth2Client();

let cachedCerts: { fetchedAt: number; certs: Record<string, string> } | null = null;

function buildAuthKey(account: ResolvedGoogleChatAccount): string {
  if (account.credentialsFile) {
    return `file:${account.credentialsFile}`;
  }
  if (account.credentials) {
    return `inline:${JSON.stringify(account.credentials)}`;
  }
  return "none";
}

function buildUserAuthKey(account: ResolvedGoogleChatAccount): string {
  return JSON.stringify({
    accessToken: account.userAuth.accessToken ?? null,
    refreshToken: account.userAuth.refreshToken ?? null,
    clientId: account.userAuth.clientId ?? null,
    clientSecret: account.userAuth.clientSecret ?? null,
    tokenUrl: account.userAuth.tokenUrl ?? null,
  });
}

function getAuthInstance(account: ResolvedGoogleChatAccount): GoogleAuth {
  const key = buildAuthKey(account);
  const cached = authCache.get(account.accountId);
  if (cached && cached.key === key) {
    return cached.auth;
  }

  const evictOldest = () => {
    if (authCache.size > MAX_AUTH_CACHE_SIZE) {
      const oldest = authCache.keys().next().value;
      if (oldest !== undefined) {
        authCache.delete(oldest);
      }
    }
  };

  if (account.credentialsFile) {
    const auth = new GoogleAuth({ keyFile: account.credentialsFile, scopes: CHAT_SCOPES });
    authCache.set(account.accountId, { key, auth });
    evictOldest();
    return auth;
  }

  if (account.credentials) {
    const auth = new GoogleAuth({ credentials: account.credentials, scopes: CHAT_SCOPES });
    authCache.set(account.accountId, { key, auth });
    evictOldest();
    return auth;
  }

  const auth = new GoogleAuth({ scopes: CHAT_SCOPES });
  authCache.set(account.accountId, { key, auth });
  evictOldest();
  return auth;
}

type GoogleChatAuthMode = "app" | "user";

function getCachedUserToken(account: ResolvedGoogleChatAccount): string | undefined {
  const key = buildUserAuthKey(account);
  const cached = userAuthCache.get(account.accountId);
  if (!cached || cached.key !== key) {
    if (cached) {
      userAuthCache.delete(account.accountId);
    }
    return undefined;
  }
  if (cached.token && cached.expiresAt && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }
  return undefined;
}

function setCachedUserToken(
  account: ResolvedGoogleChatAccount,
  params: { token: string; expiresIn?: number },
) {
  const expiresAt = params.expiresIn
    ? Date.now() + Math.max(0, params.expiresIn - 30) * 1000
    : undefined;
  userAuthCache.set(account.accountId, {
    key: buildUserAuthKey(account),
    credentials: account.userAuth,
    token: params.token,
    expiresAt,
  });
  if (userAuthCache.size > MAX_AUTH_CACHE_SIZE) {
    const oldest = userAuthCache.keys().next().value;
    if (oldest !== undefined) {
      userAuthCache.delete(oldest);
    }
  }
}

async function refreshGoogleChatUserAccessToken(
  account: ResolvedGoogleChatAccount,
): Promise<string> {
  const cached = getCachedUserToken(account);
  if (cached) {
    return cached;
  }

  const accessToken = account.userAuth.accessToken?.trim();
  const refreshToken = account.userAuth.refreshToken?.trim();
  const clientId = account.userAuth.clientId?.trim();
  const clientSecret = account.userAuth.clientSecret?.trim();
  const tokenUrl = account.userAuth.tokenUrl?.trim() || DEFAULT_TOKEN_URL;

  if (accessToken && !refreshToken) {
    setCachedUserToken(account, { token: accessToken });
    return accessToken;
  }

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error(
      "Google Chat user auth is missing refresh credentials. Set userAuth.refreshToken, userAuth.clientId, and userAuth.clientSecret.",
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Google Chat user token refresh failed (${response.status}): ${text || response.statusText}`,
    );
  }
  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  const token = payload.access_token?.trim();
  if (!token) {
    throw new Error("Google Chat user token refresh returned no access_token");
  }
  setCachedUserToken(account, { token, expiresIn: payload.expires_in });
  return token;
}

export async function getGoogleChatAccessToken(
  account: ResolvedGoogleChatAccount,
  options?: { authMode?: GoogleChatAuthMode },
): Promise<string> {
  const authMode = options?.authMode ?? "app";
  if (authMode === "user") {
    return await refreshGoogleChatUserAccessToken(account);
  }

  const auth = getAuthInstance(account);
  const client = await auth.getClient();
  const access = await client.getAccessToken();
  const token = typeof access === "string" ? access : access?.token;
  if (!token) {
    throw new Error("Missing Google Chat access token");
  }
  return token;
}

async function fetchChatCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now - cachedCerts.fetchedAt < 10 * 60 * 1000) {
    return cachedCerts.certs;
  }
  const res = await fetch(CHAT_CERTS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Chat certs (${res.status})`);
  }
  const certs = (await res.json()) as Record<string, string>;
  cachedCerts = { fetchedAt: now, certs };
  return certs;
}

export type GoogleChatAudienceType = "app-url" | "project-number";

export async function verifyGoogleChatRequest(params: {
  bearer?: string | null;
  audienceType?: GoogleChatAudienceType | null;
  audience?: string | null;
  expectedAddOnPrincipal?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const bearer = params.bearer?.trim();
  if (!bearer) {
    return { ok: false, reason: "missing token" };
  }
  const audience = params.audience?.trim();
  if (!audience) {
    return { ok: false, reason: "missing audience" };
  }
  const audienceType = params.audienceType ?? null;

  if (audienceType === "app-url") {
    try {
      const ticket = await verifyClient.verifyIdToken({
        idToken: bearer,
        audience,
      });
      const payload = ticket.getPayload();
      const email = String(payload?.email ?? "")
        .trim()
        .toLowerCase();
      if (!payload?.email_verified) {
        return { ok: false, reason: "email not verified" };
      }
      if (email === CHAT_ISSUER) {
        return { ok: true };
      }
      if (!ADDON_ISSUER_PATTERN.test(email)) {
        return { ok: false, reason: `invalid issuer: ${email}` };
      }
      const expectedAddOnPrincipal = params.expectedAddOnPrincipal?.trim().toLowerCase();
      if (!expectedAddOnPrincipal) {
        return { ok: false, reason: "missing add-on principal binding" };
      }
      const tokenPrincipal = String(payload?.sub ?? "")
        .trim()
        .toLowerCase();
      if (!tokenPrincipal || tokenPrincipal !== expectedAddOnPrincipal) {
        return {
          ok: false,
          reason: `unexpected add-on principal: ${tokenPrincipal || "<missing>"}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "invalid token" };
    }
  }

  if (audienceType === "project-number") {
    try {
      const certs = await fetchChatCerts();
      await verifyClient.verifySignedJwtWithCertsAsync(bearer, certs, audience, [CHAT_ISSUER]);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "invalid token" };
    }
  }

  return { ok: false, reason: "unsupported audience type" };
}

export const GOOGLE_CHAT_SCOPE = CHAT_SCOPES[0];
