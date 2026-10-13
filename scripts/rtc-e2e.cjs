/**
 * WebRTC lane E2E - exercises the REAL ProducerClient (with its RtcPeerDelivery)
 * against the REAL bridge (game-bridge.mjs). Success = bridge log shows
 * "RTC: game-bootstrap received" AND "RTC: game-event".
 *   node scripts/rtc-e2e.cjs [bridgePath] [port]
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const bridgePath =
  process.argv[2] ?? path.join(repoRoot, "..", "HU-bridge-main", "game-bridge.mjs");
const port = Number(process.argv[3] ?? 7191);

if (!fs.existsSync(bridgePath)) {
  console.error(`bridge not found at ${bridgePath}`);
  process.exit(2);
}

const { ProducerClient } = require("../apps/desktop/dist/main/producer.js");
const { TrpcClient } = require("../apps/desktop/dist/main/trpc.js");

const bridge = spawn(process.execPath, [bridgePath], {
  env: { ...process.env, PORT: String(port), GAME_BRIDGE_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeLog = [];
bridge.stdout.on("data", (d) => bridgeLog.push(d.toString()));
bridge.stderr.on("data", (d) => bridgeLog.push(d.toString()));

const saw = (needle) => bridgeLog.some((l) => l.includes(needle));

async function main() {
  const origin = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`${origin}/healthz`).then(() => true).catch(() => false);
  }
  if (!up) throw new Error("bridge never came up");
  console.log("[e2e] bridge up at", origin);

  const trpc = new TrpcClient(origin);
  const ticket = await trpc.desktopProducerTicket({
    roomId: "TEST",
    roomName: "E2E Room",
    roomGame: "VAL",
  });
  console.log("[e2e] ticket issued");

  const producer = new ProducerClient(origin);
  const ack = await producer.connect(ticket.ticket, {
    roomId: "TEST",
    roomName: "E2E Room",
    roomGame: "VAL",
  });
  if (!ack.ok) throw new Error(`claim rejected: ${JSON.stringify(ack)}`);
  console.log("[e2e] claimed as", ack.producerSessionId?.slice(0, 8));

  const wait = (needle) =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const tick = () => {
        if (saw(needle)) return resolve();
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for "${needle}"`));
        setTimeout(tick, 300);
      };
      tick();
    });
  await wait("RTC: answer sent");
  await new Promise((r) => setTimeout(r, 1500));

  const game = {
    gameId: 21640,
    state: {
      leftTeam: { name: "Team A", gameScore: 5, seriesScore: 0 },
      rightTeam: { name: "Team B", gameScore: 3, seriesScore: 0 },
      currentRound: { roundNumber: 9, roundPhase: "combat" },
      players: [{ playerId: "Foo#BAR", name: "Foo", agentName: "Jett", isAlive: true, kills: 3 }],
      gameScore: { left: 5, right: 3 },
      scene: "ingame-hud",
      roundPhase: "combat",
      phaseStartedAt: Date.now(),
      bombPlanted: false,
      match: { winner: null, mvp: null },
      roundEnd: null,
    },
  };
  producer.publishSnapshot(game);
  producer.publishEvent({ type: "roundWin", data: { winType: "ace" } });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (saw("RTC: game-bootstrap received") && saw("RTC: game-event")) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const ok = saw("RTC: game-bootstrap received") && saw("RTC: game-event");
  console.log("[e2e] bootstrap received:", saw("RTC: game-bootstrap received"));
  console.log("[e2e] event received:", saw("RTC: game-event"));
  console.log("[e2e] channel open seen:", saw("datachannel opened"));

  producer.stop().catch(() => {});
  bridge.kill();

  if (ok) {
    console.log("[e2e] PASS - WebRTC lane delivered frames end to end");
    process.exit(0);
  }
  console.log("[e2e] FAIL - bridge log tail:");
  console.log(bridgeLog.slice(-40).join(""));
  process.exit(1);
}

main().catch((error) => {
  console.error("[e2e] error:", error);
  console.log(bridgeLog.slice(-40).join(""));
  bridge.kill();
  process.exit(1);
});
