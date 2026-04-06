/**
 * Lightweight readable logs: ISO time, level, message, optional JSON context.
 * Configure via config.js / env: LOG_LEVEL, LOG_HTTP.
 */

import { config } from "../config.js";

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel() {
  const v = String(config.logLevel || "info").toLowerCase();
  return LEVEL_ORDER[v] ?? LEVEL_ORDER.info;
}

function shouldLog(level) {
  return LEVEL_ORDER[level] >= minLevel();
}

const useColor = typeof process.stdout !== "undefined" && process.stdout.isTTY;

const ansi = useColor
  ? {
      reset: "\x1b[0m",
      dim: "\x1b[2m",
      bold: "\x1b[1m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      blue: "\x1b[34m",
      cyan: "\x1b[36m",
      gray: "\x1b[90m",
    }
  : {
      reset: "",
      dim: "",
      bold: "",
      red: "",
      green: "",
      yellow: "",
      blue: "",
      cyan: "",
      gray: "",
    };

const levelColor = {
  debug: ansi.gray,
  info: ansi.cyan,
  warn: ansi.yellow,
  error: ansi.red,
  http: ansi.green,
};

function padLevel(level) {
  return level.toUpperCase().padEnd(5);
}

function formatMeta(meta) {
  if (meta === undefined) return "";
  if (meta instanceof Error) {
    return `\n${ansi.dim}${meta.stack || meta.message}${ansi.reset}`;
  }
  if (typeof meta === "object") {
    try {
      return `\n${ansi.dim}${JSON.stringify(meta, null, 2)}${ansi.reset}`;
    } catch {
      return `\n${ansi.dim}${String(meta)}${ansi.reset}`;
    }
  }
  return `\n${ansi.dim}${String(meta)}${ansi.reset}`;
}

function write(level, message, meta) {
  if (!shouldLog(level)) return;
  const time = `${ansi.dim}${new Date().toISOString()}${ansi.reset}`;
  const tag = `${levelColor[level] || ""}${ansi.bold}${padLevel(level)}${ansi.reset}`;
  const line = `${time} ${tag} ${message}`;
  if (meta !== undefined) {
    // eslint-disable-next-line no-console
    console.log(line + formatMeta(meta));
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export const logger = {
  debug: (message, meta) => write("debug", message, meta),
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
  /**
   * One-line HTTP request summary (respects LOG_HTTP / config.logHttp).
   */
  httpLine(message) {
    if (!config.logHttp) return;
    if (!shouldLog("info")) return;
    const time = `${ansi.dim}${new Date().toISOString()}${ansi.reset}`;
    const tag = `${levelColor.http}${ansi.bold}${padLevel("http")}${ansi.reset}`;
    // eslint-disable-next-line no-console
    console.log(`${time} ${tag} ${message}`);
  },
};
