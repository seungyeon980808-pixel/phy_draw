/* ===== SNAP: Shift-only body-move magnet and preview =====
 *
 * transform.js calls resolveSnap() once per body-move mousemove, before
 * applyDelta(). Distances are measured in world units after converting the
 * 40/80 screen-pixel thresholds through the current render scale.
 *
 * Rect, ellipse, and triangle participate as moving objects. Rect, triangle,
 * line, and polyline objects also contribute finite contact edges.
 */

import { rotPt, singleObjBBox } from "./render.js?v=0.17.10";

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
  return !!layer && layer.visible !== false && layerId === snapshot.activeLayerId;
}

/* Optical object head = top-center tip of the up-arrow, rotation applied about the
 * box center (mirrors renderOptics object_arrow + the rotate() transform). */
function opticalObjectHead(obj) {
  const cx = obj.x + obj.w / 2;
  const head = { x: cx, y: obj.y };
  const rot = obj.rotation || 0;
  return rot ? rotPt(head.x, head.y, cx, obj.y + obj.h / 2, rot) : head;
}

function makeSnapPoint(p, type, objectId, pointKey, priority) {
  return { x: p.x, y: p.y, type, objectId, pointKey, priority };
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
      points.push(makeSnapPoint(opticalObjectHead(obj), "optical-object-head", obj.id, "head", 1));
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

/* resolveEndpointSnap: for a dragged line-like endpoint handle (Case A). Returns
 * { target, attach, preview } or null. Caller writes target onto the endpoint when
 * attach is true; otherwise only the preview overlay is shown. */
export function resolveEndpointSnap(point, excludeIds, scale, state) {
  if (!isValidPoint(point)) return null;
  const safeScale = scale > 0 ? scale : 1;
  const targets = collectPrioritySnapPoints(state, excludeIds);
  if (!targets.length) return null;
  const best = nearestPriorityTarget(point.x, point.y, targets, PREVIEW_PX / safeScale, safeScale);
  if (!best) return null;
  const target = { x: best.point.x, y: best.point.y };
  const attach = best.distance <= ATTACH_PX / safeScale;
  return {
    target,
    attach,
    preview: attach
      ? { from: target, to: target }
      : { from: { x: point.x, y: point.y }, to: target },
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
  const attach = { x: best.target.x, y: best.target.y };
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
