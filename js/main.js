/* ===== MAIN (wire modules; data-as-truth + viewBox zoom/pan) ===== */
//
// Responsibilities:
//   1. write state.viewBox onto the SVG (the only coordinate authority);
//   2. subscribe render to the store so data changes auto-repaint;
//   3. init viewport (wheel zoom / drag pan) → it mutates viewBox via update;
//   4. init tools (tool selection + the rectangle draw pipeline).

// ?v= matches index.html so a version bump reloads every module, not just main.
import { state } from "./state.js?v=0.4.4";
import { render } from "./render.js?v=0.4.4";
import { initViewport, getZoom, screenToWorld } from "./viewport.js?v=0.4.4";
import { initTools } from "./tools.js?v=0.4.4";

const svg = document.getElementById("canvas");
const zoomReadout = document.getElementById("zoom-readout");

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

/* ----- tools: V/R selection + rectangle drawing (mouse → store.update) ----- */
initTools(svg, state);

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
// Proves pointer→world mapping live. Compares the app's screenToWorld with a
// fresh getScreenCTM round-trip; "Δscreen" is how far the mapped point lands
// from the real pointer pixel — must read ~0 at any zoom/pan. Off by default.
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
    // independent round-trip: world → back to screen via the SAME CTM
    const m = svg.getScreenCTM();
    const back = { x: m.a * w.x + m.c * w.y + m.e, y: m.b * w.x + m.d * w.y + m.f };
    const f = (n) => n.toFixed(2);
    box.textContent =
      `client   ${f(e.clientX)}, ${f(e.clientY)}\n` +
      `svg rect ${f(r.left)},${f(r.top)}  ${f(r.width)}×${f(r.height)}  ar=${f(r.width / r.height)}\n` +
      `viewBox  ${f(vb.x)},${f(vb.y)}  ${f(vb.w)}×${f(vb.h)}  ar=${f(vb.w / vb.h)}\n` +
      `world    ${f(w.x)}, ${f(w.y)}\n` +
      `Δscreen  ${f(back.x - e.clientX)}, ${f(back.y - e.clientY)}  (should be ~0)`;
  });
})();

console.info(
  "[PhysicsExamDrawer v0.2.6] Pick R (or press R), drag on the canvas to draw a\n" +
    "Press 'd' to toggle the live coord-debug overlay (pointer↔world mapping).\n" +
    "rectangle. Verify with:\n" +
    "  phyDraw.objects()        // array of committed rect objects\n" +
    "  phyDraw.state.get().activeTool   // 'V' after each draw (auto-return)\n" +
    "Wheel = zoom, Space/middle-drag = pan — shapes stay anchored in world space."
);
