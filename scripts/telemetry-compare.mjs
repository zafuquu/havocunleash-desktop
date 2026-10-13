/**
 * A3 — Dual-source telemetry comparison harness (DIAGNOSTIC ONLY).
 *
 *   node scripts/telemetry-compare.mjs [--blob URL] [--hu URL] [--duration S] [--json] [--verbose]
 *
 * Subscribes to both runtimes' SSE streams (event-driven, no polling),
 * normalizes each to the shared semantic shape, and continuously compares:
 *
 *   Blob raw state  → reference normalization  ↘
 *                                              compare → report
 *   HU raw state    → HU normalized state      ↗
 *
 * This tool is diagnostic. It never mutates state, never selects providers,
 * and never writes anywhere. Exit codes: 0 = no blocking mismatch,
 * 1 = mismatch detected, 2 = sources unavailable / not comparable.
 *
 * Comparison happens on NORMALIZED SEMANTIC state (never raw field names),
 * with strict null/zero/unknown separation (A1 contract) and A2 telemetry
 * quality gating (a source that is not HEALTHY/STALE is NOT_COMPARABLE).
 */

/** A2 freshness contract (see services/game-data-runtime/src/gep-capture.ts). */
export const TELEMETRY_FRESHNESS_MS = 330_000;
/** HU health is polled at this low rate only for the A2 telemetry state. */
const HEALTH_POLL_MS = 5_000;
/** A source silent this long is flagged stale in the freshness report. */
const SOURCE_STALE_MS = 15_000;

export const CLASSIFICATIONS = {
  MATCH: "MATCH",
  HU_MISSING: "HU_MISSING",
  BLOB_MISSING: "BLOB_MISSING",
  VALUE_MISMATCH: "VALUE_MISMATCH",
  TYPE_MISMATCH: "TYPE_MISMATCH",
  STALE_HU: "STALE_HU",
  STALE_BLOB: "STALE_BLOB",
  PHASE_MISMATCH: "PHASE_MISMATCH",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  HU_NOT_COMPARABLE: "HU_NOT_COMPARABLE",
  BLOB_NOT_COMPARABLE: "BLOB_NOT_COMPARABLE",
  UNCOMPARABLE: "UNCOMPARABLE",
  POSSIBLE_STATIC_STATE: "POSSIBLE_STATIC_STATE",
};

/** Normalized roundPhase → the scene the overlay is expected to render. */
export function expectedSceneForPhase(roundPhase, sessionPhase) {
  if (sessionPhase === "pregame" || roundPhase === "game_start") return "agent-select";
  if (sessionPhase === "ending" || roundPhase === "game_end" || roundPhase === "matchend") return "post-game";
  if (roundPhase === "shopping" || roundPhase === "buy" || roundPhase === "buy_phase") return "buy-round";
  if (roundPhase === "combat" || roundPhase === "active" || roundPhase === "spike") return "ingame-hud";
  if (roundPhase === "end") return "ingame-hud"; // round-result banner lives inside the HUD scene
  return null;
}

/* --------------------------- value comparison --------------------------- */

/** Missing = null/undefined (A1 contract: unknown is its own state). */
function isMissing(v) {
  return v === null || v === undefined;
}

/** Strict scalar compare. null/undefined never equals a concrete value (§8). */
export function classifyValue(blobValue, huValue) {
  const bMissing = isMissing(blobValue);
  const hMissing = isMissing(huValue);
  if (bMissing && hMissing) return CLASSIFICATIONS.MATCH; // both unknown — agreed absence
  if (bMissing) return CLASSIFICATIONS.BLOB_MISSING;
  if (hMissing) return CLASSIFICATIONS.HU_MISSING;
  const bt = typeof blobValue;
  const ht = typeof huValue;
  if (bt !== ht) return CLASSIFICATIONS.TYPE_MISMATCH; // 1 !== true, 0 !== false (§11)
  if (bt === "object") {
    // Deep type check: {C:1} vs {C:true} is a TYPE_MISMATCH (ability state
    // numeric-vs-boolean conflation, §11/§26-K), not a mere value diff.
    const sig = (v) =>
      Array.isArray(v)
        ? v.map((x) => (x === null ? "null" : typeof x)).join(",")
        : Object.entries(v)
            .map(([k, x]) => `${k}:${x === null ? "null" : typeof x}`)
            .sort()
            .join(",");
    if (sig(blobValue) !== sig(huValue)) return CLASSIFICATIONS.TYPE_MISMATCH;
    return JSON.stringify(blobValue) === JSON.stringify(huValue)
      ? CLASSIFICATIONS.MATCH
      : CLASSIFICATIONS.VALUE_MISMATCH;
  }
  return blobValue === huValue ? CLASSIFICATIONS.MATCH : CLASSIFICATIONS.VALUE_MISMATCH;
}

/* ------------------------------ normalizers ------------------------------ */
/* ------------------------------ normalizers ------------------------------ */

function normalizePlayer(p) {
  if (!p) return null;
  const player = p.player ?? {};
  const identity = player.identity ?? player.name ?? {};
  return {
    playerId: player.playerId ?? player.puuid ?? null,
    name: identity.displayName ?? identity.gameName ?? null,
    teamId: p.teamId ?? null,
    teamIndex: p.teamIndex ?? null,
    agent: p.agent?.name ?? p.agent?.key ?? null,
    agentKey: p.agent?.key ?? null,
    alive: player.isAlive ?? null,
    health: player.health ?? null, // null = unknown (never fabricated)
    shield: player.shield ?? null, // null = unknown (never fabricated)
    shieldType: player.shieldType ?? null,
    credits: player.credits ?? null,
    spentCredits: player.spentCredits ?? null,
    weapon: player.weapon ?? null, // null = unknown (never "Classic")
    abilities: player.abilities ?? null,
    ultPoints: player.ultPoints ?? null,
    ultMax: player.ultMax ?? null,
    hasSpike: player.hasSpike ?? null,
  };
}

function playerKey(np) {
  return np.playerId ?? (np.name ? `name:${String(np.name).split("#")[0].toLowerCase()}` : null);
}

/** Normalize a `valorant_session_snapshot` frame (both dialects). */
export function normalizeSessionFrame(frame) {
  const snap = frame?.snapshot ?? frame ?? {};
  const session = snap.session ?? {};
  const teams = snap.teams ?? session.teams ?? [];
  const players = [];
  for (const team of teams) {
    for (const p of team.players ?? []) {
      const np = normalizePlayer({ ...p, teamId: p.teamId ?? team.teamId });
      if (np) players.push(np);
    }
  }
  return {
    phase: snap.sessionPhase ?? snap.phase ?? null,
    matchId: snap.matchId ?? session.matchId ?? null,
    mapKey: snap.mapKey ?? session.map?.key ?? null,
    mapName: snap.mapName ?? session.map?.name ?? null,
    scene: snap.scene ?? null, // HU runtime publishes the derived scene
    roundPhase: snap.roundPhase ?? (snap.currentRound?.roundPhase ?? null),
    roundNumber: snap.currentRound?.roundNumber ?? null,
    score: snap.score ?? null,
    revision: snap.revision ?? frame?.id ?? null,
    players,
  };
}

/** Normalize a `valorant_score_snapshot` frame (blob dialect: ally/enemy). */
export function normalizeScoreFrame(frame) {
  const score = frame?.score ?? null;
  if (!score) return null;
  // Blob speaks viewer-perspective {ally, enemy}; HU runtime speaks
  // viewer-anchored {blue, red}. Both are exposed as-is — a divergence here
  // (e.g. sides inverted) is exactly what A3 must surface, never silently fix.
  return { blue: score.blue ?? score.ally ?? null, red: score.red ?? score.enemy ?? null };
}
/* ---------------------------- field comparison --------------------------- */

export function compareNormalized(ref, hu, opts = {}) {
  const fields = {};
  const playerFields = [];
  const diagnostics = [];
  const now = opts.now ?? Date.now();

  // Quality gating per §20: a source without live telemetry is NOT_COMPARABLE
  // — per-field mismatches would just enumerate the absence of data.
  const huQuality = hu.telemetryState ?? null;
  const huComparable =
    opts.ignoreQuality === true ||
    huQuality === "HEALTHY" ||
    huQuality === "STALE" ||
    huQuality === null; // null = runtime without A2 health (reference-only mode)
  const blobComparable = ref.updates > 0;

  const gate = (field) => {
    if (!huComparable) return CLASSIFICATIONS.HU_NOT_COMPARABLE;
    if (!blobComparable) return CLASSIFICATIONS.BLOB_NOT_COMPARABLE;
    if (hu.telemetryState === "STALE") return CLASSIFICATIONS.STALE_HU;
    if (ref.stale) return CLASSIFICATIONS.STALE_BLOB;
    return null;
  };

  const put = (field, b, h) => {
    fields[field] = { status: gate(field) ?? classifyValue(b, h), blob: b ?? null, hu: h ?? null };
  };

  // --- match ---
  put("matchId", ref.matchId, hu.matchId);
  put("map", ref.mapKey, hu.mapKey);

  // --- phase (§14, high priority) ---
  if (huComparable && blobComparable) {
    put("matchPhase", ref.phase, hu.phase);
    fields.roundPhase = { status: CLASSIFICATIONS.MATCH, blob: ref.roundPhase ?? null, hu: hu.roundPhase ?? null };
    if (
      ref.roundPhase &&
      hu.roundPhase &&
      String(ref.roundPhase).toLowerCase() !== String(hu.roundPhase).toLowerCase()
    ) {
      fields.roundPhase.status = CLASSIFICATIONS.PHASE_MISMATCH;
    }
  } else {
    put("matchPhase", ref.phase, hu.phase);
    fields.roundPhase = {
      status: gate("roundPhase") ?? CLASSIFICATIONS.UNCOMPARABLE,
      blob: ref.roundPhase ?? null,
      hu: hu.roundPhase ?? null,
    };
  }

  // --- score ---
  put(
    "score",
    ref.score ? `${ref.score.blue}-${ref.score.red}` : null,
    hu.score ? `${hu.score.blue}-${hu.score.red}` : null,
  );

  // --- scene diagnostic (§15) — HU only; expected from its own phase ---
  if (hu.scene != null && hu.roundPhase != null) {
    const expected = expectedSceneForPhase(hu.roundPhase, hu.phase);
    if (expected && expected !== hu.scene) {
      diagnostics.push({
        kind: "SCENE_MISMATCH",
        detail: `HU scene=${hu.scene} but normalized phase ${hu.roundPhase} expects ${expected}`,
      });
      fields.scene = { status: "SCENE_MISMATCH", blob: null, hu: hu.scene, expected };
    } else {
      fields.scene = { status: CLASSIFICATIONS.MATCH, blob: null, hu: hu.scene };
    }
  }

  // --- players (identity matching per §12: playerId, then normalized name) ---
  const huByKey = new Map();
  for (const p of hu.players) {
    const k = playerKey(p);
    if (k) huByKey.set(k, p);
  }
  const refByKey = new Map();
  for (const p of ref.players) {
    const k = playerKey(p);
    if (k) refByKey.set(k, p);
  }
  for (const [key, rp] of refByKey) {
    const hp = huByKey.get(key);
    if (!hp) {
      playerFields.push({ player: rp.name ?? key, field: "roster", status: CLASSIFICATIONS.HU_MISSING });
      continue;
    }
    const cmp = (field, b, h) => {
      const st = gate(field) ?? classifyValue(b, h);
      playerFields.push({ player: rp.name ?? key, field, status: st, blob: b ?? null, hu: h ?? null });
    };
    cmp("agent", rp.agent, hp.agent);
    cmp("alive", rp.alive, hp.alive);
    cmp("health", rp.health, hp.health); // null vs 87 → HU_MISSING (§8/§9)
    cmp("shield", rp.shield, hp.shield); // null vs 0 → HU_MISSING (§8/§9)
    cmp("shieldType", rp.shieldType, hp.shieldType);
    cmp("credits", rp.credits, hp.credits); // null vs 4500 → HU_MISSING (§8)
    cmp("weapon", rp.weapon, hp.weapon); // Vandal vs Classic → VALUE_MISMATCH (§10)
    cmp("abilities", rp.abilities, hp.abilities); // raw form preserved (§11)
    cmp("ultPoints", rp.ultPoints, hp.ultPoints);
    cmp("ultMax", rp.ultMax, hp.ultMax);
    cmp("hasSpike", rp.hasSpike, hp.hasSpike);
    cmp("team", rp.teamId, hp.teamId); // side divergence surfaced, never fixed (§13)
  }
  for (const [key, hp] of huByKey) {
    if (!refByKey.has(key)) {
      playerFields.push({ player: hp.name ?? key, field: "roster", status: CLASSIFICATIONS.BLOB_MISSING });
    }
  }

  // --- continuity (§17/§18): frozen HU snapshot while blob keeps updating ---
  if (hu.telemetryState === "HEALTHY" && blobComparable) {
    const age = now - (hu.lastUpdateAt ?? 0);
    const revStatic = (hu.revisionChanges ?? 0) === 0;
    if (age > 60_000 && revStatic) {
      diagnostics.push({
        kind: "POSSIBLE_STATIC_STATE",
        detail: "HU reports HEALTHY but its snapshot id/revision has not changed while Blob continued updating",
      });
    }
  }
  if (!huComparable && huQuality != null) {
    diagnostics.push({
      kind: "INSUFFICIENT_TELEMETRY",
      detail: `HU telemetry state ${huQuality} — field comparisons gated (NOT_COMPARABLE)`,
    });
  }

  const statuses = [
    ...Object.values(fields).map((f) => f.status),
    ...playerFields.map((f) => f.status),
  ];
  const mismatch = statuses.some((s) =>
    [
      CLASSIFICATIONS.VALUE_MISMATCH,
      CLASSIFICATIONS.TYPE_MISMATCH,
      CLASSIFICATIONS.PHASE_MISMATCH,
      CLASSIFICATIONS.IDENTITY_MISMATCH,
    ].includes(s),
  );
  const anyMissing = statuses.some(
    (s) => s === CLASSIFICATIONS.HU_MISSING || s === CLASSIFICATIONS.BLOB_MISSING,
  );
  return { fields, players: playerFields, diagnostics, mismatch, anyMissing };
}
/* ------------------------------ stream taps ------------------------------ */

/** Parse one SSE chunk into JSON frames (kind lives in the JSON body). */
export function parseSseFrames(chunk) {
  const out = [];
  let i;
  while ((i = chunk.indexOf("\n\n")) >= 0) {
    const fr = chunk.slice(0, i);
    chunk = chunk.slice(i + 2);
    const dl = fr.split("\n").find((x) => x.startsWith("data:"));
    if (!dl) continue;
    try {
      out.push(JSON.parse(dl.slice(5)));
    } catch {
      /* ignore malformed frame */
    }
  }
  return out;
}

/** Consume one runtime's SSE stream, maintaining normalized state. */
export async function tapRuntime(origin, sink, abortSignal) {
  const state = {
    origin,
    phase: null,
    matchId: null,
    mapKey: null,
    scene: null,
    roundPhase: null,
    roundNumber: null,
    score: null,
    revision: null,
    telemetryState: null,
    players: [],
    lastUpdateAt: 0,
    updates: 0,
    revisionChanges: 0,
    factsSeen: {},
    stale: false,
  };
  const res = await fetch(`${origin}/events`, {
    headers: { Accept: "text/event-stream" },
    signal: abortSignal,
  }).catch((err) => {
    // Source offline: report and keep the comparison alive — the CLI marks
    // the source NOT COMPARABLE instead of crashing the whole run.
    sink?.({ type: "offline", state });
    return null;
  });
  if (!res || !res.body) return { state, res: null };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const fr = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const dl = fr.split("\n").find((x) => x.startsWith("data:"));
        if (!dl) continue;
        let body;
        try {
          body = JSON.parse(dl.slice(5));
        } catch {
          continue;
        }
        const kind = body.kind ?? "";
        state.updates += 1;
        state.lastUpdateAt = Date.now();
        if (kind === "valorant_session_snapshot") {
          const n = normalizeSessionFrame(body);
          const revKey = `${n.revision}`;
          if (state.revision !== null && state.revision !== revKey) state.revisionChanges += 1;
          state.revision = revKey;
          state.phase = n.phase;
          state.matchId = n.matchId;
          state.mapKey = n.mapKey;
          state.scene = n.scene;
          state.roundPhase = n.roundPhase ?? state.roundPhase;
          state.roundNumber = n.roundNumber ?? state.roundNumber;
          state.score = n.score ?? state.score;
          state.players = n.players;
          sink?.({ type: "session", state });
        } else if (kind === "valorant_score_snapshot") {
          const n = normalizeScoreFrame(body);
          if (n) state.score = n;
          sink?.({ type: "score", state });
        } else if (kind === "new_info_update" || kind === "new_game_event") {
          const key = body.data?.key ?? "?";
          state.factsSeen[key] = (state.factsSeen[key] ?? 0) + 1;
          if (key === "round_phase") {
            const v = body.data?.value;
            if (typeof v === "string" && v) state.roundPhase = v;
          } else if (key === "round") {
            const n = Number(body.data?.value);
            if (Number.isFinite(n) && n > 0) state.roundNumber = n;
          }
          sink?.({ type: "fact", key, state });
        }
      }
    }
  })().catch(() => {});
  return { state, res };
}

/** Poll /health once and extract the A2 telemetry state (HU runtime only). */
export async function fetchTelemetryState(origin) {
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    const json = await res.json();
    const t = json?.capabilities?.overwolf?.telemetry ?? null;
    return t && typeof t.state === "string" ? { state: t.state, ...t } : null;
  } catch {
    return null;
  }
}
/* --------------------------------- CLI ---------------------------------- */

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
  };
  const has = (name) => args.includes(`--${name}`);
  const blobUrl = opt("blob", "http://127.0.0.1:7413");
  const huUrl = opt("hu", "http://127.0.0.1:7423");
  const durationMs = Number(opt("duration", "120")) * 1000;
  const asJson = has("--json");
  const verbose = has("--verbose");

  const controller = new AbortController();
  const blob = await tapRuntime(blobUrl, verbose ? (e) => console.log(`[blob] ${e.type}`) : null, controller.signal);
  const hu = await tapRuntime(huUrl, verbose ? (e) => console.log(`[hu] ${e.type}${e.key ? ":" + e.key : ""}`) : null, controller.signal);

  const huComparableNow = (huState) => ["HEALTHY", "STALE"].includes(huState?.telemetryState ?? "");

  const report = async () => {
    controller.abort();
    const now = Date.now();
    const ref = {
      ...blob.state,
      updates: blob.state.updates,
      telemetryState:
        blob.state.updates > 0
          ? now - blob.state.lastUpdateAt <= SOURCE_STALE_MS
            ? "HEALTHY"
            : "STALE"
          : "DISCONNECTED",
      stale: now - blob.state.lastUpdateAt > SOURCE_STALE_MS,
    };
    const huHealth = await fetchTelemetryState(huUrl);
    const huN = { ...hu.state, telemetryState: hu.state.telemetryState ?? huHealth?.state ?? null };
    const result = compareNormalized(ref, huN, { now });

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            blob: {
              endpoint: blobUrl,
              state: ref.telemetryState,
              updates: ref.updates,
              lastUpdateAt: ref.lastUpdateAt,
              factsSeen: ref.factsSeen,
            },
            hu: {
              endpoint: huUrl,
              state: huN.telemetryState,
              updates: huN.updates,
              lastUpdateAt: huN.lastUpdateAt,
              revisionChanges: huN.revisionChanges,
              factsSeen: huN.factsSeen,
              scene: huN.scene,
            },
            fields: result.fields,
            players: result.players,
            diagnostics: result.diagnostics,
            mismatch: result.mismatch,
            anyMissing: result.anyMissing,
          },
          null,
          2,
        ),
      );
    } else {
      console.log("=".repeat(50));
      console.log("HU TELEMETRY COMPARISON");
      console.log("=".repeat(50));
      for (const [label, st, url] of [["Blob", ref, blobUrl], ["HU", huN, huUrl]]) {
        console.log(`${label}:`);
        console.log(`  endpoint: ${url}`);
        console.log(`  state: ${st.telemetryState ?? "unknown"}`);
        console.log(
          `  updates: ${st.updates} (last ${st.lastUpdateAt ? Math.round((now - st.lastUpdateAt) / 1000) + "s ago" : "never"})`,
        );
        console.log(`  facts: ${JSON.stringify(st.factsSeen)}`);
      }
      console.log("-".repeat(50));
      console.log("MATCH STATE");
      console.log("-".repeat(50));
      for (const [k, f] of Object.entries(result.fields)) {
        console.log(
          `${k.padEnd(16)} ${f.status}${verbose ? `  blob=${JSON.stringify(f.blob)} hu=${JSON.stringify(f.hu)}` : ""}`,
        );
      }
      console.log("-".repeat(50));
      console.log("PLAYER DATA");
      console.log("-".repeat(50));
      if (result.players.length === 0) console.log("  (no comparable players)");
      for (const f of result.players) {
        console.log(
          `  ${String(f.player).padEnd(20)} ${f.field.padEnd(14)} ${f.status}${verbose ? `  blob=${JSON.stringify(f.blob)} hu=${JSON.stringify(f.hu)}` : ""}`,
        );
      }
      console.log("-".repeat(50));
      console.log("DIAGNOSTICS");
      console.log("-".repeat(50));
      if (result.diagnostics.length === 0) console.log("  (none)");
      for (const d of result.diagnostics) console.log(`${d.kind}: ${d.detail}`);
      console.log(`HU revision changes: ${huN.revisionChanges}`);
      const overall = !huComparableNow(huN) || ref.updates === 0
        ? "NOT COMPARABLE"
        : result.mismatch
          ? "FAIL (mismatch)"
          : result.anyMissing
            ? "PARTIAL (missing fields)"
            : "PASS";
      console.log(`OVERALL: ${overall}`);
    }
    const notComparable = !huComparableNow(huN) || blob.state.updates === 0;
    process.exitCode = notComparable ? 2 : result.mismatch || result.anyMissing ? 1 : 0;
  };

  setTimeout(() => void report(), durationMs);
}
// __END__



