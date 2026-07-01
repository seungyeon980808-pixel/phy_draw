/* ===== RENDER (DESIGN 1-1: SVG is a projection of state.objects) ===== */
//
// render(state) repaints the <g id="scene"> from data. It is registered as a
// store subscriber in main.js, so ANY state.update() repaints automatically ??// no caller ever invokes render() by hand. That is the data-as-truth proof.
//
// Each object carries its own world coordinates (x/y/w/h in viewBox units), so
// the projection stays anchored in world space through zoom/pan (the viewBox
// alone changes what slice of that space is shown).

import { getZoom, getRenderScale } from "./viewport.js?v=0.36.5";
import {
  DEFAULT_TEXT_FONT,
  DEFAULT_TEXT_SIZE_MM,
  CIRCUIT_BODY_MM,
  TOOL_LABEL_FONT_FAMILY,
  EQUATION_LETTER_SPACING,
  VARIABLE_LABEL_FONT_STYLE,
  CALLOUT_LABEL_FONT_STYLE,
  OBJECT_LABEL_TYPES,
  OBJECT_LABEL_QUANTITY_FONT_FAMILY,
  OBJECT_LABEL_TEXT_FONT_FAMILY,
  ROMAN_NUMERAL_FONT_FAMILY,
  splitRomanRuns,
  resolveTextFontStyle,
  resolveTextLetterSpacing,
  normalizeTextRuns,
} from "./state.js?v=0.36.5";
import { resolveObjectStyle } from "./style-mode.js?v=0.36.5";
import { renderFormula } from "./formula.js?v=0.36.5";

const SVG_NS = "http://www.w3.org/2000/svg";

/* ===== SNAP PREVIEW STATE: transient render data, never persisted ===== */
let snapPreview = null;

export function setSnapPreview(preview) {
  const validPoint = (point) => point
    && Number.isFinite(point.x) && Number.isFinite(point.y);
  snapPreview = preview && validPoint(preview.from) && validPoint(preview.to)
    ? preview
    : null;
}

/* rotation-zone cursor: clockwise circular arrow (20횞20, 24횞24 viewBox) */
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

  // ----- per-object fill patterns: regenerated every render into a fresh <defs> -----
  // (matches the wipe-and-rebuild model ??each object's pattern carries its own
  // fillLevel as the mark color, so different levels never collide).
  const defs = document.createElementNS(SVG_NS, "defs");
  scene.appendChild(defs);
  for (const obj of state.objects) {
    const pat = makeFillPattern(obj);
    if (pat) defs.appendChild(pat);
  }

  // ----- artboard: world-space rect from state.artboard (single source of truth),
  // centered on origin, non-interactive, always first. 1 world unit = 1 mm. -----
  const { w: _abW, h: _abH } = state.artboard;
  const artboard = document.createElementNS(SVG_NS, "rect");
  artboard.setAttribute("x", -_abW / 2);
  artboard.setAttribute("y", -_abH / 2);
  artboard.setAttribute("width", _abW);
  artboard.setAttribute("height", _abH);
  artboard.setAttribute("fill", "#ffffff");
  artboard.setAttribute("stroke", "#d0d7de");
  artboard.setAttribute("stroke-width", "1");
  artboard.setAttribute("vector-effect", "non-scaling-stroke");
  artboard.setAttribute("pointer-events", "none");
  scene.appendChild(artboard);

  // ----- grid layer (between artboard and objects; never exported) -----
  if (state.grid && state.grid.visible) {
    scene.appendChild(renderGrid(state));
  }

  // ----- committed objects (z-order = array order, DESIGN 1-1) -----
  const _editingId = state.draftText && state.draftText.editingId;
  for (const obj of state.objects) {
    // The object being re-edited is drawn by the draftText preview instead, so
    // skip its committed render to avoid double text while editing.
    if (_editingId && obj.id === _editingId) continue;
    // A formula being re-edited is replaced by its inline editor overlay; skip
    // its committed render so the old glyphs don't show behind the input.
    if (state.editingFormulaId && obj.id === state.editingFormulaId) continue;
    const _layerId = obj.layerId ?? 1;
    const _layer = (state.layers || []).find(l => l.id === _layerId);
    if (_layer && _layer.visible === false) continue;
    const el = renderObject(obj);
    if (!el) continue;
    const _isActive = _layerId === state.activeLayerId;
    if (!_isActive) el.setAttribute("opacity", "0.5");
    if (!_isActive) el.setAttribute("pointer-events", "none");
    scene.appendChild(el);
    // Open-path hit twin: only on the active layer (other layers stay non-interactive).
    // The twin width is HIT_PX / getZoom(), so a zoom/viewBox change recomputes it via
    // the store subscribe → render path (main.js: state.subscribe(render)).
    if (_isActive) {
      const twin = makeHitTwin(obj);
      if (twin) {
        el.setAttribute("pointer-events", "none"); // only the twin receives events
        scene.appendChild(twin);
      }
    }
  }

  // ----- ruler guides: editing aids only; export builds from objects separately -----
  const vb = state.viewBox;
  for (const guide of state.guides || []) {
    const group = document.createElementNS(SVG_NS, "g");
    group.dataset.guideId = guide.id;

    const setEnds = (line) => {
      if (guide.axis === "x") {
        line.setAttribute("x1", guide.position);
        line.setAttribute("x2", guide.position);
        line.setAttribute("y1", vb.y - vb.h);
        line.setAttribute("y2", vb.y + vb.h * 2);
      } else {
        // Extend past the viewBox so SVG letterboxing cannot leave a visible
        // gap between a horizontal guide and the left ruler.
        line.setAttribute("x1", vb.x - vb.w);
        line.setAttribute("x2", vb.x + vb.w * 2);
        line.setAttribute("y1", guide.position);
        line.setAttribute("y2", guide.position);
      }
    };

    const line = document.createElementNS(SVG_NS, "line");
    setEnds(line);
    line.setAttribute("stroke", state.selectedGuideId === guide.id ? "#0550ae" : "#0969da");
    line.setAttribute("stroke-width", state.selectedGuideId === guide.id ? "1.5" : "1");
    line.setAttribute("stroke-opacity", state.selectedGuideId === guide.id ? "0.9" : "0.65");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    line.setAttribute("pointer-events", "none");
    group.appendChild(line);

    // Only the margins outside the artboard are draggable. The visible line
    // through the drawing area deliberately remains pointer-transparent.
    const addDragZone = (x1, y1, x2, y2) => {
      if (x1 === x2 && y1 === y2) return;
      const hit = document.createElementNS(SVG_NS, "line");
      hit.setAttribute("x1", x1);
      hit.setAttribute("y1", y1);
      hit.setAttribute("x2", x2);
      hit.setAttribute("y2", y2);
      hit.setAttribute("stroke", "transparent");
      hit.setAttribute("stroke-width", "10");
      hit.setAttribute("vector-effect", "non-scaling-stroke");
      hit.dataset.guideId = guide.id;
      hit.style.cursor = guide.axis === "x" ? "col-resize" : "row-resize";
      group.appendChild(hit);
    };
    if (guide.axis === "x") {
      const topEnd = Math.min(-_abH / 2, vb.y + vb.h);
      const bottomStart = Math.max(_abH / 2, vb.y);
      if (topEnd > vb.y) addDragZone(guide.position, vb.y, guide.position, topEnd);
      if (bottomStart < vb.y + vb.h) {
        addDragZone(guide.position, bottomStart, guide.position, vb.y + vb.h);
      }
    } else {
      const leftEnd = Math.min(-_abW / 2, vb.x + vb.w);
      const rightStart = Math.max(_abW / 2, vb.x);
      if (leftEnd > vb.x) addDragZone(vb.x, guide.position, leftEnd, guide.position);
      if (rightStart < vb.x + vb.w) {
        addDragZone(rightStart, guide.position, vb.x + vb.w, guide.position);
      }
    }
    scene.appendChild(group);
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
      _grect.setAttribute("stroke-dasharray", "0.6 0.6");
      _grect.style.stroke = "#2f9e44";
      scene.appendChild(_grect);
    }
  }

  for (const _sid of _selIds) {
    const sel = state.objects.find((o) => o.id === _sid);
    if (!sel) continue;
    const _selLayer = (state.layers || []).find(l => l.id === (sel.layerId ?? 1));
    if (_selLayer && _selLayer.visible === false) continue;
    if (sel.positionLocked) renderPositionLockMarker(sel, scene, getZoom());
    if (_allSameGroup) continue; // combined rect already drawn above
    const _selColor = (state.targetedId === _sid) ? "#e67700"
                    : sel.groupId  ? "#2f9e44"
                    : sel.locked   ? "#e53e3e"
                    : sel.positionLocked ? "#8b5cf6"
                    : "var(--c-main, #0969da)";
    if (sel.type === "line" || sel.type === "circuit") {
      // Line/circuit have no bbox; the selection guide is a dashed copy of the
      // p1–p2 segment (circuit's leads + body sit on this axis).
      const ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("x1", sel.p1.x);
      ln.setAttribute("y1", sel.p1.y);
      ln.setAttribute("x2", sel.p2.x);
      ln.setAttribute("y2", sel.p2.y);
      ln.setAttribute("stroke-width", "0.4"); // world units
      ln.setAttribute("stroke-dasharray", "0.6 0.6");
      ln.style.stroke = _selColor;
      ln.setAttribute("pointer-events", "none"); // decorative; the hit twin owns events
      scene.appendChild(ln);
    } else if (sel.type === "polyline" && sel.closed === true) {
      // Closed polyline takes branch-A (face) treatment: a dashed bbox rect guide,
      // matching rect/ellipse/triangle. Points are world-true so the box is axis-aligned.
      const bb = singleObjBBox(sel, scene);
      if (bb) {
        const box = document.createElementNS(SVG_NS, "rect");
        box.setAttribute("x", bb.x);
        box.setAttribute("y", bb.y);
        box.setAttribute("width", bb.w);
        box.setAttribute("height", bb.h);
        box.setAttribute("fill", "none");
        box.setAttribute("stroke-width", "0.4"); // world units
        box.setAttribute("stroke-dasharray", "0.6 0.6");
        box.style.stroke = _selColor;
        scene.appendChild(box);
      }
    } else if (sel.type === "polyline") {
      // Open polyline: guide is a dashed copy of the path.
      const pl = document.createElementNS(SVG_NS, "polyline");
      pl.setAttribute("points", sel.points.map((p) => `${p.x},${p.y}`).join(" "));
      pl.setAttribute("fill", "none");
      pl.setAttribute("stroke-width", "0.4"); // world units
      pl.setAttribute("stroke-dasharray", "0.6 0.6");
      pl.style.stroke = _selColor;
      pl.setAttribute("pointer-events", "none"); // decorative; the hit twin owns events
      scene.appendChild(pl);
    } else if (sel.type === "curve" && sel.closed === true) {
      // Closed curve: bbox rect guide (same as closed polyline).
      const bb = singleObjBBox(sel, scene);
      if (bb) {
        const box = document.createElementNS(SVG_NS, "rect");
        box.setAttribute("x", bb.x);
        box.setAttribute("y", bb.y);
        box.setAttribute("width", bb.w);
        box.setAttribute("height", bb.h);
        box.setAttribute("fill", "none");
        box.setAttribute("stroke-width", "0.4");
        box.setAttribute("stroke-dasharray", "0.6 0.6");
        box.style.stroke = _selColor;
        scene.appendChild(box);
      }
    } else if (sel.type === "curve") {
      // Open curve: dashed copy of the smooth path.
      const cv = document.createElementNS(SVG_NS, "path");
      cv.setAttribute("d", catmullRomPath(sel.points));
      cv.setAttribute("fill", "none");
      cv.setAttribute("stroke-width", "0.4"); // world units
      cv.setAttribute("stroke-dasharray", "0.6 0.6");
      cv.style.stroke = _selColor;
      cv.setAttribute("pointer-events", "none"); // decorative; the hit twin owns events
      scene.appendChild(cv);
    } else if (sel.type === "text" || sel.type === "formula") {
      // getBBox() on the already-rendered element gives the exact visual bounds.
      // (formula's <g> includes a transparent body rect spanning its whole box.)
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
          box.setAttribute("stroke-dasharray", "0.6 0.6");
          box.style.stroke = _selColor;
          scene.appendChild(box);
        } catch (_) { /* not laid out yet */ }
      }
    } else if (sel.type === "anglearc") {
      // EDIT-TIME GUIDE: the arc's TWO bounding radii (vertex → each arc end),
      // drawn as dashed lines in the SAME visual family as the selection box.
      // Projection only — lives in this overlay (never in renderObject), so it
      // shows only while selected and is excluded from SVG/PNG export like handles.
      const r = sel.radius || 0;
      const a0 = (sel.startAngle || 0) * Math.PI / 180;
      const a1 = ((sel.startAngle || 0) + (sel.sweepAngle ?? 0)) * Math.PI / 180;
      for (const rad of [a0, a1]) {
        const ray = document.createElementNS(SVG_NS, "line");
        ray.setAttribute("x1", sel.x);
        ray.setAttribute("y1", sel.y);
        ray.setAttribute("x2", sel.x + r * Math.cos(rad));
        ray.setAttribute("y2", sel.y - r * Math.sin(rad)); // +Y up → SVG y down
        ray.setAttribute("fill", "none");
        ray.setAttribute("stroke-width", "0.4"); // world units, matches the box
        ray.setAttribute("stroke-dasharray", "0.6 0.6");
        ray.style.stroke = _selColor;
        ray.setAttribute("pointer-events", "none");
        scene.appendChild(ray);
      }
      // Dashed bbox guide (vertex-centered square of radius r), matching the
      // branch-A selection boxes so the arc reads as a normal selected object.
      const _bb = singleObjBBox(sel, scene);
      if (_bb) {
        const box = document.createElementNS(SVG_NS, "rect");
        box.setAttribute("x", _bb.x);
        box.setAttribute("y", _bb.y);
        box.setAttribute("width", _bb.w);
        box.setAttribute("height", _bb.h);
        box.setAttribute("fill", "none");
        box.setAttribute("stroke-width", "0.4");
        box.setAttribute("stroke-dasharray", "0.6 0.6");
        box.style.stroke = _selColor;
        scene.appendChild(box);
      }
    } else {
      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("x", sel.x);
      box.setAttribute("y", sel.y);
      box.setAttribute("width", sel.w);
      box.setAttribute("height", sel.h);
      box.setAttribute("fill", "none");
      box.setAttribute("stroke-width", "0.4"); // world units
      box.setAttribute("stroke-dasharray", "0.6 0.6");
      box.style.stroke = _selColor;
      if (sel.rotation) {
        const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2;
        box.setAttribute("transform", `rotate(${sel.rotation} ${cx} ${cy})`);
      }
      scene.appendChild(box);
    }
  }

  // ----- selection handles (DESIGN 5-2: fixed 10 CSS px = 10/zoom world units) -----
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
    } else {
      // Plain multi-selection (no shared groupId): still draw the 8 handles on the
      // combined bbox so an ad-hoc selection scales/rotates as a unit.
      const _box = combinedGroupBBox(_members, scene);
      if (_box) {
        renderHandles(
          { type: "rect", id: "__group__", x: _box.x, y: _box.y, w: _box.w, h: _box.h, rotation: 0 },
          scene, getZoom(), state.activeTool
        );
      }
    }
  }

  /* ===== SNAP PREVIEW OVERLAY HOOK: same transient layer as selection handles ===== */
  renderSnapPreview(scene, getZoom());

  // ----- live drag preview (ephemeral; not in state.objects yet) -----
  if (state.draft) {
    const d = state.draft;

    // For size-based shapes (ellipse/triangle) the bbox differs from the shape
    // outline, so draw a dashed rectangle guide spanning the drag bounds first.
    // (rect's own preview already IS that rectangle; the line has no bbox ??it
    // shows its own solid preview below ??so both skip the duplicate guide.)
    if (d.type !== "rect" && d.type !== "line" && d.type !== "polyline" && d.type !== "curve" && d.type !== "anglearc" && d.type !== "rightangle" && d.type !== "circuit" && d.type !== "labeler") {
      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("x", d.x);
      box.setAttribute("y", d.y);
      box.setAttribute("width", d.w);
      box.setAttribute("height", d.h);
      box.setAttribute("fill", "none");
      box.style.stroke = "var(--c-main, #0969da)";
      box.setAttribute("stroke-width", d.strokeWidth);
      box.setAttribute("stroke-dasharray", "0.6 0.6"); // world-unit dashes
      scene.appendChild(box);
    }

    // anglearc preview: a blue dashed rubber-band radius from the vertex to the
    // start point, showing the vertex + radius while the arc (below) previews the
    // sweep. Projection only — the committed arc carries no radius line.
    if (d.type === "anglearc") {
      const rad = (d.startAngle || 0) * Math.PI / 180;
      const ex = d.x + (d.radius || 0) * Math.cos(rad);
      const ey = d.y - (d.radius || 0) * Math.sin(rad); // +Y up → SVG y down
      const guide = document.createElementNS(SVG_NS, "line");
      guide.setAttribute("x1", d.x);
      guide.setAttribute("y1", d.y);
      guide.setAttribute("x2", ex);
      guide.setAttribute("y2", ey);
      guide.setAttribute("fill", "none");
      guide.style.stroke = "var(--c-main, #0969da)";
      guide.setAttribute("stroke-width", "0.3");
      guide.setAttribute("stroke-dasharray", "0.6 0.6");
      guide.setAttribute("pointer-events", "none");
      scene.appendChild(guide);
    }

    // The actual shape outline that will be committed, drawn inside the guide.
    // Render it SOLID exactly as the real shape will look (black stroke, same
    // stroke-width from renderObject) ??no dashing ??so the preview matches.
    const el = renderObject(d);
    if (el) {
      scene.appendChild(el);
    }
  }

  // Optional non-native preview. Normal editing uses the textarea overlay so
  // its visible glyphs and native caret share one browser text layout.
  if (state.draftText && !state.draftText.nativeEditor && (state.draftText.text || "").length) {
    const dt = state.draftText;
    const tEl = renderText(dt);
    tEl.dataset.ui = "draft-text";
    scene.appendChild(tEl);
    try {
      const bb = tEl.getBBox();
      const pad = 3 / getRenderScale(); // ~3 screen px of padding, zoom-stable
      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("x", bb.x - pad);
      box.setAttribute("y", bb.y - pad);
      box.setAttribute("width", bb.width + pad * 2);
      box.setAttribute("height", bb.height + pad * 2);
      box.setAttribute("fill", "none");
      box.setAttribute("stroke-width", "0.4");
      box.setAttribute("stroke-dasharray", "0.6 0.6");
      box.style.stroke = "var(--c-main, #0969da)";
      box.setAttribute("pointer-events", "none");
      box.dataset.ui = "draft-text-outline";
      scene.appendChild(box);
    } catch (_) { /* not laid out yet */ }
  }
}

function renderPositionLockMarker(obj, scene, zoom) {
  const box = singleObjBBox(obj, scene);
  if (!box) return;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const arm = 6 / zoom;
  const gap = 2 / zoom;
  const sw = 1.5 / zoom;
  const marker = document.createElementNS(SVG_NS, "g");
  marker.setAttribute("data-ui", "position-lock-anchor");
  marker.setAttribute("pointer-events", "none");
  for (const [x1, y1, x2, y2] of [
    [cx - arm, cy, cx - gap, cy], [cx + gap, cy, cx + arm, cy],
    [cx, cy - arm, cx, cy - gap], [cx, cy + gap, cx, cy + arm],
  ]) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.setAttribute("stroke", "#8b5cf6");
    line.setAttribute("stroke-width", sw);
    line.setAttribute("stroke-linecap", "round");
    marker.appendChild(line);
  }
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
  dot.setAttribute("r", 1.5 / zoom);
  dot.setAttribute("fill", "#8b5cf6");
  marker.appendChild(dot);
  scene.appendChild(marker);
}

/* ===== GRID LAYER (reference grid drawn on artboard; never in exports) ===== */
function renderGrid(state) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("id", "grid-layer");
  g.setAttribute("pointer-events", "none");

  const { w: abW, h: abH } = state.artboard;
  const left   = -abW / 2;
  const right  =  abW / 2;
  const top    = -abH / 2;
  const bottom =  abH / 2;

  // 1-10 → 0.1-1.0, applied directly to stroke color so lines are fully black at max
  const opacity = state.grid.opacity / 10;
  const majorStroke = `rgba(0,0,0,${opacity.toFixed(2)})`;
  const minorStroke = `rgba(0,0,0,${(opacity * 0.5).toFixed(2)})`;

  const STEP  = state.grid.interval ?? 10;
  const MAJOR = STEP * 5;

  // Vertical lines (x = constant)
  const xMin = Math.ceil(left  / STEP) * STEP;
  const xMax = Math.floor(right / STEP) * STEP;
  for (let x = xMin; x <= xMax; x += STEP) {
    const isMajor = x % MAJOR === 0;
    const ln = document.createElementNS(SVG_NS, "line");
    ln.setAttribute("x1", x);  ln.setAttribute("y1", top);
    ln.setAttribute("x2", x);  ln.setAttribute("y2", bottom);
    ln.setAttribute("stroke", isMajor ? majorStroke : minorStroke);
    ln.setAttribute("stroke-width", isMajor ? 0.3 : 0.2);
    ln.setAttribute("vector-effect", "non-scaling-stroke");
    g.appendChild(ln);
    if (isMajor) {
      const lbl = document.createElementNS(SVG_NS, "text");
      lbl.setAttribute("x", x);
      lbl.setAttribute("y", bottom + 1.5);
      lbl.setAttribute("font-size", "1.8");
      lbl.setAttribute("fill", majorStroke);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("dominant-baseline", "hanging");
      lbl.setAttribute("font-family", "IBM Plex Mono, monospace");
      lbl.textContent = String(x);
      g.appendChild(lbl);
    }
  }

  // Horizontal lines (y = constant)
  const yMin = Math.ceil(top    / STEP) * STEP;
  const yMax = Math.floor(bottom / STEP) * STEP;
  for (let y = yMin; y <= yMax; y += STEP) {
    const isMajor = y % MAJOR === 0;
    const ln = document.createElementNS(SVG_NS, "line");
    ln.setAttribute("x1", left);  ln.setAttribute("y1", y);
    ln.setAttribute("x2", right); ln.setAttribute("y2", y);
    ln.setAttribute("stroke", isMajor ? majorStroke : minorStroke);
    ln.setAttribute("stroke-width", isMajor ? 0.3 : 0.2);
    ln.setAttribute("vector-effect", "non-scaling-stroke");
    g.appendChild(ln);
    if (isMajor) {
      const lbl = document.createElementNS(SVG_NS, "text");
      lbl.setAttribute("x", left - 1);
      lbl.setAttribute("y", y);
      lbl.setAttribute("font-size", "1.8");
      lbl.setAttribute("fill", majorStroke);
      lbl.setAttribute("text-anchor", "end");
      lbl.setAttribute("dominant-baseline", "middle");
      lbl.setAttribute("font-family", "IBM Plex Mono, monospace");
      lbl.textContent = String(y);
      g.appendChild(lbl);
    }
  }

  return g;
}

/* ===== HIT TWIN (open paths: one fat invisible band unifies hover + grab/click) =====
 * A thin line/polyline/curve is only ~1px of real geometry, so the visible stroke
 * is the lone element that can receive pointer events — making thin open paths
 * almost impossible to grab (transform.js reads e.target's data-id) and giving no
 * hover affordance. Fix: for every OPEN path render a transparent duplicate over
 * the SAME geometry with a fat, zoom-INVARIANT stroke (HIT_PX screen px / getZoom()
 * world units) carrying the SAME data-id. pointer-events="stroke" makes the band
 * hittable despite transparent paint; cursor:pointer drives hover + selection/grab
 * from this ONE element. The visible stroke is set pointer-events="none" so only the
 * twin is interactive. Closed shapes already grab via their (transparent-capable)
 * fill, so they get no twin. Twins exist only in the editor render() — export builds
 * from renderObject(), so they never reach SVG/PNG output or the export viewBox. */
const HIT_PX = 12; // constant on-screen hit width (px), mirroring the handle/zoom pattern

function makeHitTwin(obj) {
  let twin = null;
  if (obj.type === "line") {
    twin = document.createElementNS(SVG_NS, "line");
    twin.setAttribute("x1", obj.p1.x);
    twin.setAttribute("y1", obj.p1.y);
    twin.setAttribute("x2", obj.p2.x);
    twin.setAttribute("y2", obj.p2.y);
  } else if (obj.type === "polyline" && obj.closed !== true) {
    twin = document.createElementNS(SVG_NS, "polyline");
    twin.setAttribute("points", (obj.points || []).map((p) => `${p.x},${p.y}`).join(" "));
  } else if (obj.type === "curve" && obj.closed !== true) {
    twin = document.createElementNS(SVG_NS, "path");
    twin.setAttribute("d", catmullRomPath(obj.points || []));
  } else if (obj.type === "rect" || obj.type === "ellipse" || obj.type === "triangle" ||
             obj.type === "image" || obj.type === "axes" || obj.type === "optics" ||
             obj.type === "apparatus") {
    twin = document.createElementNS(SVG_NS, "rect");
    twin.setAttribute("x", obj.x);
    twin.setAttribute("y", obj.y);
    twin.setAttribute("width", obj.w);
    twin.setAttribute("height", obj.h);
    if (obj.rotation) {
      const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
      twin.setAttribute("transform", `rotate(${obj.rotation} ${cx} ${cy})`);
    }
  } else if (obj.type === "anglearc") {
    const r = obj.radius || 0;
    twin = document.createElementNS(SVG_NS, "rect");
    twin.setAttribute("x", obj.x - r);
    twin.setAttribute("y", obj.y - r);
    twin.setAttribute("width", r * 2);
    twin.setAttribute("height", r * 2);
  } else if (obj.type === "rightangle") {
    const r = (obj.size || 0) * 1.6;
    twin = document.createElementNS(SVG_NS, "rect");
    twin.setAttribute("x", obj.x - r);
    twin.setAttribute("y", obj.y - r);
    twin.setAttribute("width", r * 2);
    twin.setAttribute("height", r * 2);
  } else if (obj.type === "labeler") {
    // Hover band along the leader (p1→p2); the label glyph grabs via its own fill.
    const a = obj.p1 || { x: 0, y: 0 }, b = obj.p2 || a;
    twin = document.createElementNS(SVG_NS, "line");
    twin.setAttribute("x1", a.x);
    twin.setAttribute("y1", a.y);
    twin.setAttribute("x2", b.x);
    twin.setAttribute("y2", b.y);
  } else {
    return null; // not an open path → no twin (closed shapes grab via fill)
  }
  const isRectTwin = twin.tagName.toLowerCase() === "rect";
  twin.setAttribute("fill", isRectTwin ? "transparent" : "none");
  twin.setAttribute("stroke", "transparent");
  twin.setAttribute("stroke-width", HIT_PX / getZoom()); // zoom-invariant screen px
  twin.setAttribute("stroke-linecap", "round");
  twin.setAttribute("stroke-linejoin", "round");
  twin.setAttribute("pointer-events", isRectTwin ? "all" : "stroke");
  if (obj.id) twin.dataset.id = obj.id;
  twin.dataset.ui = "hit-twin";
  return twin;
}

/* ----- per-object dispatch (one branch per shape type) ----- */
// Exported so SVG export reuses the exact same per-object node builders
// (no duplicated shape-drawing code; DESIGN 1-1 projection stays single-source).
export function renderObject(obj) {
  obj = resolveObjectStyle(obj);
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
    case "formula":
      return renderFormula(obj);
    case "image":
      return renderImage(obj);
    case "axes":
      return renderAxes(obj);
    case "anglearc":
      return renderAngleArc(obj);
    case "rightangle":
      return renderRightAngle(obj);
    case "labeler":
      return renderLabeler(obj);
    case "circuit":
      return renderCircuit(obj);
    case "optics":
      return renderOptics(obj);
    case "apparatus":
      return renderApparatus(obj);
    default:
      return null;
  }
}

/* ===== SHARED UPRIGHT LABEL (Group 3) =====
 * A custom text label that always renders horizontally (screen-upright),
 * EXCLUDED from the object's rotation (the caller appends it as a sibling of the
 * rotated shape, never inside the rotation group), in the default font, and IS
 * included in export (it lives in renderObject's output). Returns an SVG <text>
 * node, or null when there's no label text. */
// Physics variable labels use the Chrome-resolved HWP equation font family.
function makeUprightLabel(text, x, y, color, sizeMm = DEFAULT_TEXT_SIZE_MM, options = {}) {
  const s = String(text ?? "");
  if (!s) return null;
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", x);
  t.setAttribute("y", y);
  t.setAttribute("font-size", sizeMm);
  // An explicit fontFamily (e.g. the labeler's Dotum-first normal text) overrides
  // the labelType-based 물리량/라벨 font policy; otherwise fall back to it.
  if (options.fontFamily) {
    applySvgTextFont(t, { family: options.fontFamily, style: options.fontStyle || "normal", letterSpacing: "normal" });
  } else {
    applyObjectLabelFont(t, options.labelType, options.labelKind === "callout" || options.italic === false ? "label" : "quantity");
  }
  t.setAttribute("fill", color);
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("dominant-baseline", "central");
  // White halo so the label stays readable over strokes/fills (mirrors the
  // line length-display label).
  t.setAttribute("paint-order", "stroke");
  t.setAttribute("stroke", "white");
  t.setAttribute("stroke-width", sizeMm * 0.16);
  t.setAttribute("stroke-linejoin", "round");
  const lines = s.split("\n");
  if (lines.length === 1) {
    fillTextWithRomanRuns(t, lines[0]);
  } else {
    const lineHeight = sizeMm * 1.2;
    lines.forEach((line, i) => {
      const ts = document.createElementNS(SVG_NS, "tspan");
      ts.setAttribute("x", x);
      ts.setAttribute("dy", i === 0 ? -lineHeight * (lines.length - 1) / 2 : lineHeight);
      fillTextWithRomanRuns(ts, line || "\u00a0");
      t.appendChild(ts);
    });
  }
  return t;
}

/* Attach a box-shape's (rect/ellipse) upright label, if any. The anchor is
 * computed in the UNROTATED bbox frame so the text stays horizontal regardless
 * of obj.rotation. labelPos: "center" | "above" | "below" | "left" | "right"
 * (default center).
 * When a label exists the shape is wrapped in a <g> that carries the data-id;
 * with no label the bare shape element is returned unchanged. */
function withBoxLabel(shapeEl, obj) {
  const pos = obj.labelPos || "center";
  const size = obj.labelSize || DEFAULT_TEXT_SIZE_MM;
  const gap = size * 0.85;
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  // Anchor in the object's LOCAL (unrotated) frame, measured from the center.
  // center -> (0,0); the four "outside" spots sit one `gap` beyond each edge.
  let lx = 0, ly = 0;
  if (pos === "above")      ly = -(obj.h / 2 + gap);
  else if (pos === "below") ly =  (obj.h / 2 + gap);
  else if (pos === "left")  lx = -(obj.w / 2 + gap);
  else if (pos === "right") lx =  (obj.w / 2 + gap);
  // Rotate that local anchor by obj.rotation around the center (via the shared
  // rotPt helper) so it stays pinned to the same relative spot as the shape
  // turns. The text node itself is appended OUTSIDE the rotation group, so the
  // glyph stays upright.
  const anchor = rotPt(cx + lx, cy + ly, cx, cy, obj.rotation || 0);
  // Rectangle internal labels (A, B, C …) are object NAMES, not physics variables:
  // force the 라벨(신명중명조 정체) policy so every rectangle label shares one regular,
  // upright style and NEVER inherits the 물리량 italic. `italic:false` also pins the
  // font-style fallback to normal. Ellipse keeps its per-object labelType choice.
  const labelOpts = obj.type === "rect"
    ? { labelType: "label", italic: false }
    : { labelType: obj.labelType };
  const lbl = makeUprightLabel(obj.label, anchor.x, anchor.y, grayHex(obj.strokeLevel), size, labelOpts);
  if (!lbl) return shapeEl;
  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) { g.dataset.id = obj.id; delete shapeEl.dataset.id; }
  g.appendChild(shapeEl);
  g.appendChild(lbl);
  return g;
}

/* ----- rect: size-based shape (DESIGN 2-1 branch A) ----- */
function renderRect(obj) {
  const r = document.createElementNS(SVG_NS, "rect");
  r.setAttribute("x", obj.x);
  r.setAttribute("y", obj.y);
  r.setAttribute("width", obj.w);
  r.setAttribute("height", obj.h);

  // Fill: transparent (none) / solid gray / pattern url ??still clicks (DESIGN 5-3).
  r.setAttribute("fill", resolveFill(obj));
  // strokeLevel 0 = black (DESIGN 2-2). stroke-width is in world units.
  r.setAttribute("stroke", grayHex(obj.strokeLevel));
  r.setAttribute("stroke-width", obj.strokeWidth);
  applyDash(r, obj);

  if (obj.rotation) {
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    r.setAttribute("transform", `rotate(${obj.rotation} ${cx} ${cy})`);
  }
  if (obj.id) r.dataset.id = obj.id;
  return withBoxLabel(r, obj);
}

/* ----- ellipse: size-based shape; bbox (x/y/w/h) ??cx/cy + rx/ry ----- */
function renderEllipse(obj) {
  const el = document.createElementNS(SVG_NS, "ellipse");
  el.setAttribute("cx", obj.x + obj.w / 2);
  el.setAttribute("cy", obj.y + obj.h / 2);
  el.setAttribute("rx", obj.w / 2);
  el.setAttribute("ry", obj.h / 2);

  // Fill: transparent (none) / solid gray / pattern url ??still clicks (DESIGN 5-3).
  el.setAttribute("fill", resolveFill(obj));
  el.setAttribute("stroke", grayHex(obj.strokeLevel));
  el.setAttribute("stroke-width", obj.strokeWidth);
  applyDash(el, obj);

  if (obj.rotation) {
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    el.setAttribute("transform", `rotate(${obj.rotation} ${cx} ${cy})`);
  }
  if (obj.id) el.dataset.id = obj.id;
  return withBoxLabel(el, obj);
}

/* ----- triangle: right-angle corner determined by flipX 횞 flipY ----- */
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

  // Fill: transparent (none) / solid gray / pattern url ??still clicks (DESIGN 5-3).
  el.setAttribute("fill", resolveFill(obj));
  el.setAttribute("stroke", grayHex(obj.strokeLevel));
  el.setAttribute("stroke-width", obj.strokeWidth);
  applyDash(el, obj);

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
// Solid = dashLength 0 (or gap 0) ??no dasharray attribute set at all (DESIGN: presets).
function applyDash(el, obj) {
  const dl = obj.dashLength ?? 0;
  const dg = obj.dashGap ?? 0;
  if (dl > 0 && dg > 0) el.setAttribute("stroke-dasharray", `${dl} ${dg}`);
}

function applySvgTextFont(t, { family, style = "normal", weight = null, letterSpacing = null }) {
  t.setAttribute("font-family", family || DEFAULT_TEXT_FONT);
  t.setAttribute("font-style", style || "normal");
  if (weight) t.setAttribute("font-weight", weight);
  if (letterSpacing != null) t.setAttribute("letter-spacing", letterSpacing);
  else t.removeAttribute("letter-spacing");
}

/* ----- roman-numeral serif runs -----
 * Fill a <text>/<tspan> with `str`, wrapping ASCII I/II/III roman-numeral runs
 * in a child <tspan> forced to the Latin serif stack, upright
 * (font-style normal). Non-roman runs stay in the parent's font. This is the single
 * place canvas + SVG + PNG export all flow through (export reuses renderObject),
 * so serifed roman numerals stay identical across every surface. */
function fillTextWithRomanRuns(parent, str) {
  const s = String(str ?? "");
  const runs = splitRomanRuns(s);
  // Fast path: no roman numerals → plain text node (unchanged behavior).
  if (!runs.some((r) => r.roman)) {
    parent.textContent = s;
    return;
  }
  for (const run of runs) {
    if (run.roman) {
      const ts = document.createElementNS(SVG_NS, "tspan");
      ts.setAttribute("class", "roman-numeral-run");
      ts.setAttribute("font-family", ROMAN_NUMERAL_FONT_FAMILY);
      ts.setAttribute("font-style", "normal");   // Myeongjo serif is upright, never italic
      ts.setAttribute("font-weight", "normal");
      ts.setAttribute("letter-spacing", "normal"); // don't inherit equation tracking
      ts.textContent = run.text;
      parent.appendChild(ts);
    } else {
      parent.appendChild(document.createTextNode(run.text));
    }
  }
}

function applySvgTextRunStyle(t, style = {}) {
  applySvgTextFont(t, {
    family: style.fontFamily || DEFAULT_TEXT_FONT,
    style: style.italic === true ? "italic" : "normal",
    weight: style.fontWeight || "normal",
    letterSpacing: resolveTextLetterSpacing(style),
  });
  const deco = [];
  if (style.underline) deco.push("underline");
  if (style.strikeout) deco.push("line-through");
  if (deco.length) t.setAttribute("text-decoration", deco.join(" "));
  else t.removeAttribute("text-decoration");
}

function textRunLines(runs) {
  const lines = [[]];
  for (const run of runs) {
    const parts = String(run.text ?? "").split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, style: run.style || {} });
    });
  }
  return lines;
}

function appendStyledTextRuns(parent, obj) {
  const runs = normalizeTextRuns(obj);
  const lines = textRunLines(runs);
  lines.forEach((line, i) => {
    const lineSpan = document.createElementNS(SVG_NS, "tspan");
    lineSpan.setAttribute("x", obj.x);
    lineSpan.setAttribute("dy", i === 0 ? "0" : obj.fontSize * 1.4);
    if (!line.length) {
      lineSpan.textContent = "\u00a0";
    } else {
      line.forEach((run) => {
        const span = document.createElementNS(SVG_NS, "tspan");
        applySvgTextRunStyle(span, run.style);
        span.textContent = run.text;
        lineSpan.appendChild(span);
      });
    }
    parent.appendChild(lineSpan);
  });
}

function resolveLabelType(labelType, fallback = "quantity") {
  return OBJECT_LABEL_TYPES.includes(labelType) ? labelType : fallback;
}

function applyObjectLabelFont(t, labelType, fallback = "quantity") {
  const resolved = resolveLabelType(labelType, fallback);
  if (resolved === "label") {
    applySvgTextFont(t, {
      family: OBJECT_LABEL_TEXT_FONT_FAMILY,
      style: "normal",
      letterSpacing: "normal",
    });
    return;
  }
  applySvgTextFont(t, {
    family: OBJECT_LABEL_QUANTITY_FONT_FAMILY,
    style: VARIABLE_LABEL_FONT_STYLE,
    letterSpacing: "normal",
  });
}

function applyVariableLabelFont(t) {
  applyObjectLabelFont(t, "quantity");
}

function applyCalloutLabelFont(t) {
  applyObjectLabelFont(t, "label", "label");
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

/* ----- line: endpoint-based shape (DESIGN 2-1 branch B); p1?뭦2, no fill ----- */
function renderLine(obj) {
  const savedArrowHead = obj.arrowHead ?? "none";
  // Files created before lineStyle used arrowHead="center" for midpoint arrows.
  let lineStyle = obj.lineMode ?? obj.lineStyle
    ?? (savedArrowHead === "center" ? "middleArrow" : savedArrowHead === "none" ? "solid" : "arrow");
  if (lineStyle === "dimensionArrow") lineStyle = "lengthArrow";
  if (!["solid", "arrow", "middleArrow", "midInward", "lengthArrow"].includes(lineStyle)) lineStyle = "solid";
  const arrowHead = lineStyle === "arrow"
    ? ({ right: "end", left: "start", both: "both" }[obj.arrowVariant] || savedArrowHead)
    : "none";
  const sw = obj.strokeWidth ?? 0.2;
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
    } else if (arrowHead === "start") {
      lx1 += nx * arrowLen; ly1 += ny * arrowLen;
    } else if (arrowHead === "both") {
      lx2 -= nx * arrowLen; ly2 -= ny * arrowLen;
      lx1 += nx * arrowLen; ly1 += ny * arrowLen;
    } else if (lineStyle === "lengthArrow") {
      lx2 -= nx * arrowLen; ly2 -= ny * arrowLen;
      lx1 += nx * arrowLen; ly1 += ny * arrowLen;
    }
    // "center" and "none": no adjustment
  }

  // One <line> segment; strokeLevel 0 = black (DESIGN 2-2), stroke-width in world units.
  const mkSeg = (x1, y1, x2, y2, dashed) => {
    const seg = document.createElementNS(SVG_NS, "line");
    seg.setAttribute("x1", x1);
    seg.setAttribute("y1", y1);
    seg.setAttribute("x2", x2);
    seg.setAttribute("y2", y2);
    seg.setAttribute("stroke", color);
    seg.setAttribute("stroke-width", sw);
    if (dashed) applyDash(seg, obj);
    return seg;
  };

  // "부분 점선": solid for dashRatio of the drawn span (from p1, or p2 when dashFlip),
  // dashed for the rest. Only straight lines; needs a dash length to show the dashes.
  const usePartial = obj.partialDash === true && L > 0 && (obj.dashLength ?? 0) > 0;
  let bodyEls;
  if (usePartial) {
    const segLen = Math.hypot(lx2 - lx1, ly2 - ly1);
    const ux = segLen ? (lx2 - lx1) / segLen : 0;
    const uy = segLen ? (ly2 - ly1) / segLen : 0;
    const ratio = Math.max(0, Math.min(1, obj.dashRatio ?? 0.5));
    const solidLen = ratio * segLen;
    if (!obj.dashFlip) {
      const sx = lx1 + ux * solidLen, sy = ly1 + uy * solidLen;
      bodyEls = [mkSeg(lx1, ly1, sx, sy, false), mkSeg(sx, sy, lx2, ly2, true)];
    } else {
      const sx = lx2 - ux * solidLen, sy = ly2 - uy * solidLen;
      bodyEls = [mkSeg(sx, sy, lx2, ly2, false), mkSeg(lx1, ly1, sx, sy, true)];
    }
  } else {
    bodyEls = [mkSeg(lx1, ly1, lx2, ly2, true)];
  }

  if (lineStyle === "solid" || L === 0) {
    if (bodyEls.length === 1) {
      if (obj.id) bodyEls[0].dataset.id = obj.id;
      return withLineLabel(bodyEls[0], obj);
    }
    const gSolid = document.createElementNS(SVG_NS, "g");
    if (obj.id) gSolid.dataset.id = obj.id;
    bodyEls.forEach((b) => gSolid.appendChild(b));
    return withLineLabel(gSolid, obj);
  }

  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;
  bodyEls.forEach((b) => g.appendChild(b));

  if (arrowHead === "end") {
    g.appendChild(makeArrowHead(obj.p2.x, obj.p2.y, nx, ny, sw, color));
  } else if (arrowHead === "start") {
    g.appendChild(makeArrowHead(obj.p1.x, obj.p1.y, -nx, -ny, sw, color));
  } else if (arrowHead === "both") {
    g.appendChild(makeArrowHead(obj.p2.x, obj.p2.y, nx, ny, sw, color));
    g.appendChild(makeArrowHead(obj.p1.x, obj.p1.y, -nx, -ny, sw, color));
  } else if (lineStyle === "middleArrow") {
    const mx = (obj.p1.x + obj.p2.x) / 2;
    const my = (obj.p1.y + obj.p2.y) / 2;
    const direction = obj.arrowVariant === "left" ? -1 : 1;
    g.appendChild(makeArrowHead(mx, my, nx * direction, ny * direction, sw, color));
  } else if (lineStyle === "midInward") {
    // Two arrowheads at ~1/3 and ~2/3 of the span, BOTH pointing INWARD toward
    // the midpoint (→ on the left half, ← on the right half) — bidirectional
    // tension/compression. n = p1→p2 unit; left head aims +n, right head −n.
    const p13 = { x: obj.p1.x + (obj.p2.x - obj.p1.x) / 3, y: obj.p1.y + (obj.p2.y - obj.p1.y) / 3 };
    const p23 = { x: obj.p1.x + (obj.p2.x - obj.p1.x) * 2 / 3, y: obj.p1.y + (obj.p2.y - obj.p1.y) * 2 / 3 };
    g.appendChild(makeArrowHead(p13.x, p13.y, nx, ny, sw, color));
    g.appendChild(makeArrowHead(p23.x, p23.y, -nx, -ny, sw, color));
  } else if (lineStyle === "lengthArrow") {
    g.appendChild(makeArrowHead(obj.p2.x, obj.p2.y, nx, ny, sw, color));
    g.appendChild(makeArrowHead(obj.p1.x, obj.p1.y, -nx, -ny, sw, color));

    const dimensionVariant = ["basic", "rightBar", "leftBar", "bothBars"].includes(obj.dimensionVariant)
      ? obj.dimensionVariant
      : "basic";
    const capHalf = Math.max(sw * 4, 1.2);
    const addCap = (point) => {
      const cap = document.createElementNS(SVG_NS, "line");
      cap.setAttribute("x1", point.x - ny * capHalf);
      cap.setAttribute("y1", point.y + nx * capHalf);
      cap.setAttribute("x2", point.x + ny * capHalf);
      cap.setAttribute("y2", point.y - nx * capHalf);
      cap.setAttribute("stroke", color);
      cap.setAttribute("stroke-width", sw);
      g.appendChild(cap);
    };
    if (dimensionVariant === "leftBar" || dimensionVariant === "bothBars") addCap(obj.p1);
    if (dimensionVariant === "rightBar" || dimensionVariant === "bothBars") addCap(obj.p2);

    const label = document.createElementNS(SVG_NS, "text");
    const mx = (obj.p1.x + obj.p2.x) / 2;
    const my = (obj.p1.y + obj.p2.y) / 2;
    label.setAttribute("x", mx);
    label.setAttribute("y", my);
    label.setAttribute("fill", color);
    label.setAttribute("font-size", Math.max(2.5, sw * 8));
    // Match the straight-line external label (makeUprightLabel): HWP equation
    // stack so a dimension label (e.g. "Q") reads identically to a line
    // variable label (e.g. "H"). Style only — geometry/behavior unchanged.
    applyObjectLabelFont(label, obj.labelType);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "central");
    label.setAttribute("paint-order", "stroke");
    label.setAttribute("stroke", "white");
    label.setAttribute("stroke-width", Math.max(0.8, sw * 3));
    label.setAttribute("stroke-linejoin", "round");
    fillTextWithRomanRuns(label, obj.dimensionLabel || "d");
    g.appendChild(label);
  }

  return withLineLabel(g, obj);
}

/* Attach a line's optional upright label (Group 3): when labelShow is on and
 * label text is non-empty, render it screen-upright, centered ABOVE the line
 * midpoint (mirrors the length-display styling, custom text, lifted above). The
 * line is drawn in absolute p1→p2 coords (no rotation group), so the label is
 * naturally upright. Wraps the body in a <g> carrying the data-id. */
function withLineLabel(bodyEl, obj) {
  if (!(obj.labelShow && String(obj.label ?? ""))) return bodyEl;
  // Length-display (dimension) mode already shows text along the line, so the
  // external label is redundant there — skip it (Group 6 task 3).
  if (obj.lineStyle === "dimensionArrow") return bodyEl;
  const mx = (obj.p1.x + obj.p2.x) / 2;
  const my = (obj.p1.y + obj.p2.y) / 2;
  const size = obj.labelSize || DEFAULT_TEXT_SIZE_MM;
  // Offset the label along the line's NORMAL by a FIXED distance so the label-to-
  // line gap is identical at every angle (the old screen-up offset varied with
  // angle). Default side is normalized to screen-up (negative y); 반전(labelFlip)
  // mirrors it to the opposite side at the SAME perpendicular distance (point-
  // symmetric about the foot of the perpendicular = the midpoint).
  const dx = obj.p2.x - obj.p1.x, dy = obj.p2.y - obj.p1.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  if (ny > 0) { nx = -nx; ny = -ny; } // keep default side pointing up
  const side = obj.labelFlip ? -1 : 1;
  const off = size; // fixed perpendicular gap (angle-independent)
  const lx = mx + nx * off * side;
  const ly = my + ny * off * side;
  const lbl = makeUprightLabel(obj.label, lx, ly, grayHex(obj.strokeLevel), size, { labelType: obj.labelType });
  if (!lbl) return bodyEl;
  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) { g.dataset.id = obj.id; if (bodyEl.dataset) delete bodyEl.dataset.id; }
  g.appendChild(bodyEl);
  g.appendChild(lbl);
  return g;
}

/* ----- rounded corners (경사면처리): per-vertex quadratic fillet path ----- */
// Projection only — NEVER mutates points[]. Each interior vertex V becomes a
// quadratic Bezier whose CONTROL point is V itself, so straight slope/flat
// segments stay perfectly straight and only the joints round off (this is a
// per-vertex fillet, NOT a spline through all points). The back-off distance is
// clamped to a QUARTER of each adjacent segment, so each end loses at most 1/4
// and at least half of every segment ALWAYS stays straight (straight runs
// dominate, fillets stay narrow — as in the reference inclined-plane figure).
// Open path: P0 and Pn are left sharp (arrowhead direction unaffected).
function roundedPolylinePath(pts, radius, closed) {
  const P = pts || [];
  const n = P.length;
  if (n < 2) return "";
  const r = Math.max(0, radius || 0);
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  // point on segment V→T, `off` world units away from V (toward T)
  const backoff = (V, T, off) => {
    const L = dist(V, T);
    if (L === 0) return { x: V.x, y: V.y }; // zero-length segment: no movement
    return { x: V.x + ((T.x - V.x) / L) * off, y: V.y + ((T.y - V.y) / L) * off };
  };

  if (closed) {
    if (n < 3) return ""; // nothing to round below a triangle
    let d = "";
    for (let i = 0; i < n; i++) {
      const V = P[i];
      const A = P[(i - 1 + n) % n];
      const B = P[(i + 1) % n];
      const off = Math.min(r, 0.25 * dist(A, V), 0.25 * dist(V, B));
      const p1 = backoff(V, A, off);
      const p2 = backoff(V, B, off);
      d += i === 0 ? `M ${p1.x} ${p1.y}` : ` L ${p1.x} ${p1.y}`;
      d += ` Q ${V.x} ${V.y} ${p2.x} ${p2.y}`;
    }
    return d + " Z"; // Z draws the straight remainder of the wrap-around edge
  }

  let d = `M ${P[0].x} ${P[0].y}`;
  for (let i = 1; i < n - 1; i++) {
    const V = P[i];
    const A = P[i - 1];
    const B = P[i + 1];
    const off = Math.min(r, 0.25 * dist(A, V), 0.25 * dist(V, B));
    const p1 = backoff(V, A, off);
    const p2 = backoff(V, B, off);
    d += ` L ${p1.x} ${p1.y} Q ${V.x} ${V.y} ${p2.x} ${p2.y}`;
  }
  return d + ` L ${P[n - 1].x} ${P[n - 1].y}`;
}

/* ----- polyline: many connected points, black stroke, no fill (click-to-click) ----- */
// Arrowheads use the SAME single arrowHead field + makeArrowHead() as renderLine
// (one setting for the whole line, no per-segment array):
//   end    = last point, direction of the last segment
//   both   = first point (reverse of first segment) + last point
//   center = 50% path-length point, pointing along travel direction
// The arrow-bearing END SEGMENT is retracted by the arrow length, like renderLine.
function renderPolyline(obj) {
  const sw = obj.strokeWidth ?? 0.2;
  const color = grayHex(obj.strokeLevel);
  const pts = obj.points || [];
  const n = pts.length;

  // ----- closed polyline: a filled <polygon> (fillable like rect/ellipse/triangle) -----
  // Arrowheads don't apply to a closed shape; it just takes the shared fill + dash.
  if (obj.closed === true) {
    // 경사면처리 on: a filled <path> with rounded joints (keeps the same fill).
    if (obj.rounded === true && n >= 3) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", roundedPolylinePath(pts, obj.cornerRadius ?? 10, true));
      path.setAttribute("fill", resolveFill(obj));
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", sw);
      applyDash(path, obj);
      if (obj.id) path.dataset.id = obj.id;
      return path;
    }
    const poly = document.createElementNS(SVG_NS, "polygon");
    poly.setAttribute("points", pts.map((p) => `${p.x},${p.y}`).join(" "));
    poly.setAttribute("fill", resolveFill(obj));
    poly.setAttribute("stroke", color);
    poly.setAttribute("stroke-width", sw);
    applyDash(poly, obj);
    if (obj.id) poly.dataset.id = obj.id;
    return poly;
  }

  const arrowHead = obj.arrowHead ?? "none";

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
  if ((arrowHead === "start" || arrowHead === "both") && startDir) {
    draw[0] = { x: pts[0].x + startDir.x * arrowLen, y: pts[0].y + startDir.y * arrowLen };
  }

  // 경사면처리 on: a <path> with rounded joints (sharp endpoints keep the
  // arrowhead direction intact); otherwise the plain <polyline>.
  let el;
  if (obj.rounded === true && n >= 3) {
    el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("d", roundedPolylinePath(draw, obj.cornerRadius ?? 10, false));
  } else {
    el = document.createElementNS(SVG_NS, "polyline");
    el.setAttribute("points", draw.map((p) => `${p.x},${p.y}`).join(" "));
  }
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
  if ((arrowHead === "start" || arrowHead === "both") && startDir) {
    g.appendChild(makeArrowHead(pts[0].x, pts[0].y, -startDir.x, -startDir.y, sw, color));
  }
  if (arrowHead === "center") { // legacy project compatibility
    const m = polylineMidpoint(pts);
    if (m) g.appendChild(makeArrowHead(m.x, m.y, m.dx, m.dy, sw, color));
  }

  return g;
}

/* ----- Catmull-Rom spline ??SVG cubic Bezier path string ----- */
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

/* ----- Catmull-Rom spline closed loop ??SVG cubic Bezier path string + Z ----- */
function catmullRomClosedPath(pts) {
  if (!pts || pts.length < 3) return "";
  const n = pts.length;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2.x} ${p2.y}`;
  }
  d += " Z";
  return d;
}

/* ----- curve outline as a flat list of {x,y} samples (for snapping/hit-tests) -----
 * Mirrors catmullRomPath / catmullRomClosedPath exactly (same control points), so
 * the sampled polyline tracks the rendered curve. Projection-only; never mutates
 * obj.points. Closed curves include the wrap-around span. */
export function curveSamplePoints(obj, samplesPerSeg = 12) {
  const pts = (obj && obj.points) || [];
  const n = pts.length;
  if (n < 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  if (n === 2) return [{ x: pts[0].x, y: pts[0].y }, { x: pts[1].x, y: pts[1].y }];
  const closed = obj.closed === true && n >= 3;
  const evalSeg = (p0, p1, p2, p3, t) => {
    const cp1x = p1.x + (p2.x - p0.x) / 6, cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6, cp2y = p2.y - (p3.y - p1.y) / 6;
    const u = 1 - t;
    const x = u * u * u * p1.x + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * p2.x;
    const y = u * u * u * p1.y + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y + t * t * t * p2.y;
    return { x, y };
  };
  const out = [{ x: pts[0].x, y: pts[0].y }];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const p0 = closed ? pts[(i - 1 + n) % n] : pts[Math.max(i - 1, 0)];
    const p1 = closed ? pts[i] : pts[i];
    const p2 = closed ? pts[(i + 1) % n] : pts[i + 1];
    const p3 = closed ? pts[(i + 2) % n] : pts[Math.min(i + 2, n - 1)];
    for (let s = 1; s <= samplesPerSeg; s++) out.push(evalSeg(p0, p1, p2, p3, s / samplesPerSeg));
  }
  return out;
}

/* ----- curve: Catmull-Rom smooth path through anchors ----- */
function renderCurve(obj) {
  if (obj.closed === true && (obj.points || []).length >= 3) {
    const el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("d", catmullRomClosedPath(obj.points));
    el.setAttribute("fill", obj.fillNone ? "transparent" : resolveFill(obj));
    el.setAttribute("stroke", grayHex(obj.strokeLevel));
    el.setAttribute("stroke-width", obj.strokeWidth);
    applyDash(el, obj);
    if (obj.id) el.dataset.id = obj.id;
    return el;
  }
  const el = document.createElementNS(SVG_NS, "path");
  el.setAttribute("d", catmullRomPath(obj.points));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", grayHex(obj.strokeLevel));
  el.setAttribute("stroke-width", obj.strokeWidth);
  applyDash(el, obj);
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
  // Style fields — safe defaults so old text objects (without them) still render.
  applySvgTextFont(el, {
    family: obj.fontFamily || DEFAULT_TEXT_FONT,
    style: resolveTextFontStyle(obj),
    weight: obj.fontWeight || "normal",
    letterSpacing: resolveTextLetterSpacing(obj),
  });
  const deco = [];
  if (obj.underline) deco.push("underline");
  if (obj.strikeout) deco.push("line-through");
  if (deco.length) el.setAttribute("text-decoration", deco.join(" "));
  el.setAttribute("text-anchor", "start");
  el.setAttribute("dominant-baseline", "hanging");
  if (obj.id) el.dataset.id = obj.id;
  // Optional rotation about the text's top-left anchor.
  const rot = obj.rotation ?? 0;
  if (rot) el.setAttribute("transform", `rotate(${rot},${obj.x},${obj.y})`);

  if (Array.isArray(obj.textRuns) && obj.textRuns.length) {
    appendStyledTextRuns(el, obj);
  } else {
    const lines = (obj.text || "").split("\n");
    if (lines.length === 1) {
      fillTextWithRomanRuns(el, lines[0]);
    } else {
      lines.forEach((line, i) => {
        const ts = document.createElementNS(SVG_NS, "tspan");
        ts.setAttribute("x", obj.x);
        ts.setAttribute("dy", i === 0 ? "0" : obj.fontSize * 1.4);
        fillTextWithRomanRuns(ts, line || "\u00a0");
        el.appendChild(ts);
      });
    }
  }
  return el;
}

/* ----- image: embedded raster via SVG <image> (href = base64 data URL) ----- */
function renderImage(obj) {
  const el = document.createElementNS(SVG_NS, "image");
  el.setAttribute("x", obj.x);
  el.setAttribute("y", obj.y);
  el.setAttribute("width", obj.w);
  el.setAttribute("height", obj.h);
  el.setAttribute("href", obj.src);
  el.setAttribute("preserveAspectRatio", "none");
  if (obj.opacity != null) el.setAttribute("opacity", obj.opacity);
  if (obj.id) el.dataset.id = obj.id;
  const rot = obj.rotation ?? 0;
  if (rot !== 0) {
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    el.setAttribute("transform", `rotate(${rot},${cx},${cy})`);
  }
  return el;
}

/* ----- axes: one atomic symbol — both axis lines + arrowheads + ticks + labels
 * drawn in a SINGLE pass into one <g>. Ticks/labels are PROJECTIONS computed
 * here from the data (x/y/w/h/showTicks/tickSpacing/label*), never stored as
 * separate objects — mirroring how text is one box, not per-glyph. Mathematical
 * convention: +X points right, +Y points UP (screen-up = smaller SVG y). ----- */
function renderAxes(obj) {
  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;

  // Transparent body rect over the whole bbox: makes the symbol behave as ONE
  // solid object — the entire box is a click/drag target (mirrors a rect's fill,
  // DESIGN 5-3) so body-drag move works from anywhere inside, not only on a line.
  const body = document.createElementNS(SVG_NS, "rect");
  body.setAttribute("x", obj.x);
  body.setAttribute("y", obj.y);
  body.setAttribute("width", obj.w);
  body.setAttribute("height", obj.h);
  body.setAttribute("fill", "transparent");
  g.appendChild(body);

  const color = grayHex(obj.strokeLevel);
  const sw = obj.strokeWidth || 0.2;
  const cx = obj.x + obj.w / 2; // origin = bbox center
  const cy = obj.y + obj.h / 2;
  const left = obj.x, right = obj.x + obj.w;
  const top = obj.y, bottom = obj.y + obj.h; // SVG: top has the smaller y

  const addLine = (x1, y1, x2, y2) => {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("stroke", color);
    l.setAttribute("stroke-width", sw);
    g.appendChild(l);
  };

  // ----- axis variant: which arms exist + which sides get ticks -----
  // cross    → H+V through origin, all four arms; arrows on +X & +Y.
  // quadrant → origin → right and origin → up only (L-shape); arrows on +X & +Y.
  // single   → one horizontal line; arrow on +X only (labelY/Y-arm ignored).
  const variant = obj.axisVariant || "cross";
  const hasYArm   = variant !== "single";          // vertical arm present?
  const negXArm   = variant === "cross";           // arm to the left of origin?
  const negYArm   = variant === "cross";           // arm below origin?
  const bothSides = variant === "cross";           // ticks on the − side too?

  // ----- arrowheads scaled 1.5× for the axis only (shared makeArrowHead untouched) -----
  const headSw = sw * 1.5;       // inflated stroke-width → head grows 1.5×
  const head = headSw * 4.5;     // arrowhead length at this scale (matches makeArrowHead)

  // ----- axis lines (shortened slightly so the arrowheads cap the ends) -----
  addLine(negXArm ? left : cx, cy, right - head * 0.6, cy);              // X axis (→ +X)
  if (hasYArm) addLine(cx, negYArm ? bottom : cy, cx, top + head * 0.6); // Y axis (→ +Y, up)

  // ----- arrowheads at the +X (right) and +Y (top) ends -----
  g.appendChild(makeArrowHead(right, cy, 1, 0, headSw, color));            // +X → pointing right
  if (hasYArm) g.appendChild(makeArrowHead(cx, top, 0, -1, headSw, color)); // +Y → pointing up

  // ----- tick marks: stepped out from the origin; − side only when bothSides -----
  if (obj.showTicks) {
    const step = Math.max(obj.tickSpacing || 5, 0.5);
    const tHalf = sw * 4; // tick half-length (perpendicular to its axis)
    // X-axis ticks (skip the origin); stop short of the arrowhead.
    for (let d = step; d <= obj.w / 2 - head * 0.6; d += step) {
      addLine(cx + d, cy - tHalf, cx + d, cy + tHalf);
      if (bothSides) addLine(cx - d, cy - tHalf, cx - d, cy + tHalf);
    }
    // Y-axis ticks (skip the origin); stop short of the arrowhead.
    if (hasYArm) {
      for (let d = step; d <= obj.h / 2 - head * 0.6; d += step) {
        addLine(cx - tHalf, cy - d, cx + tHalf, cy - d);                   // +Y (up) side
        if (bothSides) addLine(cx - tHalf, cy + d, cx + tHalf, cy + d);    // −Y (down) side
      }
    }
  }

  // ----- axis labels (equation font, near each arrow tip) -----
  const labelSize = Math.max(sw * 14, 3);
  const addLabel = (text, lx, ly, anchor, baseline) => {
    if (!text) return;
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", lx);
    t.setAttribute("y", ly);
    t.setAttribute("font-size", labelSize);
    applyObjectLabelFont(t, obj.labelType);
    t.setAttribute("fill", color);
    t.setAttribute("text-anchor", anchor);
    t.setAttribute("dominant-baseline", baseline);
    fillTextWithRomanRuns(t, text);
    g.appendChild(t);
  };
  addLabel(obj.labelX, right, cy + labelSize * 0.9, "end", "hanging");  // below +X tip
  if (hasYArm) addLabel(obj.labelY, cx - labelSize * 0.5, top, "end", "hanging"); // left of +Y tip

  // ----- rotation: whole symbol turns about its origin (bbox center) -----
  const rot = obj.rotation ?? 0;
  if (rot) g.setAttribute("transform", `rotate(${rot} ${cx} ${cy})`);

  return g;
}

/* ----- anglearc: one atomic symbol — the angle θ drawn in a SINGLE pass.
 * Geometry lives in data (vertex x/y, radius, startAngle, sweepAngle in MATH
 * convention: CCW positive, +Y up). The drawn arc + label are pure PROJECTIONS;
 * the two rays are intentionally NOT drawn (the user adds those with the line
 * tool). A transparent pie-sector body makes the whole wedge ONE solid
 * click/drag target — mirroring how renderAxes lays a transparent body so the
 * symbol behaves as one indivisible object. Rotation is encoded in startAngle
 * (no group transform), keeping the arc data-as-truth. ----- */
function renderAngleArc(obj) {
  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;

  const vx = obj.x, vy = obj.y;                 // vertex (world/SVG coords)
  const r = Math.max(obj.radius || 0, 0.0001);
  const a0 = obj.startAngle || 0;
  const sweep = obj.sweepAngle ?? 0;
  const a1 = a0 + sweep;
  const color = grayHex(obj.strokeLevel);
  const sw = obj.strokeWidth || 0.2;

  // math angle (deg, CCW, +Y up) → SVG point (y down): up = smaller SVG y.
  const pt = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: vx + r * Math.cos(rad), y: vy - r * Math.sin(rad) };
  };
  const p0 = pt(a0), p1 = pt(a1);
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  // math CCW (screen counterclockwise) = SVG sweep-flag 0; CW (negative) = 1.
  const sweepFlag = sweep >= 0 ? 0 : 1;

  // Transparent pie-sector body (vertex → start → arc → close): one solid target.
  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute("d",
    `M ${vx} ${vy} L ${p0.x} ${p0.y} ` +
    `A ${r} ${r} 0 ${largeArc} ${sweepFlag} ${p1.x} ${p1.y} Z`);
  body.setAttribute("fill", "transparent");
  body.setAttribute("stroke", "none");
  g.appendChild(body);

  // The visible arc (no fill).
  const arc = document.createElementNS(SVG_NS, "path");
  arc.setAttribute("d",
    `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} ${sweepFlag} ${p1.x} ${p1.y}`);
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", color);
  arc.setAttribute("stroke-width", sw);
  g.appendChild(arc);

  // Label (default θ) at the arc midpoint, just OUTSIDE the radius.
  if (obj.showLabel !== false && obj.label) {
    const labelSize = Math.max(sw * 14, 3);
    const mid = a0 + sweep / 2;
    const rad = (mid * Math.PI) / 180;
    const lr = r + labelSize * 0.9;
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", vx + lr * Math.cos(rad));
    t.setAttribute("y", vy - lr * Math.sin(rad));
    t.setAttribute("font-size", labelSize);
    applyObjectLabelFont(t, obj.labelType);
    t.setAttribute("fill", color);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "middle");
    fillTextWithRomanRuns(t, obj.label);
    g.appendChild(t);
  }

  return g;
}

/* ----- estimate a labeler's text block half-extents (world mm) -----
 * No exact measurement is available here: renderLabeler runs for both the live
 * canvas and SVG/PNG export, where the element isn't laid out yet (getBBox would
 * read 0). So estimate from font size, line count, the longest line, and the
 * line height used by makeUprightLabel (lineHeight = size * 1.2). The block is
 * centered on the label point; the returned half-width/half-height include `pad`.
 * Per-char widths intentionally OVER-estimate (CJK ≈ 1em, others ≈ 0.6em) so the
 * leader stops outside the glyphs even when measurement is imperfect. */
function estimateLabelBlock(text, size, pad) {
  const s = String(text ?? "");
  const lines = s.length ? s.split("\n") : [""];
  const lineHeight = size * 1.2;
  const isWide = (code) =>
    (code >= 0x1100 && code <= 0x11ff) ||  // Hangul Jamo
    (code >= 0x3000 && code <= 0x9fff) ||  // CJK symbols/punctuation + Unified
    (code >= 0xac00 && code <= 0xd7a3) ||  // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) ||  // CJK Compatibility Ideographs
    (code >= 0xff00 && code <= 0xffef);    // Fullwidth forms
  let maxEm = 0;
  for (const line of lines) {
    let em = 0;
    for (const ch of line) em += isWide(ch.codePointAt(0)) ? 1.0 : 0.6;
    maxEm = Math.max(maxEm, em);
  }
  const blockW = maxEm * size;
  const blockH = lines.length * lineHeight;
  return { hw: blockW / 2 + pad, hh: blockH / 2 + pad };
}

/* ----- labeler: a short leader line (지시선) from a graph anchor to an upright
 * NAME label (이름). Data: p1 = anchor (on/near the graph), p2 = label position,
 * text = label content (circled-letter preset by default), labelSize = mm. The
 * leader runs from p1 toward p2 but stops a SMALL gap short of p2, then the upright
 * (non-rotating) label sits at p2 in the tool label font, upright/normal
 * (makeUprightLabel, Group 6 / v0.31.0). Pure projection — both points are the
 * truth and round-trip on save/load. ----- */
function renderLabeler(obj) {
  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;
  const color = grayHex(obj.strokeLevel);
  const sw = obj.strokeWidth || 0.2;
  const a = obj.p1 || { x: 0, y: 0 };
  const b = obj.p2 || a;
  const size = obj.labelSize || DEFAULT_TEXT_SIZE_MM;

  // Leader from the anchor toward the label, stopping at the edge of the label's
  // (multiline-aware) text block so the line never crosses the glyphs. The block
  // is upright and centered on b (matching makeUprightLabel), so its axis-aligned
  // bounds are valid under any labeler rotation (which rotates a/b in world space).
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const ux = dist ? dx / dist : 0, uy = dist ? dy / dist : 0;
  // Small visual gap (~2-4px equivalent) between the leader tip and the text edge.
  const pad = size * 0.25;
  const { hw, hh } = estimateLabelBlock(obj.text, size, pad);
  // Distance from b back along the leader to where it crosses the padded block:
  // the nearer of the vertical/horizontal faces (ray-vs-centered-box).
  const tx = Math.abs(ux) > 1e-6 ? hw / Math.abs(ux) : Infinity;
  const ty = Math.abs(uy) > 1e-6 ? hh / Math.abs(uy) : Infinity;
  const tBox = Math.min(tx, ty);
  const lead = dist - tBox;                // leader length, trimmed to the block edge
  // Fall back safely when the anchor sits inside (or within the gap of) the text
  // block: skip the leader entirely rather than draw a line over the glyphs.
  if (lead > 0.05) {
    const ex = a.x + ux * lead, ey = a.y + uy * lead;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", ex);
    line.setAttribute("y2", ey);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", sw);
    line.setAttribute("stroke-linecap", "round");
    g.appendChild(line);
  }

  // Upright (non-rotating) callout text at p2. The labeler is an editable text
  // object: its default style is Dotum-first NORMAL text (not 물리량 italic). A
  // per-object fontFamily (set in the inspector 글씨체 control) overrides the
  // default; if absent, fall back to the system Dotum stack.
  const lbl = makeUprightLabel(obj.text, b.x, b.y, color, size, {
    fontFamily: obj.fontFamily || DEFAULT_TEXT_FONT,
    fontStyle: "normal",
  });
  if (lbl) g.appendChild(lbl);

  return g;
}

function renderRightAngle(obj) {
  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;
  const color = grayHex(obj.strokeLevel);
  const sw = obj.strokeWidth || 0.2;
  const size = Math.max(obj.size || 4, 0.1);
  const angle = (obj.angle || 0) * Math.PI / 180;
  const side = (obj.orientation ?? 1) >= 0 ? 1 : -1;
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const vx = -uy * side, vy = ux * side;
  const p0 = { x: obj.x, y: obj.y };
  const p1 = { x: p0.x + ux * size, y: p0.y + uy * size };
  const p2 = { x: p1.x + vx * size, y: p1.y + vy * size };
  const p3 = { x: p0.x + vx * size, y: p0.y + vy * size };

  const body = document.createElementNS(SVG_NS, "polygon");
  body.setAttribute("points", `${p0.x},${p0.y} ${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`);
  body.setAttribute("fill", "transparent");
  body.setAttribute("stroke", "none");
  g.appendChild(body);

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y}`);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", sw);
  g.appendChild(path);
  return g;
}

function renderApparatus(obj) {
  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;
  const body = document.createElementNS(SVG_NS, "rect");
  body.setAttribute("x", obj.x);
  body.setAttribute("y", obj.y);
  body.setAttribute("width", obj.w);
  body.setAttribute("height", obj.h);
  body.setAttribute("fill", "transparent");
  g.appendChild(body);

  const color = grayHex(obj.strokeLevel);
  const sw = obj.strokeWidth || 0.2;
  const kind = obj.kind || "wire";
  if (kind === "wire") drawWire(g, obj, sw, color);
  else if (kind === "compass") drawCompass(g, obj, sw, color);
  else if (kind === "pulley") drawPulley(g, obj, sw, color);
  else if (kind === "clamp") drawClamp(g, obj, sw, color);
  else if (kind === "scale") drawScale(g, obj, sw, color);

  const rot = obj.rotation ?? 0;
  if (rot) {
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    g.setAttribute("transform", `rotate(${rot} ${cx} ${cy})`);
  }
  return g;
}

function drawWire(g, obj, sw, color) {
  const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
  const length = Math.max(obj.length || obj.w || 20, 1);
  const thickness = Math.max(obj.thickness ?? obj.gap ?? Math.max(sw * 6, 1.8), sw * 2.5, 0.2);
  const angle = (obj.angle || 0) * Math.PI / 180;
  const wire = document.createElementNS(SVG_NS, "rect");
  wire.setAttribute("x", cx - length / 2);
  wire.setAttribute("y", cy - thickness / 2);
  wire.setAttribute("width", length);
  wire.setAttribute("height", thickness);
  wire.setAttribute("rx", thickness / 2);
  wire.setAttribute("fill", "#e6e6e6");
  wire.setAttribute("stroke", color);
  wire.setAttribute("stroke-width", sw);
  wire.setAttribute("transform", `rotate(${angle * 180 / Math.PI} ${cx} ${cy})`);
  g.appendChild(wire);
}

function drawCompass(g, obj, sw, color) {
  const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
  const r = Math.min(obj.w, obj.h) / 2 * 0.88;
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
  c.setAttribute("fill", "none"); c.setAttribute("stroke", color); c.setAttribute("stroke-width", sw);
  g.appendChild(c);
  const deg = obj.needleAngle ?? -90;
  const rad = deg * Math.PI / 180;
  const ux = Math.cos(rad), uy = Math.sin(rad);
  const px = -uy, py = ux;
  const tip = { x: cx + ux * r * 0.72, y: cy + uy * r * 0.72 };
  const tail = { x: cx - ux * r * 0.72, y: cy - uy * r * 0.72 };
  const half = r * 0.13;
  const needle = document.createElementNS(SVG_NS, "polygon");
  needle.setAttribute("points",
    `${tip.x},${tip.y} ${cx + px * half},${cy + py * half} ${tail.x},${tail.y} ${cx - px * half},${cy - py * half}`);
  needle.setAttribute("fill", "#d9d9d9");
  needle.setAttribute("stroke", color);
  needle.setAttribute("stroke-width", sw);
  g.appendChild(needle);
  oLine(g, cx - px * half * 0.8, cy - py * half * 0.8, cx + px * half * 0.8, cy + py * half * 0.8, sw * 0.7, color);
  oDot(g, cx, cy, Math.max(r * 0.08, sw * 1.2), color);
}

function drawPulley(g, obj, sw, color) {
  const cx = obj.x + obj.w * 0.38, cy = obj.y + obj.h * 0.38;
  const r = Math.min(obj.w, obj.h) * 0.34;
  const variant = obj.variant || "basic";
  const outer = document.createElementNS(SVG_NS, "circle");
  outer.setAttribute("cx", cx); outer.setAttribute("cy", cy); outer.setAttribute("r", r);
  outer.setAttribute("fill", "none"); outer.setAttribute("stroke", color); outer.setAttribute("stroke-width", sw);
  g.appendChild(outer);
  const inner = document.createElementNS(SVG_NS, "circle");
  inner.setAttribute("cx", cx); inner.setAttribute("cy", cy); inner.setAttribute("r", r * 0.72);
  inner.setAttribute("fill", "none"); inner.setAttribute("stroke", color); inner.setAttribute("stroke-width", sw * 0.85);
  g.appendChild(inner);
  const axleR = Math.max(r * 0.24, 0.65);
  const axle = document.createElementNS(SVG_NS, "circle");
  axle.setAttribute("cx", cx); axle.setAttribute("cy", cy); axle.setAttribute("r", axleR);
  axle.setAttribute("fill", "#b8b8b8");
  axle.setAttribute("stroke", color);
  axle.setAttribute("stroke-width", sw * 0.8);
  g.appendChild(axle);
  if (variant !== "simple") {
    const armAngle = Math.PI / 4;
    const ux = Math.cos(armAngle), uy = Math.sin(armAngle);
    const px = -uy, py = ux;
    const start = { x: cx + ux * axleR * 0.7, y: cy + uy * axleR * 0.7 };
    const end = { x: obj.x + obj.w * 0.82, y: obj.y + obj.h * 0.78 };
    const half = Math.max(r * 0.13, sw * 2);
    const arm = document.createElementNS(SVG_NS, "polygon");
    arm.setAttribute("points",
      `${start.x + px * half},${start.y + py * half} ${end.x + px * half},${end.y + py * half} ${end.x - px * half},${end.y - py * half} ${start.x - px * half},${start.y - py * half}`);
    arm.setAttribute("fill", "white");
    arm.setAttribute("stroke", color);
    arm.setAttribute("stroke-width", sw);
    g.appendChild(arm);
    const boltR = Math.max(r * 0.16, 0.45);
    const bolt = document.createElementNS(SVG_NS, "circle");
    bolt.setAttribute("cx", end.x);
    bolt.setAttribute("cy", end.y);
    bolt.setAttribute("r", boltR);
    bolt.setAttribute("fill", "#b8b8b8");
    bolt.setAttribute("stroke", color);
    bolt.setAttribute("stroke-width", sw * 0.8);
    g.appendChild(bolt);
  }
}

function drawClamp(g, obj, sw, color) {
  const left = obj.x, top = obj.y, w = obj.w, h = obj.h;
  const dir = obj.flipped ? -1 : 1;
  const standX = left + (obj.flipped ? w * 0.64 : w * 0.64);
  const rodY = top + h * 0.18;
  const rodStart = standX - dir * w * 0.5;
  const rodEnd = standX + dir * w * 0.22;
  const tubeW = Math.max(w * 0.055, sw * 2.8);
  const tubeFill = "#e6e6e6";
  const vRod = document.createElementNS(SVG_NS, "rect");
  vRod.setAttribute("x", standX - tubeW / 2);
  vRod.setAttribute("y", top + h * 0.08);
  vRod.setAttribute("width", tubeW);
  vRod.setAttribute("height", h * 0.82);
  vRod.setAttribute("fill", tubeFill);
  vRod.setAttribute("stroke", color);
  vRod.setAttribute("stroke-width", sw);
  g.appendChild(vRod);
  const hRod = document.createElementNS(SVG_NS, "rect");
  hRod.setAttribute("x", Math.min(rodStart, rodEnd));
  hRod.setAttribute("y", rodY - tubeW / 2);
  hRod.setAttribute("width", Math.abs(rodEnd - rodStart));
  hRod.setAttribute("height", tubeW);
  hRod.setAttribute("fill", tubeFill);
  hRod.setAttribute("stroke", color);
  hRod.setAttribute("stroke-width", sw);
  g.appendChild(hRod);
  const bw = w * 0.17, bh = h * 0.08;
  const block = document.createElementNS(SVG_NS, "rect");
  block.setAttribute("x", standX - bw / 2);
  block.setAttribute("y", rodY - bh / 2);
  block.setAttribute("width", bw);
  block.setAttribute("height", bh);
  block.setAttribute("fill", "#d9d9d9");
  block.setAttribute("stroke", color);
  block.setAttribute("stroke-width", sw);
  g.appendChild(block);
  const knob = document.createElementNS(SVG_NS, "circle");
  knob.setAttribute("cx", standX);
  knob.setAttribute("cy", rodY);
  knob.setAttribute("r", Math.max(bh * 0.3, 0.45));
  knob.setAttribute("fill", "#f2f2f2");
  knob.setAttribute("stroke", color);
  knob.setAttribute("stroke-width", sw);
  g.appendChild(knob);
  oDot(g, standX, rodY, Math.max(bh * 0.14, 0.2), color);
  const baseY = top + h * 0.86;
  const base = document.createElementNS(SVG_NS, "path");
  base.setAttribute("d",
    `M ${left + w * 0.40} ${baseY} L ${left + w * 0.88} ${baseY} L ${left + w * 0.88} ${baseY + h * 0.08} L ${left + w * 0.68} ${baseY + h * 0.08} L ${left + w * 0.66} ${baseY + h * 0.045} L ${left + w * 0.52} ${baseY + h * 0.045} L ${left + w * 0.50} ${baseY + h * 0.08} L ${left + w * 0.40} ${baseY + h * 0.08} Z`);
  base.setAttribute("fill", "#ededed");
  base.setAttribute("stroke", color);
  base.setAttribute("stroke-width", sw);
  g.appendChild(base);
}

function drawScale(g, obj, sw, color) {
  const x = obj.x, y = obj.y, w = obj.w, h = obj.h;
  const top = y + h * 0.08;
  const platform = document.createElementNS(SVG_NS, "rect");
  platform.setAttribute("x", x + w * 0.25);
  platform.setAttribute("y", top);
  platform.setAttribute("width", w * 0.5);
  platform.setAttribute("height", h * 0.12);
  platform.setAttribute("fill", "none");
  platform.setAttribute("stroke", color);
  platform.setAttribute("stroke-width", sw);
  g.appendChild(platform);
  oLine(g, x + w * 0.32, top + h * 0.16, x + w * 0.68, top + h * 0.16, sw, color);
  const body = document.createElementNS(SVG_NS, "rect");
  body.setAttribute("x", x + w * 0.08);
  body.setAttribute("y", y + h * 0.28);
  body.setAttribute("width", w * 0.84);
  body.setAttribute("height", h * 0.55);
  body.setAttribute("rx", Math.min(w, h) * 0.07);
  body.setAttribute("fill", "#e6e6e6");
  body.setAttribute("stroke", color);
  body.setAttribute("stroke-width", sw);
  g.appendChild(body);
  const display = document.createElementNS(SVG_NS, "rect");
  display.setAttribute("x", x + w * 0.13);
  display.setAttribute("y", y + h * 0.43);
  display.setAttribute("width", w * 0.48);
  display.setAttribute("height", h * 0.25);
  display.setAttribute("rx", Math.min(w, h) * 0.035);
  display.setAttribute("fill", "none");
  display.setAttribute("stroke", color);
  display.setAttribute("stroke-width", sw * 0.8);
  g.appendChild(display);
  cText(g, x + w * 0.37, y + h * 0.555, obj.displayText || "0.99 N", Math.min(w * 0.105, h * 0.21), color);
  oDot(g, x + w * 0.72, y + h * 0.55, h * 0.07, color);
  oDot(g, x + w * 0.83, y + h * 0.55, h * 0.07, color);
  const footY = y + h * 0.83;
  const feet = document.createElementNS(SVG_NS, "path");
  feet.setAttribute("d",
    `M ${x + w * 0.18} ${footY} L ${x + w * 0.32} ${footY} L ${x + w * 0.32} ${y + h * 0.88} L ${x + w * 0.16} ${y + h * 0.88} Q ${x + w * 0.14} ${y + h * 0.88} ${x + w * 0.18} ${footY} Z ` +
    `M ${x + w * 0.68} ${footY} L ${x + w * 0.82} ${footY} Q ${x + w * 0.86} ${y + h * 0.88} ${x + w * 0.84} ${y + h * 0.88} L ${x + w * 0.68} ${y + h * 0.88} Z`);
  feet.setAttribute("fill", "#e6e6e6");
  feet.setAttribute("stroke", color);
  feet.setAttribute("stroke-width", sw);
  g.appendChild(feet);
}

/* ===== CIRCUIT: branch-B atomic symbol (two terminals p1/p2, like a line) =====
 *
 * CORE INVARIANT — symmetric leads: the element BODY is always centered on the
 * midpoint of p1–p2 and is a FIXED world size (CIRCUIT_BODY_MM along the axis), so
 * the two leads (terminal → body edge) are ALWAYS equal by construction. Lead
 * lengths are NOT stored; they are derived here. If |p1–p2| < CIRCUIT_BODY_MM the
 * body fills the whole span and the leads are zero-length (clamped, never negative).
 *
 * Geometry is single-source via circuitGeom(); renderCircuit draws the shared
 * skeleton (leads + label) and dispatches the BODY by `element` through
 * CIRCUIT_ELEMENTS, so Steps 2–3 add elements by adding cases only. */
const CIRCUIT_BODY_HALF_H = CIRCUIT_BODY_MM * 0.2; // default body box half-height (perp to axis)
const CIRCUIT_HEIGHT_ELEMENTS = new Set(["resistor", "inductor", "capacitor", "voltmeter", "ammeter"]);

function circuitHalfHeight(obj) {
  const defaultHeight = obj && (obj.element === "voltmeter" || obj.element === "ammeter")
    ? CIRCUIT_CIRCLE_R * 2
    : CIRCUIT_BODY_HALF_H * 2;
  const h = obj && CIRCUIT_HEIGHT_ELEMENTS.has(obj.element) && Number.isFinite(obj.height)
    ? obj.height
    : defaultHeight;
  return Math.max(0.5, h) / 2;
}

// Derive all projection geometry from the two stored terminals. `half` is the
// body half-length along the axis (clamped so it never exceeds the span).
function circuitGeom(obj) {
  const p1 = obj.p1, p2 = obj.p2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const L = Math.hypot(dx, dy) || 0.0001;
  const ux = dx / L, uy = dy / L;       // unit vector along p1→p2
  const px = -uy, py = ux;              // unit vector perpendicular to the axis
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const half = Math.min(CIRCUIT_BODY_MM, L) / 2;
  const heightScale = circuitHalfHeight(obj) / CIRCUIT_BODY_HALF_H;
  const bodyStart = { x: mid.x - ux * half, y: mid.y - uy * half };
  const bodyEnd   = { x: mid.x + ux * half, y: mid.y + uy * half };
  return { p1, p2, dx, dy, L, ux, uy, px, py, mid, half, heightScale, bodyStart, bodyEnd };
}

// World-space 4-corner polygon of the element body box (for hit-testing). Shared
// with tools.js so the clickable box matches exactly what renderCircuit draws.
export function circuitBodyPolygon(obj) {
  const g = circuitGeom(obj);
  const { mid, ux, uy, px, py, half } = g;
  const hh = circuitHalfHeight(obj);
  return [
    { x: mid.x - ux * half - px * hh, y: mid.y - uy * half - py * hh },
    { x: mid.x + ux * half - px * hh, y: mid.y + uy * half - py * hh },
    { x: mid.x + ux * half + px * hh, y: mid.y + uy * half + py * hh },
    { x: mid.x - ux * half + px * hh, y: mid.y - uy * half + py * hh },
  ];
}

/* ----- shared circuit body helpers (projection-only, reused by every element) ----- */
const CIRCUIT_CIRCLE_R = CIRCUIT_BODY_MM * 0.32;   // circle-body radius (ac/unknown/lamp/meters)
const CIRCUIT_CAP_GAP_DEFAULT = 2;                 // capacitor plate gap default (mm); mirrors tools.js makeCircuit

// Point at axis-offset `a` (along p1→p2) and perp-offset `o`, in world coords.
function circuitPt(geo, a, o) {
  return { x: geo.mid.x + geo.ux * a + geo.px * o, y: geo.mid.y + geo.uy * a + geo.py * o };
}
// A plain world-space stroke segment between two {x,y} points.
function cLine(a, b, sw, color) {
  const l = document.createElementNS(SVG_NS, "line");
  l.setAttribute("x1", a.x); l.setAttribute("y1", a.y);
  l.setAttribute("x2", b.x); l.setAttribute("y2", b.y);
  l.setAttribute("stroke", color); l.setAttribute("stroke-width", sw);
  return l;
}
// A centered glyph (shared by circle-body elements + diode terminal labels + optics label).
function cText(g, x, y, text, size, color, fontFamily = null, fontStyle = null, labelType = null) {
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y);
  t.setAttribute("font-size", size);
  if (fontFamily || fontStyle) {
    applySvgTextFont(t, {
      family: fontFamily || TOOL_LABEL_FONT_FAMILY,
      style: fontStyle || VARIABLE_LABEL_FONT_STYLE,
      letterSpacing: fontFamily ? resolveTextLetterSpacing({ fontFamily }) : EQUATION_LETTER_SPACING,
    });
  } else {
    applyObjectLabelFont(t, labelType);
  }
  t.setAttribute("fill", color);
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("dominant-baseline", "central");
  fillTextWithRomanRuns(t, text);
  g.appendChild(t);
}
// Circle body + short connectors from circle edge to the lead ends (ac/unknown/lamp/meters).
function circuitCircleBody(g, geo, sw, color, obj) {
  const r = obj ? Math.max(0.25, circuitHalfHeight(obj)) : CIRCUIT_CIRCLE_R;
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", geo.mid.x); c.setAttribute("cy", geo.mid.y);
  c.setAttribute("r", r);
  c.setAttribute("fill", "none");
  c.setAttribute("stroke", color);
  c.setAttribute("stroke-width", sw);
  g.appendChild(c);
  if (geo.half > r) {
    g.appendChild(cLine(circuitPt(geo, -geo.half, 0), circuitPt(geo, -r, 0), sw, color));
    g.appendChild(cLine(circuitPt(geo, r, 0), circuitPt(geo, geo.half, 0), sw, color));
  }
}

/* ----- per-element BODY drawers (dispatch on obj.element). The shared skeleton
 * (leads + label) lives in renderCircuit; each drawer paints ONLY the body in the
 * geo's axis/perp frame, so it rotates with the placement and stays centered. */
const CIRCUIT_ELEMENTS = {
  // resistor: a zig-zag (sawtooth) along the p1→p2 axis — the Korean exam standard.
  // 6 alternating peaks; the first/last points sit on the axis so the leads meet it
  // cleanly. ux/uy (axis) and px/py (perp) already encode the tilt, so the points
  // come out rotated with no transform needed. No fill.
  resistor(g, geo, sw, color) {
    const { mid, ux, uy, px, py, half } = geo;
    const amp = half * 0.35 * geo.heightScale;            // peak amplitude, perp to axis
    const ts   = [0, 1/12, 3/12, 5/12, 7/12, 9/12, 11/12, 1];
    const offs = [0,  amp, -amp,  amp, -amp,  amp, -amp,  0]; // alternating peaks
    const pts = ts.map((t, i) => {
      const a = (2 * t - 1) * half;                       // axis coord: -half … +half
      const o = offs[i];
      return `${mid.x + ux * a + px * o},${mid.y + uy * a + py * o}`;
    }).join(" ");
    const poly = document.createElementNS(SVG_NS, "polyline");
    poly.setAttribute("points", pts);
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", color);
    poly.setAttribute("stroke-width", sw);
    g.appendChild(poly);
  },

  // dc_source: long(+) & short(−) bars ⟂ axis with a small gap at center.
  dc_source(g, geo, sw, color) {
    const H = CIRCUIT_BODY_HALF_H, half = geo.half;
    const d = half * 0.18;                                         // half-gap between the bars
    g.appendChild(cLine(circuitPt(geo, -half, 0), circuitPt(geo, -d, 0), sw, color));              // lead → long bar
    g.appendChild(cLine(circuitPt(geo, d, 0), circuitPt(geo, half, 0), sw, color));                // short bar → lead
    g.appendChild(cLine(circuitPt(geo, -d, -H), circuitPt(geo, -d, H), sw, color));                // long (+)
    g.appendChild(cLine(circuitPt(geo, d, -H * 0.5), circuitPt(geo, d, H * 0.5), sw, color));       // short (−)
  },

  // ac_source: circle body with a sine wave (∿) inside.
  ac_source(g, geo, sw, color) {
    circuitCircleBody(g, geo, sw, color);
    const aMax = CIRCUIT_CIRCLE_R * 0.7, amp = CIRCUIT_CIRCLE_R * 0.45, N = 24;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const a = -aMax + (2 * aMax) * (i / N);
      const o = Math.sin((a / aMax) * Math.PI) * amp;
      const p = circuitPt(geo, a, o);
      pts.push(`${p.x},${p.y}`);
    }
    const wave = document.createElementNS(SVG_NS, "polyline");
    wave.setAttribute("points", pts.join(" "));
    wave.setAttribute("fill", "none");
    wave.setAttribute("stroke", color);
    wave.setAttribute("stroke-width", sw);
    g.appendChild(wave);
  },

  // capacitor: two EQUAL parallel bars ⟂ axis, separated by obj.gap (world mm).
  capacitor(g, geo, sw, color, obj) {
    const H = circuitHalfHeight(obj);
    const half = geo.half;
    let gap = (obj && Number.isFinite(obj.gap)) ? obj.gap : CIRCUIT_CAP_GAP_DEFAULT;
    gap = Math.min(gap, half * 1.6);                              // keep plates inside the body span
    const d = gap / 2;
    g.appendChild(cLine(circuitPt(geo, -half, 0), circuitPt(geo, -d, 0), sw, color));   // lead → plate
    g.appendChild(cLine(circuitPt(geo, d, 0), circuitPt(geo, half, 0), sw, color));      // plate → lead
    g.appendChild(cLine(circuitPt(geo, -d, -H), circuitPt(geo, -d, H), sw, color));      // plate 1
    g.appendChild(cLine(circuitPt(geo, d, -H), circuitPt(geo, d, H), sw, color));        // plate 2
  },

  // inductor: 4 semicircle bumps along the axis (bulging to perp+).
  inductor(g, geo, sw, color) {
    const half = geo.half, bumps = 4;
    const R = (2 * half) / bumps / 2;                             // bump radius
    const pts = [];
    for (let b = 0; b < bumps; b++) {
      const ac = -half + R * (2 * b + 1);                         // bump center along axis
      const steps = 10;
      for (let s = (b === 0 ? 0 : 1); s <= steps; s++) {
        const th = Math.PI * (s / steps);                        // 0 → π semicircle
        const p = circuitPt(geo, ac - R * Math.cos(th), R * Math.sin(th) * geo.heightScale);
        pts.push(`${p.x},${p.y}`);
      }
    }
    const coil = document.createElementNS(SVG_NS, "polyline");
    coil.setAttribute("points", pts.join(" "));
    coil.setAttribute("fill", "none");
    coil.setAttribute("stroke", color);
    coil.setAttribute("stroke-width", sw);
    g.appendChild(coil);
  },

  // unknown: circle body with a "?" inside.
  unknown(g, geo, sw, color) {
    circuitCircleBody(g, geo, sw, color);
    cText(g, geo.mid.x, geo.mid.y, "?", CIRCUIT_CIRCLE_R * 1.2, color);
  },

  // diode: filled triangle along axis + cathode bar at the tip; two terminal labels.
  diode(g, geo, sw, color, obj) {
    const H = CIRCUIT_BODY_HALF_H, half = geo.half;
    const triHalf = half * 0.6;
    g.appendChild(cLine(circuitPt(geo, -half, 0), circuitPt(geo, -triHalf, 0), sw, color)); // lead → base
    g.appendChild(cLine(circuitPt(geo, triHalf, 0), circuitPt(geo, half, 0), sw, color));   // bar → lead
    const b1 = circuitPt(geo, -triHalf, -H), b2 = circuitPt(geo, -triHalf, H), apex = circuitPt(geo, triHalf, 0);
    const tri = document.createElementNS(SVG_NS, "polygon");
    tri.setAttribute("points", `${b1.x},${b1.y} ${b2.x},${b2.y} ${apex.x},${apex.y}`);
    tri.setAttribute("fill", color);
    tri.setAttribute("stroke", color);
    tri.setAttribute("stroke-width", sw);
    g.appendChild(tri);
    g.appendChild(cLine(circuitPt(geo, triHalf, -H), circuitPt(geo, triHalf, H), sw, color)); // cathode bar
    const tl = (obj && obj.terminalLabels) || ["", ""];
    const size = DEFAULT_TEXT_SIZE_MM * 0.8;
    const sign = geo.py <= 0 ? 1 : -1;                            // perpendicular toward screen-up
    const off = H + size * 0.7;
    if ((tl[0] ?? "") !== "") cText(g, geo.p1.x + geo.px * off * sign, geo.p1.y + geo.py * off * sign, tl[0], size, color, null, null, obj?.labelType);
    if ((tl[1] ?? "") !== "") cText(g, geo.p2.x + geo.px * off * sign, geo.p2.y + geo.py * off * sign, tl[1], size, color, null, null, obj?.labelType);
  },

  // lamp: circle body with an ✕ inside.
  lamp(g, geo, sw, color) {
    circuitCircleBody(g, geo, sw, color);
    const d = CIRCUIT_CIRCLE_R * 0.6;
    g.appendChild(cLine(circuitPt(geo, -d, -d), circuitPt(geo, d, d), sw, color));
    g.appendChild(cLine(circuitPt(geo, -d, d), circuitPt(geo, d, -d), sw, color));
  },

  // ammeter: circle body with "A" inside.
  ammeter(g, geo, sw, color, obj) {
    circuitCircleBody(g, geo, sw, color, obj);
    cText(g, geo.mid.x, geo.mid.y, "A", Math.max(0.25, circuitHalfHeight(obj)) * 1.2, color);
  },

  // voltmeter: circle body with "V" inside.
  voltmeter(g, geo, sw, color, obj) {
    circuitCircleBody(g, geo, sw, color, obj);
    cText(g, geo.mid.x, geo.mid.y, "V", Math.max(0.25, circuitHalfHeight(obj)) * 1.2, color);
  },
};

function renderCircuit(obj) {
  const sw = obj.strokeWidth ?? 0.2;
  const color = grayHex(obj.strokeLevel);
  const geo = circuitGeom(obj);
  const { p1, p2, ux, uy, px, py, mid, half, bodyStart, bodyEnd, L } = geo;

  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;

  const seg = (a, b) => {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("x1", a.x); l.setAttribute("y1", a.y);
    l.setAttribute("x2", b.x); l.setAttribute("y2", b.y);
    l.setAttribute("stroke", color);
    l.setAttribute("stroke-width", sw);
    return l;
  };

  // Shared skeleton — leads: terminal → body edge. Equal by construction; drawn
  // only when there is leftover wire (clamped to zero-length when the body fills
  // the whole span, so no overlapping/negative wire).
  if (L > CIRCUIT_BODY_MM) {
    g.appendChild(seg(p1, bodyStart));
    g.appendChild(seg(bodyEnd, p2));
  }

  // BODY — dispatch on element; obj is passed for element-specific fields
  // (capacitor.gap, diode.terminalLabels). All body geometry is derived here.
  (CIRCUIT_ELEMENTS[obj.element] || CIRCUIT_ELEMENTS.resistor)(g, geo, sw, color, obj);

  // Shared skeleton — label: a single text just above the box (only if non-empty),
  // using the world-unit physics/tool label convention.
  if ((obj.label ?? "") !== "") {
    const size = DEFAULT_TEXT_SIZE_MM;
    // Offset along the perpendicular toward screen-up (smaller y) so the label
    // sits "above" the box regardless of the placement tilt.
    const sign = py <= 0 ? 1 : -1;
    const off = CIRCUIT_BODY_HALF_H + size * 0.6;
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", mid.x + px * off * sign);
    t.setAttribute("y", mid.y + py * off * sign);
    t.setAttribute("font-size", size);
    applyObjectLabelFont(t, obj.labelType);
    t.setAttribute("fill", color);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "middle");
    fillTextWithRomanRuns(t, obj.label);
    g.appendChild(t);
  }

  return g;
}

/* ===== OPTICS: branch-A box symbol (x/y/w/h/rotation), kind-dispatched =====
 *
 * Reuses the rect/ellipse interaction skeleton wholesale (creation, selection,
 * resize, rotate, hit-test) — only the render differs. Every symbol is drawn as
 * a PROJECTION from the bounding box and is symmetric about the box's horizontal
 * axis (the optical axis). A transparent body rect makes the whole box one
 * click/drag target (like renderAxes). Rotation is one group transform about the
 * box center, matching renderRect. */

// A stroke segment in the optics box (optional thicker `width`).
function oLine(g, x1, y1, x2, y2, sw, color, width) {
  const l = document.createElementNS(SVG_NS, "line");
  l.setAttribute("x1", x1); l.setAttribute("y1", y1);
  l.setAttribute("x2", x2); l.setAttribute("y2", y2);
  l.setAttribute("stroke", color); l.setAttribute("stroke-width", width || sw);
  g.appendChild(l);
}
// A quadratic-arc stroke (lens/mirror curves).
function oQuad(g, x0, y0, cx, cy, x1, y1, sw, color) {
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", `M ${x0} ${y0} Q ${cx} ${cy} ${x1} ${y1}`);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", color); p.setAttribute("stroke-width", sw);
  g.appendChild(p);
}
// Point on a quadratic Bézier at parameter t (for mirror hatch placement).
function quadPt(x0, y0, cx, cy, x1, y1, t) {
  const u = 1 - t;
  return { x: u * u * x0 + 2 * u * t * cx + t * t * x1, y: u * u * y0 + 2 * u * t * cy + t * t * y1 };
}
// Filled dot (point light / node / pivot center / pulley axle).
function oDot(g, cx, cy, r, color) {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
  c.setAttribute("fill", color);
  g.appendChild(c);
}
// Short 45° hatch ticks along a vertical line x=X, on side `sign` (mirror backing/screen).
function hatchVLine(g, X, top, bottom, sign, sw, color) {
  const n = 6, len = Math.min((bottom - top) * 0.12, 2) + 0.4;
  for (let i = 1; i <= n; i++) {
    const y = top + (bottom - top) * (i / (n + 1));
    oLine(g, X, y, X + sign * len, y - len, sw, color);
  }
}
// Thin vertical dashed line (lens optical-axis / center line). Follows the body
// color/strokeLevel but is drawn thinner than the lens outline.
function oDashV(g, x, y1, y2, sw, color) {
  const l = document.createElementNS(SVG_NS, "line");
  l.setAttribute("x1", x); l.setAttribute("y1", y1);
  l.setAttribute("x2", x); l.setAttribute("y2", y2);
  l.setAttribute("stroke", color);
  l.setAttribute("stroke-width", Math.max(sw * 0.6, 0.1));
  l.setAttribute("stroke-dasharray", "1.2 1");
  l.setAttribute("fill", "none");
  g.appendChild(l);
}
// Optional center dashed line through a lens. centerLine: "none"|"top"|"bottom"|"full".
// "top" = upper half (lens top→center), "bottom" = lower half (center→bottom).
function drawCenterLine(g, obj, sw, color) {
  const mode = obj.centerLine || "none";
  if (mode === "none") return;
  const cx = obj.x + obj.w / 2;
  const top = obj.y, bottom = obj.y + obj.h, cy = obj.y + obj.h / 2;
  let y1 = top, y2 = bottom;
  if (mode === "top") { y2 = cy; }
  else if (mode === "bottom") { y1 = cy; }
  oDashV(g, cx, y1, y2, sw, color);
}
// Mirror = vertical arc bowing `sign` in x + hatch ticks on the back (bulge) side.
function drawMirror(g, obj, sw, color, sign) {
  const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
  const top = obj.y, bottom = obj.y + obj.h;
  const cpx = cx + obj.w * 0.32 * sign;
  oQuad(g, cx, top, cpx, cy, cx, bottom, sw, color);
  const n = 6, len = Math.min(obj.h * 0.12, 2) + 0.4;
  for (let i = 1; i <= n; i++) {
    const p = quadPt(cx, top, cpx, cy, cx, bottom, i / (n + 1));
    oLine(g, p.x, p.y, p.x + sign * len, p.y - len, sw, color);
  }
}

const OPTICS_KINDS = {
  // convex_lens: two outward-bowed arcs meeting at sharp top & bottom vertices
  // (eye shape). No arrowheads. Optional center dashed line via centerLine.
  convex_lens(g, obj, sw, color) {
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    const top = obj.y, bottom = obj.y + obj.h, bow = obj.w * 0.5;
    oQuad(g, cx, top, cx - bow, cy, cx, bottom, sw, color);   // left bulge
    oQuad(g, cx, top, cx + bow, cy, cx, bottom, sw, color);   // right bulge
    drawCenterLine(g, obj, sw, color);
  },
  // concave_lens: ")(" inward arcs with flat caps (pinched middle / bowtie).
  // No arrowheads. Optional center dashed line via centerLine.
  concave_lens(g, obj, sw, color) {
    const cy = obj.y + obj.h / 2;
    const left = obj.x, right = obj.x + obj.w, top = obj.y, bottom = obj.y + obj.h;
    const bow = obj.w * 0.32;
    oLine(g, left, top, right, top, sw, color);                   // top cap
    oLine(g, left, bottom, right, bottom, sw, color);             // bottom cap
    oQuad(g, left, top, left + bow, cy, left, bottom, sw, color);    // ")" bulge right
    oQuad(g, right, top, right - bow, cy, right, bottom, sw, color); // "(" bulge left
    drawCenterLine(g, obj, sw, color);
  },
  // convex_mirror: arc bowing right + hatch ticks on the back (right) side.
  convex_mirror(g, obj, sw, color) { drawMirror(g, obj, sw, color, 1); },
  // concave_mirror: arc bowing left + hatch ticks on the back (left) side.
  concave_mirror(g, obj, sw, color) { drawMirror(g, obj, sw, color, -1); },
  // object_arrow: thick UP arrow spanning h at the box center x.
  object_arrow(g, obj, sw, color) {
    const cx = obj.x + obj.w / 2, top = obj.y, bottom = obj.y + obj.h;
    const bodyWidth = Math.max(sw * 2.5, 0.5);
    const headSw = Math.max(sw * 3, 0.7);
    const arrowLen = headSw * 4.5 * 0.7;
    const shaftTop = Math.min(bottom, top + arrowLen);
    const shaft = document.createElementNS(SVG_NS, "line");
    shaft.setAttribute("x1", cx);
    shaft.setAttribute("y1", bottom);
    shaft.setAttribute("x2", cx);
    shaft.setAttribute("y2", shaftTop);
    shaft.setAttribute("stroke", color);
    shaft.setAttribute("stroke-width", bodyWidth);
    applyDash(shaft, obj);
    g.appendChild(shaft);
    g.appendChild(makeArrowHead(cx, top, 0, -1, headSw, color));
  },
  // pulley: circle (dia = min(w,h)) + small center axle dot. No rope.
  pulley(g, obj, sw, color) {
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    const r = Math.min(obj.w, obj.h) / 2;
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
    c.setAttribute("fill", resolveFill(obj));
    c.setAttribute("stroke", color); c.setAttribute("stroke-width", sw);
    g.appendChild(c);
    oDot(g, cx, cy, Math.max(r * 0.12, 0.4), color);
  },
  // plane_mirror: vertical straight line + back-side hatch ticks.
  plane_mirror(g, obj, sw, color) {
    const cx = obj.x + obj.w / 2, top = obj.y, bottom = obj.y + obj.h;
    oLine(g, cx, top, cx, bottom, sw, color);
    hatchVLine(g, cx, top, bottom, 1, sw, color);
  },
  // point_light: small filled circle + short radial rays.
  point_light(g, obj, sw, color) {
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    const m = Math.min(obj.w, obj.h);
    oDot(g, cx, cy, m * 0.16, color);
    const rIn = m * 0.26, rOut = m * 0.48;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      oLine(g, cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn,
               cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut, sw, color);
    }
  },
  // node: small filled circle only (wire junction).
  node(g, obj, sw, color) {
    oDot(g, obj.x + obj.w / 2, obj.y + obj.h / 2, Math.min(obj.w, obj.h) * 0.22, color);
  },
  // support_tri: small upward triangle (a stand/support base).
  support_tri(g, obj, sw, color) {
    const left = obj.x, right = obj.x + obj.w, top = obj.y, bottom = obj.y + obj.h, cx = obj.x + obj.w / 2;
    const tri = document.createElementNS(SVG_NS, "polygon");
    tri.setAttribute("points", `${cx},${top} ${left},${bottom} ${right},${bottom}`);
    tri.setAttribute("fill", resolveFill(obj));
    tri.setAttribute("stroke", color); tri.setAttribute("stroke-width", sw);
    g.appendChild(tri);
  },
  // pivot: small ⊙ (outline circle + center dot) = rotation axis.
  pivot(g, obj, sw, color) {
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2, r = Math.min(obj.w, obj.h) * 0.3;
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
    c.setAttribute("fill", "none"); c.setAttribute("stroke", color); c.setAttribute("stroke-width", sw);
    g.appendChild(c);
    oDot(g, cx, cy, Math.max(r * 0.28, 0.4), color);
  },
  // screen: a thick vertical bar with hatch ticks on one side (projection screen).
  screen(g, obj, sw, color) {
    const cx = obj.x + obj.w / 2, top = obj.y, bottom = obj.y + obj.h;
    oLine(g, cx, top, cx, bottom, sw, color, Math.max(sw * 3, 0.8));
    hatchVLine(g, cx, top, bottom, 1, sw, color);
  },
  // bar_magnet: rectangle split into two halves labelled "N" and "S".
  bar_magnet(g, obj, sw, color) {
    const left = obj.x, top = obj.y, cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2, bottom = obj.y + obj.h;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", obj.x); rect.setAttribute("y", obj.y);
    rect.setAttribute("width", obj.w); rect.setAttribute("height", obj.h);
    rect.setAttribute("fill", resolveFill(obj));
    rect.setAttribute("stroke", color); rect.setAttribute("stroke-width", sw);
    g.appendChild(rect);
    oLine(g, cx, top, cx, bottom, sw, color);                    // divider
    const size = Math.min(obj.w * 0.4, obj.h * 0.6);
    cText(g, left + obj.w * 0.25, cy, "N", size, color);
    cText(g, left + obj.w * 0.75, cy, "S", size, color);
  },
};

function renderOptics(obj) {
  const g = document.createElementNS(SVG_NS, "g");
  if (obj.id) g.dataset.id = obj.id;
  const color = grayHex(obj.strokeLevel);
  const sw = obj.strokeWidth || 0.2;

  // Transparent body over the whole bbox: the symbol behaves as ONE click/drag
  // target (mirrors renderAxes), so a hollow lens/mirror is grabbable anywhere.
  const body = document.createElementNS(SVG_NS, "rect");
  body.setAttribute("x", obj.x); body.setAttribute("y", obj.y);
  body.setAttribute("width", obj.w); body.setAttribute("height", obj.h);
  body.setAttribute("fill", "transparent");
  g.appendChild(body);

  (OPTICS_KINDS[obj.kind] || OPTICS_KINDS.convex_lens)(g, obj, sw, color);

  // Optional label below the bbox (toggled by showLabel, like the anglearc label).
  if (obj.showLabel && (obj.label ?? "") !== "") {
    const size = DEFAULT_TEXT_SIZE_MM;
    cText(g, obj.x + obj.w / 2, obj.y + obj.h + size * 0.8, obj.label, size, color, null, null, obj.labelType);
  }

  const rot = obj.rotation ?? 0;
  if (rot) {
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    g.setAttribute("transform", `rotate(${rot} ${cx} ${cy})`);
  }

  // Node label (Feature G): a horizontal text above/below the dot that must NEVER
  // rotate with the object. Rendered in an un-rotated wrapper OUTSIDE g's rotate
  // transform; the dot sits at the rotation center, so its position is unaffected.
  if (obj.kind === "node" && (obj.label ?? "") !== "") {
    const wrap = document.createElementNS(SVG_NS, "g");
    if (obj.id) { wrap.dataset.id = obj.id; delete g.dataset.id; }
    wrap.appendChild(g);
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    const dotR = Math.min(obj.w, obj.h) * 0.22;
    const size = DEFAULT_TEXT_SIZE_MM;
    const ly = (obj.labelPos ?? "above") === "below"
      ? cy + dotR + size * 0.7
      : cy - dotR - size * 0.7;
    cText(wrap, cx, ly, obj.label, size, color, null, null, obj.labelType);
    return wrap;
  }
  return g;
}

/* ----- rotate point (px,py) about center (cx,cy) by deg degrees (SVG clockwise) ----- */
export function rotPt(px, py, cx, cy, deg) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/* ===== SNAP PREVIEW OVERLAY: closest pair only, zoom-invariant styling ===== */
function renderSnapPreview(scene, zoom) {
  if (!snapPreview) return;
  const scale = zoom > 0 ? zoom : 1;
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("id", "snap-preview");
  group.setAttribute("pointer-events", "none");

  // SINGLE red-dot indicator: when from and to coincide (endpoint/node attach),
  // draw ONE dot and no connecting line. Otherwise (body-move pairing preview)
  // keep the dashed link + a dot at each end.
  const coincident = Math.hypot(snapPreview.to.x - snapPreview.from.x,
                                snapPreview.to.y - snapPreview.from.y) < 0.5 / scale;
  if (!coincident) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", snapPreview.from.x);
    line.setAttribute("y1", snapPreview.from.y);
    line.setAttribute("x2", snapPreview.to.x);
    line.setAttribute("y2", snapPreview.to.y);
    line.setAttribute("stroke", "#e03131");
    line.setAttribute("stroke-width", 1 / scale);
    line.setAttribute("stroke-dasharray", `${4 / scale} ${3 / scale}`);
    group.appendChild(line);
  }

  const dotPoints = coincident ? [snapPreview.to] : [snapPreview.from, snapPreview.to];
  for (const point of dotPoints) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", point.x);
    dot.setAttribute("cy", point.y);
    dot.setAttribute("r", 4 / scale);
    dot.setAttribute("fill", "#e03131");
    group.appendChild(dot);
  }
  scene.appendChild(group);
}

/* ----- grayscale level (0??55) ??hex; 0 = black, 255 = white (DESIGN 7-2) ----- */
function grayHex(level = 0) {
  const v = Math.max(0, Math.min(255, Math.round(level)));
  const h = v.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

/* ===== FILL PATTERNS (grayscale only ??mark color = grayHex(obj.fillLevel)) ===== */
// Tile size / dot radius / mark stroke are fixed world-unit (mm) values, cheap to
// tune. Patterns are per-object (id = pat_{obj.id}) and rebuilt every render, so a
// different fillLevel per object never collides.
const PAT_TILE   = 3.2;  // pattern tile edge (mm)
const PAT_DOT_R  = 0.55; // dot radius (mm)
const PAT_STROKE = 0.35; // cross/hatch mark stroke width (mm)

/* ----- which objects can carry a fill (shared by render + pattern builder) ----- */
// rect/ellipse/triangle always; a polyline or curve only once it is closed.
function isFillable(obj) {
  return obj.type === "rect" || obj.type === "ellipse" || obj.type === "triangle"
      || obj.type === "optics"
      || (obj.type === "polyline" && obj.closed === true)
      || (obj.type === "curve"    && obj.closed === true);
}

/* ----- resolve an object's fill attribute (DESIGN 5-3: empty still clickable) ----- */
//   fillNone            ??"transparent"
//   fillStyle "solid"   ??grayHex(fillLevel)
//   otherwise (pattern) ??url(#pat_{id})
function resolveFill(obj) {
  if (obj.fillNone) return "transparent";
  const style = obj.fillStyle ?? "solid";
  if (style === "solid" || !obj.id) return grayHex(obj.fillLevel);
  return `url(#pat_${obj.id})`;
}

/* ----- build a <pattern> for one object, or null when it needs no pattern ----- */
// Each tile starts with a fill="transparent" base rect so the empty area between
// marks still captures clicks (DESIGN 5-3), exactly like a transparent solid fill.
export function makeFillPattern(obj) {
  obj = resolveObjectStyle(obj);
  const style = obj.fillStyle ?? "solid";
  if (!obj.id || obj.fillNone || style === "solid" || !isFillable(obj)) return null;

  const mark = grayHex(obj.fillLevel);
  const pat = document.createElementNS(SVG_NS, "pattern");
  pat.setAttribute("id", `pat_${obj.id}`);
  pat.setAttribute("patternUnits", "userSpaceOnUse");
  pat.setAttribute("width", PAT_TILE);
  pat.setAttribute("height", PAT_TILE);

  const base = document.createElementNS(SVG_NS, "rect");
  base.setAttribute("width", PAT_TILE);
  base.setAttribute("height", PAT_TILE);
  base.setAttribute("fill", "transparent");
  pat.appendChild(base);

  const line = (x1, y1, x2, y2) => {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("stroke", mark);
    l.setAttribute("stroke-width", PAT_STROKE);
    pat.appendChild(l);
  };

  if (style === "dots") {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", PAT_TILE / 2);
    c.setAttribute("cy", PAT_TILE / 2);
    c.setAttribute("r", PAT_DOT_R);
    c.setAttribute("fill", mark);
    pat.appendChild(c);
  } else if (style === "cross") {
    const m = PAT_TILE / 2, d = PAT_TILE * 0.22; // ??arm half-length
    line(m - d, m - d, m + d, m + d);
    line(m - d, m + d, m + d, m - d);
  } else if (style === "hatch") {
    // 45째 parallel lines. The main anti-diagonal tiles seamlessly; the two
    // half-corner segments fill the seams so the lines read as continuous.
    line(0, PAT_TILE, PAT_TILE, 0);
    line(-PAT_TILE / 2, PAT_TILE / 2, PAT_TILE / 2, -PAT_TILE / 2);
    line(PAT_TILE / 2, PAT_TILE * 1.5, PAT_TILE * 1.5, PAT_TILE / 2);
  }
  return pat;
}

/* ----- selection handles: 10-CSS-px white squares, zoom-invariant (DESIGN 5-2) ----- */
/* ----- bbox of one object in world space (text uses its rendered <text> box) ----- */
export function singleObjBBox(o, scene) {
  if (o.type === "rect" || o.type === "ellipse" || o.type === "triangle" || o.type === "image" || o.type === "axes" || o.type === "optics" || o.type === "apparatus") {
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
  // anglearc has no x/y/w/h — its box is the vertex-centered square of radius r.
  if (o.type === "anglearc") {
    const r = o.radius || 0;
    return { x: o.x - r, y: o.y - r, w: 2 * r, h: 2 * r };
  }
  if (o.type === "rightangle") {
    const r = (o.size || 0) * 1.6;
    return { x: o.x - r, y: o.y - r, w: 2 * r, h: 2 * r };
  }
  if (o.type === "text" || o.type === "formula") {
    const el = scene.querySelector(`[data-id="${o.id}"]`);
    if (el) {
      try { const bb = el.getBBox(); return { x: bb.x, y: bb.y, w: bb.width, h: bb.height }; }
      catch (_) { /* not laid out yet */ }
    }
    return null;
  }
  if (o.type === "line" || o.type === "circuit") {
    return {
      x: Math.min(o.p1.x, o.p2.x), y: Math.min(o.p1.y, o.p2.y),
      w: Math.abs(o.p2.x - o.p1.x), h: Math.abs(o.p2.y - o.p1.y),
    };
  }
  if (o.type === "labeler") {
    const a = o.p1 || { x: 0, y: 0 }, b = o.p2 || a;
    const sz = (o.labelSize || DEFAULT_TEXT_SIZE_MM) * 0.7; // pad for the label glyph
    const minX = Math.min(a.x, b.x - sz), minY = Math.min(a.y, b.y - sz);
    const maxX = Math.max(a.x, b.x + sz), maxY = Math.max(a.y, b.y + sz);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
  const half = 5 / zoom;   // resize square is half*2 = 10 CSS px (DESIGN 5-2 base size)
  const sw   = 0.5 / zoom;

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("id", "handles");

  const makeHandle = (wx, wy, label, easierPointerTarget = false) => {
    if (easierPointerTarget) {
      const hit = document.createElementNS(SVG_NS, "rect");
      const hitHalf = 12 / zoom;
      hit.setAttribute("x", wx - hitHalf);
      hit.setAttribute("y", wy - hitHalf);
      hit.setAttribute("width", hitHalf * 2);
      hit.setAttribute("height", hitHalf * 2);
      hit.setAttribute("fill", "transparent");
      hit.dataset.handle = label;
      hit.dataset.id = sel.id;
      g.appendChild(hit);
    }
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

  const _closedPoly  = sel.type === "polyline" && sel.closed === true;
  const _closedCurve = sel.type === "curve"    && sel.closed === true;
  const _anglearc = sel.type === "anglearc";
  const _rightangle = sel.type === "rightangle";
  if (sel.type === "rect" || sel.type === "ellipse" || sel.type === "triangle" || sel.type === "image" || sel.type === "axes" || sel.type === "optics" || sel.type === "apparatus" || _anglearc || _rightangle || _closedPoly || _closedCurve) {
    // Closed polyline/curve and anglearc reuse branch-A handles on a derived
    // (axis-aligned) bbox; none has x/y/w/h or a rotation field, so derive the
    // box and pin deg to 0 (anglearc's rotation lives in startAngle, not a box).
    let x, y, w, h, deg;
    if (_closedPoly || _closedCurve || _anglearc || _rightangle) {
      const bb = singleObjBBox(sel, scene);
      ({ x, y, w, h } = bb);
      deg = 0;
    } else {
      ({ x, y, w, h } = sel);
      deg = sel.rotation || 0;
    }
    const cx = x + w / 2, cy = y + h / 2;
    const rx = x + w, by = y + h;

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
      // corner handles: blue circles + 90째 arc indicators
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
  } else if (sel.type === "labeler" && activeTool === "rotate") {
    // Labeler rotation: corner handles (blue circles + 90° arc hints) around the
    // derived bbox spin the whole object (leader + label) about its center. Under
    // the V tool the labeler instead shows its two endpoint handles (below).
    const bb = singleObjBBox(sel, scene);
    if (bb) {
      const { x, y, w, h } = bb;
      const rx = x + w, by = y + h;
      const rotOuter = 28 / zoom;
      const makeArc = (px, py, startDeg, endDeg) => {
        const R = rotOuter;
        const s = startDeg * Math.PI / 180, en = endDeg * Math.PI / 180;
        const x1 = px + R * Math.cos(s), y1 = py + R * Math.sin(s);
        const x2 = px + R * Math.cos(en), y2 = py + R * Math.sin(en);
        const arc = document.createElementNS(SVG_NS, "path");
        arc.setAttribute("d", `M ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2}`);
        arc.setAttribute("fill", "none");
        arc.setAttribute("stroke", "#0969da");
        arc.setAttribute("stroke-width", 1.5 / zoom);
        arc.setAttribute("pointer-events", "none");
        g.appendChild(arc);
      };
      for (const [label, hx, hy, base] of [
        ["nw", x, y, 180], ["ne", rx, y, 270], ["se", rx, by, 0], ["sw", x, by, 90]
      ]) {
        const c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("cx", hx);
        c.setAttribute("cy", hy);
        c.setAttribute("r", half);
        c.setAttribute("fill", "#0969da");
        c.setAttribute("stroke", "none");
        c.dataset.handle = label;
        c.dataset.id = sel.id;
        g.appendChild(c);
        makeArc(hx, hy, base, base + 90);
      }
    }
  } else if (sel.type === "line" || sel.type === "circuit" || sel.type === "labeler") {
    // Circuit + labeler reuse the line's two endpoint handles: drag p1/p2 to move
    // an endpoint. For the labeler, p0 = leader anchor, p1 = label position.
    makeHandle(sel.p1.x, sel.p1.y, "p0", true);
    makeHandle(sel.p2.x, sel.p2.y, "p1", true);
  } else if ((sel.type === "polyline" || sel.type === "curve") && !sel.closed) {
    sel.points.forEach((p, i) => makeHandle(p.x, p.y, `p${i}`, true));
  }
  // text: no handles

  scene.appendChild(g);
}
