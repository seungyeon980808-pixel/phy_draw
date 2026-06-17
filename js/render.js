/* ===== RENDER (DESIGN 1-1: SVG is a projection of state.objects) ===== */
//
// render(state) repaints the <g id="scene"> from data. It is registered as a
// store subscriber in main.js, so ANY state.update() repaints automatically —
// no caller ever invokes render() by hand. That is the data-as-truth proof.
//
// Each object carries its own world coordinates (x/y/w/h in viewBox units), so
// the projection stays anchored in world space through zoom/pan (the viewBox
// alone changes what slice of that space is shown).

import { getZoom } from "./viewport.js?v=0.7.0";

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
    const el = renderObject(obj);
    if (el) scene.appendChild(el);
  }

  // ----- selection outline (blue dashed bbox; world space so it tracks zoom/pan) -----
  if (state.selectedId) {
    const sel = state.objects.find((o) => o.id === state.selectedId);
    if (sel && sel.type === "line") {
      // A line has no bbox; its selection guide is a dashed copy of the segment.
      const ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("x1", sel.p1.x);
      ln.setAttribute("y1", sel.p1.y);
      ln.setAttribute("x2", sel.p2.x);
      ln.setAttribute("y2", sel.p2.y);
      ln.setAttribute("stroke-width", "0.4"); // world units
      ln.setAttribute("stroke-dasharray", "1.2 1.2");
      ln.style.stroke = "var(--c-main, #0969da)";
      scene.appendChild(ln);
    } else if (sel && sel.type === "polyline") {
      // A polyline has no fillable bbox; its guide is a dashed copy of the path.
      const pl = document.createElementNS(SVG_NS, "polyline");
      pl.setAttribute("points", sel.points.map((p) => `${p.x},${p.y}`).join(" "));
      pl.setAttribute("fill", "none");
      pl.setAttribute("stroke-width", "0.4"); // world units
      pl.setAttribute("stroke-dasharray", "1.2 1.2");
      pl.style.stroke = "var(--c-main, #0969da)";
      scene.appendChild(pl);
    } else if (sel && sel.type === "curve") {
      // A curve has no fillable bbox; its guide is a dashed copy of the smooth path.
      const cv = document.createElementNS(SVG_NS, "path");
      cv.setAttribute("d", catmullRomPath(sel.points));
      cv.setAttribute("fill", "none");
      cv.setAttribute("stroke-width", "0.4"); // world units
      cv.setAttribute("stroke-dasharray", "1.2 1.2");
      cv.style.stroke = "var(--c-main, #0969da)";
      scene.appendChild(cv);
    } else if (sel && sel.type === "text") {
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
          box.style.stroke = "var(--c-main, #0969da)";
          scene.appendChild(box);
        } catch (_) { /* not laid out yet */ }
      }
    } else if (sel) {
      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("x", sel.x);
      box.setAttribute("y", sel.y);
      box.setAttribute("width", sel.w);
      box.setAttribute("height", sel.h);
      box.setAttribute("fill", "none");
      box.setAttribute("stroke-width", "0.4"); // world units
      box.setAttribute("stroke-dasharray", "1.2 1.2");
      box.style.stroke = "var(--c-main, #0969da)";
      if (sel.rotation) {
        const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2;
        box.setAttribute("transform", `rotate(${sel.rotation} ${cx} ${cy})`);
      }
      scene.appendChild(box);
    }
  }

  // ----- selection handles (DESIGN 5-2: fixed 7 CSS px = 7/zoom world units) -----
  if (state.selectedId) {
    const handleSel = state.objects.find((o) => o.id === state.selectedId);
    if (handleSel) renderHandles(handleSel, scene, getZoom(), state.activeTool);
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

/* ----- line: endpoint-based shape (DESIGN 2-1 branch B); p1→p2, no fill ----- */
function renderLine(obj) {
  const el = document.createElementNS(SVG_NS, "line");
  el.setAttribute("x1", obj.p1.x);
  el.setAttribute("y1", obj.p1.y);
  el.setAttribute("x2", obj.p2.x);
  el.setAttribute("y2", obj.p2.y);
  // strokeLevel 0 = black (DESIGN 2-2). stroke-width is in world units.
  el.setAttribute("stroke", grayHex(obj.strokeLevel));
  el.setAttribute("stroke-width", obj.strokeWidth);
  if (obj.id) el.dataset.id = obj.id;
  return el;
}

/* ----- polyline: many connected points, black stroke, no fill (click-to-click) ----- */
function renderPolyline(obj) {
  const el = document.createElementNS(SVG_NS, "polyline");
  el.setAttribute("points", obj.points.map((p) => `${p.x},${p.y}`).join(" "));
  el.setAttribute("fill", "none");
  // strokeLevel 0 = black (DESIGN 2-2). stroke-width is in world units.
  el.setAttribute("stroke", grayHex(obj.strokeLevel));
  el.setAttribute("stroke-width", obj.strokeWidth);
  if (obj.id) el.dataset.id = obj.id;
  return el;
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
      // edge handles: normal white squares
      makeHandle(hN.x,  hN.y,  "n");
      makeHandle(hE.x,  hE.y,  "e");
      makeHandle(hS.x,  hS.y,  "s");
      makeHandle(hW.x,  hW.y,  "w");
      // corner handles: blue circles indicating rotation mode
      for (const [label, pt] of [["nw", hNW], ["ne", hNE], ["se", hSE], ["sw", hSW]]) {
        const c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("cx", pt.x);
        c.setAttribute("cy", pt.y);
        c.setAttribute("r",  half);
        c.setAttribute("fill", "#0969da");
        c.setAttribute("stroke", "none");
        c.dataset.handle = label;
        c.dataset.id = sel.id;
        g.appendChild(c);
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
