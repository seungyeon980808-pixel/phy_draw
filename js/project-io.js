/* ===== PROJECT I/O (save / open editable source as JSON) ===== */
//
// This is the *editable source* format — the data needed to reconstruct the
// drawing — and is separate from image export (built later). We serialize only
// the persistent drawing data; transient session state (undo/redo, selection,
// active tool/layer, viewBox) is deliberately NOT saved.
//
// Groups are NOT stored: each object already carries `groupId`, and groups are
// derived from it everywhere (see transform.js rebuildGroups + the undo engine,
// which snapshots only `objects` and rebuilds groups). groupId is the single
// source of truth, so we rebuild groups on load via that same helper.

import { rebuildGroups } from "./transform.js?v=0.36.5";
import { screenToWorld } from "./viewport.js?v=0.36.5";
import { applyNewObjectStyleDefaults, migrateObjectStyleMode } from "./style-mode.js?v=0.36.5";
import { DEFAULT_TEXT_SIZE_MM, DEFAULT_TEXT_FONT, normalizeTextRuns, textRunsToText } from "./state.js?v=0.36.5";

// Schema version of the saved file. Distinct from the app UI version.
// 0.15 adds editing guides; older files without them load with an empty guide list.
const SCHEMA_VERSION = "0.15";

// Default artboard size for files saved before the artboard field existed.
const DEFAULT_ARTBOARD = { w: 90, h: 60 };

// Default download filename for a saved project.
const DEFAULT_FILENAME = "physics_drawing.json";
const APPARATUS_TEMPLATE_IDS = {
  wire: "E001",
  compass: "E002",
  pulley: "M001",
  clamp: "M004",
  scale: "M003",
};

const LABEL_CAPABLE_TYPES = new Set(["rect", "ellipse", "line", "axes", "anglearc", "labeler", "circuit", "optics"]);

function normalizeLabelType(value, fallback = "quantity") {
  return value === "quantity" || value === "label" ? value : fallback;
}

/* ----- migrate: bring an older saved file up to the current schema ----- */
// Currently only "0.13" exists, so this is a pass-through. As the schema
// evolves, insert version-specific transforms here, e.g.:
//   if (data.version === "0.13") { data = upgrade_0_13_to_0_14(data); }
function migrate(data) {
  if (!data || !Array.isArray(data.objects)) return data;
  return {
    ...data,
    objects: data.objects.map((obj) => {
      const next = {
        ...obj,
        positionLocked: obj.positionLocked ?? false,
      };
      if (LABEL_CAPABLE_TYPES.has(next.type)) {
        next.labelType = normalizeLabelType(next.labelType, next.type === "labeler" ? "label" : "quantity");
      }
      migrateObjectStyleMode(next);
      if (next.type === "text") {
        next.italic = next.italic ?? false;
        if (Array.isArray(next.textRuns) && next.textRuns.length) {
          next.textRuns = normalizeTextRuns(next);
          next.text = next.text ?? textRunsToText(next.textRuns);
        }
      }
      if (next.type === "formula") {
        next.italic = next.italic ?? false;
        next.rawSource = next.rawSource ?? next.source ?? "";
      }
      if (next.type === "polyline") {
        // 경사면처리 fields: old files lack them → default to sharp corners.
        next.rounded = next.rounded ?? false;
        next.cornerRadius = next.cornerRadius ?? 10;
      }
      if (next.type === "optics" && next.kind === "object_arrow") {
        next.dashLength = next.dashLength ?? 0;
        next.dashGap = next.dashGap ?? 0;
      }
      if (next.type === "anglearc") {
        next.radius = next.radius ?? 14;
        next.startAngle = next.startAngle ?? 0;
        next.sweepAngle = next.sweepAngle ?? 60;
      }
      if (next.type === "rightangle") {
        next.size = next.size ?? 6;
        next.angle = next.angle ?? 0;
        next.orientation = next.orientation ?? 1;
      }
      if (next.type === "labeler") {
        next.p1 = next.p1 ?? { x: 0, y: 0 };
        next.p2 = next.p2 ?? { x: next.p1.x + 12, y: next.p1.y - 6 };
        next.text = next.text ?? "㉠";
        // Older files lack fontFamily → default to the Dotum-first normal stack
        // (render.js falls back to the same default when this is absent).
        next.fontFamily = next.fontFamily ?? DEFAULT_TEXT_FONT;
        next.labelSize = next.labelSize ?? DEFAULT_TEXT_SIZE_MM;
        next.strokeLevel = next.strokeLevel ?? 0;
        next.strokeWidth = next.strokeWidth ?? 0.2;
      }
      if (next.type === "apparatus") {
        next.kind = next.kind ?? "wire";
        next.templateId = next.templateId ?? APPARATUS_TEMPLATE_IDS[next.kind] ?? null;
        next.x = next.x ?? 0;
        next.y = next.y ?? 0;
        next.w = next.w ?? 20;
        next.h = next.h ?? 12;
        next.rotation = next.rotation ?? 0;
        if (next.kind === "wire") {
          next.length = next.length ?? next.w ?? 24;
          next.angle = next.angle ?? 0;
          next.thickness = next.thickness ?? next.gap ?? 1.8;
          next.gap = next.gap ?? next.thickness;
        }
        if (next.kind === "compass") next.needleAngle = next.needleAngle ?? -90;
        if (next.kind === "compass" || next.kind === "pulley" || next.kind === "clamp" || next.kind === "scale") {
          next.lockAspect = next.lockAspect ?? true;
        }
        if (next.kind === "pulley") next.variant = next.variant ?? "basic";
        if (next.kind === "clamp") next.flipped = next.flipped ?? false;
        if (next.kind === "scale") next.displayText = next.displayText ?? "0.99 N";
      }
      return next;
    }),
  };
}

/* ----- serialize: build the saved-file object from live state ----- */
function serialize(s) {
  return {
    version: SCHEMA_VERSION,
    objects: s.objects,
    guides: s.guides,
    layers: s.layers,
    // artboard: page size (single source of truth for export/render dimensions).
    artboard: s.artboard,
    // groups omitted on purpose — derived from obj.groupId on load.
  };
}

/* ----- saveProject: download current drawing as a .json file ----- */
function saveProject(state) {
  const json = JSON.stringify(serialize(state.get()), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = DEFAULT_FILENAME;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ----- applyLoaded: replace drawing data through the store (re-renders) ----- */
function applyLoaded(state, data) {
  state.update((s) => {
    // Replace the persistent drawing data.
    s.objects = data.objects;
    s.guides = Array.isArray(data.guides)
      ? data.guides.filter((guide) => guide && (guide.axis === "x" || guide.axis === "y")
          && typeof guide.position === "number")
      : [];
    s.layers = data.layers;
    // Restore artboard; older files (no artboard field) default to 90×60.
    s.artboard = (data.artboard && typeof data.artboard.w === "number"
                  && typeof data.artboard.h === "number")
      ? { w: data.artboard.w, h: data.artboard.h }
      : { ...DEFAULT_ARTBOARD };
    // Groups are derived from groupId — rebuild rather than trust the file.
    rebuildGroups(s);

    // Fresh session for the opened file: drop history + selection.
    s.undoStack = [];
    s.redoStack = [];
    s.selectedIds = [];
    s.selectedGuideId = null;
    s.targetedId = null;
    s.draft = null;

    // Keep activeLayerId valid against the loaded layers.
    if (!s.layers.some((l) => l.id === s.activeLayerId)) {
      s.activeLayerId = s.layers[0] ? s.layers[0].id : 1;
    }
    // viewBox is left as-is on purpose (do not restore saved view).
  });
}

/* ----- openProject: read a .json file and load it into state ----- */
function openProject(state, file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const raw = JSON.parse(reader.result);
      const data = migrate(raw);

      // Structural sanity check before touching live state.
      if (
        !data ||
        typeof data !== "object" ||
        !Array.isArray(data.objects) ||
        !Array.isArray(data.layers)
      ) {
        throw new Error("필요한 데이터(objects/layers) 형식이 올바르지 않습니다.");
      }

      applyLoaded(state, data);
    } catch (err) {
      // On any failure, do NOT corrupt current state — just warn.
      alert("프로젝트 파일을 열 수 없습니다.\n" + (err && err.message ? err.message : err));
    }
  };
  reader.onerror = () => alert("파일을 읽는 중 오류가 발생했습니다.");
  reader.readAsText(file);
}

/* ----- image import: file-picker + drag-and-drop helper ----- */
let _imgIdCounter = 0;
let _placement = null;
let _placementHint = null;

function finishImagePlacement(state) {
  if (!_placement) return;
  _placement = null;
  if (_placementHint) _placementHint.hidden = true;
  state.update((s) => { s.activeTool = "V"; });
}

function cancelImagePlacement(state) {
  if (!_placement) return;
  const { objectId } = _placement;
  _placement = null;
  if (_placementHint) _placementHint.hidden = true;
  state.update((s) => {
    s.objects = s.objects.filter((o) => o.id !== objectId);
    s.selectedIds = (s.selectedIds || []).filter((id) => id !== objectId);
    s.targetedId = null;
    s.activeTool = "V";
  });
}

function beginImagePlacement(state, objectId) {
  finishImagePlacement(state);
  _placement = { objectId };
  if (_placementHint) _placementHint.hidden = false;
}

function readImageFile(file, dropPos, state) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const src = e.target.result;
    const img = new Image();
    img.onload = () => {
      const { w: artboardW, h: artboardH } = state.get().artboard;
      const scale = Math.min(
        (artboardW * 0.9) / img.naturalWidth,
        (artboardH * 0.9) / img.naturalHeight
      );
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      const center = dropPos || { x: 0, y: 0 };
      const minX = -artboardW / 2;
      const minY = -artboardH / 2;
      const x = Math.min(Math.max(center.x - w / 2, minX), artboardW / 2 - w);
      const y = Math.min(Math.max(center.y - h / 2, minY), artboardH / 2 - h);
      let objectId;
      state.update((s) => {
        const newObj = applyNewObjectStyleDefaults({
          id: `obj_${Date.now().toString(36)}_img${++_imgIdCounter}`,
          type: "image",
          src,
          x,
          y,
          w,
          h,
          rotation: 0,
          locked: false,
          positionLocked: false,
          layerId: s.activeLayerId,
          order: s.objects.length,
        });
        objectId = newObj.id;
        s.objects.push(newObj);
        s.selectedIds = [newObj.id];
        s.targetedId = null;
        s.activeTool = "V";
      });
      beginImagePlacement(state, objectId);
    };
    img.src = src;
  };
  reader.readAsDataURL(file);
}

/* ----- initProjectIO: wire the top-bar buttons + hidden file input ----- */
export function initProjectIO(state, svg) {
  const saveBtn = document.getElementById("project-save");
  const openBtn = document.getElementById("project-open");
  const imageImportBtn = document.getElementById("image-import");

  _placementHint = document.createElement("div");
  _placementHint.className = "image-placement-hint";
  _placementHint.textContent = "원하는 크기로 조정이 완료되면 Enter를 눌러주세요.";
  _placementHint.hidden = true;
  const canvasWrap = svg && svg.closest(".canvas-wrap");
  if (canvasWrap) canvasWrap.appendChild(_placementHint);

  window.addEventListener("keydown", (e) => {
    if (!_placement || (e.key !== "Enter" && e.key !== "Escape")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") cancelImagePlacement(state);
    else finishImagePlacement(state);
  }, true);

  // Hidden file input for project JSON, created here so index.html stays markup-only.
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  if (saveBtn) saveBtn.addEventListener("click", () => saveProject(state));

  if (openBtn) openBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) openProject(state, file);
    // Reset so selecting the same file again still fires "change".
    fileInput.value = "";
  });

  // Hidden file input for image import.
  const imageInput = document.createElement("input");
  imageInput.type = "file";
  imageInput.accept = "image/png,image/jpeg";
  imageInput.style.display = "none";
  document.body.appendChild(imageInput);

  if (imageImportBtn) imageImportBtn.addEventListener("click", () => imageInput.click());

  imageInput.addEventListener("change", () => {
    const file = imageInput.files && imageInput.files[0];
    if (file) readImageFile(file, null, state);
    imageInput.value = "";
  });

  // Drag-and-drop image import on the canvas.
  if (svg) {
    svg.addEventListener("dragover", (e) => e.preventDefault());
    svg.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file || !file.type.startsWith("image/")) return;
      const vb = state.get().viewBox;
      const pos = screenToWorld(svg, vb, e.clientX, e.clientY);
      readImageFile(file, pos, state);
    });
  }
}
