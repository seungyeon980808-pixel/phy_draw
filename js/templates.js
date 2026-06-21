/* ===== TEMPLATES (symbol library — the reusable foundation, DESIGN 1-1) ===== */
//
// This is the standard path every future library symbol follows: a definition
// lives here, the left-panel library shows a button for it, and clicking that
// button calls instantiate() to drop ONE data object onto the canvas via the
// store — exactly like drawing or importing, so it lands on the undo stack and
// auto-selects. SVG stays a pure projection of state.objects (data-as-truth).
//
// Two KINDS of symbol are distinguished in the registry so the structure is
// ready for both, even though only the first is used now:
//   * "atomic"    — ONE indivisible data object (e.g. axes, circuit symbols).
//                   Selection/move/rotate/resize act on the single object.
//   * "composite" — SEVERAL primitives bundled as a group (e.g. lens, pulley).
//                   NOT implemented yet — see the placeholder below.

import { state } from "./state.js?v=0.41.0";

const DEFAULT_STROKE_WIDTH = 0.2; // world units (mm) — matches tools.js shapes

// Monotonic suffix so two instantiations within the same millisecond differ.
let _tplIdCounter = 0;

/* ===== SYMBOL REGISTRY =====
 * Keyed by symbolId. Each entry:
 *   { kind, label, make(atCanvasPoint) -> objectData | objectData[] }
 * For "atomic" make() returns ONE object (no id/order/layerId — instantiate
 * assigns those). For "composite" make() will return several primitives plus a
 * group; left unimplemented for now. */
export const TEMPLATES = {
  /* ----- AXES: first atomic symbol (single type:"axes" object) -----
   * Carries x/y/w/h/rotation so it rides the existing size-based transform path
   * (move/rotate/resize) with no new logic. The origin (axis intersection) sits
   * at the bbox center; ticks and labels are computed by the renderer, never
   * stored as separate objects (mirrors how text is one box, not per-glyph). */
  axes: {
    kind: "atomic",
    label: "좌표축",
    make(at) {
      const w = 44, h = 34; // default extent (mm); resizable afterwards
      return {
        type: "axes",
        x: at.x - w / 2,
        y: at.y - h / 2,
        w,
        h,
        rotation: 0,
        strokeLevel: 0,                 // 0 = black (DESIGN 2-2)
        strokeWidth: DEFAULT_STROKE_WIDTH,
        showTicks: true,
        tickSpacing: 5,                 // world units (mm) between ticks
        labelX: "x",
        labelY: "y",
        locked: false,
        positionLocked: false,
      };
    },
  },

  /* ----- COMPOSITE PLACEHOLDER (not implemented yet) -----
   * When composites land, an entry like this returns several primitive objects
   * plus a group descriptor; instantiate() will push them together and select
   * the group. Kept here only to fix the structure future symbols follow.
   *
   * lens: {
   *   kind: "composite",
   *   label: "볼록 렌즈",
   *   make(at) { return [ ...primitives ]; },  // + group wiring
   * },
   */
};

/* ===== INSTANTIATE: the single entry point the left panel calls ===== */
// atomic → push ONE object through the store (undo snapshot + auto-select),
// exactly like drawing a shape (tools.js) or importing an image (project-io.js).
export function instantiate(symbolId, atCanvasPoint) {
  const def = TEMPLATES[symbolId];
  if (!def) {
    console.warn(`[templates] unknown symbol: ${symbolId}`);
    return;
  }
  if (def.kind === "composite") {
    // Reserved path — composites are not implemented yet.
    console.warn(`[templates] composite "${symbolId}" not implemented yet`);
    return;
  }

  const at = atCanvasPoint || { x: 0, y: 0 };
  const obj = def.make(at);

  state.update((s) => {
    // Snapshot pre-creation objects so a single Ctrl+Z removes this symbol.
    const snap = JSON.parse(JSON.stringify(s.objects));
    obj.id = `obj_${Date.now().toString(36)}_tpl${++_tplIdCounter}`;
    obj.order = s.objects.length;
    obj.layerId = s.activeLayerId;
    s.objects.push(obj);
    s.undoStack.push(snap);
    s.redoStack = [];
    s.selectedIds = [obj.id]; // auto-select the new symbol
    s.targetedId = null;
    s.activeTool = "V";       // ensure the select tool is armed
  });
}

/* ===== WIRE THE LEFT-PANEL LIBRARY ===== */
// Each library button carries data-template="<symbolId>". Clicking it drops the
// symbol at the current view center (world coords derived from the viewBox).
export function initTemplates(svg) {
  const panel = document.getElementById("tool-list");
  if (!panel) return;
  panel.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-template]");
    if (!btn) return;
    const symbolId = btn.dataset.template;
    const vb = state.get().viewBox;
    const center = { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
    instantiate(symbolId, center);
  });
}
