/* ===== MAIN (wire modules; data-as-truth + viewBox zoom/pan) ===== */
//
// Responsibilities:
//   1. write state.viewBox onto the SVG (the only coordinate authority);
//   2. subscribe render to the store so data changes auto-repaint;
//   3. init viewport (wheel zoom / drag pan) ??it mutates viewBox via update;
//   4. init tools (tool selection + the rectangle draw pipeline).

// ?v= matches index.html so a version bump reloads every module, not just main.
import { state } from "./state.js?v=0.36.5";
import { render } from "./render.js?v=0.36.5";
import { initViewport, getZoom, screenToWorld, centerView, setCenterLocked } from "./viewport.js?v=0.36.5";
import { initTools } from "./tools.js?v=0.36.5";
import { initTransform, undo, redo } from "./transform.js?v=0.36.5";
import { initInspector } from "./inspector.js?v=0.36.5";
import { initProjectIO } from "./project-io.js?v=0.36.5";
import { initExportDialog } from "./export-dialog.js?v=0.36.5";
import { initRuler, setRulerVisible } from "./ruler.js?v=0.36.5";
import { initSettings } from "./settings.js?v=0.36.5";
import { initImageObjectify } from "./image-objectify.js?v=0.36.5";
import { initImageImportMock } from "./image-import-mock.js?v=0.36.5";
import { initTemplates } from "./templates.js?v=0.36.5";
import { initObjectSearch } from "./search.js?v=0.36.5";

const svg = document.getElementById("canvas");
const zoomReadout = document.getElementById("zoom-readout");

/* ===== APP FULLSCREEN (workspace only; artboard state remains unchanged) ===== */
(function initFullscreen() {
  const app = document.querySelector(".app");
  const btn = document.getElementById("fullscreen-toggle");
  if (!app || !btn) return;

  const syncButton = () => {
    const active = document.fullscreenElement === app;
    btn.setAttribute("aria-pressed", String(active));
    btn.setAttribute("aria-label", active ? "전체화면 해제" : "전체화면");
    btn.title = active ? "전체화면 해제 (Alt+Enter)" : "전체화면 (Alt+Enter)";
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await app.requestFullscreen();
    } catch (error) {
      console.error("Unable to toggle fullscreen", error);
    }
  };

  btn.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", syncButton);
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.key !== "Enter" || e.repeat) return;
    e.preventDefault();
    toggleFullscreen();
  });
  syncButton();
})();

/* ===== THEME TOGGLE (dark/light; persisted in localStorage 'theme') ===== */
(function initTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem("theme");
  root.setAttribute("data-theme", saved === "light" || saved === "dark" ? saved : "dark");

  const btn = document.getElementById("theme-toggle");
  function syncIcon() {
    if (!btn) return;
    const dark = root.getAttribute("data-theme") === "dark";
    btn.setAttribute("aria-pressed", String(dark));
    btn.setAttribute("aria-label", dark ? "흑백 모드 끄기" : "흑백 모드 켜기");
    btn.title = dark ? "흑백 모드 끄기" : "흑백 모드 켜기";
  }
  syncIcon();

  if (btn) {
    btn.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      syncIcon();
    });
  }
})();

/* ----- projection of viewBox onto the SVG element ----- */
function applyViewBox(s) {
  const { x, y, w, h } = s.viewBox;
  svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  if (zoomReadout) zoomReadout.textContent = `zoom ${getZoom().toFixed(2)}×`;
}

/* ----- subscribe: every state.update() repaints + re-projects viewBox ----- */
// render runs automatically on data change (data-as-truth, DESIGN 1-1).
state.subscribe(render);
state.subscribe(applyViewBox);

/* ----- viewport: zoom/pan mutate viewBox through the store ----- */
// onChange is intentionally a no-op: initViewport mutates viewBox via
// state.update(), which already fires the applyViewBox + render subscribers.
initViewport(svg, state, () => {});

/* ----- tools: V/R selection + rectangle drawing (mouse ??store.update) ----- */
initTools(svg, state);

/* ----- transform: body-drag move + Undo/Redo (must come after initTools) ----- */
initTransform(svg, state);

/* ----- inspector: right-panel controls wired to selected object ----- */
initInspector(state);

/* ===== UNDO / REDO TOP-BAR BUTTONS (icon-only; left of 파일) ===== */
(function initUndoRedoButtons() {
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  if (!undoBtn || !redoBtn) return;
  undoBtn.addEventListener("click", () => undo(state));
  redoBtn.addEventListener("click", () => redo(state));
  // Reflect availability on every state change (history changes via update()).
  function syncUndoRedo(s) {
    undoBtn.disabled = (s.undoStack || []).length === 0;
    redoBtn.disabled = (s.redoStack || []).length === 0;
  }
  state.subscribe(syncUndoRedo);
  syncUndoRedo(state.get());
})();

/* ----- project I/O: top-bar 저장/불러오기 buttons (editable JSON source) ----- */
initProjectIO(state, svg);

/* ----- export dialog: 파일 dropdown → 내보내기/미리보기 (PNG/SVG) ----- */
initExportDialog(state, svg);

/* ----- rulers: top + left ruler canvases synced to viewport ----- */
initRuler(svg, state);

/* ----- settings: 설정 dropdown + 기본값 설정 modal (persists to localStorage) ----- */
initSettings(state);

/* ----- advanced: local image-to-line rough draft extraction ----- */
initImageObjectify(state);

/* ----- advanced: local mock JSON → editable objects (image-to-object Phase 1) ----- */
initImageImportMock(state);

/* ----- template library: 기호 패널 클릭 → 캔버스에 심볼 instantiate ----- */
initTemplates(svg);

/* ----- object search: Ctrl+F registry search + existing creation paths ----- */
initObjectSearch();

/* ===== TOOL PANEL: collapsible section toggle (event delegation) ===== */
(function initToolSections() {
  const panel = document.getElementById("tool-list");
  if (!panel) return;
  panel.addEventListener("click", (e) => {
    const header = e.target.closest(".tool-section-header");
    if (!header) return;
    header.closest(".tool-section").classList.toggle("is-collapsed");
  });
})();

/* ===== GRID CONTROLS (canvas bottom bar) ===== */
(function initGridControls() {
  const toggle   = document.getElementById("grid-toggle");
  const slider   = document.getElementById("grid-opacity");
  const interval = document.getElementById("grid-interval");
  const centerBtn = document.getElementById("center-view-btn");
  if (!toggle || !slider) return;
  toggle.addEventListener("change", () => {
    state.update((s) => { s.grid.visible = toggle.checked; });
  });
  slider.addEventListener("input", () => {
    state.update((s) => { s.grid.opacity = Number(slider.value); });
  });
  if (interval) {
    interval.addEventListener("input", () => {
      state.update((s) => { s.grid.interval = Number(interval.value); });
    });
  }
  if (centerBtn) {
    centerBtn.addEventListener("click", () => {
      const locked = centerBtn.classList.toggle("is-active");
      setCenterLocked(locked);
      centerBtn.style.background = locked ? "var(--c-main)" : "";
      centerBtn.style.color = locked ? "#fff" : "";
      if (locked) centerView(state);
    });
  }
  const rulerToggle = document.getElementById("ruler-toggle");
  if (rulerToggle) {
    rulerToggle.addEventListener("change", () => setRulerVisible(rulerToggle.checked));
  }
})();

/* ----- initial paint ----- */
applyViewBox(state.get());
render(state.get());

/* ===== DEBUG HANDLE (console verification) ===== */
// Inspect the live data: `phyDraw.objects()` lists committed shapes.
window.phyDraw = {
  state,
  objects: () => state.get().objects,
  selected: () => state.get().objects.find((o) => o.id === state.get().selectedId) || null,
  zoom: getZoom,
};

/* ===== COORD DEBUG OVERLAY (press "d" to toggle) ===== */
// Proves pointer?뭮orld mapping live. Compares the app's screenToWorld with a
// fresh getScreenCTM round-trip; "?screen" is how far the mapped point lands
// from the real pointer pixel ??must read ~0 at any zoom/pan. Off by default.
(function initCoordDebug() {
  const box = document.createElement("div");
  box.id = "coord-debug";
  box.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:9999;display:none;" +
    "font:11px/1.45 'IBM Plex Mono',monospace;white-space:pre;" +
    "background:rgba(13,17,23,.88);color:#7ee787;padding:8px 10px;" +
    "border-radius:6px;pointer-events:none;max-width:46ch;";
  document.body.appendChild(box);

  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key.toLowerCase() === "d" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      box.style.display = box.style.display === "none" ? "block" : "none";
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (box.style.display === "none") return;
    const vb = state.get().viewBox;
    const r = svg.getBoundingClientRect();
    const w = screenToWorld(svg, vb, e.clientX, e.clientY); // app's single helper
    // independent round-trip: world ??back to screen via the SAME CTM
    const m = svg.getScreenCTM();
    const back = { x: m.a * w.x + m.c * w.y + m.e, y: m.b * w.x + m.d * w.y + m.f };
    const f = (n) => n.toFixed(2);
    box.textContent =
      `client   ${f(e.clientX)}, ${f(e.clientY)}\n` +
      `svg rect ${f(r.left)},${f(r.top)}  ${f(r.width)}횞${f(r.height)}  ar=${f(r.width / r.height)}\n` +
      `viewBox  ${f(vb.x)},${f(vb.y)}  ${f(vb.w)}횞${f(vb.h)}  ar=${f(vb.w / vb.h)}\n` +
      `world    ${f(w.x)}, ${f(w.y)}\n` +
      `?screen  ${f(back.x - e.clientX)}, ${f(back.y - e.clientY)}  (should be ~0)`;
  });
})();

console.info(
  "[시범공개] [5E v0.36.5] Pick R (or press R), drag on the canvas to draw a\n" +
    "Press 'd' to toggle the live coord-debug overlay (pointer?봶orld mapping).\n" +
    "rectangle. Verify with:\n" +
    "  phyDraw.objects()        // array of committed rect objects\n" +
    "  phyDraw.state.get().activeTool   // 'V' after each draw (auto-return)\n" +
    "Wheel = zoom, Space/middle-drag = pan ??shapes stay anchored in world space."
);
