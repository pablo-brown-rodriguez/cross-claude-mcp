#!/usr/bin/env node
/**
 * Session and start-up tests for the HTTP server (D-558 / KE-233, 2026-11-18). Synthetic keys only.
 * Run: node test-session.mjs
 */
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const KEY = "synthetic-session-test-key-0123456789";
const PORT = String(42000 + Math.floor(Math.random() * 2000));
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const homes = [];
const logs = [];   // every server process started here, so log checks see all of them
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`); ok ? passed++ : failed++; };

function start(extraEnv, home = mkdtempSync(join(tmpdir(), "ccm-sess-"))) {
  if (!homes.includes(home)) homes.push(home);
  // Never the shell's database or key: only what a test passes in.
  const base = { ...process.env }; delete base.DATABASE_URL; delete base.MCP_API_KEY;
  const env = { ...base, PORT, HOME: home, ...extraEnv };
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete env[k];
  const child = spawn("node", [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  const s = { child, out: "", home, exit: null };
  child.stdout.on("data", (d) => (s.out += d));
  child.stderr.on("data", (d) => (s.out += d));
  child.on("exit", (code) => (s.exit = code));
  logs.push(s);
  return s;
}
async function up() { for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) return true; } catch {} await wait(150); } return false; }
async function stop(s) { s.child.kill("SIGTERM"); for (let i = 0; i < 40 && s.exit === null; i++) await wait(100); if (s.exit === null) s.child.kill("SIGKILL"); await wait(150); }

const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${KEY}` };
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "session-test", version: "1" } } };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const post = (body, headers = {}, raw = false) => fetch(BASE + "/mcp", { method: "POST", headers: { ...H, ...headers }, body: raw ? body : JSON.stringify(body) });
async function json(r) { try { return JSON.parse(await r.text()); } catch { return null; } }
async function open() {
  const r = await post(INIT); const sid = r.headers.get("mcp-session-id"); await r.text();
  await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid })).text();
  return { status: r.status, sid };
}

try {
// 1. start-up: no key, blank key, explicit opt-out
for (const [label, env] of [["unset key", { MCP_API_KEY: undefined, ALLOW_NO_AUTH: undefined }], ["blank key", { MCP_API_KEY: "   ", ALLOW_NO_AUTH: undefined }], ["ALLOW_NO_AUTH=0", { MCP_API_KEY: undefined, ALLOW_NO_AUTH: "0" }], ["ALLOW_NO_AUTH=true", { MCP_API_KEY: undefined, ALLOW_NO_AUTH: "true" }], ["key with a trailing line break", { MCP_API_KEY: KEY + "\n", ALLOW_NO_AUTH: undefined }], ["key with a leading space", { MCP_API_KEY: " " + KEY, ALLOW_NO_AUTH: undefined }]]) {
  const s = start(env); for (let i = 0; i < 50 && s.exit === null; i++) await wait(100);
  let listening = false; try { listening = (await fetch(BASE + "/health")).ok; } catch {}
  check(`${label}: refuses to start`, s.exit === 1 && !listening && s.out.includes("[FATAL]"), `exit ${s.exit}`);
  if (s.exit === null) await stop(s);
}
{
  const s = start({ MCP_API_KEY: undefined, ALLOW_NO_AUTH: "1" });
  check("ALLOW_NO_AUTH=1: starts, with a warning and an honest banner", (await up()) && s.out.includes("NO authentication") && s.out.includes("NONE (ALLOW_NO_AUTH=1)") && !s.out.includes("Bearer token required"));
  await stop(s);
}
{
  const s = start({ MCP_API_KEY: KEY, ALLOW_NO_AUTH: "1" });
  const okUp = await up();
  const r0 = await fetch(BASE + "/api/channels");
  check("a real key with ALLOW_NO_AUTH=1 still requires the key", okUp && r0.status === 401 && s.out.includes("Bearer token required"));
  await stop(s);
}

// 2. sessions
let s = start({ MCP_API_KEY: KEY });
check("server with a key starts", await up());
check("no key -> 401 on /mcp", (await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(INIT) })).status === 401);
const a = await open();
check("initialize opens a session", a.status === 200 && !!a.sid, `status ${a.status}`);
let r = await post(LIST, { "mcp-session-id": a.sid }); const listText = await r.text();
check("known session answers tools/list", r.status === 200 && listText.includes("check_messages"), `status ${r.status}`);

r = await post(LIST, { "mcp-session-id": "00000000-0000-4000-8000-000000000000" }); let unkText = await r.text(); let b;
check("unknown session id on POST is answered, with no session minted", r.status === 200 && unkText.includes("check_messages") && !r.headers.get("mcp-session-id"), `status ${r.status}`);
r = await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_channels", arguments: {} } }, { "mcp-session-id": "another-unknown-id" }); unkText = await r.text();
check("unknown session id: a tool call works", r.status === 200 && unkText.includes('"result"') && !unkText.includes('"isError":true'), `status ${r.status}`);
r = await post(INIT, { "mcp-session-id": "stale-session-id" }); const reSid = r.headers.get("mcp-session-id"); await r.text();
check("initialize carrying a stale session id opens a new session", r.status === 200 && !!reSid && reSid !== "stale-session-id", `status ${r.status}`);
r = await post("x".repeat(200 * 1024), { "mcp-session-id": a.sid }, true); b = await json(r);
check("oversized body -> 413 named as such, no stack", r.status === 413 && b?.error === "Payload too large", `status ${r.status}`);
r = await fetch(BASE + "/api/register", { method: "POST", headers: { Authorization: `Bearer ${KEY}` } }); const restText = await r.text();
check("REST POST with no body -> 400, not a 500", r.status === 400 && restText.includes("Request body must be JSON"), `status ${r.status}`);
r = await fetch(BASE + "/api/data/synthetic-secret-key-name"); await r.text();
r = await fetch(BASE + "/api/messages/synthetic-secret-channel", { headers: { Authorization: `Bearer ${KEY}` } }); await r.text();
check("auth log lines keep two path segments: no shared-data key or channel name", s.out.includes("[AUTH FAIL] GET /api/data/...") && s.out.includes("[AUTH OK] GET /api/messages/...") && !s.out.includes("synthetic-secret"));
{
  const s2 = start({ MCP_API_KEY: KEY }); for (let i = 0; i < 50 && s2.exit === null; i++) await wait(100);
  check("a second server on a taken port exits with a FATAL line, no 'listening' banner", s2.exit === 1 && s2.out.includes("[FATAL] cannot listen") && !s2.out.includes("listening on port"), `exit ${s2.exit}`);
  if (s2.exit === null) await stop(s2);
  const s3 = start({ MCP_API_KEY: KEY, DATABASE_URL: "postgresql://synthuser:synthpw-0123@127.0.0.1:1/x" }); for (let i = 0; i < 100 && s3.exit === null; i++) await wait(100);
  check("an unreachable database at start-up exits with a FATAL line: no password, host or stack", s3.exit === 1 && s3.out.includes("[FATAL] database start-up failed") && !s3.out.includes("synthpw") && !s3.out.includes("127.0.0.1") && !/\n\s+at\s/.test(s3.out), `exit ${s3.exit}`);
  if (s3.exit === null) await stop(s3);
}
r = await fetch(BASE + "/sse", { headers: { Authorization: `Bearer ${KEY}` } }); await r.text();
check("legacy /sse is off by default", r.status === 404);
r = await post(LIST); b = await json(r);
check("no session id, not initialize -> 400", r.status === 400 && b?.error?.code === -32000, `status ${r.status}`);
r = await post([LIST, LIST]); await r.text();
check("no session id, batch without initialize -> 400", r.status === 400);
r = await post("", {}, true); await r.text();
check("no session id, empty body -> 400", r.status === 400);
r = await post("{not json", {}, true); const badText = await r.text();
check("malformed JSON -> 400 with no stack trace", r.status === 400 && !/\bat\s.+:\d+:\d+/.test(badText) && !badText.includes("SyntaxError"), `status ${r.status}`);
r = await fetch(BASE + "/mcp", { headers: { ...H, "mcp-session-id": "nope" } });
b = await json(r);
check("GET /mcp unknown session -> 404 Session not found", r.status === 404 && b?.error?.code === -32001 && b?.id === null, `status ${r.status}`);
r = await fetch(BASE + "/mcp", { headers: H }); await r.text();
check("GET /mcp with no session id -> 400", r.status === 400);

// 3. delete
const d = await open();
r = await fetch(BASE + "/mcp", { method: "DELETE", headers: { ...H, "mcp-session-id": d.sid } }); await r.text();
check("DELETE known session -> 200", r.status === 200);
r = await post(LIST, { "mcp-session-id": d.sid }); await r.text();
check("a deleted session's id is then treated as unknown (answered, 200)", r.status === 200);
r = await fetch(BASE + "/mcp", { method: "DELETE", headers: { ...H, "mcp-session-id": "nope" } }); await r.text();
check("DELETE unknown session -> 200 (unchanged)", r.status === 200);

// 4. legacy SSE, when switched on, works end to end
await stop(s);
s = start({ MCP_API_KEY: KEY, ENABLE_LEGACY_SSE: "1" }, s.home);
check("server with ENABLE_LEGACY_SSE=1 starts", await up());
{
  const ac = new AbortController();
  const sse = await fetch(BASE + "/sse", { headers: { Authorization: `Bearer ${KEY}` }, signal: ac.signal });
  const reader = sse.body.getReader(); let first = "";
  const t = setTimeout(() => ac.abort(), 3000);
  try { while (!first.includes("\n\n")) { const { value, done } = await reader.read(); if (done) break; first += new TextDecoder().decode(value); } } catch {}
  clearTimeout(t);
  check("GET /sse answers an endpoint event", sse.status === 200 && first.includes("event: endpoint"), `status ${sse.status}`);
  const ep = (first.match(/data: (\S+)/) || [])[1] || "";
  const mr = await fetch(BASE + ep, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(INIT) });
  await mr.text();
  let reply = ""; const t2 = setTimeout(() => ac.abort(), 3000);
  try { while (!reply.includes("serverInfo")) { const { value, done } = await reader.read(); if (done) break; reply += new TextDecoder().decode(value); } } catch {}
  clearTimeout(t2); ac.abort();
  check("legacy session answers initialize over the stream", mr.status === 202 && reply.includes("serverInfo"), `status ${mr.status}`);
  await wait(300);
  check("GET /sse logs no error", !s.out.includes("already started") && !s.out.includes("[ERROR] GET /sse"));
}

// 4b. idle sessions are closed by the sweep
await stop(s);
s = start({ MCP_API_KEY: KEY, SESSION_IDLE_DAYS: "0.00001", SESSION_SWEEP_MS: "300" }, s.home);
check("server with a short idle horizon starts", await up());
{
  const idle = await open();
  await wait(2200);
  r = await post(LIST, { "mcp-session-id": idle.sid }); await r.text();
  check("a session idle past the horizon is closed, and its next call is still answered", r.status === 200 && s.out.includes("idle session(s)"), `status ${r.status}`);
}

// 5. KE-233: a restart orphans the session; the client is told 404 and a new session works
await stop(s);
s = start({ MCP_API_KEY: KEY }, s.home);
check("server restarts", await up());
r = await post(LIST, { "mcp-session-id": a.sid }); const afterText = await r.text();
check("KE-233: a session from before the restart is answered, not 400 'Server not initialized'", r.status === 200 && afterText.includes("check_messages") && !afterText.includes("not initialized"), `status ${r.status}`);
const c = await open();
r = await post(LIST, { "mcp-session-id": c.sid }); await r.text();
check("a new session after the restart works", c.status === 200 && r.status === 200);

// 5b. the real SDK client, kept open across a restart, with nothing done on the client side
{
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "restart-test", version: "1" });
  const tr = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } });
  let before = 0, after = 0, err = "";
  try {
    await client.connect(tr);
    before = (await client.listTools()).tools.length;
    await stop(s);
    s = start({ MCP_API_KEY: KEY }, s.home);
    await up();
    after = (await client.listTools()).tools.length;
    const call = await client.callTool({ name: "list_channels", arguments: {} });
    if (call.isError) err = "tool call error";
  } catch (e) { err = e?.name || "error"; }
  check("SDK client: same client object works after the server restarts", before > 0 && after === before && !err, `before ${before} after ${after} ${err}`);
  try { await tr.close(); } catch {}
}

const call = (name, args, sid, id = 50) => post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid });

// 6. presence after a restart: a chat on a stale id stays online through its own calls
{
  const live = await open();
  await (await call("register", { instance_id: "stale-bob" }, live.sid)).text();
  await stop(s);
  const { default: Database } = await import("better-sqlite3");
  const dbf = new Database(join(s.home, ".cross-claude-mcp", "messages.db"));
  dbf.prepare("UPDATE instances SET status = 'offline', last_seen = datetime('now', '-300 seconds') WHERE instance_id = ?").run("stale-bob");
  dbf.close();
  s = start({ MCP_API_KEY: KEY }, s.home);
  await up();
  r = await call("list_instances", {}, live.sid); const beforeBeat = await r.text();
  await (await call("check_messages", { channel: "presence-test", instance_id: "stale-bob" }, live.sid)).text();
  r = await call("list_instances", {}, live.sid); const afterBeat = await r.text();
  check("stale id: the caller's own instance_id keeps it online after a restart", beforeBeat.includes("stale-bob [offline]") && afterBeat.includes("stale-bob [online]"));
}

// 7. the session cap: the least recently used session goes, and its next call is still answered
await stop(s);
s = start({ MCP_API_KEY: KEY, MAX_SESSIONS: "2" }, s.home);
await up();
{
  const s1 = await open(); await wait(30); const s2 = await open(); await wait(30); const s3 = await open(); await wait(200);
  const count = () => s.out.split("unknown session id: answered without a session").length - 1;
  const c0 = count();
  r = await post(LIST, { "mcp-session-id": s3.sid }); await r.text(); const c1 = count();
  r = await post(LIST, { "mcp-session-id": s1.sid }); const capText = await r.text(); const c2 = count();
  check("over MAX_SESSIONS the oldest session is closed; the newest stays; the closed one is still answered", s.out.includes("session(s) over the cap of 2") && c1 === c0 && c2 === c0 + 1 && r.status === 200 && capText.includes("check_messages"), `counts ${c0} ${c1} ${c2}`);
  // a session holding an open GET stream goes last, but it does go: the cap is hard
  const h1 = await open();                                   // open now: s2, h1 (s3 went when h1 was stored)
  const ac = new AbortController();
  const stream = await fetch(BASE + "/mcp", { headers: { ...H, "mcp-session-id": h1.sid }, signal: ac.signal });
  await wait(100); const h2 = await open(); await wait(100);  // s2 (older, no stream) goes; h1 keeps its stream
  const c3 = count();
  r = await post(LIST, { "mcp-session-id": h1.sid }); await r.text(); const c4 = count();
  r = await post(LIST, { "mcp-session-id": s2.sid }); await r.text(); const c5 = count();
  check("over the cap, a session with an open stream is kept while another can go", stream.status === 200 && c4 === c3 && c5 === c3 + 1, `counts ${c3} ${c4} ${c5}`);
  await (await post(LIST, { "mcp-session-id": h2.sid })).text(); await wait(50);   // h2 is now the most recently used
  const h3 = await open(); await wait(150);                    // open before: h1 (stream), h2; h3 stored -> h2 (no stream, older than h3) goes
  const c6 = count();
  r = await post(LIST, { "mcp-session-id": h2.sid }); await r.text(); const c7 = count();
  check("the cap holds when a stream stays open: the plain session goes first", c7 === c6 + 1, `counts ${c6} ${c7}`);
  const h4 = await open(); await wait(150);                    // open before: h1 (stream), h3; h4 stored -> h3 goes
  const h5 = await open(); await wait(150);                    // open before: h1 (stream), h4; h5 stored -> h4 goes
  ac.abort(); await wait(150);
  const lines = s.out.split("\n").filter((l) => l.includes("over the cap of 2"));
  check("every store over the cap closed exactly one session", lines.length >= 5 && lines.every((l) => l.includes("closed 1 session(s)") && l.includes("; 2 open")), `lines ${lines.length}`);
}

// 8. the sweep leaves a session with a request in flight; wait_for_reply is bounded
await stop(s);
s = start({ MCP_API_KEY: KEY, SESSION_IDLE_DAYS: "0.000005", SESSION_SWEEP_MS: "150" }, s.home);
await up();
{
  const w = await open();
  const t0 = Date.now();
  r = await call("wait_for_reply", { channel: "sweep-test", after_id: 0, instance_id: "waiter", timeout_seconds: 2.5, poll_interval_seconds: 1 }, w.sid);
  const waited = await r.text();
  check("a request in flight is answered in full while the sweep runs", r.status === 200 && waited.includes("No new messages") && Date.now() - t0 >= 2000, `status ${r.status} len ${waited.length}`);
  const t1 = Date.now();
  r = await call("wait_for_reply", { channel: "sweep-test", after_id: 0, instance_id: "waiter", timeout_seconds: 1, poll_interval_seconds: 1e9 }, w.sid);
  const clamped = await r.text();
  check("wait_for_reply: a huge poll interval cannot outlast the timeout", clamped.includes("No new messages") && Date.now() - t1 < 4000 && !s.out.includes("TimeoutOverflowWarning"), `ms ${Date.now() - t1}`);
  // an open stream keeps its session through the sweep; once the stream closes, the session is swept
  const g = await open(); const plain = await open();
  const gc = new AbortController();
  const gs = await fetch(BASE + "/mcp", { headers: { ...H, "mcp-session-id": g.sid }, signal: gc.signal });
  const seen = () => s.out.split("unknown session id: answered without a session").length - 1;
  await wait(1300); const n0 = seen();
  await (await post(LIST, { "mcp-session-id": g.sid })).text(); const n1 = seen();
  await (await post(LIST, { "mcp-session-id": plain.sid })).text(); const n2 = seen();
  gc.abort(); await wait(1300);
  await (await post(LIST, { "mcp-session-id": g.sid })).text(); const n3 = seen();
  check("the sweep keeps a session with an open stream, closes an idle one beside it, and closes the first once its stream ends", gs.status === 200 && n1 === n0 && n2 === n0 + 1 && n3 === n2 + 1, `counts ${n0} ${n1} ${n2} ${n3}`);
}

// 9. in process: error text never leaves by a tool result or a REST log line
{
  const boom = () => Object.assign(new Error("connect ECONNREFUSED synth-db-host.internal:5432 user=synthuser password=synthpw-0123"), { name: "DatabaseError", code: "ECONNREFUSED" });
  const fakeDb = new Proxy({}, { get: () => async () => { throw boom(); } });
  const { registerTools } = await import("./tools.mjs");
  const handlers = new Map();
  const errLines = []; const realError = console.error; console.error = (...a) => errLines.push(a.join(" "));
  let toolResult = null, plainThrown = "", waitText = "", restStatus = 0, restBody = "";
  try {
    registerTools({ tool: (...args) => handlers.set(args[0], args[args.length - 1]) }, fakeDb);
    toolResult = await handlers.get("list_channels")({}, {});
    const plainDb = new Proxy({}, { get: () => async () => { throw new Error("synthetic plain message"); } });
    const h2 = new Map(); registerTools({ tool: (...args) => h2.set(args[0], args[args.length - 1]) }, plainDb);
    try { await h2.get("list_channels")({}, {}); } catch (e) { plainThrown = e.message; }
    const gone = new AbortController(); gone.abort();
    const quietDb = new Proxy({}, { get: () => async () => [] });
    const h3 = new Map(); registerTools({ tool: (...args) => h3.set(args[0], args[args.length - 1]) }, quietDb);
    waitText = (await h3.get("wait_for_reply")({ channel: "x", after_id: 0, instance_id: "w", timeout_seconds: 1e9, poll_interval_seconds: 1e9 }, { signal: gone.signal })).content[0].text;
    const { default: express } = await import("express");
    const { createRestRouter } = await import("./rest-api.mjs");
    const mini = express(); mini.use("/api", express.json(), createRestRouter(fakeDb));
    const srv = await new Promise((res) => { const x = mini.listen(0, "127.0.0.1", () => res(x)); });
    const rr = await fetch(`http://127.0.0.1:${srv.address().port}/api/data/synthetic-secret-key-name`);
    restStatus = rr.status; restBody = await rr.text();
    await new Promise((res) => srv.close(res));
  } finally { console.error = realError; }
  const errText = errLines.join("\n");
  const toolText = toolResult?.content?.[0]?.text || "";
  check("a database error in a tool is answered by kind, never by its message", toolResult?.isError === true && toolText.includes("DatabaseError ECONNREFUSED") && !toolText.includes("synth-db-host") && !toolText.includes("synthpw") && errText.includes("[ERROR] tool list_channels | DatabaseError ECONNREFUSED"));
  check("a plain Error from a tool keeps its message", plainThrown === "synthetic plain message");
  {
    const fkDb = new Proxy({}, { get: () => async () => { throw Object.assign(new Error("FOREIGN KEY constraint failed"), { name: "SqliteError", code: "SQLITE_CONSTRAINT_FOREIGNKEY" }); } });
    const h4 = new Map(); const keep = console.error; console.error = () => {};
    let fkText = "", pgText = "";
    try {
      registerTools({ tool: (...args) => h4.set(args[0], args[args.length - 1]) }, fkDb);
      fkText = (await h4.get("list_channels")({}, {})).content[0].text;
      const pgDb = new Proxy({}, { get: () => async () => { throw Object.assign(new Error("violates foreign key constraint"), { name: "error", code: "23503" }); } });
      const h5 = new Map(); registerTools({ tool: (...args) => h5.set(args[0], args[args.length - 1]) }, pgDb);
      pgText = (await h5.get("list_channels")({}, {})).content[0].text;
    } finally { console.error = keep; }
    check("a constraint error is reported as rejected input, not as a fault to retry", fkText.includes("was rejected") && !fkText.includes("Try again") && pgText.includes("was rejected") && !pgText.includes("Try again"));
    const onceDb = new Proxy({}, { get: (_t, prop) => async () => (prop === "getUnread" ? [{ id: 9, message_type: "message", sender: "other", created_at: "now", content: "synthetic" }] : []) });
    const h6 = new Map(); registerTools({ tool: (...args) => h6.set(args[0], args[args.length - 1]) }, onceDb);
    const onceText = (await h6.get("wait_for_reply")({ channel: "x", after_id: 0, instance_id: "w", timeout_seconds: 0, poll_interval_seconds: 5 }, {})).content[0].text;
    check("wait_for_reply with timeout 0 still looks once", onceText.includes("1 new message(s)"));
    const { logPath } = await import("./rest-api.mjs");
    check("logPath: encoded slashes are split, segments are capped, odd input is safe", logPath("/api/data%2Fsynthetic-secret-key") === "/api/data/..." && logPath("/" + "a".repeat(500)) === "/" + "a".repeat(40) && logPath("/api/%E0%A4%A/x") === "/api/%E0%A4%A/..." && logPath("") === "/" && logPath(undefined) === "/" && logPath("/api/x%0A[AUTH OK] GET /mcp%0D%E2%80%A8y") === "/api/x?[AUTH OK] GET /..." && !/[^\x20-\x7e]/.test(logPath("/a%0Ab%1B[31m%00/c%0Dd%E2%80%A8%C3%A9")));
  }
  check("wait_for_reply: the timeout is capped at 600 s and a caller that has gone ends the wait", waitText.includes("after waiting 600s"));
  check("REST handler error -> 500 with no detail; its log line holds the kind and two path segments", restStatus === 500 && restBody.includes("Internal server error") && !restBody.includes("synth-db-host") && errText.includes("[ERROR] REST GET /api/data/... | DatabaseError ECONNREFUSED") && !errText.includes("synthetic-secret") && !errText.includes("synth-db-host") && !errText.includes("synthpw"));
}

await wait(200);
await stop(s);
const allOut = logs.map((x) => x.out).join("\n");
check("no log of any server process holds part of the key", !allOut.includes(KEY) && !allOut.includes(KEY.slice(0, 12)));
check("no log of any server process holds a stack trace", !/\n\s+at\s.+:\d+:\d+/.test(allOut));
check("unknown session ids are logged, without the id", allOut.includes("[SESSION] POST /mcp with an unknown session id: answered without a session") && !allOut.includes("00000000-0000-4000-8000-000000000000"));
check("parser errors are logged by kind", allOut.includes("[ERROR] POST /mcp"));
} finally {
  for (const x of logs) { if (x.exit === null) { try { x.child.kill("SIGKILL"); } catch {} } }
  await wait(200);
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}

console.log(`\n========================================\nResults: ${passed} passed, ${failed} failed\n========================================`);
process.exit(failed ? 1 : 0);
