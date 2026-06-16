/* ===== VIEWPORT (DESIGN 1-2: viewBox zoom/pan, NO CSS transform) ===== */
//
// All zoom/pan is expressed as changes to state.viewBox {x,y,w,h}. The SVG
// viewBox attribute is written from that. Object coordinates never move — only
// the window onto world space does. This keeps hit-testing and fixed-size
// handles (handleSize / zoom) trivial later.

/* ----- module geometry helpers (depend only on the SVG box + viewBox) ----- */

// zoom factor = screen pixels per world unit (uniform; we keep aspect square).
// Derived from how many on-screen pixels one viewBox-width currently spans.
function currentZoom(svg, vb) {
  const rect = svg.getBoundingClientRect();
  return rect.width / vb.w;
}

// world (viewBox) coords -> screen (client) pixels
export function worldToScreen(svg, vb, wx, wy) {
  const rect = svg.getBoundingClientRect();
  return {
    x: rect.left + ((wx - vb.x) / vb.w) * rect.width,
    y: rect.top + ((wy - vb.y) / vb.h) * rect.height,
  };
}

// screen (client) pixels -> world (viewBox) coords.
// Use the SVG's native screen CTM so the conversion honours preserveAspectRatio
// letterboxing (the rendered box is not square). A naive rect.width/height
// divide ignores the centered letterbox and drifts proportionally off-center.
export function screenToWorld(svg, vb, sx, sy) {
  const pt = svg.createSVGPoint();
  pt.x = sx;
  pt.y = sy;
  const w = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: w.x, y: w.y };
}

/* ----- public: current zoom factor (will feed handleSize / zoom later) ----- */
let _svgRef = null;
let _stateRef = null;
export function getZoom() {
  if (!_svgRef || !_stateRef) return 1;
  return currentZoom(_svgRef, _stateRef.get().viewBox);
}

/* ----- setup: wire wheel-zoom + drag-pan onto the SVG element ----- */
export function initViewport(svg, state, onChange) {
  _svgRef = svg;
  _stateRef = state;

  const ZOOM_STEP = 1.0015; // per wheel delta unit; >1 so deltaY<0 zooms in
  const MIN_W = 1;          // most zoomed-in viewBox width (world units)
  const MAX_W = 100000;     // most zoomed-out

  let spaceHeld = false;
  let panning = false;
  let panStart = null; // { sx, sy, vb:{...} }

  // notify caller (main) that viewBox changed → it writes SVG + re-renders
  const commit = () => onChange();

  /* --- wheel zoom, anchored on cursor (world point under cursor stays put) --- */
  svg.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      state.update((s) => {
        const vb = s.viewBox;
        // world point under the cursor before zoom
        const before = screenToWorld(svg, vb, e.clientX, e.clientY);

        const factor = Math.pow(ZOOM_STEP, e.deltaY);
        let newW = vb.w * factor;
        let newH = vb.h * factor;

        // clamp on width, keep aspect via the same factor
        const clampedW = Math.min(MAX_W, Math.max(MIN_W, newW));
        const k = clampedW / vb.w;
        newW = vb.w * k;
        newH = vb.h * k;

        // re-anchor so `before` maps back under the same cursor pixel
        const rect = svg.getBoundingClientRect();
        const fx = (e.clientX - rect.left) / rect.width;
        const fy = (e.clientY - rect.top) / rect.height;
        vb.w = newW;
        vb.h = newH;
        vb.x = before.x - fx * newW;
        vb.y = before.y - fy * newH;
      });
      commit();
    },
    { passive: false }
  );

  /* --- pan start: middle button, or left button while Space held --- */
  svg.addEventListener("mousedown", (e) => {
    const isMiddle = e.button === 1;
    const isSpaceLeft = e.button === 0 && spaceHeld;
    if (!isMiddle && !isSpaceLeft) return;

    e.preventDefault();
    panning = true;
    const vb = state.get().viewBox;
    panStart = { sx: e.clientX, sy: e.clientY, vb: { ...vb } };
    svg.classList.add("is-panning");
  });

  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    const rect = svg.getBoundingClientRect();
    const start = panStart.vb;
    // convert pixel delta into world delta using the *start* viewBox scale
    const dxWorld = ((e.clientX - panStart.sx) / rect.width) * start.w;
    const dyWorld = ((e.clientY - panStart.sy) / rect.height) * start.h;
    state.update((s) => {
      s.viewBox.x = start.x - dxWorld;
      s.viewBox.y = start.y - dyWorld;
    });
    commit();
  });

  window.addEventListener("mouseup", () => {
    if (!panning) return;
    panning = false;
    panStart = null;
    svg.classList.remove("is-panning");
  });

  /* --- Space toggles pan-ready cursor (don't scroll page) --- */
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !spaceHeld) {
      spaceHeld = true;
      svg.classList.add("space-held");
      // avoid page scroll only when canvas is the focus target
      if (e.target === document.body) e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spaceHeld = false;
      svg.classList.remove("space-held");
    }
  });

  // suppress middle-click autoscroll / context menu on the canvas
  svg.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });
}
