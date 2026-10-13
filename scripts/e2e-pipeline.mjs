/**
 * End-to-end pipeline test — mock-driven, no Valorant / no Electron GUI needed.
 *
 * Traces ONE live game-state update through every boundary of the real stack:
 *
 *   [mock GEP] -> game-data-runtime :7423 (/health + /events SSE)
 *              -> desktop pipeline (GameDataRuntimeClient -> ValProjectionSession)
 *                 -> HudServer :7104 (/api/state + /ws push)   [real class]
 *                 -> toGameSnapshot -> ProducerClient (Socket.IO)
 *              -> mock-bridge :7190 (records game-data:fallback snapshots)
 *
 * Asserts the exact contract the site popout consumes:
 *   state.players[].name, leftTeam/rightTeam, roundPhase, isAgentSelectPhase,
 *   scene, currentRound.roundNumber — plus live scene transitions.
 *
 * Usage: node scripts/e2e-pipeline.mjs [durationMs=55000]
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const RUNTIME_PORT = 7425; // 7423 is the live desktop's runtime
const HUD_PORT = 7105; // 7103 is the live desktop's HUD server
const BRIDGE_PORT = 7191; // 7190 is the CI mock-bridge port
const durationMs = Number(process.argv[2] ?? 55_000);

const results = [];
function boundary(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${name}] ${detail}`);
}

const children = [];
function spawnChild(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}!] ${d}`));
  children.push(child);
  return child;
}

async function waitHealthy(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(700) });
      if (res.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ---------- 1. start mock-bridge + runtime ----------
spawnChild("bridge", process.execPath, ["scripts/mock-bridge.cjs"], { MOCK_BRIDGE_PORT: String(BRIDGE_PORT) });
spawnChild("runtime", process.execPath, ["services/game-data-runtime/dist/server.js"], {
  PORT: String(RUNTIME_PORT),
  HAVOC_SOURCE: "mock",
  HAVOC_DEBUG_PIPELINE: "1",
});

const runtimeOk = await waitHealthy(`http://127.0.0.1:${RUNTIME_PORT}/health`);
boundary("1-runtime-health", runtimeOk, `GET :${RUNTIME_PORT}/health`);
const bridgeOk = await waitHealthy(`http://127.0.0.1:${BRIDGE_PORT}/health`);
boundary("2-bridge-up", bridgeOk, `GET :${BRIDGE_PORT}/health`);

// ---------- 2. real desktop pipeline classes ----------
const { GameDataRuntimeClient } = require("../apps/desktop/dist/main/runtimeClient.js");
const { ValProjectionSession } = require("../apps/desktop/dist/main/projection.js");
const { HudServer } = require("../apps/desktop/dist/main/hudServer.js");
const { toGameSnapshot } = require("../apps/desktop/dist/main/snapshot.js");
const { ProducerClient } = require("../apps/desktop/dist/main/producer.js");

const projection = new ValProjectionSession();
const hudServer = new HudServer(HUD_PORT, path.join(root, "apps", "hud", "public"));
await hudServer.start();
boundary("3-hudserver-up", true, `listening :${HUD_PORT} (/api/state + /ws)`);

const state = {
  sseConnected: 0,
  facts: 0,
  snapshots: 0,
  lastApiState: null,
  wsFrames: 0,
  scenesSeen: new Set(),
};
let producer = null;

projection.subscribe((hudState) => {
  // Boundary: normalized game state -> overlay (WS push) + bridge (snapshot).
  hudServer.publish(hudState);
  if (hudState.scene) state.scenesSeen.add(hudState.scene);
  if (producer) producer.publishSnapshot(toGameSnapshot(hudState));
});

// Ticket from the mock bridge's tRPC endpoint, then the real producer client.
const ticketUrl =
  `http://127.0.0.1:${BRIDGE_PORT}/api/trpc/realtime.desktopProducerTicket` +
  `?input=${encodeURIComponent(JSON.stringify({ "0": { json: { roomId: "TEST" } } }))}`;
const ticketRes = await (await fetch(ticketUrl)).json();
const ticket = ticketRes?.[0]?.result?.data?.json?.ticket ?? null;
boundary("4-bridge-auth", !!ticket, ticket ? "producer ticket issued" : "no ticket");

producer = new ProducerClient(`http://127.0.0.1:${BRIDGE_PORT}`);
await producer.connect(ticket, { roomId: "TEST", roomName: "Mock Room", roomGame: "VAL" });
boundary("5-producer-claimed", producer.sessionId !== null, `producerSessionId=${producer.sessionId}`);

const client = new GameDataRuntimeClient(`http://127.0.0.1:${RUNTIME_PORT}`, {
  onFact: ({ key, value }) => {
    state.facts += 1;
    projection.applyFact(key, value);
  },
  onScore: ({ blue, red }) => projection.applyScore(blue, red),
  onSnapshot: (snap) => {
    state.snapshots += 1;
    projection.applySnapshot(snap);
  },
  onGameState: () => {},
  onStatus: (s) => { if (s.connected) state.sseConnected += 1; },
});

// WS probe: exactly what the real OBS overlay page receives.
const ws = new WebSocket(`ws://127.0.0.1:${HUD_PORT}/ws`);
ws.on("message", () => { state.wsFrames += 1; });

client.start().catch((e) => console.error("client fatal:", e));

// ---------- 3. run the mock match & poll /api/state ----------
const apiPoll = setInterval(async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${HUD_PORT}/api/state`);
    state.lastApiState = await res.json();
  } catch { /* hud server not ready */ }
}, 500);

console.log(`\nRunning mock match for ${Math.round(durationMs / 1000)}s...\n`);
await new Promise((r) => setTimeout(r, durationMs));
clearInterval(apiPoll);

// ---------- 4. assertions ----------
const api = state.lastApiState;
boundary("6-sse-stream", state.snapshots > 0, `bootstrap snapshots=${state.snapshots} facts=${state.facts} connects=${state.sseConnected}`);
boundary(
  "7-api-state-data",
  !!api && (api.roster?.length ?? 0) > 0 && api.round?.number > 0 && api.scene != null,
  api ? `roster=${api.roster.length} R${api.round.number}/${api.round.phase} scene=${api.scene} score=${api.score.blue}-${api.score.red}` : "no /api/state",
);
boundary("8-ws-push", state.wsFrames > 0, `${state.wsFrames} frames pushed to overlay WS client`);
boundary(
  "9-scene-switching",
  state.scenesSeen.size >= 2,
  `scenes observed: [${[...state.scenesSeen].join(", ")}]`,
);

let received = [];
try {
  received = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/received`)).json();
} catch { /* bridge probe failed */ }
const withGame = received.filter((r) => r.game?.state);
const lastGame = withGame[withGame.length - 1]?.game ?? null;
const st = lastGame?.state ?? null;
const popoutOk =
  !!st &&
  (st.players?.length ?? 0) > 0 &&
  st.players.every((p) => typeof p.name === "string" && p.name.length > 0) &&
  !!st.leftTeam && !!st.rightTeam &&
  ["shopping", "combat", "end", "unknown"].includes(String(st.roundPhase)) &&
  ["agent-select", "buy-round", "ingame-hud", "post-game"].includes(String(st.scene)) &&
  (st.currentRound?.roundNumber ?? 0) > 0;
boundary(
  "10-bridge-snapshot-popout-contract",
  popoutOk,
  st
    ? `published=${withGame.length} players=${st.players.length} teams=${!!st.leftTeam && !!st.rightTeam} roundPhase=${st.roundPhase} scene=${st.scene} round=${st.currentRound?.roundNumber}`
    : "no game snapshot reached the bridge",
);

console.log("\n---------- SAMPLE PUBLISHED SNAPSHOT (site popout contract) ----------");
console.log(JSON.stringify(lastGame, null, 2).slice(0, 2200));

// ---------- 5. cleanup ----------
client.stop();
producer.stop();
try { ws.close(); } catch { /* ignore */ }
for (const c of children) c.kill();
const failed = results.filter((r) => !r.ok);
console.log(`\n========== E2E RESULT: ${results.length - failed.length}/${results.length} boundaries passed ==========`);
process.exit(failed.length === 0 ? 0 : 1);

