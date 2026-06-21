/* ===== INSPECTOR (right panel — shows/edits selected object properties) ===== */

import { TEXT_FONTS, DEFAULT_TEXT_FONT, mmToPt, ptToMm } from "./state.js?v=0.40.6";
import { openFontModalForSelection } from "./tools.js?v=0.40.6";

const GRAY_LEVELS = [0, 43, 85, 128, 170, 213, 255];
const SHAPE_TYPES = ["rect", "ellipse", "triangle"];
// Branch-B "line family": share arrow + dash controls; fill section is hidden for them.
const LINE_TYPES = ["line", "polyline", "curve"];
const DASH_TYPES = [...SHAPE_TYPES, ...LINE_TYPES];
// Dash presets (world units / mm). 실선 = (0,0) = solid (no dasharray).
const DASH_PRESETS = [
  { label: "실선",  dashLength: 0, dashGap: 0 },
  { label: "점선1", dashLength: 0.2, dashGap: 0.2 },
  { label: "점선2", dashLength: 0.5, dashGap: 0.3 },
  { label: "점선3", dashLength: 1.0, dashGap: 0.3 },
];

// True while user is dragging a color picker bar — suppresses populate() re-entry.
let _dragging = false;

function levelToHex(v) {
  const h = Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

/* ===== Reusable color picker widget =====
 * onInput(level) — fires continuously on drag / swatch click
 * onStart()      — fires at drag/click start, before any state change (for snapshot)
 * onCommit()     — fires at drag end / swatch click end (push undo snapshot here)
 */
function makeColorPicker(onInput, onStart, onCommit) {
  const root = document.createElement("div");
  root.className = "cp-root";

  const palette = document.createElement("div");
  palette.className = "cp-palette";

  // Slider + numeric box live on one row (number is right-aligned next to the bar).
  const barRow = document.createElement("div");
  barRow.className = "cp-bar-row";
  const barWrap = document.createElement("div");
  barWrap.className = "cp-bar-wrap";
  const bar = document.createElement("div");
  bar.className = "cp-bar";
  const handle = document.createElement("div");
  handle.className = "cp-handle";
  barWrap.appendChild(bar);
  barWrap.appendChild(handle);

  // Numeric level input. Shown value = "darkness" 0..255 (0 = white, 255 = black),
  // which is the inverse of the internal grayscale level (0 = black, 255 = white)
  // used by the renderer — so saved-file/render semantics stay untouched.
  const numInput = document.createElement("input");
  numInput.type = "number";
  numInput.min = "0";
  numInput.max = "255";
  numInput.step = "1";
  numInput.className = "cp-num-input";

  barRow.appendChild(barWrap);
  barRow.appendChild(numInput);

  const preview = document.createElement("div");
  preview.className = "cp-preview";

  root.appendChild(palette);
  root.appendChild(barRow);
  root.appendChild(preview);

  let _level = 0;

  function setLevel(v, fire) {
    _level = Math.round(Math.max(0, Math.min(255, v)));
    const pct = (1 - _level / 255) * 100; // left=white=255, right=black=0
    handle.style.left = `${pct}%`;
    preview.style.background = levelToHex(_level);
    // Don't clobber the field while the user is typing in it.
    if (document.activeElement !== numInput) numInput.value = 255 - _level;
    if (fire && onInput) onInput(_level);
  }

  // Numeric box: type a darkness value (0=white..255=black), apply on Enter/blur.
  numInput.addEventListener("focus", () => { if (onStart) onStart(); });
  function applyNum() {
    const raw = parseInt(numInput.value, 10);
    if (!isFinite(raw)) return;
    const darkness = Math.max(0, Math.min(255, raw));
    numInput.value = darkness;           // reflect clamped/parsed value
    setLevel(255 - darkness, true);      // darkness → internal level, render + fire
  }
  numInput.addEventListener("keydown", (e) => { if (e.key === "Enter") numInput.blur(); });
  numInput.addEventListener("change", () => { applyNum(); if (onCommit) onCommit(); });

  function levelFromX(e) {
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return Math.round((1 - pct) * 255);
  }

  // Palette swatches
  GRAY_LEVELS.forEach((g) => {
    const sw = document.createElement("div");
    sw.className = "cp-swatch";
    sw.style.background = levelToHex(g);
    sw.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (onStart) onStart();
      setLevel(g, true);
      if (onCommit) onCommit();
    });
    palette.appendChild(sw);
  });

  // Bar and handle share the same drag handler
  function startBarDrag(e) {
    e.preventDefault();
    if (onStart) onStart();      // capture snapshot BEFORE first change
    _dragging = true;            // suppress populate() re-entry during drag
    setLevel(levelFromX(e), true);

    function onMove(e2) { setLevel(levelFromX(e2), true); }
    function onUp() {
      _dragging = false;
      if (onCommit) onCommit();  // push undo snapshot
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  bar.addEventListener("mousedown", startBarDrag);
  handle.addEventListener("mousedown", startBarDrag);

  return {
    el: root,
    setValue(v) { setLevel(v, false); },
    setDisabled(flag) {
      root.style.opacity = flag ? "0.4" : "";
      root.style.pointerEvents = flag ? "none" : "";
    },
  };
}

/* ----- Collapsible section wrapper ----- */
function makeSection(title, bodyEl) {
  const details = document.createElement("details");
  details.open = true;
  details.className = "insp-section";
  const summary = document.createElement("summary");
  summary.className = "insp-summary";
  summary.textContent = title;
  details.appendChild(summary);
  details.appendChild(bodyEl);
  return details;
}

/* ===== PUBLIC ===== */
export function initInspector(state) {
  const emptyEl   = document.getElementById("inspector-empty");
  const contentEl = document.getElementById("inspector-content");
  if (!emptyEl || !contentEl) return;

  // Click-to-select-all: focusing any number input selects its value so a typed
  // digit replaces the old value instead of inserting into it.
  contentEl.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t && t.tagName === "INPUT" && t.type === "number") t.select();
  });

  // Wire left-edge resize handle
  const resizeHandle = document.getElementById("inspector-resize");
  const panelRight = document.querySelector(".panel-right");
  if (resizeHandle && panelRight) {
    resizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panelRight.offsetWidth;
      function onMove(e2) {
        const newW = Math.min(480, Math.max(200, startW + (startX - e2.clientX)));
        panelRight.style.width = newW + "px";
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  // Capture a full objects snapshot from current state (for undo)
  function snapBefore() {
    const s = state.get();
    const ids = s.selectedIds || [];
    return ids.length ? JSON.parse(JSON.stringify(s.objects)) : null;
  }

  function pushSnap(snap) {
    if (!snap) return;
    state.update((s) => { s.undoStack.push(snap); s.redoStack = []; });
  }

  /* ---- Section 1: 선 ---- */
  const sec1Body = document.createElement("div");
  sec1Body.className = "insp-body";

  let _strokeSnap = null;
  const strokeCP = makeColorPicker(
    (lv) => {
      const s = state.get();
      const ids = s.selectedIds || [];
      if (!ids.length) return;
      state.update((s2) => {
        (s2.selectedIds || []).forEach(id => {
          const o = s2.objects.find((o) => o.id === id);
          if (o) o.strokeLevel = lv;
        });
      });
    },
    () => { _strokeSnap = snapBefore(); },
    () => { pushSnap(_strokeSnap); _strokeSnap = null; }
  );
  sec1Body.appendChild(strokeCP.el);

  // Stroke width row
  const widthRow = document.createElement("div");
  widthRow.className = "insp-row";
  const widthLbl = document.createElement("label");
  widthLbl.className = "insp-field-label";
  widthLbl.textContent = "선 굵기";
  const widthRange = document.createElement("input");
  widthRange.type = "range";
  widthRange.min = "0.1";
  widthRange.max = "0.5";
  widthRange.step = "0.1";
  widthRange.className = "insp-range";
  const widthNum = document.createElement("input");
  widthNum.type = "number";
  widthNum.min = "0.1";
  widthNum.max = "0.5";
  widthNum.step = "0.1";
  widthNum.style.cssText = "width:40px;font-size:11px;border:1px solid #3a3c41;border-radius:3px;padding:2px 4px;text-align:center;background:#1e1f22;color:#dcddde;";
  const widthUnit = document.createElement("span");
  widthUnit.textContent = "mm";
  widthUnit.className = "insp-unit";
  widthRow.appendChild(widthLbl);
  widthRow.appendChild(widthRange);
  widthRow.appendChild(widthNum);
  widthRow.appendChild(widthUnit);
  sec1Body.appendChild(widthRow);

  // Arrow head control (line objects only)
  const arrowRow = document.createElement("div");
  arrowRow.className = "insp-row";
  const arrowLbl = document.createElement("label");
  arrowLbl.className = "insp-field-label";
  arrowLbl.textContent = "화살표";
  const arrowBtns = document.createElement("div");
  arrowBtns.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
  // 40×24 inline-SVG previews: horizontal line + barbed arrowhead(s).
  const ARROW_ICONS = {
    none:   '<line x1="4" y1="12" x2="36" y2="12" stroke="#888" stroke-width="1.5"/>',
    end:    '<line x1="4" y1="12" x2="30" y2="12" stroke="#888" stroke-width="1.5"/>' +
            '<polygon points="30,8 36,12 30,16" fill="#888"/>',
    start:  '<line x1="10" y1="12" x2="36" y2="12" stroke="#888" stroke-width="1.5"/>' +
            '<polygon points="10,8 4,12 10,16" fill="#888"/>',
    center: '<line x1="4" y1="12" x2="36" y2="12" stroke="#888" stroke-width="1.5"/>' +
            '<polygon points="14,8 20,12 14,16" fill="#888"/>',
    both:   '<line x1="4" y1="12" x2="36" y2="12" stroke="#888" stroke-width="1.5"/>' +
            '<polygon points="10,8 4,12 10,16" fill="#888"/>' +
            '<polygon points="30,8 36,12 30,16" fill="#888"/>',
  };
  const MIDDLE_LEFT_ICON = '<line x1="4" y1="12" x2="36" y2="12" stroke="#888" stroke-width="1.5"/>' +
    '<polygon points="26,8 20,12 26,16" fill="#888"/>';
  const lengthIcon = (variant) => ARROW_ICONS.both +
    ((variant === "leftBar" || variant === "bothBars") ? '<line x1="4" y1="6" x2="4" y2="18" stroke="#888" stroke-width="1.5"/>' : '') +
    ((variant === "rightBar" || variant === "bothBars") ? '<line x1="36" y1="6" x2="36" y2="18" stroke="#888" stroke-width="1.5"/>' : '');
  const ARROW_CYCLE = ["end", "start", "both", "none"];
  const ARROW_LABELS = { end: "정방향", start: "역방향", both: "양끝", none: "없음" };
  const arrowBtn = document.createElement("button");
  arrowBtn.style.cssText = "width:40px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
  arrowBtn.addEventListener("click", () => {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (o && (o.type === "line" || o.type === "polyline")) {
        const current = ARROW_CYCLE.includes(o.arrowHead) ? o.arrowHead : "none";
        o.arrowHead = ARROW_CYCLE[(ARROW_CYCLE.indexOf(current) + 1) % ARROW_CYCLE.length];
        s2.undoStack.push(snap);
        s2.redoStack = [];
      }
    });
  });
  arrowBtns.appendChild(arrowBtn);
  arrowRow.appendChild(arrowLbl);
  arrowRow.appendChild(arrowBtns);
  sec1Body.appendChild(arrowRow);

  // Straight-line mode dials. Re-clicking the active mode advances its variant.
  const lineModeRow = document.createElement("div");
  lineModeRow.className = "insp-row";
  const lineModeLbl = document.createElement("label");
  lineModeLbl.className = "insp-field-label";
  lineModeLbl.textContent = "Line mode";
  const lineModeBtns = document.createElement("div");
  lineModeBtns.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
  const LINE_MODES = [
    { value: "solid", label: "Solid", icon: ARROW_ICONS.none },
    { value: "arrow", label: "Arrow", icon: ARROW_ICONS.end },
    { value: "middleArrow", label: "Middle arrow", icon: ARROW_ICONS.center },
    { value: "lengthArrow", label: "Length arrow", icon: ARROW_ICONS.both },
  ];
  const lineModeBtnEls = {};
  LINE_MODES.forEach(({ value, label, icon }) => {
    const btn = document.createElement("button");
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = `<svg width="40" height="24" viewBox="0 0 40 24">${icon}</svg>`;
    btn.style.cssText = "width:40px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
    btn.addEventListener("click", () => {
      const s = state.get();
      const ids = s.selectedIds || [];
      if (ids.length !== 1) return;
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const o = s2.objects.find((item) => item.id === ids[0]);
        if (!o || o.type !== "line") return;
        const oldMode = o.lineMode
          ?? (o.lineStyle === "dimensionArrow" ? "lengthArrow" : o.lineStyle)
          ?? (o.arrowHead === "center" ? "middleArrow" : (o.arrowHead ?? "none") === "none" ? "solid" : "arrow");
        if (value === "arrow") {
          const cycle = ["right", "left", "both"];
          const current = cycle.includes(o.arrowVariant)
            ? o.arrowVariant
            : ({ end: "right", start: "left", both: "both" }[o.arrowHead] || "right");
          o.arrowVariant = oldMode === value ? cycle[(cycle.indexOf(current) + 1) % cycle.length] : "right";
          o.arrowHead = { right: "end", left: "start", both: "both" }[o.arrowVariant];
        } else if (value === "middleArrow") {
          const current = o.arrowVariant === "left" ? "left" : "right";
          o.arrowVariant = oldMode === value && current === "right" ? "left" : "right";
          o.arrowHead = "none";
        } else if (value === "lengthArrow") {
          const cycle = ["basic", "rightBar", "leftBar", "bothBars"];
          const current = cycle.includes(o.dimensionVariant) ? o.dimensionVariant : "basic";
          o.dimensionVariant = oldMode === value ? cycle[(cycle.indexOf(current) + 1) % cycle.length] : "basic";
          o.dimensionLabel ??= "d";
          o.arrowHead = "none";
        } else {
          o.arrowHead = "none";
        }
        o.lineMode = value;
        o.lineStyle = value === "lengthArrow" ? "dimensionArrow" : value;
        s2.undoStack.push(snap);
        s2.redoStack = [];
      });
    });
    lineModeBtnEls[value] = btn;
    lineModeBtns.appendChild(btn);
  });
  lineModeRow.appendChild(lineModeLbl);
  lineModeRow.appendChild(lineModeBtns);
  sec1Body.appendChild(lineModeRow);

  const dimensionLabelRow = document.createElement("div");
  dimensionLabelRow.className = "insp-row";
  const dimensionLabelLbl = document.createElement("label");
  dimensionLabelLbl.className = "insp-field-label";
  dimensionLabelLbl.textContent = "Label";
  const dimensionLabelInp = document.createElement("input");
  dimensionLabelInp.type = "text";
  dimensionLabelInp.maxLength = 40;
  dimensionLabelInp.style.cssText = "width:90px;font-size:11px;border:1px solid #3a3c41;border-radius:3px;padding:3px 5px;background:#1e1f22;color:#dcddde;";
  dimensionLabelInp.addEventListener("change", () => {
    const s = state.get();
    const id = (s.selectedIds || [])[0];
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((item) => item.id === id);
      if (!o || o.type !== "line") return;
      o.dimensionLabel = dimensionLabelInp.value || "d";
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  });
  dimensionLabelRow.appendChild(dimensionLabelLbl);
  dimensionLabelRow.appendChild(dimensionLabelInp);
  sec1Body.appendChild(dimensionLabelRow);

  // ---- Dash presets + length/gap sliders (line/polyline/curve) ----
  const dashRow = document.createElement("div");
  dashRow.className = "insp-row";
  const dashLbl = document.createElement("label");
  dashLbl.className = "insp-field-label";
  dashLbl.textContent = "선 종류";
  const dashBtns = document.createElement("div");
  dashBtns.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
  // 40×24 inline-SVG line previews, keyed by preset label (constant left untouched).
  const DASH_ICONS = {
    "실선":  '<line x1="2" y1="12" x2="38" y2="12" stroke="#888" stroke-width="2"/>',
    "점선1": '<line x1="2" y1="12" x2="38" y2="12" stroke="#888" stroke-width="2" stroke-dasharray="4 3"/>',
    "점선2": '<line x1="2" y1="12" x2="38" y2="12" stroke="#888" stroke-width="2" stroke-dasharray="8 3"/>',
    "점선3": '<line x1="2" y1="12" x2="38" y2="12" stroke="#888" stroke-width="2" stroke-dasharray="2 2"/>',
  };
  const _dashBtnEls = [];
  DASH_PRESETS.forEach((preset) => {
    const btn = document.createElement("button");
    btn.title = preset.label;
    btn.innerHTML = `<svg width="40" height="24" viewBox="0 0 40 24">${DASH_ICONS[preset.label] || ""}</svg>`;
    btn.style.cssText = "width:40px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
    btn.addEventListener("click", () => {
      const s = state.get();
      const ids = s.selectedIds || [];
      if (ids.length !== 1) return;
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const o = s2.objects.find((o) => o.id === ids[0]);
        if (o && DASH_TYPES.includes(o.type)) {
          o.dashLength = preset.dashLength;
          o.dashGap = preset.dashGap;
          s2.undoStack.push(snap);
          s2.redoStack = [];
        }
      });
    });
    _dashBtnEls.push(btn);
    dashBtns.appendChild(btn);
  });
  dashRow.appendChild(dashLbl);
  dashRow.appendChild(dashBtns);
  sec1Body.appendChild(dashRow);

  // Length/gap sliders — visible only when a dashed preset is active (dashLength > 0).
  function makeDashSliderRow(labelText, prop) {
    const row = document.createElement("div");
    row.className = "insp-row";
    const lbl = document.createElement("label");
    lbl.className = "insp-field-label";
    lbl.textContent = labelText;
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0.2";
    range.max = "1.5";
    range.step = "0.1";
    range.className = "insp-range";
    const num = document.createElement("input");
    num.type = "number";
    num.min = "0.2";
    num.max = "1.5";
    num.step = "0.1";
    num.style.cssText = "width:40px;font-size:11px;border:1px solid #3a3c41;border-radius:3px;padding:2px 4px;text-align:center;background:#1e1f22;color:#dcddde;";
    const unit = document.createElement("span");
    unit.textContent = "mm";
    unit.className = "insp-unit";
    row.appendChild(lbl);
    row.appendChild(range);
    row.appendChild(num);
    row.appendChild(unit);

    function apply(val) {
      const s = state.get();
      const ids = s.selectedIds || [];
      if (ids.length !== 1) return;
      state.update((s2) => {
        const o = s2.objects.find((o) => o.id === ids[0]);
        if (o && DASH_TYPES.includes(o.type)) o[prop] = val;
      });
    }

    let _snap = null;
    range.addEventListener("mousedown", () => { _snap = snapBefore(); });
    range.addEventListener("input", () => {
      const val = parseFloat(range.value);
      num.value = val.toFixed(1);
      apply(val);
    });
    range.addEventListener("change", () => { pushSnap(_snap); _snap = null; });

    let _numSnap = null;
    num.addEventListener("focus", () => { _numSnap = snapBefore(); });
    num.addEventListener("input", () => {
      const raw = parseFloat(num.value);
      if (!isFinite(raw)) return;
      const val = Math.min(1.5, Math.max(0.2, Math.round(raw * 10) / 10));
      range.value = val;
      apply(val);
    });
    num.addEventListener("change", () => { pushSnap(_numSnap); _numSnap = null; });

    return { el: row, range, num };
  }

  const dashSliders = document.createElement("div");
  dashSliders.style.cssText = "display:flex;flex-direction:column;gap:5px;";
  const dashLenSlider = makeDashSliderRow("길이", "dashLength");
  const dashGapSlider = makeDashSliderRow("간격", "dashGap");
  dashSliders.appendChild(dashLenSlider.el);
  dashSliders.appendChild(dashGapSlider.el);
  sec1Body.appendChild(dashSliders);

  // ---- 닫기 toggle (single polyline only): off = open <polyline>, on = filled <polygon>.
  // Turning it on flips obj.closed; populate() then reveals the 채우기 section.
  const closeRow = document.createElement("div");
  closeRow.className = "insp-row";
  const closeCb = document.createElement("input");
  closeCb.type = "checkbox";
  closeCb.className = "insp-cb";
  const closeLbl = document.createElement("label");
  closeLbl.className = "insp-field-label";
  closeLbl.textContent = "닫기";
  closeRow.appendChild(closeCb);
  closeRow.appendChild(closeLbl);
  sec1Body.appendChild(closeRow);

  closeCb.addEventListener("change", () => {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = snapBefore();
    const val = closeCb.checked;
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (o && (o.type === "polyline" || o.type === "curve")) {
        s2.undoStack.push(snap);
        s2.redoStack = [];
        o.closed = val;
      }
    });
  });

  // Highlight the active preset button (or none, for a custom slider value).
  function syncDashControls(obj) {
    const dl = obj.dashLength ?? 0;
    const dg = obj.dashGap ?? 0;
    _dashBtnEls.forEach((btn, i) => {
      const p = DASH_PRESETS[i];
      const active = p.dashLength === dl && p.dashGap === dg;
      btn.style.background = active ? "#4a9eff" : "#1e1f22";
      btn.style.color      = active ? "#ffffff" : "#dcddde";
      btn.style.border     = active ? "1px solid #4a9eff" : "1px solid #3a3c41";
    });
    const dashed = dl > 0;
    dashSliders.style.display = dashed ? "" : "none";
    if (dashed) {
      dashLenSlider.range.value = dl; dashLenSlider.num.value = dl.toFixed(1);
      dashGapSlider.range.value = dg; dashGapSlider.num.value = dg.toFixed(1);
    }
  }

  let _widthSnap = null;
  widthRange.addEventListener("mousedown", () => { _widthSnap = snapBefore(); });
  widthRange.addEventListener("input", () => {
    const val = parseFloat(widthRange.value);
    widthNum.value = val.toFixed(1);
    const s = state.get();
    const ids = s.selectedIds || [];
    if (!ids.length) return;
    state.update((s2) => {
      (s2.selectedIds || []).forEach(id => {
        const o = s2.objects.find((o) => o.id === id);
        if (o) o.strokeWidth = val;
      });
    });
  });
  widthRange.addEventListener("change", () => { pushSnap(_widthSnap); _widthSnap = null; });

  let _widthNumSnap = null;
  widthNum.addEventListener("focus", () => { _widthNumSnap = snapBefore(); });
  widthNum.addEventListener("input", () => {
    const raw = parseFloat(widthNum.value);
    if (!isFinite(raw)) return;
    const val = Math.min(0.5, Math.max(0.1, Math.round(raw * 10) / 10));
    widthRange.value = val;
    const s = state.get();
    const ids = s.selectedIds || [];
    if (!ids.length) return;
    state.update((s2) => {
      (s2.selectedIds || []).forEach(id => {
        const o = s2.objects.find((o) => o.id === id);
        if (o) o.strokeWidth = val;
      });
    });
  });
  widthNum.addEventListener("change", () => { pushSnap(_widthNumSnap); _widthNumSnap = null; });

  // ---- Group section: 개체 풀기 button (shown in targeted and group-selected states) ----
  const groupDiv = document.createElement("div");
  groupDiv.className = "insp-body";
  groupDiv.style.cssText = "padding: 6px 8px;";
  const ungroupBtn = document.createElement("button");
  ungroupBtn.textContent = "개체 풀기";
  ungroupBtn.style.cssText = "padding:4px 10px;font-size:11px;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;width:100%;";
  ungroupBtn.addEventListener("click", () => {
    const s = state.get();
    const refId = s.targetedId || (s.selectedIds || [])[0];
    const refObj = s.objects.find((o) => o.id === refId);
    if (!refObj || !refObj.groupId) return;
    const groupId = refObj.groupId;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const grp = s2.groups.find((g) => g.id === groupId);
      if (grp) grp.memberIds.forEach(id => {
        const o = s2.objects.find((o) => o.id === id);
        if (o) delete o.groupId;
      });
      s2.groups = s2.groups.filter((g) => g.id !== groupId);
      s2.targetedId = null;
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  });
  groupDiv.appendChild(ungroupBtn);
  contentEl.appendChild(groupDiv);

  // ---- 묶기 button: shown for an ungrouped multi-selection (ids>1 && !allInGroup) ----
  const groupBtnDiv = document.createElement("div");
  groupBtnDiv.className = "insp-body";
  groupBtnDiv.style.cssText = "padding: 6px 8px;";
  groupBtnDiv.style.display = "none";
  const groupBtn = document.createElement("button");
  groupBtn.textContent = "묶기";
  groupBtn.style.cssText = "padding:4px 10px;font-size:11px;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;width:100%;";
  groupBtn.addEventListener("click", () => {
    // Mirrors the G-key group-creation logic in transform.js.
    const s = state.get();
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const groupId = Date.now().toString();
      // locked objects are excluded; need ≥2 mutable members left to form a group
      const memberIds = (s2.selectedIds || []).filter(id =>
        !(s2.objects.find((o) => o.id === id)?.locked));
      if (memberIds.length < 2) return;
      memberIds.forEach(id => {
        const o = s2.objects.find((o) => o.id === id);
        if (o) o.groupId = groupId;
      });
      s2.groups.push({ id: groupId, memberIds });
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  });
  groupBtnDiv.appendChild(groupBtn);
  contentEl.appendChild(groupBtnDiv);

  // ---- 각도 (straight line only): set the line's angle in degrees ----
  // angle = atan2(p2.y - p1.y, p2.x - p1.x). Editing rotates the line about its
  // midpoint, preserving length. Axis-aligned angles snap to an exact horizontal
  // / vertical so 0° / 90° land precisely. One undo entry per edit.
  const angleRow = document.createElement("div");
  angleRow.className = "insp-row";
  const angleLbl = document.createElement("label");
  angleLbl.className = "insp-field-label";
  angleLbl.textContent = "각도";
  const angleInp = document.createElement("input");
  angleInp.type = "number";
  angleInp.step = "1";
  angleInp.className = "insp-input";
  const angleUnit = document.createElement("span");
  angleUnit.className = "insp-unit";
  angleUnit.textContent = "°";
  angleRow.appendChild(angleLbl);
  angleRow.appendChild(angleInp);
  angleRow.appendChild(angleUnit);
  sec1Body.appendChild(angleRow);

  function commitAngle() {
    const val = parseFloat(angleInp.value);
    if (!isFinite(val)) return;
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (!o || o.type !== "line" || o.locked) return;
      const mx = (o.p1.x + o.p2.x) / 2, my = (o.p1.y + o.p2.y) / 2;
      const len = Math.hypot(o.p2.x - o.p1.x, o.p2.y - o.p1.y);
      const rad = (val * Math.PI) / 180;
      let nx = Math.cos(rad), ny = Math.sin(rad);
      const n = ((val % 360) + 360) % 360;
      if (n === 0 || n === 180) ny = 0;   // exact horizontal
      if (n === 90 || n === 270) nx = 0;  // exact vertical
      const hx = (nx * len) / 2, hy = (ny * len) / 2;
      o.p1 = { x: mx - hx, y: my - hy };
      o.p2 = { x: mx + hx, y: my + hy };
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  }
  angleInp.addEventListener("keydown", (e) => { if (e.key === "Enter") angleInp.blur(); });
  angleInp.addEventListener("blur", commitAngle);

  const sec1 = makeSection("선", sec1Body);
  contentEl.appendChild(sec1);

  /* ---- Section (text only): 글꼴 (font family + size) ----
   * Edits the SAME obj.fontFamily / obj.fontSize fields the right-click menu uses.
   * Each change pushes one undo snapshot so Ctrl+Z reverts it. */
  const secTextBody = document.createElement("div");
  secTextBody.className = "insp-body";

  const fontFamRow = document.createElement("div");
  fontFamRow.className = "insp-row";
  const fontFamLbl = document.createElement("label");
  fontFamLbl.className = "insp-field-label";
  fontFamLbl.textContent = "글꼴";
  const fontFamSel = document.createElement("select");
  fontFamSel.style.cssText = "flex:1;min-width:0;font-size:12px;border:1px solid #3a3c41;border-radius:3px;padding:2px 4px;background:#1e1f22;color:#dcddde;";
  TEXT_FONTS.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.css;
    opt.textContent = f.label;
    fontFamSel.appendChild(opt);
  });
  fontFamRow.appendChild(fontFamLbl);
  fontFamRow.appendChild(fontFamSel);
  secTextBody.appendChild(fontFamRow);

  const fontSizeRow = document.createElement("div");
  fontSizeRow.className = "insp-row";
  const fontSizeLbl = document.createElement("label");
  fontSizeLbl.className = "insp-field-label";
  fontSizeLbl.textContent = "크기";
  const fontSizeNum = document.createElement("input");
  fontSizeNum.type = "number";
  fontSizeNum.min = "1";
  fontSizeNum.max = "400";
  fontSizeNum.step = "1";
  fontSizeNum.style.cssText = "width:56px;font-size:11px;border:1px solid #3a3c41;border-radius:3px;padding:2px 4px;text-align:center;background:#1e1f22;color:#dcddde;";
  const fontSizeUnit = document.createElement("span");
  fontSizeUnit.textContent = "pt"; // points; stored fontSize is world-unit mm
  fontSizeUnit.className = "insp-unit";
  fontSizeRow.appendChild(fontSizeLbl);
  fontSizeRow.appendChild(fontSizeNum);
  fontSizeRow.appendChild(fontSizeUnit);
  secTextBody.appendChild(fontSizeRow);

  function applyTextProp(prop, value) {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (!o || o.type !== "text") return;
      o[prop] = value;
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  }
  fontFamSel.addEventListener("change", () => applyTextProp("fontFamily", fontFamSel.value));
  fontSizeNum.addEventListener("change", () => {
    const v = parseFloat(fontSizeNum.value); // entered in pt → store mm
    if (isFinite(v) && v > 0) applyTextProp("fontSize", ptToMm(v));
  });
  fontSizeNum.addEventListener("keydown", (e) => { if (e.key === "Enter") fontSizeNum.blur(); });

  // 글꼴 설정... — opens the same modal the right-click menu uses (shared fields).
  const fontDlgRow = document.createElement("div");
  fontDlgRow.className = "insp-row";
  const fontDlgBtn = document.createElement("button");
  fontDlgBtn.type = "button";
  fontDlgBtn.textContent = "글꼴 설정...";
  fontDlgBtn.style.cssText = "padding:4px 10px;font-size:11px;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;width:100%;";
  fontDlgBtn.addEventListener("click", () => openFontModalForSelection());
  fontDlgRow.appendChild(fontDlgBtn);
  secTextBody.appendChild(fontDlgRow);

  const secText = makeSection("글꼴", secTextBody);
  contentEl.appendChild(secText);

  /* ---- Section 2: 채우기 ---- */
  const sec2Body = document.createElement("div");
  sec2Body.className = "insp-body";

  const fnRow = document.createElement("div");
  fnRow.className = "insp-row";
  const fnCb = document.createElement("input");
  fnCb.type = "checkbox";
  fnCb.className = "insp-cb";
  const fnLbl = document.createElement("label");
  fnLbl.className = "insp-field-label";
  fnLbl.textContent = "채우기 없음";
  fnRow.appendChild(fnCb);
  fnRow.appendChild(fnLbl);
  // fnRow is moved into the "면" section header row below (not appended to body).

  let _fillSnap = null;
  const fillCP = makeColorPicker(
    (lv) => {
      const s = state.get();
      const ids = s.selectedIds || [];
      if (!ids.length) return;
      state.update((s2) => {
        (s2.selectedIds || []).forEach(id => {
          const o = s2.objects.find((o) => o.id === id);
          if (o) o.fillLevel = lv;
        });
      });
    },
    () => { _fillSnap = snapBefore(); },
    () => { pushSnap(_fillSnap); _fillSnap = null; }
  );
  sec2Body.appendChild(fillCP.el);

  // ---- fill style selector: 색(solid) / 도트(dots) / 엑스(cross) / 헤칭(hatch) ----
  // fillLevel (shade) still applies — patterns use it as their mark color.
  const fsRow = document.createElement("div");
  fsRow.className = "insp-row";
  const fsLbl = document.createElement("label");
  fsLbl.className = "insp-field-label";
  fsLbl.textContent = "채우기 종류";
  const fsBtns = document.createElement("div");
  fsBtns.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
  // 18×18 inline-SVG glyphs (drawn inside a 28×28 button).
  const FILL_STYLE_ICONS = {
    solid: '<rect width="18" height="18" fill="#888" rx="1"/>',
    dots:  '<rect width="18" height="18" fill="white" stroke="#ccc" rx="1"/>' +
           '<circle cx="5" cy="5" r="1.5" fill="#888"/><circle cx="13" cy="5" r="1.5" fill="#888"/>' +
           '<circle cx="5" cy="13" r="1.5" fill="#888"/><circle cx="13" cy="13" r="1.5" fill="#888"/>',
    cross: '<rect width="18" height="18" fill="white" stroke="#ccc" rx="1"/>' +
           '<line x1="4" y1="4" x2="14" y2="14" stroke="#888" stroke-width="1.5"/>' +
           '<line x1="14" y1="4" x2="4" y2="14" stroke="#888" stroke-width="1.5"/>',
    hatch: '<rect width="18" height="18" fill="white" stroke="#ccc" rx="1"/>' +
           '<line x1="0" y1="9" x2="9" y2="0" stroke="#888" stroke-width="1"/>' +
           '<line x1="4" y1="14" x2="14" y2="4" stroke="#888" stroke-width="1"/>' +
           '<line x1="9" y1="18" x2="18" y2="9" stroke="#888" stroke-width="1"/>',
  };
  const FILL_STYLE_OPTIONS = [
    { label: "색",   value: "solid" },
    { label: "도트", value: "dots"  },
    { label: "엑스", value: "cross" },
    { label: "헤칭", value: "hatch" },
  ];
  const _fillStyleBtnEls = {};
  FILL_STYLE_OPTIONS.forEach(({ label, value }) => {
    const btn = document.createElement("button");
    btn.title = label;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18">${FILL_STYLE_ICONS[value]}</svg>`;
    btn.style.cssText = "width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
    btn.addEventListener("click", () => {
      const s = state.get();
      const ids = s.selectedIds || [];
      if (!ids.length) return;
      const snap = snapBefore();
      state.update((s2) => {
        s2.undoStack.push(snap);
        s2.redoStack = [];
        (s2.selectedIds || []).forEach(id => {
          const o = s2.objects.find((o) => o.id === id);
          if (o) o.fillStyle = value;
        });
      });
    });
    _fillStyleBtnEls[value] = btn;
    fsBtns.appendChild(btn);
  });
  fsRow.appendChild(fsLbl);
  fsRow.appendChild(fsBtns);
  sec2Body.appendChild(fsRow);

  // Highlight the active fill-style button for the (first) selected object.
  function syncFillStyle(obj) {
    const fs = obj.fillStyle ?? "solid";
    Object.entries(_fillStyleBtnEls).forEach(([val, btn]) => {
      const active = val === fs;
      btn.style.background = active ? "#4a9eff" : "#1e1f22";
      btn.style.color      = active ? "#ffffff" : "#dcddde";
      btn.style.border     = active ? "1px solid #4a9eff" : "1px solid #3a3c41";
    });
  }

  fnCb.addEventListener("change", () => {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (!ids.length) return;
    const snap = snapBefore();
    const val = fnCb.checked;
    fillCP.setDisabled(val);
    state.update((s2) => {
      s2.undoStack.push(snap);
      s2.redoStack = [];
      (s2.selectedIds || []).forEach(id => {
        const o = s2.objects.find((o) => o.id === id);
        if (o) o.fillNone = val;
      });
    });
  });

  const sec2 = makeSection("면", sec2Body);
  // Place 채우기 없음 on the right side of the "면" header row (saves a row).
  // stopPropagation keeps clicks here from toggling the <details> open/closed.
  const sec2Summary = sec2.querySelector(".insp-summary");
  fnRow.style.marginLeft = "auto";
  fnRow.addEventListener("click", (e) => e.stopPropagation());
  sec2Summary.appendChild(fnRow);
  contentEl.appendChild(sec2);

  /* ---- Section 3: 크기·위치 (shapes only, single selection only) ---- */
  const sec3Body = document.createElement("div");
  sec3Body.className = "insp-body";
  sec3Body.style.padding = "6px 6px"; // narrower than default for a compact section

  // negate=true → inspector shows/accepts math convention (Y up) while the stored
  // value stays in SVG convention (Y down). Display = -internal, internal = -input.
  function makePosRow(label, prop, step, negate = false) {
    const row = document.createElement("div");
    row.className = "insp-row";
    const lbl = document.createElement("label");
    lbl.className = "insp-field-label";
    lbl.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = step;
    inp.className = "insp-input";

    function commit() {
      const val = parseFloat(inp.value);
      if (!isFinite(val)) return;
      const s = state.get();
      const ids = s.selectedIds || [];
      if (!ids.length) return;
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const id = (s2.selectedIds || [])[0];
        const o = s2.objects.find((o) => o.id === id);
        if (!o) return;
        if (o.locked || (o.positionLocked && (prop === "x" || prop === "y"))) return;
        const next = negate ? -val : val;
        if (o.positionLocked && prop === "w") o.x -= (next - o.w) / 2;
        if (o.positionLocked && prop === "h") o.y -= (next - o.h) / 2;
        s2.undoStack.push(snap);
        s2.redoStack = [];
        o[prop] = next;
      });
    }

    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    inp.addEventListener("blur", commit);
    row.appendChild(lbl);
    row.appendChild(inp);
    return { el: row, inp };
  }

  const xF   = makePosRow("X",     "x",        "0.1");
  const yF   = makePosRow("Y",     "y",        "0.1", true); // math Y (up = positive)
  const wF   = makePosRow("W",     "w",        "0.1");
  const hF   = makePosRow("H",     "h",        "0.1");
  const rotF = makePosRow("회전 °", "rotation", "1");

  sec3Body.appendChild(rotF.el);

  // X/Y on one row, W/H on the next — compact pairs, left-aligned (not stretched).
  const xyPair = document.createElement("div");
  xyPair.style.cssText = "display:flex;gap:10px;";
  xyPair.appendChild(xF.el);
  xyPair.appendChild(yF.el);
  sec3Body.appendChild(xyPair);

  const whPair = document.createElement("div");
  whPair.style.cssText = "display:flex;gap:10px;";
  whPair.appendChild(wF.el);
  whPair.appendChild(hF.el);
  sec3Body.appendChild(whPair);

  const sec3 = makeSection("크기·위치", sec3Body);
  contentEl.appendChild(sec3);

  /* ---- Section 4: 보호 (single selection only) ---- */
  const sec4Body = document.createElement("div");
  sec4Body.className = "insp-body";

  const lockRow = document.createElement("div");
  lockRow.className = "insp-row";
  const lockCb = document.createElement("input");
  lockCb.type = "checkbox";
  lockCb.className = "insp-cb";
  const lockLbl = document.createElement("label");
  lockLbl.className = "insp-field-label";
  lockLbl.textContent = "개체 잠금";
  lockRow.appendChild(lockCb);
  lockRow.appendChild(lockLbl);
  sec4Body.appendChild(lockRow);

  const positionLockRow = document.createElement("div");
  positionLockRow.className = "insp-row";
  const positionLockCb = document.createElement("input");
  positionLockCb.type = "checkbox";
  positionLockCb.className = "insp-cb";
  const positionLockLbl = document.createElement("label");
  positionLockLbl.className = "insp-field-label";
  positionLockLbl.textContent = "위치 고정";
  positionLockRow.appendChild(positionLockCb);
  positionLockRow.appendChild(positionLockLbl);
  sec4Body.appendChild(positionLockRow);

  lockCb.addEventListener("change", () => {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (!ids.length) return;
    const snap = snapBefore();
    const val = lockCb.checked;
    state.update((s2) => {
      s2.undoStack.push(snap);
      s2.redoStack = [];
      (s2.selectedIds || []).forEach(id => {
        const o = s2.objects.find((o) => o.id === id);
        if (o) o.locked = val;
      });
    });
  });

  positionLockCb.addEventListener("change", () => {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (!ids.length) return;
    const snap = snapBefore();
    const val = positionLockCb.checked;
    state.update((s2) => {
      s2.undoStack.push(snap);
      s2.redoStack = [];
      (s2.selectedIds || []).forEach(id => {
        const o = s2.objects.find((o) => o.id === id);
        if (o) o.positionLocked = val;
      });
    });
  });

  const sec4 = makeSection("보호", sec4Body);
  contentEl.appendChild(sec4);

  /* ---- Section: 아트보드 (shown in the no-selection / empty state) ---- *
   * Lets the user set the page size. Changing it ONLY moves the artboard
   * boundary — objects keep their exact world coordinates. The artboard stays
   * centered on origin: render.js derives x=-w/2, y=-h/2 from state.artboard,
   * so it re-centers automatically. Max 100×100, min 10×10 (clamped here). */
  const AB_MIN = 10, AB_MAX = 100;

  const abBody = document.createElement("div");
  abBody.className = "insp-body";

  // Click-to-select-all for the artboard number inputs (mirrors contentEl above;
  // emptyEl/abSection live outside contentEl so they need their own handler).
  abBody.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t && t.tagName === "INPUT" && t.type === "number") t.select();
  });

  function makeArtboardRow(labelText) {
    const row = document.createElement("div");
    row.className = "insp-row";
    const lbl = document.createElement("label");
    lbl.className = "insp-field-label";
    lbl.style.minWidth = "44px";
    lbl.textContent = labelText;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = String(AB_MIN);
    inp.max = String(AB_MAX);
    inp.step = "1";
    inp.className = "insp-input";
    const unit = document.createElement("span");
    unit.className = "insp-unit";
    unit.textContent = "mm";
    row.appendChild(lbl);
    row.appendChild(inp);
    row.appendChild(unit);
    return { el: row, inp };
  }

  const abW = makeArtboardRow("너비(W)");
  const abH = makeArtboardRow("높이(H)");
  abBody.appendChild(abW.el);
  abBody.appendChild(abH.el);

  // Apply new size through the store so render() re-runs. Objects untouched.
  function applyArtboard(w, h) {
    const cw = Math.max(AB_MIN, Math.min(AB_MAX, Math.round(w)));
    const ch = Math.max(AB_MIN, Math.min(AB_MAX, Math.round(h)));
    state.update((s2) => { s2.artboard = { w: cw, h: ch }; });
  }

  function commitArtboard() {
    const s = state.get();
    const w = parseFloat(abW.inp.value);
    const h = parseFloat(abH.inp.value);
    applyArtboard(isFinite(w) ? w : s.artboard.w, isFinite(h) ? h : s.artboard.h);
  }

  [abW.inp, abH.inp].forEach((inp) => {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    inp.addEventListener("blur", commitArtboard);
  });

  // Preset buttons: just set w,h and apply the same way.
  const abPresets = document.createElement("div");
  abPresets.className = "insp-ab-presets";
  [[90, 60], [100, 100], [100, 60], [60, 90]].forEach(([w, h]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "insp-ab-preset";
    btn.textContent = `${w}×${h}`;
    btn.addEventListener("click", () => applyArtboard(w, h));
    abPresets.appendChild(btn);
  });
  abBody.appendChild(abPresets);

  const abSection = makeSection("아트보드", abBody);
  const _abRoot = emptyEl.parentElement;
  if (_abRoot) _abRoot.appendChild(abSection);

  // Refresh inputs from state (skip while the user is typing in one).
  function refreshArtboard(s) {
    if (document.activeElement === abW.inp || document.activeElement === abH.inp) return;
    abW.inp.value = s.artboard.w;
    abH.inp.value = s.artboard.h;
  }

  /* ---- Section: 레이어 (always visible — lives outside contentEl) ---- */
  const layerDetails = document.createElement("details");
  layerDetails.open = true;
  layerDetails.className = "insp-section";
  // Pin to the bottom of the inspector. #inspector is already a full-height
  // flex column (see inspector.css), so margin-top:auto pushes this to the end.
  layerDetails.style.marginTop = "auto";
  const layerSummary = document.createElement("summary");
  layerSummary.className = "insp-summary";
  layerSummary.textContent = "레이어";
  layerDetails.appendChild(layerSummary);

  const layerBody = document.createElement("div");
  layerBody.className = "insp-body";
  layerBody.style.padding = "4px 0";
  layerDetails.appendChild(layerBody);

  const _inspectorRoot = emptyEl.parentElement;
  if (_inspectorRoot) _inspectorRoot.appendChild(layerDetails);

  function renderLayerPanel(s) {
    if (layerBody.contains(document.activeElement)) return; // don't clobber inline name edit
    layerBody.innerHTML = "";

    // Bordered box holding the layer rows (top row = front-most, 3 → 2 → 1).
    const listBox = document.createElement("div");
    listBox.style.cssText =
      "border:1px solid #d0d7de;border-radius:4px;overflow:hidden;";
    layerBody.appendChild(listBox);

    const layers = [...(s.layers || [])].reverse(); // layer 3 on top → layer 1 on bottom
    for (const layer of layers) {
      const isActive = layer.id === s.activeLayerId;
      const isHidden = layer.visible === false;

      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;" +
        "border-left:3px solid " + (isActive ? "#0969da" : "transparent") + ";" +
        "background:" + (isActive ? "rgba(9,105,218,0.12)" : "transparent") + ";";

      // Visibility checkbox — checked = visible. stopPropagation keeps the
      // checkbox click from also triggering the row's "set active" handler.
      const visCb = document.createElement("input");
      visCb.type = "checkbox";
      visCb.checked = !isHidden;
      visCb.title = isHidden ? "표시" : "숨기기";
      visCb.style.cssText = "flex-shrink:0;cursor:pointer;margin:0;";
      visCb.addEventListener("click", (e) => { e.stopPropagation(); });
      visCb.addEventListener("change", (e) => {
        e.stopPropagation();
        state.update((s2) => {
          const l = s2.layers.find(l => l.id === layer.id);
          if (l) l.visible = !visCb.checked ? false : true;
        });
      });

      // Layer name
      const nameSpan = document.createElement("span");
      nameSpan.textContent = layer.name;
      nameSpan.style.cssText =
        "flex:1;font-size:12px;user-select:none;overflow:hidden;text-overflow:ellipsis;" +
        "white-space:nowrap;opacity:" + (isHidden ? "0.4" : "1") + ";";

      // Click row → set active layer
      row.addEventListener("click", () => {
        state.update((s2) => {
          s2.activeLayerId = layer.id;
          s2.selectedIds = [];
          s2.targetedId = null;
        });
      });

      // Double-click name → inline edit
      nameSpan.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const inp = document.createElement("input");
        inp.value = layer.name;
        inp.style.cssText =
          "flex:1;font-size:12px;background:#1e1f22;color:#dcddde;" +
          "border:1px solid #0969da;border-radius:3px;padding:1px 4px;width:100%;min-width:0;";
        nameSpan.replaceWith(inp);
        inp.focus();
        inp.select();
        let committed = false;
        function commitName() {
          if (committed) return;
          committed = true;
          const newName = inp.value.trim() || layer.name;
          state.update((s2) => {
            const l = s2.layers.find(l => l.id === layer.id);
            if (l) l.name = newName;
          });
        }
        inp.addEventListener("blur", commitName);
        inp.addEventListener("keydown", (e2) => {
          if (e2.key === "Enter") { inp.blur(); }
          if (e2.key === "Escape") { committed = true; renderLayerPanel(state.get()); }
        });
      });

      row.appendChild(visCb);
      row.appendChild(nameSpan);
      listBox.appendChild(row);
    }
  }

  /* ---- Subscribe: populate controls on every state change ---- */
  function populate(s) {
    renderLayerPanel(s);
    const ids = s.selectedIds || [];

    if (ids.length === 0) {
      emptyEl.style.display = "";
      contentEl.style.display = "none";
      abSection.style.display = "";   // 아트보드 section lives in the empty state
      refreshArtboard(s);
      return;
    }

    emptyEl.style.display = "none";
    contentEl.style.display = "";
    abSection.style.display = "none"; // hidden whenever something is selected
    groupBtnDiv.style.display = "none"; // shown only for an ungrouped multi-selection
    secText.style.display = "none"; // shown only for a single text object (set below)

    // Targeted state: only show ungroup button, hide everything else
    if (s.targetedId) {
      groupDiv.style.display = "";
      sec1.style.display = "none";
      sec2.style.display = "none";
      sec3.style.display = "none";
      sec4.style.display = "none";
      arrowRow.style.display = "none";
      dashRow.style.display = "none";
      dashSliders.style.display = "none";
      closeRow.style.display = "none";
      angleRow.style.display = "none";
      return;
    }

    // Whether every selected object is a line-family type (line/polyline/curve).
    const allLineFamily = ids.length > 0 && ids.every((id) => {
      const o = s.objects.find((o) => o.id === id);
      return o && LINE_TYPES.includes(o.type);
    });

    // Determine if all selected objects share the same groupId
    const firstObj = s.objects.find((o) => o.id === ids[0]);
    const allInGroup = !!(firstObj?.groupId) && ids.every(id => {
      const o = s.objects.find((o) => o.id === id);
      return o && o.groupId === firstObj.groupId;
    });

    // Group selected: show stroke/fill + ungroup button, hide 크기·위치 and 보호
    if (allInGroup) {
      groupDiv.style.display = "";
      sec1.style.display = "";
      sec2.style.display = allLineFamily ? "none" : ""; // no fill for line family
      sec3.style.display = ""; // group: show combined bbox center + shared rotation
      sec4.style.display = "none";
      arrowRow.style.display = "none";
      dashRow.style.display = "none";
      dashSliders.style.display = "none";
      closeRow.style.display = "none";
      angleRow.style.display = "none";

      const groupHasLocked = ids.some((id) => s.objects.find((o) => o.id === id)?.locked);
      const groupHasPositionLocked = ids.some((id) => s.objects.find((o) => o.id === id)?.positionLocked);
      xF.inp.disabled = groupHasLocked || groupHasPositionLocked;
      yF.inp.disabled = groupHasLocked || groupHasPositionLocked;
      wF.inp.disabled = groupHasLocked;
      hF.inp.disabled = groupHasLocked;
      rotF.inp.disabled = groupHasLocked;

      if (_dragging) return;

      strokeCP.setValue(firstObj.strokeLevel ?? 0);
      const _sw = firstObj.strokeWidth ?? 0.2;
      widthRange.value = _sw;
      widthNum.value =_sw.toFixed(1);

      const _fn = !!(firstObj.fillNone);
      fnCb.checked = _fn;
      fillCP.setValue(firstObj.fillLevel ?? 255);
      fillCP.setDisabled(_fn);
      syncFillStyle(firstObj);

      // Section 3 — combined bbox center (X/Y), combined size (W/H), shared rotation.
      let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
      const gRots = [];
      ids.forEach((id) => {
        const o = s.objects.find((o) => o.id === id);
        if (!o) return;
        let bx, by, bw, bh;
        if (o.type === "line") {
          bx = Math.min(o.p1.x, o.p2.x); by = Math.min(o.p1.y, o.p2.y);
          bw = Math.abs(o.p2.x - o.p1.x); bh = Math.abs(o.p2.y - o.p1.y);
        } else if ((o.type === "polyline" || o.type === "curve") && o.points && o.points.length) {
          let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
          o.points.forEach((p) => { if (p.x < a) a = p.x; if (p.y < b) b = p.y; if (p.x > c) c = p.x; if (p.y > d) d = p.y; });
          bx = a; by = b; bw = c - a; bh = d - b;
        } else {
          bx = o.x ?? 0; by = o.y ?? 0; bw = o.w ?? 0; bh = o.h ?? 0;
        }
        if (bx < gMinX) gMinX = bx;
        if (by < gMinY) gMinY = by;
        if (bx + bw > gMaxX) gMaxX = bx + bw;
        if (by + bh > gMaxY) gMaxY = by + bh;
        if (typeof o.rotation === "number") gRots.push(o.rotation);
      });
      if (isFinite(gMinX)) {
        const cx = (gMinX + gMaxX) / 2, cy = (gMinY + gMaxY) / 2;
        xF.inp.value = cx.toFixed(2);
        yF.inp.value = (-cy).toFixed(2); // SVG Y down → math Y up
        wF.inp.value = (gMaxX - gMinX).toFixed(2);
        hF.inp.value = (gMaxY - gMinY).toFixed(2);
      }
      // shared rotation: common value if all equal, else average (0 when none)
      let gSharedRot = 0;
      if (gRots.length) {
        gSharedRot = gRots.every((r) => r === gRots[0])
          ? gRots[0]
          : gRots.reduce((a, b) => a + b, 0) / gRots.length;
      }
      rotF.inp.value = gSharedRot.toFixed(1);
      return;
    }

    groupDiv.style.display = "none";

    if (ids.length > 1) {
      // Multi-selection (no shared group): stroke/fill sections + 묶기 button
      groupBtnDiv.style.display = ""; // ids>1 && !allInGroup (allInGroup returned above)
      sec1.style.display = "";
      sec2.style.display = allLineFamily ? "none" : ""; // no fill for line family
      sec3.style.display = "none";
      sec4.style.display = "none";
      arrowRow.style.display = "none";
      dashRow.style.display = "none";
      dashSliders.style.display = "none";
      closeRow.style.display = "none";
      angleRow.style.display = "none";

      if (_dragging) return;

      if (!firstObj) return;

      strokeCP.setValue(firstObj.strokeLevel ?? 0);
      const sw = firstObj.strokeWidth ?? 0.2;
      widthRange.value = sw;
      widthNum.value =sw.toFixed(1);

      const fn = !!(firstObj.fillNone);
      fnCb.checked = fn;
      fillCP.setValue(firstObj.fillLevel ?? 255);
      fillCP.setDisabled(fn);
      syncFillStyle(firstObj);
      return;
    }

    // Single selection: full controls
    const obj = s.objects.find((o) => o.id === ids[0]);
    if (!obj) {
      emptyEl.style.display = "";
      contentEl.style.display = "none";
      return;
    }

    if (_dragging) return; // skip during color picker drag to avoid handle jump

    const isText = obj.type === "text";
    // Text has no stroke/fill controls; it gets its own 글꼴 section instead.
    sec1.style.display = isText ? "none" : "";
    secText.style.display = isText ? "" : "none";
    if (isText) {
      fontFamSel.value = obj.fontFamily || DEFAULT_TEXT_FONT;
      if (document.activeElement !== fontSizeNum) {
        // Stored fontSize is world-unit mm; the field shows points.
        fontSizeNum.value = Math.round(mmToPt(obj.fontSize ?? 0) * 10) / 10;
      }
    }
    const isLineFamily = LINE_TYPES.includes(obj.type);

    // 채우기 섹션 표시 규칙: rect/ellipse/triangle + 닫힌 polyline + 닫힌 curve만 노출.
    const isClosedPoly  = obj.type === "polyline" && obj.closed === true;
    const isClosedCurve = obj.type === "curve"    && obj.closed === true;
    const showFill = SHAPE_TYPES.includes(obj.type) || isClosedPoly || isClosedCurve;
    sec2.style.display = showFill ? "" : "none";

    // 닫기 토글: polyline 또는 curve 선택 시 노출(열림/닫힘 모두).
    const isPolyline = obj.type === "polyline";
    const isCurve    = obj.type === "curve";
    const showClose  = isPolyline || isCurve;
    closeRow.style.display = showClose ? "" : "none";
    if (showClose) closeCb.checked = obj.closed === true;

    // 각도: straight line only. Skip while the field is focused so typing isn't clobbered.
    const isStraightLine = obj.type === "line";
    angleRow.style.display = isStraightLine ? "" : "none";
    if (isStraightLine && document.activeElement !== angleInp) {
      const ang = Math.atan2(obj.p2.y - obj.p1.y, obj.p2.x - obj.p1.x) * 180 / Math.PI;
      angleInp.value = ang.toFixed(1);
    }

    lineModeRow.style.display = isStraightLine ? "" : "none";
    let lineMode = obj.lineMode ?? obj.lineStyle
      ?? (obj.arrowHead === "center" ? "middleArrow" : (obj.arrowHead ?? "none") === "none" ? "solid" : "arrow");
    if (lineMode === "dimensionArrow") lineMode = "lengthArrow";
    if (!lineModeBtnEls[lineMode]) lineMode = "solid";
    Object.entries(lineModeBtnEls).forEach(([value, btn]) => {
      const active = value === lineMode;
      btn.style.background = active ? "#4a9eff" : "#1e1f22";
      btn.style.borderColor = active ? "#4a9eff" : "#3a3c41";
    });
    const arrowIcon = ({ right: ARROW_ICONS.end, left: ARROW_ICONS.start, both: ARROW_ICONS.both })[obj.arrowVariant]
      || ({ end: ARROW_ICONS.end, start: ARROW_ICONS.start, both: ARROW_ICONS.both })[obj.arrowHead]
      || ARROW_ICONS.end;
    lineModeBtnEls.arrow.innerHTML = `<svg width="40" height="24" viewBox="0 0 40 24">${arrowIcon}</svg>`;
    lineModeBtnEls.middleArrow.innerHTML = `<svg width="40" height="24" viewBox="0 0 40 24">${obj.arrowVariant === "left" ? MIDDLE_LEFT_ICON : ARROW_ICONS.center}</svg>`;
    lineModeBtnEls.lengthArrow.innerHTML = `<svg width="40" height="24" viewBox="0 0 40 24">${lengthIcon(obj.dimensionVariant || "basic")}</svg>`;
    dimensionLabelRow.style.display = isStraightLine && lineMode === "lengthArrow" ? "" : "none";
    if (document.activeElement !== dimensionLabelInp) dimensionLabelInp.value = obj.dimensionLabel ?? "d";

    // Arrow head: open line + open polyline (closed polyline = filled shape, no arrow).
    const showArrow = obj.type === "polyline" && !isClosedPoly;
    arrowRow.style.display = showArrow ? "" : "none";
    if (showArrow) {
      const ah = obj.arrowHead ?? "none";
      const displayArrow = ARROW_CYCLE.includes(ah) ? ah : "none";
      arrowBtn.title = ARROW_LABELS[displayArrow];
      arrowBtn.setAttribute("aria-label", `화살표 방향: ${ARROW_LABELS[displayArrow]}`);
      arrowBtn.innerHTML = `<svg width="40" height="24" viewBox="0 0 40 24">${ARROW_ICONS[displayArrow]}</svg>`;
    }

    // Dash presets + sliders: lines and size-based shape outlines.
    const supportsDash = DASH_TYPES.includes(obj.type);
    dashRow.style.display = supportsDash ? "" : "none";
    if (supportsDash) {
      syncDashControls(obj);
    } else {
      dashSliders.style.display = "none";
    }

    // Section 1
    strokeCP.setValue(obj.strokeLevel ?? 0);
    const sw = obj.strokeWidth ?? 0.2;
    widthRange.value = sw;
    widthNum.value =sw.toFixed(1);

    // Section 2
    const fn = !!(obj.fillNone);
    fnCb.checked = fn;
    fillCP.setValue(obj.fillLevel ?? 255);
    fillCP.setDisabled(fn);
    syncFillStyle(obj);

    // Section 3 — shape types only
    const isShape = SHAPE_TYPES.includes(obj.type);
    sec3.style.display = isShape ? "" : "none";
    if (isShape) {
      xF.inp.value   = (obj.x        ?? 0).toFixed(2);
      yF.inp.value   = (-(obj.y      ?? 0)).toFixed(2); // SVG Y down → math Y up
      wF.inp.value   = (obj.w        ?? 0).toFixed(2);
      hF.inp.value   = (obj.h        ?? 0).toFixed(2);
      rotF.inp.value = (obj.rotation ?? 0).toFixed(1);
    }

    // Section 4
    sec4.style.display = "";
    lockCb.checked = !!(obj.locked);
    positionLockCb.checked = !!(obj.positionLocked);
    positionLockCb.disabled = !!(obj.locked);
    xF.inp.disabled = !!(obj.locked || obj.positionLocked);
    yF.inp.disabled = !!(obj.locked || obj.positionLocked);
    wF.inp.disabled = !!obj.locked;
    hF.inp.disabled = !!obj.locked;
    rotF.inp.disabled = !!obj.locked;
  }

  state.subscribe(populate);
  populate(state.get());
}
