/* ===== INSPECTOR (right panel — shows/edits selected object properties) ===== */

import { TEXT_FONTS, DEFAULT_TEXT_FONT, DEFAULT_TEXT_SIZE_MM, mmToPt, ptToMm, MIN_TEXT_PT, OBJECT_LABEL_TYPES, normalizeTextRunStyle } from "./state.js?v=0.36.5";
import { openFontModalForSelection, openAngleArcLabelEditor } from "./tools.js?v=0.36.5";
import { resolveObjectStyle } from "./style-mode.js?v=0.36.5";

const GRAY_LEVELS = [0, 43, 85, 128, 170, 213, 255];
const SHAPE_TYPES = ["rect", "ellipse", "triangle"];
const CIRCUIT_HEIGHT_ELEMENTS = new Set(["resistor", "inductor", "capacitor", "voltmeter", "ammeter"]);
// Branch-B "line family": share arrow + dash controls; fill section is hidden for them.
const LINE_TYPES = ["line", "polyline", "curve"];
const DASH_TYPES = [...SHAPE_TYPES, ...LINE_TYPES];
function supportsDash(obj) {
  return !!obj && (DASH_TYPES.includes(obj.type) || (obj.type === "optics" && obj.kind === "object_arrow"));
}
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
      numInput.disabled = !!flag;
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

  /* ----- shared 라벨 크기 row builder (Group 6 task 6) -----
   * A "라벨 크기" number input in points; stores obj.labelSize in world mm.
   * `applies(o)` guards which selected object types accept the edit (line vs box).
   * Returns { row, num } so callers can append it and sync its value in populate(). */
  function makeLabelSizeRow(applies, labelText = "라벨 크기") {
    const row = document.createElement("div");
    row.className = "insp-row";
    const lbl = document.createElement("label");
    lbl.className = "insp-field-label";
    lbl.textContent = labelText;
    const num = document.createElement("input");
    num.type = "number";
    num.min = String(MIN_TEXT_PT);
    num.max = "400";
    num.step = "1";
    num.style.cssText = "width:56px;font-size:11px;border:1px solid #3a3c41;border-radius:3px;padding:2px 4px;text-align:center;background:#1e1f22;color:#dcddde;";
    const unit = document.createElement("span");
    unit.textContent = "pt";
    unit.className = "insp-unit";
    row.appendChild(lbl); row.appendChild(num); row.appendChild(unit);
    num.addEventListener("change", () => {
      const s = state.get();
      const id = (s.selectedIds || [])[0];
      if (!id) return;
      let pt = Number(num.value);
      if (!isFinite(pt) || pt < MIN_TEXT_PT) pt = MIN_TEXT_PT;
      const mm = ptToMm(pt);
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const o = s2.objects.find((it) => it.id === id);
        if (!o || !applies(o) || o.locked) return;
        o.labelSize = mm;
        s2.undoStack.push(snap);
        s2.redoStack = [];
      });
    });
    return { row, num };
  }

  function normalizeLabelType(value, fallback = "quantity") {
    return OBJECT_LABEL_TYPES.includes(value) ? value : fallback;
  }

  function makeLabelTypeRow(applies, fallback = "quantity") {
    const row = document.createElement("div");
    row.className = "insp-row";
    const lbl = document.createElement("label");
    lbl.className = "insp-field-label";
    lbl.textContent = "라벨 종류";
    const sel = document.createElement("select");
    sel.className = "insp-input";
    [
      ["quantity", "물리량"],
      ["label", "라벨"],
    ].forEach(([value, text]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      sel.appendChild(opt);
    });
    row.appendChild(lbl);
    row.appendChild(sel);
    sel.addEventListener("change", () => {
      const s = state.get();
      const id = (s.selectedIds || [])[0];
      if (!id) return;
      const nextType = normalizeLabelType(sel.value, fallback);
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const o = s2.objects.find((it) => it.id === id);
        if (!o || !applies(o) || o.locked) return;
        if (normalizeLabelType(o.labelType, fallback) === nextType && o.labelType === nextType) return;
        o.labelType = nextType;
        s2.undoStack.push(snap);
        s2.redoStack = [];
      });
    });
    return {
      row,
      sel,
      sync(obj) {
        sel.value = normalizeLabelType(obj?.labelType, fallback);
      },
    };
  }

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

  // (평가원/자유 설정 object-style mode removed in v0.22.0 — objects are always free.)

  function setButtonDisabled(btn, disabled) {
    btn.disabled = !!disabled;
    btn.style.opacity = disabled ? "0.45" : "";
    btn.style.cursor = disabled ? "default" : "pointer";
  }

  /* ---- Section 1: 선 ---- */
  const sec1Body = document.createElement("div");
  sec1Body.className = "insp-body insp-line-grid"; // fixed-width label column (Illustrator-style)

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
    // two arrows at ~1/3 and ~2/3, BOTH pointing inward toward the midpoint.
    midInward: '<line x1="4" y1="12" x2="36" y2="12" stroke="#888" stroke-width="1.5"/>' +
            '<polygon points="11,8 17,12 11,16" fill="#888"/>' +
            '<polygon points="29,8 23,12 29,16" fill="#888"/>',
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
  lineModeLbl.textContent = "화살표 종류";
  const lineModeBtns = document.createElement("div");
  lineModeBtns.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
  const LINE_MODES = [
    { value: "solid", label: "Solid", icon: ARROW_ICONS.none },
    { value: "arrow", label: "Arrow", icon: ARROW_ICONS.end },
    { value: "middleArrow", label: "Middle arrow", icon: ARROW_ICONS.center },
    { value: "midInward", label: "Inward double arrow", icon: ARROW_ICONS.midInward },
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
  const dimensionLabelTypeRow = makeLabelTypeRow((o) => o.type === "line");
  sec1Body.appendChild(dimensionLabelTypeRow.row);

  /* ---- straight-line upright label (Group 3): text input + on/off toggle ----
   * Writes obj.label / obj.labelShow. When on, render.js (withLineLabel) draws
   * the text screen-upright, centered above the line midpoint, default font. */
  const lineLabelRow = document.createElement("div");
  lineLabelRow.className = "insp-row";
  const lineLabelLbl = document.createElement("label");
  lineLabelLbl.className = "insp-field-label";
  lineLabelLbl.textContent = "라벨";
  const lineLabelInp = document.createElement("input");
  lineLabelInp.type = "text";
  lineLabelInp.maxLength = 60;
  lineLabelInp.style.cssText = "width:90px;font-size:11px;border:1px solid #3a3c41;border-radius:3px;padding:3px 5px;background:#1e1f22;color:#dcddde;";
  lineLabelInp.addEventListener("change", () => {
    const s = state.get();
    const id = (s.selectedIds || [])[0];
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((item) => item.id === id);
      if (!o || o.type !== "line" || o.locked) return;
      if ((o.label ?? "") === lineLabelInp.value) return; // no-op → no undo entry
      o.label = lineLabelInp.value;
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  });
  lineLabelRow.appendChild(lineLabelLbl);
  lineLabelRow.appendChild(lineLabelInp);
  sec1Body.appendChild(lineLabelRow);
  const lineLabelTypeRow = makeLabelTypeRow((o) => o.type === "line");
  sec1Body.appendChild(lineLabelTypeRow.row);

  const lineLabelShowRow = document.createElement("div");
  lineLabelShowRow.className = "insp-row";
  const lineLabelShowCb = document.createElement("input");
  lineLabelShowCb.type = "checkbox";
  lineLabelShowCb.className = "insp-cb";
  const lineLabelShowLbl = document.createElement("label");
  lineLabelShowLbl.className = "insp-field-label";
  lineLabelShowLbl.textContent = "라벨 표시";
  lineLabelShowRow.appendChild(lineLabelShowCb);
  lineLabelShowRow.appendChild(lineLabelShowLbl);
  sec1Body.appendChild(lineLabelShowRow);
  lineLabelShowCb.addEventListener("change", () => {
    const s = state.get();
    const id = (s.selectedIds || [])[0];
    if (!id) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    const val = lineLabelShowCb.checked;
    state.update((s2) => {
      const o = s2.objects.find((item) => item.id === id);
      if (!o || o.type !== "line" || o.locked) return;
      o.labelShow = val;
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  });

  // ---- 라벨 반전 (Group 6 task 2): mirror the label to the opposite side of the
  // line at the same perpendicular distance. Toggles obj.labelFlip; render.js
  // (withLineLabel) flips the normal-offset sign. Only the position changes. ----
  const lineLabelFlipRow = document.createElement("div");
  lineLabelFlipRow.className = "insp-row";
  const lineLabelFlipLbl = document.createElement("label");
  lineLabelFlipLbl.className = "insp-field-label";
  lineLabelFlipLbl.textContent = ""; // align with the 라벨 column
  const lineLabelFlipBtn = document.createElement("button");
  lineLabelFlipBtn.type = "button";
  lineLabelFlipBtn.textContent = "반전";
  lineLabelFlipBtn.style.cssText = "padding:4px 10px;font-size:11px;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
  lineLabelFlipBtn.addEventListener("click", () => {
    const s = state.get();
    const id = (s.selectedIds || [])[0];
    if (!id) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((item) => item.id === id);
      if (!o || o.type !== "line" || o.locked) return;
      o.labelFlip = !o.labelFlip;
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  });
  lineLabelFlipRow.appendChild(lineLabelFlipLbl);
  lineLabelFlipRow.appendChild(lineLabelFlipBtn);
  sec1Body.appendChild(lineLabelFlipRow);

  // ---- 라벨 크기 (Group 6 task 6): per-line label font size in points → mm. ----
  const lineLabelSizeRow = makeLabelSizeRow((o) => o.type === "line");
  sec1Body.appendChild(lineLabelSizeRow.row);

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
        if (supportsDash(o)) {
          o.dashLength = preset.dashLength;
          o.dashGap = preset.dashGap;
          o.partialDash = false; // selecting a normal dash preset exits 부분 점선 mode
          s2.undoStack.push(snap);
          s2.redoStack = [];
        }
      });
    });
    _dashBtnEls.push(btn);
    dashBtns.appendChild(btn);
  });

  // "부분 점선" (partial dash): half solid + half dashed. Straight line only — sets
  // obj.partialDash and seeds dashRatio/dashFlip; the dashed half reuses 길이/간격.
  const partialDashBtn = document.createElement("button");
  partialDashBtn.title = "부분 점선";
  partialDashBtn.innerHTML = '<svg width="40" height="24" viewBox="0 0 40 24">' +
    '<line x1="2" y1="12" x2="20" y2="12" stroke="#888" stroke-width="2"/>' +
    '<line x1="20" y1="12" x2="38" y2="12" stroke="#888" stroke-width="2" stroke-dasharray="3 3"/></svg>';
  partialDashBtn.style.cssText = "width:40px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
  partialDashBtn.addEventListener("click", () => {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (o && o.type === "line") {
        o.partialDash = true;
        if ((o.dashLength ?? 0) <= 0) { o.dashLength = 0.2; o.dashGap = 0.2; } // ensure dashes show
        o.dashRatio ??= 0.5;
        o.dashFlip ??= false;
        s2.undoStack.push(snap);
        s2.redoStack = [];
      }
    });
  });
  dashBtns.appendChild(partialDashBtn);

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
        if (supportsDash(o)) o[prop] = val;
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

  // ---- 부분 점선 전용 컨트롤: 실선 비율(0..1) + 방향 반전. 직선 한 개가 선택되고
  // partialDash가 켜졌을 때만 노출(axisVariant 전용 섹션 패턴과 동일). ----
  const partialControls = document.createElement("div");
  partialControls.style.cssText = "display:flex;flex-direction:column;gap:5px;";

  // 실선 비율 slider (dashRatio: 시작점 p1 기준 실선 비율)
  const ratioRow = document.createElement("div");
  ratioRow.className = "insp-row";
  const ratioLbl = document.createElement("label");
  ratioLbl.className = "insp-field-label";
  ratioLbl.textContent = "실선 비율";
  const ratioRange = document.createElement("input");
  ratioRange.type = "range";
  ratioRange.min = "0";
  ratioRange.max = "1";
  ratioRange.step = "0.05";
  ratioRange.className = "insp-range";
  const ratioNum = document.createElement("input");
  ratioNum.type = "number";
  ratioNum.min = "0";
  ratioNum.max = "1";
  ratioNum.step = "0.05";
  ratioNum.style.cssText = "width:40px;font-size:11px;border:1px solid #3a3c41;border-radius:3px;padding:2px 4px;text-align:center;background:#1e1f22;color:#dcddde;";
  ratioRow.appendChild(ratioLbl);
  ratioRow.appendChild(ratioRange);
  ratioRow.appendChild(ratioNum);

  function applyRatio(val) {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (o && o.type === "line") o.dashRatio = val;
    });
  }
  let _ratioSnap = null;
  ratioRange.addEventListener("mousedown", () => { _ratioSnap = snapBefore(); });
  ratioRange.addEventListener("input", () => {
    const val = Math.max(0, Math.min(1, parseFloat(ratioRange.value)));
    ratioNum.value = val.toFixed(2);
    applyRatio(val);
  });
  ratioRange.addEventListener("change", () => { pushSnap(_ratioSnap); _ratioSnap = null; });
  let _ratioNumSnap = null;
  ratioNum.addEventListener("focus", () => { _ratioNumSnap = snapBefore(); });
  ratioNum.addEventListener("input", () => {
    const raw = parseFloat(ratioNum.value);
    if (!isFinite(raw)) return;
    const val = Math.max(0, Math.min(1, raw));
    ratioRange.value = val;
    applyRatio(val);
  });
  ratioNum.addEventListener("change", () => { pushSnap(_ratioNumSnap); _ratioNumSnap = null; });
  partialControls.appendChild(ratioRow);

  // 방향 반전 button (dashFlip toggle): 실선/점선 절반을 좌우 교환.
  const flipRow = document.createElement("div");
  flipRow.className = "insp-row";
  const flipLbl = document.createElement("label");
  flipLbl.className = "insp-field-label";
  flipLbl.textContent = ""; // 라벨 컬럼 정렬 유지용 빈 칸
  const flipBtn = document.createElement("button");
  flipBtn.type = "button";
  flipBtn.textContent = "방향 반전";
  flipBtn.style.cssText = "padding:4px 10px;font-size:11px;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
  flipBtn.addEventListener("click", () => {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (o && o.type === "line") {
        o.dashFlip = !o.dashFlip;
        s2.undoStack.push(snap);
        s2.redoStack = [];
      }
    });
  });
  flipRow.appendChild(flipLbl);
  flipRow.appendChild(flipBtn);
  partialControls.appendChild(flipRow);

  sec1Body.appendChild(partialControls);

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

  // ---- 경사면처리 toggle (single polyline only): rounds interior joints at render. ----
  const roundRow = document.createElement("div");
  roundRow.className = "insp-row";
  const roundCb = document.createElement("input");
  roundCb.type = "checkbox";
  roundCb.className = "insp-cb";
  const roundLbl = document.createElement("label");
  roundLbl.className = "insp-field-label";
  roundLbl.textContent = "경사면처리";
  roundRow.appendChild(roundCb);
  roundRow.appendChild(roundLbl);
  sec1Body.appendChild(roundRow);

  roundCb.addEventListener("change", () => {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = snapBefore();
    const val = roundCb.checked;
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (o && o.type === "polyline") {
        s2.undoStack.push(snap);
        s2.redoStack = [];
        o.rounded = val;
      }
    });
  });

  // ---- 곡률 반경 (corner radius, world-unit mm): active only when 경사면처리 is on. ----
  const radiusRow = document.createElement("div");
  radiusRow.className = "insp-row";
  const radiusLbl = document.createElement("label");
  radiusLbl.className = "insp-field-label";
  radiusLbl.textContent = "곡률 반경";
  const radiusInp = document.createElement("input");
  radiusInp.type = "number";
  radiusInp.step = "1";
  radiusInp.min = "0";
  radiusInp.className = "insp-input";
  const radiusUnit = document.createElement("span");
  radiusUnit.className = "insp-unit";
  radiusUnit.textContent = "mm";
  radiusRow.appendChild(radiusLbl);
  radiusRow.appendChild(radiusInp);
  radiusRow.appendChild(radiusUnit);
  sec1Body.appendChild(radiusRow);

  function commitRadius() {
    const val = parseFloat(radiusInp.value);
    if (!isFinite(val)) return;
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (!o || o.type !== "polyline" || o.locked) return;
      o.cornerRadius = Math.max(0, val);
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  }
  radiusInp.addEventListener("keydown", (e) => { if (e.key === "Enter") radiusInp.blur(); });
  radiusInp.addEventListener("blur", commitRadius);

  // Highlight the active preset button (or none, for a custom slider value).
  function syncDashControls(obj) {
    const dl = obj.dashLength ?? 0;
    const dg = obj.dashGap ?? 0;
    const isPartial = obj.type === "line" && !!obj.partialDash;
    _dashBtnEls.forEach((btn, i) => {
      const p = DASH_PRESETS[i];
      // In partial mode no plain preset is the active "선 종류" (the partial button is).
      const active = !isPartial && p.dashLength === dl && p.dashGap === dg;
      btn.style.background = active ? "#4a9eff" : "#1e1f22";
      btn.style.color      = active ? "#ffffff" : "#dcddde";
      btn.style.border     = active ? "1px solid #4a9eff" : "1px solid #3a3c41";
    });
    // 부분 점선 button: shown for straight lines only; highlighted when active.
    partialDashBtn.style.display = obj.type === "line" ? "" : "none";
    partialDashBtn.style.background = isPartial ? "#4a9eff" : "#1e1f22";
    partialDashBtn.style.color      = isPartial ? "#ffffff" : "#dcddde";
    partialDashBtn.style.border     = isPartial ? "1px solid #4a9eff" : "1px solid #3a3c41";

    const dashed = dl > 0;
    dashSliders.style.display = dashed ? "" : "none";
    if (dashed) {
      dashLenSlider.range.value = dl; dashLenSlider.num.value = dl.toFixed(1);
      dashGapSlider.range.value = dg; dashGapSlider.num.value = dg.toFixed(1);
    }

    // 실선 비율 / 방향 반전: only for a single straight line in partial mode.
    partialControls.style.display = isPartial ? "" : "none";
    if (isPartial) {
      const r = Math.max(0, Math.min(1, obj.dashRatio ?? 0.5));
      if (document.activeElement !== ratioNum) {
        ratioRange.value = r;
        ratioNum.value = r.toFixed(2);
      }
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
  fontSizeNum.min = String(MIN_TEXT_PT);
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

  const italicRow = document.createElement("div");
  italicRow.className = "insp-row";
  const italicCb = document.createElement("input");
  italicCb.type = "checkbox";
  italicCb.className = "insp-cb";
  const italicLbl = document.createElement("label");
  italicLbl.className = "insp-field-label";
  italicLbl.textContent = "기울임";
  italicRow.appendChild(italicCb);
  italicRow.appendChild(italicLbl);
  secTextBody.appendChild(italicRow);

  function applyTextProp(prop, value) {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (!o || (o.type !== "text" && o.type !== "formula")) return;
      o[prop] = value;
      if (o.type === "text") o.textRuns = (o.text ?? "") ? [{ text: o.text, style: normalizeTextRunStyle(o, o) }] : [];
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  }
  fontFamSel.addEventListener("change", () => applyTextProp("fontFamily", fontFamSel.value));
  italicCb.addEventListener("change", () => {
    const val = italicCb.checked;
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === ids[0]);
      if (!o || (o.type !== "text" && o.type !== "formula")) return;
      o.italic = val;
      o.fontStyle = val ? "italic" : "normal";
      if (o.type === "text") o.textRuns = (o.text ?? "") ? [{ text: o.text, style: normalizeTextRunStyle(o, o) }] : [];
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  });
  fontSizeNum.addEventListener("change", () => {
    let v = parseFloat(fontSizeNum.value); // entered in pt → store mm
    if (!isFinite(v)) return;
    v = Math.max(MIN_TEXT_PT, v);          // clamp to the 6pt floor
    fontSizeNum.value = v;                 // reflect the clamped value
    applyTextProp("fontSize", ptToMm(v));
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
        if (o.type === "apparatus" && o.kind === "wire") {
          if (prop === "length") o.w = Math.max(next, 1);
          if (prop === "thickness") {
            o.gap = next;
            o.h = Math.max(next * 3, 3);
          }
        }
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

  // anglearc-only rows: radius + start/sweep angle (math convention, CCW +). The
  // arc has no W/H/rotation — these replace those rows for an anglearc selection.
  const radF = makePosRow("반지름", "radius", "0.1");
  const saF  = makePosRow("시작각 °", "startAngle", "1");
  const swF  = makePosRow("사잇각 °", "sweepAngle", "1");
  sec3Body.appendChild(radF.el);
  const arcPair = document.createElement("div");
  arcPair.style.cssText = "display:flex;gap:10px;";
  arcPair.appendChild(saF.el);
  arcPair.appendChild(swF.el);
  sec3Body.appendChild(arcPair);

  // anglearc-only: free-text label (default "θ"). User types verbatim — no
  // auto degree sign. Empty string is kept on the object; render.js draws no
  // label text when it's empty, but the arc itself stays.
  const labelRow = document.createElement("div");
  labelRow.className = "insp-row";
  const labelLbl = document.createElement("label");
  labelLbl.className = "insp-field-label";
  labelLbl.textContent = "라벨";
  const labelInp = document.createElement("input");
  labelInp.type = "text";
  labelInp.className = "insp-input";
  function commitArcLabel() {
    const s = state.get();
    const ids = s.selectedIds || [];
    if (!ids.length) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const id = (s2.selectedIds || [])[0];
      const o = s2.objects.find((o) => o.id === id);
      if (!o || o.locked) return;
      if ((o.label ?? "") === labelInp.value) return; // no-op → no undo entry
      s2.undoStack.push(snap);
      s2.redoStack = [];
      o.label = labelInp.value;
    });
  }
  labelInp.addEventListener("keydown", (e) => { if (e.key === "Enter") labelInp.blur(); });
  labelInp.addEventListener("blur", commitArcLabel);
  labelRow.appendChild(labelLbl);
  labelRow.appendChild(labelInp);
  sec3Body.appendChild(labelRow);
  const objectLabelTypeRow = makeLabelTypeRow((o) => o.type === "anglearc" || o.type === "optics" || o.type === "circuit");
  sec3Body.appendChild(objectLabelTypeRow.row);

  // anglearc-only: 라벨 편집 button. Opens the SAME small text editor the labeler
  // uses (writes obj.label), so θ can be changed to α/β/A/㉠/Ⅰ/m/h and simple
  // formula-like symbols. The inline 라벨 input above still works for quick edits.
  const arcLabelEditRow = document.createElement("div");
  arcLabelEditRow.className = "insp-row";
  const arcLabelEditLbl = document.createElement("label");
  arcLabelEditLbl.className = "insp-field-label";
  arcLabelEditLbl.textContent = "";
  const arcLabelEditBtn = document.createElement("button");
  arcLabelEditBtn.type = "button";
  arcLabelEditBtn.textContent = "라벨 편집...";
  arcLabelEditBtn.title = "각도 라벨/기호 입력기 열기";
  arcLabelEditBtn.style.cssText = "padding:4px 10px;font-size:11px;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
  arcLabelEditBtn.addEventListener("click", () => {
    const id = (state.get().selectedIds || [])[0];
    if (id) openAngleArcLabelEditor(id);
  });
  arcLabelEditRow.appendChild(arcLabelEditLbl);
  arcLabelEditRow.appendChild(arcLabelEditBtn);
  sec3Body.appendChild(arcLabelEditRow);

  // optics-only: show/hide toggle for the label (like the anglearc label visibility).
  const showLabelRow = document.createElement("div");
  showLabelRow.className = "insp-row";
  const showLabelCb = document.createElement("input");
  showLabelCb.type = "checkbox";
  showLabelCb.className = "insp-cb";
  const showLabelLbl = document.createElement("label");
  showLabelLbl.className = "insp-field-label";
  showLabelLbl.textContent = "라벨 표시";
  showLabelRow.appendChild(showLabelCb);
  showLabelRow.appendChild(showLabelLbl);
  sec3Body.appendChild(showLabelRow);
  showLabelCb.addEventListener("change", () => {
    const s = state.get();
    if (!(s.selectedIds || []).length) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    const val = showLabelCb.checked;
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === (s2.selectedIds || [])[0]);
      if (!o || o.locked) return;
      s2.undoStack.push(snap); s2.redoStack = [];
      o.showLabel = val;
    });
  });

  // node-only: label side (above/below). The label itself reuses labelRow above.
  const labelPosRow = document.createElement("div");
  labelPosRow.className = "insp-row";
  const labelPosLbl = document.createElement("label");
  labelPosLbl.className = "insp-field-label";
  labelPosLbl.textContent = "라벨 위치";
  const labelPosSel = document.createElement("select");
  labelPosSel.className = "insp-input";
  [["above", "위 (above)"], ["below", "아래 (below)"]].forEach(([val, text]) => {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = text;
    labelPosSel.appendChild(opt);
  });
  labelPosRow.appendChild(labelPosLbl);
  labelPosRow.appendChild(labelPosSel);
  sec3Body.appendChild(labelPosRow);
  labelPosSel.addEventListener("change", () => {
    const s = state.get();
    if (!(s.selectedIds || []).length) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    const val = labelPosSel.value === "below" ? "below" : "above";
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === (s2.selectedIds || [])[0]);
      if (!o || o.locked) return;
      s2.undoStack.push(snap); s2.redoStack = [];
      o.labelPos = val;
    });
  });

  // labeler-only geometry (mirrors the straight-line inspector): 길이 + 각도 of the
  // leader line. The labeler stores p1 (leader anchor on the graph) and p2 (label
  // position); 길이 = |p2 − p1|, 각도 = atan2(p2−p1) in the SAME convention as the
  // straight-line 각도 field. Text editing lives in the double-click dialog, NOT here.
  // Editing keeps the anchor p1 fixed and repositions the label p2, preserving the
  // other component — so the leader anchor stays put and labeler geometry is intact.
  const labelerLenRow = document.createElement("div");
  labelerLenRow.className = "insp-row";
  const labelerLenLbl = document.createElement("label");
  labelerLenLbl.className = "insp-field-label";
  labelerLenLbl.textContent = "길이";
  const labelerLenInp = document.createElement("input");
  labelerLenInp.type = "number";
  labelerLenInp.step = "0.1";
  labelerLenInp.min = "0";
  labelerLenInp.className = "insp-input";
  const labelerLenUnit = document.createElement("span");
  labelerLenUnit.className = "insp-unit";
  labelerLenUnit.textContent = "mm";
  labelerLenRow.appendChild(labelerLenLbl);
  labelerLenRow.appendChild(labelerLenInp);
  labelerLenRow.appendChild(labelerLenUnit);
  sec3Body.appendChild(labelerLenRow);

  function commitLabelerLength() {
    const val = parseFloat(labelerLenInp.value);
    if (!isFinite(val) || val < 0) return;
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((it) => it.id === ids[0]);
      if (!o || o.type !== "labeler" || o.locked) return;
      const dx = o.p2.x - o.p1.x, dy = o.p2.y - o.p1.y;
      const cur = Math.hypot(dx, dy);
      const ux = cur > 1e-9 ? dx / cur : 1; // degenerate leader → default horizontal
      const uy = cur > 1e-9 ? dy / cur : 0;
      o.p2 = { x: o.p1.x + ux * val, y: o.p1.y + uy * val };
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  }
  labelerLenInp.addEventListener("keydown", (e) => { if (e.key === "Enter") labelerLenInp.blur(); });
  labelerLenInp.addEventListener("blur", commitLabelerLength);

  const labelerAngleRow = document.createElement("div");
  labelerAngleRow.className = "insp-row";
  const labelerAngleLbl = document.createElement("label");
  labelerAngleLbl.className = "insp-field-label";
  labelerAngleLbl.textContent = "각도";
  const labelerAngleInp = document.createElement("input");
  labelerAngleInp.type = "number";
  labelerAngleInp.step = "1";
  labelerAngleInp.className = "insp-input";
  const labelerAngleUnit = document.createElement("span");
  labelerAngleUnit.className = "insp-unit";
  labelerAngleUnit.textContent = "°";
  labelerAngleRow.appendChild(labelerAngleLbl);
  labelerAngleRow.appendChild(labelerAngleInp);
  labelerAngleRow.appendChild(labelerAngleUnit);
  sec3Body.appendChild(labelerAngleRow);

  function commitLabelerAngle() {
    const val = parseFloat(labelerAngleInp.value);
    if (!isFinite(val)) return;
    const s = state.get();
    const ids = s.selectedIds || [];
    if (ids.length !== 1) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((it) => it.id === ids[0]);
      if (!o || o.type !== "labeler" || o.locked) return;
      const len = Math.hypot(o.p2.x - o.p1.x, o.p2.y - o.p1.y);
      const rad = (val * Math.PI) / 180;
      let nx = Math.cos(rad), ny = Math.sin(rad);
      const n = ((val % 360) + 360) % 360;
      if (n === 0 || n === 180) ny = 0;   // exact horizontal
      if (n === 90 || n === 270) nx = 0;  // exact vertical
      o.p2 = { x: o.p1.x + nx * len, y: o.p1.y + ny * len };
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  }
  labelerAngleInp.addEventListener("keydown", (e) => { if (e.key === "Enter") labelerAngleInp.blur(); });
  labelerAngleInp.addEventListener("blur", commitLabelerAngle);

  /* ---- rect/ellipse upright label (Group 3): text input + position dropdown ----
   * Writes obj.label / obj.labelPos. The label renders screen-upright, excluded
   * from rotation, in the default font (see render.js withBoxLabel). */
  const boxLabelRow = document.createElement("div");
  boxLabelRow.className = "insp-row";
  const boxLabelLbl = document.createElement("label");
  boxLabelLbl.className = "insp-field-label";
  boxLabelLbl.textContent = "라벨";
  const boxLabelInp = document.createElement("input");
  boxLabelInp.type = "text";
  boxLabelInp.maxLength = 60;
  boxLabelInp.className = "insp-input";
  function commitBoxLabel() {
    const s = state.get();
    if (!(s.selectedIds || []).length) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === (s2.selectedIds || [])[0]);
      if (!o || o.locked) return;
      if ((o.label ?? "") === boxLabelInp.value) return; // no-op → no undo entry
      s2.undoStack.push(snap); s2.redoStack = [];
      o.label = boxLabelInp.value;
    });
  }
  boxLabelInp.addEventListener("keydown", (e) => { if (e.key === "Enter") boxLabelInp.blur(); });
  boxLabelInp.addEventListener("blur", commitBoxLabel);
  boxLabelRow.appendChild(boxLabelLbl);
  boxLabelRow.appendChild(boxLabelInp);
  sec3Body.appendChild(boxLabelRow);
  const boxLabelTypeRow = makeLabelTypeRow((o) => o.type === "rect" || o.type === "ellipse");
  sec3Body.appendChild(boxLabelTypeRow.row);

  const boxLabelPosRow = document.createElement("div");
  boxLabelPosRow.className = "insp-row";
  const boxLabelPosLbl = document.createElement("label");
  boxLabelPosLbl.className = "insp-field-label";
  boxLabelPosLbl.textContent = "라벨 위치";
  const boxLabelPosSel = document.createElement("select");
  boxLabelPosSel.className = "insp-input";
  [["center", "가운데"], ["above", "위"], ["below", "아래"], ["left", "왼쪽"], ["right", "오른쪽"]].forEach(([val, text]) => {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = text;
    boxLabelPosSel.appendChild(opt);
  });
  boxLabelPosRow.appendChild(boxLabelPosLbl);
  boxLabelPosRow.appendChild(boxLabelPosSel);
  sec3Body.appendChild(boxLabelPosRow);
  boxLabelPosSel.addEventListener("change", () => {
    const s = state.get();
    if (!(s.selectedIds || []).length) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    const val = ["center", "above", "below", "left", "right"].includes(boxLabelPosSel.value) ? boxLabelPosSel.value : "center";
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === (s2.selectedIds || [])[0]);
      if (!o || o.locked) return;
      s2.undoStack.push(snap); s2.redoStack = [];
      o.labelPos = val;
    });
  });

  // ---- rect/ellipse 라벨 크기 (Group 6 task 6): per-box label font size. ----
  const boxLabelSizeRow = makeLabelSizeRow((o) => o.type === "rect" || o.type === "ellipse");
  sec3Body.appendChild(boxLabelSizeRow.row);

  // capacitor-only: plate separation 간격 (world mm).
  const gapRow = document.createElement("div");
  gapRow.className = "insp-row";
  const gapLbl = document.createElement("label");
  gapLbl.className = "insp-field-label";
  gapLbl.textContent = "간격";
  const gapInp = document.createElement("input");
  gapInp.type = "number";
  gapInp.step = "0.1";
  gapInp.min = "0.1";
  gapInp.className = "insp-input";
  function commitGap() {
    const val = parseFloat(gapInp.value);
    if (!isFinite(val) || val <= 0) return;
    const s = state.get();
    if (!(s.selectedIds || []).length) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === (s2.selectedIds || [])[0]);
      if (!o || o.locked) return;
      if (o.gap === val) return; // no-op → no undo entry
      s2.undoStack.push(snap); s2.redoStack = [];
      o.gap = val;
    });
  }
  gapInp.addEventListener("keydown", (e) => { if (e.key === "Enter") gapInp.blur(); });
  gapInp.addEventListener("blur", commitGap);
  gapRow.appendChild(gapLbl);
  gapRow.appendChild(gapInp);
  sec3Body.appendChild(gapRow);

  const circuitHeightF = makePosRow("높이", "height", "0.1");
  sec3Body.appendChild(circuitHeightF.el);

  // axes-only: 형태(축 모양) 3종 전환 + X/Y 라벨 + 눈금 간격. Shown only when a single
  // 좌표축 is selected. Reuses existing fields (axisVariant/labelX/labelY/tickSpacing);
  // each control commits on click or Enter/blur with one undo snapshot, like the rows above.
  const AXIS_VARIANTS = [
    { id: "cross",    label: "십자" },
    { id: "quadrant", label: "L자" },
    { id: "single",   label: "직선" },
  ];
  // Mutate the single selected axes object under one undo snapshot. `apply` returns
  // false when nothing changed → no undo entry is pushed (mirrors commitGap/commitArcLabel).
  function commitAxes(apply) {
    const s = state.get();
    if (!(s.selectedIds || []).length) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === (s2.selectedIds || [])[0]);
      if (!o || o.locked || o.type !== "axes") return;
      if (!apply(o)) return;
      s2.undoStack.push(snap); s2.redoStack = [];
    });
  }

  const axisVarRow = document.createElement("div");
  axisVarRow.className = "insp-row";
  const axisVarLbl = document.createElement("label");
  axisVarLbl.className = "insp-field-label";
  axisVarLbl.textContent = "형태";
  axisVarRow.appendChild(axisVarLbl);
  const axisVarBtns = {};
  AXIS_VARIANTS.forEach(({ id, label }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.style.cssText =
      "flex:1;padding:4px 0;margin-left:4px;border:1px solid #3a3c41;border-radius:4px;" +
      "background:#1e1f22;color:#ddd;cursor:pointer;font-size:12px;";
    btn.addEventListener("click", () =>
      commitAxes((o) => {
        if ((o.axisVariant || "cross") === id) return false;
        o.axisVariant = id;
        return true;
      })
    );
    axisVarBtns[id] = btn;
    axisVarRow.appendChild(btn);
  });
  sec3Body.appendChild(axisVarRow);

  function makeAxisLabelRow(labelText, field) {
    const row = document.createElement("div");
    row.className = "insp-row";
    const lbl = document.createElement("label");
    lbl.className = "insp-field-label";
    lbl.textContent = labelText;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "insp-input";
    function commit() {
      commitAxes((o) => {
        if ((o[field] ?? "") === inp.value) return false;
        o[field] = inp.value;
        return true;
      });
    }
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    inp.addEventListener("blur", commit);
    row.appendChild(lbl);
    row.appendChild(inp);
    sec3Body.appendChild(row);
    return { row, inp };
  }
  const axisLabelXRow = makeAxisLabelRow("X 라벨", "labelX");
  const axisLabelYRow = makeAxisLabelRow("Y 라벨", "labelY");
  const axisLabelTypeRow = makeLabelTypeRow((o) => o.type === "axes");
  sec3Body.appendChild(axisLabelTypeRow.row);

  const tickRow = document.createElement("div");
  tickRow.className = "insp-row";
  const tickLbl = document.createElement("label");
  tickLbl.className = "insp-field-label";
  tickLbl.textContent = "눈금 간격";
  const tickInp = document.createElement("input");
  tickInp.type = "number";
  tickInp.step = "0.5";
  tickInp.min = "0.5";
  tickInp.className = "insp-input";
  function commitTick() {
    const val = parseFloat(tickInp.value);
    if (!isFinite(val)) return;
    const clamped = Math.max(val, 0.5); // sane minimum (matches render clamp)
    commitAxes((o) => {
      if (o.tickSpacing === clamped) return false;
      o.tickSpacing = clamped;
      return true;
    });
  }
  tickInp.addEventListener("keydown", (e) => { if (e.key === "Enter") tickInp.blur(); });
  tickInp.addEventListener("blur", commitTick);
  tickRow.appendChild(tickLbl);
  tickRow.appendChild(tickInp);
  sec3Body.appendChild(tickRow);

  // lens-only: 중앙 세로 점선 옵션 (none/top/bottom/full). Shown only when a single
  // convex_lens or concave_lens is selected (mirrors the axes-only block above).
  const CENTERLINE_OPTS = [
    { id: "none",   label: "없음" },
    { id: "top",    label: "위쪽" },
    { id: "bottom", label: "아래쪽" },
    { id: "full",   label: "전체" },
  ];
  // Mutate the single selected lens object under one undo snapshot, like commitAxes.
  function commitLens(apply) {
    const s = state.get();
    if (!(s.selectedIds || []).length) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((o) => o.id === (s2.selectedIds || [])[0]);
      if (!o || o.locked || o.type !== "optics") return;
      if (o.kind !== "convex_lens" && o.kind !== "concave_lens") return;
      if (!apply(o)) return;
      s2.undoStack.push(snap); s2.redoStack = [];
    });
  }

  const centerLineRow = document.createElement("div");
  centerLineRow.className = "insp-row";
  const centerLineLbl = document.createElement("label");
  centerLineLbl.className = "insp-field-label";
  centerLineLbl.textContent = "중앙 점선";
  const centerLineSel = document.createElement("select");
  centerLineSel.className = "insp-input";
  CENTERLINE_OPTS.forEach(({ id, label }) => {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = label;
    centerLineSel.appendChild(opt);
  });
  centerLineSel.addEventListener("change", () => {
    commitLens((o) => {
      if ((o.centerLine || "none") === centerLineSel.value) return false;
      o.centerLine = centerLineSel.value;
      return true;
    });
  });
  centerLineRow.appendChild(centerLineLbl);
  centerLineRow.appendChild(centerLineSel);
  sec3Body.appendChild(centerLineRow);

  // diode-only: two terminal labels (단자1 / 단자2) replacing the single 라벨 row.
  function makeTermRow(labelText, idx) {
    const row = document.createElement("div");
    row.className = "insp-row";
    const lbl = document.createElement("label");
    lbl.className = "insp-field-label";
    lbl.textContent = labelText;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "insp-input";
    function commit() {
      const s = state.get();
      if (!(s.selectedIds || []).length) return;
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const o = s2.objects.find((o) => o.id === (s2.selectedIds || [])[0]);
        if (!o || o.locked) return;
        const cur = Array.isArray(o.terminalLabels) ? o.terminalLabels.slice() : ["", ""];
        if ((cur[idx] ?? "") === inp.value) return; // no-op → no undo entry
        cur[idx] = inp.value;
        s2.undoStack.push(snap); s2.redoStack = [];
        o.terminalLabels = cur;
      });
    }
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    inp.addEventListener("blur", commit);
    row.appendChild(lbl);
    row.appendChild(inp);
    sec3Body.appendChild(row);
    return { el: row, inp };
  }
  const term1 = makeTermRow("단자1", 0);
  const term2 = makeTermRow("단자2", 1);
  const terminalLabelTypeRow = makeLabelTypeRow((o) => o.type === "circuit" && o.element === "diode");
  sec3Body.appendChild(terminalLabelTypeRow.row);

  const raSizeF = makePosRow("크기", "size", "0.1");
  const raAngleF = makePosRow("각도", "angle", "1");
  const raDirRow = document.createElement("div");
  raDirRow.className = "insp-row";
  const raDirLbl = document.createElement("label");
  raDirLbl.className = "insp-field-label";
  raDirLbl.textContent = "방향";
  const raDirSel = document.createElement("select");
  raDirSel.className = "insp-input";
  [["1", "시계반대"], ["-1", "시계"]].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    raDirSel.appendChild(opt);
  });
  raDirRow.appendChild(raDirLbl);
  raDirRow.appendChild(raDirSel);
  sec3Body.appendChild(raSizeF.el);
  sec3Body.appendChild(raAngleF.el);
  sec3Body.appendChild(raDirRow);

  function commitSelectedObject(apply) {
    const s = state.get();
    if (!(s.selectedIds || []).length) return;
    const snap = JSON.parse(JSON.stringify(s.objects));
    state.update((s2) => {
      const o = s2.objects.find((item) => item.id === (s2.selectedIds || [])[0]);
      if (!o || o.locked) return;
      if (!apply(o)) return;
      s2.undoStack.push(snap);
      s2.redoStack = [];
    });
  }
  raDirSel.addEventListener("change", () => {
    const next = parseInt(raDirSel.value, 10) || 1;
    commitSelectedObject((o) => {
      if (o.type !== "rightangle" || (o.orientation ?? 1) === next) return false;
      o.orientation = next;
      return true;
    });
  });

  const appLengthF = makePosRow("길이", "length", "0.1");
  const appAngleF = makePosRow("각도", "angle", "1");
  const appThicknessF = makePosRow("굵기", "thickness", "0.1");
  const appNeedleF = makePosRow("방향각", "needleAngle", "1");
  sec3Body.appendChild(appLengthF.el);
  sec3Body.appendChild(appAngleF.el);
  sec3Body.appendChild(appThicknessF.el);
  sec3Body.appendChild(appNeedleF.el);

  const pulleyVariantRow = document.createElement("div");
  pulleyVariantRow.className = "insp-row";
  const pulleyVariantLbl = document.createElement("label");
  pulleyVariantLbl.className = "insp-field-label";
  pulleyVariantLbl.textContent = "형태";
  const pulleyVariantSel = document.createElement("select");
  pulleyVariantSel.className = "insp-input";
  [["basic", "기본형"], ["simple", "단순형"]].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    pulleyVariantSel.appendChild(opt);
  });
  pulleyVariantRow.appendChild(pulleyVariantLbl);
  pulleyVariantRow.appendChild(pulleyVariantSel);
  sec3Body.appendChild(pulleyVariantRow);
  pulleyVariantSel.addEventListener("change", () => {
    commitSelectedObject((o) => {
      if (o.type !== "apparatus" || o.kind !== "pulley" || (o.variant || "basic") === pulleyVariantSel.value) return false;
      o.variant = pulleyVariantSel.value;
      return true;
    });
  });

  const clampFlipRow = document.createElement("div");
  clampFlipRow.className = "insp-row";
  const clampFlipCb = document.createElement("input");
  clampFlipCb.type = "checkbox";
  clampFlipCb.className = "insp-cb";
  const clampFlipLbl = document.createElement("label");
  clampFlipLbl.className = "insp-field-label";
  clampFlipLbl.textContent = "좌우 반전";
  clampFlipRow.appendChild(clampFlipCb);
  clampFlipRow.appendChild(clampFlipLbl);
  sec3Body.appendChild(clampFlipRow);
  clampFlipCb.addEventListener("change", () => {
    const next = clampFlipCb.checked;
    commitSelectedObject((o) => {
      if (o.type !== "apparatus" || o.kind !== "clamp" || !!o.flipped === next) return false;
      o.flipped = next;
      return true;
    });
  });

  const scaleTextRow = document.createElement("div");
  scaleTextRow.className = "insp-row";
  const scaleTextLbl = document.createElement("label");
  scaleTextLbl.className = "insp-field-label";
  scaleTextLbl.textContent = "표시값";
  const scaleTextInp = document.createElement("input");
  scaleTextInp.type = "text";
  scaleTextInp.className = "insp-input";
  scaleTextRow.appendChild(scaleTextLbl);
  scaleTextRow.appendChild(scaleTextInp);
  sec3Body.appendChild(scaleTextRow);
  scaleTextInp.addEventListener("keydown", (e) => { if (e.key === "Enter") scaleTextInp.blur(); });
  scaleTextInp.addEventListener("blur", () => {
    commitSelectedObject((o) => {
      if (o.type !== "apparatus" || o.kind !== "scale" || (o.displayText ?? "") === scaleTextInp.value) return false;
      o.displayText = scaleTextInp.value;
      return true;
    });
  });

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

  function setStyleControlsDisabled(disabled, fillNone = false, locked = false) {
    strokeCP.setDisabled(disabled);
    widthRange.disabled = disabled;
    widthNum.disabled = disabled;
    [
      arrowBtn,
      partialDashBtn,
      flipBtn,
      ...Object.values(lineModeBtnEls),
      ..._dashBtnEls,
      ...Object.values(_fillStyleBtnEls),
    ].forEach((btn) => setButtonDisabled(btn, disabled));
    dashLenSlider.range.disabled = disabled;
    dashLenSlider.num.disabled = disabled;
    dashGapSlider.range.disabled = disabled;
    dashGapSlider.num.disabled = disabled;
    ratioRange.disabled = disabled;
    ratioNum.disabled = disabled;
    fillCP.setDisabled(disabled || fillNone);
    fnCb.disabled = disabled;
    fontFamSel.disabled = disabled;
    fontSizeNum.disabled = disabled;
    italicCb.disabled = disabled;
    fontDlgBtn.disabled = disabled;
    centerLineSel.disabled = disabled || locked;
  }

  /* ---- Subscribe: populate controls on every state change ---- */
  function populate(s) {
    renderLayerPanel(s);
    const ids = s.selectedIds || [];
    const selectedObjects = ids.map((id) => s.objects.find((o) => o.id === id)).filter(Boolean);

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
    // Group-3 upright-label rows: shown only for a single rect/ellipse (box) or
    // line (set in the single-selection branch); hidden in every other case.
    boxLabelRow.style.display = "none";
    boxLabelTypeRow.row.style.display = "none";
    boxLabelPosRow.style.display = "none";
    boxLabelSizeRow.row.style.display = "none";
    lineLabelRow.style.display = "none";
    lineLabelTypeRow.row.style.display = "none";
    lineLabelShowRow.style.display = "none";
    lineLabelFlipRow.style.display = "none";
    lineLabelSizeRow.row.style.display = "none";
    dimensionLabelTypeRow.row.style.display = "none";
    objectLabelTypeRow.row.style.display = "none";
    axisLabelTypeRow.row.style.display = "none";
    terminalLabelTypeRow.row.style.display = "none";

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
      partialControls.style.display = "none";
      closeRow.style.display = "none";
      roundRow.style.display = "none";
      radiusRow.style.display = "none";
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
      partialControls.style.display = "none";
      closeRow.style.display = "none";
      roundRow.style.display = "none";
      radiusRow.style.display = "none";
      angleRow.style.display = "none";
      // A group always uses the box rows (W/H + rotation); never the arc rows,
      // even if the prior single selection was an anglearc.
      whPair.style.display  = "flex";
      rotF.el.style.display = "";
      radF.el.style.display = "none";
      arcPair.style.display = "none";
      // Per-object symbol rows never apply to a group; keep them hidden.
      labelRow.style.display = "none";
      showLabelRow.style.display = "none";
      gapRow.style.display = "none";
      term1.el.style.display = "none";
      term2.el.style.display = "none";
      axisVarRow.style.display = "none";
      axisLabelXRow.row.style.display = "none";
      axisLabelYRow.row.style.display = "none";
      tickRow.style.display = "none";
      raSizeF.el.style.display = "none";
      raAngleF.el.style.display = "none";
      raDirRow.style.display = "none";
      appLengthF.el.style.display = "none";
      appAngleF.el.style.display = "none";
      appThicknessF.el.style.display = "none";
      appNeedleF.el.style.display = "none";
      pulleyVariantRow.style.display = "none";
      clampFlipRow.style.display = "none";
      scaleTextRow.style.display = "none";

      const groupHasLocked = ids.some((id) => s.objects.find((o) => o.id === id)?.locked);
      const groupHasPositionLocked = ids.some((id) => s.objects.find((o) => o.id === id)?.positionLocked);
      const groupStyleDisabled = false; // style mode removed — never disabled by mode
      xF.inp.disabled = groupHasLocked || groupHasPositionLocked;
      yF.inp.disabled = groupHasLocked || groupHasPositionLocked;
      wF.inp.disabled = groupHasLocked;
      hF.inp.disabled = groupHasLocked;
      rotF.inp.disabled = groupHasLocked;

      if (_dragging) return;

      const firstStyleObj = resolveObjectStyle(firstObj);
      strokeCP.setValue(firstStyleObj.strokeLevel ?? 0);
      const _sw = firstStyleObj.strokeWidth ?? 0.2;
      widthRange.value = _sw;
      widthNum.value =_sw.toFixed(1);

      const _fn = !!(firstStyleObj.fillNone);
      fnCb.checked = _fn;
      fillCP.setValue(firstStyleObj.fillLevel ?? 255);
      syncFillStyle(firstStyleObj);
      setStyleControlsDisabled(groupStyleDisabled, _fn, groupHasLocked);

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
      partialControls.style.display = "none";
      closeRow.style.display = "none";
      roundRow.style.display = "none";
      radiusRow.style.display = "none";
      angleRow.style.display = "none";

      if (_dragging) return;

      if (!firstObj) return;

      const multiStyleDisabled = false; // style mode removed — never disabled by mode
      const firstStyleObj = resolveObjectStyle(firstObj);
      strokeCP.setValue(firstStyleObj.strokeLevel ?? 0);
      const sw = firstStyleObj.strokeWidth ?? 0.2;
      widthRange.value = sw;
      widthNum.value =sw.toFixed(1);

      const fn = !!(firstStyleObj.fillNone);
      fnCb.checked = fn;
      fillCP.setValue(firstStyleObj.fillLevel ?? 255);
      syncFillStyle(firstStyleObj);
      setStyleControlsDisabled(multiStyleDisabled, fn, false);
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

    const styleObj = resolveObjectStyle(obj);
    const styleDisabled = false; // style mode removed — never disabled by mode
    // Formula shares the text font controls (family + size apply to its glyphs).
    const isText = obj.type === "text" || obj.type === "formula";
    // Text has no stroke/fill controls; it gets its own 글꼴 section instead.
    sec1.style.display = isText ? "none" : "";
    secText.style.display = isText ? "" : "none";
    if (isText) {
      fontFamSel.value = styleObj.fontFamily || DEFAULT_TEXT_FONT;
      italicCb.checked = styleObj.italic === true;
      if (document.activeElement !== fontSizeNum) {
        // Stored fontSize is world-unit mm; the field shows points.
        fontSizeNum.value = Math.round(mmToPt(styleObj.fontSize ?? 0) * 10) / 10;
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

    // 경사면처리 + 곡률 반경: single polyline only (open or closed).
    roundRow.style.display = isPolyline ? "" : "none";
    radiusRow.style.display = isPolyline ? "" : "none";
    if (isPolyline) {
      const isRounded = obj.rounded === true;
      roundCb.checked = isRounded;
      radiusInp.disabled = !isRounded;
      radiusRow.style.opacity = isRounded ? "" : "0.5";
      if (document.activeElement !== radiusInp) radiusInp.value = obj.cornerRadius ?? 10;
    }

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
    dimensionLabelTypeRow.row.style.display = isStraightLine && lineMode === "lengthArrow" ? "" : "none";
    if (document.activeElement !== dimensionLabelInp) dimensionLabelInp.value = obj.dimensionLabel ?? "d";
    if (isStraightLine && lineMode === "lengthArrow") dimensionLabelTypeRow.sync(obj);

    // Group-3 straight-line upright label: text + on/off toggle + 반전 + 크기.
    // Hidden entirely in length-display (lengthArrow) mode — the dimension label
    // along the line is shown instead, so the external label is redundant (task 3).
    const showLineLabel = isStraightLine && lineMode !== "lengthArrow";
    lineLabelRow.style.display = showLineLabel ? "" : "none";
    lineLabelTypeRow.row.style.display = showLineLabel ? "" : "none";
    lineLabelShowRow.style.display = showLineLabel ? "" : "none";
    lineLabelFlipRow.style.display = showLineLabel ? "" : "none";
    lineLabelSizeRow.row.style.display = showLineLabel ? "" : "none";
    if (showLineLabel) {
      if (document.activeElement !== lineLabelInp) lineLabelInp.value = obj.label ?? "";
      lineLabelTypeRow.sync(obj);
      lineLabelShowCb.checked = obj.labelShow === true;
      if (document.activeElement !== lineLabelSizeRow.num) {
        lineLabelSizeRow.num.value = Math.round(mmToPt(obj.labelSize || DEFAULT_TEXT_SIZE_MM));
      }
    }

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
    const canDash = supportsDash(obj);
    dashRow.style.display = canDash ? "" : "none";
    if (canDash) {
      syncDashControls(styleObj);
    } else {
      dashSliders.style.display = "none";
      partialControls.style.display = "none";
    }

    // Section 1
    strokeCP.setValue(styleObj.strokeLevel ?? 0);
    const sw = styleObj.strokeWidth ?? 0.2;
    widthRange.value = sw;
    widthNum.value =sw.toFixed(1);

    // Section 2
    const fn = !!(styleObj.fillNone);
    fnCb.checked = fn;
    fillCP.setValue(styleObj.fillLevel ?? 255);
    syncFillStyle(styleObj);

    // Section 3 — shape types + axes (size-based: X/Y/W/H/rotation), plus the
    // anglearc (X/Y + radius/startAngle/sweepAngle in math convention, CCW +).
    // Optics is a branch-A box (X/Y/W/H/rotation), like rect + axes.
    const isOptics = obj.type === "optics";
    const isApparatus = obj.type === "apparatus";
    const appKind = isApparatus ? (obj.kind || "wire") : null;
    const isShape = SHAPE_TYPES.includes(obj.type) || obj.type === "axes" || isOptics || isApparatus;
    const isArc = obj.type === "anglearc";
    const isRightAngle = obj.type === "rightangle";
    const isCircuit = obj.type === "circuit";
    const isLabeler = obj.type === "labeler";
    // Circuit element variants: capacitor adds 간격; diode swaps the single 라벨 for
    // two terminal labels. Everything else uses the single 라벨 row.
    const circElem = isCircuit ? obj.element : null;
    const isCap = circElem === "capacitor";
    const isDiode = circElem === "diode";
    const hasCircuitHeight = isCircuit && CIRCUIT_HEIGHT_ELEMENTS.has(circElem);
    const isAxes = obj.type === "axes";
    const axisVariant = isAxes ? (obj.axisVariant || "cross") : null;
    sec3.style.display = (isShape || isArc || isRightAngle || isCircuit || isLabeler) ? "" : "none";
    // Toggle which rows belong to this selection: arc swaps W/H + rotation for
    // radius + start/sweep angle; circuit (two terminals) hides the box rows.
    xyPair.style.display  = (isCircuit || isLabeler) ? "none" : "flex";
    whPair.style.display  = (isArc || isRightAngle || isCircuit || isLabeler) ? "none" : "flex";
    rotF.el.style.display = (isArc || isRightAngle || isCircuit || isLabeler) ? "none" : "";
    radF.el.style.display = isArc ? "" : "none";
    arcPair.style.display = isArc ? "flex" : "none";
    raSizeF.el.style.display = isRightAngle ? "" : "none";
    raAngleF.el.style.display = isRightAngle ? "" : "none";
    raDirRow.style.display = isRightAngle ? "" : "none";
    appLengthF.el.style.display = isApparatus && appKind === "wire" ? "" : "none";
    appAngleF.el.style.display = isApparatus && appKind === "wire" ? "" : "none";
    appThicknessF.el.style.display = isApparatus && appKind === "wire" ? "" : "none";
    appNeedleF.el.style.display = isApparatus && appKind === "compass" ? "" : "none";
    pulleyVariantRow.style.display = isApparatus && appKind === "pulley" ? "" : "none";
    clampFlipRow.style.display = isApparatus && appKind === "clamp" ? "" : "none";
    scaleTextRow.style.display = isApparatus && appKind === "scale" ? "" : "none";
    // Single 라벨 row: arc, optics, and all circuits EXCEPT diode (which uses 단자1/2).
    const isNode = isOptics && obj.kind === "node";
    const showObjectLabel = isArc || isOptics || (isCircuit && !isDiode);
    labelRow.style.display = showObjectLabel ? "" : "none";
    objectLabelTypeRow.row.style.display = showObjectLabel ? "" : "none";
    // node uses a label-position dropdown instead of the show/hide toggle.
    showLabelRow.style.display = (isOptics && !isNode) ? "" : "none";
    labelPosRow.style.display = isNode ? "" : "none";
    labelerLenRow.style.display = isLabeler ? "" : "none";
    labelerAngleRow.style.display = isLabeler ? "" : "none";
    if (isLabeler) {
      if (document.activeElement !== labelerLenInp) {
        const len = Math.hypot(obj.p2.x - obj.p1.x, obj.p2.y - obj.p1.y);
        labelerLenInp.value = len.toFixed(2);
      }
      if (document.activeElement !== labelerAngleInp) {
        const ang = Math.atan2(obj.p2.y - obj.p1.y, obj.p2.x - obj.p1.x) * 180 / Math.PI;
        labelerAngleInp.value = ang.toFixed(1);
      }
    }
    arcLabelEditRow.style.display = isArc ? "" : "none";

    // Group-3 box upright label: rect/ellipse only (text + center/above/below).
    const isBoxLabelType = obj.type === "rect" || obj.type === "ellipse";
    boxLabelRow.style.display = isBoxLabelType ? "" : "none";
    boxLabelTypeRow.row.style.display = isBoxLabelType ? "" : "none";
    boxLabelPosRow.style.display = isBoxLabelType ? "" : "none";
    boxLabelSizeRow.row.style.display = isBoxLabelType ? "" : "none";
    if (isBoxLabelType) {
      if (document.activeElement !== boxLabelInp) boxLabelInp.value = obj.label ?? "";
      boxLabelTypeRow.sync(obj);
      boxLabelPosSel.value = ["center", "above", "below", "left", "right"].includes(obj.labelPos) ? obj.labelPos : "center";
      if (document.activeElement !== boxLabelSizeRow.num) {
        boxLabelSizeRow.num.value = Math.round(mmToPt(obj.labelSize || DEFAULT_TEXT_SIZE_MM));
      }
    }
    gapRow.style.display = isCap ? "" : "none";
    circuitHeightF.el.style.display = hasCircuitHeight ? "" : "none";
    term1.el.style.display = isDiode ? "" : "none";
    term2.el.style.display = isDiode ? "" : "none";
    terminalLabelTypeRow.row.style.display = isDiode ? "" : "none";
    // axes-only rows. single variant ignores labelY → hide that one row.
    axisVarRow.style.display = isAxes ? "" : "none";
    axisLabelXRow.row.style.display = isAxes ? "" : "none";
    axisLabelYRow.row.style.display = (isAxes && axisVariant !== "single") ? "" : "none";
    axisLabelTypeRow.row.style.display = isAxes ? "" : "none";
    tickRow.style.display = isAxes ? "" : "none";
    // lens-only center dashed-line row.
    const isLens = isOptics && (obj.kind === "convex_lens" || obj.kind === "concave_lens");
    centerLineRow.style.display = isLens ? "" : "none";
    if (isShape) {
      xF.inp.value   = (obj.x        ?? 0).toFixed(2);
      yF.inp.value   = (-(obj.y      ?? 0)).toFixed(2); // SVG Y down → math Y up
      wF.inp.value   = (obj.w        ?? 0).toFixed(2);
      hF.inp.value   = (obj.h        ?? 0).toFixed(2);
      rotF.inp.value = (obj.rotation ?? 0).toFixed(1);
    }
    if (isArc) {
      xF.inp.value    = (obj.x          ?? 0).toFixed(2);
      yF.inp.value    = (-(obj.y        ?? 0)).toFixed(2); // SVG Y down → math Y up
      radF.inp.value  = (obj.radius     ?? 0).toFixed(2);
      saF.inp.value   = (obj.startAngle ?? 0).toFixed(1);
      swF.inp.value   = (obj.sweepAngle ?? 0).toFixed(1);
      labelInp.value  = obj.label ?? "";
    }
    if (isRightAngle) {
      xF.inp.value = (obj.x ?? 0).toFixed(2);
      yF.inp.value = (-(obj.y ?? 0)).toFixed(2);
      raSizeF.inp.value = (obj.size ?? 0).toFixed(2);
      raAngleF.inp.value = (obj.angle ?? 0).toFixed(1);
      raDirSel.value = String((obj.orientation ?? 1) >= 0 ? 1 : -1);
    }
    if (isApparatus) {
      if (appKind === "wire") {
        if (document.activeElement !== appLengthF.inp) appLengthF.inp.value = (obj.length ?? obj.w ?? 0).toFixed(2);
        if (document.activeElement !== appAngleF.inp) appAngleF.inp.value = (obj.angle ?? 0).toFixed(1);
        if (document.activeElement !== appThicknessF.inp) appThicknessF.inp.value = (obj.thickness ?? obj.gap ?? 1.8).toFixed(2);
      }
      if (appKind === "compass" && document.activeElement !== appNeedleF.inp) appNeedleF.inp.value = (obj.needleAngle ?? -90).toFixed(1);
      if (appKind === "pulley") pulleyVariantSel.value = obj.variant || "basic";
      if (appKind === "clamp") clampFlipCb.checked = !!obj.flipped;
      if (appKind === "scale" && document.activeElement !== scaleTextInp) scaleTextInp.value = obj.displayText ?? "0.99 N";
    }
    if ((isCircuit && !isDiode || isOptics) && document.activeElement !== labelInp) {
      labelInp.value  = obj.label ?? "";
    }
    if (showObjectLabel) objectLabelTypeRow.sync(obj);
    if (isOptics) showLabelCb.checked = !!obj.showLabel;
    if (isNode) labelPosSel.value = (obj.labelPos === "below") ? "below" : "above";
    if (isLens) centerLineSel.value = styleObj.centerLine || "none";
    if (isCap && document.activeElement !== gapInp) {
      gapInp.value = (obj.gap ?? 2).toFixed(1);
    }
    if (hasCircuitHeight && document.activeElement !== circuitHeightF.inp) {
      const defaultHeight = (circElem === "voltmeter" || circElem === "ammeter") ? 5.12 : 3.2;
      circuitHeightF.inp.value = String(obj.height ?? defaultHeight);
    }
    if (isDiode) {
      const tl = Array.isArray(obj.terminalLabels) ? obj.terminalLabels : ["", ""];
      if (document.activeElement !== term1.inp) term1.inp.value = tl[0] ?? "";
      if (document.activeElement !== term2.inp) term2.inp.value = tl[1] ?? "";
      terminalLabelTypeRow.sync(obj);
    }
    if (isAxes) {
      Object.entries(axisVarBtns).forEach(([id, btn]) => {
        const active = id === axisVariant;
        btn.style.background = active ? "#4a9eff" : "#1e1f22";
        btn.style.borderColor = active ? "#4a9eff" : "#3a3c41";
      });
      if (document.activeElement !== axisLabelXRow.inp) axisLabelXRow.inp.value = obj.labelX ?? "";
      if (document.activeElement !== axisLabelYRow.inp) axisLabelYRow.inp.value = obj.labelY ?? "";
      axisLabelTypeRow.sync(obj);
      if (document.activeElement !== tickInp) tickInp.value = (obj.tickSpacing ?? 5).toString();
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
    radF.inp.disabled = !!obj.locked;
    saF.inp.disabled = !!obj.locked;
    swF.inp.disabled = !!obj.locked;
    labelInp.disabled = !!obj.locked;
    arcLabelEditBtn.disabled = !!obj.locked;
    labelerLenInp.disabled = !!obj.locked;
    labelerAngleInp.disabled = !!obj.locked;
    showLabelCb.disabled = !!obj.locked;
    labelPosSel.disabled = !!obj.locked;
    boxLabelInp.disabled = !!obj.locked;
    boxLabelTypeRow.sel.disabled = !!obj.locked;
    boxLabelPosSel.disabled = !!obj.locked;
    lineLabelInp.disabled = !!obj.locked;
    lineLabelTypeRow.sel.disabled = !!obj.locked;
    lineLabelShowCb.disabled = !!obj.locked;
    dimensionLabelInp.disabled = !!obj.locked;
    dimensionLabelTypeRow.sel.disabled = !!obj.locked;
    objectLabelTypeRow.sel.disabled = !!obj.locked;
    terminalLabelTypeRow.sel.disabled = !!obj.locked;
    axisLabelTypeRow.sel.disabled = !!obj.locked;
    gapInp.disabled = !!obj.locked;
    circuitHeightF.inp.disabled = !!obj.locked;
    term1.inp.disabled = !!obj.locked;
    term2.inp.disabled = !!obj.locked;
    axisLabelXRow.inp.disabled = !!obj.locked;
    axisLabelYRow.inp.disabled = !!obj.locked;
    tickInp.disabled = !!obj.locked;
    centerLineSel.disabled = !!obj.locked;
    raSizeF.inp.disabled = !!obj.locked;
    raAngleF.inp.disabled = !!obj.locked;
    raDirSel.disabled = !!obj.locked;
    appLengthF.inp.disabled = !!obj.locked;
    appAngleF.inp.disabled = !!obj.locked;
    appThicknessF.inp.disabled = !!obj.locked;
    appNeedleF.inp.disabled = !!obj.locked;
    pulleyVariantSel.disabled = !!obj.locked;
    clampFlipCb.disabled = !!obj.locked;
    scaleTextInp.disabled = !!obj.locked;
    Object.values(axisVarBtns).forEach((btn) => { btn.disabled = !!obj.locked; });
    setStyleControlsDisabled(styleDisabled, fn, !!obj.locked);
  }

  state.subscribe(populate);
  populate(state.get());
}
