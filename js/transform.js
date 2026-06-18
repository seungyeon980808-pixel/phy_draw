/* ===== TRANSFORM (DESIGN §3 select-tool MOVE + snapshot-based Undo/Redo) ===== */
//
// Owns two concerns:
//   1. Body-drag MOVE of the selected object (V tool only).
//   2. Snapshot-based Undo/Redo engine (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y).
//
// Undo strategy: whole-objects-array snapshot (fine at this scale, DESIGN §9).
// Snapshot is captured at drag start; committed only if the pointer crossed a
// distance threshold — so a plain click never creates a useless undo entry.
//
// Coordination with tools.js: tools.js updates selectedIds on mousedown (bubble
// phase). We use a capture-phase listener to read the PRE-click selectedIds, so
// we can distinguish "click on already-selected → move allowed" from "click
// selects a new object → just select, no move this press."

import { screenToWorld } from "./viewport.js?v=0.11.0";

/* ----- shared lock guard: locked objects are excluded from mutating ops ----- */
function isMutable(o) { return o && !o.locked; }

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

function rebuildGroups(s) {
  const map = {};
  s.objects.forEach(o => {
    if (o.groupId) {
      if (!map[o.groupId]) map[o.groupId] = [];
      map[o.groupId].push(o.id);
    }
  });
  s.groups = Object.entries(map).map(([id, memberIds]) => ({ id, memberIds }));
}

function undo(state) {
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

function redo(state) {
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

let _moving = false;
let _moveObjIds = [];
let _moveStartWorld = null; // world coords of the mousedown that started the drag
let _moveOrigObjs = {};     // map from id → deep clone of the object's geometry at drag start
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
let _groupOrigObjs  = {};    // id → deep clone at drag start
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
let _lastMouseWorld = { x: 0, y: 0 };
const _arrowKeysHeld = new Set();

/* ----- set object position from original + delta (avoids float drift) ----- */
function applyDelta(obj, orig, dx, dy) {
  if (obj.type === "rect" || obj.type === "ellipse" ||
      obj.type === "triangle" || obj.type === "text") {
    obj.x = orig.x + dx;
    obj.y = orig.y + dy;
  } else if (obj.type === "line") {
    obj.p1 = { x: orig.p1.x + dx, y: orig.p1.y + dy };
    obj.p2 = { x: orig.p2.x + dx, y: orig.p2.y + dy };
  } else if (obj.type === "polyline" || obj.type === "curve") {
    obj.points = orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
}

const MIN_SIZE = 0.3; // world units; minimum w or h after resize

/* ----- apply one handle drag delta to an object ----- */
function applyHandleDelta(obj, orig, handle, dx, dy, shiftKey) {
  // Branch B: endpoint handles (line / polyline / curve)
  if (obj.type === "line") {
    if (handle === "p0") {
      obj.p1 = { x: orig.p1.x + dx, y: orig.p1.y + dy };
    } else {
      obj.p2 = { x: orig.p2.x + dx, y: orig.p2.y + dy };
    }
    return;
  }
  if (obj.type === "polyline" || obj.type === "curve") {
    const i = parseInt(handle.slice(1), 10);
    obj.points = orig.points.map((p, j) =>
      j === i ? { x: p.x + dx, y: p.y + dy } : { x: p.x, y: p.y }
    );
    return;
  }

  // Branch A: bounding box resize (rect / ellipse / triangle)
  const ratio = orig.w / orig.h;
  let { x, y, w, h } = orig;

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
  // ratio, Shift-independent and forced (DESIGN 6-2) — breaking a group's ratio
  // would distort the relative layout the grouping is meant to preserve.
  // Reference axis is fixed by HANDLE TYPE (not by live dx-vs-dy), so it never
  // flips mid-drag on a diagonal where dx ≈ dy — which used to cause size jumps.
  //   vertical edges (n/s) → height drives:  w = h * ratio
  //   everything else (e/w + all corners)   → width drives:  h = w / ratio
  if ((shiftKey || obj.groupId) && ratio > 0 && isFinite(ratio)) {
    if (handle === "n" || handle === "s") {
      // height is the driver → snap w to follow h
      w = h * ratio;
      if (handle === "w" || handle === "nw" || handle === "sw") {
        x = orig.x + orig.w - w;
      }
    } else {
      // width is the driver → snap h to follow w
      h = w / ratio;
      if (handle === "n" || handle === "nw" || handle === "ne") {
        y = orig.y + orig.h - h;
      }
    }
  }

  // Clamp to minimum size; keep the anchored edge fixed
  if (w < MIN_SIZE) {
    if (handle === "w" || handle === "nw" || handle === "sw") x = orig.x + orig.w - MIN_SIZE;
    w = MIN_SIZE;
  }
  if (h < MIN_SIZE) {
    if (handle === "n" || handle === "nw" || handle === "ne") y = orig.y + orig.h - MIN_SIZE;
    h = MIN_SIZE;
  }

  obj.x = x;
  obj.y = y;
  obj.w = w;
  obj.h = h;
}

/* ----- world bbox of one object (text uses its rendered <text> box) ----- */
function objWorldBBox(o, svg) {
  if (o.type === "rect" || o.type === "ellipse" || o.type === "triangle") {
    return { x: o.x, y: o.y, w: o.w, h: o.h };
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
 * independent). Every member is then remapped by the box0 → newBox affine, so
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
    if (orig.type === "rect" || orig.type === "ellipse" || orig.type === "triangle") {
      const p = mapPt(orig.x, orig.y);
      obj.x = p.x; obj.y = p.y; obj.w = orig.w * sx; obj.h = orig.h * sy;
    } else if (orig.type === "text") {
      const p = mapPt(orig.x, orig.y);
      obj.x = p.x; obj.y = p.y;
      obj.fontSize = orig.fontSize * sx; // sx == sy under forced ratio
    } else if (orig.type === "line") {
      obj.p1 = mapPt(orig.p1.x, orig.p1.y);
      obj.p2 = mapPt(orig.p2.x, orig.p2.y);
    } else if (orig.type === "polyline" || orig.type === "curve") {
      obj.points = orig.points.map((p) => mapPt(p.x, p.y));
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
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    const s = state.get();
    const selectedIds = s.selectedIds || [];

    // Ctrl+C — copy selected objects into module-level clipboard
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !e.shiftKey) {
      if (!selectedIds.length) return;
      _clipboard = selectedIds
        .map(id => s.objects.find(o => o.id === id))
        .filter(Boolean)
        .map(obj => JSON.parse(JSON.stringify(obj)));
      return;
    }

    // Ctrl+V — paste clipboard at original position + (1, 1) world unit offset
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && !e.shiftKey) {
      if (!_clipboard || !_clipboard.length) return;
      e.preventDefault();
      const snap = JSON.parse(JSON.stringify(s.objects));
      const newObjs = _clipboard.map((src, i) => {
        const newObj = JSON.parse(JSON.stringify(src));
        newObj.id = String(Date.now() + i);
        if (newObj.type === "rect" || newObj.type === "ellipse" ||
            newObj.type === "triangle" || newObj.type === "text") {
          newObj.x += 1;
          newObj.y += 1;
        } else if (newObj.type === "line") {
          newObj.p1 = { x: newObj.p1.x + 1, y: newObj.p1.y + 1 };
          newObj.p2 = { x: newObj.p2.x + 1, y: newObj.p2.y + 1 };
        } else if (newObj.type === "polyline" || newObj.type === "curve") {
          newObj.points = newObj.points.map((p) => ({ x: p.x + 1, y: p.y + 1 }));
        }
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

    // Delete — remove all selected objects with undo snapshot
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
        const snap = JSON.parse(JSON.stringify(s.objects));
        const flipAxis = (e.key === "ArrowLeft" || e.key === "ArrowRight") ? "flipX" : "flipY";
        state.update((s2) => {
          const ids = s2.selectedIds || [];
          let changed = false;
          ids.forEach(id => {
            const o = s2.objects.find((o) => o.id === id);
            if (!isMutable(o) || !["rect", "ellipse", "triangle"].includes(o.type)) return;
            o[flipAxis] = !(o[flipAxis] ?? false);
            changed = true;
          });
          if (changed) { s2.undoStack.push(snap); s2.redoStack = []; }
        });
        return;
      }
      const nudge = e.ctrlKey ? 5 : 0.5;
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
          if (!isMutable(obj)) return; // locked objects are not nudged
          const orig = JSON.parse(JSON.stringify(obj));
          applyDelta(obj, orig, dx, dy);
        });
      });
      return;
    }

    // PageUp — bring selected objects forward one step in z-order
    if (e.key === "PageUp") {
      if (!selectedIds.length) return;
      e.preventDefault();
      if (s.activeTool === "rotate") {
        const snap = JSON.parse(JSON.stringify(s.objects));
        state.update((s2) => {
          const ids = s2.selectedIds || [];
          let changed = false;
          ids.forEach(id => {
            const o = s2.objects.find((o) => o.id === id);
            if (!isMutable(o) || !["rect", "ellipse", "triangle"].includes(o.type)) return;
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

    // PageDown — send selected objects backward one step in z-order
    if (e.key === "PageDown") {
      if (!selectedIds.length) return;
      e.preventDefault();
      if (s.activeTool === "rotate") {
        const snap = JSON.parse(JSON.stringify(s.objects));
        state.update((s2) => {
          const ids = s2.selectedIds || [];
          let changed = false;
          ids.forEach(id => {
            const o = s2.objects.find((o) => o.id === id);
            if (!isMutable(o) || !["rect", "ellipse", "triangle"].includes(o.type)) return;
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

    // F — toggle flipY on selected triangle(s)
    if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "f") {
      if (!selectedIds.length) return;
      const triangleIds = selectedIds.filter(id => {
        const o = s.objects.find(ob => ob.id === id);
        return isMutable(o) && o.type === "triangle"; // skip locked
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

    // K — toggle locked on all selected shape-based objects (V tool only)
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

    // G — group selected objects (V tool, ≥2 selected)
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "g") {
      if (s.activeTool !== "V" || selectedIds.length < 2) return;
      e.preventDefault();
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const groupId = Date.now().toString();
        // locked objects are excluded from the group; need ≥2 mutable members left
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

    // Shift+G — ungroup (V tool, all selected objects share the same groupId)
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

    // Targeted state: block all transforms; only Shift+G / inspector "개체 풀기" allowed
    if (state.get().targetedId) return;

    // Handle drag: only active when exactly one object is selected
    const hLabel = e.target.dataset && e.target.dataset.handle;
    const hObjId = e.target.dataset && e.target.dataset.id;
    const s0 = state.get();
    const selectedIds0 = s0.selectedIds || [];

    // Whole-group handle drag (green state): every selected object shares one
    // groupId and handles are drawn on the combined bbox (render id "__group__").
    //  - V tool       → uniform resize, aspect FORCED (DESIGN 6-2).
    //  - rotate tool  → rotate ALL members about the combined-bbox center.
    // targeted (orange) already returned above so it can never reach here.
    if (hLabel && (activeTool === "V" || activeTool === "rotate") && selectedIds0.length > 1) {
      const gFirst = s0.objects.find((o) => o.id === selectedIds0[0]);
      const gGid = gFirst && gFirst.groupId &&
        selectedIds0.every((id) => s0.objects.find((o) => o.id === id)?.groupId === gFirst.groupId)
        ? gFirst.groupId : null;
      if (gGid) {
        const members = selectedIds0.map((id) => s0.objects.find((o) => o.id === id)).filter(Boolean);
        if (members.some((o) => o.locked)) return; // a locked member blocks the gesture
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
        if (obj.locked) return; // locked objects block handle and rotation drag
        const isCorner = ["nw", "ne", "se", "sw"].includes(hLabel);
        if (activeTool === "rotate" && isCorner) {
          _rotating       = true;
          _rotObjId       = obj.id;
          _rotOrigObj     = JSON.parse(JSON.stringify(obj));
          _rotPivot       = getRotPivot(obj, hLabel);
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

    // Find the clicked object by traversing up from the event target
    let el = e.target;
    let clickedId = null;
    while (el && el !== svg) {
      if (el.dataset && el.dataset.id) { clickedId = el.dataset.id; break; }
      el = el.parentElement;
    }

    // Allow move only if the clicked object is in the current selection
    if (!clickedId || !selectedIds.includes(clickedId)) return;

    const obj = s.objects.find((o) => o.id === clickedId);
    if (!obj) return;
    if (obj.locked) return; // locked objects block body-move

    const vb = s.viewBox;
    _moveStartWorld = screenToWorld(svg, vb, e.clientX, e.clientY);
    _moving = true;
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
    _moveObjIds = _moveIds;
    _moveOrigObjs = {};
    _moveIds.forEach(id => {
      const o = s.objects.find((o) => o.id === id);
      if (o) _moveOrigObjs[id] = JSON.parse(JSON.stringify(o));
    });
    _pendingSnapshot = JSON.parse(JSON.stringify(s.objects)); // pre-move state for undo
    _didMove = false;

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

      // Normalize: rotating by δ about pivot P ≡ rotating by δ about center C + translation.
      // new_center = rotate(orig_center, pivot, δ); stored (x,y) = new_center − (w/2, h/2).
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
          if (orig.type === "line") {
            obj.p1 = rot(orig.p1.x, orig.p1.y);
            obj.p2 = rot(orig.p2.x, orig.p2.y);
          } else if (orig.type === "polyline" || orig.type === "curve") {
            obj.points = orig.points.map((p) => rot(p.x, p.y));
          } else {
            // box-type (rect/ellipse/triangle/text): rotate center about pivot,
            // and bump the member's own rotation field by the same delta.
            const c = rot(orig.x + orig.w / 2, orig.y + orig.h / 2);
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
      state.update((s) => {
        const obj = s.objects.find((o) => o.id === _handleOrigObj.id);
        if (!obj) return;
        applyHandleDelta(obj, _handleOrigObj, _handleId, dx, dy, e.shiftKey);
      });
      if (!_didMove && Math.hypot(dx, dy) > MOVE_THRESHOLD) _didMove = true;
      return;
    }

    if (!_moving) return;
    const vb = state.get().viewBox;
    const cur = screenToWorld(svg, vb, e.clientX, e.clientY);
    const dx = cur.x - _moveStartWorld.x;
    const dy = cur.y - _moveStartWorld.y;

    state.update((s) => {
      _moveObjIds.forEach(id => {
        const obj = s.objects.find((o) => o.id === id);
        const orig = _moveOrigObjs[id];
        if (!obj || !orig) return;
        applyDelta(obj, orig, dx, dy);
      });
    });

    if (!_didMove && Math.hypot(dx, dy) > MOVE_THRESHOLD) {
      _didMove = true;
    }
  });

  /* -- mouseup: commit or discard the pending undo snapshot -- */
  window.addEventListener("mouseup", () => {
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

    if (_didMove && _pendingSnapshot) {
      const snap = _pendingSnapshot;
      state.update((s) => {
        s.undoStack.push(snap);
        s.redoStack = [];
      });
    }

    _moveStartWorld = null;
    _moveObjIds = [];
    _moveOrigObjs = {};
    _pendingSnapshot = null;
    _didMove = false;
  });
}
