/* ===== RENDER (DESIGN 1-1: SVG is a projection of state.objects) ===== */
//
// render(state) repaints the <g id="scene"> from data. It is registered as a
// store subscriber in main.js, so ANY state.update() repaints automatically —
// no caller ever invokes render() by hand. That is the data-as-truth proof.
//
// Each object carries its own world coordinates (x/y/w/h in viewBox units), so
// the projection stays anchored in world space through zoom/pan (the viewBox
// alone changes what slice of that space is shown).

import { getZoom } from "./viewport.js?v=0.10.0";

const SVG_NS = "http://www.w3.org/2000/svg";

/* rotation-zone cursor: clockwise circular arrow (20×20, 24×24 viewBox) */
const ROT_CURSOR = (() => {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24'>" +
    "<path d='M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4" +
    "c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z' fill='#222'/></svg>";
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") 10 10, grab`;
})();

/* ----- main draw: clear the scene group, repaint from state ----- */
export function render(state) {
  const scene = document.getElementById("scene");
  if (!scene) return;

  // Simplest correct projection: wipe and rebuild. Fine at this scale; a
  // keyed/diffing pass can replace this once object counts grow.
  scene.replaceChildren();

  // ----- artboard: 90mm × 65mm world-space rect, non-interactive, always first -----
  const artboard = document.createElementNS(SVG_NS, "rect");
  artboard.setAttribute("x", "-45");
  artboard.setAttribute("y", "-32.5");
  artboard.setAttribute("width", "90");
  artboard.setAttribute("height", "65");
  artboard.setAttribute("fill", "#ffffff");
  artboard.setAttribute("stroke", "#d0d7de");
  artboard.setAttribute("stroke-width", "1");
  artboard.setAttribute("vector-effect", "non-scaling-stroke");
  artboard.setAttribute("pointer-events", "none");
  scene.appendChild(artboard);

  // ----- committed objects (z-order = array order, DESIGN 1-1) -----
  for (const obj of state.objects) {
    const _layerId = obj.layerId ?? 1;
    const _layer = (state.layers || []).find(l => l.id === _layerId);
    if (_layer && _layer.visible === false) continue;
    const el = renderObject(obj);
    if (!el) continue;
    const _isActive = _layerId === state.activeLayerId;
    if (!_isActive) el.setAttribute("opacity", "0.5");
    if (!_isActive) el.setAttribute("pointer-events", "none");
    scene.appendChild(el);
  }

  // ----- selection outline (blue dashed bbox; world space so it tracks zoom/pan) -----
  const _selIds = state.selectedIds || [];

  // For a grouped multi-selection, draw ONE combined green rect instead of per-member outlines.
  const _groupMembers = _selIds.map((id) => state.objects.find((o) => o.id === id)).filter(Boolean);
  const _firstMember = _groupMembers[0];
  const _allSameGroup = _selIds.length > 1 && _firstMember && _firstMember.groupId &&
    _groupMembers.every((o) => o.groupId === _firstMember.groupId);
  if (_allSameGroup) {
    const _gbox = combinedGroupBBox(_groupMembers, scene);
    if (_gbox) {
      const _grect = document.createElementNS(SVG_NS, "rect");
      _grect.setAttribute("x", _gbox.x);
      _grect.setAttribute("y", _gbox.y);
      _grect.setAttribute("width", _gbox.w);
      _grect.setAttribute("height", _gbox.h);
      _grect.setAttribute("fill", "none");
      _grect.setAttribute("stroke-width", "0.4");
      _grect.setAttribute("stroke-dasharray", "1.2 1.2");
      _grect.style.stroke = "#2f9e44";
      scene.appendChild(_grect);
    }
  }

  for (const _sid of _selIds) {
    if (_allSameGroup) continue; // combined rect already drawn above
    const sel = state.objects.find((o) => o.id === _sid);
    if (!sel) continue;
    const _selLayer = (state.layers || []).find(l => l.id === (sel.layerId ?? 1));
    if (_selLayer && _selLayer.visible === false) continue;
    const _selColor = (state.targetedId === _sid) ? "#e67700"
                    : sel.groupId  ? "#2f9e44"
                    : sel.locked   ? "#e53e3e"
                    : "var(--c-main, #0969da)";
    if (sel.type === "line") {
      // A line has no bbox; its selection guide is a dashed copy of the segment.
      const ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("x1", sel.p1.x);
      ln.setAttribute("y1", sel.p1.y);
      ln.setAttribute("x2", sel.p2.x);
      ln.setAttribute("y2", sel.p2.y);
      ln.setAttribute("stroke-width", "0.4"); // world units
      ln.setAttribute("stroke-dasharray", "1.2 1.2");
      ln.style.stroke = _selColor;
      scene.appendChild(ln);
    } else if (sel.type === "polyline") {
      // A polyline has no fillable bbox; its guide is a dashed copy of the path.
      const pl = document.createElementNS(SVG_NS, "polyline");
      pl.setAttribute("points", sel.points.map((p) => `${p.x},${p.y}`).join(" "));
      pl.setAttribute("fill", "none");
      pl.setAttribute("stroke-width", "0.4"); // world units
      pl.setAttribute("stroke-dasharray", "1.2 1.2");
      pl.style.stroke = _selColor;
      scene.appendChild(pl);
    } else if (sel.type === "curve") {
      // A curve has no fillable bbox; its guide is a dashed copy of the smooth path.
      const cv = document.createElementNS(SVG_NS, "path");
      cv.setAttribute("d", catmullRomPath(sel.points));
      cv.setAttribute("fill", "none");
      cv.setAttribute("stroke-width", "0.4"); // world units
      cv.setAttribute("stroke-dasharray", "1.2 1.2");
      cv.style.stroke = _selColor;
      scene.appendChild(cv);
    } else if (sel.type === "text") {
      // getBBox() on the already-rendered <text> element gives the exact visual bounds.
      const textEl = scene.querySelector(`[data-id="${sel.id}"]`);
      if (textEl) {
        try {
          const bb = textEl.getBBox();
          const box = document.createElementNS(SVG_NS, "rect");
          box.setAttribute("x", bb.x);
          box.setAttribute("y", bb.y);
          box.setAttribute("width", bb.width);
          box.setAttribute("height", bb.height);
          box.setAttribute("fill", "none");
          box.setAttribute("stroke-width", "0.4");
          box.setAttribute("stroke-dasharray", "1.2 1.2");
          box.style.stroke = _selColor;
          scene.appendChild(box);
        } catch (_) { /* not laid out yet */ }
      }
    } else {
      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("x", sel.x);
      box.setAttribute("y", sel.y);
      box.setAttribute("width", sel.w);
      box.setAttribute("height", sel.h);
      box.setAttribute("fill", "none");
      box.setAttribute("stroke-width", "0.4"); // world units
      box.setAttribute("stroke-dasharray", "1.2 1.2");
      box.style.stroke = _selColor;
      if (sel.rotation) {
        const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2;
        box.setAttribute("transform", `rotate(${sel.rotation} ${cx} ${cy})`);
      }
      scene.appendChild(box);
    }
  }

  // ----- selection handles (DESIGN 5-2: fixed 7 CSS px = 7/zoom world units) -----
  if (_selIds.length === 1) {
    const handleSel = state.objects.find((o) => o.id === _selIds[0]);
    if (handleSel && !state.targetedId) {
      renderHandles(handleSel, scene, getZoom(), state.activeTool);
    }
  } else if (_selIds.length > 1 && !state.targetedId) {
    // Whole-group selection (green): every selected object shares one groupId.
    // Draw 8 resize handles on the COMBINED bbox so the group scales as a unit
    // (DESIGN 6-2). Targeted (orange) is excluded above, so it never gets handles.
    const _members = _selIds.map((id) => state.objects.find((o) => o.id === id)).filter(Boolean);
    const _first = _members[0];
    const _sharedGid = _first && _first.groupId &&
      _members.every((o) => o.groupId === _first.groupId) ? _first.groupId : null;
    if (_sharedGid) {
      const _box = combinedGroupBBox(_members, scene);
      if (_box) {
        // Reuse renderHandles via a synthetic axis-aligned rect (id "__group__"):
        // it emits the same 8 white squares the resize logic listens for.
        renderHandles(
          { type: "rect", id: "__group__", x: _box.x, y: _box.y, w: _box.w, h: _box.h, rotation: 0 },
          scene, getZoom(), state.activeTool
        );
      }
    }
  }

  // ----- live drag preview (ephemeral; not in state.objects yet) -----
  if (state.draft) {
    const d = state.draft;

    // For size-based shapes (ellipse/triangle) the bbox differs from the shape
    // outline, so draw a dashed rectangle guide spanning the drag bounds first.
    // (rect's own preview already IS that rectangle; the line has no bbox — it
    // shows its own solid preview below — so both skip the duplicate guide.)
    if (d.type !== "rect" && d.type !== "line" && d.type !== "polyline" && d.type !== "curve") {
      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("x", d.x);
      box.setAttribute("y", d.y);
      box.setAttribute("width", d.w);
      box.setAttribute("height", d.h);
      box.setAttribute("fill", "none");
      box.style.stroke = "var(--c-main, #0969da)";
      box.setAttribute("stroke-width", d.strokeWidth);
      box.setAttribute("stroke-dasharray", "1.2 1.2"); // world-unit dashes
      scene.appendChild(box);
    }

    // The actual shape outline that will be committed, drawn inside the guide.
    // Render it SOLID exactly as the real shape will look (black stroke, same
    // stroke-width from renderObject) — no dashing — so the preview matches.
    const el = renderObject(d);
    if (el) {
      scene.appendChild(el);
    }
  }
}

/* ----- per-object dispatch (one branch per shape type) ----- */
function renderObject(obj) {
  switch (obj.type) {
    case "rect":
      return renderRect(obj);
    case "ellipse":
      return renderEllipse(obj);
    case "triangle":
      return renderTriangle(obj);
    case "line":
      return renderLine(obj);
    case "polyline":
      return renderPolyline(obj);
    case "curve":
      return renderCurve(obj);
    case "text":
      return renderText(obj);
    default:
      return null;
  }
}

/* ----- rect: size-based shape (DESIGN 2-1 branch A) ----- */
function renderRect(obj) {
  const r = document.createElementNS(SVG_NS, "rect");
  r.setAttribute("x", obj.x);
  r.setAttribute("y", obj.y);
  r.setAttribute("width", obj.w);
  r.setAttribute("height", obj.h);

  // fillNone → transparent fill: invisible but still receives clicks (DESIGN 5-3).
  r.setAttribute("fill", obj.fillNone ? "transparent" : grayHex(obj.fillLevel));
  // strokeLevel 0 = black (DESIGN 2-2). stroke-width is in world units.
  r.setAttribute("stroke", grayHex(obj.strokeLevel));
  r.setAttribute("stroke-width", obj.strokeWidth);

  if (obj.rotation) {
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    r.setAttribute("transform", `rotate(${obj.rotation} ${cx} ${cy})`);
  }
  if (obj.id) r.dataset.id = obj.id;
  return r;
}

/* ----- ellipse: size-based shape; bbox (x/y/w/h) → cx/cy + rx/ry ----- */
function renderEllipse(obj) {
  const el = document.createElementNS(SVG_NS, "ellipse");
  el.setAttribute("cx", obj.x + obj.w / 2);
  el.setAttribute("cy", obj.y + obj.h / 2);
  el.setAttribute("rx", obj.w / 2);
  el.setAttribute("ry", obj.h / 2);

  // fillNone → transparent fill: invisible but still receives clicks (DESIGN 5-3).
  el.setAttribute("fill", obj.fillNone ? "transparent" : grayHex(obj.fillLevel));
  el.setAttribute("stroke", grayHex(obj.strokeLevel));
  el.setAttribute("stroke-width", obj.strokeWidth);

  if (obj.rotation) {
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    el.setAttribute("transform", `rotate(${obj.rotation} ${cx} ${cy})`);
  }
  if (obj.id) el.dataset.id = obj.id;
  return el;
}

/* ----- triangle: right-angle corner determined by flipX × flipY ----- */
// flipX false / flipY false: bottom-left   flipX true  / flipY false: bottom-right
// flipX false / flipY true:  top-left      flipX true  / flipY true:  top-right
function renderTriangle(obj) {
  const el = document.createElementNS(SVG_NS, "polygon");
  const flipX = obj.flipX ?? false;
  const flipY = obj.flipY ?? false;
  let pts;
  if (!flipX && !flipY) {
    pts = `${obj.x},${obj.y + obj.h} ${obj.x + obj.w},${obj.y + obj.h} ${obj.x},${obj.y}`;
  } else if (flipX && !flipY) {
    pts = `${obj.x + obj.w},${obj.y + obj.h} ${obj.x},${obj.y + obj.h} ${obj.x + obj.w},${obj.y}`;
  } else if (!flipX && flipY) {
    pts = `${obj.x},${obj.y} ${obj.x + obj.w},${obj.y} ${obj.x},${obj.y + obj.h}`;
  } else {
    pts = `${obj.x + obj.w},${obj.y} ${obj.x},${obj.y} ${obj.x + obj.w},${obj.y + obj.h}`;
  }
  el.setAttribute("points", pts);

  // fillNone → transparent fill: invisible but still receives clicks (DESIGN 5-3).
  el.setAttribute("fill", obj.fillNone ? "transparent" : grayHex(obj.fillLevel));
  el.setAttribute("stroke", grayHex(obj.strokeLevel));
  el.setAttribute("stroke-width", obj.strokeWidth);

  if (obj.rotation) {
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    el.setAttribute("transform", `rotate(${obj.rotation} ${cx} ${cy})`);
  }
  if (obj.id) el.dataset.id = obj.id;
  return el;
}

/* ----- arrowhead: filled triangle pointing in (dirX, dirY), tip at (tipX, tipY) ----- */
function makeArrowHead(tipX, tipY, dirX, dirY, strokeWidth, color) {
  const length     = strokeWidth * 4.5;
  const halfWidth  = strokeWidth * 1.8;
  const notchDepth = length * 0.3;

  const perpX = -dirY, perpY = dirX;

  const baseX = tipX - dirX * length;
  const baseY = tipY - dirY * length;

  const leftX  = baseX + perpX * halfWidth;
  const leftY  = baseY + perpY * halfWidth;
  const rightX = baseX - perpX * halfWidth;
  const rightY = baseY - perpY * halfWidth;

  const notchX = tipX - dirX * (length - notchDepth);
  const notchY = tipY - dirY * (length - notchDepth);

  const poly = document.createElementNS(SVG_NS, "polygon");
  poly.setAttribute("points", `${tipX},${tipY} ${leftX},${leftY} ${notchX},${notchY} ${rightX},${rightY}`);
  poly.setAttribute("fill", color);
  poly.setAttribute("stroke", "none");
  return poly;
}

/* ----- dashes (line/polyline/curve): SVG stroke-dasharray in world units (mm) ----- */
// Solid = dashLength 0 (or gap 0) → no dasharray attribute set at all (DESIGN: presets).
function applyDash(el, obj) {
  const dl = obj.dashLength ?? 0;
  const dg = obj.dashGap ?? 0;
  if (dl > 0 && dg > 0) el.setAttribute("stroke-dasharray", `${dl} ${dg}`);
}

/* ----- point + travel direction at 50% of a polyline's total path length ----- */
// Used by polyline "center" arrowhead: visually natural midpoint of the whole path.
function polylineMidpoint(pts) {
  if (!pts || pts.length < 2) return null;
  const segLens = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const L = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segLens.push(L);
    total += L;
  }
  if (total === 0) return null;
  const target = total / 2;
  let acc = 0;
  for (let i = 0; i < segLens.length; i++) {
    if (acc + segLens[i] >= target) {
      const a = pts[i], b = pts[i + 1];
      const L = segLens[i] || 1;
      const t = (target - acc) / L;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: (b.x - a.x) / L, dy: (b.y - a.y) / L };
    }
    acc += segLens[i];
  }
  return null;
}

/* ----- line: endpoint-based shape (DESIGN 2-1 branch B); p1→p2, no fill ----- */
function renderLine(obj) {
  const arrowHead = obj.arrowHead ?? "none";
  const sw = obj.strokeWidth;
  const color = grayHex(obj.strokeLevel);

  const dx = obj.p2.x - obj.p1.x;
  const dy = obj.p2.y - obj.p1.y;
  const L = Math.sqrt(dx * dx + dy * dy);

  let lx1 = obj.p1.x, ly1 = obj.p1.y;
  let lx2 = obj.p2.x, ly2 = obj.p2.y;
  let nx = 0, ny = 0;

  if (L > 0) {
    nx = dx / L; ny = dy / L;
    const arrowLen = sw * 4.5 * 0.7; // retract to notch: length - notchDepth (length * 0.3)
    if (arrowHead === "end") {
      lx2 -= nx * arrowLen; ly2 -= ny * arrowLen;
    } else if (arrowHead === "both") {
      lx2 -= nx * arrowLen; ly2 -= ny * arrowLen;
      lx1 += nx * arrowLen; ly1 += ny * arrowLen;
    }
    // "center" and "none": no adjustment
  }

  const el = document.createElementNS(SVG_NS, "line");
  el.setAttribute("x1", lx1);
  el.setAttribute("y1", ly1);
  el.setAttribute("x2", lx2);
  el.setAttribute("y2", ly2);
  // strokeLevel 0 = black (DESIGN 2-2). stroke-width is in world units.
  el.setAttribute("stroke", color);
  el.setAttribute("stroke-width", sw);
  applyDash(el, obj);

  if (arrowHead === "none" || L === 0) {
    if (obj.id) el.dataset.id = obj.id;
    return el;
  }

  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;
  g.appendChild(el);

  if (arrowHead === "end") {
    g.appendChild(makeArrowHead(obj.p2.x, obj.p2.y, nx, ny, sw, color));
  } else if (arrowHead === "both") {
    g.appendChild(makeArrowHead(obj.p2.x, obj.p2.y, nx, ny, sw, color));
    g.appendChild(makeArrowHead(obj.p1.x, obj.p1.y, -nx, -ny, sw, color));
  } else if (arrowHead === "center") {
    const mx = (obj.p1.x + obj.p2.x) / 2;
    const my = (obj.p1.y + obj.p2.y) / 2;
    g.appendChild(makeArrowHead(mx, my, nx, ny, sw, color));
  }

  return g;
}

/* ----- polyline: many connected points, black stroke, no fill (click-to-click) ----- */
// Arrowheads use the SAME single arrowHead field + makeArrowHead() as renderLine
// (one setting for the whole line, no per-segment array):
//   end    = last point, direction of the last segment
//   both   = first point (reverse of first segment) + last point
//   center = 50% path-length point, pointing along travel direction
// The arrow-bearing END SEGMENT is retracted by the arrow length, like renderLine.
function renderPolyline(obj) {
  const arrowHead = obj.arrowHead ?? "none";
  const sw = obj.strokeWidth;
  const color = grayHex(obj.strokeLevel);
  const pts = obj.points || [];
  const n = pts.length;

  // Unit directions of the first/last segments (for arrow placement + retraction).
  let endDir = null, startDir = null;
  if (n >= 2) {
    const a = pts[n - 2], b = pts[n - 1];
    const eL = Math.hypot(b.x - a.x, b.y - a.y);
    if (eL > 0) endDir = { x: (b.x - a.x) / eL, y: (b.y - a.y) / eL };
    const c = pts[0], d = pts[1];
    const sL = Math.hypot(d.x - c.x, d.y - c.y);
    if (sL > 0) startDir = { x: (d.x - c.x) / sL, y: (d.y - c.y) / sL };
  }

  // Working copy of the points; retract the arrow-bearing endpoints to the notch.
  const draw = pts.map((p) => ({ x: p.x, y: p.y }));
  const arrowLen = sw * 4.5 * 0.7; // matches renderLine: length - notchDepth
  if ((arrowHead === "end" || arrowHead === "both") && endDir) {
    draw[n - 1] = { x: pts[n - 1].x - endDir.x * arrowLen, y: pts[n - 1].y - endDir.y * arrowLen };
  }
  if (arrowHead === "both" && startDir) {
    draw[0] = { x: pts[0].x + startDir.x * arrowLen, y: pts[0].y + startDir.y * arrowLen };
  }

  const el = document.createElementNS(SVG_NS, "polyline");
  el.setAttribute("points", draw.map((p) => `${p.x},${p.y}`).join(" "));
  el.setAttribute("fill", "none");
  // strokeLevel 0 = black (DESIGN 2-2). stroke-width is in world units.
  el.setAttribute("stroke", color);
  el.setAttribute("stroke-width", sw);
  applyDash(el, obj);

  if (arrowHead === "none" || n < 2) {
    if (obj.id) el.dataset.id = obj.id;
    return el;
  }

  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;
  g.appendChild(el);

  if ((arrowHead === "end" || arrowHead === "both") && endDir) {
    g.appendChild(makeArrowHead(pts[n - 1].x, pts[n - 1].y, endDir.x, endDir.y, sw, color));
  }
  if (arrowHead === "both" && startDir) {
    g.appendChild(makeArrowHead(pts[0].x, pts[0].y, -startDir.x, -startDir.y, sw, color));
  }
  if (arrowHead === "center") {
    const m = polylineMidpoint(pts);
    if (m) g.appendChild(makeArrowHead(m.x, m.y, m.dx, m.dy, sw, color));
  }

  return g;
}

/* ----- Catmull-Rom spline → SVG cubic Bezier path string ----- */
// Passes through every anchor point. 2-point degenerate case = straight line.
function catmullRomPath(pts) {
  if (!pts || pts.length < 2) return "";
  if (pts.length === 2) {
    return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  }
  const n = pts.length;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, n - 1)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2.x} ${p2.y}`;
  }
  return d;
}

/* ----- curve: Catmull-Rom smooth path through anchors, black stroke, no fill ----- */
function renderCurve(obj) {
  const el = document.createElementNS(SVG_NS, "path");
  el.setAttribute("d", catmullRomPath(obj.points));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", grayHex(obj.strokeLevel));
  el.setAttribute("stroke-width", obj.strokeWidth);
  applyDash(el, obj); // curve: dashes only this round (no arrowheads)
  if (obj.id) el.dataset.id = obj.id;
  return el;
}

/* ----- text: SVG <text> with optional multi-line <tspan> elements ----- */
// x/y = top-left anchor in world coords (dominant-baseline: hanging positions y at top).
// Multi-line: split on \n, each line is a <tspan> with dy=fontSize*1.4.
function renderText(obj) {
  const el = document.createElementNS(SVG_NS, "text");
  el.setAttribute("x", obj.x);
  el.setAttribute("y", obj.y);
  el.setAttribute("font-size", obj.fontSize);
  el.setAttribute("fill", "#0d1117");
  el.setAttribute("font-family", "IBM Plex Sans KR, sans-serif");
  el.setAttribute("text-anchor", "start");
  el.setAttribute("dominant-baseline", "hanging");
  if (obj.id) el.dataset.id = obj.id;

  const lines = (obj.text || "").split("\n");
  if (lines.length === 1) {
    el.textContent = lines[0];
  } else {
    lines.forEach((line, i) => {
      const ts = document.createElementNS(SVG_NS, "tspan");
      ts.setAttribute("x", obj.x);
      ts.setAttribute("dy", i === 0 ? "0" : obj.fontSize * 1.4);
      ts.textContent = line || " "; // non-breaking space keeps empty lines tall
      el.appendChild(ts);
    });
  }
  return el;
}

/* ----- rotate point (px,py) about center (cx,cy) by deg degrees (SVG clockwise) ----- */
function rotPt(px, py, cx, cy, deg) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/* ----- grayscale level (0–255) → hex; 0 = black, 255 = white (DESIGN 7-2) ----- */
function grayHex(level = 0) {
  const v = Math.max(0, Math.min(255, Math.round(level)));
  const h = v.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

/* ----- selection handles: 7-CSS-px white squares, zoom-invariant (DESIGN 5-2) ----- */
/* ----- bbox of one object in world space (text uses its rendered <text> box) ----- */
function singleObjBBox(o, scene) {
  if (o.type === "rect" || o.type === "ellipse" || o.type === "triangle") {
    const deg = o.rotation || 0;
    if (!deg) return { x: o.x, y: o.y, w: o.w, h: o.h };
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const corners = [
      rotPt(o.x,       o.y,       cx, cy, deg),
      rotPt(o.x + o.w, o.y,       cx, cy, deg),
      rotPt(o.x + o.w, o.y + o.h, cx, cy, deg),
      rotPt(o.x,       o.y + o.h, cx, cy, deg),
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of corners) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (o.type === "text") {
    const el = scene.querySelector(`[data-id="${o.id}"]`);
    if (el) {
      try { const bb = el.getBBox(); return { x: bb.x, y: bb.y, w: bb.width, h: bb.height }; }
      catch (_) { /* not laid out yet */ }
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

/* ----- union bbox of several objects (for whole-group resize handles) ----- */
function combinedGroupBBox(members, scene) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of members) {
    const b = singleObjBBox(o, scene);
    if (!b) continue;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function renderHandles(sel, scene, zoom, activeTool) {
  const half = 6 / zoom;
  const sw   = 0.5 / zoom;

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("id", "handles");

  const makeHandle = (wx, wy, label) => {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("x", wx - half);
    r.setAttribute("y", wy - half);
    r.setAttribute("width",  half * 2);
    r.setAttribute("height", half * 2);
    r.setAttribute("fill", "#ffffff");
    r.setAttribute("stroke", "#0969da");
    r.setAttribute("stroke-width", sw);
    r.dataset.handle = label;
    r.dataset.id = sel.id;
    g.appendChild(r);
  };

  if (sel.type === "rect" || sel.type === "ellipse" || sel.type === "triangle") {
    const { x, y, w, h } = sel;
    const cx = x + w / 2, cy = y + h / 2;
    const rx = x + w, by = y + h;
    const deg = sel.rotation || 0;

    // Compute rotated world positions for all 8 handle anchor points
    const hNW = rotPt(x,  y,  cx, cy, deg);
    const hN  = rotPt(cx, y,  cx, cy, deg);
    const hNE = rotPt(rx, y,  cx, cy, deg);
    const hE  = rotPt(rx, cy, cx, cy, deg);
    const hSE = rotPt(rx, by, cx, cy, deg);
    const hS  = rotPt(cx, by, cx, cy, deg);
    const hSW = rotPt(x,  by, cx, cy, deg);
    const hW  = rotPt(x,  cy, cx, cy, deg);

    if (activeTool === "rotate") {
      const rotOuter = 28 / zoom;
      // edge handles: normal white squares
      makeHandle(hN.x,  hN.y,  "n");
      makeHandle(hE.x,  hE.y,  "e");
      makeHandle(hS.x,  hS.y,  "s");
      makeHandle(hW.x,  hW.y,  "w");
      // corner handles: blue circles + 90° arc indicators
      const makeArc = (px, py, startDeg, endDeg) => {
        const R = rotOuter;
        const s = startDeg * Math.PI / 180;
        const e = endDeg   * Math.PI / 180;
        const x1 = px + R * Math.cos(s), y1 = py + R * Math.sin(s);
        const x2 = px + R * Math.cos(e), y2 = py + R * Math.sin(e);
        const arc = document.createElementNS(SVG_NS, "path");
        arc.setAttribute("d", `M ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2}`);
        arc.setAttribute("fill", "none");
        arc.setAttribute("stroke", "#0969da");
        arc.setAttribute("stroke-width", 1.5 / zoom);
        arc.setAttribute("pointer-events", "none");
        g.appendChild(arc);
      };
      // base angles per corner (unrotated): arc faces outward from shape
      for (const [label, pt, base] of [
        ["nw", hNW, 180], ["ne", hNE, 270], ["se", hSE, 0], ["sw", hSW, 90]
      ]) {
        const c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("cx", pt.x);
        c.setAttribute("cy", pt.y);
        c.setAttribute("r",  half);
        c.setAttribute("fill", "#0969da");
        c.setAttribute("stroke", "none");
        c.dataset.handle = label;
        c.dataset.id = sel.id;
        g.appendChild(c);
        makeArc(pt.x, pt.y, base + deg, base + deg + 90);
      }
    } else {
      // normal resize mode: all 8 handles as white squares
      makeHandle(hNW.x, hNW.y, "nw");
      makeHandle(hN.x,  hN.y,  "n");
      makeHandle(hNE.x, hNE.y, "ne");
      makeHandle(hE.x,  hE.y,  "e");
      makeHandle(hSE.x, hSE.y, "se");
      makeHandle(hS.x,  hS.y,  "s");
      makeHandle(hSW.x, hSW.y, "sw");
      makeHandle(hW.x,  hW.y,  "w");
    }
  } else if (sel.type === "line") {
    makeHandle(sel.p1.x, sel.p1.y, "p0");
    makeHandle(sel.p2.x, sel.p2.y, "p1");
  } else if (sel.type === "polyline" || sel.type === "curve") {
    sel.points.forEach((p, i) => makeHandle(p.x, p.y, `p${i}`));
  }
  // text: no handles

  scene.appendChild(g);
}
