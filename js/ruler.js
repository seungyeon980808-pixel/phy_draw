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
let _dragGuideId = null;
let _guideIdCounter = 0;
let _suppressRulerClick = false;
let _hoveredBadgeGuideId = null;
let _coordinateEditor = null;
const _badgeHits = { x: [], y: [] };

const GUIDE_COLOR = "#0969da";
const GUIDE_SELECTED_COLOR = "#0550ae";
const GUIDE_HIT_PX = 6;

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

  const worldPoint = (clientX, clientY) => {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  };

  const addGuide = (axis, e) => {
    const point = worldPoint(e.clientX, e.clientY);
    if (!point) return;
    const id = `guide_${Date.now().toString(36)}_${++_guideIdCounter}`;
    state.update((s) => {
      s.guides.push({ id, axis, position: axis === "x" ? point.x : point.y });
      s.selectedGuideId = id;
      s.selectedIds = [];
      s.targetedId = null;
    });
  };

  const findGuideNearScreenPoint = (axis, clientX, clientY) => {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    let nearest = null;
    let nearestDistance = GUIDE_HIT_PX + 1;
    for (const guide of state.get().guides || []) {
      if (guide.axis !== axis) continue;
      const screen = new DOMPoint(
        axis === "x" ? guide.position : 0,
        axis === "y" ? guide.position : 0
      ).matrixTransform(matrix);
      const distance = Math.abs(axis === "x" ? screen.x - clientX : screen.y - clientY);
      if (distance <= GUIDE_HIT_PX && distance < nearestDistance) {
        nearest = guide;
        nearestDistance = distance;
      }
    }
    return nearest;
  };

  const selectAndStartDrag = (guideId) => {
    _dragGuideId = guideId;
    state.update((s) => {
      s.selectedGuideId = guideId;
      s.selectedIds = [];
      s.targetedId = null;
    });
  };

  const selectGuide = (guideId) => {
    state.update((s) => {
      s.selectedGuideId = guideId;
      s.selectedIds = [];
      s.targetedId = null;
    });
  };

  const findBadgeAtPoint = (canvas, axis, clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return _badgeHits[axis].find((hit) =>
      x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h
    ) || null;
  };

  const closeCoordinateEditor = (commit) => {
    if (!_coordinateEditor) return;
    const { guideId, originalValue, input, element } = _coordinateEditor;
    const trimmed = input.value.trim();
    const value = trimmed === "" ? NaN : Number(trimmed);
    _coordinateEditor = null;
    _suppressRulerClick = false;
    element.remove();

    if (commit && Number.isFinite(value)) {
      state.update((s) => {
        const guide = s.guides.find((item) => item.id === guideId);
        if (guide) guide.position = guide.axis === "x" ? value : -value;
      });
    } else if (commit && !Number.isFinite(value)) {
      state.update((s) => {
        const guide = s.guides.find((item) => item.id === guideId);
        if (guide) guide.position = guide.axis === "x" ? originalValue : -originalValue;
      });
    }
    _scheduleDraw();
  };

  const editGuideCoordinate = (guide, canvas, badge) => {
    if (_coordinateEditor) closeCoordinateEditor(true);
    const container = document.getElementById("ruler-container");
    if (!container || !badge) return;

    const displayedValue = guide.axis === "x" ? guide.position : -guide.position;
    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const element = document.createElement("label");
    element.className = `guide-coordinate-editor${guide.axis === "y" ? " is-vertical" : ""}`;
    element.setAttribute("aria-label", `${guide.axis.toUpperCase()} coordinate in millimeters`);
    element.append("[");
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.value = displayedValue.toFixed(1);
    element.append(input, "] mm");

    const width = guide.axis === "x" ? badge.w : badge.h;
    const centerX = canvasRect.left - containerRect.left + badge.x + badge.w / 2;
    const centerY = canvasRect.top - containerRect.top + badge.y + badge.h / 2;
    element.style.width = `${width}px`;
    element.style.left = `${centerX - width / 2}px`;
    element.style.top = `${centerY - 7}px`;
    container.appendChild(element);
    _coordinateEditor = { guideId: guide.id, originalValue: displayedValue, input, element };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        closeCoordinateEditor(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeCoordinateEditor(false);
      }
    });
    input.addEventListener("blur", () => closeCoordinateEditor(true));
    input.focus();
    input.select();
  };

  const wireRuler = (canvas, axis) => {
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const badge = findBadgeAtPoint(canvas, axis, e.clientX, e.clientY);
      if (badge) {
        e.preventDefault();
        _suppressRulerClick = true;
        selectGuide(badge.guideId);
        const guide = state.get().guides.find((item) => item.id === badge.guideId);
        if (guide) editGuideCoordinate(guide, canvas, badge);
        return;
      }
      const guide = findGuideNearScreenPoint(axis, e.clientX, e.clientY);
      if (!guide) return;
      e.preventDefault();
      _suppressRulerClick = true;
      selectAndStartDrag(guide.id);
    });
    canvas.addEventListener("click", (e) => {
      if (_suppressRulerClick) {
        _suppressRulerClick = false;
        return;
      }
      addGuide(axis, e);
    });
    canvas.addEventListener("mousemove", (e) => {
      const badge = findBadgeAtPoint(canvas, axis, e.clientX, e.clientY);
      const hoveredId = badge ? badge.guideId : null;
      canvas.style.cursor = badge ? "pointer" : "";
      if (_hoveredBadgeGuideId === hoveredId) return;
      _hoveredBadgeGuideId = hoveredId;
      _scheduleDraw();
    });
    canvas.addEventListener("mouseleave", () => {
      canvas.style.cursor = "";
      if (!_hoveredBadgeGuideId) return;
      _hoveredBadgeGuideId = null;
      _scheduleDraw();
    });
  };
  wireRuler(_hCanvas, "x");
  wireRuler(_vCanvas, "y");

  svg.addEventListener("mousedown", (e) => {
    const guideId = e.target && e.target.dataset && e.target.dataset.guideId;
    if (e.button !== 0) return;
    if (!guideId) {
      if (state.get().selectedGuideId) {
        state.update((s) => { s.selectedGuideId = null; });
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    selectAndStartDrag(guideId);
  }, true);

  window.addEventListener("mousemove", (e) => {
    if (!_dragGuideId) return;
    const point = worldPoint(e.clientX, e.clientY);
    if (!point) return;
    state.update((s) => {
      const guide = s.guides.find((item) => item.id === _dragGuideId);
      if (guide) guide.position = guide.axis === "x" ? point.x : point.y;
    });
  });
  window.addEventListener("mouseup", () => {
    if (!_dragGuideId) return;
    _dragGuideId = null;
    _scheduleDraw();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Delete") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const selectedGuideId = state.get().selectedGuideId;
    if (!selectedGuideId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    state.update((s) => {
      s.guides = s.guides.filter((guide) => guide.id !== selectedGuideId);
      s.selectedGuideId = null;
    });
  }, true);

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
    _badgeHits.x = [];
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

    // Continue vertical guides through the ruler so they visually originate here.
    const rulerState = _state.get();
    for (const guide of rulerState.guides || []) {
      if (guide.axis !== "x") continue;
      const px = wxToHpx(guide.position);
      if (px < 0 || px > hw) continue;
      const selected = rulerState.selectedGuideId === guide.id;
      hx.strokeStyle = selected ? GUIDE_SELECTED_COLOR : GUIDE_COLOR;
      hx.globalAlpha = selected ? 0.9 : 0.65;
      hx.lineWidth = selected ? 1.5 : 1;
      hx.beginPath();
      hx.moveTo(px, 0);
      hx.lineTo(px, hh);
      hx.stroke();
      hx.globalAlpha = 1;

      if (selected) {
        const label = `X = ${guide.position.toFixed(1)} mm`;
        hx.font = '9px "IBM Plex Mono", monospace';
        const labelW = hx.measureText(label).width + 8;
        const labelX = Math.max(0, Math.min(hw - labelW, px - labelW / 2));
        hx.fillStyle = GUIDE_SELECTED_COLOR;
        hx.fillRect(labelX, 2, labelW, 14);
        if (_hoveredBadgeGuideId === guide.id) {
          hx.strokeStyle = "rgba(255,255,255,0.45)";
          hx.lineWidth = 1;
          hx.strokeRect(labelX + 0.5, 2.5, labelW - 1, 13);
        }
        _badgeHits.x.push({ guideId: guide.id, x: labelX, y: 2, w: labelW, h: 14 });
        hx.fillStyle = "#fff";
        hx.textBaseline = "middle";
        hx.fillText(label, labelX + 4, 9);
        hx.textBaseline = "top";
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
    _badgeHits.y = [];
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

    // Continue horizontal guides through the ruler and show selected Y in math coordinates.
    const rulerState = _state.get();
    for (const guide of rulerState.guides || []) {
      if (guide.axis !== "y") continue;
      const py = wyToVpx(guide.position);
      if (py < 0 || py > vh) continue;
      const selected = rulerState.selectedGuideId === guide.id;
      vx.strokeStyle = selected ? GUIDE_SELECTED_COLOR : GUIDE_COLOR;
      vx.globalAlpha = selected ? 0.9 : 0.65;
      vx.lineWidth = selected ? 1.5 : 1;
      vx.beginPath();
      vx.moveTo(0, py);
      vx.lineTo(vw, py);
      vx.stroke();
      vx.globalAlpha = 1;

      if (selected) {
        const label = `Y = ${(-guide.position).toFixed(1)} mm`;
        vx.font = '9px "IBM Plex Mono", monospace';
        const labelW = vx.measureText(label).width + 8;
        const labelY = Math.max(labelW / 2, Math.min(vh - labelW / 2, py));
        vx.save();
        vx.translate(vw / 2, labelY);
        vx.rotate(-Math.PI / 2);
        vx.fillStyle = GUIDE_SELECTED_COLOR;
        vx.fillRect(-labelW / 2, -7, labelW, 14);
        if (_hoveredBadgeGuideId === guide.id) {
          vx.strokeStyle = "rgba(255,255,255,0.45)";
          vx.lineWidth = 1;
          vx.strokeRect(-labelW / 2 + 0.5, -6.5, labelW - 1, 13);
        }
        _badgeHits.y.push({
          guideId: guide.id,
          x: vw / 2 - 7,
          y: labelY - labelW / 2,
          w: 14,
          h: labelW,
        });
        vx.fillStyle = "#fff";
        vx.textAlign = "center";
        vx.textBaseline = "middle";
        vx.fillText(label, 0, 0);
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
