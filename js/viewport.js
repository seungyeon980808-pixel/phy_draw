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

// TRUE on-screen scale (px per world unit) honouring preserveAspectRatio="xMidYMid
// meet" letterboxing. getZoom() uses rect.width/vb.w, which is wrong whenever the
// SVG box aspect ratio differs from the viewBox — that mismatch is what made
// committed text resize on commit. The screen CTM's .a is the real meet scale.
export function getRenderScale() {
  if (!_svgRef) return getZoom();
  const m = _svgRef.getScreenCTM();
  return (m && m.a) ? m.a : getZoom();
}

/* ----- center lock: when true, drag-pan is suppressed ----- */
let centerLocked = false;
export function setCenterLocked(val) { centerLocked = val; }

/* ----- setup: wire wheel-zoom + drag-pan onto the SVG element ----- */
function clampViewBox(s) {
  const vb = s.viewBox;
  const abW = s.artboard.w, abH = s.artboard.h;
  // Allow panning up to one artboard-width/height beyond each edge — generous
  // working margin, but a HARD wall so accumulation always stops.
  const marginX = abW, marginY = abH;
  const minX = -abW/2 - marginX;
  const maxX =  abW/2 + marginX - vb.w;
  const minY = -abH/2 - marginY;
  const maxY =  abH/2 + marginY - vb.h;
  // If the view is larger than the allowed span, center on origin instead.
  vb.x = (minX <= maxX) ? Math.min(maxX, Math.max(minX, vb.x)) : -vb.w/2;
  vb.y = (minY <= maxY) ? Math.min(maxY, Math.max(minY, vb.y)) : -vb.h/2;
}

export function initViewport(svg, state, onChange) {
  _svgRef = svg;
  _stateRef = state;

  const ZOOM_STEP = 1.0015; // per wheel delta unit; >1 so deltaY<0 zooms in

  let spaceHeld = false;
  let panning = false;
  let panStart = null; // { sx, sy, vb:{...} }

  // notify caller (main) that viewBox changed → it writes SVG + re-renders
  const commit = () => onChange();

  /* --- wheel: plain = vertical pan, Shift = horizontal pan, Ctrl = zoom --- */
  svg.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.shiftKey) {
        // plain scroll → pan vertically (blocked when centerLocked)
        e.preventDefault();
        if (!centerLocked) {
          state.update((s) => {
            const _rect = svg.getBoundingClientRect();
            s.viewBox.y += (e.deltaY / _rect.height) * s.viewBox.h;
            clampViewBox(s);
          });
          commit();
        }
        return;
      }
      if (e.shiftKey && !e.ctrlKey) {
        // Shift+scroll → pan horizontally (blocked when centerLocked)
        e.preventDefault();
        if (!centerLocked) {
          state.update((s) => {
            const _rect = svg.getBoundingClientRect();
            s.viewBox.x += (e.deltaY / _rect.height) * s.viewBox.h;
            clampViewBox(s);
          });
          commit();
        }
        return;
      }
      // Ctrl+scroll → zoom; when centerLocked, zoom is centered on artboard origin
      e.preventDefault();
      state.update((s) => {
        const vb = s.viewBox;
        const factor = Math.pow(ZOOM_STEP, e.deltaY);
        const _abMax = Math.max(s.artboard.w, s.artboard.h);
        const MIN_W = _abMax * 0.1;
        const MAX_W = _abMax * 2.5;
        const clampedW = Math.min(MAX_W, Math.max(MIN_W, vb.w * factor));
        const k = clampedW / vb.w;
        const newW = vb.w * k;
        const newH = vb.h * k;

        if (centerLocked) {
          vb.w = newW;
          vb.h = newH;
          vb.x = -newW / 2;
          vb.y = -newH / 2;
        } else {
          const before = screenToWorld(svg, vb, e.clientX, e.clientY);
          const rect = svg.getBoundingClientRect();
          const fx = (e.clientX - rect.left) / rect.width;
          const fy = (e.clientY - rect.top) / rect.height;
          vb.w = newW;
          vb.h = newH;
          vb.x = before.x - fx * newW;
          vb.y = before.y - fy * newH;
        }
        clampViewBox(s);
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

    e.preventDefault(); // always suppress middle-click autoscroll
    if (centerLocked) return;
    panning = true;
    const vb = state.get().viewBox;
    panStart = { sx: e.clientX, sy: e.clientY, vb: { ...vb } };
    svg.classList.add("is-panning");
  });

  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    if (!panStart || e.buttons === 0) { panning = false; panStart = null; svg.classList.remove("is-panning"); return; }
    if (centerLocked) return;
    const rect = svg.getBoundingClientRect();
    const start = panStart.vb;
    // convert pixel delta into world delta using the *start* viewBox scale
    const dxWorld = ((e.clientX - panStart.sx) / rect.width) * start.w;
    const dyWorld = ((e.clientY - panStart.sy) / rect.height) * start.h;
    state.update((s) => {
      s.viewBox.x = start.x - dxWorld;
      s.viewBox.y = start.y - dyWorld;
      clampViewBox(s);
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

/* ----- centerView: reposition so artboard (world origin) is centered in view ----- */
export function centerView(state) {
  state.update((s) => {
    s.viewBox.x = -s.viewBox.w / 2;
    s.viewBox.y = -s.viewBox.h / 2;
  });
}
