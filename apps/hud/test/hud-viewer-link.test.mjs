/**
 * HUD consumer contract test: the page has no is_local flag to work with, so
 * `viewerName` must be what marks the viewer's own roster row and surfaces that
 * row's ability charges. Runs the real public/main.js against a minimal DOM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "public", "main.js"), "utf8");

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this._class = "";
    this.parentNode = null;
    const self = this;
    this.classList = {
      toggle(name, on) {
        const set = new Set(self._class.split(" ").filter(Boolean));
        const want = on === undefined ? !set.has(name) : !!on;
        if (want) set.add(name);
        else set.delete(name);
        self._class = [...set].join(" ");
      },
      add(name) {
        self.classList.toggle(name, true);
      },
      remove(name) {
        self.classList.toggle(name, false);
      },
      contains(name) {
        return self._class.split(" ").includes(name);
      },
    };
  }
  get className() {
    return this._class;
  }
  set className(value) {
    this._class = String(value ?? "");
  }
  set innerHTML(value) {
    if (value === "") this.children = [];
  }
  get innerHTML() {
    return "";
  }
  append(...kids) {
    for (const k of kids) {
      k.parentNode = this;
      this.children.push(k);
    }
  }
  appendChild(kid) {
    this.append(kid);
    return kid;
  }
  remove() {
    const i = this.parentNode?.children.indexOf(this) ?? -1;
    if (i >= 0) this.parentNode.children.splice(i, 1);
  }
  /** Depth-first descendants matching a predicate. */
  all(pred) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  text() {
    return this.textContent + this.children.map((c) => c.text()).join("");
  }
}

/** Load main.js and hand back a frame injector plus the element registry. */
function loadHud() {
  const byId = new Map();
  let socket = null;
  const sandbox = {
    console,
    URLSearchParams,
    document: {
      getElementById(id) {
        if (!byId.has(id)) byId.set(id, new El("div"));
        return byId.get(id);
      },
      createElement: (tag) => new El(tag),
    },
    location: { origin: "http://127.0.0.1:41731", search: "", href: "http://127.0.0.1:41731/" },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        socket = this;
      }
      close() {}
    },
    fetch: async () => {
      throw new Error("no network in tests");
    },
    setTimeout: () => 0,
    setInterval: () => 0,
  };
  vm.runInNewContext(source, sandbox, { filename: "main.js" });
  assert.ok(socket, "the HUD opens a /ws connection on load");
  return {
    push: (state) => socket.onmessage({ data: JSON.stringify(state) }),
    el: byId,
  };
}

const frame = (overrides) => ({
  revision: 1,
  sessionPhase: "live",
  scene: "ingame-hud",
  round: { number: 4, phase: "shopping" },
  score: { blue: 2, red: 1 },
  viewerName: "Viewer #TAG",
  roster: [
    {
      displayName: "Viewer #TAG",
      teamId: "Blue",
      teamIndex: 0,
      agentName: "Tejo",
      health: 100,
      shield: 50,
      isAlive: true,
      kills: 3,
      deaths: 2,
      assists: 1,
      credits: 1250,
      ultPoints: 4,
      ultMax: 9,
      abilityState: { C: true, Q: false, E: true, X: false },
    },
    { displayName: "Mate#TAG", teamId: "Blue", teamIndex: 0, agentName: "Sage", isAlive: true },
    { displayName: "Opp#TAG", teamId: "Red", teamIndex: 1, agentName: "Jett", isAlive: false },
  ],
  killfeed: [],
  ...overrides,
});

test("viewer row — highlighted, tagged, and carrying its ability charges", () => {
  const { push, el } = loadHud();
  push(frame());

  const blue = el.get("roster-blue").children;
  const red = el.get("roster-red").children;
  assert.equal(blue.length, 2);
  assert.equal(red.length, 1);

  const me = blue[0];
  assert.match(me.className, /\bme\b/, "the viewer's row is marked");
  assert.ok(me.all((c) => c.className === "r-you").length, "row is tagged YOU");
  assert.ok(!blue[1].className.includes("me"), "a teammate is not the viewer");
  assert.ok(!red[0].className.includes("me"), "an opponent is not the viewer");

  const chips = me.all((c) => c.classList.contains("abil"));
  assert.deepEqual(
    chips.map((c) => `${c.text()}${c.classList.contains("on") ? "+" : "-"}`),
    ["C+", "Q-", "E+", "X-"],
    "charges mirror abilityState in slot order",
  );
  assert.equal(blue[1].all((c) => c.classList.contains("abil")).length, 0);
});

test("viewer row — no identity means nothing is marked", () => {
  const { push, el } = loadHud();
  push(frame({ viewerName: null }));
  const rows = [...el.get("roster-blue").children, ...el.get("roster-red").children];
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.className.includes("me")).length, 0);
});

test("viewer row — the link is readable by automation on #root", () => {
  const { push, el } = loadHud();
  push(frame());
  const root = el.get("root");
  assert.equal(root.dataset.viewer, "Viewer #TAG");
  assert.equal(root.dataset.viewerMatched, "1");
  assert.equal(root.dataset.viewerAbils, JSON.stringify({ C: true, Q: false, E: true, X: false }));
});

test("viewer row — a dialect mismatch surfaces as unmatched, never misattached", () => {
  const { push, el } = loadHud();
  // Guards the failure the relay fix removes: identity published in a different
  // spelling than the roster row must not silently attach to another player.
  push(frame({ viewerName: "Viewer#TAG" }));
  assert.equal(el.get("root").dataset.viewerMatched, "0");
  const rows = [...el.get("roster-blue").children, ...el.get("roster-red").children];
  assert.equal(rows.filter((r) => r.className.includes("me")).length, 0);
});
