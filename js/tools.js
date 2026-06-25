/* ===== TOOLS (DESIGN 짠3 tool selection + the rectangle draw pipeline) ===== */
//
// Two responsibilities, both routed through the store so data stays the truth:
//   1. Tool selection ??V (select) / R (rectangle), via buttons or keyboard.
//      The armed tool lives in state.activeTool.
//   2. Rectangle drawing ??mouse down?뭗rag?뭫p while R is armed. The drag builds
//      a `draft` rect (live preview via state.draft); mouse-up commits it into
//      state.objects, then auto-returns to V (DESIGN 4-3).
//
// Mouse points are screen pixels; they are converted to WORLD coords through
// screenToWorld BEFORE being stored, so shapes are anchored in world space and
// survive zoom/pan unchanged (DESIGN 1-2).

import { screenToWorld, getZoom, getRenderScale, worldToScreen } from "./viewport.js?v=0.15.0";
import {
  TEXT_FONTS, DEFAULT_TEXT_FONT, DEFAULT_TEXT_SIZE_PX, DEFAULT_TEXT_SIZE_MM,
  TEXT_STYLES, TEXT_SIZE_PRESETS, ptToMm, mmToPt,
} from "./state.js?v=0.15.0";
// Single-source circuit body geometry: hit-testing reuses the SAME polygon the
// renderer draws, so the clickable box and the visible box can never diverge.
import { circuitBodyPolygon } from "./render.js?v=0.15.0";

// Default look until the inspector exists (DESIGN 짠3-2: border only, hollow).
const DEFAULT_STROKE_WIDTH = 0.2; // world units (mm)
const MIN_SIZE = 0.3; // world units; ignore stray clicks that draw nothing
const HIT_TOL_PX = 6; // CSS px of slop around an edge so thin strokes are clickable
const LINE_HIT_TOL_PX = 20; // existing screen-space slop for line-family segments
const BASIC_LINE_MIN_HIT_WIDTH_PX = 24;
const TEXT_EDITOR_PX = 14; // on-screen px of the text editor (matches .text-editor-overlay font-size)
const TEXT_LINE_HEIGHT = 1.4; // matches .text-editor-overlay line-height AND renderText() tspan dy
// A textarea centers its glyphs in the line box, so the first line sits half a
// leading below the element top. The committed SVG <text> uses dominant-baseline:
// hanging (glyph top AT the anchor), so we shift the editor up by that half-leading
// to keep the draft and the final text from jumping vertically on commit.
const TEXT_HALF_LEADING_PX = TEXT_EDITOR_PX * (TEXT_LINE_HEIGHT - 1) / 2;

// A closed polyline keeps branch-B storage (point array) but takes branch-A
// (face) interaction ??selectable by interior, ratio-resizable, rotatable.
function isClosedPoly(o) { return o && o.type === "polyline" && o.closed === true; }
// A closed curve follows the SAME pattern: branch-B storage (anchor array) +
// branch-A (face) interaction. The gap is closed with a smooth curved span.
function isClosedCurve(o) { return o && o.type === "curve" && o.closed === true; }

let _svg = null;
let _state = null;
let _idCounter = 0;

// Which circuit element / optics kind the next placement creates. Set via
// armSymbol() when a left-panel symbol button is clicked; the placement pipelines
// read these so a single CIRCUIT/OPTICS tool covers every variant.
let _circuitElement = "resistor";
let _opticsKind = "convex_lens";
const CIRCUIT_CAP_GAP_DEFAULT = 2; // capacitor plate gap default (mm); mirrors render.js

// The UNIQUE id (data-symbol) of the library symbol currently armed, or null when
// a plain drawing tool is active. Drives single-button highlight in syncButtons:
// many symbols share ONE placement tool (CIRCUIT/OPTICS/ARC) but each button has a
// unique data-symbol, so exactly one highlights — fixing the old all-CIRCUIT /
// all-OPTICS multi-highlight where every button matching data-tool lit up.
let _activeSymbolId = null;
// Tools that a library symbol arms (vs. the plain V/R/O/... drawing tools). While
// one of these is active, _activeSymbolId names WHICH symbol armed it; any other
// tool (incl. auto-return to V after a commit) means no symbol is armed.
const SYMBOL_TOOLS = new Set(["CIRCUIT", "OPTICS", "ARC"]);

/* ----- public: wire buttons, keyboard, and the drawing gestures ----- */
export function initTools(svg, state) {
  _svg = svg;
  _state = state;

  setupButtons();
  setupKeyboard();
  setupDrawing();
  setupClickDrawing();
  setupTextTool();
  setupTextClickToEdit();
  setupTextEditShortcuts();
  setupTextContextMenu();

  // Keep the tool buttons in sync with state.activeTool on every change.
  state.subscribe((s) => syncButtons(s.activeTool));
  syncButtons(state.get().activeTool);
}

/* ----- tool selection: the one path that changes the armed tool ----- */
function setActiveTool(tool) {
  if (_state.get().activeTool === tool) return;
  clearClickLocals(); // arming another tool discards any in-progress click draft
  cancelActiveTextEditor(); // discard any in-progress text edit
  _state.update((s) => {
    s.activeTool = tool;
    s.draft = null; // arming another tool discards any unfinished draft
  });
}

/* ----- left-panel buttons (the plain V/R/O/Y/L/P/C/T/rotate drawing tools) ----- */
// These map ONE button to ONE tool via data-tool. Library symbol buttons are NOT
// wired here — they carry data-symbol and are handled by templates.js, which calls
// armSymbol() below to record the variant and arm the shared placement tool.
function setupButtons() {
  document.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTool(btn.dataset.tool));
  });
}

/* ----- arm a library symbol (called by templates.js for "shape"-kind symbols) -----
 * Records the concrete variant (the EXACT thing the old per-element/per-kind
 * buttons did) then arms the shared placement tool. syncButtons runs explicitly so
 * the highlight updates even when the armed tool is unchanged (e.g. 저항 → 전지,
 * both on CIRCUIT, where setActiveTool early-returns and fires no subscriber). */
export function armSymbol(symbolId, tool, variant) {
  if (tool === "CIRCUIT") _circuitElement = variant || "resistor";
  if (tool === "OPTICS")  _opticsKind = variant || "convex_lens";
  _activeSymbolId = symbolId;
  setActiveTool(tool);
  syncButtons(_state.get().activeTool);
}

function syncButtons(activeTool) {
  // A library symbol stays armed only while its placement tool is active; any plain
  // tool (or the auto-return to V after a commit) clears the symbol highlight.
  if (!SYMBOL_TOOLS.has(activeTool)) _activeSymbolId = null;
  // Plain tool buttons: one button ↔ one tool (unchanged behavior).
  document.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tool === activeTool);
  });
  // Symbol buttons share a placement tool but each has a UNIQUE data-symbol, so
  // exactly one highlights — keyed on the armed symbol id, not the shared tool.
  document.querySelectorAll("[data-symbol]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.symbol === _activeSymbolId);
  });
}

/* ----- keyboard shortcuts: V / S / R / O / Y / L / P / C / T ----- */
function setupKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave Ctrl+R (reload) etc.
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const key = e.key.toLowerCase();
    if (key === "v") setActiveTool("V");
    else if (key === "s") setActiveTool("R");
    else if (key === "r") setActiveTool("rotate");
    else if (key === "o") setActiveTool("O");
    else if (key === "y") setActiveTool("Y");
    else if (key === "l") setActiveTool("L");
    else if (key === "p") setActiveTool("P");
    else if (key === "c") setActiveTool("C");
    else if (key === "t") setActiveTool("T");
  });
}

/* ===== SHAPE DRAWING (rect / ellipse / triangle ??one shared pipeline) ===== */

// Armed tool ??object type. Size-based shapes (rect/ellipse/triangle) draw
// through the SAME down?뭗rag?뭫p flow; only the stored geometry differs
// (makeShape branches on type). Line (L) and polyline (P) are click-to-click
// instead ??see setupClickDrawing below.
const SHAPE_TYPE = { R: "rect", O: "ellipse", Y: "triangle", OPTICS: "optics" };

let drawing = false;
let startWorld = null; // world coord of the mouse-down point
let drawType = null;   // type being drawn for the current drag
let spaceHeld = false; // mirror viewport's Space-pan so we never draw while panning

let _marqueeStart = null; // world {x,y} of marquee drag start, or null
let _marqueeEl = null;    // temporary SVG <rect> shown during marquee drag

function constrainShapeEnd(type, start, end, shiftHeld) {
  if (!shiftHeld || (type !== "rect" && type !== "ellipse")) return end;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: start.x + (dx < 0 ? -size : size),
    y: start.y + (dy < 0 ? -size : size),
  };
}

function snapLineEnd(start, end, ctrlHeld) {
  if (!ctrlHeld) return end;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
  return {
    x: start.x + Math.cos(angle) * distance,
    y: start.y + Math.sin(angle) * distance,
  };
}

function setupDrawing() {
  // track Space locally so a Space+drag pans (viewport) instead of drawing.
  window.addEventListener("keydown", (e) => { if (e.code === "Space") spaceHeld = true; });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceHeld = false; });

  // HOVER CURSOR is now driven by the open-path hit twin (render.js): each twin
  // carries cursor:pointer over the SAME fat transparent band that drives click
  // selection and grab/move, so hover and click share one element. The old
  // pointermove handler here set a "grab" cursor only for basic lines via a
  // separate geometric test — that divergence is removed so the two can't disagree.

  // V (select): click hit-tests committed rects by world bbox, topmost wins.
  // Clicking empty space clears the selection.
  _svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;                  // left button only
    if (spaceHeld) return;                        // Space+left = pan, not select
    const _at = _state.get().activeTool;
    if (_at !== "V" && _at !== "rotate") return;  // select or rotate tool picks
    // A click on a selection handle means "manipulate the selected object",
    // NOT "change selection". Handles can sit OUTSIDE the shape outline
    // (ellipse/triangle corners), where hitTest finds empty space and would
    // wrongly clear selectedIds ??breaking transform.js's handle-drag guard.
    const tgt = e.target;
    if (tgt && tgt.dataset && tgt.dataset.handle) return;
    const vb = _state.get().viewBox;
    const p = screenToWorld(_svg, vb, e.clientX, e.clientY);
    // Convert a few CSS px of edge tolerance into world units (DESIGN-style
    // tolerance) so thin strokes are easy to hit.
    const worldUnitsPerPx = vb.w / _svg.getBoundingClientRect().width;
    const tol = HIT_TOL_PX * worldUnitsPerPx;
    const lineTol = LINE_HIT_TOL_PX / getRenderScale();
    const shiftHeld = e.shiftKey;
    let hitId = null;
    _state.update((s) => {
      hitId = _at === "V"
        ? pickSelectableObject(s, p, tol, lineTol)
        : hitTest(s.objects, p, tol, lineTol);
      if (_at !== "V" && hitId !== null) {
        const hit = s.objects.find((o) => o.id === hitId);
        if (!isObjectSelectable(s, hit)) hitId = null;
      }
      if (hitId === null) {
        if (_at !== "V") s.selectedIds = []; // rotate: clear immediately
        // V: defer selection to mouseup so marquee can run
      } else if (shiftHeld) {
        const idx = s.selectedIds.indexOf(hitId);
        if (idx === -1) s.selectedIds = [...s.selectedIds, hitId];
        else s.selectedIds = s.selectedIds.filter(id => id !== hitId);
      } else {
        const _hitObj = s.objects.find((o) => o.id === hitId);
        if (_hitObj && _hitObj.groupId) {
          if (e.detail >= 2) {
            // Double-click targets the individual member (DESIGN 6-2). We detect
            // it here via e.detail rather than via a dblclick listener: every
            // mousedown re-renders (scene.replaceChildren), detaching the clicked
            // node before mouseup, so the browser never fires click/dblclick.
            s.targetedId = hitId;
            s.selectedIds = [hitId];
          } else if (s.targetedId === hitId) {
            // Already targeting this member ??preserve targeted state
            s.selectedIds = [hitId];
          } else {
            const _grp = s.groups.find((g) => g.id === _hitObj.groupId);
            s.selectedIds = _grp ? [..._grp.memberIds] : [hitId];
            s.targetedId = null;
          }
        } else if (!s.selectedIds.includes(hitId)) {
          s.selectedIds = [hitId];
          s.targetedId = null;
        }
      }
    });
    // Double-click a text object → edit its content in place (DESIGN: like the
    // group-member targeting above, detected via e.detail since re-render detaches
    // the node before a real dblclick can fire).
    if (hitId !== null && e.detail >= 2 && !shiftHeld) {
      const _ho = _state.get().objects.find((o) => o.id === hitId);
      if (_ho && _ho.type === "text") {
        if (_textEditor) return; // already editing (e.g. opened by click-to-edit on press #1)
        startEditingTextObject(hitId, { x: e.clientX, y: e.clientY }); return;
      }
    }
    if (hitId === null && _at === "V") {
      _marqueeStart = { x: p.x, y: p.y };
      _marqueeEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      _marqueeEl.setAttribute("fill", "rgba(9,105,218,0.08)");
      _marqueeEl.setAttribute("stroke", "#0969da");
      _marqueeEl.setAttribute("stroke-width", "0.3");
      _marqueeEl.setAttribute("stroke-dasharray", "0.7 0.5");
      _marqueeEl.setAttribute("pointer-events", "none");
      _marqueeEl.setAttribute("x", p.x);
      _marqueeEl.setAttribute("y", p.y);
      _marqueeEl.setAttribute("width", "0");
      _marqueeEl.setAttribute("height", "0");
      _svg.appendChild(_marqueeEl);
    }
  });

  _svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;                 // left button only
    if (spaceHeld) return;                       // Space+left = pan, not draw
    const type = SHAPE_TYPE[_state.get().activeTool];
    if (!type) return;                           // only a shape tool draws
    e.preventDefault();

    const vb = _state.get().viewBox;
    startWorld = screenToWorld(_svg, vb, e.clientX, e.clientY);
    drawing = true;
    drawType = type;
    _state.update((s) => { s.draft = makeShape(drawType, startWorld, startWorld); });
  });

  // move/up on window so a fast drag that leaves the SVG still tracks.
  window.addEventListener("mousemove", (e) => {
    if (!drawing) return;
    const vb = _state.get().viewBox;
    const pointer = screenToWorld(_svg, vb, e.clientX, e.clientY);
    // Shift = aspect-ratio lock: force w === h (perfect square / circle) using the
    // larger of the two extents, preserving the drag direction on each axis.
    const cur = drawType === "line"
      ? snapLineEnd(startWorld, pointer, e.ctrlKey)
      : constrainShapeEnd(drawType, startWorld, pointer, e.shiftKey);
    _state.update((s) => { s.draft = makeShape(drawType, startWorld, cur); });
  });

  window.addEventListener("mouseup", (e) => {
    if (!drawing) return;
    drawing = false;
    const vb = _state.get().viewBox;
    const pointer = screenToWorld(_svg, vb, e.clientX, e.clientY);
    const cur = drawType === "line"
      ? snapLineEnd(startWorld, pointer, e.ctrlKey)
      : constrainShapeEnd(drawType, startWorld, pointer, e.shiftKey);
    const shape = makeShape(drawType, startWorld, cur);
    startWorld = null;
    drawType = null;

    _state.update((s) => {
      s.draft = null;
      // Only commit a real drag; a click with no movement draws nothing.
      if (isCommittable(shape)) {
        // Snapshot the pre-creation objects so a single Ctrl+Z removes this shape.
        const snap = JSON.parse(JSON.stringify(s.objects));
        shape.id = `obj_${Date.now().toString(36)}_${++_idCounter}`;
        shape.order = s.objects.length;
        shape.layerId = s.activeLayerId;
        s.objects.push(shape);
        s.undoStack.push(snap);
        s.redoStack = [];
        s.activeTool = "V"; // auto-return to select right after drawing (DESIGN 4-3)
      }
    });
  });

  // Marquee drag ??update the dashed selection rect while dragging empty space.
  window.addEventListener("mousemove", (e) => {
    if (!_marqueeStart) return;
    const vb = _state.get().viewBox;
    const cur = screenToWorld(_svg, vb, e.clientX, e.clientY);
    const rx = Math.min(_marqueeStart.x, cur.x);
    const ry = Math.min(_marqueeStart.y, cur.y);
    const rw = Math.abs(cur.x - _marqueeStart.x);
    const rh = Math.abs(cur.y - _marqueeStart.y);
    _marqueeEl.setAttribute("x", rx);
    _marqueeEl.setAttribute("y", ry);
    _marqueeEl.setAttribute("width", rw);
    _marqueeEl.setAttribute("height", rh);
  });

  // Marquee drag ??commit or cancel on mouse-up.
  window.addEventListener("mouseup", (e) => {
    if (!_marqueeStart) return;
    const vb = _state.get().viewBox;
    const cur = screenToWorld(_svg, vb, e.clientX, e.clientY);
    const start = _marqueeStart;
    _marqueeStart = null;
    if (_marqueeEl) { _marqueeEl.remove(); _marqueeEl = null; }

    const dist = Math.hypot(cur.x - start.x, cur.y - start.y);
    if (dist < 2) {
      // Plain empty-click ??clear selection.
      _state.update((s) => { s.selectedIds = []; s.targetedId = null; });
      return;
    }
    const rx = Math.min(start.x, cur.x);
    const ry = Math.min(start.y, cur.y);
    const rw = Math.abs(cur.x - start.x);
    const rh = Math.abs(cur.y - start.y);
    const selRect = { x: rx, y: ry, w: rw, h: rh };
    _state.update((s) => {
      s.targetedId = null;
      s.selectedIds = s.objects
        .filter((o) => {
          const _mLayerId = o.layerId ?? 1;
          const _mLayer = (s.layers || []).find(l => l.id === _mLayerId);
          if (!_mLayer || _mLayer.visible === false || _mLayerId !== s.activeLayerId) return false;
          const bb = getObjectBBox(o);
          return bb && bboxIntersects(bb, selRect);
        })
        .map((o) => o.id);
    });
  });

  window.addEventListener("pointercancel", () => {
    drawing = false;
    startWorld = null;
    drawType = null;
    _marqueeStart = null;
    if (_marqueeEl) { _marqueeEl.remove(); _marqueeEl = null; }
    _state.update((s) => { s.draft = null; });
  });

  // NOTE: targeting a group member on double-click is handled in the mousedown
  // handler above (e.detail >= 2). A dblclick listener can't be used here: every
  // mousedown re-renders (scene.replaceChildren) and detaches the clicked node
  // before mouseup, so the browser never fires click/dblclick on it.
}

function isObjectSelectable(state, obj) {
  if (!obj) return false;
  const layerId = obj.layerId ?? 1;
  const layer = (state.layers || []).find((item) => item.id === layerId);
  return !!layer && layer.visible !== false && layerId === state.activeLayerId;
}

function isBasicLine(obj) {
  if (!obj || obj.type !== "line") return false;
  const arrowHead = obj.arrowHead ?? "none";
  const mode = obj.lineMode ?? obj.lineStyle ?? (arrowHead === "none" ? "solid" : "arrow");
  const dashed = (obj.dashLength ?? 0) > 0 && (obj.dashGap ?? 0) > 0;
  return mode === "solid" && arrowHead === "none" && !dashed;
}

function basicLineHitThreshold(line, renderScale) {
  const visibleStrokePx = (line.strokeWidth ?? 0) * renderScale;
  const hitWidthPx = Math.max(visibleStrokePx * 3, BASIC_LINE_MIN_HIT_WIDTH_PX);
  return hitWidthPx / 2 / renderScale;
}

function nearestBasicLine(objects, p, renderScale, isSelectable = () => true) {
  let nearestId = null;
  let nearestDistance = Infinity;
  for (let i = objects.length - 1; i >= 0; i--) {
    const line = objects[i];
    if (!isBasicLine(line) || !isSelectable(line)) continue;
    const distance = segDist(p.x, p.y, line.p1.x, line.p1.y, line.p2.x, line.p2.y);
    if (distance <= basicLineHitThreshold(line, renderScale) && distance < nearestDistance) {
      nearestDistance = distance;
      nearestId = line.id;
    }
  }
  return nearestId;
}

function pickSelectableObject(state, p, tol, lineTol) {
  const selectableNonBasic = state.objects.filter((o) =>
    !isBasicLine(o) && isObjectSelectable(state, o)
  );
  const hitId = hitTest(selectableNonBasic, p, tol, lineTol);
  if (hitId !== null) return hitId;
  return nearestBasicLine(
    state.objects,
    p,
    getRenderScale(),
    (o) => isObjectSelectable(state, o)
  );
}

/* ===== CLICK-TO-CLICK DRAWING (line L + polyline P ??one shared mechanism) ===== */
//
// Both place vertices by CLICKING (no button hold). A running point list
// (draftPoints) is built one click at a time; a live SOLID rubber-band preview
// (state.draft, rendered as a polyline) runs from the last placed vertex to the
// mouse. The only difference between the tools is when they finish:
//   ??LINE (L): the 2-point case ??the 2nd click commits and finishes.
//   ??POLYLINE (P): many points ??double-click or Enter finishes (?? points).
// ESC cancels the whole draft (nothing committed). All clicks convert to world
// coords through the SHARED screenToWorld helper ??no new coordinate math.
const CLICK_TOOLS = { L: "line", P: "polyline", C: "curve", CIRCUIT: "circuit" };

let clickTool = null;     // armed click-to-click tool ("L"/"P"/"C"/"CIRCUIT") while drafting, else null
let draftPoints = [];     // world-space vertices placed so far
let mouseWorld = null;    // last mouse world pos, for the rubber-band segment

function setupClickDrawing() {
  // Each click appends a vertex. Line auto-commits at 2 points; polyline keeps going.
  _svg.addEventListener("click", (e) => {
    if (e.button !== 0) return;                  // left button only
    if (spaceHeld) return;                        // Space+click = pan, not draw
    const tool = _state.get().activeTool;
    if (tool === "ARC") { handleArcClick(e); return; } // two-click anglearc placement
    if (!CLICK_TOOLS[tool]) return;               // only L / P place points
    const vb = _state.get().viewBox;
    let cur = screenToWorld(_svg, vb, e.clientX, e.clientY);
    // Apply the SAME Ctrl angle snap used for the live preview so the COMMITTED
    // endpoint is identical to what the preview showed (no last-pixel drift —
    // a horizontal preview commits an exactly horizontal line). See snapAngle.
    if (e.ctrlKey && (tool === "L" || tool === "P" || tool === "CIRCUIT") && draftPoints.length > 0) {
      cur = snapAngle(draftPoints[draftPoints.length - 1], cur);
    }
    draftPoints.push(cur);
    clickTool = tool;

    if (tool === "L" && draftPoints.length === 2) { commitLine(); return; }
    if (tool === "CIRCUIT" && draftPoints.length === 2) { commitCircuit(); return; } // two-click, like line
    updateDraftPreview();                         // refresh the committed-segments preview
  });

  // Rubber-band: redraw preview from the placed points to the live mouse.
  window.addEventListener("mousemove", (e) => {
    if (!clickTool) return;
    const vb = _state.get().viewBox;
    let cur = screenToWorld(_svg, vb, e.clientX, e.clientY);
    // Ctrl = 15° angle snap (line / polyline / circuit). The preview uses the SAME
    // shared snapAngle helper as the commit path above, so they can never diverge.
    if (e.ctrlKey && (clickTool === "L" || clickTool === "P" || clickTool === "CIRCUIT") && draftPoints.length > 0) {
      cur = snapAngle(draftPoints[draftPoints.length - 1], cur);
    }
    mouseWorld = cur;
    updateDraftPreview();
  });

  // Double-click finishes a polyline or curve. Its two click events already
  // appended a duplicate vertex at the finish spot, so drop it before committing.
  _svg.addEventListener("dblclick", () => {
    if (clickTool !== "P" && clickTool !== "C") return;
    if (draftPoints.length > 0) draftPoints.pop();
    finishPolyline();
  });

  // Enter finishes a polyline/curve; Esc cancels any in-progress click draft.
  window.addEventListener("keydown", (e) => {
    if (!clickTool) return;
    if (e.key === "Escape") { e.preventDefault(); resetClickDraft(); }
    else if (e.key === "Enter" && (clickTool === "P" || clickTool === "C")) { e.preventDefault(); finishPolyline(); }
  });
}

/* ----- Ctrl angle snap: snap the segment from `anchor` to `cur` to the nearest
 * 15° increment, keeping the same length. For axis-aligned angles (0/90/180/270)
 * the off-axis component is zeroed EXACTLY, so a horizontal stays exactly
 * horizontal (p1.y === p2.y) and a vertical stays exactly vertical (p1.x === p2.x)
 * with no float drift. Shared by BOTH the preview and the commit so they match. */
function snapAngle(anchor, cur) {
  const dx = cur.x - anchor.x, dy = cur.y - anchor.y;
  const dist = Math.hypot(dx, dy);
  const deg = Math.round((Math.atan2(dy, dx) * 180 / Math.PI) / 15) * 15;
  const rad = (deg * Math.PI) / 180;
  let nx = Math.cos(rad), ny = Math.sin(rad);
  const n = ((deg % 360) + 360) % 360;
  if (n === 0 || n === 180) ny = 0;   // horizontal: exact
  if (n === 90 || n === 270) nx = 0;  // vertical: exact
  return { x: anchor.x + nx * dist, y: anchor.y + ny * dist };
}

// Live preview = the placed segments PLUS a rubber-band from the last vertex to
// the mouse. For curve, renders as a smooth curve preview so it matches the result.
function updateDraftPreview() {
  if (!clickTool || draftPoints.length === 0) return;
  if (clickTool === "ARC") { updateArcPreview(); return; }
  if (clickTool === "CIRCUIT") {
    // Live preview: leads + body, rebuilt from p1 and the floating mouse (p2).
    const end = mouseWorld || draftPoints[0];
    _state.update((s) => { s.draft = makeCircuit(draftPoints[0], end); });
    return;
  }
  const pts = mouseWorld ? [...draftPoints, mouseWorld] : draftPoints.slice();
  _state.update((s) => { s.draft = clickTool === "C" ? makeCurve(pts) : makePolyline(pts); });
}

// LINE: exactly two clicks. Commit a real line object, or cancel a zero-length one.
function commitLine() {
  const line = makeLine(draftPoints[0], draftPoints[1]);
  if (isCommittable(line)) commitClickShape(line);
  else resetClickDraft();
}

// CIRCUIT: exactly two clicks, mirroring the line tool. Commit one circuit object
// (undoable, auto-selected, returns to V via commitClickShape) or cancel a
// zero-length placement.
function commitCircuit() {
  const circ = makeCircuit(draftPoints[0], draftPoints[1]);
  if (isCommittable(circ)) commitClickShape(circ);
  else resetClickDraft();
}

/* ===== ANGLE ARC (ARC): two-click placement, mirroring the line tool ===== */
//
// Reuses the SAME click-to-click locals (draftPoints / mouseWorld / clickTool)
// and the SAME store commit path as the line tool — no new interaction machinery.
//   * Click 1 → vertex (x,y).
//   * Move    → live preview (vertex + rubber-band radius + arc; see render.js).
//   * Click 2 → start point: radius = dist(vertex,pt2), startAngle = atan2
//               direction vertex→pt2 in MATH convention (+Y up, like the inspector).
// sweepAngle defaults to 60°, refined afterward via the inspector/handles (no
// third click). Commit auto-selects the arc and returns to V; switching tools or
// ESC mid-gesture discards the draft (handled by setActiveTool / the ESC keydown).
function handleArcClick(e) {
  const vb = _state.get().viewBox;
  const cur = screenToWorld(_svg, vb, e.clientX, e.clientY);
  draftPoints.push(cur);
  clickTool = "ARC";
  mouseWorld = cur;
  if (draftPoints.length >= 2) { commitArc(); return; }
  updateArcPreview();
}

// Build an anglearc draft from the vertex and a point on its start radius. Mirrors
// the template's anglearc shape (templates.js) so the inspector works post-commit.
function makeAngleArcDraft(vertex, point) {
  const dx = point.x - vertex.x, dy = point.y - vertex.y;
  const radius = Math.hypot(dx, dy);
  // Math convention (+Y up): world y grows downward, so negate dy for atan2.
  const startAngle = Math.atan2(-dy, dx) * 180 / Math.PI;
  return {
    id: null,                 // assigned on commit
    type: "anglearc",
    x: vertex.x,              // arc vertex
    y: vertex.y,
    radius,
    startAngle,               // math convention (CCW positive, +Y up)
    sweepAngle: 60,           // default opening (deg); refined via inspector/handles
    label: "θ",
    showLabel: true,
    strokeLevel: 0,           // 0 = black (DESIGN 2-2)
    strokeWidth: DEFAULT_STROKE_WIDTH,
    locked: false,
    positionLocked: false,
    layerId: 1,
    order: 0,                 // assigned on commit
  };
}

// Live preview: vertex + rubber-band radius + arc, driven by the floating mouse.
function updateArcPreview() {
  if (draftPoints.length === 0) return;
  const v = draftPoints[0];
  const m = mouseWorld || v;
  _state.update((s) => { s.draft = makeAngleArcDraft(v, m); });
}

// Click 2 commits the arc through the shared store path (or discards a zero-radius
// placement, exactly like a zero-length line is discarded).
function commitArc() {
  const arc = makeAngleArcDraft(draftPoints[0], draftPoints[1]);
  if ((arc.radius || 0) < MIN_SIZE) { resetClickDraft(); return; }
  commitClickShape(arc);
}

// POLYLINE / CURVE: needs ?? vertices; otherwise the draft is discarded.
function finishPolyline() {
  if (draftPoints.length < 2) { resetClickDraft(); return; }
  const shape = clickTool === "C" ? makeCurve(draftPoints) : makePolyline(draftPoints);
  commitClickShape(shape);
}

// Push a finished click-to-click shape through the SAME store path as the drag
// flow (id + z-order assigned on commit), then auto-return to V (DESIGN 4-3).
function commitClickShape(shape) {
  _state.update((s) => {
    // Snapshot the pre-creation objects so a single Ctrl+Z removes this shape.
    const snap = JSON.parse(JSON.stringify(s.objects));
    shape.id = `obj_${Date.now().toString(36)}_${++_idCounter}`;
    shape.order = s.objects.length;
    shape.layerId = s.activeLayerId;
    s.objects.push(shape);
    s.undoStack.push(snap);
    s.redoStack = [];
    s.draft = null;
    s.activeTool = "V";
  });
  clearClickLocals();
}

function clearClickLocals() {
  draftPoints = [];
  clickTool = null;
  mouseWorld = null;
}

function resetClickDraft() {
  clearClickLocals();
  if (_state.get().draft) _state.update((s) => { s.draft = null; });
}

/* ----- commit gate: ignore stray clicks that drew nothing ----- */
// Size-based shapes need a non-trivial box; a line needs a non-trivial length.
function isCommittable(shape) {
  if (shape.type === "line" || shape.type === "circuit") {
    return Math.hypot(shape.p2.x - shape.p1.x, shape.p2.y - shape.p1.y) >= MIN_SIZE;
  }
  return shape.w >= MIN_SIZE && shape.h >= MIN_SIZE;
}

/* ----- hit-test: topmost shape whose ACTUAL outline/interior (grown outward) contains p ----- */
// Array order = z-order (last = top), so scan from the end. Each shape is tested
// against its REAL geometry (not just its bbox), expanded OUTWARD by margin =
// strokeWidth/2 (to reach the stroke's outer edge) + tol (a few screen px of
// click slack). Rect's bbox == its shape, so it keeps the bbox test; the ellipse
// and triangle use shape-specific tests so the empty bbox corners do NOT select.
function hitTest(objects, p, tol = 0, lineTol = tol) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type !== "rect" && o.type !== "ellipse" && o.type !== "triangle" &&
        o.type !== "line" && o.type !== "polyline" && o.type !== "curve" &&
        o.type !== "text" && o.type !== "image" && o.type !== "axes" &&
        o.type !== "anglearc" && o.type !== "circuit" && o.type !== "optics") continue;

    if (o.type === "text") {
      // Use the rendered SVG element's getBBox for an accurate hit area.
      const svgEl = _svg.querySelector(`[data-id="${o.id}"]`);
      if (!svgEl) continue;
      try {
        const bb = svgEl.getBBox();
        if (p.x >= bb.x - tol && p.x <= bb.x + bb.width + tol &&
            p.y >= bb.y - tol && p.y <= bb.y + bb.height + tol) return o.id;
      } catch (_) { /* element not in layout yet */ }
      continue;
    }
    // A line has no area: clickable band = stroke half-width + the screen-px
    // slack already converted to world units (tol = tolerancePx / currentZoom),
    // so the band stays visually constant at any zoom (DESIGN-style tolerance).
    const margin = (o.strokeWidth || 0) / 2 +
      ((o.type === "line" || o.type === "polyline" || o.type === "curve" || o.type === "circuit") ? lineTol : tol);

    if (o.type === "line") {
      if (segDist(p.x, p.y, o.p1.x, o.p1.y, o.p2.x, o.p2.y) <= margin) return o.id;
      continue;
    }

    if (o.type === "circuit") {
      // Reuse the line hit-test along the p1→p2 axis (covers both leads and the
      // body's center line), plus the body box polygon for clicks on its off-axis
      // area. circuitBodyPolygon() is the SAME geometry the renderer draws.
      if (segDist(p.x, p.y, o.p1.x, o.p1.y, o.p2.x, o.p2.y) <= margin) return o.id;
      if (pointInPolygon(p.x, p.y, circuitBodyPolygon(o))) return o.id;
      continue;
    }

    if (o.type === "polyline") {
      // Hit if within margin of ANY segment between consecutive vertices.
      const pts = o.points || [];
      for (let k = 0; k < pts.length - 1; k++) {
        if (segDist(p.x, p.y, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) <= margin) return o.id;
      }
      // A CLOSED polyline behaves like a face: also test the closing edge AND
      // the interior (ray casting), so an inside click selects it too ??the
      // outline still selects via the segment loop above. Open polyline: edges only.
      if (isClosedPoly(o) && pts.length >= 3) {
        const last = pts[pts.length - 1], first = pts[0];
        if (segDist(p.x, p.y, last.x, last.y, first.x, first.y) <= margin) return o.id;
        if (pointInPolygon(p.x, p.y, pts)) return o.id;
      }
      continue;
    }

    if (o.type === "curve") {
      const pts = o.points || [];
      if (pts.length < 2) continue;
      if (pts.length === 2) {
        if (segDist(p.x, p.y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) <= margin) return o.id;
        continue;
      }
      const SAMPLES = 12;
      // A CLOSED curve behaves like a face: sample EVERY span (incl. the closing
      // last?뭚irst span) finely into a polygon approximation, then accept an
      // interior click via point-in-polygon. The on-curve outline still hits too.
      if (isClosedCurve(o) && pts.length >= 3) {
        const poly = [];
        let hit = false;
        for (let k = 0; k < pts.length; k++) {
          const seg = curveBezierSegClosed(pts, k);
          let prev = { x: seg.sx, y: seg.sy };
          poly.push(prev);
          for (let s = 1; s <= SAMPLES; s++) {
            const cur = evalBezier(seg, s / SAMPLES);
            if (segDist(p.x, p.y, prev.x, prev.y, cur.x, cur.y) <= margin) hit = true;
            poly.push(cur);
            prev = cur;
          }
        }
        if (hit) return o.id;
        if (pointInPolygon(p.x, p.y, poly)) return o.id;
        continue;
      }
      // OPEN curve: sample each Catmull-Rom Bezier segment for fine outline hits.
      let hit = false;
      for (let k = 0; k < pts.length - 1 && !hit; k++) {
        const seg = curveBezierSeg(pts, k);
        let prev = { x: seg.sx, y: seg.sy };
        for (let s = 1; s <= SAMPLES; s++) {
          const cur = evalBezier(seg, s / SAMPLES);
          if (segDist(p.x, p.y, prev.x, prev.y, cur.x, cur.y) <= margin) { hit = true; break; }
          prev = cur;
        }
      }
      if (hit) return o.id;
      continue;
    }

    if (o.type === "rect" || o.type === "image" || o.type === "axes" || o.type === "optics") {
      // box == actual shape: outward-grown bbox containment (axes/optics select as
      // one indivisible object via the bounding box; same as rect)
      if (p.x >= o.x - margin && p.x <= o.x + o.w + margin &&
          p.y >= o.y - margin && p.y <= o.y + o.h + margin) return o.id;
      continue;
    }

    if (o.type === "anglearc") {
      // Selects as ONE indivisible object via its vertex-centered square bbox
      // (the transparent pie-sector body also makes the wedge a drag target).
      const r = o.radius || 0;
      if (p.x >= o.x - r - margin && p.x <= o.x + r + margin &&
          p.y >= o.y - r - margin && p.y <= o.y + r + margin) return o.id;
      continue;
    }

    if (o.type === "ellipse") {
      // inside the ellipse curve, grown outward by margin on each radius
      const rx = o.w / 2 + margin, ry = o.h / 2 + margin;
      if (rx <= 0 || ry <= 0) continue;
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      const nx = (p.x - cx) / rx, ny = (p.y - cy) / ry;
      if (nx * nx + ny * ny <= 1) return o.id;
      continue;
    }

    if (o.type === "triangle") {
      // vertices (DESIGN render order): bottom-left, bottom-right, top-left
      const ax = o.x,       ay = o.y + o.h;
      const bx = o.x + o.w, by = o.y + o.h;
      const cx = o.x,       cy = o.y;
      if (pointInTriangle(p.x, p.y, ax, ay, bx, by, cx, cy)) return o.id;
      // hollow shapes also accept a click within margin of any edge
      if (o.fillNone && (
          segDist(p.x, p.y, ax, ay, bx, by) <= margin ||
          segDist(p.x, p.y, bx, by, cx, cy) <= margin ||
          segDist(p.x, p.y, cx, cy, ax, ay) <= margin)) return o.id;
      continue;
    }
  }
  return null;
}

/* ----- axis-aligned bounding box of any object (for marquee intersection) ----- */
function getObjectBBox(o) {
  if (o.type === "rect" || o.type === "ellipse" || o.type === "triangle" || o.type === "image" || o.type === "axes" || o.type === "optics") {
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
  if (o.type === "anglearc") {
    const r = o.radius || 0;
    return { x: o.x - r, y: o.y - r, w: 2 * r, h: 2 * r };
  }
  if (o.type === "line" || o.type === "circuit") {
    return {
      x: Math.min(o.p1.x, o.p2.x), y: Math.min(o.p1.y, o.p2.y),
      w: Math.abs(o.p2.x - o.p1.x), h: Math.abs(o.p2.y - o.p1.y),
    };
  }
  if (o.type === "polyline" || o.type === "curve") {
    const pts = o.points || [];
    if (!pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of pts) {
      if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (o.type === "text") {
    const svgEl = _svg.querySelector(`[data-id="${o.id}"]`);
    if (!svgEl) return null;
    try { const bb = svgEl.getBBox(); return { x: bb.x, y: bb.y, w: bb.width, h: bb.height }; }
    catch (_) { return null; }
  }
  return null;
}

/* ----- AABB intersection test (touching counts as intersecting) ----- */
function bboxIntersects(a, b) {
  return a.x <= b.x + b.w && a.x + a.w >= b.x &&
         a.y <= b.y + b.h && a.y + a.h >= b.y;
}

/* ----- point-in-triangle via consistent sign of edge cross products ----- */
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/* ----- point-in-polygon via ray casting (for closed-polyline interior hits) ----- */
function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    const intersect = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/* ----- shortest distance from point (px,py) to segment (ax,ay)-(bx,by) ----- */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

/* ----- build a size-based shape from two world points (handles negative drags) ----- */
// DESIGN 2-1 branch A (size-based): x/y is the top-left, w/h are positive.
// `type` is "rect" | "ellipse" | "triangle"; all share this identical structure.
function makeShape(type, a, b) {
  if (type === "line") return makeLine(a, b);
  const shape = {
    id: null, // assigned on commit
    type,
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
    rotation: 0,
    strokeLevel: 0,        // 0 = black (DESIGN 2-2)
    strokeWidth: DEFAULT_STROKE_WIDTH,
    fillLevel: 214,
    fillNone: false,
    fillStyle: "solid",   // "solid" | "dots" | "cross" | "hatch"
    dashLength: 0,
    dashGap: 0,
    locked: false,
    positionLocked: false,
    layerId: 1,
    order: 0,              // assigned on commit (z-order within layer)
  };
  if (type === "triangle") shape.flipX = b.x < a.x;
  // Optics (branch A): reuse the size-drag box wholesale; only kind + label fields
  // are added. Default fillNone so lenses/mirrors drop as clean outlines.
  if (type === "optics") {
    shape.kind = _opticsKind || "convex_lens";
    shape.label = "";
    shape.showLabel = false;
    shape.fillNone = true;
    // Center dashed-line option: convex/concave lenses only (default off).
    if (shape.kind === "convex_lens" || shape.kind === "concave_lens") {
      shape.centerLine = "none";
    }
  }
  return shape;
}

/* ----- build an endpoint-based line from two world points (DESIGN 2-1 branch B) ----- */
// A line is defined by TWO endpoints (p1/p2), not x/y/w/h, and has no fill.
function makeLine(a, b) {
  return {
    id: null, // assigned on commit
    type: "line",
    p1: { x: a.x, y: a.y },
    p2: { x: b.x, y: b.y },
    rotation: 0,
    strokeLevel: 0,        // 0 = black (DESIGN 2-2)
    strokeWidth: DEFAULT_STROKE_WIDTH,
    // ----- branch-B common line props (arrow + dashes) -----
    lineMode: "solid",     // "solid" | "arrow" | "middleArrow" | "lengthArrow"
    lineStyle: "solid",    // legacy alias retained for project compatibility
    arrowVariant: "right",
    dimensionVariant: "basic",
    arrowHead: "none",     // "none" | "end" | "start" | "both"
    dashLength: 0,         // world units (mm); 0 = solid (no dasharray)
    dashGap: 0,            // world units (mm); 0 = solid
    locked: false,
    positionLocked: false,
    layerId: 1,
    order: 0,              // assigned on commit (z-order within layer)
  };
}

/* ----- build a circuit element from two terminals (branch B, same family as line) ----- */
// Two endpoints (p1/p2), one label, one element kind. Leads + body geometry are
// PROJECTION (derived at render time from p1/p2), never stored — see render.js.
function makeCircuit(a, b) {
  const element = _circuitElement || "resistor";
  const obj = {
    id: null,                 // assigned on commit
    type: "circuit",
    element,                  // render dispatches the body on this
    p1: { x: a.x, y: a.y },   // left terminal
    p2: { x: b.x, y: b.y },   // right terminal
    label: "",                // single optional text label (empty allowed)
    strokeLevel: 0,           // 0 = black (DESIGN 2-2)
    strokeWidth: DEFAULT_STROKE_WIDTH,
    locked: false,
    positionLocked: false,
    layerId: 1,
    order: 0,                 // assigned on commit (z-order within layer)
  };
  // Element-specific data fields (only the relevant element carries each).
  if (element === "capacitor") obj.gap = CIRCUIT_CAP_GAP_DEFAULT; // plate separation (world mm)
  if (element === "diode") obj.terminalLabels = ["", ""];          // 단자1 / 단자2
  return obj;
}

/* ----- build a polyline from a list of world points (click-to-click) ----- */
// Many vertices, connected in order; no fill. Used both for the live preview
// (placed points + floating mouse) and the committed object.
function makePolyline(points) {
  return {
    id: null, // assigned on commit
    type: "polyline",
    points: points.map((p) => ({ x: p.x, y: p.y })),
    rotation: 0,
    strokeLevel: 0,        // 0 = black (DESIGN 2-2)
    strokeWidth: DEFAULT_STROKE_WIDTH,
    // ----- branch-B common line props (arrow + dashes) -----
    arrowHead: "none",     // "none" | "end" | "start" | "both"
    dashLength: 0,         // world units (mm); 0 = solid (no dasharray)
    dashGap: 0,            // world units (mm); 0 = solid
    // ----- closed-fill props: a closed polyline behaves like a fillable shape -----
    closed: false,         // false = open <polyline>; true = filled <polygon>
    fillLevel: 214,        // mark/solid shade when closed
    fillNone: false,
    fillStyle: "solid",    // "solid" | "dots" | "cross" | "hatch"
    locked: false,
    positionLocked: false,
    layerId: 1,
    order: 0,              // assigned on commit (z-order within layer)
  };
}

/* ----- build a curve from a list of world points (click-to-click, Catmull-Rom) ----- */
function makeCurve(points) {
  return {
    id: null,
    type: "curve",
    points: points.map((p) => ({ x: p.x, y: p.y })),
    rotation: 0,
    strokeLevel: 0,
    strokeWidth: DEFAULT_STROKE_WIDTH,
    // ----- branch-B common line props (curve: dashes only this round) -----
    arrowHead: "none",     // schema-common; curve excluded from arrowheads for now
    dashLength: 0,         // world units (mm); 0 = solid (no dasharray)
    dashGap: 0,            // world units (mm); 0 = solid
    // ----- closed-fill props: a closed curve behaves like a fillable shape -----
    closed: false,         // false = open <path>; true = smoothly-closed filled <path>
    fillLevel: 214,        // mark/solid shade when closed
    fillNone: false,
    fillStyle: "solid",    // "solid" | "dots" | "cross" | "hatch"
    locked: false,
    positionLocked: false,
    layerId: 1,
    order: 0,
  };
}

/* ----- Catmull-Rom cubic Bezier control points for segment i ??i+1 ----- */
function curveBezierSeg(pts, i) {
  const n = pts.length;
  const p0 = pts[Math.max(i - 1, 0)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(i + 2, n - 1)];
  return {
    sx: p1.x, sy: p1.y,
    cp1x: p1.x + (p2.x - p0.x) / 6, cp1y: p1.y + (p2.y - p0.y) / 6,
    cp2x: p2.x - (p3.x - p1.x) / 6, cp2y: p2.y - (p3.y - p1.y) / 6,
    ex: p2.x, ey: p2.y,
  };
}

/* ----- closed-curve Bezier control points for span i ??i+1 (indices wrap) ----- */
// The closing span (last ??first) is span i = n-1; neighbors wrap modulo n so the
// whole loop stays smooth, mirroring render's catmullRomClosedPath.
function curveBezierSegClosed(pts, i) {
  const n = pts.length;
  const p0 = pts[(i - 1 + n) % n];
  const p1 = pts[i];
  const p2 = pts[(i + 1) % n];
  const p3 = pts[(i + 2) % n];
  return {
    sx: p1.x, sy: p1.y,
    cp1x: p1.x + (p2.x - p0.x) / 6, cp1y: p1.y + (p2.y - p0.y) / 6,
    cp2x: p2.x - (p3.x - p1.x) / 6, cp2y: p2.y - (p3.y - p1.y) / 6,
    ex: p2.x, ey: p2.y,
  };
}

/* ----- evaluate cubic Bezier at parameter t ??[0,1] ----- */
function evalBezier(seg, t) {
  const u = 1 - t;
  return {
    x: u*u*u*seg.sx + 3*u*u*t*seg.cp1x + 3*u*t*t*seg.cp2x + t*t*t*seg.ex,
    y: u*u*u*seg.sy + 3*u*u*t*seg.cp1y + 3*u*t*t*seg.cp2y + t*t*t*seg.ey,
  };
}

/* ===== TEXT TOOL (T) — create, edit-in-place, font menu, font modal ===== */
//
// A native <textarea> overlay owns the glyphs, selection, IME composition, and
// caret while editing. Committed text is rendered as SVG after the overlay is
// closed. The draft carries an `editingId`: null for new text, or an existing
// object's id when re-editing it in place.
//
// Enter commits; Shift+Enter inserts a newline; ESC cancels (restoring the
// original when editing an existing object).

let _textEditor = null;     // the live capture <textarea>, or null
let _textAnchor = null;     // world-space {x,y} of the text origin
let _textCancelled = false; // set by ESC so blur doesn't double-commit

function setupTextTool() {
  _svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (spaceHeld) return;
    if (_state.get().activeTool !== "T") return;
    e.preventDefault();

    // Clicking again while an editor is open commits the current one first.
    if (_textEditor) { _commitText(); return; }

    const anchor = screenToWorld(_svg, _state.get().viewBox, e.clientX, e.clientY);
    const _sc = worldToScreen(_svg, _state.get().viewBox, anchor.x, anchor.y);
    // WYSIWYG: desired on-screen px → WORLD units via the TRUE render scale.
    const worldFontSize = DEFAULT_TEXT_SIZE_MM;
    _openTextEditor({
      x: anchor.x, y: anchor.y, text: "",
      fontSize: worldFontSize, fontFamily: DEFAULT_TEXT_FONT,
      fontWeight: "normal", fontStyle: "normal",
      underline: false, strikeout: false, rotation: 0,
      editingId: null,
    }, _sc.x, _sc.y, "");
  });
}

// Begin editing an EXISTING text object in place: prefill the editor with its
// content and copy ALL of its style into the draft, so the preview matches and
// the commit preserves style + id. `clickPt` = client {x,y} of the mouse click
// that opened the editor (or null for F2 / context-menu); when given, the caret
// is placed at the clicked character instead of at the end.
function startEditingTextObject(objId, clickPt = null) {
  if (_textEditor) _commitText();
  const s = _state.get();
  const o = s.objects.find((x) => x.id === objId);
  if (!o || o.type !== "text") return;
  const sc = worldToScreen(_svg, s.viewBox, o.x, o.y);
  _openTextEditor({
    x: o.x, y: o.y, text: o.text || "",
    fontSize: o.fontSize,
    fontFamily: o.fontFamily || DEFAULT_TEXT_FONT,
    fontWeight: o.fontWeight || "normal",
    fontStyle: o.fontStyle || "normal",
    underline: !!o.underline, strikeout: !!o.strikeout,
    rotation: o.rotation ?? 0,
    editingId: o.id,
  }, sc.x, sc.y, o.text || "", clickPt);
}

/* ----- click → caret index: map a mouse click to the closest character index
 * in the editor overlay, so editing-by-click drops the caret where the user
 * clicked (not at the end). Measures with the SAME font as the overlay via a
 * reusable canvas, and segments Korean correctly (Intl.Segmenter → graphemes,
 * falling back to code-point iteration) so syllables are never split. */
let _measureCanvas = null;
function _measureCtx() {
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  return _measureCanvas.getContext("2d");
}

// Caret index (UTF-16) in the overlay value for a client-space click point.
// A DOM text mirror is necessary because textarea contents live in a user-agent
// shadow tree that caretPositionFromPoint does not expose consistently.
function _caretIndexFromPoint(clientX, clientY) {
  if (!_textEditor) return null;

  // Chromium exposes the native textarea offset directly. This is the ideal
  // path because it is exactly the index a real click will put in selectionStart.
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(clientX, clientY);
    if (pos && pos.offsetNode === _textEditor) {
      return Math.max(0, Math.min(_textEditor.value.length, pos.offset));
    }
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(clientX, clientY);
    if (range && range.startContainer === _textEditor) {
      return Math.max(0, Math.min(_textEditor.value.length, range.startOffset));
    }
  }

  // Fallback for engines that keep textarea contents fully inside their
  // user-agent shadow tree: query an identically styled DOM text node.
  const mirror = document.createElement("div");
  mirror.className = "text-editor-overlay";
  mirror.setAttribute("aria-hidden", "true");
  mirror.textContent = _textEditor.value || "\u200b";
  mirror.style.cssText = _textEditor.style.cssText;
  mirror.style.height = _textEditor.clientHeight + "px";
  mirror.style.minWidth = "0";
  mirror.style.color = "transparent";
  mirror.style.background = "transparent";
  mirror.style.whiteSpace = "pre";
  mirror.style.overflow = "hidden";
  mirror.style.pointerEvents = "auto";
  mirror.style.zIndex = "2147483647";
  _textEditor.parentElement.appendChild(mirror);

  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(clientX, clientY);
    if (pos) { node = pos.offsetNode; offset = pos.offset; }
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(clientX, clientY);
    if (range) { node = range.startContainer; offset = range.startOffset; }
  }

  let index = null;
  if (node && mirror.contains(node)) {
    const before = document.createRange();
    before.setStart(mirror, 0);
    before.setEnd(node, offset);
    index = before.toString().length;
  }
  mirror.remove();
  return index == null ? null : Math.max(0, Math.min(_textEditor.value.length, index));
}

// Shared: seed the draft, build the capture textarea, wire its listeners.
// clientX/clientY = screen px of the text's top-left anchor.
// caretClick = client {x,y} of the opening mouse click, or null (F2 / menu).
function _openTextEditor(draft, clientX, clientY, prefill, caretClick = null) {
  _textAnchor = { x: draft.x, y: draft.y };
  // While editing, the textarea renders both glyphs and caret. Keeping those in
  // one native layout is what makes selectionStart match the visible position.
  draft.nativeEditor = true;
  _state.update((s) => { s.draftText = draft; });

  const wrap = _svg.closest(".canvas-wrap");
  const wr = wrap.getBoundingClientRect();

  _textCancelled = false;
  _textEditor = document.createElement("textarea");
  _textEditor.className = "text-editor-overlay";
  // This is a capture overlay, not for proofing — kill native spellcheck so the
  // (misaligned, dpr-dependent) red underline never appears.
  _textEditor.spellcheck = false;
  _textEditor.setAttribute("autocorrect", "off");
  _textEditor.setAttribute("autocapitalize", "off");
  // SVG text wraps only at real newlines. Soft wrapping would make the editor
  // show line breaks that do not exist in the stored/rendered string.
  _textEditor.wrap = "off";
  // Half-leading must match the editor's REAL font size (set dynamically in
  // _syncEditorFont as dt.fontSize * getRenderScale()) and CSS line-height 1.4,
  // not the static TEXT_HALF_LEADING_PX (fixed px), or glyphs shift on edit.
  const _editorPx = _state.get().draftText.fontSize * getRenderScale();
  const _halfLeading = _editorPx * (1.4 - 1) / 2;   // matches CSS line-height:1.4
  _textEditor.style.left = (clientX - wr.left) + "px";
  _textEditor.style.top  = (clientY - wr.top - _halfLeading) + "px";
  _textEditor.value = prefill || "";
  _textEditor.rows = Math.max(1, (prefill || "").split("\n").length);
  _syncEditorFont();
  _textEditor.style.transformOrigin = `0 ${_halfLeading}px`;
  _textEditor.style.transform = draft.rotation ? `rotate(${draft.rotation}deg)` : "none";
  wrap.appendChild(_textEditor);
  _textEditor.focus();
  // Caret at end (not select-all) so editing existing text doesn't wipe it on
  // the first keystroke. F2 / context-menu keep this end caret.
  const _len = _textEditor.value.length;
  _textEditor.setSelectionRange(_len, _len);
  // Mouse-click editing: let the browser map its own glyph layout to an index.
  if (caretClick) {
    // Defer to the next frame so getBoundingClientRect/getComputedStyle read the
    // overlay AFTER layout (size/position settled) — otherwise the caret mapping
    // is measured against a stale box and snaps to 0/end.
    requestAnimationFrame(() => {
      if (!_textEditor) return;
      const idx = _caretIndexFromPoint(caretClick.x, caretClick.y);
      if (idx != null) _textEditor.setSelectionRange(idx, idx);
    });
  }

  _textEditor.addEventListener("input", () => {
    _textEditor.rows = Math.max(1, _textEditor.value.split("\n").length);
    _syncEditorWidth(); // keep trailing click-room past the (new) last character
    const val = _textEditor.value;
    _state.update((s) => { if (s.draftText) s.draftText.text = val; });
  });

  _textEditor.addEventListener("keydown", (ke) => {
    if (ke.key === "Escape") {
      ke.preventDefault();
      _textCancelled = true;
      _cancelText();
    } else if (ke.key === "Enter" && !ke.shiftKey) {
      ke.preventDefault();
      _commitText();
    }
    // Shift+Enter falls through → native newline in textarea
  });

  _textEditor.addEventListener("blur", (be) => {
    if (_textCancelled) return;
    // Don't commit if focus moved into the font menu/modal — those refocus the
    // editor afterwards so the draft survives the font change.
    if (be.relatedTarget && _elInTextUI(be.relatedTarget)) return;
    // A right-click (to open the font menu) also blurs the editor.
    if (_rightMouseDown) return;
    _commitText();
  });
}

// True when an element lives inside the text context menu or the font modal.
function _elInTextUI(el) {
  return (_ctxMenu && _ctxMenu.contains(el)) || (_fontModal && _fontModal.contains(el));
}

// Keep the capture textarea's caret sized/styled to the draft (on-screen px).
function _syncEditorFont() {
  if (!_textEditor) return;
  const dt = _state.get().draftText;
  if (!dt) return;
  _textEditor.style.fontSize   = (dt.fontSize * getRenderScale()) + "px";
  _textEditor.style.fontFamily = dt.fontFamily || DEFAULT_TEXT_FONT;
  _textEditor.style.fontWeight = dt.fontWeight || "normal";
  _textEditor.style.fontStyle  = dt.fontStyle  || "normal";
  const deco = [];
  if (dt.underline) deco.push("underline");
  if (dt.strikeout) deco.push("line-through");
  _textEditor.style.textDecoration = deco.join(" ") || "none";
  _syncEditorWidth();
}

// Grow the capture textarea to fit its widest line PLUS one trailing em, measured
// with the editor's OWN font. The textarea uses white-space:pre + overflow:hidden,
// so a fixed cols-based width clips long text and makes the region AFTER the last
// character unclickable — the user then can't drop the caret at text.length. The
// extra em guarantees a clickable insertion zone past the final glyph at any length.
function _syncEditorWidth() {
  if (!_textEditor) return;
  const st = _textEditor.style;
  const fontCss = `${st.fontStyle || "normal"} ${st.fontWeight || "normal"} ` +
    `${st.fontSize || (TEXT_EDITOR_PX + "px")} ${st.fontFamily || DEFAULT_TEXT_FONT}`;
  const ctx = _measureCtx();
  ctx.font = fontCss;
  let maxW = 0;
  for (const line of _textEditor.value.split("\n")) {
    const w = ctx.measureText(line).width;
    if (w > maxW) maxW = w;
  }
  const em = parseFloat(st.fontSize) || TEXT_EDITOR_PX;
  _textEditor.style.width = Math.ceil(maxW + em) + "px";
}

function _removeTextEditor() {
  if (_textEditor) {
    const el = _textEditor;
    _textEditor = null; // null first to prevent blur re-entrancy
    el.remove();
  }
  _textAnchor = null;
}

// ESC / tool-switch: drop the draft, commit nothing. When editing an existing
// object, render.js stops skipping it once draftText clears → original restored.
function _cancelText() {
  _removeTextEditor();
  if (_state.get().draftText) _state.update((s) => { s.draftText = null; });
}

function _commitText() {
  if (!_textEditor) return;
  const dt = _state.get().draftText;
  const val = dt ? dt.text : _textEditor.value;
  const fromTool = _state.get().activeTool === "T"; // new-text path
  _removeTextEditor();
  if (!dt) return;

  _state.update((s) => {
    if (dt.editingId) {
      // Re-edit: update the SAME object (id preserved). Empty text → keep the
      // original unchanged (prefer restore over delete). One undo entry.
      const o = s.objects.find((x) => x.id === dt.editingId);
      if (o && (val || "").trim()) {
        const snap = JSON.parse(JSON.stringify(s.objects));
        s.undoStack.push(snap);
        s.redoStack = [];
        o.text = val;
        o.fontSize = dt.fontSize;
        o.fontFamily = dt.fontFamily;
        o.fontWeight = dt.fontWeight;
        o.fontStyle = dt.fontStyle;
        o.underline = dt.underline;
        o.strikeout = dt.strikeout;
      }
    } else if ((val || "").trim()) {
      // New text built from the SAME draft data shown while typing.
      const snap = JSON.parse(JSON.stringify(s.objects));
      s.undoStack.push(snap);
      s.redoStack = [];
      s.objects.push({
        id: `obj_${Date.now().toString(36)}_${++_idCounter}`,
        type: "text",
        x: dt.x, y: dt.y, text: val,
        fontSize: dt.fontSize, fontFamily: dt.fontFamily,
        fontWeight: dt.fontWeight, fontStyle: dt.fontStyle,
        underline: dt.underline, strikeout: dt.strikeout,
        rotation: 0, locked: false, positionLocked: false,
        layerId: s.activeLayerId, order: s.objects.length,
      });
    }
    s.draftText = null;
    if (fromTool) s.activeTool = "V"; // auto-return to select after new text
  });
}

function cancelActiveTextEditor() {
  if (!_textEditor && !_state.get().draftText) return;
  _textCancelled = true;
  _cancelText();
}

/* ----- CLICK-AGAIN-TO-EDIT: a no-drag click on an ALREADY-selected sole text
 * object enters edit mode (DESIGN: text is directly editable, no context menu
 * required). The first click that SELECTS a text only selects it; a subsequent
 * click on the same (already sole-selected) text opens the in-place editor.
 *
 * Implemented across mousedown→move→up so it never fires mid-drag:
 *   ??mousedown (capture, so we read the PRE-click selection before setupDrawing's
 *     bubble handler runs) arms a candidate iff exactly that one text is selected
 *     and the click lands on it.
 *   ??any real pointer movement (a drag to MOVE the text) disarms the candidate.
 *   ??a clean mouseup with the candidate still armed opens the editor.
 * Non-text objects and multi-selection never arm, so normal select/drag/resize/
 * rotate behavior is untouched. */
let _editClickId = null;     // text id armed for click-to-edit on this press, or null
let _editClickStart = null;  // {x,y} client px of the arming mousedown (drag detection)
const EDIT_CLICK_TOL_PX = 4; // pointer movement beyond this = a drag, not a click

function setupTextClickToEdit() {
  // Capture phase: read selectedIds BEFORE setupDrawing's bubble mousedown.
  _svg.addEventListener("mousedown", (e) => {
    _editClickId = null;
    _editClickStart = null;
    if (e.button !== 0) return;            // left button only
    if (spaceHeld) return;                  // Space+drag = pan
    if (e.detail >= 2) return;              // double-click handled in setupDrawing
    if (_textEditor) return;                // already editing
    const s = _state.get();
    if (s.activeTool !== "V") return;       // only the select tool edits-on-click
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;           // must be the SOLE selection
    const o = s.objects.find((x) => x.id === ids[0]);
    if (!o || o.type !== "text") return;    // ...and it must be a text object
    // The click must actually land on THAT text (not empty space / another shape).
    const vb = s.viewBox;
    const tol = (HIT_TOL_PX * vb.w) / _svg.getBoundingClientRect().width;
    const p = screenToWorld(_svg, vb, e.clientX, e.clientY);
    if (hitTest(s.objects, p, tol) !== o.id) return;
    _editClickId = o.id;
    _editClickStart = { x: e.clientX, y: e.clientY };
  }, true); // capture = true

  // A drag (moving the text) cancels the pending edit-click.
  window.addEventListener("mousemove", (e) => {
    if (!_editClickId || !_editClickStart) return;
    if (Math.hypot(e.clientX - _editClickStart.x, e.clientY - _editClickStart.y) > EDIT_CLICK_TOL_PX) {
      _editClickId = null;
      _editClickStart = null;
    }
  });

  // Clean click (no drag) on the already-selected text → enter edit mode.
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    const id = _editClickId;
    _editClickId = null;
    _editClickStart = null;
    if (id === null) return;
    if (spaceHeld) return;
    const o = _state.get().objects.find((x) => x.id === id);
    if (!o || o.type !== "text") return;
    startEditingTextObject(id, { x: e.clientX, y: e.clientY });
  });
}

/* ----- F2 / Enter on a selected single text object → edit it in place ----- */
function setupTextEditShortcuts() {
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (_textEditor) return;                                   // already editing
    if (_fontModal && !_fontModal.hidden) return;              // modal owns keys
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key !== "F2" && e.key !== "Enter") return;
    const s = _state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const o = s.objects.find((x) => x.id === ids[0]);
    if (!o || o.type !== "text") return;
    e.preventDefault();
    startEditingTextObject(o.id);
  });
}

/* ===== TEXT CONTEXT MENU (right-click): 텍스트 수정 / 글꼴 설정... ===== */
let _ctxMenu = null;          // the floating action menu element (built lazily)
let _ctxEditItem = null;
let _ctxFontItem = null;
let _ctxTarget = null;        // { kind: "object"|"draft", id }
let _rightMouseDown = false;  // true during a right-click so blur doesn't commit the draft

function _buildCtxMenu() {
  if (_ctxMenu) return;
  _ctxMenu = document.createElement("div");
  _ctxMenu.className = "text-ctx-menu";
  _ctxMenu.hidden = true;

  _ctxEditItem = document.createElement("button");
  _ctxEditItem.type = "button";
  _ctxEditItem.className = "text-ctx-item";
  _ctxEditItem.textContent = "텍스트 수정";
  _ctxEditItem.addEventListener("click", () => {
    const id = (_ctxTarget && _ctxTarget.kind === "object") ? _ctxTarget.id : null;
    _closeCtxMenu();
    if (id) startEditingTextObject(id);
  });

  _ctxFontItem = document.createElement("button");
  _ctxFontItem.type = "button";
  _ctxFontItem.className = "text-ctx-item";
  _ctxFontItem.textContent = "글꼴 설정...";
  _ctxFontItem.addEventListener("click", () => {
    const target = _ctxTarget;
    _closeCtxMenu();
    if (target) _openFontModal(target);
  });

  _ctxMenu.appendChild(_ctxEditItem);
  _ctxMenu.appendChild(_ctxFontItem);
  document.body.appendChild(_ctxMenu);
  // Clicks inside the menu shouldn't close it via the window handler.
  _ctxMenu.addEventListener("mousedown", (e) => e.stopPropagation());
}

function _closeCtxMenu() {
  if (_ctxMenu) _ctxMenu.hidden = true;
}

function setupTextContextMenu() {
  _svg.addEventListener("contextmenu", (e) => {
    const s = _state.get();
    let target = null;

    if (s.draftText) {
      // Editing a draft (new or in-place) → tune the draft; "텍스트 수정" hidden.
      target = { kind: "draft", id: s.draftText.editingId || null };
    } else {
      const p = screenToWorld(_svg, s.viewBox, e.clientX, e.clientY);
      const tol = HIT_TOL_PX / getZoom();
      const hitId = hitTest(s.objects, p, tol);
      const hitObj = hitId ? s.objects.find((o) => o.id === hitId) : null;
      let obj = (hitObj && hitObj.type === "text") ? hitObj : null;
      if (!obj && (s.selectedIds || []).length === 1) {
        const sel = s.objects.find((o) => o.id === s.selectedIds[0]);
        if (sel && sel.type === "text") obj = sel;
      }
      if (!obj) return; // not a text target → leave the native menu alone
      target = { kind: "object", id: obj.id };
      if (!(s.selectedIds || []).includes(obj.id)) {
        _state.update((s2) => { s2.selectedIds = [obj.id]; s2.targetedId = null; });
      }
    }

    e.preventDefault(); // suppress native menu for text targets
    _buildCtxMenu();
    _ctxTarget = target;
    _ctxEditItem.style.display = target.kind === "object" ? "" : "none";
    _ctxMenu.hidden = false;
    // Position near the pointer, clamped into the viewport.
    const mw = 160, mh = 76;
    const left = Math.min(e.clientX, window.innerWidth - mw);
    const top = Math.min(e.clientY, window.innerHeight - mh);
    _ctxMenu.style.left = Math.max(4, left) + "px";
    _ctxMenu.style.top = Math.max(4, top) + "px";
  });

  // Outside click closes the menu. A right mousedown sets a short-lived flag so
  // the editor's blur handler won't commit the draft while the menu is opening.
  window.addEventListener("mousedown", (e) => {
    if (e.button === 2) { _rightMouseDown = true; setTimeout(() => { _rightMouseDown = false; }, 0); }
    if (_ctxMenu && !_ctxMenu.hidden) _closeCtxMenu();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _ctxMenu && !_ctxMenu.hidden) _closeCtxMenu();
  });
}

/* ===== FONT SETTINGS MODAL (글꼴 설정) =====
 * Windows-style font dialog: family / style / size / effects + live preview.
 * Edits a WORKING COPY; only 확인 applies. Object edits = one undo entry; draft
 * edits flow into the committed text. Size is shown in points (stored fontSize
 * stays world-unit mm; converted via ptToMm/mmToPt). */
let _fontModal = null;        // overlay element (built lazily)
let _fmFamily = null, _fmStyle = null, _fmSizeInput = null, _fmSizeList = null;
let _fmUnderline = null, _fmStrikeout = null, _fmPreview = null;
let _fmTarget = null;         // { kind, id }
let _fmWork = null;           // working copy: { fontFamily, fontWeight, fontStyle, underline, strikeout, pt }

function _buildFontModal() {
  if (_fontModal) return;
  _fontModal = document.createElement("div");
  _fontModal.className = "font-modal-overlay";
  _fontModal.hidden = true;

  const box = document.createElement("div");
  box.className = "font-modal";

  const header = document.createElement("div");
  header.className = "font-modal-header";
  header.textContent = "글꼴 설정";
  box.appendChild(header);

  const body = document.createElement("div");
  body.className = "font-modal-body";

  // family column
  const famCol = document.createElement("div");
  famCol.className = "fm-col";
  const famLbl = document.createElement("label");
  famLbl.className = "fm-label"; famLbl.textContent = "글꼴";
  _fmFamily = document.createElement("select");
  _fmFamily.className = "fm-list"; _fmFamily.size = 7;
  TEXT_FONTS.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.css; opt.textContent = f.label;
    _fmFamily.appendChild(opt);
  });
  famCol.appendChild(famLbl); famCol.appendChild(_fmFamily);

  // style column
  const styCol = document.createElement("div");
  styCol.className = "fm-col";
  const styLbl = document.createElement("label");
  styLbl.className = "fm-label"; styLbl.textContent = "글꼴 스타일";
  _fmStyle = document.createElement("select");
  _fmStyle.className = "fm-list"; _fmStyle.size = 7;
  TEXT_STYLES.forEach((st, i) => {
    const opt = document.createElement("option");
    opt.value = String(i); opt.textContent = st.label;
    _fmStyle.appendChild(opt);
  });
  styCol.appendChild(styLbl); styCol.appendChild(_fmStyle);

  // size column
  const szCol = document.createElement("div");
  szCol.className = "fm-col fm-col-size";
  const szLbl = document.createElement("label");
  szLbl.className = "fm-label"; szLbl.textContent = "크기";
  _fmSizeInput = document.createElement("input");
  _fmSizeInput.type = "number"; _fmSizeInput.min = "1"; _fmSizeInput.max = "400"; _fmSizeInput.step = "1";
  _fmSizeInput.className = "fm-size-input";
  _fmSizeList = document.createElement("select");
  _fmSizeList.className = "fm-list"; _fmSizeList.size = 6;
  TEXT_SIZE_PRESETS.forEach((pt) => {
    const opt = document.createElement("option");
    opt.value = String(pt); opt.textContent = String(pt);
    _fmSizeList.appendChild(opt);
  });
  szCol.appendChild(szLbl); szCol.appendChild(_fmSizeInput); szCol.appendChild(_fmSizeList);

  body.appendChild(famCol); body.appendChild(styCol); body.appendChild(szCol);
  box.appendChild(body);

  // effects
  const fx = document.createElement("div");
  fx.className = "fm-effects";
  const fxLbl = document.createElement("span");
  fxLbl.className = "fm-label"; fxLbl.textContent = "효과";
  const strikeLbl = document.createElement("label");
  _fmStrikeout = document.createElement("input"); _fmStrikeout.type = "checkbox";
  strikeLbl.appendChild(_fmStrikeout); strikeLbl.appendChild(document.createTextNode(" 취소선"));
  const underLbl = document.createElement("label");
  _fmUnderline = document.createElement("input"); _fmUnderline.type = "checkbox";
  underLbl.appendChild(_fmUnderline); underLbl.appendChild(document.createTextNode(" 밑줄"));
  fx.appendChild(fxLbl); fx.appendChild(strikeLbl); fx.appendChild(underLbl);
  box.appendChild(fx);

  // preview
  const pvWrap = document.createElement("div");
  pvWrap.className = "fm-preview-wrap";
  const pvLbl = document.createElement("div");
  pvLbl.className = "fm-label"; pvLbl.textContent = "미리보기";
  _fmPreview = document.createElement("div");
  _fmPreview.className = "fm-preview";
  _fmPreview.textContent = "AaBbYyZz 가나다라";
  pvWrap.appendChild(pvLbl); pvWrap.appendChild(_fmPreview);
  box.appendChild(pvWrap);

  // footer buttons
  const footer = document.createElement("div");
  footer.className = "font-modal-footer";
  const okBtn = document.createElement("button");
  okBtn.type = "button"; okBtn.className = "fm-btn fm-ok"; okBtn.textContent = "확인";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button"; cancelBtn.className = "fm-btn fm-cancel"; cancelBtn.textContent = "취소";
  footer.appendChild(okBtn); footer.appendChild(cancelBtn);
  box.appendChild(footer);

  _fontModal.appendChild(box);
  document.body.appendChild(_fontModal);

  // wiring — preview-only until 확인
  _fmFamily.addEventListener("change", () => { _fmWork.fontFamily = _fmFamily.value; _refreshFontPreview(); });
  _fmStyle.addEventListener("change", () => {
    const st = TEXT_STYLES[parseInt(_fmStyle.value, 10)] || TEXT_STYLES[0];
    _fmWork.fontWeight = st.fontWeight; _fmWork.fontStyle = st.fontStyle; _refreshFontPreview();
  });
  _fmSizeList.addEventListener("change", () => {
    _fmSizeInput.value = _fmSizeList.value;
    _fmWork.pt = parseFloat(_fmSizeList.value) || _fmWork.pt; _refreshFontPreview();
  });
  _fmSizeInput.addEventListener("input", () => {
    const v = parseFloat(_fmSizeInput.value);
    if (isFinite(v) && v > 0) { _fmWork.pt = v; _refreshFontPreview(); }
  });
  _fmUnderline.addEventListener("change", () => { _fmWork.underline = _fmUnderline.checked; _refreshFontPreview(); });
  _fmStrikeout.addEventListener("change", () => { _fmWork.strikeout = _fmStrikeout.checked; _refreshFontPreview(); });

  okBtn.addEventListener("click", _applyFontModal);
  cancelBtn.addEventListener("click", _closeFontModal);
  _fontModal.addEventListener("mousedown", (e) => { if (e.target === _fontModal) _closeFontModal(); });
  // Keyboard: Escape cancels, Enter applies (Phase 4.9).
  _fontModal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); _closeFontModal(); }
    else if (e.key === "Enter") { e.preventDefault(); _applyFontModal(); }
  });
}

function _refreshFontPreview() {
  if (!_fmPreview || !_fmWork) return;
  _fmPreview.style.fontFamily = _fmWork.fontFamily;
  _fmPreview.style.fontWeight = _fmWork.fontWeight;
  _fmPreview.style.fontStyle  = _fmWork.fontStyle;
  _fmPreview.style.fontSize   = _fmWork.pt + "pt";
  const deco = [];
  if (_fmWork.underline) deco.push("underline");
  if (_fmWork.strikeout) deco.push("line-through");
  _fmPreview.style.textDecoration = deco.join(" ") || "none";
}

function _openFontModal(target) {
  _buildFontModal();
  _fmTarget = target;

  const s = _state.get();
  const src = target.kind === "object"
    ? s.objects.find((o) => o.id === target.id)
    : s.draftText;
  if (!src) return;

  _fmWork = {
    fontFamily: src.fontFamily || DEFAULT_TEXT_FONT,
    fontWeight: src.fontWeight || "normal",
    fontStyle:  src.fontStyle  || "normal",
    underline:  !!src.underline,
    strikeout:  !!src.strikeout,
    pt: Math.round(mmToPt(src.fontSize) * 10) / 10,
  };

  _fmFamily.value = _fmWork.fontFamily;
  const styleIdx = TEXT_STYLES.findIndex((st) => st.fontWeight === _fmWork.fontWeight && st.fontStyle === _fmWork.fontStyle);
  _fmStyle.value = String(styleIdx < 0 ? 0 : styleIdx);
  _fmSizeInput.value = _fmWork.pt;
  _fmSizeList.value = String(_fmWork.pt); // no-op if pt isn't a preset
  _fmUnderline.checked = _fmWork.underline;
  _fmStrikeout.checked = _fmWork.strikeout;
  _refreshFontPreview();

  _fontModal.hidden = false;
  _fmFamily.focus();
}

function _closeFontModal() {
  if (_fontModal) _fontModal.hidden = true;
  _fmTarget = null;
  _fmWork = null;
  if (_textEditor) _textEditor.focus(); // resume draft editing if still open
}

function _applyFontModal() {
  if (!_fmTarget || !_fmWork) { _closeFontModal(); return; }
  const w = _fmWork;
  const fields = {
    fontFamily: w.fontFamily,
    fontWeight: w.fontWeight,
    fontStyle:  w.fontStyle,
    underline:  w.underline,
    strikeout:  w.strikeout,
    fontSize:   ptToMm(w.pt),
  };
  if (_fmTarget.kind === "object") {
    _state.update((s) => {
      const o = s.objects.find((x) => x.id === _fmTarget.id);
      if (!o || o.type !== "text") return;
      const snap = JSON.parse(JSON.stringify(s.objects));
      s.undoStack.push(snap);
      s.redoStack = [];
      Object.assign(o, fields);
    });
  } else {
    _state.update((s) => { if (s.draftText) Object.assign(s.draftText, fields); });
    _syncEditorFont();
  }
  _closeFontModal();
}

// Open the font modal for the current selection / active draft. Used by the
// inspector "글꼴 설정..." button so both UIs share one modal + one field set.
export function openFontModalForSelection() {
  const s = _state.get();
  if (s.draftText) { _openFontModal({ kind: "draft", id: s.draftText.editingId || null }); return; }
  const ids = s.selectedIds || [];
  if (ids.length !== 1) return;
  const o = s.objects.find((x) => x.id === ids[0]);
  if (o && o.type === "text") _openFontModal({ kind: "object", id: o.id });
}
