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

import { exportPng, exportSvg } from "./svg-export.js?v=0.42.0";

const DEFAULT_NAME = "physics_drawing";

/* ----- dropdown: open on click, close on outside-click / Escape ----- */
function initFileMenu() {
  const btn = document.getElementById("file-menu-btn");
  const list = document.getElementById("file-menu-list");
  if (!btn || !list) return;

  function close() {
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }
  function open() {
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (list.hidden) open();
    else close();
  });

  // Any item click (save/open/export) dismisses the menu.
  list.addEventListener("click", () => close());

  // Click anywhere outside the menu closes it.
  document.addEventListener("click", (e) => {
    if (list.hidden) return;
    if (!list.contains(e.target) && e.target !== btn) close();
  });

  // Escape closes it.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
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
               value="${DEFAULT_NAME}" autocomplete="off" spellcheck="false" />
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

/* ----- initExportDialog: wire dropdown + modal to the export functions ----- */
export function initExportDialog(state) {
  initFileMenu();

  const overlay = buildModal();
  const formatGroup = overlay.querySelector("#export-format");
  const dpiGroup = overlay.querySelector("#export-dpi");
  const dpiField = overlay.querySelector("#export-dpi-field");
  const filenameInput = overlay.querySelector("#export-filename");

  function showModal() {
    overlay.hidden = false;
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

  // Export with the chosen settings.
  overlay.querySelector("#export-confirm").addEventListener("click", () => {
    const name = (filenameInput.value || "").trim() || DEFAULT_NAME;
    const format = segValue(formatGroup, "data-format");
    if (format === "svg") {
      exportSvg(state, `${name}.svg`);
    } else {
      const dpi = parseInt(segValue(dpiGroup, "data-dpi"), 10) || 300;
      exportPng(state, `${name}.png`, dpi);
    }
    hideModal();
  });
}
