/* Havoc Unleash desktop shell — login → room code → overlay control. */
const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const v of ["view-login", "view-room", "view-connected"]) $(v).classList.add("hidden");
  $(id).classList.remove("hidden");
};

let overlayOn = false;
/** v11: watchdog banner dismissal (re-arms on recovery) + health drawer. */
let bannerDismissed = false;
let drawerOpen = false;

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

async function refresh() {
  let s;
  try {
    s = await (await fetch("/api/status")).json();
  } catch {
    return;
  }

  const inMatch = s.live?.sessionPhase === "live";
  // v10 (2026-10-20 patch day): GEP can attach yet deliver ZERO match data
  // (DLL injection broken after a game patch) — the HUD then runs on
  // fabricated state. Surface that loudly instead of a healthy chip.
  const telState = s.gepTelemetry?.state ?? null;
  const gepDead =
    inMatch && (telState === "STALE" || telState === "CONNECTED_BUT_NO_TELEMETRY" || telState === "ERROR");
  const dot = $("dot");
  dot.className =
    "dot" + (s.runtimeConnected ? " on" : "") + (inMatch ? " live" : "") + (gepDead ? " gepdead" : "");
  $("conn-text").textContent = !s.runtimeConnected
    ? "runtime: idle"
    : gepDead
      ? "runtime: LIVE · GEP: NO DATA"
      : inMatch
        ? "runtime: LIVE"
        : "runtime: connected";
  $("conn-text").classList.toggle("gepdead", gepDead);

  // v11 C11 — versions strip + data age; B7 — watchdog banner; A — OCR badge.
  const lastDataMs = s.gepTelemetry?.lastDataAt ?? s.gepTelemetry?.at ?? 0;
  const dataAgeS = lastDataMs > 0 ? Math.max(0, Math.round((Date.now() - lastDataMs) / 1000)) : null;
  const v = s.versions ?? {};
  $("versions").textContent =
    `app ${v.app ?? "—"} · GEP pkg ${v.gepPackage ?? "?"} · VAL ${
      v.gameBuildAt ? new Date(v.gameBuildAt).toLocaleDateString() : "?"
    } · data ${dataAgeS === null ? "—" : dataAgeS + "s"}` + (v.gameRecentlyUpdated ? " · ⚠ game updated" : "");
  const banner = $("gep-banner");
  const watch = inMatch && gepDead && dataAgeS !== null && dataAgeS > 180;
  if (watch && !bannerDismissed) {
    banner.textContent =
      `No GEP game data for ${Math.floor(dataAgeS / 60)}m ${dataAgeS % 60}s while live — a VALORANT patch may have broken telemetry until Overwolf ships a fix.` +
      (s.ocr?.engaged ? " OCR backup is covering the scene." : s.ocr?.enabled ? "" : " Tip: enable OCR backup in health details (chip).");
    banner.classList.remove("hidden");
  } else if (!watch) {
    banner.classList.add("hidden");
    bannerDismissed = false; // recovery re-arms the banner
  }
  $("ocr-badge").classList.toggle("hidden", !(s.ocr && s.ocr.engaged));

  if (!s.signedIn) {
    show("view-login");
    return;
  }

  if (!s.room) {
    show("view-room");
    $("subtitle").textContent = `Signed in as ${s.userName ?? "user"}`;
    return;
  }

  show("view-connected");
  renderSetup(s);
  renderHealth(s, dataAgeS);
  $("subtitle").textContent = `Signed in as ${s.userName ?? "user"}`;
  $("c-room").textContent = s.room.roomName || s.room.roomId.slice(0, 8);
  overlayOn = !!s.overlayRequested;
  $("btn-overlay").textContent = overlayOn ? "Stop overlay" : "Start overlay";
  $("btn-overlay").classList.toggle("stop", overlayOn);
  if (s.live) {
    $("c-live").textContent =
      s.live.sessionPhase === "live" ? `LIVE — ${s.live.mapName ?? "in match"}` : s.live.sessionPhase;
    $("c-scene").textContent = s.live.scene ?? "—";
    if (s.live.score) $("c-score").textContent = `${s.live.score.blue} : ${s.live.score.red}`;
    $("c-score").textContent = `${s.live.score?.blue ?? 0} : ${s.live.score?.red ?? 0}  (round ${s.live.roundNumber ?? 0})`;
  } else {
    $("c-live").textContent = "waiting for game…";
    $("c-scene").textContent = "—";
  }
}

$("btn-login").addEventListener("click", async () => {
  $("btn-login").disabled = true;
  $("login-note").classList.remove("hidden");
  await post("/api/auth/start");
  setTimeout(() => ($("btn-login").disabled = false), 2500);
});

$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("room-code").value.trim();
  if (!code) return;
  $("room-error").classList.add("hidden");
  const r = await post("/api/room/join", { roomId: code });
  if (!r.ok) {
    $("room-error").textContent = r.error ?? "Could not join that room.";
    $("room-error").classList.remove("hidden");
  }
});

async function loadRooms() {
  try {
    const { rooms } = await (await fetch("/api/rooms")).json();
    const list = $("rooms-list");
    list.innerHTML = "";
    for (const room of rooms ?? []) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${room.roomName || "Room"} · ${room.roomGame || "VAL"}`;
      btn.addEventListener("click", () => {
        $("room-code").value = room.roomId;
        $("join-form").dispatchEvent(new Event("submit"));
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    if ((rooms ?? []).length === 0) list.innerHTML = '<li class="muted small">No rooms found on the bridge.</li>';
  } catch {
    $("rooms-list").innerHTML = '<li class="muted small">Bridge unreachable.</li>';
  }
}

$("btn-leave").addEventListener("click", async () => {
  $("btn-leave").disabled = true;
  try {
    await post("/api/room/leave");
  } finally {
    $("btn-leave").disabled = false;
  }
  void refresh();
});

$("btn-change-room").addEventListener("click", async () => {
  $("btn-change-room").disabled = true;
  try {
    await post("/api/room/leave");
  } finally {
    $("btn-change-room").disabled = false;
  }
  show("view-room");
  void loadRooms();
  void refresh();
});
$("btn-net-reset").addEventListener("click", async () => {
  const btn = $("btn-net-reset");
  btn.disabled = true;
  btn.textContent = "Resetting…";
  try {
    const r = await post("/api/network/reset");
    btn.textContent = r.ok
      ? `Done — removed ${r.result?.summary?.removedRowCount ?? 0} sockets`
      : r.error ?? "Reset failed";
  } catch {
    btn.textContent = "Reset failed";
  }
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Reset VALORANT network (observers)";
  }, 3000);
});

$("btn-overlay").addEventListener("click", async () => {
  const r = await post("/api/overlay/toggle");
  overlayOn = !!r.on;
  $("btn-overlay").textContent = overlayOn ? "Stop overlay" : "Start overlay";
  $("btn-overlay").classList.toggle("stop", overlayOn);
});

// Re-fetch the room list whenever the room view is visible.
new MutationObserver(() => {
  if (!$("view-room").classList.contains("hidden")) void loadRooms();
}).observe($("view-room"), { attributes: true, attributeFilter: ["class"] });

/* ------------------------- v11 shell: health drawer / setup / OCR ------------------------- */

function renderHealth(s, dataAgeS) {
  if (!drawerOpen) return;
  const tel = s.gepTelemetry?.state ?? "—";
  $("h-gep").textContent = tel + (s.ocr?.engaged ? " · OCR covering" : "");
  $("h-lastdata").textContent = dataAgeS === null ? "—" : `${dataAgeS}s ago`;
  const v = s.versions ?? {};
  $("h-app").textContent = `${v.app ?? "—"} / ${v.gepPackage ?? "?"}`;
  $("h-game").textContent = v.gameBuildAt
    ? `${new Date(v.gameBuildAt).toLocaleString()}${v.gameRecentlyUpdated ? " — updated recently" : ""}`
    : "?";
  const o = s.ocr ?? {};
  $("h-ocr").textContent = !o.enabled
    ? "off"
    : o.engineError
      ? `error: ${o.engineError}`
      : o.engaged
        ? `engaged${o.lastReadAt ? ` · read ${Math.max(0, Math.round((Date.now() - o.lastReadAt) / 1000))}s ago` : ""}${
            o.score ? ` · raw L${o.score.left} R${o.score.right}` : ""
          }`
        : "on (waiting for GEP to go stale)";
  const box = $("ocr-enabled");
  if (document.activeElement !== box) box.checked = o.enabled === true;
}

function setupDone() {
  try {
    return localStorage.getItem("hu_setup_done") === "1";
  } catch {
    return true;
  }
}

function renderSetup(s) {
  const card = $("setup");
  if (setupDone()) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const set = (id, ok) => {
    const el = $(id);
    el.classList.toggle("ok", !!ok);
    el.classList.toggle("bad", !ok);
  };
  set("st-signin", s.signedIn);
  set("st-room", !!s.room);
  set("st-runtime", s.runtimeConnected);
  set("st-gep", s.gepTelemetry?.state === "HEALTHY");
  set("st-overlay", s.overlayRequested);
}

$("chip").addEventListener("click", () => {
  drawerOpen = !drawerOpen;
  $("health-drawer").classList.toggle("hidden", !drawerOpen);
  void refresh();
});

$("gep-banner").addEventListener("click", () => {
  bannerDismissed = true;
  $("gep-banner").classList.add("hidden");
});

$("ocr-enabled").addEventListener("change", async (e) => {
  await post("/api/ocr/settings", { enabled: e.target.checked === true });
  void refresh();
});

$("btn-support").addEventListener("click", async () => {
  const p = $("h-support");
  p.classList.remove("hidden");
  p.textContent = "Building bundle…";
  try {
    const r = await post("/api/support-bundle");
    p.textContent = r.ok ? `Bundle ready: ${r.dir ?? "folder opened"}` : `Failed: ${r.error ?? "unknown error"}`;
  } catch (error) {
    p.textContent = `Failed: ${error}`;
  }
});

$("setup-dismiss").addEventListener("click", () => {
  try {
    localStorage.setItem("hu_setup_done", "1");
  } catch {
    /* private mode */
  }
  $("setup").classList.add("hidden");
});

$("btn-copy-obs").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/`);
    $("btn-copy-obs").textContent = "Copied!";
    setTimeout(() => ($("btn-copy-obs").textContent = "Copy OBS browser-source URL"), 1500);
  } catch {
    $("btn-copy-obs").textContent = "Copy failed — copy the address bar URL";
  }
});

void refresh();
setInterval(refresh, 1500);