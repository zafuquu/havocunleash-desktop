/**
 * Headless integration harness.
 *   node scripts/integration.mjs http://127.0.0.1:7413 30000
 * Connects GameDataRuntimeClient -> ValProjectionSession against any runtime,
 * printing applied projection states and a final snapshot summary.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { GameDataRuntimeClient } = require("../apps/desktop/dist/main/runtimeClient.js");
const { ValProjectionSession } = require("../apps/desktop/dist/main/projection.js");

const origin = process.argv[2] ?? "http://127.0.0.1:7423";
const durationMs = Number(process.argv[3] ?? 25000);

const projection = new ValProjectionSession();
let changes = 0;
let lastState = null;

projection.subscribe((state) => {
  changes += 1;
  lastState = state;
  if (changes <= 6 && changes % 2 === 1) {
    console.log(
      `[change ${changes}] rev=${state.revision} phase=${state.sessionPhase} map=${state.mapKey} ` +
        `R${state.round.number}/${state.round.phase} score=${state.score.blue}-${state.score.red} ` +
        `spike=${state.spike ?? "-"} kf=${state.killfeed.length} viewer=${state.viewerRole}`,
    );
  }
});

const client = new GameDataRuntimeClient(origin, {
  onFact: ({ key, value }) => projection.applyFact(key, value),
  onScore: ({ blue, red }) => projection.applyScore(blue, red),
  onSnapshot: (snap) => projection.applySnapshot(snap),
  onGameState: (f) => console.log(`[game-state] ${f.kind}`),
  onStatus: (s) => console.log(`[status] connected=${s.connected}${s.reason ? " " + s.reason : ""}`),
});

setTimeout(() => {
  client.stop();
  const snap = projection.snapshotValue();
  console.log("---------- SUMMARY ----------");
  console.log(JSON.stringify({ ...snap, killfeed: `<${snap.killfeed.length}>` }, null, 2));
  process.exit(changes > 0 || snap.revision >= 0 ? 0 : 1);
}, durationMs).unref();

client.start().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
