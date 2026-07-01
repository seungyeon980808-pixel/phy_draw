/* ===== IMAGE-TO-OBJECT (Phase 1: local mock JSON import) ===== */
//
// SAFE, LOCAL-ONLY path for the planned image→object feature. This is NOT image
// recognition and it makes NO network calls: it only reads a *local* JSON file
// in the "image-to-object-v1" schema, validates it, converts supported entries
// into the app's EXISTING object types, shows an import summary + a lightweight
// schematic preview, and — on confirm — inserts them as normal editable objects
// in ONE undo step.
//
// No external API, no API key, no backend, no image bytes are read or sent.
// Design ref: docs/IMAGE_TO_OBJECT_API_DESIGN_20260630.md (roadmap Phase 1).
// Fixtures:   docs/qa-fixtures/image_to_object_mock_v1.json (+ _expected.md).

import { DEFAULT_TEXT_SIZE_MM, DEFAULT_TEXT_FONT } from "./state.js?v=0.36.5";

const SCHEMA_VERSION = "image-to-object-v1";
const DEFAULT_STROKE_WIDTH = 0.2; // world units (mm), mirrors tools.js
let idCounter = 0;

/* ----- small validators ----- */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPt = (p) => !!p && isNum(p.x) && isNum(p.y);
const clone = (v) => JSON.parse(JSON.stringify(v));

// Canonical type from the various aliases a mock producer might emit.
const TYPE_ALIASES = {
  line: "line",
  arrow: "arrow", arrowline: "arrow", arrow_line: "arrow", arrowed: "arrow",
  rect: "rect", rectangle: "rect",
  circle: "circle",
  ellipse: "ellipse", oval: "ellipse",
  triangle: "triangle",
  polyline: "polyline", polygon: "polyline",
  text: "text",
  labeler: "labeler", callout: "labeler",
  anglearc: "anglearc", angle: "anglearc", angle_arc: "anglearc", arc: "anglearc",
};
function canonicalType(raw) {
  return TYPE_ALIASES[String(raw || "").trim().toLowerCase()] || null;
}

/* ----- coordinate mapper: image-pixel space → artboard world (mm) -----
 * Preserves aspect ratio, fits into ~90% of the artboard, centers on the
 * artboard origin (= world 0,0 = artboard center). Geometry is scaled; style
 * sizes (strokeWidth/fontSize/labelSize) are treated as world mm already. */
function makeMapper(source, artboard) {
  const sw = source.width, sh = source.height;
  const scale = Math.min((artboard.w * 0.9) / sw, (artboard.h * 0.9) / sh);
  const fittedW = sw * scale, fittedH = sh * scale;
  const ox = -fittedW / 2, oy = -fittedH / 2;
  return {
    scale,
    pt: (p) => ({ x: ox + p.x * scale, y: oy + p.y * scale }),
    len: (v) => v * scale,
  };
}

// Resolve a {x,y,w,h} box from explicit fields or a sourceBox fallback.
function boxOf(raw) {
  if (isNum(raw.x) && isNum(raw.y) && isNum(raw.w) && isNum(raw.h) && raw.w > 0 && raw.h > 0) {
    return { x: raw.x, y: raw.y, w: raw.w, h: raw.h };
  }
  const b = raw.sourceBox;
  if (b && isNum(b.x) && isNum(b.y) && isNum(b.w) && isNum(b.h) && b.w > 0 && b.h > 0) {
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  }
  return null;
}

// Per-object stroke width (world mm), default DEFAULT_STROKE_WIDTH.
function strokeOf(raw) {
  return isNum(raw.strokeWidth) && raw.strokeWidth > 0 ? raw.strokeWidth : DEFAULT_STROKE_WIDTH;
}

/* ===== object builders (mirror tools.js make* schemas; id/order/layer set on insert) ===== */
function baseLine(a, b, strokeWidth, arrowHead, isArrow) {
  return {
    id: null, type: "line",
    p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y },
    rotation: 0,
    strokeLevel: 0, strokeWidth,
    lineMode: isArrow ? "arrow" : "solid",
    lineStyle: "solid",
    arrowVariant: "right",
    dimensionVariant: "basic",
    arrowHead: arrowHead || "none",
    dashLength: 0, dashGap: 0,
    locked: false, positionLocked: false,
    layerId: 1, order: 0,
  };
}
function baseShape(type, x, y, w, h, strokeWidth) {
  const shape = {
    id: null, type, x, y, w, h,
    rotation: 0,
    strokeLevel: 0, strokeWidth,
    fillLevel: 255, fillNone: false, fillStyle: "solid",
    dashLength: 0, dashGap: 0,
    labelType: "quantity",
    locked: false, positionLocked: false,
    layerId: 1, order: 0,
  };
  if (type === "triangle") shape.flipX = false;
  return shape;
}
function basePolyline(points, closed, strokeWidth) {
  return {
    id: null, type: "polyline",
    points: points.map((p) => ({ x: p.x, y: p.y })),
    rotation: 0,
    strokeLevel: 0, strokeWidth,
    arrowHead: "none", dashLength: 0, dashGap: 0,
    closed: !!closed,
    fillLevel: 255, fillNone: !closed, fillStyle: "solid",
    rounded: false, cornerRadius: 10,
    locked: false, positionLocked: false,
    layerId: 1, order: 0,
  };
}
function baseText(p, text, fontSize) {
  return {
    id: null, type: "text",
    x: p.x, y: p.y, text,
    fontSize, fontFamily: DEFAULT_TEXT_FONT,
    fontWeight: "normal", fontStyle: "normal",
    italic: false, letterSpacing: null,
    underline: false, strikeout: false,
    rotation: 0, locked: false, positionLocked: false,
    layerId: 1, order: 0,
  };
}
function baseLabeler(a, b, text, labelSize) {
  return {
    id: null, type: "labeler",
    p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y },
    text, labelType: "label",
    fontFamily: DEFAULT_TEXT_FONT, labelSize,
    strokeLevel: 0, strokeWidth: DEFAULT_STROKE_WIDTH,
    locked: false, positionLocked: false,
    layerId: 1, order: 0,
  };
}
function baseAngleArc(vertex, radius, startAngle, sweepAngle, label) {
  return {
    id: null, type: "anglearc",
    x: vertex.x, y: vertex.y,
    radius, startAngle, sweepAngle,
    label, labelType: "quantity", showLabel: true,
    strokeLevel: 0, strokeWidth: DEFAULT_STROKE_WIDTH,
    locked: false, positionLocked: false,
    layerId: 1, order: 0,
  };
}

/* ===== per-type converters: return { obj } or { warn } ===== */
const CONVERTERS = {
  line(raw, m) {
    if (!isPt(raw.p1) || !isPt(raw.p2)) return { warn: "line: p1/p2 좌표가 없거나 숫자가 아님" };
    const ah = ["none", "end", "start", "both"].includes(raw.arrowHead) ? raw.arrowHead : "none";
    return { obj: baseLine(m.pt(raw.p1), m.pt(raw.p2), strokeOf(raw), ah, ah !== "none") };
  },
  arrow(raw, m) {
    if (!isPt(raw.p1) || !isPt(raw.p2)) return { warn: "arrow: p1/p2 좌표가 없거나 숫자가 아님" };
    const ah = ["end", "start", "both"].includes(raw.arrowHead) ? raw.arrowHead : "end";
    return { obj: baseLine(m.pt(raw.p1), m.pt(raw.p2), strokeOf(raw), ah, true) };
  },
  rect(raw, m) {
    const box = boxOf(raw);
    if (!box) return { warn: "rectangle: x/y/w/h(또는 sourceBox) 누락 또는 비정상" };
    const tl = m.pt({ x: box.x, y: box.y });
    return { obj: baseShape("rect", tl.x, tl.y, m.len(box.w), m.len(box.h), strokeOf(raw)) };
  },
  ellipse(raw, m) {
    const box = boxOf(raw);
    if (!box) return { warn: "ellipse: x/y/w/h(또는 sourceBox) 누락 또는 비정상" };
    const tl = m.pt({ x: box.x, y: box.y });
    return { obj: baseShape("ellipse", tl.x, tl.y, m.len(box.w), m.len(box.h), strokeOf(raw)) };
  },
  circle(raw, m) {
    let box = null;
    if (isNum(raw.cx) && isNum(raw.cy) && isNum(raw.r) && raw.r > 0) {
      box = { x: raw.cx - raw.r, y: raw.cy - raw.r, w: raw.r * 2, h: raw.r * 2 };
    } else {
      box = boxOf(raw);
    }
    if (!box) return { warn: "circle: cx/cy/r 또는 x/y/w/h 누락 또는 비정상" };
    const tl = m.pt({ x: box.x, y: box.y });
    // circle = ellipse with equal w/h (the app has no separate circle type).
    return { obj: baseShape("ellipse", tl.x, tl.y, m.len(box.w), m.len(box.h), strokeOf(raw)) };
  },
  triangle(raw, m) {
    const box = boxOf(raw);
    if (!box) return { warn: "triangle: x/y/w/h(또는 sourceBox) 누락 또는 비정상" };
    const tl = m.pt({ x: box.x, y: box.y });
    return { obj: baseShape("triangle", tl.x, tl.y, m.len(box.w), m.len(box.h), strokeOf(raw)) };
  },
  polyline(raw, m) {
    const pts = Array.isArray(raw.points) ? raw.points.filter(isPt) : [];
    if (pts.length < 2) return { warn: "polyline: 유효한 점이 2개 미만" };
    return { obj: basePolyline(pts.map((p) => m.pt(p)), raw.closed === true, strokeOf(raw)) };
  },
  text(raw, m) {
    if (!isNum(raw.x) || !isNum(raw.y)) return { warn: "text: x/y 좌표 누락 또는 비정상" };
    if (typeof raw.text !== "string" || !raw.text.length) return { warn: "text: text 문자열 누락" };
    const size = isNum(raw.fontSize) && raw.fontSize > 0 ? raw.fontSize : DEFAULT_TEXT_SIZE_MM;
    return { obj: baseText(m.pt({ x: raw.x, y: raw.y }), raw.text, size) };
  },
  labeler(raw, m) {
    if (!isPt(raw.p1) || !isPt(raw.p2)) return { warn: "labeler: p1/p2 좌표 누락 또는 비정상" };
    if (typeof raw.text !== "string" || !raw.text.length) return { warn: "labeler: text 문자열 누락" };
    const size = isNum(raw.labelSize) && raw.labelSize > 0 ? raw.labelSize : DEFAULT_TEXT_SIZE_MM;
    return { obj: baseLabeler(m.pt(raw.p1), m.pt(raw.p2), raw.text, size) };
  },
  anglearc(raw, m) {
    if (!isNum(raw.x) || !isNum(raw.y)) return { warn: "anglearc: 꼭짓점 x/y 누락 또는 비정상" };
    if (!isNum(raw.radius) || raw.radius <= 0) return { warn: "anglearc: radius 누락 또는 비정상" };
    if (!isNum(raw.startAngle) || !isNum(raw.sweepAngle)) return { warn: "anglearc: startAngle/sweepAngle 비정상" };
    const label = typeof raw.label === "string" && raw.label.length ? raw.label : "θ";
    return { obj: baseAngleArc(m.pt({ x: raw.x, y: raw.y }), m.len(raw.radius), raw.startAngle, raw.sweepAngle, label) };
  },
};

/* ===== top-level parse + validate + convert ===== */
// Returns { ok, error } on structural failure, or
// { ok:true, objects:[...world objects], imported, skipped, warnings:[], byType:{} }.
export function parseMockImport(rawText, artboard) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, error: "JSON 구문 오류: " + (e && e.message ? e.message : e) };
  }
  if (!data || typeof data !== "object") return { ok: false, error: "최상위가 객체가 아닙니다." };
  if (data.version !== SCHEMA_VERSION) {
    return { ok: false, error: `version이 "${SCHEMA_VERSION}"이어야 합니다 (받은 값: ${JSON.stringify(data.version)}).` };
  }
  if (!Array.isArray(data.objects)) return { ok: false, error: "objects 배열이 없습니다." };
  const source = data.source;
  if (!source || !isNum(source.width) || !isNum(source.height) || source.width <= 0 || source.height <= 0) {
    return { ok: false, error: "source.width / source.height (양수)가 필요합니다." };
  }

  const m = makeMapper(source, artboard);
  const objects = [];
  const warnings = [];
  const byType = {};
  // Carry over any author-supplied warnings (informational only).
  if (Array.isArray(data.warnings)) {
    for (const w of data.warnings) if (typeof w === "string" && w) warnings.push("입력 경고: " + w);
  }

  data.objects.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") {
      warnings.push(`#${i}: 객체가 아님 → 건너뜀`);
      return;
    }
    const type = canonicalType(raw.type);
    if (!type || !CONVERTERS[type]) {
      warnings.push(`#${i}: 지원하지 않는 type "${raw.type}" → 건너뜀`);
      return;
    }
    let result;
    try {
      result = CONVERTERS[type](raw, m);
    } catch (e) {
      warnings.push(`#${i} (${raw.type}): 변환 중 오류 → 건너뜀 (${e && e.message ? e.message : e})`);
      return;
    }
    if (result.warn) {
      warnings.push(`#${i}: ${result.warn} → 건너뜀`);
      return;
    }
    objects.push(result.obj);
    byType[result.obj.type] = (byType[result.obj.type] || 0) + 1;
  });

  return {
    ok: true,
    objects,
    imported: objects.length,
    skipped: data.objects.length - objects.length,
    warnings,
    byType,
  };
}

/* ===== lightweight schematic preview (source-pixel space → canvas) ===== */
function drawPreview(canvas, data) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const src = data.source;
  const pad = 8;
  const k = Math.min((canvas.width - pad * 2) / src.width, (canvas.height - pad * 2) / src.height);
  const ox = (canvas.width - src.width * k) / 2;
  const oy = (canvas.height - src.height * k) / 2;
  const X = (v) => ox + v * k;
  const Y = (v) => oy + v * k;

  // source frame
  ctx.strokeStyle = "rgba(120,130,150,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(X(0), Y(0), src.width * k, src.height * k);

  ctx.strokeStyle = "#0969da";
  ctx.fillStyle = "#0969da";
  ctx.lineWidth = 1.4;
  ctx.font = "12px sans-serif";
  ctx.textBaseline = "alphabetic";

  for (const raw of data.objects) {
    const type = canonicalType(raw && raw.type);
    if (!type) continue;
    ctx.beginPath();
    if ((type === "line" || type === "arrow") && isPt(raw.p1) && isPt(raw.p2)) {
      ctx.moveTo(X(raw.p1.x), Y(raw.p1.y));
      ctx.lineTo(X(raw.p2.x), Y(raw.p2.y));
      ctx.stroke();
      if (type === "arrow" || raw.arrowHead) {
        const ang = Math.atan2(Y(raw.p2.y) - Y(raw.p1.y), X(raw.p2.x) - X(raw.p1.x));
        const hl = 7;
        ctx.beginPath();
        ctx.moveTo(X(raw.p2.x), Y(raw.p2.y));
        ctx.lineTo(X(raw.p2.x) - hl * Math.cos(ang - 0.4), Y(raw.p2.y) - hl * Math.sin(ang - 0.4));
        ctx.moveTo(X(raw.p2.x), Y(raw.p2.y));
        ctx.lineTo(X(raw.p2.x) - hl * Math.cos(ang + 0.4), Y(raw.p2.y) - hl * Math.sin(ang + 0.4));
        ctx.stroke();
      }
    } else if (type === "labeler" && isPt(raw.p1) && isPt(raw.p2)) {
      ctx.moveTo(X(raw.p1.x), Y(raw.p1.y));
      ctx.lineTo(X(raw.p2.x), Y(raw.p2.y));
      ctx.stroke();
      if (typeof raw.text === "string") ctx.fillText(raw.text, X(raw.p2.x) + 2, Y(raw.p2.y));
    } else if (type === "circle" && isNum(raw.cx) && isNum(raw.cy) && isNum(raw.r)) {
      ctx.ellipse(X(raw.cx), Y(raw.cy), raw.r * k, raw.r * k, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (type === "polyline" && Array.isArray(raw.points)) {
      const pts = raw.points.filter(isPt);
      if (pts.length >= 2) {
        ctx.moveTo(X(pts[0].x), Y(pts[0].y));
        for (const p of pts.slice(1)) ctx.lineTo(X(p.x), Y(p.y));
        if (raw.closed === true) ctx.closePath();
        ctx.stroke();
      }
    } else if (type === "text" && isNum(raw.x) && isNum(raw.y) && typeof raw.text === "string") {
      ctx.fillText(raw.text, X(raw.x), Y(raw.y));
    } else if (type === "anglearc" && isNum(raw.x) && isNum(raw.y) && isNum(raw.radius)) {
      // math convention (CCW +, +Y up); canvas y is down → negate angles.
      const a0 = -(raw.startAngle || 0) * Math.PI / 180;
      const a1 = -((raw.startAngle || 0) + (raw.sweepAngle || 0)) * Math.PI / 180;
      ctx.arc(X(raw.x), Y(raw.y), raw.radius * k, Math.min(a0, a1), Math.max(a0, a1));
      ctx.stroke();
    } else {
      const box = boxOf(raw || {});
      if (box) { ctx.strokeRect(X(box.x), Y(box.y), box.w * k, box.h * k); }
    }
  }
}

/* ===== modal ===== */
function buildModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal modal-objectify" role="dialog" aria-modal="true" aria-labelledby="mockimport-title">
      <h2 class="modal-title" id="mockimport-title">이미지 → 객체 (목업 JSON 가져오기)</h2>
      <p class="objectify-description">로컬 <code>image-to-object-v1</code> JSON을 읽어 편집 가능한 객체로 변환합니다. 외부 전송·API 호출은 없습니다(로컬 전용).</p>
      <input id="mockimport-file" type="file" accept="application/json,.json" hidden />
      <div id="mockimport-dropzone" class="objectify-dropzone" role="button" tabindex="0">목업 JSON 파일 선택 또는 끌어 놓기</div>
      <canvas id="mockimport-preview" class="objectify-preview" width="560" height="220" hidden></canvas>
      <p id="mockimport-status" class="objectify-status" role="status">목업 JSON 파일을 선택하세요.</p>
      <div id="mockimport-report" class="objectify-status" style="white-space:pre-wrap;max-height:120px;overflow:auto;"></div>
      <div class="modal-actions">
        <button id="mockimport-cancel" type="button" class="modal-btn">취소</button>
        <button id="mockimport-insert" type="button" class="modal-btn modal-btn-primary" disabled>객체로 삽입</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

/* ===== init ===== */
export function initImageImportMock(state) {
  const openButton = document.getElementById("image-import-mock-open");
  if (!openButton) return;

  const overlay = buildModal();
  const fileInput = overlay.querySelector("#mockimport-file");
  const dropzone = overlay.querySelector("#mockimport-dropzone");
  const preview = overlay.querySelector("#mockimport-preview");
  const status = overlay.querySelector("#mockimport-status");
  const report = overlay.querySelector("#mockimport-report");
  const insertButton = overlay.querySelector("#mockimport-insert");

  let pending = null; // array of converted world objects, or null

  const setStatus = (msg, isError = false) => {
    status.textContent = msg;
    status.classList.toggle("is-error", isError);
  };
  const reset = () => {
    pending = null;
    insertButton.disabled = true;
    report.textContent = "";
    preview.hidden = true;
  };
  const close = () => { overlay.hidden = true; };

  function handleText(text) {
    reset();
    const artboard = state.get().artboard;
    const result = parseMockImport(text, artboard);
    if (!result.ok) {
      setStatus("가져오기 실패: " + result.error, true);
      return;
    }
    pending = result.objects;
    const typeLine = Object.keys(result.byType).length
      ? Object.entries(result.byType).map(([t, n]) => `${t} ${n}`).join(" · ")
      : "(없음)";
    const lines = [
      `가져올 객체 ${result.imported}개 · 건너뛴 객체 ${result.skipped}개`,
      `종류: ${typeLine}`,
    ];
    if (result.warnings.length) {
      lines.push("", "경고/건너뜀:");
      for (const w of result.warnings) lines.push("· " + w);
    }
    report.textContent = lines.join("\n");
    insertButton.disabled = result.imported === 0;
    setStatus(result.imported
      ? "미리보기를 확인하고 [객체로 삽입]을 누르세요."
      : "삽입할 수 있는 지원 객체가 없습니다.", result.imported === 0);

    // Preview from the original (validated) JSON if possible.
    try {
      const data = JSON.parse(text);
      drawPreview(preview, data);
      preview.hidden = false;
    } catch (_) { preview.hidden = true; }
  }

  function loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => setStatus("파일을 읽지 못했습니다.", true);
    reader.onload = () => handleText(String(reader.result || ""));
    reader.readAsText(file);
  }

  function insertObjects() {
    if (!pending || !pending.length) return;
    const stamp = Date.now().toString(36);
    state.update((s) => {
      const snapshot = clone(s.objects);
      const layerId = s.activeLayerId;
      const addedIds = [];
      for (const proto of pending) {
        const obj = clone(proto);
        obj.id = `obj_${stamp}_${obj.type}${++idCounter}`;
        obj.layerId = layerId;
        obj.order = s.objects.length;
        s.objects.push(obj);
        addedIds.push(obj.id);
      }
      // One grouped history step (matches image-objectify.js insertion).
      s.undoStack.push(snapshot);
      s.redoStack = [];
      s.selectedIds = addedIds;
      s.targetedId = null;
      s.activeTool = "V";
    });
    close();
  }

  openButton.addEventListener("click", () => { overlay.hidden = false; reset(); setStatus("목업 JSON 파일을 선택하세요."); dropzone.focus(); });
  overlay.querySelector("#mockimport-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => { loadFile(fileInput.files?.[0]); fileInput.value = ""; });
  for (const type of ["dragenter", "dragover"]) {
    dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add("is-dragover"); });
  }
  for (const type of ["dragleave", "drop"]) {
    dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.remove("is-dragover"); });
  }
  dropzone.addEventListener("drop", (e) => loadFile(e.dataTransfer.files?.[0]));
  insertButton.addEventListener("click", insertObjects);
}
