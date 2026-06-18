/* ===== INSPECTOR (right panel — shows/edits selected object properties) ===== */

const GRAY_LEVELS = [0, 43, 85, 128, 170, 213, 255];
const SHAPE_TYPES = ["rect", "ellipse", "triangle"];
// Branch-B "line family": share arrow + dash controls; fill section is hidden for them.
const LINE_TYPES = ["line", "polyline", "curve"];
// Dash presets (world units / mm). 실선 = (0,0) = solid (no dasharray).
const DASH_PRESETS = [
  { label: "실선",  dashLength: 0, dashGap: 0 },
  { label: "점선1", dashLength: 2, dashGap: 2 },
  { label: "점선2", dashLength: 5, dashGap: 3 },
  { label: "점선3", dashLength: 1, dashGap: 3 },
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

  const barWrap = document.createElement("div");
  barWrap.className = "cp-bar-wrap";
  const bar = document.createElement("div");
  bar.className = "cp-bar";
  const handle = document.createElement("div");
  handle.className = "cp-handle";
  barWrap.appendChild(bar);
  barWrap.appendChild(handle);

  const preview = document.createElement("div");
  preview.className = "cp-preview";

  root.appendChild(palette);
  root.appendChild(barWrap);
  root.appendChild(preview);

  let _level = 0;

  function setLevel(v, fire) {
    _level = Math.round(Math.max(0, Math.min(255, v)));
    const pct = (1 - _level / 255) * 100; // left=white=255, right=black=0
    handle.style.left = `${pct}%`;
    preview.style.background = levelToHex(_level);
    if (fire && onInput) onInput(_level);
  }

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

  // Wire left-edge resize handle
  const resizeHandle = document.getElementById("inspector-resize");
  const panelRight = document.querySelector(".panel-right");
  if (resizeHandle && panelRight) {
    resizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panelRight.offsetWidth;
      function onMove(e2) {
        const newW = Math.min(400, Math.max(200, startW + (startX - e2.clientX)));
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

  const strokeColorLbl = document.createElement("div");
  strokeColorLbl.className = "insp-field-label";
  strokeColorLbl.textContent = "선 색";
  sec1Body.appendChild(strokeColorLbl);

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
  widthRange.max = "5";
  widthRange.step = "0.1";
  widthRange.className = "insp-range";
  const widthNum = document.createElement("input");
  widthNum.type = "number";
  widthNum.min = "0.1";
  widthNum.max = "5";
  widthNum.step = "0.1";
  widthNum.style.cssText = "width:40px;font-size:11px;border:1px solid #3a3c41;border-radius:3px;padding:2px 4px;text-align:center;background:#1e1f22;color:#dcddde;";
  const widthUnit = document.createElement("span");
  widthUnit.textContent = "pt";
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
  const ARROW_OPTIONS = [
    { label: "없음", value: "none"   },
    { label: "끝",   value: "end"    },
    { label: "양끝", value: "both"   },
    { label: "중앙", value: "center" },
  ];
  const _arrowBtnEls = {};
  ARROW_OPTIONS.forEach(({ label, value }) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = "padding:2px 6px;font-size:10px;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
    btn.addEventListener("click", () => {
      const s = state.get();
      const ids = s.selectedIds || [];
      if (ids.length !== 1) return;
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const o = s2.objects.find((o) => o.id === ids[0]);
        // Same single arrowHead field for line AND polyline (curve excluded this round).
        if (o && (o.type === "line" || o.type === "polyline")) {
          o.arrowHead = value;
          s2.undoStack.push(snap);
          s2.redoStack = [];
        }
      });
    });
    _arrowBtnEls[value] = btn;
    arrowBtns.appendChild(btn);
  });
  arrowRow.appendChild(arrowLbl);
  arrowRow.appendChild(arrowBtns);
  sec1Body.appendChild(arrowRow);

  // ---- Dash presets + length/gap sliders (line/polyline/curve) ----
  const dashRow = document.createElement("div");
  dashRow.className = "insp-row";
  const dashLbl = document.createElement("label");
  dashLbl.className = "insp-field-label";
  dashLbl.textContent = "선 종류";
  const dashBtns = document.createElement("div");
  dashBtns.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
  const _dashBtnEls = [];
  DASH_PRESETS.forEach((preset) => {
    const btn = document.createElement("button");
    btn.textContent = preset.label;
    btn.style.cssText = "padding:2px 6px;font-size:10px;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
    btn.addEventListener("click", () => {
      const s = state.get();
      const ids = s.selectedIds || [];
      if (ids.length !== 1) return;
      const snap = JSON.parse(JSON.stringify(s.objects));
      state.update((s2) => {
        const o = s2.objects.find((o) => o.id === ids[0]);
        if (o && LINE_TYPES.includes(o.type)) {
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
    range.min = "0.5";
    range.max = "10";
    range.step = "0.5";
    range.className = "insp-range";
    const num = document.createElement("input");
    num.type = "number";
    num.min = "0.5";
    num.max = "10";
    num.step = "0.5";
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
        if (o && LINE_TYPES.includes(o.type)) o[prop] = val;
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
      const val = Math.min(10, Math.max(0.5, raw));
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
      if (o && o.type === "polyline") {
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
    const val = Math.min(5, Math.max(0.1, raw));
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

  const sec1 = makeSection("선", sec1Body);
  contentEl.appendChild(sec1);

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
  sec2Body.appendChild(fnRow);

  const fillColorLbl = document.createElement("div");
  fillColorLbl.className = "insp-field-label";
  fillColorLbl.textContent = "채우기 색";
  sec2Body.appendChild(fillColorLbl);

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
  const FILL_STYLE_OPTIONS = [
    { label: "색",   value: "solid" },
    { label: "도트", value: "dots"  },
    { label: "엑스", value: "cross" },
    { label: "헤칭", value: "hatch" },
  ];
  const _fillStyleBtnEls = {};
  FILL_STYLE_OPTIONS.forEach(({ label, value }) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = "padding:2px 6px;font-size:10px;cursor:pointer;border:1px solid #3a3c41;border-radius:3px;background:#1e1f22;color:#dcddde;";
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

  const sec2 = makeSection("채우기", sec2Body);
  contentEl.appendChild(sec2);

  /* ---- Section 3: 크기·위치 (shapes only, single selection only) ---- */
  const sec3Body = document.createElement("div");
  sec3Body.className = "insp-body";

  function makePosRow(label, prop, step) {
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
        s2.undoStack.push(snap);
        s2.redoStack = [];
        o[prop] = val;
      });
    }

    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    inp.addEventListener("blur", commit);
    row.appendChild(lbl);
    row.appendChild(inp);
    return { el: row, inp };
  }

  const xF   = makePosRow("X",     "x",        "0.1");
  const yF   = makePosRow("Y",     "y",        "0.1");
  const wF   = makePosRow("W",     "w",        "0.1");
  const hF   = makePosRow("H",     "h",        "0.1");
  const rotF = makePosRow("회전 °", "rotation", "1");

  sec3Body.appendChild(rotF.el);

  const xyPair = document.createElement("div");
  xyPair.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
  xyPair.appendChild(xF.el);
  xyPair.appendChild(yF.el);
  sec3Body.appendChild(xyPair);

  const whPair = document.createElement("div");
  whPair.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
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

  const sec4 = makeSection("보호", sec4Body);
  contentEl.appendChild(sec4);

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

    // Caption: top row is front-most. Matches the 3 → 2 → 1 list order below.
    const caption = document.createElement("div");
    caption.textContent = "위 행이 앞(전면)에 그려집니다.";
    caption.style.cssText =
      "font-size:11px;color:#8a8a8a;padding:0 8px 4px;user-select:none;";
    layerBody.appendChild(caption);

    // Bordered box holding the layer rows.
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
      return;
    }

    emptyEl.style.display = "none";
    contentEl.style.display = "";

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
      sec3.style.display = "none";
      sec4.style.display = "none";
      arrowRow.style.display = "none";
      dashRow.style.display = "none";
      dashSliders.style.display = "none";
      closeRow.style.display = "none";

      if (_dragging) return;

      strokeCP.setValue(firstObj.strokeLevel ?? 0);
      const _sw = firstObj.strokeWidth ?? 1;
      widthRange.value = _sw;
      widthNum.value =_sw.toFixed(1);

      const _fn = !!(firstObj.fillNone);
      fnCb.checked = _fn;
      fillCP.setValue(firstObj.fillLevel ?? 255);
      fillCP.setDisabled(_fn);
      syncFillStyle(firstObj);
      return;
    }

    groupDiv.style.display = "none";

    if (ids.length > 1) {
      // Multi-selection (no shared group): only stroke/fill sections visible
      sec1.style.display = "";
      sec2.style.display = allLineFamily ? "none" : ""; // no fill for line family
      sec3.style.display = "none";
      sec4.style.display = "none";
      arrowRow.style.display = "none";
      dashRow.style.display = "none";
      dashSliders.style.display = "none";
      closeRow.style.display = "none";

      if (_dragging) return;

      if (!firstObj) return;

      strokeCP.setValue(firstObj.strokeLevel ?? 0);
      const sw = firstObj.strokeWidth ?? 1;
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

    sec1.style.display = "";
    const isLineFamily = LINE_TYPES.includes(obj.type);

    // 채우기 섹션 표시 규칙: rect/ellipse/triangle + 닫힌 polyline만 노출.
    // 숨김: line / 열린 polyline / curve / text. (닫힌 polyline은 채울 수 있다.)
    const isClosedPoly = obj.type === "polyline" && obj.closed === true;
    const showFill = SHAPE_TYPES.includes(obj.type) || isClosedPoly;
    sec2.style.display = showFill ? "" : "none";

    // 닫기 토글: 단일 polyline 선택 시에만 노출(열림/닫힘 모두).
    const isPolyline = obj.type === "polyline";
    closeRow.style.display = isPolyline ? "" : "none";
    if (isPolyline) closeCb.checked = obj.closed === true;

    // Arrow head: open line + open polyline (closed polyline = filled shape, no arrow).
    const showArrow = obj.type === "line" || (obj.type === "polyline" && !isClosedPoly);
    arrowRow.style.display = showArrow ? "" : "none";
    if (showArrow) {
      const ah = obj.arrowHead ?? "none";
      Object.entries(_arrowBtnEls).forEach(([val, btn]) => {
        btn.style.background = val === ah ? "#4a9eff" : "#1e1f22";
        btn.style.color      = val === ah ? "#ffffff" : "#dcddde";
        btn.style.border     = val === ah ? "1px solid #4a9eff" : "1px solid #3a3c41";
      });
    }

    // Dash presets + sliders: all line family (line/polyline/curve).
    dashRow.style.display = isLineFamily ? "" : "none";
    if (isLineFamily) {
      syncDashControls(obj);
    } else {
      dashSliders.style.display = "none";
    }

    // Section 1
    strokeCP.setValue(obj.strokeLevel ?? 0);
    const sw = obj.strokeWidth ?? 1;
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
      yF.inp.value   = (obj.y        ?? 0).toFixed(2);
      wF.inp.value   = (obj.w        ?? 0).toFixed(2);
      hF.inp.value   = (obj.h        ?? 0).toFixed(2);
      rotF.inp.value = (obj.rotation ?? 0).toFixed(1);
    }

    // Section 4
    sec4.style.display = "";
    lockCb.checked = !!(obj.locked);
  }

  state.subscribe(populate);
  populate(state.get());
}
