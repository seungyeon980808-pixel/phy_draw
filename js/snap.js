/* ===== SNAP: Shift-only body-move magnet and preview =====
 *
 * transform.js calls resolveSnap() once per body-move mousemove, before
 * applyDelta(). Distances are measured in world units after converting the
 * 40/80 screen-pixel thresholds through the current render scale.
 *
 * Rect, ellipse, and triangle participate as moving objects. Rect, triangle,
 * line, and polyline objects also contribute finite contact edges.
 */

import { rotPt, singleObjBBox } from "./render.js?v=0.14.0";

const ATTACH_PX = 40;
const PREVIEW_PX = 80;
const SHAPE_TYPES = new Set(["rect", "ellipse", "triangle"]);
const EDGE_TARGET_TYPES = new Set(["rect", "triangle", "line", "polyline"]);
const LINE_TARGET_TYPES = new Set(["line", "polyline"]);
const CIRCLE_RATIO_EPSILON = 1e-3;

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
