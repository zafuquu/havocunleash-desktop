/* Havoc Unleash desktop shell — login → room code → overlay control. */
const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const v of ["view-login", "view-room", "view-connected"]) $(v).classList.add("hidden");
  $(id).classList.remove("hidden");
};

let overlayOn = false;

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

  const dot = $("dot");
  dot.className = "dot" + (s.runtimeConnected ? " on" : "") + (s.live?.sessionPhase === "live" ? " live" : "");
  $("conn-text").textContent = s.runtimeConnected
    ? s.live?.sessionPhase === "live"
      ? "runtime: LIVE"
      : "runtime: connected"
    : "runtime: idle";

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

void refresh();
setInterval(refresh, 1500);