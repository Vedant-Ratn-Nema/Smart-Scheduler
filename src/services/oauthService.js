import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { google } from "googleapis";
import { Redis } from "@upstash/redis";
import { config } from "../config.js";

const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];

function getTokenFilePath() {
  return resolve(process.cwd(), config.oauthTokenFile);
}

function hasRedisConfig() {
  return Boolean(config.upstashRedisUrl && config.upstashRedisToken);
}

let redisClient = null;
function getRedisClient() {
  if (!hasRedisConfig()) return null;
  if (!redisClient) {
    redisClient = new Redis({
      url: config.upstashRedisUrl,
      token: config.upstashRedisToken,
    });
  }
  return redisClient;
}

function getTokenStoreMode() {
  if (config.oauthTokenStore === "redis" || config.oauthTokenStore === "file") {
    return config.oauthTokenStore;
  }
  return hasRedisConfig() ? "redis" : "file";
}

function normalizeTokenPayload(value) {
  if (!value || typeof value !== "object") return null;
  const token = value;
  if (!token.refresh_token && !token.access_token) return null;
  return token;
}

function tryReadOAuthClientFromJson(filePath) {
  if (!filePath) return null;
  const resolved = resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) return null;
  try {
    const parsed = JSON.parse(readFileSync(resolved, "utf8"));
    const node = parsed.web || parsed.installed || null;
    if (!node?.client_id || !node?.client_secret) return null;
    const redirectUri = config.oauthRedirectUri || node.redirect_uris?.[0] || "";
    if (!redirectUri) return null;
    return {
      clientId: node.client_id,
      clientSecret: node.client_secret,
      redirectUri,
    };
  } catch {
    return null;
  }
}

async function readSavedToken() {
  if (getTokenStoreMode() === "redis") {
    const redis = getRedisClient();
    if (!redis) return null;
    try {
      const token = await redis.get(config.oauthTokenRedisKey);
      return normalizeTokenPayload(token);
    } catch {
      return null;
    }
  }

  const tokenPath = getTokenFilePath();
  if (!existsSync(tokenPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(tokenPath, "utf8"));
    return normalizeTokenPayload(parsed);
  } catch {
    return null;
  }
}

async function writeSavedToken(token) {
  if (getTokenStoreMode() === "redis") {
    const redis = getRedisClient();
    if (!redis) {
      throw new Error(
        "OAUTH_TOKEN_STORE=redis requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      );
    }
    await redis.set(config.oauthTokenRedisKey, token);
    return;
  }

  const tokenPath = getTokenFilePath();
  writeFileSync(tokenPath, JSON.stringify(token, null, 2), "utf8");
}

function buildOAuthClient() {
  const cfg = getOAuthClientConfig();
  if (!cfg) return null;
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

function getOAuthClientConfig() {
  if (config.oauthClientId && config.oauthClientSecret && config.oauthRedirectUri) {
    return {
      clientId: config.oauthClientId,
      clientSecret: config.oauthClientSecret,
      redirectUri: config.oauthRedirectUri,
    };
  }

  // Preferred file var for downloaded OAuth client JSON.
  const byOAuthFile = tryReadOAuthClientFromJson(config.oauthCredentialsFile);
  if (byOAuthFile) return byOAuthFile;

  // Backward-compatible fallback in case users pointed service-account file env to OAuth JSON by mistake.
  const byServiceFile = tryReadOAuthClientFromJson(config.serviceAccountFile);
  if (byServiceFile) return byServiceFile;

  return null;
}

export function isOAuthConfigured() {
  return Boolean(getOAuthClientConfig());
}

export function getGoogleAuthUrl() {
  if (!isOAuthConfigured()) {
    return {
      url: "",
      error:
        "OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.",
    };
  }
  const oauth2Client = buildOAuthClient();
  if (!oauth2Client) {
    return {
      url: "",
      error:
        "OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI or GOOGLE_OAUTH_CREDENTIALS_FILE.",
    };
  }
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: CALENDAR_SCOPES,
  });
  return { url, error: null };
}

export async function exchangeCodeForTokens(code) {
  if (!isOAuthConfigured()) {
    return {
      success: false,
      error:
        "OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.",
    };
  }
  const oauth2Client = buildOAuthClient();
  if (!oauth2Client) {
    return {
      success: false,
      error:
        "OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI or GOOGLE_OAUTH_CREDENTIALS_FILE.",
    };
  }
  const { tokens } = await oauth2Client.getToken(code);

  const existing = (await readSavedToken()) || {};
  const merged = {
    ...existing,
    ...tokens,
    refresh_token: tokens.refresh_token || existing.refresh_token || "",
  };
  await writeSavedToken(merged);
  return { success: true, error: null };
}

export async function getOAuthClientFromSavedToken() {
  if (!isOAuthConfigured()) {
    return { client: null, error: "OAuth is not configured." };
  }
  const tokens = await readSavedToken();
  if (!tokens?.refresh_token && !tokens?.access_token) {
    return {
      client: null,
      error:
        "OAuth is configured but not authenticated. Visit /auth/google to connect your Google account.",
    };
  }
  const oauth2Client = buildOAuthClient();
  if (!oauth2Client) {
    return {
      client: null,
      error:
        "OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI or GOOGLE_OAUTH_CREDENTIALS_FILE.",
    };
  }
  oauth2Client.setCredentials(tokens);
  return { client: oauth2Client, error: null };
}

export async function getOAuthStatus() {
  const cfg = getOAuthClientConfig();
  const configured = isOAuthConfigured();
  const saved = await readSavedToken();
  const authenticated = Boolean(saved?.refresh_token || saved?.access_token);
  return {
    configured,
    authenticated,
    tokenStore: getTokenStoreMode(),
    tokenRedisKey: config.oauthTokenRedisKey,
    tokenFile: getTokenFilePath(),
    redirectUri: cfg?.redirectUri || "",
  };
}
