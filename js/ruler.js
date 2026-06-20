/* ===== RULER (top & left rulers synced with viewport zoom/pan) ===== */
//
// Uses HTML Canvas 2D for tick rendering. World coordinates (mm) map to ruler
// pixels via the SVG's getScreenCTM() so letterboxing from preserveAspectRatio
// is automatically accounted for. Y labels are inverted (math Y: up = positive)
// to match the inspector display.

let _svg    = null;
let _state  = null;
let _hCanvas = null; // horizontal ruler canvas (top)
let _vCanvas = null; // vertical ruler canvas (left)
let _mouseX  = null; // current mouse screen X, null when off-canvas
let _mouseY  = null;

// Observe the fixed-size wrapper, not the canvas backing stores. Canvas
// width/height updates must not reconnect the observer: observe() itself queues
// a notification and can sustain a frame-by-frame feedback loop.
let _ro = null;

// Throttle redraws to one per animation frame so multiple triggers in a single
// frame (mousemove bursts, store updates, resize) collapse into one _draw().
let _drawScheduled = false;
function _scheduleDraw() {
  if (_drawScheduled) return;
  _drawScheduled = true;
  requestAnimationFrame(() => { _drawScheduled = false; _draw(); });
}

export function initRuler(svg, state) {
  _svg    = svg;
  _state  = state;
  _hCanvas = document.getElementById("ruler-h");
  _vCanvas = document.getElementById("ruler-v");
  if (!_hCanvas || !_vCanvas) return;

  // Guard against double-registration: initRuler may run more than once, which
  // would stack duplicate mousemove listeners and fire _draw many times per move.
  if (initRuler._wired) { _draw(); return; }
  initRuler._wired = true;

  // Redraw whenever the store changes (viewport zoom/pan mutates viewBox via state.update)
  state.subscribe(_scheduleDraw);

  // Crosshair: track mouse over the SVG canvas
  svg.addEventListener("mousemove", (e) => {
    _mouseX = e.clientX;
    _mouseY = e.clientY;
    _scheduleDraw();
  });
  svg.addEventListener("mouseleave", () => {
    _mouseX = null;
    _mouseY = null;
    _scheduleDraw();
  });

  // Redraw when the canvas elements change size (window resize, panel resize)
  _ro = new ResizeObserver(() => { _scheduleDraw(); });
  const rulerContainer = document.getElementById("ruler-container")
                      || _hCanvas.parentElement || _hCanvas;
  _ro.observe(rulerContainer);

  _draw();
}

export function setRulerVisible(visible) {
  const container = document.getElementById("ruler-container");
  if (!container) return;
  container.classList.toggle("rulers-hidden", !visible);
  requestAnimationFrame(_draw);
}

/* ----- read a CSS variable from the root element ----- */
function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ----- main draw: horizontal + vertical ruler ----- */
function _draw() {
  if (!_hCanvas || !_vCanvas || !_svg || !_state) return;

  const m = _svg.getScreenCTM();
  if (!m) return;

  const svgRect = _svg.getBoundingClientRect();
  if (svgRect.width === 0 || svgRect.height === 0) return;

  const dpr        = window.devicePixelRatio || 1;
  const bgColor    = _cssVar("--bg-panel")       || "#2c2c2c";
  const tickColor  = _cssVar("--text-secondary") || "#999";
  const cursorColor = _cssVar("--accent")        || "#0d99ff";

  // px/mm scale (CTM: m.a = horizontal scale, m.d = vertical; both equal for uniform zoom)
  const pxPerMm = Math.abs(m.a);
  // Finest tick step based on zoom: >3px/mm=1mm, 1.5–3=5mm, <1.5=10mm
  const fineStep = pxPerMm > 3 ? 1 : pxPerMm >= 1.5 ? 5 : 10;
  const TICK_COLOR = "rgba(255,255,255,0.7)";

  // Helpers: world mm → ruler-canvas local pixel
  // ruler-h left edge = svgRect.left, ruler-v top edge = svgRect.top
  const wxToHpx = (wx) => m.a * wx + m.e - svgRect.left;
  const wyToVpx = (wy) => m.d * wy + m.f - svgRect.top;

  // ── Horizontal ruler ──────────────────────────────────────────────────────
  const hw = _hCanvas.clientWidth;
  const hh = _hCanvas.clientHeight;
  if (hw > 0 && hh > 0) {
    const _htw = Math.round(hw * dpr), _hth = Math.round(hh * dpr);
    if (_hCanvas._lastW !== _htw || _hCanvas._lastH !== _hth) {
      _hCanvas.width  = _htw;
      _hCanvas.height = _hth;
      _hCanvas._lastW = _htw;
      _hCanvas._lastH = _hth;
    }
    const hx = _hCanvas.getContext("2d");
    hx.setTransform(dpr, 0, 0, dpr, 0, 0);

    hx.fillStyle = bgColor;
    hx.fillRect(0, 0, hw, hh);

    // Artboard range highlight on H ruler
    hx.fillStyle = "rgba(255,255,255,0.15)";
    hx.fillRect(0, 0, hw, hh);
    const { w: _abW } = _state.get().artboard;
    const _abHL = wxToHpx(-_abW / 2);
    const _abHR = wxToHpx( _abW / 2);
    const _hClipL = Math.max(0, _abHL);
    const _hClipR = Math.min(hw, _abHR);
    if (_hClipR > _hClipL) {
      hx.fillStyle = "rgba(0,0,0,0.35)";
      hx.fillRect(_hClipL, 0, _hClipR - _hClipL, hh);
    }

    hx.font        = '9px "IBM Plex Mono", monospace';
    hx.textBaseline = "top";

    const startWX = (svgRect.left  - m.e) / m.a;
    const endWX   = (svgRect.right - m.e) / m.a;
    const first   = Math.ceil(startWX / fineStep) * fineStep;

    for (let wx = first; wx <= endWX + fineStep; wx += fineStep) {
      const px  = wxToHpx(wx);
      if (px < -1 || px > hw + 1) continue;
      const mm  = Math.round(wx);
      let tickLen, lineW;
      if (mm % 10 === 0)      { tickLen = 10; lineW = 1;   }
      else if (mm % 5 === 0)  { tickLen = 6;  lineW = 0.5; }
      else                    { tickLen = 3;  lineW = 0.5; }

      hx.strokeStyle = TICK_COLOR;
      hx.fillStyle   = TICK_COLOR;
      hx.lineWidth   = lineW;
      hx.beginPath();
      hx.moveTo(px, hh);
      hx.lineTo(px, hh - tickLen);
      hx.stroke();

      if (mm % 10 === 0) {
        hx.fillText(String(mm), px + 2, 2);
      }
    }

    // Cursor crosshair line on H ruler
    if (_mouseX !== null) {
      const cpx = _mouseX - svgRect.left;
      if (cpx >= 0 && cpx <= hw) {
        hx.strokeStyle = cursorColor;
        hx.lineWidth   = 1;
        hx.beginPath();
        hx.moveTo(cpx, 0);
        hx.lineTo(cpx, hh);
        hx.stroke();
      }
    }
  }

  // ── Vertical ruler ────────────────────────────────────────────────────────
  const vw = _vCanvas.clientWidth;
  const vh = _vCanvas.clientHeight;
  if (vw > 0 && vh > 0) {
    const _vtw = Math.round(vw * dpr), _vth = Math.round(vh * dpr);
    if (_vCanvas._lastW !== _vtw || _vCanvas._lastH !== _vth) {
      _vCanvas.width  = _vtw;
      _vCanvas.height = _vth;
      _vCanvas._lastW = _vtw;
      _vCanvas._lastH = _vth;
    }
    const vx = _vCanvas.getContext("2d");
    vx.setTransform(dpr, 0, 0, dpr, 0, 0);

    vx.fillStyle = bgColor;
    vx.fillRect(0, 0, vw, vh);

    // Artboard range highlight on V ruler
    vx.fillStyle = "rgba(255,255,255,0.15)";
    vx.fillRect(0, 0, vw, vh);
    const { h: _abH } = _state.get().artboard;
    const _abVT = wyToVpx(-_abH / 2);
    const _abVB = wyToVpx( _abH / 2);
    const _vClipT = Math.max(0, _abVT);
    const _vClipB = Math.min(vh, _abVB);
    if (_vClipB > _vClipT) {
      vx.fillStyle = "rgba(0,0,0,0.35)";
      vx.fillRect(0, _vClipT, vw, _vClipB - _vClipT);
    }

    vx.font        = '9px "IBM Plex Mono", monospace';

    const startWY = (svgRect.top    - m.f) / m.d;
    const endWY   = (svgRect.bottom - m.f) / m.d;
    const firstY  = Math.ceil(startWY / fineStep) * fineStep;

    for (let wy = firstY; wy <= endWY + fineStep; wy += fineStep) {
      const py  = wyToVpx(wy);
      if (py < -1 || py > vh + 1) continue;
      const mm  = Math.round(wy);
      let tickLen, lineW;
      if (mm % 10 === 0)      { tickLen = 10; lineW = 1;   }
      else if (mm % 5 === 0)  { tickLen = 6;  lineW = 0.5; }
      else                    { tickLen = 3;  lineW = 0.5; }

      vx.strokeStyle = TICK_COLOR;
      vx.fillStyle   = TICK_COLOR;
      vx.lineWidth   = lineW;
      vx.beginPath();
      vx.moveTo(vw, py);
      vx.lineTo(vw - tickLen, py);
      vx.stroke();

      if (mm % 10 === 0) {
        // Display math Y = -worldY (invert because SVG Y increases downward)
        const label = String(Math.round(-wy));
        vx.save();
        vx.translate(vw - 2, py);
        vx.rotate(-Math.PI / 2);
        vx.textBaseline = "bottom";
        vx.fillText(label, -2, 0);
        vx.restore();
      }
    }

    // Cursor crosshair line on V ruler
    if (_mouseY !== null) {
      const cpy = _mouseY - svgRect.top;
      if (cpy >= 0 && cpy <= vh) {
        vx.strokeStyle = cursorColor;
        vx.lineWidth   = 1;
        vx.beginPath();
        vx.moveTo(0, cpy);
        vx.lineTo(vw, cpy);
        vx.stroke();
      }
    }
  }
}
