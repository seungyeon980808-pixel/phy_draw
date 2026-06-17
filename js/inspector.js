/* ===== INSPECTOR (right panel — shows/edits selected object properties) ===== */

const GRAY_LEVELS = [0, 43, 85, 128, 170, 213, 255];
const SHAPE_TYPES = ["rect", "ellipse", "triangle"];

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
  const widthSpan = document.createElement("span");
  widthSpan.className = "insp-num";
  widthRow.appendChild(widthLbl);
  widthRow.appendChild(widthRange);
  widthRow.appendChild(widthSpan);
  sec1Body.appendChild(widthRow);

  let _widthSnap = null;
  widthRange.addEventListener("mousedown", () => { _widthSnap = snapBefore(); });
  widthRange.addEventListener("input", () => {
    const val = parseFloat(widthRange.value);
    widthSpan.textContent = val.toFixed(1);
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

  // ---- Group section: 개체 풀기 button (shown in targeted and group-selected states) ----
  const groupDiv = document.createElement("div");
  groupDiv.className = "insp-body";
  groupDiv.style.cssText = "padding: 6px 8px;";
  const ungroupBtn = document.createElement("button");
  ungroupBtn.textContent = "개체 풀기";
  ungroupBtn.style.cssText = "padding: 4px 10px; font-size: 12px; cursor: pointer; border: 1px solid #d0d7de; border-radius: 4px; background: #f6f8fa; color: #0d1117; width: 100%;";
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

  [xF, yF, wF, hF, rotF].forEach((f) => sec3Body.appendChild(f.el));

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

  /* ---- Subscribe: populate controls on every state change ---- */
  function populate(s) {
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
      return;
    }

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
      sec2.style.display = "";
      sec3.style.display = "none";
      sec4.style.display = "none";

      if (_dragging) return;

      strokeCP.setValue(firstObj.strokeLevel ?? 0);
      const _sw = firstObj.strokeWidth ?? 1;
      widthRange.value = _sw;
      widthSpan.textContent = _sw.toFixed(1);

      const _fn = !!(firstObj.fillNone);
      fnCb.checked = _fn;
      fillCP.setValue(firstObj.fillLevel ?? 255);
      fillCP.setDisabled(_fn);
      return;
    }

    groupDiv.style.display = "none";

    if (ids.length > 1) {
      // Multi-selection (no shared group): only stroke/fill sections visible
      sec1.style.display = "";
      sec2.style.display = "";
      sec3.style.display = "none";
      sec4.style.display = "none";

      if (_dragging) return;

      if (!firstObj) return;

      strokeCP.setValue(firstObj.strokeLevel ?? 0);
      const sw = firstObj.strokeWidth ?? 1;
      widthRange.value = sw;
      widthSpan.textContent = sw.toFixed(1);

      const fn = !!(firstObj.fillNone);
      fnCb.checked = fn;
      fillCP.setValue(firstObj.fillLevel ?? 255);
      fillCP.setDisabled(fn);
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
    sec2.style.display = "";

    // Section 1
    strokeCP.setValue(obj.strokeLevel ?? 0);
    const sw = obj.strokeWidth ?? 1;
    widthRange.value = sw;
    widthSpan.textContent = sw.toFixed(1);

    // Section 2
    const fn = !!(obj.fillNone);
    fnCb.checked = fn;
    fillCP.setValue(obj.fillLevel ?? 255);
    fillCP.setDisabled(fn);

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
