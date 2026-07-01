/* ===== TRANSFORM (DESIGN 吏? select-tool MOVE + snapshot-based Undo/Redo) ===== */
//
// Owns two concerns:
//   1. Body-drag MOVE of the selected object (V tool only).
//   2. Snapshot-based Undo/Redo engine (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y).
//
// Undo strategy: whole-objects-array snapshot (fine at this scale, DESIGN 吏?).
// Snapshot is captured at drag start; committed only if the pointer crossed a
// distance threshold ??so a plain click never creates a useless undo entry.
//
// Coordination with tools.js: tools.js updates selectedIds on mousedown (bubble
// phase). We use a capture-phase listener to read the PRE-click selectedIds, so
// we can distinguish "click on already-selected ??move allowed" from "click
// selects a new object ??just select, no move this press."

import { screenToWorld, getRenderScale } from "./viewport.js?v=0.36.5";
import { resolveSnap, resolveEndpointSnap, resolveRadialCenterSnap } from "./snap.js?v=0.36.5";
import { setSnapPreview } from "./render.js?v=0.36.5";
import { pickSelectableObjectFromEvent } from "./tools.js?v=0.36.5";

/* ----- shared lock guard: locked objects are excluded from mutating ops ----- */
function isMutable(o) { return o && !o.locked; }
function isPositionMovable(o) { return isMutable(o) && !o.positionLocked; }

/* ----- closed polyline: branch-B storage (points) + branch-A (face) interaction -----
 * Transforms are BAKED into the point coordinates (no rotation field), so the
 * points stay world-true. These helpers derive its branch-A bbox and bake ops. */
function isClosedPoly(o) { return o && o.type === "polyline" && o.closed === true; }
function isClosedCurve(o) { return o && o.type === "curve" && o.closed === true; }

function polyBBox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function polyCenter(points) {
  const b = polyBBox(points);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/* rotate every point about its bbox center by deg (baked into coords) */
function rotatePolyPoints(o, deg) {
  const c = polyCenter(o.points);
  const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  o.points = o.points.map((p) => ({
    x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin,
    y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos,
  }));
}

/* mirror every point about its bbox center along one axis (baked into coords) */
function flipPolyPoints(o, axis) {
  const c = polyCenter(o.points);
  o.points = o.points.map((p) => ({
    x: axis === "flipX" ? 2 * c.x - p.x : p.x,
    y: axis === "flipY" ? 2 * c.y - p.y : p.y,
  }));
}

/* ----- rotate point (px,py) about center (cx,cy) by deg degrees ----- */
function rotPt(px, py, cx, cy, deg) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return { x: cx + (px - cx) * cos - (py - cy) * sin,
           y: cy + (px - cx) * sin + (py - cy) * cos };
}

/* ----- world position of the corner diagonally opposite to `corner` ----- */
function getRotPivot(obj, corner) {
  const { x, y, w, h, rotation } = obj;
  const cx = x + w / 2, cy = y + h / 2;
  const deg = rotation || 0;
  switch (corner) {
    case "nw": return rotPt(x + w, y + h, cx, cy, deg); // opposite = se
    case "ne": return rotPt(x,     y + h, cx, cy, deg); // opposite = sw
    case "se": return rotPt(x,     y,     cx, cy, deg); // opposite = nw
    case "sw": return rotPt(x + w, y,     cx, cy, deg); // opposite = ne
    default:   return { x: cx, y: cy };
  }
}

/* ===== UNDO / REDO ENGINE ===== */

function cloneObjects(objects) {
  return JSON.parse(JSON.stringify(objects));
}

export function rebuildGroups(s) {
  const map = {};
  s.objects.forEach(o => {
    if (o.groupId) {
      if (!map[o.groupId]) map[o.groupId] = [];
      map[o.groupId].push(o.id);
    }
  });
  s.groups = Object.entries(map).map(([id, memberIds]) => ({ id, memberIds }));
}

export function undo(state) {
  if (state.get().undoStack.length === 0) return;
  state.update((s) => {
    const current = cloneObjects(s.objects);
    const prev = s.undoStack.pop();
    s.redoStack.push(current);
    s.objects = prev;
    s.targetedId = null;
    s.selectedIds = (s.selectedIds || []).filter(id => s.objects.find((o) => o.id === id));
    rebuildGroups(s);
  });
}

export function redo(state) {
  if (state.get().redoStack.length === 0) return;
  state.update((s) => {
    const current = cloneObjects(s.objects);
    const next = s.redoStack.pop();
    s.undoStack.push(current);
    s.objects = next;
    s.targetedId = null;
    s.selectedIds = (s.selectedIds || []).filter(id => s.objects.find((o) => o.id === id));
    rebuildGroups(s);
  });
}

/* ===== MOVE GESTURE ===== */

const MOVE_THRESHOLD = 0.01; // world units; below this = plain click, not a drag
const SHAPE_MOVE_TYPES = new Set(["rect", "ellipse", "triangle"]);

let _moving = false;
let _moveObjIds = [];
let _moveStartWorld = null; // world coords of the mousedown that started the drag
let _moveOrigObjs = {};     // map from id ??deep clone of the object's geometry at drag start
let _pendingSnapshot = null; // full objects clone for undo; committed only if moved
let _didMove = false;        // true once the threshold is crossed
let _prevSelectedIds = [];   // selectedIds captured BEFORE tools.js's handler fires
let _spaceHeld = false;

/* handle-drag state (resize branch A / endpoint branch B) */
let _handleDragging   = false;
let _handleId         = null;
let _handleOrigObj    = null;
let _handleStartWorld = null;

/* whole-group resize state (DESIGN 6-2: uniform scale, aspect FORCED) */
let _groupResizing  = false;
let _groupHandle    = null;
let _groupBox0      = null;  // combined bbox at drag start
let _groupMemberIds = [];
let _groupOrigObjs  = {};    // id ??deep clone at drag start
let _groupRotating  = false; // whole-group rotation about combined-bbox center

/* rotation-drag state (also reused for whole-group rotation: _rotPivot, _rotStartAngle) */
let _rotating        = false;
let _rotObjId        = null;
let _rotOrigObj      = null;
let _rotPivot        = null;
let _rotStartAngle   = 0;
let _rotPendingSnap  = null;
let _rotDidMove      = false;

/* clipboard, mouse position, and arrow-key hold tracking */
let _clipboard = null;
let _propertyClipboard = null;
let _lastMouseWorld = null; // latest pointer world coord (set on first mousemove); null until then
const _arrowKeysHeld = new Set();

function isEditingFieldTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
    target.isContentEditable ||
    target.closest?.("#inspector, .text-editor-overlay, .font-modal-overlay, .text-ctx-menu");
}

function lineAngleDeg(obj) {
  return Math.atan2(obj.p2.y - obj.p1.y, obj.p2.x - obj.p1.x) * 180 / Math.PI;
}

function objectAngleDeg(obj) {
  if (!obj) return null;
  if ((obj.type === "line" || obj.type === "circuit") && obj.p1 && obj.p2) return lineAngleDeg(obj);
  if (typeof obj.rotation === "number") return obj.rotation;
  return null;
}

function unitForAngle(deg) {
  const rad = (deg * Math.PI) / 180;
  let x = Math.cos(rad), y = Math.sin(rad);
  const n = ((deg % 360) + 360) % 360;
  if (Math.abs(n - 0) < 1e-9 || Math.abs(n - 180) < 1e-9) y = 0;
  if (Math.abs(n - 90) < 1e-9 || Math.abs(n - 270) < 1e-9) x = 0;
  return { x, y };
}

function applyAngleDeg(obj, deg) {
  if (!obj || obj.locked || obj.positionLocked) return false;
  if ((obj.type === "line" || obj.type === "circuit") && obj.p1 && obj.p2) {
    const mx = (obj.p1.x + obj.p2.x) / 2;
    const my = (obj.p1.y + obj.p2.y) / 2;
    const len = Math.hypot(obj.p2.x - obj.p1.x, obj.p2.y - obj.p1.y);
    const u = unitForAngle(deg);
    const hx = (u.x * len) / 2;
    const hy = (u.y * len) / 2;
    const nextP1 = { x: mx - hx, y: my - hy };
    const nextP2 = { x: mx + hx, y: my + hy };
    const changed = Math.abs(nextP1.x - obj.p1.x) > 1e-9 || Math.abs(nextP1.y - obj.p1.y) > 1e-9 ||
      Math.abs(nextP2.x - obj.p2.x) > 1e-9 || Math.abs(nextP2.y - obj.p2.y) > 1e-9;
    if (!changed) return false;
    obj.p1 = nextP1;
    obj.p2 = nextP2;
    return true;
  }
  if (typeof obj.rotation === "number") {
    if (Math.abs((obj.rotation ?? 0) - deg) <= 1e-9) return false;
    obj.rotation = deg;
    return true;
  }
  return false;
}

/* ----- axis-aligned bbox of a set of (clipboard) objects, in world units -----
 * Text uses its anchor point as a zero-size box (the clone isn't rendered, so
 * getBBox is unavailable). Used to center a paste on the mouse. */
function clipboardBBox(objs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  for (const o of objs) {
    if (o.type === "rect" || o.type === "ellipse" || o.type === "triangle" || o.type === "image" || o.type === "axes" || o.type === "optics" || o.type === "apparatus") {
      acc(o.x, o.y); acc(o.x + (o.w || 0), o.y + (o.h || 0));
    } else if (o.type === "anglearc") {
      const r = o.radius || 0;
      acc(o.x - r, o.y - r); acc(o.x + r, o.y + r);
    } else if (o.type === "rightangle") {
      const r = (o.size || 0) * 1.6;
      acc(o.x - r, o.y - r); acc(o.x + r, o.y + r);
    } else if (o.type === "text" || o.type === "formula") {
      acc(o.x, o.y);
    } else if (o.type === "line" || o.type === "circuit" || o.type === "labeler") {
      acc(o.p1.x, o.p1.y); acc(o.p2.x, o.p2.y);
    } else if (o.type === "polyline" || o.type === "curve") {
      (o.points || []).forEach((p) => acc(p.x, p.y));
    }
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ----- set object position from original + delta (avoids float drift) ----- */
function applyDelta(obj, orig, dx, dy) {
  if (obj.type === "rect" || obj.type === "ellipse" ||
      obj.type === "triangle" || obj.type === "text" || obj.type === "formula" ||
      obj.type === "image" ||
      obj.type === "axes" || obj.type === "anglearc" || obj.type === "rightangle" ||
      obj.type === "optics" || obj.type === "apparatus") {
    // anglearc moves by its vertex (x,y); radius/angles are unaffected.
    obj.x = orig.x + dx;
    obj.y = orig.y + dy;
  } else if (obj.type === "line" || obj.type === "circuit" || obj.type === "labeler") {
    // Circuit/labeler move by translating BOTH endpoints (labeler: anchor + label).
    obj.p1 = { x: orig.p1.x + dx, y: orig.p1.y + dy };
    obj.p2 = { x: orig.p2.x + dx, y: orig.p2.y + dy };
  } else if (obj.type === "polyline" || obj.type === "curve") {
    obj.points = orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
}

/* ----- line-like endpoint handle <-> point bridge (for endpoint-priority snap) ----- */
function handleEndpointPoint(obj, handle) {
  if (obj.type === "line" || obj.type === "circuit" || obj.type === "labeler") {
    return handle === "p0" ? obj.p1 : obj.p2;
  }
  if ((obj.type === "polyline" || obj.type === "curve")
      && typeof handle === "string" && handle[0] === "p") {
    const i = parseInt(handle.slice(1), 10);
    return Number.isInteger(i) ? obj.points?.[i] : null;
  }
  return null;
}

function setHandleEndpointPoint(obj, handle, pt) {
  const next = { x: pt.x, y: pt.y };
  if (obj.type === "line" || obj.type === "circuit" || obj.type === "labeler") {
    if (handle === "p0") obj.p1 = next; else obj.p2 = next;
    return;
  }
  if (obj.type === "polyline" || obj.type === "curve") {
    const i = parseInt(handle.slice(1), 10);
    if (Number.isInteger(i) && obj.points?.[i]) obj.points[i] = next;
  }
}

/* The FIXED (non-dragged) endpoint of a line/circuit, for the 6c radial-center
 * test. Only defined for the two-endpoint line family. */
function otherEndpointPoint(obj, handle) {
  if (obj.type === "line" || obj.type === "circuit") {
    return handle === "p0" ? obj.p2 : obj.p1;
  }
  return null;
}

/* Consolidate the endpoint-snap candidates (6b edge/vertex + 6c radial center)
 * into ONE choice. 6c radial is angularly gated — it only fires when the line is
 * deliberately aimed at an object's center — so it WINS over the plain edge foot
 * whenever it attaches (otherwise the perpendicular edge point would beat the
 * radial point and the line would never go radial). Falls back to the edge/vertex
 * snap, then to whichever preview is available. */
function pickEndpointSnap(edgeSnap, radialSnap) {
  if (radialSnap && radialSnap.attach) return { ...radialSnap, kind: "radial" };
  if (edgeSnap && edgeSnap.attach) return { ...edgeSnap, kind: "edge" };
  if (radialSnap) return { ...radialSnap, kind: "radial" };
  if (edgeSnap) return { ...edgeSnap, kind: "edge" };
  return null;
}

const MIN_SIZE = 0.3; // world units; minimum w or h after resize

/* ----- apply one handle drag delta to an object ----- */
function objectCenter(obj) {
  if (obj.type === "line" || obj.type === "circuit" || obj.type === "labeler") {
    return { x: (obj.p1.x + obj.p2.x) / 2, y: (obj.p1.y + obj.p2.y) / 2 };
  }
  if (obj.type === "polyline" || obj.type === "curve") return polyCenter(obj.points);
  return { x: obj.x + (obj.w || 0) / 2, y: obj.y + (obj.h || 0) / 2 };
}

function translateObject(obj, dx, dy) {
  const orig = JSON.parse(JSON.stringify(obj));
  applyDelta(obj, orig, dx, dy);
}

function snapLineEndpoint(anchor, point) {
  const dx = point.x - anchor.x, dy = point.y - anchor.y;
  const distance = Math.hypot(dx, dy);
  const degrees = Math.round((Math.atan2(dy, dx) * 180 / Math.PI) / 15) * 15;
  const radians = degrees * Math.PI / 180;
  let ux = Math.cos(radians), uy = Math.sin(radians);
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0 || normalized === 180) uy = 0;
  if (normalized === 90 || normalized === 270) ux = 0;
  return { x: anchor.x + ux * distance, y: anchor.y + uy * distance };
}

function applyHandleDeltaBase(obj, orig, handle, dx, dy, shiftKey, ctrlKey) {
  // anglearc: a single-DOF symbol ??resizing scales the RADIUS, vertex anchored.
  // Reuse the SAME per-handle box math on the arc's vertex-centered square bbox,
  // then map the resulting box size back to a radius (avg half-extent so every
  // handle, edge or corner, responds monotonically). Aspect lock is irrelevant.
  if (obj.type === "anglearc") {
    const r0 = orig.radius || 0;
    let w = 2 * r0, h = 2 * r0;
    switch (handle) {
      case "n":  h -= dy; break;
      case "s":  h += dy; break;
      case "w":  w -= dx; break;
      case "e":  w += dx; break;
      case "nw": h -= dy; w -= dx; break;
      case "ne": h -= dy; w += dx; break;
      case "se": h += dy; w += dx; break;
      case "sw": h += dy; w -= dx; break;
    }
    obj.radius = Math.max(MIN_SIZE, (w + h) / 4);
    obj.x = orig.x; // vertex stays put ??the circle grows/shrinks about it
    obj.y = orig.y;
    return;
  }
  if (obj.type === "rightangle") {
    const s0 = orig.size || 0;
    let w = 2 * s0, h = 2 * s0;
    switch (handle) {
      case "n":  h -= dy; break;
      case "s":  h += dy; break;
      case "w":  w -= dx; break;
      case "e":  w += dx; break;
      case "nw": h -= dy; w -= dx; break;
      case "ne": h -= dy; w += dx; break;
      case "se": h += dy; w += dx; break;
      case "sw": h += dy; w -= dx; break;
    }
    obj.size = Math.max(MIN_SIZE, (w + h) / 4);
    obj.x = orig.x;
    obj.y = orig.y;
    return;
  }
  // Branch B: endpoint handles (line / circuit / labeler / polyline / curve).
  // Circuit reuses the line's p0/p1 terminal drag (body re-centers at render);
  // labeler treats p0 = leader anchor, p1 = label position (drag to reshape).
  if (obj.type === "line" || obj.type === "circuit" || obj.type === "labeler") {
    if (handle === "p0") {
      const dragged = { x: orig.p1.x + dx, y: orig.p1.y + dy };
      obj.p1 = ctrlKey ? snapLineEndpoint(orig.p2, dragged) : dragged;
    } else {
      const dragged = { x: orig.p2.x + dx, y: orig.p2.y + dy };
      obj.p2 = ctrlKey ? snapLineEndpoint(orig.p1, dragged) : dragged;
    }
    return;
  }
  // Open polyline & open curve: per-vertex endpoint handles (branch B). A CLOSED
  // polyline or closed curve instead falls through to branch-A bbox resize below.
  if ((obj.type === "curve" && !obj.closed) || (obj.type === "polyline" && obj.closed !== true)) {
    const i = parseInt(handle.slice(1), 10);
    let dragged = { x: orig.points[i].x + dx, y: orig.points[i].y + dy };
    // Ctrl angle-constraint (Feature B): snap the dragged vertex so its segment to
    // the PREVIOUS neighbor (i-1) — or the NEXT neighbor (i+1) for vertex 0 — falls
    // on a 15° increment. Reuses the SAME helper/key/increment as the line handle.
    if (ctrlKey && orig.points.length > 1) {
      const anchor = orig.points[i === 0 ? 1 : i - 1];
      if (anchor) dragged = snapLineEndpoint(anchor, dragged);
    }
    obj.points = orig.points.map((p, j) =>
      j === i ? dragged : { x: p.x, y: p.y }
    );
    return;
  }

  // Branch A: bounding box resize (rect / ellipse / triangle / closed polyline / closed curve).
  // Closed polyline and closed curve have no x/y/w/h ??derive the box from the point cloud,
  // run the SAME per-handle math, then scale ALL points about the anchored corner.
  const isPoly  = isClosedPoly(obj);
  const isCurve = isClosedCurve(obj);
  const box0 = (isPoly || isCurve) ? polyBBox(orig.points) : orig;
  const ratio = box0.w / box0.h;
  let { x, y, w, h } = box0;

  switch (handle) {
    case "n":  y += dy; h -= dy; break;
    case "s":  h += dy;          break;
    case "w":  x += dx; w -= dx; break;
    case "e":  w += dx;          break;
    case "nw": y += dy; h -= dy; x += dx; w -= dx; break;
    case "ne": y += dy; h -= dy;           w += dx; break;
    case "se": h += dy;           w += dx;          break;
    case "sw": h += dy; x += dx; w -= dx;           break;
  }

  // Shift = keep original aspect ratio (DESIGN 4-1). Grouped objects ALWAYS keep
  // ratio, Shift-independent and forced (DESIGN 6-2) ??breaking a group's ratio
  // would distort the relative layout the grouping is meant to preserve.
  // Reference axis is fixed by HANDLE TYPE (not by live dx-vs-dy), so it never
  // flips mid-drag on a diagonal where dx ??dy ??which used to cause size jumps.
  //   vertical edges (n/s) ??height drives:  w = h * ratio
  //   everything else (e/w + all corners)   ??width drives:  h = w / ratio
  if ((shiftKey || obj.groupId || obj.lockAspect) && ratio > 0 && isFinite(ratio)) {
    if (handle === "n" || handle === "s") {
      // height is the driver ??snap w to follow h
      w = h * ratio;
      if (handle === "w" || handle === "nw" || handle === "sw") {
        x = box0.x + box0.w - w;
      }
    } else {
      // width is the driver ??snap h to follow w
      h = w / ratio;
      if (handle === "n" || handle === "nw" || handle === "ne") {
        y = box0.y + box0.h - h;
      }
    }
  }

  // Clamp to minimum size; keep the anchored edge fixed
  if (w < MIN_SIZE) {
    if (handle === "w" || handle === "nw" || handle === "sw") x = box0.x + box0.w - MIN_SIZE;
    w = MIN_SIZE;
  }
  if (h < MIN_SIZE) {
    if (handle === "n" || handle === "nw" || handle === "ne") y = box0.y + box0.h - MIN_SIZE;
    h = MIN_SIZE;
  }

  // Closed polyline / closed curve: scale ALL points about the anchor.
  // p' = anchor + (p - anchor) * (sx, sy) ??the box0 ??new-box affine.
  if (isPoly || isCurve) {
    const sx = box0.w ? w / box0.w : 1;
    const sy = box0.h ? h / box0.h : 1;
    obj.points = orig.points.map((p) => ({
      x: x + (p.x - box0.x) * sx,
      y: y + (p.y - box0.y) * sy,
    }));
    return;
  }

  obj.x = x;
  obj.y = y;
  obj.w = w;
  obj.h = h;
  if (obj.type === "apparatus" && (obj.kind || "wire") === "wire") {
    obj.length = Math.max(MIN_SIZE, w);
    obj.h = Math.max(obj.h, (obj.gap || 1.2) + swSafe(obj));
  }
}

function swSafe(obj) {
  return Math.max(Number(obj.strokeWidth) || 0.2, 0.2);
}

/* positionLocked resize uses the original center as its fixed anchor. */
function applyHandleDelta(obj, orig, handle, dx, dy, shiftKey, ctrlKey) {
  applyHandleDeltaBase(obj, orig, handle, dx, dy, shiftKey, ctrlKey);
  if (!orig.positionLocked) return;
  const before = objectCenter(orig);
  const after = objectCenter(obj);
  translateObject(obj, before.x - after.x, before.y - after.y);
}

/* ----- world bbox of one object (text uses its rendered <text> box) ----- */
function objWorldBBox(o, svg) {
  if (o.type === "rect" || o.type === "ellipse" || o.type === "triangle" || o.type === "image" || o.type === "axes" || o.type === "optics" || o.type === "apparatus") {
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
  if (o.type === "anglearc") {
    const r = o.radius || 0;
    return { x: o.x - r, y: o.y - r, w: 2 * r, h: 2 * r };
  }
  if (o.type === "rightangle") {
    const r = (o.size || 0) * 1.6;
    return { x: o.x - r, y: o.y - r, w: 2 * r, h: 2 * r };
  }
  if (o.type === "text") {
    const el = svg.querySelector(`[data-id="${o.id}"]`);
    if (el) {
      try { const bb = el.getBBox(); return { x: bb.x, y: bb.y, w: bb.width, h: bb.height }; }
      catch (_) { /* not laid out */ }
    }
    return null;
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
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of pts) { if (p.x < a) a = p.x; if (p.y < b) b = p.y; if (p.x > c) c = p.x; if (p.y > d) d = p.y; }
    return { x: a, y: b, w: c - a, h: d - b };
  }
  return null;
}

/* ----- union bbox of several objects (matches render's combinedGroupBBox) ----- */
function groupBBox(objs, svg) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objs) {
    const b = objWorldBBox(o, svg);
    if (!b) continue;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ----- whole-group resize: uniform scale about the opposite corner -----
 * Recomputes the new combined box with the SAME per-handle math as the single
 * object path, but aspect ratio is FORCED unconditionally (DESIGN 6-2, Shift-
 * independent). Every member is then remapped by the box0 ??newBox affine, so
 * the relative layout the grouping preserves is kept intact. */
function applyGroupResize(objs, origObjs, box0, handle, dx, dy) {
  const ratio = box0.w / box0.h;
  let { x, y, w, h } = box0;

  switch (handle) {
    case "n":  y += dy; h -= dy; break;
    case "s":  h += dy;          break;
    case "w":  x += dx; w -= dx; break;
    case "e":  w += dx;          break;
    case "nw": y += dy; h -= dy; x += dx; w -= dx; break;
    case "ne": y += dy; h -= dy;           w += dx; break;
    case "se": h += dy;           w += dx;          break;
    case "sw": h += dy; x += dx; w -= dx;           break;
  }

  // Forced aspect lock. Reference axis fixed by handle type (never flips mid-drag).
  if (ratio > 0 && isFinite(ratio)) {
    if (handle === "n" || handle === "s") {
      w = h * ratio;
      if (handle === "w" || handle === "nw" || handle === "sw") x = box0.x + box0.w - w;
    } else {
      h = w / ratio;
      if (handle === "n" || handle === "nw" || handle === "ne") y = box0.y + box0.h - h;
    }
  }

  // Clamp to a minimum group size, keeping the anchored edge fixed and ratio intact.
  if (w < MIN_SIZE) {
    if (handle === "w" || handle === "nw" || handle === "sw") x = box0.x + box0.w - MIN_SIZE;
    w = MIN_SIZE; if (ratio > 0 && isFinite(ratio)) h = w / ratio;
  }
  if (h < MIN_SIZE) {
    if (handle === "n" || handle === "nw" || handle === "ne") y = box0.y + box0.h - MIN_SIZE;
    h = MIN_SIZE; if (ratio > 0 && isFinite(ratio)) w = h * ratio;
  }

  const sx = w / box0.w, sy = h / box0.h;
  const mapPt = (px, py) => ({ x: x + (px - box0.x) * sx, y: y + (py - box0.y) * sy });

  for (const obj of objs) {
    const orig = origObjs[obj.id];
    if (!orig) continue;
    if (orig.type === "rect" || orig.type === "ellipse" || orig.type === "triangle" || orig.type === "image" || orig.type === "axes" || orig.type === "optics" || orig.type === "apparatus") {
      const p = mapPt(orig.x, orig.y);
      obj.x = p.x; obj.y = p.y; obj.w = orig.w * sx; obj.h = orig.h * sy;
    } else if (orig.type === "anglearc") {
      const p = mapPt(orig.x, orig.y);
      obj.x = p.x; obj.y = p.y; obj.radius = orig.radius * sx; // forced ratio: sx == sy
    } else if (orig.type === "rightangle") {
      const p = mapPt(orig.x, orig.y);
      obj.x = p.x; obj.y = p.y; obj.size = orig.size * sx;
    } else if (orig.type === "text") {
      const p = mapPt(orig.x, orig.y);
      obj.x = p.x; obj.y = p.y;
      obj.fontSize = orig.fontSize * sx; // sx == sy under forced ratio
    } else if (orig.type === "line" || orig.type === "circuit" || orig.type === "labeler") {
      obj.p1 = mapPt(orig.p1.x, orig.p1.y);
      obj.p2 = mapPt(orig.p2.x, orig.p2.y);
    } else if (orig.type === "polyline" || orig.type === "curve") {
      obj.points = orig.points.map((p) => mapPt(p.x, p.y));
    }
    if (orig.positionLocked) {
      const before = objectCenter(orig);
      const after = objectCenter(obj);
      translateObject(obj, before.x - after.x, before.y - after.y);
    }
  }
}

/* ===== PUBLIC: wire all event listeners ===== */
export function initTransform(svg, state) {

  /* -- Space tracking (mirror viewport.js/tools.js; keep independent) -- */
  window.addEventListener("keydown", (e) => { if (e.code === "Space") _spaceHeld = true; });
  window.addEventListener("keyup",   (e) => { if (e.code === "Space") _spaceHeld = false; });

  /* -- Undo/Redo keyboard: Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y -- */
  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo(state);
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      redo(state);
    }
  });

  /* -- Keyboard shortcuts: Delete, Arrow nudge, Ctrl+C/V, PageUp/Down, F (flipY) -- */
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (isEditingFieldTarget(t)) return;

    const s = state.get();
    const selectedIds = s.selectedIds || [];

    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === "c") {
      if (selectedIds.length !== 1) return;
      const obj = s.objects.find((o) => o.id === selectedIds[0]);
      const value = objectAngleDeg(obj);
      if (value == null || !isFinite(value)) return;
      e.preventDefault();
      _propertyClipboard = { kind: "angle", value };
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === "v") {
      if (!_propertyClipboard || _propertyClipboard.kind !== "angle" || !selectedIds.length) return;
      e.preventDefault();
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        let changed = false;
        (s2.selectedIds || []).forEach((id) => {
          const obj = s2.objects.find((o) => o.id === id);
          if (applyAngleDeg(obj, _propertyClipboard.value)) changed = true;
        });
        if (changed) {
          s2.undoStack.push(snap);
          s2.redoStack = [];
        }
      });
      return;
    }

    // Ctrl+C ??copy selected objects into module-level clipboard
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !e.shiftKey) {
      if (!selectedIds.length) return;
      _clipboard = selectedIds
        .map(id => s.objects.find(o => o.id === id))
        .filter(Boolean)
        .map(obj => JSON.parse(JSON.stringify(obj)));
      return;
    }

    // Ctrl+V ??paste the copied selection CENTERED at the latest mouse world
    // position (fallback: current viewport center). Relative positions within a
    // multi-object paste are preserved; every clone gets a fresh id; one undo entry.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && !e.shiftKey) {
      if (!_clipboard || !_clipboard.length) return;
      e.preventDefault();
      const snap = JSON.parse(JSON.stringify(s.objects));
      // Target = mouse world coord, or viewport center if the mouse is unknown.
      const target = _lastMouseWorld
        ? _lastMouseWorld
        : { x: s.viewBox.x + s.viewBox.w / 2, y: s.viewBox.y + s.viewBox.h / 2 };
      const bbox = clipboardBBox(_clipboard);
      const cx = bbox ? bbox.x + bbox.w / 2 : target.x;
      const cy = bbox ? bbox.y + bbox.h / 2 : target.y;
      const dx = target.x - cx;
      const dy = target.y - cy;
      const newObjs = _clipboard.map((src, i) => {
        const newObj = JSON.parse(JSON.stringify(src));
        newObj.id = String(Date.now() + i);
        applyDelta(newObj, src, dx, dy); // handles every shape type incl. image
        return newObj;
      });
      state.update((s2) => {
        s2.undoStack.push(snap);
        s2.redoStack = [];
        newObjs.forEach(o => s2.objects.push(o));
        s2.selectedIds = newObjs.map(o => o.id);
      });
      return;
    }

    // Delete ??remove all selected objects with undo snapshot
    if (e.key === "Delete") {
      if (!selectedIds.length) return;
      e.preventDefault();
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        s2.undoStack.push(snap);
        s2.redoStack = [];
        // locked objects are never deleted; remove only selected + mutable ones
        s2.objects = s2.objects.filter((o) => !(selectedIds.includes(o.id) && isMutable(o)));
        s2.selectedIds = [];
      });
      return;
    }

    // Arrow nudge (0.5 world units; Ctrl = 5 units; snapshot pushed on first keydown only)
    if (e.key === "ArrowUp" || e.key === "ArrowDown" ||
        e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (!selectedIds.length) return;
      e.preventDefault();
      if (s.activeTool === "rotate") {
        const selected = selectedIds.map(id => s.objects.find((o) => o.id === id)).filter(Boolean);
        if (selected.some((o) => !isMutable(o))) return;
        const snap = JSON.parse(JSON.stringify(s.objects));
        const flipAxis = (e.key === "ArrowLeft" || e.key === "ArrowRight") ? "flipX" : "flipY";
        state.update((s2) => {
          const ids = s2.selectedIds || [];
          let changed = false;
          ids.forEach(id => {
            const o = s2.objects.find((o) => o.id === id);
            if (!isMutable(o)) return;
            if (isClosedPoly(o) || isClosedCurve(o)) { flipPolyPoints(o, flipAxis); changed = true; return; }
            if (!["rect", "ellipse", "triangle"].includes(o.type)) return;
            o[flipAxis] = !(o[flipAxis] ?? false);
            changed = true;
          });
          if (changed) { s2.undoStack.push(snap); s2.redoStack = []; }
        });
        return;
      }
      const nudge = e.ctrlKey ? 5 : 0.5;
      const selected = selectedIds.map(id => s.objects.find((o) => o.id === id)).filter(Boolean);
      if (selected.some((o) => !isPositionMovable(o))) return;
      const dx = e.key === "ArrowLeft" ? -nudge : e.key === "ArrowRight" ? nudge : 0;
      const dy = e.key === "ArrowUp"   ? -nudge : e.key === "ArrowDown"  ? nudge : 0;
      const isFirst = !_arrowKeysHeld.has(e.key);
      if (isFirst) _arrowKeysHeld.add(e.key);
      const snap = isFirst ? JSON.parse(JSON.stringify(s.objects)) : null;
      state.update((s2) => {
        const ids = s2.selectedIds || [];
        if (snap) { s2.undoStack.push(snap); s2.redoStack = []; }
        ids.forEach(id => {
          const obj = s2.objects.find((o) => o.id === id);
          if (!isPositionMovable(obj)) return;
          const orig = JSON.parse(JSON.stringify(obj));
          applyDelta(obj, orig, dx, dy);
        });
      });
      return;
    }

    // PageUp ??bring selected objects forward one step in z-order
    if (e.key === "PageUp") {
      if (!selectedIds.length) return;
      e.preventDefault();
      if (s.activeTool === "rotate") {
        const selected = selectedIds.map(id => s.objects.find((o) => o.id === id)).filter(Boolean);
        if (selected.some((o) => !isMutable(o))) return;
        const snap = JSON.parse(JSON.stringify(s.objects));
        // Whole-group rotation: when every selected object shares one groupId,
        // rotate all members about the COMBINED bbox center (group pivot) instead
        // of each object spinning about its own center.
        const gFirst = s.objects.find((o) => o.id === selectedIds[0]);
        const gGid = selectedIds.length > 1 && gFirst && gFirst.groupId &&
          selectedIds.every((id) => s.objects.find((o) => o.id === id)?.groupId === gFirst.groupId)
          ? gFirst.groupId : null;
        if (gGid) {
          const members = selectedIds.map((id) => s.objects.find((o) => o.id === id)).filter(Boolean);
          if (members.some((o) => !isMutable(o))) return;
          const box0 = groupBBox(members, svg);
          if (box0) {
            const px = box0.x + box0.w / 2, py = box0.y + box0.h / 2;
            const r = (5 * Math.PI) / 180, cosT = Math.cos(r), sinT = Math.sin(r);
            const rot = (x, y) => ({
              x: px + cosT * (x - px) - sinT * (y - py),
              y: py + sinT * (x - px) + cosT * (y - py),
            });
            state.update((s2) => {
              members.forEach((m) => {
                const obj = s2.objects.find((o) => o.id === m.id);
                if (!obj) return;
                if (obj.type === "line") {
                  obj.p1 = rot(obj.p1.x, obj.p1.y);
                  obj.p2 = rot(obj.p2.x, obj.p2.y);
                } else if (obj.type === "polyline" || obj.type === "curve") {
                  obj.points = obj.points.map((p) => rot(p.x, p.y));
                } else if (obj.type === "anglearc") {
                  const c = rot(obj.x, obj.y);          // vertex about group pivot
                  obj.x = c.x; obj.y = c.y;
                  obj.startAngle = (obj.startAngle || 0) - 5;
                } else if (obj.type === "rightangle") {
                  const c = rot(obj.x, obj.y);
                  obj.x = c.x; obj.y = c.y;
                  obj.angle = (obj.angle || 0) + 5;
                } else {
                  const c = rot(obj.x + obj.w / 2, obj.y + obj.h / 2);
                  obj.x = c.x - obj.w / 2;
                  obj.y = c.y - obj.h / 2;
                  obj.rotation = (obj.rotation || 0) + 5;
                }
              });
              s2.undoStack.push(snap); s2.redoStack = [];
            });
          }
          return;
        }
        state.update((s2) => {
          const ids = s2.selectedIds || [];
          let changed = false;
          ids.forEach(id => {
            const o = s2.objects.find((o) => o.id === id);
            if (!isMutable(o)) return;
            if (isClosedPoly(o) || isClosedCurve(o)) { rotatePolyPoints(o, 5); changed = true; return; }
            if (o.type === "rightangle") { o.angle = (o.angle || 0) + 5; changed = true; return; }
            if (!["rect", "ellipse", "triangle", "optics", "apparatus"].includes(o.type)) return;
            o.rotation = (o.rotation ?? 0) + 5;
            changed = true;
          });
          if (changed) { s2.undoStack.push(snap); s2.redoStack = []; }
        });
        return;
      }
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const ids = s2.selectedIds || [];
        // Process from highest index downward to avoid index collision
        const indices = ids
          .map(id => s2.objects.findIndex(o => o.id === id))
          .filter(idx => idx >= 0 && isMutable(s2.objects[idx])) // skip locked
          .sort((a, b) => b - a);
        let moved = false;
        indices.forEach(idx => {
          if (idx === s2.objects.length - 1) return;
          [s2.objects[idx], s2.objects[idx + 1]] = [s2.objects[idx + 1], s2.objects[idx]];
          moved = true;
        });
        if (moved) { s2.undoStack.push(snap); s2.redoStack = []; }
      });
      return;
    }

    // PageDown ??send selected objects backward one step in z-order
    if (e.key === "PageDown") {
      if (!selectedIds.length) return;
      e.preventDefault();
      if (s.activeTool === "rotate") {
        const selected = selectedIds.map(id => s.objects.find((o) => o.id === id)).filter(Boolean);
        if (selected.some((o) => !isMutable(o))) return;
        const snap = JSON.parse(JSON.stringify(s.objects));
        // Whole-group rotation: when every selected object shares one groupId,
        // rotate all members about the COMBINED bbox center (group pivot) instead
        // of each object spinning about its own center.
        const gFirst = s.objects.find((o) => o.id === selectedIds[0]);
        const gGid = selectedIds.length > 1 && gFirst && gFirst.groupId &&
          selectedIds.every((id) => s.objects.find((o) => o.id === id)?.groupId === gFirst.groupId)
          ? gFirst.groupId : null;
        if (gGid) {
          const members = selectedIds.map((id) => s.objects.find((o) => o.id === id)).filter(Boolean);
          if (members.some((o) => !isMutable(o))) return;
          const box0 = groupBBox(members, svg);
          if (box0) {
            const px = box0.x + box0.w / 2, py = box0.y + box0.h / 2;
            const r = (-5 * Math.PI) / 180, cosT = Math.cos(r), sinT = Math.sin(r);
            const rot = (x, y) => ({
              x: px + cosT * (x - px) - sinT * (y - py),
              y: py + sinT * (x - px) + cosT * (y - py),
            });
            state.update((s2) => {
              members.forEach((m) => {
                const obj = s2.objects.find((o) => o.id === m.id);
                if (!obj) return;
                if (obj.type === "line") {
                  obj.p1 = rot(obj.p1.x, obj.p1.y);
                  obj.p2 = rot(obj.p2.x, obj.p2.y);
                } else if (obj.type === "polyline" || obj.type === "curve") {
                  obj.points = obj.points.map((p) => rot(p.x, p.y));
                } else if (obj.type === "anglearc") {
                  const c = rot(obj.x, obj.y);          // vertex about group pivot
                  obj.x = c.x; obj.y = c.y;
                  obj.startAngle = (obj.startAngle || 0) + 5; // screen-CCW = math +
                } else {
                  const c = rot(obj.x + obj.w / 2, obj.y + obj.h / 2);
                  obj.x = c.x - obj.w / 2;
                  obj.y = c.y - obj.h / 2;
                  obj.rotation = (obj.rotation || 0) - 5;
                }
              });
              s2.undoStack.push(snap); s2.redoStack = [];
            });
          }
          return;
        }
        state.update((s2) => {
          const ids = s2.selectedIds || [];
          let changed = false;
          ids.forEach(id => {
            const o = s2.objects.find((o) => o.id === id);
            if (!isMutable(o)) return;
            if (isClosedPoly(o) || isClosedCurve(o)) { rotatePolyPoints(o, -5); changed = true; return; }
            if (o.type === "rightangle") { o.angle = (o.angle || 0) - 5; changed = true; return; }
            if (!["rect", "ellipse", "triangle", "optics", "apparatus"].includes(o.type)) return;
            o.rotation = (o.rotation ?? 0) - 5;
            changed = true;
          });
          if (changed) { s2.undoStack.push(snap); s2.redoStack = []; }
        });
        return;
      }
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const ids = s2.selectedIds || [];
        // Process from lowest index upward to avoid index collision
        const indices = ids
          .map(id => s2.objects.findIndex(o => o.id === id))
          .filter(idx => idx >= 0 && isMutable(s2.objects[idx])) // skip locked
          .sort((a, b) => a - b);
        let moved = false;
        indices.forEach(idx => {
          if (idx <= 0) return;
          [s2.objects[idx], s2.objects[idx - 1]] = [s2.objects[idx - 1], s2.objects[idx]];
          moved = true;
        });
        if (moved) { s2.undoStack.push(snap); s2.redoStack = []; }
      });
      return;
    }

    // F ??toggle flipY on selected triangle(s)
    if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "f") {
      if (!selectedIds.length) return;
      const triangleIds = selectedIds.filter(id => {
        const o = s.objects.find(ob => ob.id === id);
        return isMutable(o) && o.type === "triangle";
      });
      if (!triangleIds.length) return;
      e.preventDefault();
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        triangleIds.forEach(id => {
          const o = s2.objects.find((o) => o.id === id);
          if (!isMutable(o) || o.type !== "triangle") return;
          o.flipY = !(o.flipY ?? false);
        });
        s2.undoStack.push(snap);
        s2.redoStack = [];
      });
    }

    // K ??toggle locked on all selected shape-based objects (V tool only)
    if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "k") {
      if (!selectedIds.length || s.activeTool !== "V") return;
      e.preventDefault();
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const ids = s2.selectedIds || [];
        ids.forEach(id => {
          const o = s2.objects.find((o) => o.id === id);
          if (!o) return; // all types lockable; lock toggle still runs on locked (to unlock)
          o.locked = !(o.locked ?? false);
        });
        s2.undoStack.push(snap);
        s2.redoStack = [];
      });
    }

    // G ??group selected objects (V tool, ?? selected)
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "g") {
      if (s.activeTool !== "V" || selectedIds.length < 2) return;
      e.preventDefault();
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const groupId = Date.now().toString();
        // locked objects are excluded from the group; need ?? mutable members left
        const memberIds = (s2.selectedIds || []).filter(id =>
          isMutable(s2.objects.find((o) => o.id === id)));
        if (memberIds.length < 2) return;
        memberIds.forEach(id => {
          const o = s2.objects.find((o) => o.id === id);
          if (o) o.groupId = groupId;
        });
        s2.groups.push({ id: groupId, memberIds });
        s2.undoStack.push(snap);
        s2.redoStack = [];
      });
      return;
    }

    // Shift+G ??ungroup (V tool, all selected objects share the same groupId)
    if (!e.ctrlKey && !e.metaKey && e.shiftKey && e.key.toLowerCase() === "g") {
      if (s.activeTool !== "V" || !selectedIds.length) return;
      const _refId = s.targetedId || selectedIds[0];
      const _refObj = s.objects.find((o) => o.id === _refId);
      if (!_refObj || !_refObj.groupId) return;
      const _gid = _refObj.groupId;
      if (!s.targetedId && !selectedIds.every(id => {
        const o = s.objects.find((o) => o.id === id);
        return o && o.groupId === _gid;
      })) return;
      e.preventDefault();
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const grp = s2.groups.find((g) => g.id === _gid);
        if (grp) grp.memberIds.forEach(id => {
          const o = s2.objects.find((o) => o.id === id);
          if (o) delete o.groupId;
        });
        s2.groups = s2.groups.filter((g) => g.id !== _gid);
        s2.targetedId = null;
        s2.undoStack.push(snap);
        s2.redoStack = [];
      });
      return;
    }
  });

  /* -- Arrow keyup: clear held set so next keydown is treated as first press -- */
  window.addEventListener("keyup", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown" ||
        e.key === "ArrowLeft" || e.key === "ArrowRight") {
      _arrowKeysHeld.delete(e.key);
    }
  });

  /* -- Capture phase: save selectedIds BEFORE tools.js's bubble handler fires --
   * tools.js registers its mousedown on the bubble phase. The capture phase fires
   * first, giving us the pre-click selectedIds. We use it below to decide whether
   * the click is on an already-selected object (move allowed) or a new one (just
   * select this press; move can start on the NEXT press). */
  svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    _prevSelectedIds = state.get().selectedIds || [];
  }, true); // capture = true

  /* -- Bubble phase: start move if click landed on an ALREADY-selected object -- */
  svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (_spaceHeld) return;
    // Second press of a double-click targets a group member (handled in tools.js).
    // Don't arm a move gesture on it.
    if (e.detail >= 2) return;
    const activeTool = state.get().activeTool;
    if (activeTool !== "V" && activeTool !== "rotate") return;

    // Targeted state: block all transforms; only Shift+G / inspector "揶쏆뮇猿???疫? allowed
    if (state.get().targetedId) return;

    // Handle drag: only active when exactly one object is selected
    const hLabel = e.target.dataset && e.target.dataset.handle;
    const hObjId = e.target.dataset && e.target.dataset.id;
    const s0 = state.get();
    const selectedIds0 = s0.selectedIds || [];

    // Whole-group handle drag (green state): every selected object shares one
    // groupId and handles are drawn on the combined bbox (render id "__group__").
    //  - V tool       ??uniform resize, aspect FORCED (DESIGN 6-2).
    //  - rotate tool  ??rotate ALL members about the combined-bbox center.
    // targeted (orange) already returned above so it can never reach here.
    if (hLabel && (activeTool === "V" || activeTool === "rotate") && selectedIds0.length > 1) {
      const gFirst = s0.objects.find((o) => o.id === selectedIds0[0]);
      const gGid = gFirst && gFirst.groupId &&
        selectedIds0.every((id) => s0.objects.find((o) => o.id === id)?.groupId === gFirst.groupId)
        ? gFirst.groupId : null;
      if (gGid) {
        const members = selectedIds0.map((id) => s0.objects.find((o) => o.id === id)).filter(Boolean);
        if (members.some((o) => !isMutable(o))) return;
        const box0 = groupBBox(members, svg);
        if (box0) {
          if (activeTool === "rotate") {
            // Group rotation only on corner handles (matches single-object rotate).
            const isCorner = ["nw", "ne", "se", "sw"].includes(hLabel);
            if (!isCorner) return;
            _groupRotating  = true;
            _groupMemberIds = members.map((o) => o.id);
            _groupOrigObjs  = {};
            members.forEach((o) => { _groupOrigObjs[o.id] = JSON.parse(JSON.stringify(o)); });
            _rotPivot       = { x: box0.x + box0.w / 2, y: box0.y + box0.h / 2 };
            const mouse     = screenToWorld(svg, s0.viewBox, e.clientX, e.clientY);
            _rotStartAngle  = Math.atan2(mouse.y - _rotPivot.y, mouse.x - _rotPivot.x);
            _pendingSnapshot = JSON.parse(JSON.stringify(s0.objects));
            _didMove        = false;
            e.preventDefault();
          } else {
            _groupResizing    = true;
            _groupHandle      = hLabel;
            _groupBox0        = box0;
            _groupMemberIds   = members.map((o) => o.id);
            _groupOrigObjs    = {};
            members.forEach((o) => { _groupOrigObjs[o.id] = JSON.parse(JSON.stringify(o)); });
            _handleStartWorld = screenToWorld(svg, s0.viewBox, e.clientX, e.clientY);
            _pendingSnapshot  = JSON.parse(JSON.stringify(s0.objects));
            _didMove          = false;
            e.preventDefault();
          }
        }
        return; // never falls through to move-start
      }
    }

    if (hLabel && hObjId && selectedIds0.length === 1 && selectedIds0.includes(hObjId)) {
      const s = s0;
      const obj = s.objects.find((o) => o.id === selectedIds0[0]);
      if (obj) {
        if (!isMutable(obj)) return;
        const isCorner = ["nw", "ne", "se", "sw"].includes(hLabel);
        if (activeTool === "rotate" && isCorner) {
          _rotating       = true;
          _rotObjId       = obj.id;
          _rotOrigObj     = JSON.parse(JSON.stringify(obj));
          // Closed polyline/curve rotates about its bbox CENTER (points are baked,
          // there is no rotation field / opposite-corner pivot to track). anglearc
          // rotates about its VERTEX (= objectCenter), spinning startAngle.
          _rotPivot       = (obj.positionLocked || isClosedPoly(obj) || isClosedCurve(obj) || obj.type === "anglearc" || obj.type === "labeler")
            ? objectCenter(obj) : getRotPivot(obj, hLabel);
          const mouse     = screenToWorld(svg, s.viewBox, e.clientX, e.clientY);
          _rotStartAngle  = Math.atan2(mouse.y - _rotPivot.y, mouse.x - _rotPivot.x);
          _rotPendingSnap = JSON.parse(JSON.stringify(s.objects));
          _rotDidMove     = false;
        } else {
          _handleDragging   = true;
          _handleId         = hLabel;
          _handleOrigObj    = JSON.parse(JSON.stringify(obj));
          _handleStartWorld = screenToWorld(svg, s.viewBox, e.clientX, e.clientY);
          _pendingSnapshot  = JSON.parse(JSON.stringify(s.objects));
          _didMove = false;
        }
        e.preventDefault();
      }
      return; // never falls through to move-start
    }

    if (activeTool !== "V") return; // rotate tool has no body-move behavior

    const s = state.get();
    const selectedIds = s.selectedIds || [];

    const pickedObj = pickSelectableObjectFromEvent(svg, s, e);
    const clickedId = pickedObj?.id || null;

    // Allow move only if the clicked object is in the current selection
    if (!clickedId || !selectedIds.includes(clickedId)) return;

    const obj = pickedObj || s.objects.find((o) => o.id === clickedId);
    if (!obj) return;
    const vb = s.viewBox;
    _moveStartWorld = screenToWorld(svg, vb, e.clientX, e.clientY);
    // Expand to all group members when selected objects share a group
    const _firstMoveObj = s.objects.find((o) => o.id === selectedIds[0]);
    const _sharedGid = _firstMoveObj?.groupId &&
      selectedIds.every(id => s.objects.find((o) => o.id === id)?.groupId === _firstMoveObj.groupId)
      ? _firstMoveObj.groupId : null;
    let _moveIds = [...selectedIds];
    if (_sharedGid) {
      const _mgrp = s.groups.find((g) => g.id === _sharedGid);
      if (_mgrp) _moveIds = [..._mgrp.memberIds];
    }
    const _moveObjs = _moveIds.map(id => s.objects.find((o) => o.id === id)).filter(Boolean);
    if (_moveObjs.some((o) => !isPositionMovable(o))) {
      _moving = false;
      _moveObjIds = [];
      _moveOrigObjs = {};
      _moveStartWorld = null;
      _pendingSnapshot = null;
      _didMove = false;
      return;
    }
    _moving = true;
    _moveObjIds = _moveIds;
    _moveOrigObjs = {};
    _moveIds.forEach(id => {
      const o = s.objects.find((o) => o.id === id);
      if (o) _moveOrigObjs[id] = JSON.parse(JSON.stringify(o));
    });
    _pendingSnapshot = JSON.parse(JSON.stringify(s.objects)); // pre-move state for undo
    _didMove = false;

    svg.style.cursor = "grabbing";
    e.preventDefault(); // suppress text-selection highlight during drag
  });

  /* -- mousemove: handle drag OR body move (live update via store) -- */
  window.addEventListener("mousemove", (e) => {
    _lastMouseWorld = screenToWorld(svg, state.get().viewBox, e.clientX, e.clientY);
    // --- rotation drag ---
    if (_rotating) {
      const vb = state.get().viewBox;
      const mouse = screenToWorld(svg, vb, e.clientX, e.clientY);
      const curAngle = Math.atan2(mouse.y - _rotPivot.y, mouse.x - _rotPivot.x);
      let deltaDeg = (curAngle - _rotStartAngle) * (180 / Math.PI);
      // Ctrl = snap to 15-degree increments (applied to the accumulated delta)
      if (e.ctrlKey) deltaDeg = Math.round(deltaDeg / 15) * 15;

      // Closed polyline / closed curve: bake the rotation into every point about the bbox center.
      if (isClosedPoly(_rotOrigObj) || isClosedCurve(_rotOrigObj)) {
        const rad = deltaDeg * (Math.PI / 180);
        const cosP = Math.cos(rad), sinP = Math.sin(rad);
        const px = _rotPivot.x, py = _rotPivot.y;
        state.update((s) => {
          const obj = s.objects.find((o) => o.id === _rotObjId);
          if (!obj) return;
          obj.points = _rotOrigObj.points.map((p) => ({
            x: px + cosP * (p.x - px) - sinP * (p.y - py),
            y: py + sinP * (p.x - px) + cosP * (p.y - py),
          }));
        });
        if (!_rotDidMove && Math.abs(deltaDeg) > 0.1) _rotDidMove = true;
        return;
      }

      // labeler: a line-like object (p1 = leader anchor, p2 = label position).
      // Rotate BOTH points about the pivot so the leader + label turn together as
      // one object. The label text stays screen-upright (render's makeUprightLabel
      // draws it horizontally regardless of geometry), so it remains readable.
      if (_rotOrigObj.type === "labeler") {
        const rad = deltaDeg * (Math.PI / 180);
        const cosP = Math.cos(rad), sinP = Math.sin(rad);
        const px = _rotPivot.x, py = _rotPivot.y;
        const rp = (p) => ({
          x: px + cosP * (p.x - px) - sinP * (p.y - py),
          y: py + sinP * (p.x - px) + cosP * (p.y - py),
        });
        state.update((s) => {
          const obj = s.objects.find((o) => o.id === _rotObjId);
          if (!obj) return;
          obj.p1 = rp(_rotOrigObj.p1);
          obj.p2 = rp(_rotOrigObj.p2);
        });
        if (!_rotDidMove && Math.abs(deltaDeg) > 0.1) _rotDidMove = true;
        return;
      }

      // anglearc: rotation is stored in startAngle (vertex is the pivot, so the
      // vertex x/y never move). Screen-CW drag = positive deltaDeg = math angle
      // DECREASE, so subtract to make the arc follow the mouse.
      if (_rotOrigObj.type === "anglearc") {
        state.update((s) => {
          const obj = s.objects.find((o) => o.id === _rotObjId);
          if (!obj) return;
          obj.startAngle = (_rotOrigObj.startAngle || 0) - deltaDeg;
        });
        if (!_rotDidMove && Math.abs(deltaDeg) > 0.1) _rotDidMove = true;
        return;
      }

      if (_rotOrigObj.type === "rightangle") {
        state.update((s) => {
          const obj = s.objects.find((o) => o.id === _rotObjId);
          if (!obj) return;
          obj.angle = (_rotOrigObj.angle || 0) + deltaDeg;
        });
        if (!_rotDidMove && Math.abs(deltaDeg) > 0.1) _rotDidMove = true;
        return;
      }

      // Normalize: rotating by ??about pivot P ??rotating by ??about center C + translation.
      // new_center = rotate(orig_center, pivot, ??; stored (x,y) = new_center ??(w/2, h/2).
      const { x: x0, y: y0, w, h, rotation: a0 } = _rotOrigObj;
      const cx0 = x0 + w / 2, cy0 = y0 + h / 2;
      const deltaRad = deltaDeg * (Math.PI / 180);
      const cosT = Math.cos(deltaRad), sinT = Math.sin(deltaRad);
      const newCx = _rotPivot.x + cosT * (cx0 - _rotPivot.x) - sinT * (cy0 - _rotPivot.y);
      const newCy = _rotPivot.y + sinT * (cx0 - _rotPivot.x) + cosT * (cy0 - _rotPivot.y);

      state.update((s) => {
        const obj = s.objects.find((o) => o.id === _rotObjId);
        if (!obj) return;
        obj.x = newCx - w / 2;
        obj.y = newCy - h / 2;
        obj.rotation = (a0 || 0) + deltaDeg;
      });
      if (!_rotDidMove && Math.abs(deltaDeg) > 0.1) _rotDidMove = true;
      return;
    }

    // --- whole-group rotation: rotate every member about the group bbox center ---
    if (_groupRotating) {
      const vb = state.get().viewBox;
      const mouse = screenToWorld(svg, vb, e.clientX, e.clientY);
      const curAngle = Math.atan2(mouse.y - _rotPivot.y, mouse.x - _rotPivot.x);
      let deltaDeg = (curAngle - _rotStartAngle) * (180 / Math.PI);
      // Ctrl = snap to 15-degree increments (same rule as single-object rotation).
      // Aspect lock does NOT apply: rotation never distorts a shape.
      if (e.ctrlKey) deltaDeg = Math.round(deltaDeg / 15) * 15;

      const rad = deltaDeg * (Math.PI / 180);
      const cosT = Math.cos(rad), sinT = Math.sin(rad);
      const px = _rotPivot.x, py = _rotPivot.y;
      const rot = (x, y) => ({
        x: px + cosT * (x - px) - sinT * (y - py),
        y: py + sinT * (x - px) + cosT * (y - py),
      });

      state.update((s) => {
        _groupMemberIds.forEach((id) => {
          const obj = s.objects.find((o) => o.id === id);
          const orig = _groupOrigObjs[id];
          if (!obj || !orig) return;
          const memberCenter = objectCenter(orig);
          const memberRot = orig.positionLocked
            ? (x, y) => rotPt(x, y, memberCenter.x, memberCenter.y, deltaDeg)
            : rot;
          if (orig.type === "line" || orig.type === "circuit" || orig.type === "labeler") {
            obj.p1 = memberRot(orig.p1.x, orig.p1.y);
            obj.p2 = memberRot(orig.p2.x, orig.p2.y);
          } else if (orig.type === "polyline" || orig.type === "curve") {
            obj.points = orig.points.map((p) => memberRot(p.x, p.y));
          } else if (orig.type === "anglearc") {
            // vertex rotates about the pivot; spin lives in startAngle (screen-CW
            // = +deltaDeg = math decrease).
            const c = orig.positionLocked ? memberCenter : rot(memberCenter.x, memberCenter.y);
            obj.x = c.x; obj.y = c.y;
            obj.startAngle = (orig.startAngle || 0) - deltaDeg;
          } else {
            // box-type (rect/ellipse/triangle/text): rotate center about pivot,
            // and bump the member's own rotation field by the same delta.
            const c = orig.positionLocked ? memberCenter : rot(memberCenter.x, memberCenter.y);
            obj.x = c.x - orig.w / 2;
            obj.y = c.y - orig.h / 2;
            obj.rotation = (orig.rotation || 0) + deltaDeg;
          }
        });
      });
      if (!_didMove && Math.abs(deltaDeg) > 0.1) _didMove = true;
      return;
    }

    if (_groupResizing) {
      const vb = state.get().viewBox;
      const cur = screenToWorld(svg, vb, e.clientX, e.clientY);
      const dx = cur.x - _handleStartWorld.x;
      const dy = cur.y - _handleStartWorld.y;
      state.update((s) => {
        const live = _groupMemberIds.map((id) => s.objects.find((o) => o.id === id)).filter(Boolean);
        applyGroupResize(live, _groupOrigObjs, _groupBox0, _groupHandle, dx, dy);
      });
      if (!_didMove && Math.hypot(dx, dy) > MOVE_THRESHOLD) _didMove = true;
      return;
    }

    if (_handleDragging) {
      const vb = state.get().viewBox;
      const cur = screenToWorld(svg, vb, e.clientX, e.clientY);
      const dx = cur.x - _handleStartWorld.x;
      const dy = cur.y - _handleStartWorld.y;
      /* ===== ENDPOINT SNAP HOOK: Shift snaps a dragged line endpoint to a
       * high-priority target (other line endpoint / optical object head). Only the
       * dragged endpoint moves; the opposite endpoint stays fixed. ===== */
      if (!e.shiftKey) setSnapPreview(null);
      state.update((s) => {
        const obj = s.objects.find((o) => o.id === _handleOrigObj.id);
        if (!obj) return;
        applyHandleDelta(obj, _handleOrigObj, _handleId, dx, dy, e.shiftKey, e.ctrlKey);
        let preview = null;
        if (e.shiftKey) {
          // CONSOLIDATED endpoint snap: ONE path resolves both 6b (edge/vertex/
          // curved-surface) and 6c (radial center) and emits a single red dot.
          const scale = getRenderScale();
          const dragged = handleEndpointPoint(obj, _handleId);
          const edgeSnap = dragged
            ? resolveEndpointSnap(dragged, [obj.id], scale, state)
            : null;
          const other = otherEndpointPoint(obj, _handleId);
          const radialSnap = (dragged && other)
            ? resolveRadialCenterSnap(other, dragged, [obj.id], scale, state)
            : null;
          const chosen = dragged ? pickEndpointSnap(edgeSnap, radialSnap) : null;
          if (chosen) {
            preview = chosen.preview;
            if (chosen.attach) setHandleEndpointPoint(obj, _handleId, chosen.target);
          }
        }
        setSnapPreview(preview);
      });
      if (!_didMove && Math.hypot(dx, dy) > MOVE_THRESHOLD) _didMove = true;
      return;
    }

    if (!_moving) return;
    const vb = state.get().viewBox;
    const cur = screenToWorld(svg, vb, e.clientX, e.clientY);
    const rawDx = cur.x - _moveStartWorld.x;
    const rawDy = cur.y - _moveStartWorld.y;

    /* ===== SNAP RESOLVE HOOK: Shift-only preview/attach before applyDelta ===== */
    if (!e.shiftKey) setSnapPreview(null);
    const snapped = resolveSnap(
      _moveObjIds,
      _moveOrigObjs,
      { dx: rawDx, dy: rawDy },
      { shift: e.shiftKey },
      getRenderScale(),
      state,
      svg,
    );
    const dx = snapped.dx, dy = snapped.dy;

    /* ===== SNAP PREVIEW HOOK: publish transient pair before the repaint ===== */
    setSnapPreview(snapped.preview);
    state.update((s) => {
      _moveObjIds.forEach(id => {
        const obj = s.objects.find((o) => o.id === id);
        const orig = _moveOrigObjs[id];
        if (!obj || !orig) return;
        applyDelta(obj, orig, dx, dy);
        if (SHAPE_MOVE_TYPES.has(obj.type)) {
          obj.rotation = snapped.rotation === null ? (orig.rotation || 0) : snapped.rotation;
        }
      });
    });

    if (!_didMove && Math.hypot(dx, dy) > MOVE_THRESHOLD) {
      _didMove = true;
    }
  });

  /* -- pointer/mouse release: commit or discard the pending undo snapshot -- */
  const finishGesture = () => {
    if (_rotating) {
      _rotating = false;
      if (_rotDidMove && _rotPendingSnap) {
        const snap = _rotPendingSnap;
        state.update((s) => {
          s.undoStack.push(snap);
          s.redoStack = [];
        });
      }
      _rotObjId = _rotOrigObj = _rotPivot = _rotPendingSnap = null;
      _rotStartAngle = 0;
      _rotDidMove = false;
      return;
    }

    if (_groupRotating) {
      _groupRotating = false;
      if (_didMove && _pendingSnapshot) {
        const snap = _pendingSnapshot;
        state.update((s) => {
          s.undoStack.push(snap);
          s.redoStack = [];
        });
      }
      _groupMemberIds  = [];
      _groupOrigObjs   = {};
      _rotPivot        = null;
      _rotStartAngle   = 0;
      _pendingSnapshot = null;
      _didMove         = false;
      return;
    }

    if (_groupResizing) {
      _groupResizing = false;
      if (_didMove && _pendingSnapshot) {
        const snap = _pendingSnapshot;
        state.update((s) => {
          s.undoStack.push(snap);
          s.redoStack = [];
        });
      }
      _groupHandle      = null;
      _groupBox0        = null;
      _groupMemberIds   = [];
      _groupOrigObjs    = {};
      _handleStartWorld = null;
      _pendingSnapshot  = null;
      _didMove = false;
      return;
    }

    if (_handleDragging) {
      _handleDragging = false;
      /* ===== SNAP CLEAR HOOK: endpoint-handle release removes the overlay ===== */
      setSnapPreview(null);
      if (_didMove && _pendingSnapshot) {
        const snap = _pendingSnapshot;
        state.update((s) => {
          s.undoStack.push(snap);
          s.redoStack = [];
        });
      }
      _handleId         = null;
      _handleOrigObj    = null;
      _handleStartWorld = null;
      _pendingSnapshot  = null;
      _didMove = false;
      return;
    }

    if (!_moving) return;
    _moving = false;

    /* ===== SNAP CLEAR HOOK: drag completion removes the transient overlay ===== */
    setSnapPreview(null);

    if (_didMove && _pendingSnapshot) {
      const snap = _pendingSnapshot;
      state.update((s) => {
        s.undoStack.push(snap);
        s.redoStack = [];
      });
    } else {
      state.update(() => {});
    }

    _moveStartWorld = null;
    _moveObjIds = [];
    _moveOrigObjs = {};
    _pendingSnapshot = null;
    _didMove = false;
    svg.style.cursor = "";
  };
  window.addEventListener("pointerup", finishGesture);
  window.addEventListener("mouseup", finishGesture);

  /* ===== SNAP CLEAR HOOK: releasing Shift clears preview without pointer motion ===== */
  window.addEventListener("keyup", (e) => {
    if (!_moving || e.key !== "Shift") return;
    setSnapPreview(null);
    const rawDx = _lastMouseWorld && _moveStartWorld ? _lastMouseWorld.x - _moveStartWorld.x : 0;
    const rawDy = _lastMouseWorld && _moveStartWorld ? _lastMouseWorld.y - _moveStartWorld.y : 0;
    state.update((s) => {
      _moveObjIds.forEach((id) => {
        const obj = s.objects.find((o) => o.id === id);
        const orig = _moveOrigObjs[id];
        if (!obj || !orig) return;
        applyDelta(obj, orig, rawDx, rawDy);
        if (SHAPE_MOVE_TYPES.has(obj.type)) obj.rotation = orig.rotation || 0;
      });
    });
  });

  /* Pointer cancellation must not leave a live gesture or preview state behind. */
  window.addEventListener("pointercancel", () => {
    /* ===== SNAP CLEAR HOOK: cancelled drags discard the transient overlay ===== */
    setSnapPreview(null);
    const snap = _rotPendingSnap || _pendingSnapshot;
    if (snap) state.update((s) => { s.objects = cloneObjects(snap); });
    _moving = _handleDragging = _groupResizing = _rotating = _groupRotating = false;
    _moveObjIds = [];
    _moveOrigObjs = {};
    _moveStartWorld = null;
    _handleId = _handleOrigObj = _handleStartWorld = null;
    _groupHandle = _groupBox0 = null;
    _groupMemberIds = [];
    _groupOrigObjs = {};
    _rotObjId = _rotOrigObj = _rotPivot = _rotPendingSnap = null;
    _pendingSnapshot = null;
    _didMove = _rotDidMove = false;
    svg.style.cursor = "";
  });
}
