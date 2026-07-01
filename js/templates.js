/* ===== TEMPLATES (the SINGLE object registry — DESIGN 1-1) ===== */
//
// One registry is the source of truth for EVERY library object. The left panel is
// rendered FROM this registry (no hardcoded buttons in index.html), and each entry
// only POINTS AT the existing creation path — it never re-implements geometry.
//
// Every entry carries:
//   label     — Korean button text ("볼록렌즈")
//   category  — "공통" | "회로" | "광학" | "역학" (drives panel grouping)
//   keywords  — search hints for a future symbol search (filled plausibly)
//   kind      — "atomic" : ONE object dropped immediately at view center
//               "shape"  : arms an existing placement tool; the user draws on canvas
//   create    — wiring to the EXISTING pipeline (NO new geometry here):
//                 atomic → { } plus a make(at) that returns the object data
//                 shape  → { tool, element? | kind? } recorded before arming the tool
//
// Two creation pipelines are preserved EXACTLY as before:
//   * atomic  → instantiate() pushes make()'s object through the store.
//   * shape   → armSymbol() (tools.js) records the variant (_circuitElement /
//               _opticsKind) then arms CIRCUIT / OPTICS / ARC, which build the
//               geometry on canvas drag/click via makeShape()/makeCircuit()/the ARC
//               tool. The registry only names which tool + variant to arm.

import { state } from "./state.js?v=0.36.5";
import { armSymbol } from "./tools.js?v=0.36.5";
import { renderObject } from "./render.js?v=0.36.5";
import { applyNewObjectStyleDefaults } from "./style-mode.js?v=0.36.5";

const DEFAULT_STROKE_WIDTH = 0.2; // world units (mm) — matches tools.js shapes

// Monotonic suffix so two instantiations within the same millisecond differ.
let _tplIdCounter = 0;

/* ===== SYMBOL REGISTRY (keyed by symbolId — the UNIQUE per-object id) ===== */
export const TEMPLATES = {
  /* ----- 공통: axes + angle arc ----- */

  /* AXES — atomic (single type:"axes" object). Carries x/y/w/h/rotation so it
   * rides the existing size-based transform path with no new logic. Ticks/labels
   * are computed by the renderer, never stored as separate objects. */
  axes: {
    kind: "atomic",
    category: "공통",
    label: "좌표축",
    keywords: ["좌표축", "axes", "축", "xy", "그래프", "graph"],
    create: {},
    make(at) {
      const w = 44, h = 34; // default extent (mm); resizable afterwards
      return {
        type: "axes",
        x: at.x - w / 2,
        y: at.y - h / 2,
        w,
        h,
        rotation: 0,
        strokeLevel: 0,                 // 0 = black (DESIGN 2-2)
        strokeWidth: DEFAULT_STROKE_WIDTH,
        showTicks: true,
        tickSpacing: 5,                 // world units (mm) between ticks
        axisVariant: "cross",           // "cross" | "quadrant" | "single" (form)
        labelX: "x",
        labelY: "y",
        labelType: "quantity",
        locked: false,
        positionLocked: false,
      };
    },
  },

  /* ANGLE ARC — shape (arms the two-click ARC tool in tools.js). The placement
   * tool owns the geometry (makeAngleArcDraft): click 1 = vertex, click 2 = start
   * point. make() below is kept for reference; the button never calls it. */
  anglearc: {
    kind: "shape",
    category: "공통",
    label: "각도 호",
    keywords: ["각도", "호", "angle", "arc", "세타", "theta", "θ"],
    create: { tool: "ARC" },
    make(at) {
      return {
        type: "anglearc",
        x: at.x,                    // arc vertex sits AT the drop point
        y: at.y,
        radius: 14,                 // world units (mm); resizable afterwards
        startAngle: 0,              // math convention (CCW positive, +Y up)
        sweepAngle: 60,             // opening of the arc (deg); CCW positive
        label: "θ",
        labelType: "quantity",
        showLabel: true,
        strokeLevel: 0,             // 0 = black (DESIGN 2-2)
        strokeWidth: DEFAULT_STROKE_WIDTH,
        locked: false,
        positionLocked: false,
      };
    },
  },

  /* ----- 회로: circuit elements — each arms the two-click CIRCUIT tool with a
   * specific element (tools.js makeCircuit reads _circuitElement). ----- */
  rightangle: {
    kind: "shape",
    category: "공통",
    label: "직각 표시",
    keywords: ["직각", "right angle", "90", "marker"],
    create: { tool: "RIGHTANGLE" },
    make(at) {
      return {
        type: "rightangle",
        x: at.x,
        y: at.y,
        size: 6,
        angle: 0,
        orientation: 1,
        strokeLevel: 0,
        strokeWidth: DEFAULT_STROKE_WIDTH,
        locked: false,
        positionLocked: false,
      };
    },
  },

  /* LABELER — shape (arms the two-click LABELER tool in tools.js). Click 1 =
   * leader-line start (on/near the graph), click 2 = label position. Draws a short
   * leader with a small end-gap, then an upright label (circled-letter presets). */
  labeler: {
    kind: "shape",
    category: "공통",
    label: "라벨러",
    keywords: ["라벨", "이름", "지시선", "label", "leader", "callout", "ㄱㄴㄷ", "보기"],
    create: { tool: "LABELER" },
  },

  wire: { kind: "shape", category: "전자기학", label: "도선", keywords: ["도선", "전선", "wire", "conductor"], create: { tool: "APPARATUS", kind: "wire" } },
  compass: { kind: "shape", category: "전자기학", label: "나침반", keywords: ["나침반", "compass", "needle", "magnetic"], create: { tool: "APPARATUS", kind: "compass" } },
  clamp: { kind: "shape", category: "역학", label: "클램프", keywords: ["클램프", "스탠드", "clamp", "stand"], create: { tool: "APPARATUS", kind: "clamp" } },
  scale: { kind: "shape", category: "역학", label: "저울", keywords: ["저울", "디지털저울", "scale", "balance"], create: { tool: "APPARATUS", kind: "scale" } },

  resistor:  { kind: "shape", category: "회로", label: "저항",     keywords: ["저항", "resistor", "옴", "ohm", "R"],            create: { tool: "CIRCUIT", element: "resistor" } },
  dc_source: { kind: "shape", category: "회로", label: "전지",     keywords: ["전지", "전원", "직류", "dc", "battery", "source"], create: { tool: "CIRCUIT", element: "dc_source" } },
  ac_source: { kind: "shape", category: "회로", label: "교류전원", keywords: ["교류", "ac", "전원", "source", "sine"],          create: { tool: "CIRCUIT", element: "ac_source" } },
  capacitor: { kind: "shape", category: "회로", label: "축전기",   keywords: ["축전기", "콘덴서", "capacitor", "condenser", "C"], create: { tool: "CIRCUIT", element: "capacitor" } },
  inductor:  { kind: "shape", category: "회로", label: "코일",     keywords: ["코일", "인덕터", "inductor", "coil", "L"],        create: { tool: "CIRCUIT", element: "inductor" } },
  unknown:   { kind: "shape", category: "회로", label: "미지소자", keywords: ["미지", "소자", "unknown", "box", "element"],      create: { tool: "CIRCUIT", element: "unknown" } },
  diode:     { kind: "shape", category: "회로", label: "다이오드", keywords: ["다이오드", "diode", "정류"],                      create: { tool: "CIRCUIT", element: "diode" } },
  lamp:      { kind: "shape", category: "회로", label: "전구",     keywords: ["전구", "램프", "lamp", "bulb", "light"],          create: { tool: "CIRCUIT", element: "lamp" } },
  ammeter:   { kind: "shape", category: "회로", label: "전류계",   keywords: ["전류계", "ammeter", "A", "전류"],                 create: { tool: "CIRCUIT", element: "ammeter" } },
  voltmeter: { kind: "shape", category: "회로", label: "전압계",   keywords: ["전압계", "voltmeter", "V", "전압"],               create: { tool: "CIRCUIT", element: "voltmeter" } },

  /* ----- 광학: lenses / mirrors / object / screen / point source — each arms the
   * OPTICS tool (rect-style size-drag) with a specific kind (tools.js makeShape
   * reads _opticsKind). ----- */
  convex_lens:    { kind: "shape", category: "광학", label: "볼록렌즈", keywords: ["볼록", "렌즈", "convex", "lens"],            create: { tool: "OPTICS", kind: "convex_lens" } },
  concave_lens:   { kind: "shape", category: "광학", label: "오목렌즈", keywords: ["오목", "렌즈", "concave", "lens"],           create: { tool: "OPTICS", kind: "concave_lens" } },
  convex_mirror:  { kind: "shape", category: "광학", label: "볼록거울", keywords: ["볼록", "거울", "convex", "mirror"],          create: { tool: "OPTICS", kind: "convex_mirror" } },
  concave_mirror: { kind: "shape", category: "광학", label: "오목거울", keywords: ["오목", "거울", "concave", "mirror"],         create: { tool: "OPTICS", kind: "concave_mirror" } },
  plane_mirror:   { kind: "shape", category: "광학", label: "평면거울", keywords: ["평면", "거울", "plane", "mirror"],           create: { tool: "OPTICS", kind: "plane_mirror" } },
  object_arrow:   { kind: "shape", category: "광학", label: "물체",     keywords: ["물체", "화살표", "object", "arrow"],         create: { tool: "OPTICS", kind: "object_arrow" } },
  screen:         { kind: "shape", category: "광학", label: "스크린",   keywords: ["스크린", "screen", "벽"],                    create: { tool: "OPTICS", kind: "screen" } },
  point_light:    { kind: "shape", category: "광학", label: "점광원",   keywords: ["점광원", "광원", "point", "light", "source"], create: { tool: "OPTICS", kind: "point_light" } },

  /* ----- 역학: pulley / supports / pivot / node / magnet — also arm the OPTICS
   * size-drag tool with a specific kind. ----- */
  pulley:      { kind: "shape", category: "역학", label: "도르래",   keywords: ["도르래", "pulley", "활차"],             create: { tool: "APPARATUS", kind: "pulley" } },
  support_tri: { kind: "shape", category: "역학", label: "받침대",   keywords: ["받침대", "지지대", "support", "stand"],  create: { tool: "OPTICS", kind: "support_tri" } },
  pivot:       { kind: "shape", category: "역학", label: "회전축",   keywords: ["회전축", "pivot", "축", "axis"],         create: { tool: "OPTICS", kind: "pivot" } },
  node:        { kind: "shape", category: "공통", label: "점",       keywords: ["점", "마디", "연결점", "node", "joint"], create: { tool: "OPTICS", kind: "node" } },
  bar_magnet:  { kind: "shape", category: "역학", label: "막대자석", keywords: ["막대자석", "자석", "magnet", "NS"],      create: { tool: "OPTICS", kind: "bar_magnet" } },
};

/* ===== INSTANTIATE: atomic creation entry point ===== */
// atomic → push ONE object through the store (undo snapshot + auto-select),
// exactly like drawing a shape (tools.js) or importing an image (project-io.js).
export function instantiate(symbolId, atCanvasPoint) {
  const def = TEMPLATES[symbolId];
  if (!def) {
    console.warn(`[templates] unknown symbol: ${symbolId}`);
    return;
  }
  if (def.kind !== "atomic") {
    // Non-atomic symbols arm a placement tool instead (see onSymbolClick).
    console.warn(`[templates] "${symbolId}" is not atomic — use the placement tool`);
    return;
  }

  const at = atCanvasPoint || { x: 0, y: 0 };
  const obj = applyNewObjectStyleDefaults(def.make(at));

  state.update((s) => {
    // Snapshot pre-creation objects so a single Ctrl+Z removes this symbol.
    const snap = JSON.parse(JSON.stringify(s.objects));
    obj.id = `obj_${Date.now().toString(36)}_tpl${++_tplIdCounter}`;
    obj.order = s.objects.length;
    obj.layerId = s.activeLayerId;
    s.objects.push(obj);
    s.undoStack.push(snap);
    s.redoStack = [];
    s.selectedIds = [obj.id]; // auto-select the new symbol
    s.targetedId = null;
    s.activeTool = "V";       // ensure the select tool is armed
  });
}

/* ===== RENDER THE LEFT-PANEL LIBRARY FROM THE REGISTRY ===== */
// Categories are rendered as collapsible sections (same markup as the hardcoded
// 공통 도구 / 고급 기능 sections, so the existing collapse delegation works). Each
// button carries data-symbol="<symbolId>" — a UNIQUE id, not a shared tool name.
const CATEGORY_ORDER = ["공통", "회로", "전자기학", "광학", "역학"];

/* ===== ICON RENDERING — reuse the REAL renderers (render.js) at small scale =====
 *
 * Each button shows a mini SVG preview built by calling the object's EXISTING
 * render function (renderObject) on a representative data object, then flattening
 * it to a single currentColor silhouette. Because the geometry comes straight from
 * the renderer, any future edit to a shape updates its icon automatically. No icon
 * is hand-drawn here — we only choose representative sizes + a clean data variant. */
const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PX = 16;          // tool-ico render box (matches css .tool-btn kbd .tool-ico)
const ICON_STROKE_PX = 1.1;  // target on-screen stroke weight (≈ the base-tool icons)
const CIRCUIT_PALETTE_LABELS = { resistor: "R", inductor: "L", capacitor: "C", voltmeter: "V", ammeter: "A" };
const SHORTCUT_LABELS = { axes: "X", anglearc: "A", rightangle: "Shift+G", node: "N", labeler: "Shift+T" };

// Representative bounding boxes (world mm) per OPTICS kind — only drives the icon's
// aspect ratio; the viewBox auto-fits afterwards. fillNone keeps shapes hollow.
const OPTICS_ICON_BOX = {
  convex_lens:    { w: 13, h: 22 },
  concave_lens:   { w: 13, h: 22 },
  convex_mirror:  { w: 12, h: 22 },
  concave_mirror: { w: 12, h: 22 },
  plane_mirror:   { w: 10, h: 22 },
  screen:         { w: 10, h: 22 },
  object_arrow:   { w: 12, h: 22 },
  point_light:    { w: 18, h: 18 },
  node:           { w: 16, h: 16 },
  pivot:          { w: 18, h: 18 },
  pulley:         { w: 18, h: 18 },
  support_tri:    { w: 20, h: 14 },
  bar_magnet:     { w: 26, h: 12 },
};

const APPARATUS_ICON_BOX = {
  wire: { w: 26, h: 6 },
  compass: { w: 18, h: 18 },
  pulley: { w: 18, h: 18 },
  clamp: { w: 18, h: 24 },
  scale: { w: 26, h: 18 },
};

// Build the data object that the REAL renderer turns into the icon.
function iconSampleObject(id, def) {
  // axes + anglearc carry a make() → reuse the real geometry verbatim.
  if (typeof def.make === "function") {
    const o = def.make({ x: 0, y: 0 });
    if (o.type === "axes") {          // strip ticks/labels so the silhouette stays clean
      o.showTicks = false;
      o.labelX = "";
      o.labelY = "";
    }
    if (o.type === "anglearc") {
      o.label = "θ";
      o.showLabel = true;
    }
    return o;
  }
  const c = def.create || {};
  if (c.tool === "CIRCUIT") {
    // horizontal two-terminal element, 16mm span (8mm body + equal leads).
    return {
      type: "circuit", element: c.element,
      p1: { x: -8, y: 0 }, p2: { x: 8, y: 0 },
      strokeLevel: 0, strokeWidth: 0.5, label: "",
    };
  }
  if (c.tool === "OPTICS") {
    const b = OPTICS_ICON_BOX[c.kind] || { w: 18, h: 22 };
    return {
      type: "optics", kind: c.kind,
      x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h, rotation: 0,
      strokeLevel: 0, strokeWidth: 0.6, showLabel: false, fillNone: true,
    };
  }
  if (c.tool === "APPARATUS") {
    const b = APPARATUS_ICON_BOX[c.kind] || { w: 20, h: 16 };
    const sample = {
      type: "apparatus", kind: c.kind,
      x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h, rotation: 0,
      strokeLevel: 0, strokeWidth: 0.6, fillNone: true,
    };
    if (c.kind === "wire") Object.assign(sample, { length: 24, gap: 1.4, angle: -18 });
    if (c.kind === "compass") sample.needleAngle = -90;
    if (c.kind === "pulley") sample.variant = "basic";
    if (c.kind === "clamp") sample.flipped = false;
    if (c.kind === "scale") sample.displayText = "0.99 N";
    return sample;
  }
  return null;
}

// Flatten any rendered element tree to one currentColor silhouette (so it inherits
// the button's text color and turns white on the active/blue state).
function monochrome(node) {
  if (node.nodeType !== 1) return;
  const stroke = node.getAttribute("stroke");
  if (stroke && stroke !== "none" && stroke !== "transparent") node.setAttribute("stroke", "currentColor");
  const fill = node.getAttribute("fill");
  if (fill && fill !== "none" && fill !== "transparent") node.setAttribute("fill", "currentColor");
  for (const child of node.children) monochrome(child);
}

// Force a uniform stroke-width across the tree (in world units) — normalizes the
// on-screen weight regardless of how big the sample object is.
function setStrokeWidth(node, sw) {
  if (node.nodeType !== 1) return;
  if (node.hasAttribute("stroke-width")) node.setAttribute("stroke-width", sw);
  for (const child of node.children) setStrokeWidth(child, sw);
}

export function buildSymbolIcon(id, def = TEMPLATES[id]) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "tool-ico");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  if (id === "anglearc") {
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.innerHTML =
      '<path d="M4 16 L4 5 M4 16 L15 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M8 16 A4 4 0 0 0 4 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
      '<text x="8.8" y="12.8" font-size="6" font-family="serif" fill="currentColor">θ</text>';
    return svg;
  }

  if (id === "labeler") {
    // A short leader line from a graph anchor up to an upright circled letter.
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.innerHTML =
      '<path d="M3 17 L10 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
      '<circle cx="3" cy="17" r="1.4" fill="currentColor"/>' +
      '<text x="13.5" y="8.5" font-size="9" font-family="serif" text-anchor="middle" dominant-baseline="middle" fill="currentColor">㉠</text>';
    return svg;
  }

  const obj = iconSampleObject(id, def);
  if (!obj) return svg;
  const el = renderObject(obj);   // EXISTING renderer — icon stays in sync with the real shape
  if (!el) return svg;
  monochrome(el);
  svg.appendChild(el);
  return svg;                     // viewBox + stroke set after it goes live (needs getBBox)
}

// viewBox needs the svg LIVE in the DOM (getBBox). Fit it to the content and give
// every icon the same on-screen stroke weight.
export function sizeIconViewBox(svg) {
  const g = svg.firstElementChild;
  if (!g) return;
  let bb;
  try { bb = g.getBBox(); } catch { return; }
  if (!bb || (bb.width <= 0 && bb.height <= 0)) return;
  const pad = Math.max(bb.width, bb.height) * 0.14 + 0.6;
  const vbW = bb.width + pad * 2, vbH = bb.height + pad * 2;
  svg.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${vbW} ${vbH}`);
  const scale = ICON_PX / Math.max(vbW, vbH);   // uniform-fit (preserveAspectRatio meet)
  setStrokeWidth(g, ICON_STROKE_PX / scale);
}

// Build one registry symbol button (UNIQUE data-symbol id) + queue its icon for sizing.
function makeSymbolButton(id, def, pending) {
  const btn = document.createElement("button");
  btn.className = "tool-btn";             // square icon button (reuses active styling)
  btn.type = "button";
  btn.dataset.symbol = id;               // UNIQUE per-object id — drives the single-highlight fix
  btn.title = SHORTCUT_LABELS[id] ? `${def.label} (${SHORTCUT_LABELS[id]})` : def.label;
  btn.setAttribute("aria-label", btn.title); // keep tooltip + a11y label consistent

  const kbd = document.createElement("kbd");
  const label = CIRCUIT_PALETTE_LABELS[id];
  if (label) {
    const letter = document.createElement("span");
    letter.className = "tool-letter";
    letter.textContent = label;
    kbd.appendChild(letter);
  } else {
    const icon = buildSymbolIcon(id, def);
    kbd.appendChild(icon);
    pending.push(icon);
  }
  btn.appendChild(kbd);
  return btn;
}

function renderPanel() {
  const host = document.getElementById("symbol-sections");
  if (!host) return;
  host.replaceChildren();

  const pending = []; // icon svgs to size once they are live in the DOM

  // 공통 객체(좌표축/각도 호)는 별도 카테고리 헤더 없이 기본 도구(V/L/P…) 그룹 안에
  // 이어 붙인다. 레지스트리 데이터(category 등)는 그대로 두고 렌더 위치만 옮긴다.
  const basicBody = document.querySelector("#tool-list .tool-section-body");
  if (basicBody) {
    Object.keys(TEMPLATES)
      .filter((id) => TEMPLATES[id].category === "공통")
      .forEach((id) => basicBody.appendChild(makeSymbolButton(id, TEMPLATES[id], pending)));
  }

  for (const cat of CATEGORY_ORDER) {
    if (cat === "공통") continue; // 위에서 기본 도구 그룹에 병합됨
    const ids = Object.keys(TEMPLATES).filter((id) => TEMPLATES[id].category === cat);
    if (!ids.length) continue;

    const section = document.createElement("div");
    section.className = "tool-section";

    const header = document.createElement("div");
    header.className = "tool-section-header";
    header.innerHTML = `${cat} <span class="toggle-icon">▾</span>`;

    const body = document.createElement("div");
    body.className = "tool-section-body";   // 3-col icon grid (same as 공통 도구)

    for (const id of ids) {
      body.appendChild(makeSymbolButton(id, TEMPLATES[id], pending));
    }

    section.appendChild(header);
    section.appendChild(body);
    host.appendChild(section);
  }

  // Now that the sections are live, fit each icon's viewBox to its content.
  for (const svg of pending) sizeIconViewBox(svg);
}

/* ----- click → creation (functionally identical to the old per-button wiring) ----- */
export function activateTemplate(symbolId) {
  const def = TEMPLATES[symbolId];
  if (!def) return;
  if (def.kind === "atomic") {
    // Drop one object at the current view center, like before.
    const vb = state.get().viewBox;
    const center = { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
    instantiate(symbolId, center);
  } else {
    // shape → record the variant + arm the shared placement tool (tools.js).
    const c = def.create || {};
    armSymbol(symbolId, c.tool, c.element ?? c.kind);
  }
}

/* ===== WIRE THE LEFT-PANEL LIBRARY ===== */
export function initTemplates(svg) {
  renderPanel();
  const panel = document.getElementById("tool-list");
  if (!panel) return;
  panel.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-symbol]");
    if (!btn) return;
    activateTemplate(btn.dataset.symbol);
  });
}
