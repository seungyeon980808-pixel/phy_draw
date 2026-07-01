/* ===== IMAGE OBJECTIFY (local image -> editable line rough draft) ===== */

import { applyNewObjectStyleDefaults } from "./style-mode.js?v=0.36.3";

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_PROCESS_DIMENSION = 1600;
const MAX_LINES = 12;
let idCounter = 0;
const OBJECTIFY_STROKE_WIDTH = 0.2;

function cloneObjects(objects) {
  return JSON.parse(JSON.stringify(objects));
}

function buildDarkMask(canvas, threshold) {
  const { width, height } = canvas;
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const dark = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
    dark[p] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) < threshold ? 1 : 0;
  }
  return dark;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function convexHull(points) {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 3) return sorted;
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function pointLineDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / Math.hypot(dx, dy);
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function simplifyPolyline(points, tolerance) {
  if (points.length <= 3) return points;
  let farthest = 0, index = -1;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = pointLineDistance(points[i], points[0], points.at(-1));
    if (distance > farthest) { farthest = distance; index = i; }
  }
  if (farthest <= tolerance) return [points[0], points.at(-1)];
  const left = simplifyPolyline(points.slice(0, index + 1), tolerance);
  const right = simplifyPolyline(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    area += points[i].x * next.y - next.x * points[i].y;
  }
  return Math.abs(area) / 2;
}

function detectOuterFrame(dark, width, height, minLength) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let index = 0; index < dark.length; index += 1) {
    if (!dark[index]) continue;
    const x = index % width, y = (index / width) | 0;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const w = maxX - minX + 1, h = maxY - minY + 1;
  if (maxX < 0 || w < minLength || h < minLength) return null;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.012));
  let top = 0, bottom = 0, left = 0, right = 0;
  for (let x = minX; x <= maxX; x += 1) {
    for (let d = 0; d <= band; d += 1) {
      if (dark[(minY + d) * width + x]) { top += 1; break; }
    }
    for (let d = 0; d <= band; d += 1) {
      if (dark[(maxY - d) * width + x]) { bottom += 1; break; }
    }
  }
  for (let y = minY; y <= maxY; y += 1) {
    for (let d = 0; d <= band; d += 1) {
      if (dark[y * width + minX + d]) { left += 1; break; }
    }
    for (let d = 0; d <= band; d += 1) {
      if (dark[y * width + maxX - d]) { right += 1; break; }
    }
  }
  if (Math.min(top / w, bottom / w, left / h, right / h) < 0.65) return null;
  return { type: "rect", x: minX, y: minY, w, h, area: w * h };
}

function consolidateFragmentedEllipse(shapes, dark, width, height) {
  const fragments = shapes.filter((shape) => shape.type === "polyline");
  if (fragments.length < 3) return shapes;
  const minX = Math.min(...fragments.map((shape) => shape.x));
  const minY = Math.min(...fragments.map((shape) => shape.y));
  const maxX = Math.max(...fragments.map((shape) => shape.x + shape.w - 1));
  const maxY = Math.max(...fragments.map((shape) => shape.y + shape.h - 1));
  const w = maxX - minX + 1, h = maxY - minY + 1;
  if (w < 12 || h < 12) return shapes;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rx = w / 2, ry = h / 2;
  const band = Math.max(3, Math.round(Math.min(w, h) * 0.035));
  let supported = 0;
  const samples = 96;
  for (let i = 0; i < samples; i += 1) {
    const angle = i * Math.PI * 2 / samples;
    const x = Math.round(cx + rx * Math.cos(angle));
    const y = Math.round(cy + ry * Math.sin(angle));
    let hit = false;
    for (let dy = -band; dy <= band && !hit; dy += 1) {
      for (let dx = -band; dx <= band; dx += 1) {
        const sx = x + dx, sy = y + dy;
        if (sx >= 0 && sx < width && sy >= 0 && sy < height && dark[sy * width + sx]) {
          hit = true;
          break;
        }
      }
    }
    if (hit) supported += 1;
  }
  if (supported / samples < 0.68) return shapes;
  const fragmentSet = new Set(fragments);
  return shapes.filter((shape) => !fragmentSet.has(shape)).concat({
    type: "ellipse", x: minX, y: minY, w, h,
    area: fragments.reduce((sum, shape) => sum + shape.area, 0),
  });
}

function detectClosedShapes(dark, width, height, minLength) {
  const labels = new Uint32Array(width * height);
  const queue = new Int32Array(width * height);
  const shapes = [];
  const minimumSize = Math.max(12, minLength * 0.6);
  let componentId = 0;

  for (let start = 0; start < dark.length; start += 1) {
    if (dark[start] || labels[start]) continue;
    componentId += 1;
    let head = 0, tail = 0;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    let touchesEdge = false;
    const boundary = [];
    labels[start] = componentId;
    queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width, y = (index / width) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
          dark[index - 1] || dark[index + 1] || dark[index - width] || dark[index + width]) {
        boundary.push({ x, y });
      }
      if (x > 0 && !dark[index - 1] && !labels[index - 1]) {
        labels[index - 1] = componentId; queue[tail++] = index - 1;
      }
      if (x < width - 1 && !dark[index + 1] && !labels[index + 1]) {
        labels[index + 1] = componentId; queue[tail++] = index + 1;
      }
      if (y > 0 && !dark[index - width] && !labels[index - width]) {
        labels[index - width] = componentId; queue[tail++] = index - width;
      }
      if (y < height - 1 && !dark[index + width] && !labels[index + width]) {
        labels[index + width] = componentId; queue[tail++] = index + width;
      }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (touchesEdge || w < minimumSize || h < minimumSize || tail < minimumSize * minimumSize * 0.35) continue;

    const fillRatio = tail / (w * h);
    let type = null;
    if (fillRatio >= 0.86) {
      type = "rect";
    } else if (fillRatio >= 0.68 && fillRatio <= 0.86) {
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const rx = w / 2, ry = h / 2;
      let expected = 0, mismatch = 0;
      const step = Math.max(1, Math.ceil(Math.max(w, h) / 160));
      for (let y = minY; y <= maxY; y += step) {
        for (let x = minX; x <= maxX; x += step) {
          const insideEllipse = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
          const insideRegion = labels[y * width + x] === componentId;
          if (insideEllipse) expected += 1;
          if (insideEllipse !== insideRegion) mismatch += 1;
        }
      }
      if (expected && mismatch / expected <= 0.18) type = "ellipse";
    }
    if (type) {
      shapes.push({ type, x: minX, y: minY, w, h, area: tail });
      continue;
    }

    // A large, compact non-elliptic enclosure is one editable polygon, not a
    // collection of line fragments. The hull intentionally drops raster noise.
    if (fillRatio >= 0.32 && boundary.length >= 3) {
      const hull = convexHull(boundary);
      const hullArea = polygonArea(hull);
      const solidity = hullArea ? tail / hullArea : 0;
      const tolerance = Math.max(2, Math.min(w, h) * 0.025);
      const simplified = simplifyPolyline(hull.concat(hull[0]), tolerance).slice(0, -1);
      if (solidity >= 0.82 && simplified.length >= 3 && simplified.length <= 16) {
        shapes.push({ type: "polyline", points: simplified, x: minX, y: minY, w, h, area: tail });
      }
    }
  }
  return shapes.sort((a, b) => b.area - a.area).slice(0, 16);
}

function maskShapes(dark, width, height, shapes) {
  const masked = dark.slice();
  for (const shape of shapes) {
    const padding = Math.max(3, Math.round(Math.min(shape.w, shape.h) * 0.04));
    const left = Math.max(0, shape.x - padding), top = Math.max(0, shape.y - padding);
    const right = Math.min(width - 1, shape.x + shape.w - 1 + padding);
    const bottom = Math.min(height - 1, shape.y + shape.h - 1 + padding);
    if (shape.type === "rect" || shape.type === "polyline") {
      if (shape.type === "polyline") {
        const edges = shape.points.map((point, index) => [point, shape.points[(index + 1) % shape.points.length]]);
        for (let y = top; y <= bottom; y += 1) {
          for (let x = left; x <= right; x += 1) {
            if (edges.some(([a, b]) => pointSegmentDistance({ x, y }, a, b) <= padding)) {
              masked[y * width + x] = 0;
            }
          }
        }
        continue;
      }
      for (let y = top; y <= bottom; y += 1) {
        if (y <= shape.y + padding || y >= shape.y + shape.h - 1 - padding) {
          masked.fill(0, y * width + left, y * width + right + 1);
        } else {
          masked.fill(0, y * width + left, y * width + Math.min(right + 1, shape.x + padding + 1));
          masked.fill(0, y * width + Math.max(left, shape.x + shape.w - 1 - padding), y * width + right + 1);
        }
      }
    } else {
      const cx = shape.x + (shape.w - 1) / 2, cy = shape.y + (shape.h - 1) / 2;
      const rx = Math.max(1, shape.w / 2), ry = Math.max(1, shape.h / 2);
      const band = padding / Math.min(rx, ry);
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          const radius = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
          if (Math.abs(radius - 1) <= band) masked[y * width + x] = 0;
        }
      }
    }
  }
  return masked;
}

function mergeLineSegments(segments, minLength) {
  const normalized = segments.map((line) => {
    const rawAngle = Math.atan2(line.y2 - line.y1, line.x2 - line.x1);
    const angle = (rawAngle + Math.PI) % Math.PI;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const offset = -uy * line.x1 + ux * line.y1;
    const a = ux * line.x1 + uy * line.y1, b = ux * line.x2 + uy * line.y2;
    return { ...line, angle, ux, uy, offset, start: Math.min(a, b), end: Math.max(a, b) };
  }).sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const merged = [];
  const angleTolerance = 12 * Math.PI / 180;
  const maxGap = Math.max(20, minLength);
  for (const line of normalized) {
    let target = null;
    let projectedStart = 0, projectedEnd = 0;
    for (const other of merged) {
      let angleDistance = Math.abs(other.angle - line.angle) % Math.PI;
      angleDistance = Math.min(angleDistance, Math.PI - angleDistance);
      if (angleDistance > angleTolerance) continue;
      const midX = (line.x1 + line.x2) / 2, midY = (line.y1 + line.y2) / 2;
      if (Math.abs(-other.uy * midX + other.ux * midY - other.offset) > Math.max(10, minLength * 0.12)) continue;
      const a = other.ux * line.x1 + other.uy * line.y1;
      const b = other.ux * line.x2 + other.uy * line.y2;
      const start = Math.min(a, b), end = Math.max(a, b);
      if (start > other.end + maxGap || end < other.start - maxGap) continue;
      target = other;
      projectedStart = start;
      projectedEnd = end;
      break;
    }
    if (!target) {
      merged.push({ ...line });
      continue;
    }
    target.start = Math.min(target.start, projectedStart);
    target.end = Math.max(target.end, projectedEnd);
  }
  return merged.map((line) => ({
    x1: line.ux * line.start - line.uy * line.offset,
    y1: line.uy * line.start + line.ux * line.offset,
    x2: line.ux * line.end - line.uy * line.offset,
    y2: line.uy * line.end + line.ux * line.offset,
    votes: line.votes || 0,
  })).filter((line) => Math.hypot(line.x2 - line.x1, line.y2 - line.y1) >= minLength);
}

function detectLineSegments(dark, width, height, minLength) {

  const edges = [];
  const sampleStep = Math.max(1, Math.ceil(Math.sqrt((width * height) / 250000)));
  for (let y = 1; y < height - 1; y += sampleStep) {
    for (let x = 1; x < width - 1; x += sampleStep) {
      const p = y * width + x;
      if (!dark[p]) continue;
      if (!dark[p - 1] || !dark[p + 1] || !dark[p - width] || !dark[p + width]) edges.push({ x, y });
    }
  }
  if (edges.length < 2) return [];

  const thetaCount = 90;
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoCount = diagonal * 2 + 1;
  const accumulator = new Uint32Array(thetaCount * rhoCount);
  const trig = Array.from({ length: thetaCount }, (_, i) => {
    const angle = i * 2 * Math.PI / 180;
    return { cos: Math.cos(angle), sin: Math.sin(angle) };
  });
  const pointStride = Math.max(1, Math.ceil(edges.length / 20000));
  for (let p = 0; p < edges.length; p += pointStride) {
    const point = edges[p];
    for (let t = 0; t < thetaCount; t += 1) {
      const rho = Math.round(point.x * trig[t].cos + point.y * trig[t].sin) + diagonal;
      accumulator[t * rhoCount + rho] += 1;
    }
  }

  const voteFloor = Math.max(20, Math.round(minLength / Math.max(1, sampleStep * 1.5)));
  const peaks = [];
  for (let t = 0; t < thetaCount; t += 1) {
    for (let rho = 0; rho < rhoCount; rho += 1) {
      const votes = accumulator[t * rhoCount + rho];
      if (votes >= voteFloor) peaks.push({ t, rho: rho - diagonal, votes });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);

  const accepted = [];
  for (const peak of peaks) {
    if (accepted.length >= 60) break;
    if (accepted.some((other) => {
      const thetaDistance = Math.abs(other.t - peak.t);
      if (thetaDistance <= 8) return Math.abs(other.rho - peak.rho) <= 14;
      return thetaDistance >= thetaCount - 8 && Math.abs(other.rho + peak.rho) <= 14;
    })) continue;
    const { cos, sin } = trig[peak.t];
    const alongX = -sin, alongY = cos;
    const projected = [];
    for (const point of edges) {
      if (Math.abs(point.x * cos + point.y * sin - peak.rho) <= Math.max(2, sampleStep * 1.5)) {
        projected.push(point.x * alongX + point.y * alongY);
      }
    }
    projected.sort((a, b) => a - b);
    if (projected.length < 2) continue;
    const maxGap = Math.max(6, minLength * 0.2);
    let runStart = projected[0];
    for (let i = 1; i <= projected.length; i += 1) {
      if (i < projected.length && projected[i] - projected[i - 1] <= maxGap) continue;
      const runEnd = projected[i - 1];
      if (runEnd - runStart >= minLength) {
        accepted.push({
          t: peak.t, rho: peak.rho,
          votes: peak.votes,
          x1: cos * peak.rho + alongX * runStart,
          y1: sin * peak.rho + alongY * runStart,
          x2: cos * peak.rho + alongX * runEnd,
          y2: sin * peak.rho + alongY * runEnd,
        });
        if (accepted.length >= 60) break;
      }
      if (i < projected.length) runStart = projected[i];
    }
  }
  return mergeLineSegments(accepted, minLength);
}

function detectObjects(canvas, threshold, minLength) {
  const { width, height } = canvas;
  const effectiveMinLength = Math.max(minLength, Math.hypot(width, height) * 0.045);
  const dark = buildDarkMask(canvas, threshold);
  const outerFrame = detectOuterFrame(dark, width, height, effectiveMinLength);
  let shapes = detectClosedShapes(dark, width, height, effectiveMinLength);
  if (outerFrame) {
    const edgeTolerance = Math.max(5, Math.min(outerFrame.w, outerFrame.h) * 0.04);
    shapes = shapes.filter((shape) => {
      const sameFrame = Math.abs(shape.x - outerFrame.x) <= edgeTolerance &&
        Math.abs(shape.y - outerFrame.y) <= edgeTolerance &&
        Math.abs(shape.x + shape.w - outerFrame.x - outerFrame.w) <= edgeTolerance &&
        Math.abs(shape.y + shape.h - outerFrame.y - outerFrame.h) <= edgeTolerance;
      if (sameFrame) return false;
      if (shape.type !== "polyline") return true;
      const touchesFrame = shape.x - outerFrame.x <= edgeTolerance ||
        shape.y - outerFrame.y <= edgeTolerance ||
        outerFrame.x + outerFrame.w - shape.x - shape.w <= edgeTolerance ||
        outerFrame.y + outerFrame.h - shape.y - shape.h <= edgeTolerance;
      return !touchesFrame;
    });
    shapes.unshift(outerFrame);
  }
  shapes = consolidateFragmentedEllipse(shapes, dark, width, height);
  const segments = detectLineSegments(maskShapes(dark, width, height, shapes), width, height, effectiveMinLength)
    .sort((a, b) => {
      const scoreA = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) * (1 + Math.log1p(a.votes));
      const scoreB = Math.hypot(b.x2 - b.x1, b.y2 - b.y1) * (1 + Math.log1p(b.votes));
      return scoreB - scoreA;
    })
    .slice(0, MAX_LINES);
  return { shapes, segments };
}

function buildModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal modal-objectify" role="dialog" aria-modal="true" aria-labelledby="objectify-title">
      <h2 class="modal-title" id="objectify-title">이미지 객체화</h2>
      <p class="objectify-description">흑백 선 그림에서 직선 후보를 찾아 편집 가능한 초안으로 만듭니다. 완벽한 복원이 아닌 따라 그리기용 결과입니다.</p>
      <input id="objectify-file" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden />
      <div id="objectify-dropzone" class="objectify-dropzone" role="button" tabindex="0">PNG/JPG/WEBP 파일 선택, 끌어 놓기 또는 Ctrl+V 붙여넣기</div>
      <canvas id="objectify-preview" class="objectify-preview" width="560" height="240" hidden></canvas>
      <div class="objectify-controls">
        <label class="modal-field">
          <span class="modal-label">임계값</span>
          <span class="objectify-range-row"><input id="objectify-threshold" type="range" min="0" max="255" value="180" /><output class="objectify-range-value">180</output></span>
        </label>
        <label class="modal-field">
          <span class="modal-label">최소 선 길이 (px)</span>
          <input id="objectify-min-length" class="modal-input" type="number" min="20" max="1000" step="1" value="60" />
        </label>
      </div>
      <label class="modal-field modal-field-row"><input id="objectify-reference" type="checkbox" checked /><span class="modal-label">원본 이미지를 반투명 배경으로 함께 삽입</span></label>
      <p id="objectify-status" class="objectify-status" role="status">이미지를 선택하세요.</p>
      <div class="modal-actions">
        <button id="objectify-cancel" type="button" class="modal-btn">취소</button>
        <button id="objectify-extract" type="button" class="modal-btn" disabled>도형 추출</button>
        <button id="objectify-insert" type="button" class="modal-btn modal-btn-primary" disabled>객체로 삽입</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

export function initImageObjectify(state) {
  const openButton = document.getElementById("image-objectify-open");
  if (!openButton) return;

  const overlay = buildModal();
  const fileInput = overlay.querySelector("#objectify-file");
  const dropzone = overlay.querySelector("#objectify-dropzone");
  const preview = overlay.querySelector("#objectify-preview");
  const threshold = overlay.querySelector("#objectify-threshold");
  const thresholdOutput = overlay.querySelector(".objectify-range-value");
  const minLength = overlay.querySelector("#objectify-min-length");
  const reference = overlay.querySelector("#objectify-reference");
  const status = overlay.querySelector("#objectify-status");
  const extractButton = overlay.querySelector("#objectify-extract");
  const insertButton = overlay.querySelector("#objectify-insert");
  let sourceCanvas = null;
  let sourceDataUrl = null;
  let segments = [];
  let shapes = [];

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  };
  const invalidate = () => {
    segments = [];
    shapes = [];
    insertButton.disabled = true;
  };
  const close = () => { overlay.hidden = true; };

  function drawPreview(showSegments = false) {
    if (!sourceCanvas) return;
    const ctx = preview.getContext("2d");
    preview.width = sourceCanvas.width;
    preview.height = sourceCanvas.height;
    ctx.drawImage(sourceCanvas, 0, 0);
    if (showSegments) {
      ctx.strokeStyle = "#e53935";
      ctx.lineWidth = Math.max(1, sourceCanvas.width / 700);
      for (const shape of shapes) {
        ctx.beginPath();
        if (shape.type === "rect") ctx.rect(shape.x, shape.y, shape.w, shape.h);
        else if (shape.type === "ellipse") ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, shape.w / 2, shape.h / 2, 0, 0, Math.PI * 2);
        else {
          ctx.moveTo(shape.points[0].x, shape.points[0].y);
          for (const point of shape.points.slice(1)) ctx.lineTo(point.x, point.y);
          ctx.closePath();
        }
        ctx.stroke();
      }
      for (const line of segments) {
        ctx.beginPath();
        ctx.moveTo(line.x1, line.y1);
        ctx.lineTo(line.x2, line.y2);
        ctx.stroke();
      }
    }
    preview.hidden = false;
  }

  function loadFile(file) {
    if (!file || !ACCEPTED_TYPES.has(file.type)) {
      setStatus("PNG, JPG, JPEG 또는 브라우저가 지원하는 WEBP 파일을 선택해 주세요.", true);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setStatus("이미지 파일을 읽지 못했습니다.", true);
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => setStatus("브라우저가 이 이미지 파일을 디코딩하지 못했습니다.", true);
      image.onload = () => {
        const scale = Math.min(1, MAX_PROCESS_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
        sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        sourceCanvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        sourceCanvas.getContext("2d").drawImage(image, 0, 0, sourceCanvas.width, sourceCanvas.height);
        sourceDataUrl = reader.result;
        invalidate();
        drawPreview();
        extractButton.disabled = false;
        setStatus("이미지가 준비되었습니다. 도형 추출을 실행하세요.");
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function extract() {
    if (!sourceCanvas) return;
    extractButton.disabled = true;
    setStatus("직선 후보를 찾는 중입니다...");
    try {
      const minimum = Math.max(20, Number(minLength.value) || 60);
      ({ shapes, segments } = detectObjects(sourceCanvas, Number(threshold.value), minimum));
      drawPreview(true);
      insertButton.disabled = shapes.length + segments.length === 0;
      setStatus(shapes.length + segments.length ? `도형 ${shapes.length}개, 직선 ${segments.length}개를 찾았습니다.` : "조건에 맞는 도형을 찾지 못했습니다. 설정을 조정해 보세요.", shapes.length + segments.length === 0);
    } catch (error) {
      invalidate();
      setStatus(`추출 중 오류가 발생했습니다: ${error.message || error}`, true);
    } finally { extractButton.disabled = false; }
  }

  function insertObjects() {
    if (!sourceCanvas || shapes.length + segments.length === 0) return;
    const artboard = state.get().artboard;
    const scale = Math.min((artboard.w * 0.9) / sourceCanvas.width, (artboard.h * 0.9) / sourceCanvas.height);
    const fitted = {
      w: sourceCanvas.width * scale,
      h: sourceCanvas.height * scale,
    };
    fitted.x = -fitted.w / 2;
    fitted.y = -fitted.h / 2;
    const stamp = Date.now().toString(36);

    state.update((s) => {
      const snapshot = cloneObjects(s.objects);
      const layerId = s.activeLayerId;
      const addedIds = [];
      if (reference.checked) {
        s.objects.push(applyNewObjectStyleDefaults({
          id: `obj_${stamp}_ref${++idCounter}`,
          type: "image", src: sourceDataUrl,
          x: fitted.x, y: fitted.y, w: fitted.w, h: fitted.h,
          opacity: 0.28, rotation: 0, locked: true, positionLocked: true,
          layerId, order: s.objects.length,
        }));
      }
      for (const shape of shapes) {
        if (shape.type === "polyline") {
          const object = applyNewObjectStyleDefaults({
            id: `obj_${stamp}_polyline${++idCounter}`,
            type: "polyline",
            points: shape.points.map((point) => ({
              x: fitted.x + point.x * scale,
              y: fitted.y + point.y * scale,
            })),
            closed: true,
            strokeLevel: 0, strokeWidth: OBJECTIFY_STROKE_WIDTH,
            arrowHead: "none", dashLength: 0, dashGap: 0,
            fillLevel: 214, fillNone: true, fillStyle: "solid",
            rotation: 0, locked: false, positionLocked: false,
            layerId, order: s.objects.length,
          });
          s.objects.push(object);
          addedIds.push(object.id);
          continue;
        }
        const object = applyNewObjectStyleDefaults({
          id: `obj_${stamp}_${shape.type}${++idCounter}`,
          type: shape.type,
          x: fitted.x + shape.x * scale, y: fitted.y + shape.y * scale,
          w: shape.w * scale, h: shape.h * scale,
          rotation: 0, strokeLevel: 0, strokeWidth: OBJECTIFY_STROKE_WIDTH,
          fillLevel: 214, fillNone: true, fillStyle: "solid",
          locked: false, positionLocked: false,
          layerId, order: s.objects.length,
        });
        s.objects.push(object);
        addedIds.push(object.id);
      }
      for (const segment of segments) {
        const line = applyNewObjectStyleDefaults({
          id: `obj_${stamp}_line${++idCounter}`,
          type: "line",
          p1: { x: fitted.x + segment.x1 * scale, y: fitted.y + segment.y1 * scale },
          p2: { x: fitted.x + segment.x2 * scale, y: fitted.y + segment.y2 * scale },
          strokeLevel: 0, strokeWidth: OBJECTIFY_STROKE_WIDTH,
          arrowHead: "none", dashLength: 0, dashGap: 0,
          layerId, order: s.objects.length,
          rotation: 0, locked: false, positionLocked: false,
        });
        s.objects.push(line);
        addedIds.push(line.id);
      }
      s.undoStack.push(snapshot);
      s.redoStack = [];
      s.selectedIds = addedIds;
      s.targetedId = null;
      s.activeTool = "V";
    });
    close();
  }

  openButton.addEventListener("click", () => {
    overlay.hidden = false;
    dropzone.focus();
  });
  overlay.querySelector("#objectify-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !overlay.hidden) close(); });
  document.addEventListener("keydown", (event) => {
    if (!overlay.hidden && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      event.stopPropagation();
    }
  }, true);
  document.addEventListener("paste", (event) => {
    if (overlay.hidden) return;
    const imageItem = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const imageFile = imageItem.getAsFile();
    if (!imageFile) return;
    event.preventDefault();
    event.stopPropagation();
    loadFile(imageFile);
  }, true);
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => { loadFile(fileInput.files?.[0]); fileInput.value = ""; });
  for (const type of ["dragenter", "dragover"]) {
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add("is-dragover"); });
  }
  for (const type of ["dragleave", "drop"]) {
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove("is-dragover"); });
  }
  dropzone.addEventListener("drop", (event) => loadFile(event.dataTransfer.files?.[0]));
  threshold.addEventListener("input", () => { thresholdOutput.value = threshold.value; invalidate(); if (sourceCanvas) drawPreview(); });
  minLength.addEventListener("input", () => { invalidate(); if (sourceCanvas) drawPreview(); });
  extractButton.addEventListener("click", extract);
  insertButton.addEventListener("click", insertObjects);
}
