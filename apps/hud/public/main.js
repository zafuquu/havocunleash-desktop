/** HUD consumer: connects to /ws (falls back to /api/state polling) and renders. */
(() => {
  const qs = new URLSearchParams(location.search);
  const usePolling = qs.get("mode") === "overlay" && false; // WS works in overlay too
  const debug = qs.get("debug") === "1" || qs.get("debug") === "true";

  const el = {
    scoreBlue: document.getElementById("score-blue"),
    scoreRed: document.getElementById("score-red"),
    roundChip: document.getElementById("round-chip"),
    roundTimer: document.getElementById("round-timer"),
    spike: document.getElementById("spike-banner"),
    killfeed: document.getElementById("killfeed"),
    pipsBlue: document.getElementById("pips-blue"),
    pipsRed: document.getElementById("pips-red"),
    rosters: document.getElementById("rosters"),
    rosterBlue: document.getElementById("roster-blue"),
    rosterRed: document.getElementById("roster-red"),
    spectator: document.getElementById("spectator-badge"),
    mapChip: document.getElementById("map-chip"),
    root: document.getElementById("root"),
    debug: document.getElementById("pipeline-debug"),
  };

  // Standard Valorant phase lengths (seconds) used to derive the round timer.
  const PHASE_SECONDS = { shopping: 30, combat: 100, end: 5 };

  let renderedSeq = new Set();
  let liveSeq = 0;
  let framesReceived = 0;
  let wsConnected = false;
  let lastRoundState = null;

  const debugLog = (msg) => {
    if (!debug) return;
    console.debug("[hud]", msg);
  };

  const updateDebugLine = () => {
    if (!debug || !el.debug) return;
    el.debug.style.display = "block";
    el.debug.textContent =
      `ws=${wsConnected ? "on" : "off"} frames=${framesReceived} scene=${el.root?.dataset.scene || "-"}`;
  };

  /** mm:ss countdown; switches to a 45s spike countdown after a plant. */
  let lastSpikePlanted = false;
  function renderTimer(round, spikePlanted) {
    if (!el.roundTimer) return;
    const phase = round?.phase ?? "unknown";
    const startedAt = round?.phaseStartedAt ?? null;
    if (spikePlanted && round?.spikePlantedAt) {
      const remaining = Math.max(0, 45 - Math.floor((Date.now() - round.spikePlantedAt) / 1000));
      el.roundTimer.textContent = `0:${String(remaining).padStart(2, "0")}`;
      el.roundTimer.classList.add("urgent");
      return;
    }
    const duration = PHASE_SECONDS[phase];
    if (!startedAt || !duration || phase === "unknown") {
      el.roundTimer.textContent = "--:--";
      el.roundTimer.classList.remove("urgent");
      return;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const remaining = Math.max(0, duration - elapsed);
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    el.roundTimer.textContent = `${m}:${String(s).padStart(2, "0")}`;
    el.roundTimer.classList.toggle("urgent", remaining <= 10 && remaining > 0);
  }

  /** Group roster into blue/red by teamIndex first, then teamId; no balancing. */
  function splitRoster(roster) {
    const blue = [];
    const red = [];
    for (const p of roster ?? []) {
      const idx = typeof p.teamIndex === "number" ? p.teamIndex : null;
      const tid = String(p.teamId ?? "").toLowerCase();
      const isBlue = idx === 0 || tid === "blue";
      const isRed = idx === 1 || tid === "red";
      if (isBlue) blue.push(p);
      else if (isRed) red.push(p);
      else if (blue.length <= red.length) blue.push(p);
      else red.push(p);
    }
    return { blue, red };
  }

  function renderRosterRow(p, viewerName) {
    // The relay carries no is_local flag on roster entries: `viewerName` is the
    // link between the viewer and their row (and therefore their own ability
    // charges, which only the local player reports).
    const isMe = !!viewerName && p.displayName === viewerName;
    const row = document.createElement("div");
    row.className = "r-row" + (p.isAlive === false ? " dead" : "") + (isMe ? " me" : "");
    if (p.agentIcon) {
      const img = document.createElement("img");
      img.className = "r-agent-img";
      img.src = p.agentIcon;
      img.alt = "";
      img.loading = "lazy";
      row.append(img);
    }
    const name = span((p.displayName ?? "?").split("#")[0], "r-name");
    const agent = span(p.agentName ?? "", "r-agent");
    row.append(name, agent);
    if (isMe) row.append(span("YOU", "r-you"));
    // Ability charges (C/Q/E/X bought state).
    const abil = p.abilityState;
    if (abil && typeof abil === "object") {
      const box = document.createElement("span");
      box.className = "r-abils";
      for (const slot of ["C", "Q", "E", "X"]) {
        box.append(span(slot, `abil ${abil[slot] ? "on" : "off"}`));
      }
      row.append(box);
    }
    // Shield + health chip (when the provider reports them).
    if (p.shield != null && p.shield > 0) row.append(span(String(p.shield), "r-shield"));
    // Stat columns render only when the provider supplies them, so the
    // pregame/agent-select roster stays clean.
    const hasStats =
      p.kills != null || p.deaths != null || p.credits != null || p.ultPoints != null;
    if (hasStats) {
      row.append(span(`${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`, "r-kda"));
      if (p.ultPoints != null) {
        row.append(span(`${p.ultPoints}/${p.ultMax ?? "?"}`, "r-ult"));
      }
      if (p.credits != null) row.append(span(String(p.credits), "r-credits"));
      if (p.hasSpike) row.append(span("SPIKE", "r-spike"));
    }
    return row;
  }

  /** Render the team rosters; returns the split (or null when roster is empty). */
  function renderRosters(roster, viewerName) {
    const { blue, red } = splitRoster(roster);
    const hasRoster = blue.length + red.length > 0;
    if (el.rosters) el.rosters.classList.toggle("hidden", !hasRoster);
    if (!hasRoster) return null;
    if (el.rosterBlue) {
      el.rosterBlue.innerHTML = "";
      for (const p of blue) el.rosterBlue.append(renderRosterRow(p, viewerName));
    }
    if (el.rosterRed) {
      el.rosterRed.innerHTML = "";
      for (const p of red) el.rosterRed.append(renderRosterRow(p, viewerName));
    }
    return { blue, red };
  }

  /** Alive pips: roster-derived counts when present, static 5 otherwise. */
  function renderPipsFromRoster(split) {
    if (!split) {
      renderPips(el.pipsBlue, "on-blue", 5);
      renderPips(el.pipsRed, "on-blue", 5);
      return;
    }
    const alive = (list) => list.filter((p) => p.isAlive !== false).length;
    // Placeholder 5s only when no roster exists yet; real alive counts after.
    const hasRoster = split.blue.length + split.red.length > 0;
    renderPips(el.pipsBlue, "on-blue", hasRoster ? Math.min(5, alive(split.blue)) : 5);
    renderPips(el.pipsRed, "on-red", hasRoster ? Math.min(5, alive(split.red)) : 5);
  }

  function render(state) {
    if (!state || typeof state !== "object" || state.revision === -1) return;
    framesReceived += 1;

    el.scoreBlue.textContent = String(state.score?.blue ?? 0);
    el.scoreRed.textContent = String(state.score?.red ?? 0);

    const phase = state.round?.phase ?? "unknown";
    const num = state.round?.number ?? 0;
    const session = state.sessionPhase ?? "idle";
    el.roundChip.textContent =
      session !== "live"
        ? `menu / ${session}`
        : num > 0
          ? `R${num} · ${phase}`
          : "connecting…";
    lastSpikePlanted = state.spike === "planted";
    renderTimer(state.round, lastSpikePlanted);
    if (el.mapChip) el.mapChip.textContent = state.mapName ?? "";

    // Scene switch: the projection's derived scene drives which blocks show
    // (same scene contract the site popout consumes).
    const scene = state.scene ?? "";
    if (el.root) el.root.dataset.scene = scene;
    // Spectator/observer indicator.
    const role = (state.viewerRole ?? "").toLowerCase();
    const spectating = role === "observer" || role === "spectator" || role === "coach";
    if (el.spectator) el.spectator.classList.toggle("hidden", !spectating);

    el.spike.classList.toggle("hidden", state.spike !== "planted");

    // Killfeed: only add entries we have not rendered yet.
    for (const kf of state.killfeed ?? []) {
      if (renderedSeq.has(kf.seq)) continue;
      renderedSeq.add(kf.seq);
      if (kf.seq < liveSeq) continue; // backfill after reconnect -> skip stale
      const div = document.createElement("div");
      div.className = "kf-entry";
      div.innerHTML = "";
      const a = span(kf.attacker, "attacker");
      const w = span(`[${kf.weapon}]`, "weapon");
      const v = span(kf.victim, "victim");
      div.append(a, w, v);
      if (kf.modifier && kf.modifier !== "bodyshot") {
        div.append(span(kf.modifier.toUpperCase(), "mod"));
      }
      el.killfeed.prepend(div);
      setTimeout(() => div.remove(), 7500);
    }
    liveSeq = Math.max(liveSeq, ...((state.killfeed ?? []).map((k) => k.seq) || [0]));

    // Rosters + roster-driven alive pips (static 5 fallback when empty).
    const split = renderRosters(state.roster, state.viewerName);
    renderPipsFromRoster(split);
    // Local-player link, also readable by automation: viewerName is published in
    // the exact spelling of its roster row, so this match is exact.
    const me = (state.roster ?? []).find((p) => p.displayName === state.viewerName) ?? null;
    if (el.root) {
      el.root.dataset.viewer = state.viewerName ?? "";
      el.root.dataset.viewerMatched = me ? "1" : "0";
      el.root.dataset.viewerAbils = me?.abilityState ? JSON.stringify(me.abilityState) : "";
    }
    debugLog(
      `scene=${scene || "-"} phase=${phase} roster=${state.roster?.length ?? 0} ` +
        `viewer=${state.viewerName ?? "-"} matched=${me ? "yes" : "no"} ` +
        `abil=${me?.abilityState ? JSON.stringify(me.abilityState) : "-"}`,
    );

    // Match winner banner on the post-game scene.
    if (el.roundChip && state.match?.winner && session === "live") {
      el.roundChip.textContent =
        `MATCH OVER · ${state.match.winner === "blue" ? "BLUE" : "RED"} WINS`;
    }
    updateDebugLine();
  }

  function span(text, cls) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  }

  /** Alive pips are roster-derived when present; placeholder of 5 otherwise. */
  function renderPips(container, clsOn, count) {
    container.innerHTML = "";
    for (let i = 0; i < count; i += 1) {
      const p = document.createElement("div");
      p.className = `pip ${clsOn}`;
      container.appendChild(p);
    }
  }

  // Keep the countdown ticking between pushed frames.
  setInterval(() => {
    if (lastRoundState) renderTimer(lastRoundState, lastSpikePlanted);
  }, 500);

  function connectWs() {
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
    ws.onopen = () => {
      wsConnected = true;
      updateDebugLine();
    };
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        lastRoundState = parsed.round ?? lastRoundState;
        render(parsed);
      } catch {}
    };
    ws.onclose = () => {
      wsConnected = false;
      updateDebugLine();
      setTimeout(connectWs, 1500);
    };
    ws.onerror = () => ws.close();
  }

  async function pollOnce() {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      const parsed = await res.json();
      lastRoundState = parsed.round ?? lastRoundState;
      render(parsed);
    } catch {}
    if (usePolling) setTimeout(pollOnce, 500);
  }

  connectWs();
  pollOnce();
  updateDebugLine();
})();
