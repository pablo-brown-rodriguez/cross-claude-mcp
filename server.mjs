#!/usr/bin/env node

/**
 * Cross-Claude MCP Server
 *
 * Modes (auto-detected):
 * - Local (stdio + SQLite): when no PORT env var is set
 * - Remote (HTTP + PostgreSQL): when PORT and DATABASE_URL are set (Railway)
 *
 * Remote endpoints:
 * - POST /mcp -- Streamable HTTP (Claude.ai, Claude Code via mcp-remote, Claude Desktop)
 * - GET  /mcp -- SSE stream for Streamable HTTP
 * - GET  /sse -- Legacy SSE transport (only with ENABLE_LEGACY_SSE=1)
 * - POST /messages -- Legacy SSE message endpoint (only with ENABLE_LEGACY_SSE=1)
 * - GET  /health -- Health check
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDB } from "./db.mjs";
import { registerTools } from "./tools.mjs";
import { createRestRouter, logPath } from "./rest-api.mjs";

// What an error is, for a log line: its class and code and where it was raised. Never its message
// (a database or parser message can carry connection details or request content) and never the
// whole stack.
function errorKind(err) {
  if (!err || typeof err !== "object") return "unknown";
  const name = typeof err.name === "string" ? err.name : "Error";
  const code = typeof err.code === "string" || typeof err.code === "number" ? ` ${err.code}` : (typeof err.type === "string" ? ` ${err.type}` : "");
  const frame = typeof err.stack === "string" ? (err.stack.split("\n").find((l) => /^\s+at\s/.test(l)) || "") : "";
  const where = (frame.match(/([^/\\()\s]+:\d+):\d+\)?\s*$/) || [])[1];
  return `${name}${code}`.replace(/[^\w .:-]/g, "").slice(0, 80) + (where ? ` at ${where}` : "");
}

// --- Transport: Stdio (local) ---

async function startStdio(db) {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });
  const cleanup = registerTools(server, db);

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => { cleanup(); process.exit(0); });
  }
  process.on("exit", cleanup);
  process.stdin.on("end", () => { cleanup(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// --- Transport: HTTP (Railway) ---

async function startHTTP(db) {
  const express = (await import("express")).default;
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
  const { randomUUID } = await import("crypto");

  const app = express();
  const PORT = parseInt(process.env.PORT) || 3000;

  // --- Health check + README (no auth) ---

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      server: "cross-claude-mcp",
      version: "2.0.0",
    });
  });

  app.get("/readme", async (req, res) => {
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const md = readFileSync(join(__dirname, "README.md"), "utf-8");

    const escaped = md
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cross-Claude MCP</title>
<style>body{max-width:800px;margin:40px auto;padding:0 20px;font-family:-apple-system,system-ui,sans-serif;line-height:1.6;color:#333}
code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:0.9em}
pre{background:#f4f4f4;padding:16px;border-radius:6px;overflow-x:auto}
h1{border-bottom:2px solid #eee;padding-bottom:8px}h2{border-bottom:1px solid #eee;padding-bottom:4px;margin-top:2em}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f4f4f4}
li{margin:4px 0}</style></head>
<body><p>${escaped}</p></body></html>`);
  });

  // --- OpenAPI spec (no auth, needed for ChatGPT Custom GPT Actions) ---

  app.get("/openapi.json", async (req, res) => {
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    res.type("json").send(readFileSync(join(__dirname, "openapi.json"), "utf-8"));
  });

  // --- Bearer token auth ---

  const API_TOKEN = process.env.MCP_API_KEY;
  // D-558: never serve the exchange without a key. An unset (or blank) MCP_API_KEY used to leave
  // every route open. Now the server refuses to start unless ALLOW_NO_AUTH=1 is set on purpose
  // (local testing only). On Railway a deploy that lost the key fails instead of going live open.
  const AUTH_ON = Boolean(API_TOKEN && API_TOKEN.trim());
  if (!AUTH_ON) {
    if (process.env.ALLOW_NO_AUTH !== "1") {
      console.error("[FATAL] MCP_API_KEY is not set. Refusing to start without authentication. Set MCP_API_KEY, or ALLOW_NO_AUTH=1 for local testing only.");
      process.exit(1);
    }
    console.warn("[WARN] ALLOW_NO_AUTH=1: running with NO authentication.");
  } else if (API_TOKEN !== API_TOKEN.trim()) {
    // A key pasted with a space or line break around it can never match what clients send:
    // the server would start, look healthy and refuse everyone.
    console.error("[FATAL] MCP_API_KEY starts or ends with whitespace. Refusing to start: fix the variable.");
    process.exit(1);
  }
  const { createHash, timingSafeEqual } = await import("crypto");
  const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest();
  // Constant-time comparison on fixed-length digests; the candidate is never logged.
  const tokenMatches = (candidate) =>
    typeof candidate === "string" && candidate.length > 0 &&
    timingSafeEqual(sha256(candidate), sha256(API_TOKEN));

  app.use((req, res, next) => {
    if (req.path === "/health" || req.path === "/readme" || req.path.startsWith("/openapi.json")) return next();

    if (AUTH_ON) {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7)
        : req.query.api_key || null;
      if (!tokenMatches(token)) {
        // Log only whether credentials were sent, never any part of them: a failed
        // sign-in often carries a real key with a typo, or last month's key.
        console.log(`[AUTH FAIL] ${req.method} ${logPath(req.path)} | authorization header: ${authHeader ? "present" : "absent"} | query api_key: ${req.query.api_key ? "present" : "absent"}`);
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    console.log(`[AUTH OK] ${req.method} ${logPath(req.path)}`);
    next();
  });

  // --- REST API (for ChatGPT, Gemini, curl, etc.) ---

  app.use("/api", express.json(), createRestRouter(db));

  // --- Streamable HTTP transport ---

  const sessions = new Map();
  const { isInitializeRequest } = await import("@modelcontextprotocol/sdk/types.js");

  // KE-233 / D-558: sessions live in memory, so every restart orphans every open client. The old
  // code built a fresh session transport for the unknown id, and that transport answered 400
  // "Server not initialized" forever. A 404 is what the 2025 revisions of MCP ask for, but it only
  // helps a client that then re-opens by itself, and the SDK client (1.27) does not. A session id
  // is no security boundary here (every caller holds the one key), so a POST that carries an
  // unknown id is simply answered, by a one-request stateless transport that ignores the id.
  // The open chat keeps working across a restart with nothing asked of the client. GET (the
  // stand-alone stream, which needs a live session) still answers 404.
  const sessionNotFound = (res) => res.status(404).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null,
  });
  const noSession = (res) => res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: no session. Send an initialize request first." },
    id: null,
  });

  // Close one session: drop it from the map first, close its transport, then mark the instance
  // offline. The offline write may be slow or hang (database down): it is given two seconds and
  // never holds up the caller.
  async function closeSession(sid, entry) {
    sessions.delete(sid);
    try { await entry.transport.close(); } catch { /* already closed */ }
    await Promise.race([
      Promise.resolve().then(() => entry.cleanup()).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000).unref()),
    ]);
  }

  // Sessions are never closed by most clients, and each holds memory (about 0.75 MB measured)
  // until the process dies of it; an out-of-memory restart is exactly the KE-233 event. Two
  // bounds: sessions idle longer than SESSION_IDLE_DAYS (default 1) are closed by an hourly
  // sweep, and no more than MAX_SESSIONS (default 200) are kept, the least recently used going
  // first. Neither costs a client anything: its next POST is answered without a session.
  const SESSION_IDLE_MS = (parseFloat(process.env.SESSION_IDLE_DAYS) > 0 ? parseFloat(process.env.SESSION_IDLE_DAYS) : 1) * 24 * 60 * 60 * 1000;
  const MAX_SESSIONS = Math.min(parseInt(process.env.MAX_SESSIONS) > 0 ? parseInt(process.env.MAX_SESSIONS) : 200, 10000);
  // A request in flight keeps its session: closing it mid-request sent the caller an empty 200.
  // An open GET stream is counted apart: it shows a connected client, so the idle sweep leaves
  // the session, but it must not hold the session past the cap (a stream can stay open for days).
  function trackRequest(entry, res, field = "inFlight") {
    entry[field] = (entry[field] || 0) + 1;
    entry.lastSeen = Date.now();
    res.on("close", () => { entry[field] = Math.max(0, (entry[field] || 1) - 1); entry.lastSeen = Date.now(); });
  }
  let sweeping = false;
  async function sweepIdleSessions(now = Date.now()) {
    if (sweeping) return 0;   // a slow close (database down) must not let sweeps pile up
    sweeping = true;
    let closed = 0;
    try {
      for (const [sid, entry] of [...sessions]) {
        if (!sessions.has(sid) || entry.inFlight > 0 || entry.streams > 0) continue;
        if (now - (entry.lastSeen || 0) > SESSION_IDLE_MS) { await closeSession(sid, entry); closed++; }
      }
    } finally { sweeping = false; }
    if (closed) console.log(`[SESSION] closed ${closed} idle session(s); ${sessions.size} open`);
    return closed;
  }
  function evictOverCap() {
    let evicted = 0;
    while (sessions.size > MAX_SESSIONS) {
      // Least recently used first; a session with an open stream goes only when no other can.
      // Known edge: when open streams alone fill the cap, each new session is the one closed,
      // at once; its calls are then answered without a session, like any closed session's.
      let victim = null;
      const older = (x, y) => (x.streams > 0) !== (y.streams > 0) ? !(x.streams > 0) : (x.lastSeen || 0) < (y.lastSeen || 0);
      for (const [sid, entry] of sessions) {
        if (entry.inFlight > 0) continue;
        if (!victim || older(entry, victim[1])) victim = [sid, entry];
      }
      if (!victim) break;   // every session is mid-request: over the cap until one finishes
      closeSession(victim[0], victim[1]).catch(() => {});   // leaves the map before the first await
      evicted++;
    }
    if (evicted) console.log(`[SESSION] closed ${evicted} session(s) over the cap of ${MAX_SESSIONS}; ${sessions.size} open`);
  }
  // SESSION_SWEEP_MS exists for the tests; the default is hourly. Bounded: Node turns a timer
  // delay above 2^31-1 ms into 1 ms.
  const SESSION_SWEEP_MS = Math.min(Math.max(parseInt(process.env.SESSION_SWEEP_MS) > 0 ? parseInt(process.env.SESSION_SWEEP_MS) : 60 * 60 * 1000, 100), 2147483647);
  setInterval(() => { sweepIdleSessions().catch(() => {}); }, SESSION_SWEEP_MS).unref();

  app.post("/mcp", express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let session = typeof sessionId === "string" ? sessions.get(sessionId) : null;

    if (!session) {
      // Only an initialize request may open a session. It may carry a stale session id (a client
      // that re-opens after a restart without dropping its old id): the id is ignored.
      const messages = Array.isArray(req.body) ? req.body : [req.body];
      if (!messages.some((m) => isInitializeRequest(m))) {
        if (sessionId === undefined) return noSession(res);
        console.log("[SESSION] POST /mcp with an unknown session id: answered without a session");
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });
        registerTools(server, db);   // no offline marking: this server lives for one request
        res.on("close", () => {
          Promise.resolve().then(() => transport.close()).catch(() => {});
          Promise.resolve().then(() => server.close()).catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });
      const cleanup = registerTools(server, db);

      await server.connect(transport);

      const sessionEntry = { server, transport, cleanup, lastSeen: Date.now(), inFlight: 0, streams: 0 };

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          cleanup();
          sessions.delete(sid);
        }
      };

      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, sessionEntry);
        evictOverCap();
      }
      return;
    }

    trackRequest(session, res);
    await session.transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : null;

    if (!session) {
      if (sessionId !== undefined) return sessionNotFound(res);
      res.status(400).json({ error: "No session. Send POST /mcp first to initialize." });
      return;
    }

    trackRequest(session, res, "streams");
    await session.transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : null;

    if (session) await closeSession(sessionId, session);
    res.status(200).json({ ok: true });
  });

  // --- Legacy SSE transport ---

  // Off by default: on main every /sse request threw (a double start), so nothing can depend on
  // it, and two fewer routes is less to defend. ENABLE_LEGACY_SSE=1 turns it on.
  const LEGACY_SSE = process.env.ENABLE_LEGACY_SSE === "1";
  const sseTransports = new Map();

  if (LEGACY_SSE) app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });
    const cleanup = registerTools(server, db);

    sseTransports.set(transport.sessionId, { server, transport, cleanup });

    transport.onclose = () => {
      cleanup();
      sseTransports.delete(transport.sessionId);
    };

    // connect() starts the transport itself; a second start() threw on every /sse request.
    await server.connect(transport);
  });

  if (LEGACY_SSE) app.post("/messages", express.json(), async (req, res) => {
    const sessionId = req.query.sessionId;
    const session = sessionId ? sseTransports.get(sessionId) : null;

    if (!session) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    await session.transport.handlePostMessage(req, res, req.body);
  });

  // --- Errors: log the kind, never the detail; answer without a stack trace ---

  app.use((err, req, res, _next) => {
    console.error(`[ERROR] ${req.method} ${logPath(req.path)} | ${errorKind(err)}`);
    // A response already under way (a stream) cannot take a status: end it. Passing the error on
    // would let Express print the whole message and stack.
    if (res.headersSent) { res.destroy(); return; }
    const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    const text = { 413: "Payload too large", 415: "Unsupported media type" }[status] || (status === 500 ? "Internal error" : "Bad request");
    res.status(status).json({ error: text });
  });

  // --- Start ---

  // --- Auto-cleanup: delete data older than 7 days ---

  const CLEANUP_DAYS = parseInt(process.env.CLEANUP_DAYS) || 7;
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  async function runCleanup() {
    try {
      const result = await db.cleanup(CLEANUP_DAYS);
      const total = result.messages + result.instances + result.shared_data;
      if (total > 0) {
        console.log(`[CLEANUP] Removed ${result.messages} messages, ${result.instances} instances, ${result.shared_data} shared data (older than ${CLEANUP_DAYS} days)`);
      }
    } catch (err) {
      // Name or code only: a database error message can carry connection details.
      console.error(`[CLEANUP] Error: ${errorKind(err)}`);
    }
  }

  await runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  app.listen(PORT, "0.0.0.0", (err) => {
    // Express 5 hands a failed listen (port taken) to this callback: without the check the
    // banner said "listening" on a process that was not.
    if (err) {
      console.error(`[FATAL] cannot listen on port ${PORT}: ${errorKind(err)}`);
      process.exit(1);
    }
    console.log(`cross-claude-mcp v2.0.0 listening on port ${PORT}`);
    console.log(`  Mode:            Standard`);
    console.log(`  Streamable HTTP: POST/GET /mcp`);
    console.log(`  REST API:        /api/* (ChatGPT, Gemini, curl)`);
    console.log(`  Legacy SSE:      ${LEGACY_SSE ? "GET /sse, POST /messages" : "off (ENABLE_LEGACY_SSE=1 to enable)"}`);
    console.log(`  Health:          GET /health`);
    console.log(`  Auth:            ${AUTH_ON ? "Bearer token required" : "NONE (ALLOW_NO_AUTH=1)"}`);
    console.log(`  Database:        ${process.env.DATABASE_URL ? "PostgreSQL" : "SQLite (local)"}`);
    console.log(`  Cleanup:         Every ${CLEANUP_DAYS} days (checks hourly)`);
  });
}

// --- Main ---

let db;
try {
  db = await createDB();
} catch (err) {
  // Kind only: a database start-up error printed whole carries the host and a full stack.
  console.error(`[FATAL] database start-up failed: ${errorKind(err)}`);
  process.exit(1);
}

if (process.env.PORT) {
  await startHTTP(db);
} else {
  await startStdio(db);
}
