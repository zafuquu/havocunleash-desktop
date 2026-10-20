/**
 * REA parity (BlobDesktop reference) — bridge surface items the reference
 * defines and the original app uses, verified against the compiled dist.
 *
 *  1. realtime.desktopCancelAccess exists and POSTs the requestId.
 *  2. awaitRoomAccess polls "pending" until "accepted" (original renderer
 *     polls every 5s; we default to the same cadence, shortened here).
 *  3. awaitRoomAccess cancels the request when approval never arrives.
 *  4. rooms.getLimitsOfRoom passes {roomId} (reference signature).
 *  5. HAVOC_APP_WINDOW config (hidden/visible/overlay, default visible).
 *  6. HAVOC_APP_PORT alias for the HUD port (reference name).
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const { TrpcClient } = await import("../dist/main/trpc.js");
const { loadConfig } = await import("../dist/main/config.js");

/* --------------------------- bridge stub (tRPC) --------------------------- */

const seen = { statusCalls: 0, cancels: [], limitsInputs: [] };
let statusSequence = ["pending", "pending", "accepted"];

function trpcOk(json) {
  return JSON.stringify([{ result: { data: { json } } }]);
}

let server;
let origin;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && url.pathname === "/api/trpc/realtime.desktopRequestStatus") {
      seen.statusCalls += 1;
      const status = statusSequence.length > 1 ? statusSequence.shift() : statusSequence[0];
      return send([{ result: { data: { json: { requestId: "req-1", status } } } }]);
    }
    if (req.method === "POST" && url.pathname === "/api/trpc/realtime.desktopCancelAccess") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          seen.cancels.push(JSON.parse(body)["0"]?.json?.requestId ?? null);
        } catch {
          seen.cancels.push(null);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(trpcOk(null));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/trpc/rooms.getLimitsOfRoom") {
      const input = url.searchParams.get("input");
      try {
        seen.limitsInputs.push(JSON.parse(input)["0"]?.json ?? null);
      } catch {
        seen.limitsInputs.push(null);
      }
      return send([{ result: { data: { json: { specialLimits: null } } } }]);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

/* --------------------------------- tests --------------------------------- */

test("awaitRoomAccess polls through pending to accepted", async () => {
  seen.statusCalls = 0;
  statusSequence = ["pending", "pending", "accepted"];
  const trpc = new TrpcClient(origin);
  const status = await trpc.awaitRoomAccess("req-1", { intervalMs: 10, timeoutMs: 5_000 });
  assert.equal(status.status, "accepted");
  assert.equal(seen.statusCalls, 3);
  assert.deepEqual(seen.cancels, []); // success must NOT cancel
});

test("awaitRoomAccess cancels the request when approval never arrives", async () => {
  seen.statusCalls = 0;
  seen.cancels = [];
  statusSequence = ["pending"];
  const trpc = new TrpcClient(origin);
  const status = await trpc.awaitRoomAccess("req-2", { intervalMs: 10, timeoutMs: 40 });
  assert.equal(status.status, "pending");
  assert.deepEqual(seen.cancels, ["req-2"]);
});

test("getLimitsOfRoom sends {roomId} like the reference gateway", async () => {
  seen.limitsInputs = [];
  const trpc = new TrpcClient(origin);
  await trpc.getLimitsOfRoom("ALPHA");
  assert.deepEqual(seen.limitsInputs, [{ roomId: "ALPHA" }]);
});

/* ------------------------------ config parity ----------------------------- */

test("HAVOC_APP_WINDOW defaults to visible (HU show-at-boot behaviour)", () => {
  assert.equal(loadConfig({ HAVOC_CONFIG: path.join(os.tmpdir(), "hu-absent-config.json") }).appWindow, "visible");
});

test("HAVOC_APP_WINDOW=hidden is honoured", () => {
  assert.equal(
    loadConfig({ HAVOC_CONFIG: path.join(os.tmpdir(), "hu-absent-config.json"), HAVOC_APP_WINDOW: "hidden" }).appWindow,
    "hidden",
  );
});

test("config-file appWindow is honoured; explicit env wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-rea-parity-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ appWindow: "overlay" }), "utf8");
  try {
    assert.equal(loadConfig({ HAVOC_CONFIG: file }).appWindow, "overlay");
    assert.equal(loadConfig({ HAVOC_CONFIG: file, HAVOC_APP_WINDOW: "visible" }).appWindow, "visible");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid HAVOC_APP_WINDOW is rejected by the schema", () => {
  assert.throws(() =>
    loadConfig({ HAVOC_CONFIG: path.join(os.tmpdir(), "hu-absent-config.json"), HAVOC_APP_WINDOW: "banana" }),
  );
});

test("HAVOC_APP_PORT aliases the HUD port (reference name)", () => {
  const cfg = loadConfig({ HAVOC_CONFIG: path.join(os.tmpdir(), "hu-absent-config.json"), HAVOC_APP_PORT: "7109" });
  assert.equal(cfg.hudPort, 7109);
  assert.equal(cfg.hudOrigin, "http://127.0.0.1:7109");
});

test("HAVOC_HUD_PORT wins over HAVOC_APP_PORT; default stays 7103", () => {
  const env = { HAVOC_CONFIG: path.join(os.tmpdir(), "hu-absent-config.json") };
  assert.equal(loadConfig(env).hudPort, 7103);
  assert.equal(loadConfig({ ...env, HAVOC_HUD_PORT: "7111", HAVOC_APP_PORT: "7109" }).hudPort, 7111);
});