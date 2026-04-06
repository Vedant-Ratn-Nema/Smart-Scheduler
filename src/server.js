import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { handleSchedulerTurn } from "./agent/schedulerAgent.js";
import {
  exchangeCodeForTokens,
  getGoogleAuthUrl,
  getOAuthStatus,
} from "./services/oauthService.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, "..", "public");

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (!config.logHttp) {
    next();
    return;
  }
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const url = req.originalUrl || req.url;
    const pathOnly = url.split("?")[0];
    const logThis =
      pathOnly.startsWith("/api") ||
      pathOnly.startsWith("/auth") ||
      pathOnly.startsWith("/oauth2callback") ||
      req.method !== "GET";
    if (logThis) {
      logger.httpLine(`${req.method} ${url} → ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

app.use(express.static(publicPath));

app.get("/api/health", async (_, res) => {
  res.json({ ok: true, timezone: config.timezone, oauth: await getOAuthStatus() });
});

app.get("/api/public-config", (_, res) => {
  res.json({ hostName: config.hostName });
});

app.get("/api/auth/status", async (_, res) => {
  res.json(await getOAuthStatus());
});

app.get("/auth/google", (_, res) => {
  const { url, error } = getGoogleAuthUrl();
  if (error) {
    res.status(400).json({ error });
    return;
  }
  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    if (!code) {
      logger.warn("OAuth callback: missing code");
      res.status(400).send("Missing OAuth code.");
      return;
    }
    const result = await exchangeCodeForTokens(code);
    if (!result.success) {
      logger.warn("OAuth token exchange failed", { error: result.error });
      res.status(400).send(result.error || "OAuth exchange failed.");
      return;
    }
    logger.info("Google OAuth connected; tokens saved");
    res
      .status(200)
      .send(
        "Google account connected successfully. You can return to the Smart Scheduler tab and start booking meetings with Meet + attendees.",
      );
  } catch (error) {
    logger.error("OAuth callback failed", error);
    res.status(500).send(`OAuth callback failed: ${error.message}`);
  }
});

app.post("/api/session", (_, res) => {
  const sessionId = randomUUID();
  logger.debug("New session", { sessionId: sessionId.slice(0, 8) + "…" });
  res.json({ sessionId });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, text, timezone, clientSession } = req.body || {};
    if (!sessionId || !text) {
      logger.warn("POST /api/chat bad request: missing sessionId or text");
      res.status(400).json({ error: "sessionId and text are required." });
      return;
    }

    const hasRestoredState = Boolean(clientSession && typeof clientSession === "object");
    logger.debug("Chat turn", {
      session: String(sessionId).slice(0, 8) + "…",
      textChars: String(text).length,
      timezone: timezone || "(default)",
      restoredFromClient: hasRestoredState,
    });

    const result = await handleSchedulerTurn({
      sessionId,
      userText: text,
      timezone: typeof timezone === "string" ? timezone.trim() || undefined : undefined,
      clientSession:
        clientSession && typeof clientSession === "object" ? clientSession : undefined,
    });

    if (config.logChatSummary && result.state) {
      const s = result.state;
      logger.info("Chat result", {
        session: String(sessionId).slice(0, 8) + "…",
        onboarding: s.onboardingStep,
        titleSet: Boolean(s.title && String(s.title).trim()),
        durationMin: s.constraints?.durationMinutes ?? null,
        slotsSuggested: s.lastSuggestedSlots?.length ?? 0,
        booked: Boolean(result.debug?.created?.created),
      });
    }

    res.json(result);
  } catch (error) {
    logger.error("Agent handler threw", error);
    res.status(500).json({
      error: "Agent failed to process the request.",
      details: error.message,
    });
  }
});

app.get(/.*/, (_, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

export default app;

if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    logger.info(`Smart Scheduler listening on http://localhost:${config.port}`, {
      logLevel: config.logLevel,
      logHttp: config.logHttp,
      chatSummary: config.logChatSummary,
    });
  });
}
