/* ===== TOOLS (DESIGN §3 tool selection + the rectangle draw pipeline) ===== */
//
// Two responsibilities, both routed through the store so data stays the truth:
//   1. Tool selection — V (select) / R (rectangle), via buttons or keyboard.
//      The armed tool lives in state.activeTool.
//   2. Rectangle drawing — mouse down→drag→up while R is armed. The drag builds
//      a `draft` rect (live preview via state.draft); mouse-up commits it into
//      state.objects, then auto-returns to V (DESIGN 4-3).
//
// Mouse points are screen pixels; they are converted to WORLD coords through
// screenToWorld BEFORE being stored, so shapes are anchored in world space and
// survive zoom/pan unchanged (DESIGN 1-2).

import { screenToWorld } from "./viewport.js?v=0.8.0";

// Default look until the inspector exists (DESIGN §3-2: border only, hollow).
const DEFAULT_STROKE_WIDTH = 0.5; // world units (≈0.5mm on the 100mm artboard)
const MIN_SIZE = 0.3; // world units; ignore stray clicks that draw nothing
const HIT_TOL_PX = 6; // CSS px of slop around an edge so thin strokes are clickable

let _svg = null;
let _state = null;
let _idCounter = 0;

/* ----- public: wire buttons, keyboard, and the drawing gestures ----- */
export function initTools(svg, state) {
  _svg = svg;
  _state = state;

  setupButtons();
  setupKeyboard();
  setupDrawing();
  setupClickDrawing();
  setupTextTool();

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

/* ----- left-panel buttons (data-tool="V" / "R") ----- */
function setupButtons() {
  document.querySelectorAll(".tool-btn").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTool(btn.dataset.tool));
  });
}

function syncButtons(activeTool) {
  document.querySelectorAll(".tool-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tool === activeTool);
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

/* ===== SHAPE DRAWING (rect / ellipse / triangle — one shared pipeline) ===== */

// Armed tool → object type. Size-based shapes (rect/ellipse/triangle) draw
// through the SAME down→drag→up flow; only the stored geometry differs
// (makeShape branches on type). Line (L) and polyline (P) are click-to-click
// instead — see setupClickDrawing below.
const SHAPE_TYPE = { R: "rect", O: "ellipse", Y: "triangle" };

let drawing = false;
let startWorld = null; // world coord of the mouse-down point
let drawType = null;   // type being drawn for the current drag
let spaceHeld = false; // mirror viewport's Space-pan so we never draw while panning

let _marqueeStart = null; // world {x,y} of marquee drag start, or null
let _marqueeEl = null;    // temporary SVG <rect> shown during marquee drag

function setupDrawing() {
  // track Space locally so a Space+drag pans (viewport) instead of drawing.
  window.addEventListener("keydown", (e) => { if (e.code === "Space") spaceHeld = true; });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceHeld = false; });

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
    // wrongly clear selectedIds — breaking transform.js's handle-drag guard.
    const tgt = e.target;
    if (tgt && tgt.dataset && tgt.dataset.handle) return;
    const vb = _state.get().viewBox;
    const p = screenToWorld(_svg, vb, e.clientX, e.clientY);
    // Convert a few CSS px of edge tolerance into world units (DESIGN-style
    // tolerance) so thin strokes are easy to hit.
    const tol = (HIT_TOL_PX * vb.w) / _svg.getBoundingClientRect().width;
    const shiftHeld = e.shiftKey;
    let hitId = null;
    _state.update((s) => {
      hitId = hitTest(s.objects, p, tol);
      if (hitId !== null) {
        const _hlObj = s.objects.find((o) => o.id === hitId);
        const _hlLayerId = _hlObj ? (_hlObj.layerId ?? 1) : 1;
        const _hlLayer = (s.layers || []).find(l => l.id === _hlLayerId);
        if (!_hlLayer || _hlLayer.visible === false || _hlLayer.locked || _hlLayerId !== s.activeLayerId) {
          hitId = null;
        }
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
            // Already targeting this member — preserve targeted state
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
    if (hitId === null && _at === "V") {
      _marqueeStart = { x: p.x, y: p.y };
      _marqueeEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      _marqueeEl.setAttribute("fill", "rgba(9,105,218,0.08)");
      _marqueeEl.setAttribute("stroke", "#0969da");
      _marqueeEl.setAttribute("stroke-width", "0.3");
      _marqueeEl.setAttribute("stroke-dasharray", "1.5 1");
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
    const cur = screenToWorld(_svg, vb, e.clientX, e.clientY);
    _state.update((s) => { s.draft = makeShape(drawType, startWorld, cur); });
  });

  window.addEventListener("mouseup", (e) => {
    if (!drawing) return;
    drawing = false;
    const vb = _state.get().viewBox;
    const cur = screenToWorld(_svg, vb, e.clientX, e.clientY);
    const shape = makeShape(drawType, startWorld, cur);
    startWorld = null;
    drawType = null;

    _state.update((s) => {
      s.draft = null;
      // Only commit a real drag; a click with no movement draws nothing.
      if (isCommittable(shape)) {
        shape.id = `obj_${Date.now().toString(36)}_${++_idCounter}`;
        shape.order = s.objects.length;
        shape.layerId = s.activeLayerId;
        s.objects.push(shape);
        s.activeTool = "V"; // auto-return to select right after drawing (DESIGN 4-3)
      }
    });
  });

  // Marquee drag — update the dashed selection rect while dragging empty space.
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

  // Marquee drag — commit or cancel on mouse-up.
  window.addEventListener("mouseup", (e) => {
    if (!_marqueeStart) return;
    const vb = _state.get().viewBox;
    const cur = screenToWorld(_svg, vb, e.clientX, e.clientY);
    const start = _marqueeStart;
    _marqueeStart = null;
    if (_marqueeEl) { _marqueeEl.remove(); _marqueeEl = null; }

    const dist = Math.hypot(cur.x - start.x, cur.y - start.y);
    if (dist < 2) {
      // Plain empty-click — clear selection.
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
          if (!_mLayer || _mLayer.visible === false || _mLayer.locked || _mLayerId !== s.activeLayerId) return false;
          const bb = getObjectBBox(o);
          return bb && bboxIntersects(bb, selRect);
        })
        .map((o) => o.id);
    });
  });

  // NOTE: targeting a group member on double-click is handled in the mousedown
  // handler above (e.detail >= 2). A dblclick listener can't be used here: every
  // mousedown re-renders (scene.replaceChildren) and detaches the clicked node
  // before mouseup, so the browser never fires click/dblclick on it.
}

/* ===== CLICK-TO-CLICK DRAWING (line L + polyline P — one shared mechanism) ===== */
//
// Both place vertices by CLICKING (no button hold). A running point list
// (draftPoints) is built one click at a time; a live SOLID rubber-band preview
// (state.draft, rendered as a polyline) runs from the last placed vertex to the
// mouse. The only difference between the tools is when they finish:
//   • LINE (L): the 2-point case — the 2nd click commits and finishes.
//   • POLYLINE (P): many points — double-click or Enter finishes (≥2 points).
// ESC cancels the whole draft (nothing committed). All clicks convert to world
// coords through the SHARED screenToWorld helper — no new coordinate math.
const CLICK_TOOLS = { L: "line", P: "polyline", C: "curve" };

let clickTool = null;     // armed click-to-click tool ("L"/"P"/"C") while drafting, else null
let draftPoints = [];     // world-space vertices placed so far
let mouseWorld = null;    // last mouse world pos, for the rubber-band segment

function setupClickDrawing() {
  // Each click appends a vertex. Line auto-commits at 2 points; polyline keeps going.
  _svg.addEventListener("click", (e) => {
    if (e.button !== 0) return;                  // left button only
    if (spaceHeld) return;                        // Space+click = pan, not draw
    const tool = _state.get().activeTool;
    if (!CLICK_TOOLS[tool]) return;               // only L / P place points
    const vb = _state.get().viewBox;
    draftPoints.push(screenToWorld(_svg, vb, e.clientX, e.clientY));
    clickTool = tool;

    if (tool === "L" && draftPoints.length === 2) { commitLine(); return; }
    updateDraftPreview();                         // refresh the committed-segments preview
  });

  // Rubber-band: redraw preview from the placed points to the live mouse.
  window.addEventListener("mousemove", (e) => {
    if (!clickTool) return;
    const vb = _state.get().viewBox;
    mouseWorld = screenToWorld(_svg, vb, e.clientX, e.clientY);
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

// Live preview = the placed segments PLUS a rubber-band from the last vertex to
// the mouse. For curve, renders as a smooth curve preview so it matches the result.
function updateDraftPreview() {
  if (!clickTool || draftPoints.length === 0) return;
  const pts = mouseWorld ? [...draftPoints, mouseWorld] : draftPoints.slice();
  _state.update((s) => { s.draft = clickTool === "C" ? makeCurve(pts) : makePolyline(pts); });
}

// LINE: exactly two clicks. Commit a real line object, or cancel a zero-length one.
function commitLine() {
  const line = makeLine(draftPoints[0], draftPoints[1]);
  if (isCommittable(line)) commitClickShape(line);
  else resetClickDraft();
}

// POLYLINE / CURVE: needs ≥2 vertices; otherwise the draft is discarded.
function finishPolyline() {
  if (draftPoints.length < 2) { resetClickDraft(); return; }
  const shape = clickTool === "C" ? makeCurve(draftPoints) : makePolyline(draftPoints);
  commitClickShape(shape);
}

// Push a finished click-to-click shape through the SAME store path as the drag
// flow (id + z-order assigned on commit), then auto-return to V (DESIGN 4-3).
function commitClickShape(shape) {
  _state.update((s) => {
    shape.id = `obj_${Date.now().toString(36)}_${++_idCounter}`;
    shape.order = s.objects.length;
    shape.layerId = s.activeLayerId;
    s.objects.push(shape);
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
  if (shape.type === "line") {
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
function hitTest(objects, p, tol = 0) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type !== "rect" && o.type !== "ellipse" && o.type !== "triangle" &&
        o.type !== "line" && o.type !== "polyline" && o.type !== "curve" &&
        o.type !== "text") continue;

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
    const margin = (o.strokeWidth || 0) / 2 + tol;

    if (o.type === "line") {
      if (segDist(p.x, p.y, o.p1.x, o.p1.y, o.p2.x, o.p2.y) <= margin) return o.id;
      continue;
    }

    if (o.type === "polyline") {
      // Hit if within margin of ANY segment between consecutive vertices.
      const pts = o.points || [];
      for (let k = 0; k < pts.length - 1; k++) {
        if (segDist(p.x, p.y, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) <= margin) return o.id;
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
      // Sample each Catmull-Rom Bezier segment to get fine-grained hit detection.
      const SAMPLES = 12;
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

    if (o.type === "rect") {
      // box == actual shape: outward-grown bbox containment (unchanged)
      if (p.x >= o.x - margin && p.x <= o.x + o.w + margin &&
          p.y >= o.y - margin && p.y <= o.y + o.h + margin) return o.id;
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
  if (o.type === "rect" || o.type === "ellipse" || o.type === "triangle") {
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
  if (o.type === "line") {
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
    locked: false,
    layerId: 1,
    order: 0,              // assigned on commit (z-order within layer)
  };
  if (type === "triangle") shape.flipX = b.x < a.x;
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
    arrowHead: "none",     // "none" | "end" | "both" | "center"
    dashLength: 0,         // world units (mm); 0 = solid (no dasharray)
    dashGap: 0,            // world units (mm); 0 = solid
    locked: false,
    layerId: 1,
    order: 0,              // assigned on commit (z-order within layer)
  };
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
    arrowHead: "none",     // "none" | "end" | "both" | "center"
    dashLength: 0,         // world units (mm); 0 = solid (no dasharray)
    dashGap: 0,            // world units (mm); 0 = solid
    locked: false,
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
    locked: false,
    layerId: 1,
    order: 0,
  };
}

/* ----- Catmull-Rom cubic Bezier control points for segment i → i+1 ----- */
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

/* ----- evaluate cubic Bezier at parameter t ∈ [0,1] ----- */
function evalBezier(seg, t) {
  const u = 1 - t;
  return {
    x: u*u*u*seg.sx + 3*u*u*t*seg.cp1x + 3*u*t*t*seg.cp2x + t*t*t*seg.ex,
    y: u*u*u*seg.sy + 3*u*u*t*seg.cp1y + 3*u*t*t*seg.cp2y + t*t*t*seg.ey,
  };
}

/* ===== TEXT TOOL (T) ===== */
//
// Single-click places an inline <textarea> overlay at the click position.
// Enter commits; Shift+Enter inserts a newline; ESC cancels.
// On commit the textarea is removed and a text object is pushed to state.

let _textEditor = null;     // the live <textarea>, or null
let _textAnchor = null;     // world-space {x,y} of the text origin
let _textCancelled = false; // set by ESC so blur doesn't double-commit

function setupTextTool() {
  _svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (spaceHeld) return;
    if (_state.get().activeTool !== "T") return;
    e.preventDefault();

    // If an editor is already open (e.g. clicked canvas a second time while T
    // is still active — unusual path), commit it and return.  The blur will
    // have already fired before mousedown so usually this guard won't trigger.
    if (_textEditor) { _commitText(); return; }

    const vb = _state.get().viewBox;
    _textAnchor = screenToWorld(_svg, vb, e.clientX, e.clientY);

    const wrap = _svg.closest(".canvas-wrap");
    const wr = wrap.getBoundingClientRect();

    _textCancelled = false;
    _textEditor = document.createElement("textarea");
    _textEditor.className = "text-editor-overlay";
    _textEditor.style.left = (e.clientX - wr.left) + "px";
    _textEditor.style.top  = (e.clientY - wr.top)  + "px";
    _textEditor.rows = 1;
    wrap.appendChild(_textEditor);
    _textEditor.focus();

    _textEditor.addEventListener("keydown", (ke) => {
      if (ke.key === "Escape") {
        ke.preventDefault();
        _textCancelled = true;
        _removeTextEditor();
      } else if (ke.key === "Enter" && !ke.shiftKey) {
        ke.preventDefault();
        _commitText();
      }
      // Shift+Enter falls through → native newline in textarea
    });

    _textEditor.addEventListener("blur", () => {
      if (!_textCancelled) _commitText();
    });
  });
}

function _removeTextEditor() {
  if (!_textEditor) return;
  const el = _textEditor;
  _textEditor = null; // null first to prevent blur re-entrancy
  _textAnchor = null;
  el.remove();
}

function _commitText() {
  if (!_textEditor) return;
  const val = _textEditor.value;
  const anchor = _textAnchor; // capture before removeTextEditor nulls it
  _removeTextEditor();

  _state.update((s) => {
    if (val.trim()) {
      s.objects.push({
        id: `obj_${Date.now().toString(36)}_${++_idCounter}`,
        type: "text",
        x: anchor.x,
        y: anchor.y,
        text: val,
        fontSize: 14,
        rotation: 0,
        locked: false,
        layerId: s.activeLayerId,
        order: s.objects.length,
      });
    }
    s.activeTool = "V";
  });
}

function cancelActiveTextEditor() {
  if (!_textEditor) return;
  _textCancelled = true;
  _removeTextEditor();
}
