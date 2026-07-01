/* ===== SNAP: Shift-only body-move magnet and preview =====
 *
 * transform.js calls resolveSnap() once per body-move mousemove, before
 * applyDelta(). Distances are measured in world units after converting the
 * 40/80 screen-pixel thresholds through the current render scale.
 *
 * Rect, ellipse, and triangle participate as moving objects. Rect, triangle,
 * line, and polyline objects also contribute finite contact edges.
 */

import { rotPt, singleObjBBox, curveSamplePoints } from "./render.js?v=0.36.4";

const ATTACH_PX = 40;
const PREVIEW_PX = 80;
const SHAPE_TYPES = new Set(["rect", "ellipse", "triangle"]);
const EDGE_TARGET_TYPES = new Set(["rect", "triangle", "line", "polyline"]);
const LINE_TARGET_TYPES = new Set(["line", "polyline"]);
const CIRCLE_RATIO_EPSILON = 1e-3;

/* ===== PRIORITY SNAP: endpoint-first targets =====
 * High-priority snap runs BEFORE the shape magnet below. Line-like endpoints win
 * (priority 0); the optical "object" (물체) head is an explicit target (priority 1)
 * so light rays can start exactly at the object's tip. Lower priority value wins
 * ties. Targets are filtered by the same visibility/active-layer rule the picker
 * uses (tools.js isObjectSelectable); locked objects stay eligible because snapping
 * to a fixed reference is useful (DESIGN 6-1).
 */
const LINE_LIKE_TYPES = new Set(["line", "circuit", "polyline", "curve"]);

function isSnapTargetEligible(obj, snapshot) {
  const layerId = obj.layerId ?? 1;
  const layer = (snapshot.layers || []).find((item) => item.id === layerId);
  // Visible layers only — hidden layers are excluded, but any VISIBLE layer is a
  // valid snap target (Features C/D/G), not just the active one. (The picker is
  // active-layer-only; snapping deliberately reaches every visible layer.)
  return !!layer && layer.visible !== false;
}

/* Optical object head = top-center tip of the up-arrow, rotation applied about the
 * box center (mirrors renderOptics object_arrow + the rotate() transform).
 * Returns { head, attach }: `head` is the measured snap point. `attach` is the
 * point an endpoint/line that snaps TO this object is written to — it equals the
 * apex exactly so a light ray lands on the rendered arrowhead tip (FIX 1). The
 * separate "optics object snaps ONTO a line" seam-hiding overlap is NOT here; it
 * is recomputed against the target's stroke inside resolveOpticTipSnap. */
function opticalObjectHead(obj) {
  const cx = obj.x + obj.w / 2;
  const center = { x: cx, y: obj.y + obj.h / 2 };
  const rawHead = { x: cx, y: obj.y };
  const rot = obj.rotation || 0;
  const head = rot ? rotPt(rawHead.x, rawHead.y, center.x, center.y, rot) : rawHead;
  return { head, attach: head };
}

/* attach defaults to p; pass a different attach point to offset where a snapped
 * endpoint is WRITTEN while still measuring distance to p (used for optical heads). */
function makeSnapPoint(p, type, objectId, pointKey, priority, attach) {
  return {
    x: p.x, y: p.y, type, objectId, pointKey, priority,
    attachX: attach ? attach.x : p.x,
    attachY: attach ? attach.y : p.y,
  };
}

/* collectPrioritySnapPoints(state, excludeIds): high-priority targets only. */
export function collectPrioritySnapPoints(state, excludeIds) {
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const snapshot = state.get();
  const points = [];
  for (const obj of snapshot.objects) {
    if (!obj?.id || exclude.has(obj.id)) continue;
    if (!isSnapTargetEligible(obj, snapshot)) continue;
    if (obj.type === "line" || obj.type === "circuit") {
      if (isValidPoint(obj.p1)) points.push(makeSnapPoint(obj.p1, "line-endpoint", obj.id, "p1", 0));
      if (isValidPoint(obj.p2)) points.push(makeSnapPoint(obj.p2, "line-endpoint", obj.id, "p2", 0));
    } else if (obj.type === "polyline" || obj.type === "curve") {
      const pts = Array.isArray(obj.points) ? obj.points : [];
      if (pts.length && isValidPoint(pts[0])) {
        points.push(makeSnapPoint(pts[0], "line-endpoint", obj.id, "first", 0));
      }
      const last = pts[pts.length - 1];
      if (pts.length && isValidPoint(last)) {
        points.push(makeSnapPoint(last, "line-endpoint", obj.id, "last", 0));
      }
    } else if (obj.type === "optics" && obj.kind === "object_arrow") {
      const { head, attach } = opticalObjectHead(obj);
      points.push(makeSnapPoint(head, "optical-object-head", obj.id, "head", 1, attach));
    }
  }
  return points;
}

/* Closest target within maxDistance; ties (within ~0.5 screen px) go to lower
 * priority value, i.e. line endpoint over optical head. */
function nearestPriorityTarget(px, py, targets, maxDistance, scale) {
  const eps = 0.5 / (scale > 0 ? scale : 1);
  let best = null;
  for (const t of targets) {
    const d = Math.hypot(t.x - px, t.y - py);
    if (d > maxDistance) continue;
    if (!best) { best = { point: t, distance: d, priority: t.priority }; continue; }
    if (d < best.distance - eps) {
      best = { point: t, distance: d, priority: t.priority };
    } else if (Math.abs(d - best.distance) <= eps && t.priority < best.priority) {
      best = { point: t, distance: d, priority: t.priority };
    }
  }
  return best;
}

/* resolveEndpointSnap: for a single dragged line endpoint — either editing an
 * existing handle (Case A) or the live endpoint of a line being drawn (Feature C).
 * Returns { target, attach, preview } or null. MOVE-ONLY: caller relocates just the
 * dragged endpoint to `target` when attach is true; the other endpoint never moves.
 *
 * Candidates (closest within threshold wins; rank breaks near-ties):
 *   rank 0 — exact vertex/endpoint/optical head (collectPrioritySnapPoints)
 *   rank 1 — point projected onto a straight edge (line/polyline/rect/triangle)
 *   rank 2 — point on a curved surface outline (ellipse / curve)
 * Optical heads attach exactly at the apex so a ray lands on the arrowhead tip. */
export function resolveEndpointSnap(point, excludeIds, scale, state) {
  if (!isValidPoint(point)) return null;
  const safeScale = scale > 0 ? scale : 1;
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const best = nearestSnapPoint(point, exclude, state, 0.5 / safeScale);
  if (!best || best.distance > PREVIEW_PX / safeScale) return null;
  const target = { x: best.x, y: best.y };
  const attach = best.distance <= ATTACH_PX / safeScale;
  return {
    target,
    attach,
    preview: attach
      ? { from: target, to: target }
      : { from: { x: point.x, y: point.y }, to: target },
  };
}

/* nearestSnapPoint: THE shared nearest-snap-candidate helper (GLOBAL PRINCIPLE).
 * Returns { x, y, distance, rank, targetStroke } for the closest edge/curve/vertex
 * to `point`, or null. Rank breaks near-ties (eps): 0 = vertex/endpoint/optical
 * head, 1 = straight edge, 2 = curved surface. `targetStroke` is the snapped
 * object's strokeWidth (undefined for vertices). No threshold filtering — callers
 * (resolveEndpointSnap C, optic-tip A, node G) apply their own preview/attach cuts. */
function nearestSnapPoint(point, exclude, state, eps = 0) {
  if (!isValidPoint(point)) return null;
  const snapshot = state.get();
  let best = null;
  const consider = (x, y, distance, rank, stroke) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!best || distance < best.distance - eps
        || (Math.abs(distance - best.distance) <= eps && rank < best.rank)) {
      best = { x, y, distance, rank, targetStroke: stroke };
    }
  };
  // rank 0: high-priority vertices/endpoints/heads (measured at the head; the
  // written attach point equals the head, so a ray lands on the optical apex).
  for (const t of collectPrioritySnapPoints(state, exclude)) {
    consider(t.attachX ?? t.x, t.attachY ?? t.y, Math.hypot(t.x - point.x, t.y - point.y), 0, undefined);
  }
  // rank 1 (straight edges) + rank 2 (curved surfaces) of every other eligible object.
  for (const obj of snapshot.objects) {
    if (!obj?.id || exclude.has(obj.id) || !isSnapTargetEligible(obj, snapshot)) continue;
    for (const [a, b] of straightEdgesOf(obj)) {
      const q = nearestOnSegment(point, a, b);
      consider(q.x, q.y, Math.hypot(q.x - point.x, q.y - point.y), 1, obj.strokeWidth);
    }
    const c = curvedSurfaceNearest(obj, point);
    if (c) consider(c.x, c.y, Math.hypot(c.x - point.x, c.y - point.y), 2, obj.strokeWidth);
  }
  return best;
}

/* ----- Feature C geometry: nearest point on edges / curved surfaces ----- */

/* Nearest point on segment a→b to p, clamped to the endpoints. */
function nearestOnSegment(p, a, b) {
  if (!isValidPoint(a) || !isValidPoint(b)) return { x: NaN, y: NaN };
  const ex = b.x - a.x, ey = b.y - a.y;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + t * ex, y: a.y + t * ey };
}

/* Straight edges of a snap target, rotation/flip applied (excludes curved types). */
function straightEdgesOf(obj) {
  if (obj.type === "line" || obj.type === "circuit") {
    return isUsableSegment(obj.p1, obj.p2) ? [[obj.p1, obj.p2]] : [];
  }
  if (obj.type === "polyline") {
    const pts = Array.isArray(obj.points) ? obj.points : [];
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i += 1) {
      if (isUsableSegment(pts[i], pts[i + 1])) segs.push([pts[i], pts[i + 1]]);
    }
    if (obj.closed === true && pts.length > 2 && isUsableSegment(pts[pts.length - 1], pts[0])) {
      segs.push([pts[pts.length - 1], pts[0]]); // wrap-around edge
    }
    return segs;
  }
  if (obj.type === "rect" || obj.type === "triangle") {
    const v = polygonVertices(obj); // rotation + flip aware
    return v.map((pt, i) => [pt, v[(i + 1) % v.length]]).filter(([a, b]) => isUsableSegment(a, b));
  }
  return [];
}

/* Nearest point on a curved-surface outline (ellipse / curve), or null. */
function curvedSurfaceNearest(obj, p) {
  if (obj.type === "ellipse") return ellipseOutlineNearest(obj, p);
  if (obj.type === "curve") {
    const samples = curveSamplePoints(obj);
    if (samples.length < 2) return null;
    const closed = obj.closed === true;
    const last = closed ? samples.length : samples.length - 1;
    let best = null;
    for (let i = 0; i < last; i += 1) {
      const q = nearestOnSegment(p, samples[i], samples[(i + 1) % samples.length]);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (Number.isFinite(d) && (!best || d < best.d)) best = { x: q.x, y: q.y, d };
    }
    return best;
  }
  return null;
}

/* Nearest point on an (optionally rotated) ellipse outline. Circle (w==h) is the
 * exact center+radius case; a true ellipse is solved in local unrotated, centered
 * space via a few angle-refinement steps, then transformed back to world. */
function ellipseOutlineNearest(obj, p) {
  const w = Math.abs(obj.w), h = Math.abs(obj.h);
  if (!w || !h) return null;
  const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
  const a = w / 2, b = h / 2;

  if (Math.abs(w - h) <= Math.max(w, h) * CIRCLE_RATIO_EPSILON) {
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy);
    const r = (a + b) / 2;
    if (len === 0) return { x: cx + r, y: cy };
    return { x: cx + (dx / len) * r, y: cy + (dy / len) * r };
  }

  const rot = obj.rotation || 0;
  const inv = -rot * Math.PI / 180;
  const dx = p.x - cx, dy = p.y - cy;
  const ic = Math.cos(inv), is = Math.sin(inv);
  const lx = dx * ic - dy * is;
  const ly = dx * is + dy * ic;

  const px = Math.abs(lx), py = Math.abs(ly);
  let t = Math.PI / 4;
  for (let i = 0; i < 6; i += 1) {
    const ex = a * Math.cos(t), ey = b * Math.sin(t);
    const evx = ((a * a - b * b) * Math.cos(t) ** 3) / a;
    const evy = ((b * b - a * a) * Math.sin(t) ** 3) / b;
    const rx = ex - evx, ry = ey - evy;
    const qx = px - evx, qy = py - evy;
    const rlen = Math.hypot(rx, ry) || 1e-9;
    const qlen = Math.hypot(qx, qy) || 1e-9;
    const denom = Math.sqrt(Math.max(1e-12, a * a + b * b - ex * ex - ey * ey));
    let s = (rx * qy - ry * qx) / (rlen * qlen);
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    t += (rlen * Math.asin(s)) / denom;
    t = t < 0 ? 0 : t > Math.PI / 2 ? Math.PI / 2 : t;
  }
  const sx = a * Math.cos(t) * (lx < 0 ? -1 : 1);
  const sy = b * Math.sin(t) * (ly < 0 ? -1 : 1);

  const fwd = rot * Math.PI / 180;
  const fc = Math.cos(fwd), fs = Math.sin(fwd);
  return { x: cx + sx * fc - sy * fs, y: cy + sx * fs + sy * fc };
}

/* ===== 6c: RADIAL CENTER SNAP =====
 * Boundary point of a circle/ellipse/rect along a unit direction (ux,uy) FROM the
 * object center (rotation-aware). Used to land a line endpoint on the boundary
 * collinear with the center so the line aims radially at the center. */
function boundaryPointInDirection(obj, ux, uy) {
  const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
  const a = Math.abs(obj.w) / 2, b = Math.abs(obj.h) / 2;
  if (!a || !b) return null;
  const rot = (obj.rotation || 0) * Math.PI / 180;
  // direction in the object's local (unrotated) frame
  const ic = Math.cos(-rot), is = Math.sin(-rot);
  const lux = ux * ic - uy * is;
  const luy = ux * is + uy * ic;
  let lx, ly;
  if (obj.type === "ellipse") {
    const denom = Math.hypot(lux / a, luy / b);
    if (denom === 0) return null;
    const t = 1 / denom;
    lx = lux * t; ly = luy * t;
  } else if (obj.type === "rect") {
    // ray from center to rect edge: smallest positive t hitting |x|=a or |y|=b
    const tx = lux !== 0 ? a / Math.abs(lux) : Infinity;
    const ty = luy !== 0 ? b / Math.abs(luy) : Infinity;
    const t = Math.min(tx, ty);
    if (!Number.isFinite(t)) return null;
    lx = lux * t; ly = luy * t;
  } else {
    return null;
  }
  // back to world frame
  const fc = Math.cos(rot), fs = Math.sin(rot);
  return { x: cx + lx * fc - ly * fs, y: cy + lx * fs + ly * fc };
}

/* resolveRadialCenterSnap: with Shift, when a dragged line endpoint is near a
 * circle/ellipse/rect AND the line (from the FIXED other endpoint through the
 * dragged point) is aimed near the object's center within an angular tolerance,
 * snap the dragged endpoint onto the boundary at the point COLLINEAR with the
 * center (near side, facing `other`) so the line becomes radial. Returns
 * { target, attach, preview } or null. */
const RADIAL_ANG_TOL = 14 * Math.PI / 180; // angular tolerance (line vs center)
export function resolveRadialCenterSnap(other, dragged, excludeIds, scale, state) {
  if (!isValidPoint(other) || !isValidPoint(dragged)) return null;
  const safeScale = scale > 0 ? scale : 1;
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const snapshot = state.get();
  const previewDist = PREVIEW_PX / safeScale;
  const ldx = dragged.x - other.x, ldy = dragged.y - other.y;
  const llen = Math.hypot(ldx, ldy);
  if (llen < 1e-6) return null;
  const lux = ldx / llen, luy = ldy / llen;
  let best = null;
  for (const obj of snapshot.objects) {
    if (!obj?.id || exclude.has(obj.id) || !isSnapTargetEligible(obj, snapshot)) continue;
    if (obj.type !== "ellipse" && obj.type !== "rect") continue;
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    // direction from the FIXED other endpoint toward the object center
    const cdx = cx - other.x, cdy = cy - other.y;
    const clen = Math.hypot(cdx, cdy);
    if (clen < 1e-6) continue;
    const cux = cdx / clen, cuy = cdy / clen;
    const dot = Math.max(-1, Math.min(1, lux * cux + luy * cuy));
    if (Math.acos(dot) > RADIAL_ANG_TOL) continue; // line not aimed at center
    // boundary point on the near side (toward `other`) so the segment stops AT the surface
    const boundary = boundaryPointInDirection(obj, other.x - cx, other.y - cy);
    if (!boundary) continue;
    const dist = Math.hypot(boundary.x - dragged.x, boundary.y - dragged.y);
    if (dist > previewDist) continue;
    if (!best || dist < best.dist) best = { point: boundary, dist };
  }
  if (!best) return null;
  return {
    target: best.point,
    attach: best.dist <= ATTACH_PX / safeScale,
    preview: { from: best.point, to: best.point },
  };
}

/* Source endpoints of a moving line-like object (whole-object drag, Case B). */
function lineLikeSourcePoints(obj, dx, dy) {
  if (obj.type === "line" || obj.type === "circuit") {
    if (!isValidPoint(obj.p1) || !isValidPoint(obj.p2)) return [];
    return [{ x: obj.p1.x + dx, y: obj.p1.y + dy }, { x: obj.p2.x + dx, y: obj.p2.y + dy }];
  }
  const pts = Array.isArray(obj.points) ? obj.points : [];
  if (pts.length < 1) return [];
  const first = pts[0], last = pts[pts.length - 1];
  const out = [];
  if (isValidPoint(first)) out.push({ x: first.x + dx, y: first.y + dy });
  if (isValidPoint(last)) out.push({ x: last.x + dx, y: last.y + dy });
  return out;
}

/* Whole-object move: translate the moving object so its closest source endpoint
 * aligns to the closest high-priority target. No rotation/distortion. */
function resolvePriorityMove(moveObjIds, origObjs, raw, scale, state) {
  const movingLineLike = moveObjIds
    .map((id) => origObjs[id])
    .filter((o) => o && LINE_LIKE_TYPES.has(o.type));
  if (!movingLineLike.length) return null;

  const targets = collectPrioritySnapPoints(state, new Set(moveObjIds));
  if (!targets.length) return null;

  const previewDistance = PREVIEW_PX / scale;
  let best = null;
  for (const obj of movingLineLike) {
    for (const src of lineLikeSourcePoints(obj, raw.dx, raw.dy)) {
      const t = nearestPriorityTarget(src.x, src.y, targets, previewDistance, scale);
      if (t && (!best || t.distance < best.distance)) {
        best = { source: src, target: t.point, distance: t.distance };
      }
    }
  }
  if (!best) return null;

  if (best.distance > ATTACH_PX / scale) {
    return {
      dx: raw.dx, dy: raw.dy, rotation: null,
      preview: { from: best.source, to: { x: best.target.x, y: best.target.y } },
    };
  }
  // Snap to the target's attach point (offset INTO an optical head; identical to
  // the head for line endpoints), so a ray landing on an object overlaps its stroke.
  const attach = { x: best.target.attachX ?? best.target.x, y: best.target.attachY ?? best.target.y };
  return {
    dx: raw.dx + (attach.x - best.source.x),
    dy: raw.dy + (attach.y - best.source.y),
    rotation: null,
    preview: { from: attach, to: attach },
  };
}

function isValidPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isUsableSegment(a, b) {
  return isValidPoint(a) && isValidPoint(b) && Math.hypot(b.x - a.x, b.y - a.y) > 0;
}

/* ===== SNAP GEOMETRY: rotation-applied corners and edge midpoints ===== */
function shapeCandidatePoints(obj, dx = 0, dy = 0, rotation = obj.rotation || 0) {
  const x = obj.x + dx, y = obj.y + dy, w = obj.w, h = obj.h;
  const cx = x + w / 2, cy = y + h / 2;
  return [
    rotPt(x, y, cx, cy, rotation),
    rotPt(cx, y, cx, cy, rotation),
    rotPt(x + w, y, cx, cy, rotation),
    rotPt(x + w, cy, cx, cy, rotation),
    rotPt(x + w, y + h, cx, cy, rotation),
    rotPt(cx, y + h, cx, cy, rotation),
    rotPt(x, y + h, cx, cy, rotation),
    rotPt(x, cy, cx, cy, rotation),
  ];
}

function bboxCandidatePoints(box) {
  const { x, y, w, h } = box;
  return [
    { x, y }, { x: x + w / 2, y }, { x: x + w, y },
    { x: x + w, y: y + h / 2 }, { x: x + w, y: y + h },
    { x: x + w / 2, y: y + h }, { x, y: y + h },
    { x, y: y + h / 2 },
  ];
}

/* ===== CIRCLE-TO-EDGE GEOMETRY: rendered finite rect/triangle edges ===== */
function circleGeometry(obj, dx, dy) {
  if (obj?.type !== "ellipse") return null;
  const width = Math.abs(obj.w), height = Math.abs(obj.h);
  const size = Math.max(width, height);
  if (!size || Math.abs(width - height) > size * CIRCLE_RATIO_EPSILON) return null;
  return {
    center: { x: obj.x + obj.w / 2 + dx, y: obj.y + obj.h / 2 + dy },
    radius: (width + height) / 4,
  };
}

function polygonVertices(obj, dx = 0, dy = 0) {
  if (obj.type !== "rect" && obj.type !== "triangle") return [];
  const x = obj.x + dx, y = obj.y + dy, w = obj.w, h = obj.h;
  const cx = x + w / 2, cy = y + h / 2;
  let vertices;
  if (obj.type === "rect") {
    vertices = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  } else if (obj.type === "triangle") {
    const rightX = obj.flipX ? x + w : x;
    const otherX = obj.flipX ? x : x + w;
    const baseY = obj.flipY ? y : y + h;
    const tipY = obj.flipY ? y + h : y;
    vertices = [{ x: rightX, y: baseY }, { x: otherX, y: baseY }, { x: rightX, y: tipY }];
  }
  return vertices.map((point) => rotPt(point.x, point.y, cx, cy, obj.rotation || 0));
}

function targetEdgeSegments(obj) {
  if (obj.type === "line") {
    return isUsableSegment(obj.p1, obj.p2) ? [[obj.p1, obj.p2]] : [];
  }
  if (obj.type === "polyline") {
    const points = Array.isArray(obj.points) ? obj.points : [];
    const segments = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      if (isUsableSegment(points[index], points[index + 1])) {
        segments.push([points[index], points[index + 1]]);
      }
    }
    return segments;
  }
  const rotated = polygonVertices(obj);
  if (!rotated.length) return [];
  return rotated
    .map((point, index) => [point, rotated[(index + 1) % rotated.length]])
    .filter(([a, b]) => isUsableSegment(a, b));
}

function contactCandidateForSegment(movingObj, raw, target, a, b) {
  const edgeX = b.x - a.x, edgeY = b.y - a.y;
  const length = Math.hypot(edgeX, edgeY);
  if (!length) return null;
  const normal = { x: -edgeY / length, y: edgeX / length };

  const circle = circleGeometry(movingObj, raw.dx, raw.dy);
  if (circle) {
    const along = ((circle.center.x - a.x) * edgeX + (circle.center.y - a.y) * edgeY)
      / (length * length);
    if (along < 0 || along > 1) return null;
    const contactPoint = { x: a.x + along * edgeX, y: a.y + along * edgeY };
    const signedDistance = (circle.center.x - a.x) * normal.x
      + (circle.center.y - a.y) * normal.y;
    const correction = (signedDistance < 0 ? -circle.radius : circle.radius) - signedDistance;
    return {
      distance: Math.abs(correction),
      dx: raw.dx + correction * normal.x,
      dy: raw.dy + correction * normal.y,
      target,
      targetPoint: contactPoint,
      contactPoint,
    };
  }

  const vertices = polygonVertices(movingObj, raw.dx, raw.dy);
  if (!vertices.length) return null;
  const signed = vertices.map((point) => (point.x - a.x) * normal.x + (point.y - a.y) * normal.y);
  const min = Math.min(...signed), max = Math.max(...signed);
  const supports = [
    { value: min, correction: -min },
    { value: max, correction: -max },
  ];
  let best = null;
  for (const support of supports) {
    const epsilon = Math.max(1, Math.abs(support.value)) * 1e-9;
    const supportPoints = vertices.filter((point, index) => Math.abs(signed[index] - support.value) <= epsilon);
    const projections = supportPoints.map((point) => (
      ((point.x - a.x) * edgeX + (point.y - a.y) * edgeY) / (length * length)
    ));
    const overlapStart = Math.max(0, Math.min(...projections));
    const overlapEnd = Math.min(1, Math.max(...projections));
    if (overlapStart > overlapEnd) continue;
    const along = (overlapStart + overlapEnd) / 2;
    const contactPoint = { x: a.x + along * edgeX, y: a.y + along * edgeY };
    const candidate = {
      distance: Math.abs(support.correction),
      dx: raw.dx + support.correction * normal.x,
      dy: raw.dy + support.correction * normal.y,
      target,
      targetPoint: contactPoint,
      contactPoint,
    };
    if (!best || candidate.distance < best.distance) best = candidate;
  }
  return best;
}

function closestContactCandidate(moveObjIds, origObjs, raw, state, maxDistance) {
  if (moveObjIds.length !== 1) return null;
  const movingObj = origObjs[moveObjIds[0]];
  if (!movingObj || !SHAPE_TYPES.has(movingObj.type)) return null;

  const moving = new Set(moveObjIds);
  let best = null;
  let bestDistance = maxDistance;
  for (const target of state.get().objects) {
    if (!target?.id || moving.has(target.id) || !EDGE_TARGET_TYPES.has(target.type)) continue;
    if (movingObj.type !== "ellipse" && !LINE_TARGET_TYPES.has(target.type)) continue;
    for (const [a, b] of targetEdgeSegments(target)) {
      const candidate = contactCandidateForSegment(movingObj, raw, target, a, b);
      if (candidate && candidate.distance <= bestDistance) {
        bestDistance = candidate.distance;
        best = candidate;
      }
    }
  }
  return best;
}

function draggedCandidatePoints(moveObjIds, origObjs, dx, dy, scene, rotation = null) {
  const eligible = moveObjIds.map((id) => origObjs[id]).filter((o) => o && SHAPE_TYPES.has(o.type));
  if (!eligible.length) return null;
  if (moveObjIds.length === 1 && eligible.length === 1) {
    return shapeCandidatePoints(eligible[0], dx, dy, rotation ?? (eligible[0].rotation || 0));
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const obj of eligible) {
    const clone = { ...obj, x: obj.x + dx, y: obj.y + dy };
    if (rotation !== null) clone.rotation = rotation;
    const box = singleObjBBox(clone, scene);
    if (!box) continue;
    minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w); maxY = Math.max(maxY, box.y + box.h);
  }
  if (!isFinite(minX)) return null;
  return bboxCandidatePoints({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
}

/* ===== SNAP SEARCH: closest dragged/target candidate pair only ===== */
function closestPair(moveObjIds, draggedPoints, state, maxDistance) {
  const moving = new Set(moveObjIds);
  let best = null;
  let bestDistance = maxDistance;
  for (const target of state.get().objects) {
    if (!target?.id || moving.has(target.id) || !SHAPE_TYPES.has(target.type)) continue;
    const targetPoints = shapeCandidatePoints(target);
    for (let draggedIndex = 0; draggedIndex < draggedPoints.length; draggedIndex += 1) {
      for (const targetPoint of targetPoints) {
        const draggedPoint = draggedPoints[draggedIndex];
        const distance = Math.hypot(targetPoint.x - draggedPoint.x, targetPoint.y - draggedPoint.y);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = { draggedIndex, draggedPoint, targetPoint, target, distance };
        }
      }
    }
  }
  return best;
}

/* ===== Feature A: a MOVING optics object_arrow snaps its ARROWHEAD TIP onto a
 * straight edge / curved surface. The tip is seated `overlap` INTO the target
 * (overlap = 0.5*targetLine.strokeWidth + 1) along the approach normal so light
 * originates exactly at the surface. Whole-object translate; no rotation. */
function resolveOpticTipSnap(moveObjIds, origObjs, raw, scale, state) {
  if (moveObjIds.length !== 1) return null;
  const obj = origObjs[moveObjIds[0]];
  if (!obj || obj.type !== "optics" || obj.kind !== "object_arrow") return null;
  const { head } = opticalObjectHead(obj);
  const tip = { x: head.x + raw.dx, y: head.y + raw.dy };
  const best = nearestSnapPoint(tip, new Set(moveObjIds), state, 0.5 / scale);
  if (!best || best.distance > PREVIEW_PX / scale) return null;
  const surface = { x: best.x, y: best.y };
  if (best.distance > ATTACH_PX / scale) {
    return { dx: raw.dx, dy: raw.dy, rotation: null, preview: { from: surface, to: surface } };
  }
  const overlap = 0.5 * (best.targetStroke ?? 0.2) + 1;
  const ndx = surface.x - tip.x, ndy = surface.y - tip.y;
  const len = Math.hypot(ndx, ndy);
  const attach = len > 0
    ? { x: surface.x + (ndx / len) * overlap, y: surface.y + (ndy / len) * overlap }
    : surface;
  return {
    dx: raw.dx + (attach.x - tip.x),
    dy: raw.dy + (attach.y - tip.y),
    rotation: null,
    preview: { from: surface, to: surface },
  };
}

/* ===== Feature G: a MOVING node (점) snaps its dot CENTER to the nearest point on
 * any straight edge / curved surface (vertex priority). Single point, so this is
 * nearest-point snapping (no tangency, no overlap). Whole-object translate. */
function resolveNodeSnap(moveObjIds, origObjs, raw, scale, state) {
  if (moveObjIds.length !== 1) return null;
  const obj = origObjs[moveObjIds[0]];
  if (!obj || obj.type !== "optics" || obj.kind !== "node") return null;
  const center = { x: obj.x + obj.w / 2 + raw.dx, y: obj.y + obj.h / 2 + raw.dy };
  const best = nearestSnapPoint(center, new Set(moveObjIds), state, 0.5 / scale);
  if (!best || best.distance > PREVIEW_PX / scale) return null;
  const surface = { x: best.x, y: best.y };
  if (best.distance > ATTACH_PX / scale) {
    return { dx: raw.dx, dy: raw.dy, rotation: null, preview: { from: surface, to: surface } };
  }
  return {
    dx: raw.dx + (surface.x - center.x),
    dy: raw.dy + (surface.y - center.y),
    rotation: null,
    preview: { from: surface, to: surface },
  };
}

/* ===== Feature D: a MOVING line snaps TANGENT to a circle/ellipse/curve by
 * TRANSLATING the whole line perpendicular to itself (both endpoints move equally,
 * angle preserved) until it rests against the curve on the near side. The contact
 * (tangent) point is the red dot. ===== */

/* Tangent translation of a line (unit normal n) to an ellipse, solved in the
 * ellipse's local (unrotated, centered) frame via the support distance. Returns
 * { shift, distance, contact } where shift is the signed move along n. */
function ellipseTangent(obj, p1, nx, ny) {
  const w = Math.abs(obj.w), h = Math.abs(obj.h);
  if (!w || !h) return null;
  const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
  const a = w / 2, b = h / 2;
  const rot = (obj.rotation || 0) * Math.PI / 180;
  const c = Math.cos(rot), s = Math.sin(rot);
  // world normal → local frame (rotate by -rot)
  const lnx = nx * c + ny * s;
  const lny = -nx * s + ny * c;
  const R = Math.hypot(a * lnx, b * lny); // support distance of unit normal
  if (R === 0) return null;
  const sdist = (cx - p1.x) * nx + (cy - p1.y) * ny; // signed center→line distance (world)
  const sign = sdist >= 0 ? 1 : -1;
  const shift = sdist - sign * R;
  // tangent point in local frame (support point on the sign side) → world
  const lxc = (sign * a * a * lnx) / R, lyc = (sign * b * b * lny) / R;
  const contact = { x: cx + lxc * c - lyc * s, y: cy + lxc * s + lyc * c };
  return { shift, distance: Math.abs(shift), contact };
}

/* Tangent translation of a line to a curve, approximated on its hit-test polygon:
 * rest the line against the extreme sample point on the near side. */
function curveTangent(obj, p1, nx, ny) {
  const pts = curveSamplePoints(obj);
  if (!Array.isArray(pts) || pts.length < 2) return null;
  let minE = Infinity, maxE = -Infinity, minPt = null, maxPt = null;
  for (const pt of pts) {
    if (!isValidPoint(pt)) continue;
    const e = (pt.x - p1.x) * nx + (pt.y - p1.y) * ny;
    if (e < minE) { minE = e; minPt = pt; }
    if (e > maxE) { maxE = e; maxPt = pt; }
  }
  if (!minPt || !maxPt) return null;
  return Math.abs(minE) <= Math.abs(maxE)
    ? { shift: minE, distance: Math.abs(minE), contact: { x: minPt.x, y: minPt.y } }
    : { shift: maxE, distance: Math.abs(maxE), contact: { x: maxPt.x, y: maxPt.y } };
}

function resolveLineTangentSnap(moveObjIds, origObjs, raw, scale, state) {
  if (moveObjIds.length !== 1) return null;
  const obj = origObjs[moveObjIds[0]];
  if (!obj || (obj.type !== "line" && obj.type !== "circuit")) return null;
  if (!isValidPoint(obj.p1) || !isValidPoint(obj.p2)) return null;
  const p1 = { x: obj.p1.x + raw.dx, y: obj.p1.y + raw.dy };
  const p2 = { x: obj.p2.x + raw.dx, y: obj.p2.y + raw.dy };
  const dirx = p2.x - p1.x, diry = p2.y - p1.y;
  const L = Math.hypot(dirx, diry);
  if (L === 0) return null;
  const ux = dirx / L, uy = diry / L;       // unit direction
  const nx = -uy, ny = ux;                   // unit normal
  // contact must lie within the segment span (translation along n leaves it fixed)
  const within = (pt) => {
    const along = (pt.x - p1.x) * ux + (pt.y - p1.y) * uy;
    return along >= 0 && along <= L;
  };
  const snapshot = state.get();
  const exclude = new Set(moveObjIds);
  const previewDist = PREVIEW_PX / scale;
  let best = null;
  for (const t of snapshot.objects) {
    if (!t?.id || exclude.has(t.id) || !isSnapTargetEligible(t, snapshot)) continue;
    let cand = null;
    if (t.type === "ellipse") cand = ellipseTangent(t, p1, nx, ny);
    else if (t.type === "curve") cand = curveTangent(t, p1, nx, ny);
    if (!cand || !within(cand.contact)) continue;
    if (cand.distance <= previewDist && (!best || cand.distance < best.distance)) best = cand;
  }
  if (!best) return null;
  const preview = { from: best.contact, to: best.contact };
  if (best.distance > ATTACH_PX / scale) return { dx: raw.dx, dy: raw.dy, rotation: null, preview };
  return { dx: raw.dx + nx * best.shift, dy: raw.dy + ny * best.shift, rotation: null, preview };
}

/* ===== SNAP RESOLVER: raw, preview-only, or magnetic attach =====
 * Returns { dx, dy, preview, rotation }. rotation is null unless attached.
 */
export function resolveSnap(moveObjIds, origObjs, raw, mods, zoom, state, scene) {
  const unsnapped = { dx: raw.dx, dy: raw.dy, preview: null, rotation: null };
  if (!mods?.shift || !moveObjIds?.length) return unsnapped;

  const scale = zoom > 0 ? zoom : 1;

  /* Priority 1+2: line-like endpoints and the optical object head win first. */
  const priority = resolvePriorityMove(moveObjIds, origObjs, raw, scale, state);
  if (priority) return priority;

  /* Feature A/G/D: optics-tip, node-center, and line-tangent move snaps. Each is
   * type-specific and mutually exclusive, so order is incidental. */
  const opticTip = resolveOpticTipSnap(moveObjIds, origObjs, raw, scale, state);
  if (opticTip) return opticTip;
  const nodeSnap = resolveNodeSnap(moveObjIds, origObjs, raw, scale, state);
  if (nodeSnap) return nodeSnap;
  const lineTangent = resolveLineTangentSnap(moveObjIds, origObjs, raw, scale, state);
  if (lineTangent) return lineTangent;

  const draggedPoints = draggedCandidatePoints(moveObjIds, origObjs, raw.dx, raw.dy, scene);
  if (!draggedPoints) return unsnapped;

  const previewDistance = PREVIEW_PX / scale;
  const pair = closestPair(moveObjIds, draggedPoints, state, previewDistance);
  const tangent = closestContactCandidate(moveObjIds, origObjs, raw, state, previewDistance);
  const validPair = pair && pair.target && !moveObjIds.includes(pair.target.id)
    && isValidPoint(pair.draggedPoint) && isValidPoint(pair.targetPoint);
  const validTangent = tangent && tangent.target && !moveObjIds.includes(tangent.target.id)
    && isValidPoint(tangent.targetPoint) && isValidPoint(tangent.contactPoint);
  const preferTangent = validTangent
    && (!validPair || tangent.distance <= pair.distance + 1 / scale);
  if (preferTangent) {
    const preview = { from: tangent.contactPoint, to: tangent.contactPoint };
    if (tangent.distance > ATTACH_PX / scale) return { ...unsnapped, preview };
    return { dx: tangent.dx, dy: tangent.dy, preview, rotation: null };
  }
  if (!validPair) return unsnapped;

  const preview = { from: pair.draggedPoint, to: pair.targetPoint };
  if (pair.distance > ATTACH_PX / scale) return { ...unsnapped, preview };

  const rotation = pair.target.rotation || 0;
  const rotatedPoints = draggedCandidatePoints(
    moveObjIds, origObjs, raw.dx, raw.dy, scene, rotation,
  );
  const attachPoint = rotatedPoints?.[pair.draggedIndex];
  if (!isValidPoint(attachPoint)) return unsnapped;

  return {
    dx: raw.dx + pair.targetPoint.x - attachPoint.x,
    dy: raw.dy + pair.targetPoint.y - attachPoint.y,
    preview,
    rotation,
  };
}
