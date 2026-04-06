import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  timezone: process.env.DEFAULT_TIMEZONE || "America/Los_Angeles",
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  calendarId: process.env.GOOGLE_CALENDAR_ID || "",
  oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  oauthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || "",
  oauthTokenFile: process.env.GOOGLE_OAUTH_TOKEN_FILE || ".oauth_tokens.json",
  oauthTokenStore: process.env.OAUTH_TOKEN_STORE || "auto",
  oauthTokenRedisKey: process.env.OAUTH_TOKEN_REDIS_KEY || "oauth:google:token",
  upstashRedisUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "",
  upstashRedisToken:
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "",
  oauthCredentialsFile: process.env.GOOGLE_OAUTH_CREDENTIALS_FILE || "",
  serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
  serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "",
  hostEmail: process.env.HOST_EMAIL || "vedantrnema05@gmail.com",
  hostName: process.env.HOST_NAME || "Vedant",
  slotStepMinutes: Number(process.env.SLOT_STEP_MINUTES || 15),
  /** debug | info | warn | error — see src/utils/logger.js */
  logLevel: process.env.LOG_LEVEL || "info",
  /** Set false to hide one-line HTTP lines for /api and non-GET */
  logHttp: process.env.LOG_HTTP !== "false",
  /** Log chat turn summary (onboarding step, slot count) at info */
  logChatSummary: process.env.LOG_CHAT_SUMMARY !== "false",
};

export const hasOpenAi = Boolean(config.openAiApiKey);
export const hasGoogleCalendar = Boolean(
  config.calendarId &&
    ((config.oauthClientId && config.oauthClientSecret && config.oauthRedirectUri) ||
      config.serviceAccountJson ||
      config.serviceAccountFile),
);
