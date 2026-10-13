// Local mock of the replica bridge (server/game-bridge.mjs) for CI smoke tests.
// Never touches real Supabase. Emulates tRPC + the Socket.IO producer
// handshake and records game-data:fallback snapshots for verification.
const http = require("node:http");
const { Server } = require("socket.io");

const PORT = Number(process.env.MOCK_BRIDGE_PORT || 7190);
const PATH = "/api/socket/io";
const rooms = [{ roomId: "TEST", roomName: "Mock Room", roomGame: "VAL", overlayId: "ingame-hud" }];
const received = [];
let ticket = "mock-ticket-000";

function sendJson(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function isSocketPath(p) {
  return p === PATH || p.startsWith(PATH + "/");
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  console.log("[mock-bridge]", req.method, pathname);
  if (isSocketPath(pathname)) return; // socket.io owns these

  if (pathname === "/api/trpc/realtime.desktopRooms") {
    return sendJson(res, [{ result: { data: { json: rooms } } }]);
  }
  if (pathname === "/api/trpc/realtime.desktopProducerTicket") {
    ticket = "ticket-" + Math.random().toString(36).slice(2);
    return sendJson(res, [{ result: { data: { json: { ticket, realtimeOrigin: "http://127.0.0.1:" + PORT, expiresAt: new Date(Date.now() + 300000).toISOString() } } } }]);
  }
  if (pathname === "/api/trpc/realtime.desktopRequestAccess") {
    return sendJson(res, [{ result: { data: { json: { requestId: "req-1", status: "accepted" } } } }]);
  }
  if (pathname === "/electron/token") {
    return sendJson(res, { token: ticket, user: { id: "dev-mock", email: "dev@mock", name: "Mock", image: null } });
  }
  if (pathname === "/api/auth/get-session") {
    return sendJson(res, { session: { id: "dev-mock" }, user: { id: "dev-mock", email: "dev@mock", name: "Mock", image: null } });
  }
  if (pathname === "/health") return sendJson(res, { ok: true });
  if (pathname === "/received") return sendJson(res, received);
  res.writeHead(404); res.end("not found");
});

const io = new Server(server, { path: PATH, cors: { origin: "*" } });
io.use((socket, next) => {
  // The desktop producer authenticates with auth:{ticket} (producer.ts);
  // accept both spellings so the mock mirrors the real bridge.
  const a = socket.handshake.auth || {};
  next(a.ticket || a.token ? undefined : new Error("unauthorized"));
});
io.on("connection", (socket) => {
  console.log("[mock-bridge] socket connected", socket.id);
  socket.on("game-data:producer:claim", (payload, ack) => {
    console.log("[mock-bridge] claim protocolVersion=", payload && payload.protocolVersion);
    const ok = payload && payload.protocolVersion === 3;
    if (typeof ack === "function") {
      ack(ok
        ? { ok: true, broadcastSessionId: "bs-1", producerSessionId: "ps-1", protocolVersion: 3, resumeGrant: "rg", dashboard: { id: "b" }, disposition: "started", mapVeto: null }
        : { ok: false, reason: "protocol_mismatch" });
    }
  });
  socket.on("game-data:fallback", (msg) => {
    console.log("[mock-bridge] fallback", msg && msg.kind, JSON.stringify(msg && msg.game && msg.game.state && msg.game.state.gameScore));
    // Record the FULL game snapshot so the E2E harness can assert the exact
    // contract the site popout consumes (players/teams/roundPhase/scene).
    received.push({ kind: msg && msg.kind, game: msg && msg.game, t: Date.now() });
  });
  socket.on("game-data:producer:stop", (_p, ack) => { if (typeof ack === "function") ack({ ok: true }); });
});

server.listen(PORT, () => {
  console.log("[mock-bridge] ready path=" + PATH + " port=" + PORT);
  setInterval(() => {
    const last = received[received.length - 1];
    console.log("[mock-bridge] recv=" + received.length + " last=" + JSON.stringify(last && last.game && last.game.state && last.game.state.gameScore));
  }, 8000);
});