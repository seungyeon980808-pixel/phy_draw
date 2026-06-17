/* ===== STATE (DESIGN 1-1: data is the single source of truth) ===== */
//
// The whole drawing is one plain data object. SVG is only a projection of it.
// `objects` holds every shape (a rectangle is one object — DESIGN 1-1). The
// render pass paints these; nothing reads back from the SVG DOM.
//
// `viewBox` mirrors the SVG viewBox and is the ONLY coordinate authority
// (DESIGN 1-2). Zoom/pan mutate this, never a CSS transform.

import { createStore } from "./store.js";

/* ----- initial state ----- */
export const state = createStore({
  // objects: array of { id, type, ...props } — the real drawing data.
  objects: [],

  // viewBox: world-space rectangle currently shown (x, y, w, h).
  // Initial view: 90×65 artboard centered at origin with ~10mm margin on each side.
  viewBox: { x: -55, y: -42.5, w: 110, h: 85 },

  // activeTool: which tool is armed. "V" = select, "R" = rectangle (DESIGN §3).
  // Drawing auto-returns to "V" right after a shape lands (DESIGN 4-3).
  activeTool: "V",

  // draft: the in-progress shape shown live during a drag. null when idle.
  // It is NOT a committed object — on mouse-up it becomes one in `objects`.
  draft: null,

  // selectedIds: array of selected object ids; empty = nothing selected.
  selectedIds: [],

  // undoStack / redoStack: each entry is a deep-cloned objects array snapshot.
  // Populated by transform.js; nothing else should touch these directly.
  undoStack: [],
  redoStack: [],

  // groups: array of { id, memberIds: [] }. Objects reference their group via obj.groupId.
  groups: [],

  // targetedId: id of the single group member targeted by double-click (주황색 지목 상태). null when idle.
  targetedId: null,

  // activeLayerId: the layer currently being drawn/edited.
  activeLayerId: 1,

  // layers: ordered list of layers; each shape will reference its layer via obj.layerId.
  layers: [
    { id: 1, name: "레이어 1", visible: true },
    { id: 2, name: "레이어 2", visible: true },
    { id: 3, name: "레이어 3", visible: true },
  ],
});
