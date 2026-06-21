/* ===== SNAP: Shift-only body-move magnet and preview =====
 *
 * transform.js calls resolveSnap() once per body-move mousemove, before
 * applyDelta(). Distances are measured in world units after converting the
 * 40/80 screen-pixel thresholds through the current render scale.
 *
 * Only rect, ellipse, and triangle participate. Their four corners and four
 * edge midpoints are rotated into world coordinates with render.js rotPt().
 * A multi-selection contributes one combined rotation-applied bbox.
 */

import { rotPt, singleObjBBox } from "./render.js?v=0.33.0";

const ATTACH_PX = 40;
const PREVIEW_PX = 80;
const SHAPE_TYPES = new Set(["rect", "ellipse", "triangle"]);

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
    if (moving.has(target.id) || !SHAPE_TYPES.has(target.type)) continue;
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

  const pair = closestPair(moveObjIds, draggedPoints, state, PREVIEW_PX / scale);
  if (!pair) return unsnapped;

  const preview = { from: pair.draggedPoint, to: pair.targetPoint };
  if (pair.distance > ATTACH_PX / scale) return { ...unsnapped, preview };

  const rotation = pair.target.rotation || 0;
  const rotatedPoints = draggedCandidatePoints(
    moveObjIds, origObjs, raw.dx, raw.dy, scene, rotation,
  );
  const attachPoint = rotatedPoints?.[pair.draggedIndex];
  if (!attachPoint) return { ...unsnapped, preview };

  return {
    dx: raw.dx + pair.targetPoint.x - attachPoint.x,
    dy: raw.dy + pair.targetPoint.y - attachPoint.y,
    preview,
    rotation,
  };
}
