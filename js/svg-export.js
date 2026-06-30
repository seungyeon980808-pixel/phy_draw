/* ===== IMAGE EXPORT (artboard region only; SVG vector + PNG raster) ===== */
//
// Exports the drawing sized to the artboard's physical dimensions (width/height
// in mm), so it imports at true size into word processors. 1 world unit = 1 mm.
//
// What is exported: ONLY the committed drawing objects (state.objects),
// rendered through render.js's per-object node builders ??no duplicated
// shape-drawing code. What is NOT exported: selection/rotation handles,
// marquee, grid, guides, any UI chrome.
//
// The viewBox is exactly the artboard region, so anything outside the page is
// cropped; a clipPath on the artboard rect guarantees nothing leaks past it.
//
//   - SVG: transparent background (no fill rect emitted), vector, true mm size.
//   - PNG: WHITE background (print/hwp-insertion standard), rasterized at a
//     chosen DPI. pixel size = mm / 25.4 * dpi.
//
// Both formats share buildExportSvg(); the dialog (export-dialog.js) decides
// filename, format, and resolution and calls exportSvg() / exportPng().

import { renderObject, makeFillPattern } from "./render.js?v=0.36.2";

const SVG_NS = "http://www.w3.org/2000/svg";
const MM_PER_INCH = 25.4;

/* ----- default export filename: local date/time to the minute (YYYYMMDD_HHmm) -----
 * Shared by the export dialog and the save fallbacks so the timestamp format is
 * defined once. Example: new Date(2026,5,30,21,40) → "20260630_2140". */
export function formatExportTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `_${p(date.getHours())}${p(date.getMinutes())}`;
}
// Full default filename with extension, e.g. getDefaultExportFilename("png").
export function getDefaultExportFilename(ext) {
  const e = String(ext || "").replace(/^\./, "");
  return e ? `${formatExportTimestamp()}.${e}` : formatExportTimestamp();
}

/* ----- NO font embedding: text uses the system gothic stack by NAME ----- */
// The default font is a system stack (돋움 / Apple SD Gothic Neo / Malgun Gothic),
// so SVG/PNG export carries only the font-family string and renders from the
// font installed on the exporting machine — no @font-face, no base64 inlining.

/* ----- a layer's visibility (mirrors render.js: hidden = visible === false) ----- */
function isHidden(s, obj) {
  const layer = (s.layers || []).find((l) => l.id === (obj.layerId ?? 1));
  return layer && layer.visible === false;
}

/* ----- trigger a browser download for a blob ----- */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ----- choose where to save (File System Access API, with safe fallback) -----
 * In Chromium/Edge, showSaveFilePicker lets the user pick the folder + filename.
 * Return values are a small protocol the callers act on:
 *   handle  → user picked a location; write the blob there (writeHandle).
 *   null    → user cancelled the picker; the caller aborts the export silently.
 *   undefined → API unsupported (or non-abort error); the caller falls back to a
 *               normal browser download with the suggested filename.
 * Must be called synchronously at the start of the export (before any other
 * await) so it runs inside the click's transient user activation. */
async function pickSaveHandle(filename, { mime, ext, description }) {
  if (!window.showSaveFilePicker) return undefined;
  try {
    return await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description, accept: { [mime]: [ext] } }],
    });
  } catch (e) {
    if (e && e.name === "AbortError") return null; // user cancelled
    return undefined;                               // permission/other → fall back
  }
}

async function writeHandle(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/* ----- resolve the world rectangle to export ----- */
// Default = the artboard region (centered at origin). When `bounds` is given
// (selected-area capture), export exactly that world rectangle instead.
function exportRegion(s, bounds) {
  if (bounds && bounds.w > 0 && bounds.h > 0) {
    return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
  }
  const { w, h } = s.artboard;
  return { x: -w / 2, y: -h / 2, w, h };
}

/* ----- build the standalone export <svg> for the current state ----- */
// Background stays transparent here; PNG export adds its own white rect.
// `bounds` (optional) = a world-coordinate {x,y,w,h} rectangle to crop to.
export function buildExportSvg(s, bounds = null) {
  const { x, y, w, h } = exportRegion(s, bounds);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  // Physical size so word processors place it at true mm dimensions.
  svg.setAttribute("width", `${w}mm`);
  svg.setAttribute("height", `${h}mm`);
  // viewBox = artboard region exactly ??off-page content is cropped.
  svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);

  // ----- defs: artboard clip + per-object fill patterns -----
  const defs = document.createElementNS(SVG_NS, "defs");

  const clip = document.createElementNS(SVG_NS, "clipPath");
  clip.setAttribute("id", "artboard-clip");
  const clipRect = document.createElementNS(SVG_NS, "rect");
  clipRect.setAttribute("x", x);
  clipRect.setAttribute("y", y);
  clipRect.setAttribute("width", w);
  clipRect.setAttribute("height", h);
  clip.appendChild(clipRect);
  defs.appendChild(clip);

  for (const obj of s.objects) {
    if (isHidden(s, obj)) continue;
    const pat = makeFillPattern(obj);
    if (pat) defs.appendChild(pat);
  }
  svg.appendChild(defs);

  // ----- drawing objects, clipped to the artboard, z-order = array order -----
  // No active-layer dimming here: this is the final artwork, not the editor view.
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("clip-path", "url(#artboard-clip)");
  for (const obj of s.objects) {
    if (isHidden(s, obj)) continue;
    const el = renderObject(obj);
    if (el) g.appendChild(el);
  }
  svg.appendChild(g);

  return svg;
}

/* ----- exportSvg: serialize the export SVG and trigger a download ----- */
// `bounds` (optional): world {x,y,w,h} rectangle for selected-area capture.
export async function exportSvg(state, filename, bounds = null) {
  const name = filename || getDefaultExportFilename("svg");
  // Ask for the save location first, while still inside the user gesture.
  const handle = await pickSaveHandle(name, { mime: "image/svg+xml", ext: ".svg", description: "SVG 이미지" });
  if (handle === null) return; // user cancelled the save dialog
  const svg = buildExportSvg(state.get(), bounds);
  const source = new XMLSerializer().serializeToString(svg);
  // XML prolog keeps the file valid as a standalone .svg document.
  const doc = `<?xml version="1.0" encoding="UTF-8"?>\n${source}`;
  const blob = new Blob([doc], { type: "image/svg+xml" });
  if (handle) {
    try { await writeHandle(handle, blob); }
    catch (_) { downloadBlob(blob, name); } // write failed → fall back to download
  } else {
    downloadBlob(blob, name);
  }
}

/* ----- exportPng: rasterize the export SVG at a DPI onto a white canvas ----- */
// `bounds` (optional): world {x,y,w,h} rectangle for selected-area capture.
export async function exportPng(state, filename, dpi, bounds = null) {
  const name = filename || getDefaultExportFilename("png");
  // Ask for the save location first, while still inside the user gesture (before
  // the async rasterization below, which would otherwise lose the activation).
  const handle = await pickSaveHandle(name, { mime: "image/png", ext: ".png", description: "PNG 이미지" });
  if (handle === null) return; // user cancelled the save dialog

  const s = state.get();
  const { x, y, w, h } = exportRegion(s, bounds);

  // mm ??px at the requested DPI (25.4mm = 1 inch).
  const pixelW = Math.round((w / MM_PER_INCH) * dpi);
  const pixelH = Math.round((h / MM_PER_INCH) * dpi);

  const svg = buildExportSvg(s, bounds);

  // White background first (PNG with white bg is standard for print/hwp).
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", x);
  bg.setAttribute("y", y);
  bg.setAttribute("width", w);
  bg.setAttribute("height", h);
  bg.setAttribute("fill", "white");
  svg.insertBefore(bg, svg.querySelector("g"));

  // Pixel dimensions for the rasterized canvas (override the mm width/height).
  svg.setAttribute("width", pixelW);
  svg.setAttribute("height", pixelH);

  const source = new XMLSerializer().serializeToString(svg);
  const doc = `<?xml version="1.0" encoding="UTF-8"?>\n${source}`;
  const url = URL.createObjectURL(new Blob([doc], { type: "image/svg+xml;charset=utf-8" }));

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = pixelW;
    canvas.height = pixelH;
    const ctx = canvas.getContext("2d");
    // Belt-and-suspenders white fill in case the SVG rect ever falls short.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pixelW, pixelH);
    ctx.drawImage(img, 0, 0, pixelW, pixelH);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (handle) {
        writeHandle(handle, blob).catch(() => downloadBlob(blob, name));
      } else {
        downloadBlob(blob, name);
      }
    }, "image/png");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert("PNG로 내보내는 중 오류가 발생했습니다.");
  };
  img.src = url;
}
