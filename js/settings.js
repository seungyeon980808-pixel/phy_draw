/* ===== SETTINGS (설정 dropdown + 기본값 설정 modal) ===== */
//
// Step 1 of the defaults feature. Owns the "설정 ▾" top-bar dropdown and the
// "기본값 설정" modal, mirroring export-dialog.js (initFileMenu + buildModal):
//
//   1. "설정 ▾" dropdown — opens on click, closes on outside-click / Escape.
//      Items: 기본값 설정 (opens the modal) + 단축키 설정 (disabled, 준비 중).
//
//   2. 기본값 설정 modal — stroke/fill/text/grid defaults, persisted to
//      localStorage under DEFAULTS_KEY. 취소 / 저장; only 저장 persists.
//
// NOTE: This step only *stores* the values. Wiring them into shape creation is
// step 2 — nothing here reads back into the drawing pipeline yet.

import {
  TEXT_FONTS,
  TEXT_STYLES,
  DEFAULT_TEXT_FONT,
  DEFAULT_TEXT_SIZE_MM,
} from "./state.js?v=0.36.2";
import { registerTopMenu } from "./top-menu.js?v=0.36.2";

/* ----- defaults schema + localStorage load/save ----- */
const DEFAULTS_KEY = "phyDraw.defaults";
const FACTORY_DEFAULTS = {
  strokeWidth: 0.2,      // mm
  strokeLevel: 0,        // 0 = black
  fillLevel: 255,        // opaque white default for new shapes
  textSizeMm: DEFAULT_TEXT_SIZE_MM,  // matches DEFAULT_TEXT_SIZE_MM
  textFont: DEFAULT_TEXT_FONT,       // css font-family string
  textWeight: "normal",
  textStyle: "normal",
  gridVisible: false,
  gridOpacity: 3,
  gridInterval: 10,
};

export function loadDefaults() {
  try {
    return { ...FACTORY_DEFAULTS, ...JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "{}") };
  } catch {
    return { ...FACTORY_DEFAULTS };
  }
}
function saveDefaults(d) {
  localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d));
}

/* ----- dropdown: registered with the shared top-menu (exclusive with 파일) ----- */
function initSettingsMenu() {
  const btn = document.getElementById("settings-menu-btn");
  const list = document.getElementById("settings-menu-list");
  registerTopMenu("settings", btn, list);
}

/* ----- modal markup, built once and appended to <body> ----- */
function buildModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "defaults-overlay";
  overlay.hidden = true;
  // f.css can contain double quotes (e.g. '"신명중명조", ...'); escaping keeps the
  // value attribute intact so the option value matches the stored default exactly
  // (otherwise the default font option breaks and the preview can't resolve it).
  const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const fontOptions = TEXT_FONTS
    .map((f) => `<option value="${escAttr(f.css)}">${f.label}</option>`)
    .join("");
  const styleOptions = TEXT_STYLES
    .map((s, i) => `<option value="${i}">${s.label}</option>`)
    .join("");

  overlay.innerHTML = `
    <div class="modal modal-defaults" role="dialog" aria-modal="true" aria-labelledby="defaults-title">
      <h2 class="modal-title" id="defaults-title">기본값 설정</h2>

      <div class="defaults-body">
        <div class="defaults-fields">
          <label class="modal-field" for="defaults-stroke-width">
            <span class="modal-label">기본 선 굵기 (mm)</span>
            <input type="number" id="defaults-stroke-width" class="modal-input"
                   step="0.1" min="0.1" max="0.5" autocomplete="off" />
          </label>

          <label class="modal-field" for="defaults-stroke-level">
            <span class="modal-label">기본 선 명도 (0-255)</span>
            <input type="number" id="defaults-stroke-level" class="modal-input"
                   min="0" max="255" step="1" autocomplete="off" />
          </label>

          <label class="modal-field" for="defaults-fill-level">
            <span class="modal-label">기본 채우기 명도 (0-255)</span>
            <input type="number" id="defaults-fill-level" class="modal-input"
                   min="0" max="255" step="1" autocomplete="off" />
          </label>

          <label class="modal-field" for="defaults-text-size">
            <span class="modal-label">기본 글자 크기 (mm)</span>
            <input type="number" id="defaults-text-size" class="modal-input"
                   step="0.1" min="0" autocomplete="off" />
          </label>

          <label class="modal-field" for="defaults-text-font">
            <span class="modal-label">기본 글씨체</span>
            <select id="defaults-text-font" class="modal-input">${fontOptions}</select>
          </label>

          <label class="modal-field" for="defaults-text-style">
            <span class="modal-label">기본 글자 스타일 (굵기)</span>
            <select id="defaults-text-style" class="modal-input">${styleOptions}</select>
          </label>

          <label class="modal-field modal-field-row" for="defaults-grid-visible">
            <input type="checkbox" id="defaults-grid-visible" />
            <span class="modal-label">앱 시작 시 격자 표시</span>
          </label>

          <label class="modal-field" for="defaults-grid-opacity">
            <span class="modal-label">격자 진하기 (1-10)</span>
            <input type="number" id="defaults-grid-opacity" class="modal-input"
                   min="1" max="10" step="1" autocomplete="off" />
          </label>

          <label class="modal-field" for="defaults-grid-interval">
            <span class="modal-label">격자 간격 (mm)</span>
            <input type="number" id="defaults-grid-interval" class="modal-input"
                   min="5" max="50" step="5" autocomplete="off" />
          </label>
        </div>

        <div class="defaults-preview">
          <span class="modal-label">미리보기</span>
          <svg id="defaults-preview-svg" class="defaults-preview-svg"
               viewBox="0 0 320 240"
               xmlns="http://www.w3.org/2000/svg"></svg>
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="modal-btn" id="defaults-cancel">취소</button>
        <button type="button" class="modal-btn modal-btn-primary" id="defaults-save">저장</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

/* ----- initSettings: wire dropdown + 기본값 설정 modal ----- */
export function initSettings(state) {
  initSettingsMenu();

  const overlay = buildModal();
  const fields = {
    strokeWidth:  overlay.querySelector("#defaults-stroke-width"),
    strokeLevel:  overlay.querySelector("#defaults-stroke-level"),
    fillLevel:    overlay.querySelector("#defaults-fill-level"),
    textSizeMm:   overlay.querySelector("#defaults-text-size"),
    textFont:     overlay.querySelector("#defaults-text-font"),
    textStyle:    overlay.querySelector("#defaults-text-style"),
    gridVisible:  overlay.querySelector("#defaults-grid-visible"),
    gridOpacity:  overlay.querySelector("#defaults-grid-opacity"),
    gridInterval: overlay.querySelector("#defaults-grid-interval"),
  };
  const previewSvg = overlay.querySelector("#defaults-preview-svg");

  function populate() {
    const d = loadDefaults();
    fields.strokeWidth.value  = d.strokeWidth;
    fields.strokeLevel.value  = d.strokeLevel;
    fields.fillLevel.value    = d.fillLevel;
    fields.textSizeMm.value   = d.textSizeMm;
    fields.textFont.value     = d.textFont;
    // Find the style preset matching the stored weight/style (fallback: 0 = Regular).
    const styleIdx = TEXT_STYLES.findIndex(
      (s) => s.fontWeight === d.textWeight && s.fontStyle === d.textStyle
    );
    fields.textStyle.value    = String(styleIdx < 0 ? 0 : styleIdx);
    fields.gridVisible.checked = !!d.gridVisible;
    fields.gridOpacity.value  = d.gridOpacity;
    fields.gridInterval.value = d.gridInterval;
  }

  // Read the chosen TEXT_STYLES preset (weight + font-style) from the select.
  function currentStyle() {
    return TEXT_STYLES[Number(fields.textStyle.value)] || TEXT_STYLES[0];
  }

  // Live integrated preview: a simple MECHANICS exam diagram (grid + incline +
  // a box resting on the slope + a small force arrow + sample label). mm → px
  // via a fixed scale, treating the preview as ~48mm wide so the scene fits the
  // larger 320×240 viewBox without clipping.
  function renderPreview() {
    const PREVIEW_W = 320, PREVIEW_H = 240;
    const scale = PREVIEW_W / 48;  // px per mm

    const gray = (g) => `rgb(${g},${g},${g})`;
    const strokeColor = gray(Number(fields.strokeLevel.value) || 0);
    const fillColor   = gray(Number(fields.fillLevel.value) || 0);
    const strokePx    = Math.max(0.4, Number(fields.strokeWidth.value) * scale);

    // grid: interval (mm) → px spacing; opacity 1-10 → 0.05-1.0.
    const interval = Math.max(1, Number(fields.gridInterval.value) || 10);
    const stepPx   = interval * scale;
    const opLevel  = Math.min(10, Math.max(1, Number(fields.gridOpacity.value) || 1));
    const gridOpacity = 0.05 + ((opLevel - 1) / 9) * 0.95;

    let gridLines = "";
    for (let x = stepPx; x < PREVIEW_W; x += stepPx) {
      gridLines += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${PREVIEW_H}" />`;
    }
    for (let y = stepPx; y < PREVIEW_H; y += stepPx) {
      gridLines += `<line x1="0" y1="${y.toFixed(1)}" x2="${PREVIEW_W}" y2="${y.toFixed(1)}" />`;
    }

    // --- incline (right-triangle ramp): bottom edge + hypotenuse rising L→R ---
    const BL = { x: 40,  y: 200 };  // bottom-left
    const BR = { x: 290, y: 200 };  // bottom-right (ground end)
    const AP = { x: 290, y: 90  };  // apex (top-right)
    const ramp =
      `<polygon points="${BL.x},${BL.y} ${BR.x},${BR.y} ${AP.x},${AP.y}"
                fill="none" stroke="${strokeColor}" stroke-width="${strokePx.toFixed(2)}"
                stroke-linejoin="round" />`;

    // --- box seated on the hypotenuse (BL → AP), rotated to match the slope ---
    const dx = AP.x - BL.x, dy = AP.y - BL.y;        // slope vector (dy < 0: rises)
    const angDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    const t = 0.45;                                  // fraction up the slope
    const seat = { x: BL.x + dx * t, y: BL.y + dy * t };
    const BW = 26, BH = 20;
    const box =
      `<g transform="translate(${seat.x.toFixed(1)},${seat.y.toFixed(1)}) rotate(${angDeg.toFixed(2)})">
         <rect x="${(-BW / 2).toFixed(1)}" y="${(-BH).toFixed(1)}" width="${BW}" height="${BH}"
               fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokePx.toFixed(2)}"
               stroke-linejoin="round" />
       </g>`;

    // --- small force arrow from the box, pointing down-slope (살짝) ---
    const len = Math.hypot(dx, dy);
    const ds = { x: -dx / len, y: -dy / len };       // down-slope unit (toward BL)
    // start a touch above the slope at the box, then go a short way down-slope
    const aStart = { x: seat.x + ds.y * 10, y: seat.y - ds.x * 10 };
    const aEnd   = { x: aStart.x + ds.x * 30, y: aStart.y + ds.y * 30 };
    const aAng   = Math.atan2(aEnd.y - aStart.y, aEnd.x - aStart.x);
    const HEAD = 8;
    const h1 = { x: aEnd.x - HEAD * Math.cos(aAng - Math.PI / 7),
                 y: aEnd.y - HEAD * Math.sin(aAng - Math.PI / 7) };
    const h2 = { x: aEnd.x - HEAD * Math.cos(aAng + Math.PI / 7),
                 y: aEnd.y - HEAD * Math.sin(aAng + Math.PI / 7) };
    const arrow =
      `<g stroke="${strokeColor}" stroke-width="${strokePx.toFixed(2)}"
          stroke-linecap="round" stroke-linejoin="round" fill="none">
         <line x1="${aStart.x.toFixed(1)}" y1="${aStart.y.toFixed(1)}"
               x2="${aEnd.x.toFixed(1)}" y2="${aEnd.y.toFixed(1)}" />
         <polyline points="${h1.x.toFixed(1)},${h1.y.toFixed(1)} ${aEnd.x.toFixed(1)},${aEnd.y.toFixed(1)} ${h2.x.toFixed(1)},${h2.y.toFixed(1)}" />
       </g>`;

    // --- sample label (upper-left, clear of the ramp) ---
    const style = currentStyle();
    const fontPx = Math.max(6, Number(fields.textSizeMm.value) * scale);
    const fontFamily = fields.textFont.value;
    const label =
      `<text x="12" y="${(fontPx + 8).toFixed(1)}" fill="${strokeColor}"
             font-size="${fontPx.toFixed(1)}"
             font-family="${fontFamily.replace(/"/g, "&quot;")}"
             font-weight="${style.fontWeight}" font-style="${style.fontStyle}"
             text-anchor="start"
             dominant-baseline="alphabetic">ABC 가나다</text>`;

    previewSvg.innerHTML = `
      <rect x="0" y="0" width="${PREVIEW_W}" height="${PREVIEW_H}" fill="#ffffff" />
      <g stroke="#000000" stroke-width="1" opacity="${gridOpacity.toFixed(3)}"
         vector-effect="non-scaling-stroke">${gridLines}</g>
      ${ramp}
      ${box}
      ${arrow}
      ${label}
    `;
  }

  // Re-render the preview on any control change (no 저장 needed to see it).
  fields.gridVisible.parentElement.parentElement
    .querySelectorAll("input, select").forEach((el) => {
      el.addEventListener("input", renderPreview);
      el.addEventListener("change", renderPreview);
    });

  function showModal() {
    populate();
    renderPreview();
    overlay.hidden = false;
    fields.strokeWidth.focus();
    fields.strokeWidth.select();
  }
  function hideModal() {
    overlay.hidden = true;
  }

  // Open from the dropdown item.
  const openBtn = document.getElementById("open-defaults");
  if (openBtn) openBtn.addEventListener("click", showModal);

  // Cancel / overlay-click / Escape close without saving.
  overlay.querySelector("#defaults-cancel").addEventListener("click", hideModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) hideModal();
  });

  // Save: read fields → persist → close. (Step 2 wires these into drawing.)
  overlay.querySelector("#defaults-save").addEventListener("click", () => {
    const style = currentStyle();
    saveDefaults({
      strokeWidth:  Number(fields.strokeWidth.value),
      strokeLevel:  Number(fields.strokeLevel.value),
      fillLevel:    Number(fields.fillLevel.value),
      textSizeMm:   Number(fields.textSizeMm.value),
      textFont:     fields.textFont.value,
      textWeight:   style.fontWeight,
      textStyle:    style.fontStyle,
      gridVisible:  fields.gridVisible.checked,
      gridOpacity:  Number(fields.gridOpacity.value),
      gridInterval: Number(fields.gridInterval.value),
    });
    hideModal();
  });
}
