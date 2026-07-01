/* ===== EXPORT DIALOG (파일 dropdown + image-export modal) ===== */
//
// Owns two pieces of top-bar UI, both kept out of index.html so markup stays
// minimal (mirrors project-io.js's dynamically-created file input):
//
//   1. "파일 ▾" dropdown — opens on click, closes on outside-click / Escape.
//      Its items are: 프로젝트 저장 / 프로젝트 불러오기 (both wired in
//      project-io.js by id), a divider, and 이미지로 내보내기 (opens the modal).
//
//   2. Export modal — filename + format (PNG/SVG) + resolution (DPI, PNG only),
//      with 취소 / 내보내기. On 내보내기 it delegates to svg-export.js's
//      exportPng() or exportSvg(); the extension is appended from the format.

import { exportPng, exportSvg, formatExportTimestamp } from "./svg-export.js?v=0.36.4";
import { registerTopMenu } from "./top-menu.js?v=0.36.4";
import { screenToWorld } from "./viewport.js?v=0.36.4";

// Default export filename base = local date/time to the minute (YYYYMMDD_HHmm),
// recomputed each time the modal opens so it reflects the actual export time.
const defaultNameBase = () => formatExportTimestamp();

/* ----- dropdown: exclusive with 설정 (shared top-menu) + hover descriptions ----- */
const DEFAULT_FILE_DESC = "파일 작업을 선택하세요.";
function initFileMenu() {
  const btn = document.getElementById("file-menu-btn");
  const list = document.getElementById("file-menu-list");
  const desc = document.getElementById("file-menu-desc");
  if (!btn || !list) return;

  // Bottom description area: reflect the hovered / keyboard-focused item; fall
  // back to the default prompt when nothing is hovered or focused.
  const reset = () => { if (desc) desc.textContent = DEFAULT_FILE_DESC; };
  if (desc) {
    list.querySelectorAll(".file-menu-item").forEach((item) => {
      const text = item.getAttribute("data-desc");
      const show = () => { if (text) desc.textContent = text; };
      item.addEventListener("mouseenter", show);
      item.addEventListener("focus", show);
      item.addEventListener("mouseleave", reset);
      item.addEventListener("blur", reset);
    });
  }

  // Reset the description each time the menu opens (nothing hovered yet).
  registerTopMenu("file", btn, list, { onOpen: reset });
}

/* ----- modal markup, built once and appended to <body> ----- */
function buildModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "export-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
      <h2 class="modal-title" id="export-title">이미지로 내보내기</h2>

      <label class="modal-field" for="export-filename">
        <span class="modal-label">파일 이름</span>
        <input type="text" id="export-filename" class="modal-input"
               value="${defaultNameBase()}" autocomplete="off" spellcheck="false" />
      </label>

      <div class="modal-field">
        <span class="modal-label">형식</span>
        <div class="seg" id="export-format">
          <button type="button" class="seg-btn is-active" data-format="png">PNG</button>
          <button type="button" class="seg-btn" data-format="svg">SVG</button>
        </div>
      </div>

      <div class="modal-field" id="export-dpi-field">
        <span class="modal-label">해상도</span>
        <div class="seg" id="export-dpi">
          <button type="button" class="seg-btn" data-dpi="200">200 dpi</button>
          <button type="button" class="seg-btn is-active" data-dpi="300">300 dpi</button>
          <button type="button" class="seg-btn" data-dpi="400">400 dpi</button>
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="modal-btn" id="export-cancel">취소</button>
        <button type="button" class="modal-btn" id="export-area">영역 지정</button>
        <button type="button" class="modal-btn modal-btn-primary" id="export-confirm">내보내기</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

/* ----- segmented control: single active button, returns chosen value ----- */
function wireSegment(group, attr, onChange) {
  group.addEventListener("click", (e) => {
    const target = e.target.closest(".seg-btn");
    if (!target) return;
    group.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("is-active"));
    target.classList.add("is-active");
    if (onChange) onChange(target.getAttribute(attr));
  });
}
function segValue(group, attr) {
  const active = group.querySelector(".seg-btn.is-active");
  return active ? active.getAttribute(attr) : null;
}

/* ----- selected-area capture: drag a rectangle on the canvas, export it -----
 * Temporarily dims the screen, shows an instruction, and lets the user drag one
 * rectangle. On release the screen rect is converted to world coords (via the
 * SVG's screen CTM) and handed to the existing export pipeline with custom
 * bounds — so handles/guides/snap/UI chrome are never included. Esc or right
 * click cancels. `onDone(bounds|null)` runs after capture ends. */
function runAreaCapture(svg, state, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "capture-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9000;cursor:crosshair;" +
    "background:rgba(0,0,0,0.35);user-select:none;";

  const hint = document.createElement("div");
  hint.textContent = "저장할 영역을 드래그하십시오";
  hint.style.cssText =
    "position:absolute;top:18px;left:50%;transform:translateX(-50%);" +
    "padding:6px 14px;border-radius:4px;background:rgba(20,20,22,0.92);" +
    "color:#fff;font-size:13px;font-weight:500;pointer-events:none;" +
    "box-shadow:0 1px 6px rgba(0,0,0,0.4);";
  overlay.appendChild(hint);

  const rect = document.createElement("div");
  rect.style.cssText =
    "position:absolute;border:1.5px solid #4aa3ff;background:rgba(74,163,255,0.18);" +
    "display:none;pointer-events:none;";
  overlay.appendChild(rect);

  document.body.appendChild(overlay);

  let start = null; // {x,y} client coords

  function cleanup() {
    overlay.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey);
    overlay.removeEventListener("contextmenu", onCtx);
    overlay.remove();
  }
  function finish(bounds) {
    cleanup();
    onDone(bounds);
  }
  function cancel() { finish(null); }

  function onDown(e) {
    if (e.button !== 0) return; // left only; right click cancels via onCtx
    start = { x: e.clientX, y: e.clientY };
    rect.style.display = "block";
    drawRect(e.clientX, e.clientY);
    e.preventDefault();
  }
  function drawRect(cx, cy) {
    const x = Math.min(start.x, cx), y = Math.min(start.y, cy);
    rect.style.left = x + "px";
    rect.style.top = y + "px";
    rect.style.width = Math.abs(cx - start.x) + "px";
    rect.style.height = Math.abs(cy - start.y) + "px";
  }
  function onMove(e) { if (start) drawRect(e.clientX, e.clientY); }
  function onUp(e) {
    if (!start) return;
    const end = { x: e.clientX, y: e.clientY };
    const s = start; start = null;
    // Ignore a near-zero drag (treat as accidental click → stay in capture).
    if (Math.abs(end.x - s.x) < 4 || Math.abs(end.y - s.y) < 4) {
      rect.style.display = "none";
      return;
    }
    // Two screen corners → world coords (honours zoom/pan/letterboxing).
    const vb = state.get().viewBox;
    const w1 = screenToWorld(svg, vb, s.x, s.y);
    const w2 = screenToWorld(svg, vb, end.x, end.y);
    finish({
      x: Math.min(w1.x, w2.x),
      y: Math.min(w1.y, w2.y),
      w: Math.abs(w2.x - w1.x),
      h: Math.abs(w2.y - w1.y),
    });
  }
  function onKey(e) {
    if (e.key === "Escape") {
      // Capture-phase + stopPropagation so the dialog's own Escape handler
      // doesn't also fire and clobber the reopened modal.
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
  function onCtx(e) { e.preventDefault(); cancel(); }

  overlay.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey, true);
  overlay.addEventListener("contextmenu", onCtx);
}

/* ----- initExportDialog: wire dropdown + modal to the export functions ----- */
export function initExportDialog(state, svg) {
  initFileMenu();

  const overlay = buildModal();
  const formatGroup = overlay.querySelector("#export-format");
  const dpiGroup = overlay.querySelector("#export-dpi");
  const dpiField = overlay.querySelector("#export-dpi-field");
  const filenameInput = overlay.querySelector("#export-filename");

  function showModal() {
    overlay.hidden = false;
    // Refresh the default name to the current minute each time the dialog opens
    // (unless the user has typed a custom name this session is fine to overwrite —
    // the field is always reset to the live timestamp on open).
    filenameInput.value = defaultNameBase();
    filenameInput.focus();
    filenameInput.select();
  }
  function hideModal() {
    overlay.hidden = true;
  }

  // 해상도 row is meaningful for PNG only.
  wireSegment(formatGroup, "data-format", (fmt) => {
    dpiField.style.display = fmt === "svg" ? "none" : "";
  });
  wireSegment(dpiGroup, "data-dpi", null);

  // Open from the dropdown item.
  const openBtn = document.getElementById("image-export");
  if (openBtn) openBtn.addEventListener("click", showModal);

  // Cancel / overlay-click / Escape close without exporting.
  overlay.querySelector("#export-cancel").addEventListener("click", hideModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) hideModal();
  });

  // Alt+P → open the image export dialog (P = print/picture; mirrors the text
  // tool's single-key feel). preventDefault only inside the app so it never
  // collides with a browser/system shortcut. Skip while typing in a field.
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if ((e.key || "").toLowerCase() !== "p") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    if (overlay.hidden) showModal();
  });

  // Export the current settings, optionally cropped to a world-coord rectangle.
  function doExport(bounds) {
    const name = (filenameInput.value || "").trim() || defaultNameBase();
    const format = segValue(formatGroup, "data-format");
    if (format === "svg") {
      exportSvg(state, `${name}.svg`, bounds);
    } else {
      const dpi = parseInt(segValue(dpiGroup, "data-dpi"), 10) || 300;
      exportPng(state, `${name}.png`, dpi, bounds);
    }
  }

  // Full-artboard export (unchanged behavior: bounds = null).
  overlay.querySelector("#export-confirm").addEventListener("click", () => {
    doExport(null);
    hideModal();
  });

  // Selected-area export: hide the modal, drag a rectangle, export just that.
  const areaBtn = overlay.querySelector("#export-area");
  if (areaBtn && svg) {
    areaBtn.addEventListener("click", () => {
      hideModal();
      runAreaCapture(svg, state, (bounds) => {
        if (bounds) doExport(bounds);
        else showModal(); // cancelled → reopen the dialog where we left off
      });
    });
  }
}
