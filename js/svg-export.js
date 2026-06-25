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

import { renderObject, makeFillPattern } from "./render.js?v=0.16.3";

const SVG_NS = "http://www.w3.org/2000/svg";
const MM_PER_INCH = 25.4;

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

/* ----- build the standalone export <svg> for the current state ----- */
// Background stays transparent here; PNG export adds its own white rect.
export function buildExportSvg(s) {
  const { w, h } = s.artboard;
  const x = -w / 2;
  const y = -h / 2;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  // Physical size so word processors place it at true mm dimensions.
  svg.setAttribute("width", `${w}mm`);
  svg.setAttribute("height", `${h}mm`);
  // viewBox = artboard region exactly ??off-page content is cropped.
  svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);

  // ----- defs: artboard clip + per-object fill patterns (visible layers only) -----
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
export function exportSvg(state, filename) {
  const svg = buildExportSvg(state.get());
  const source = new XMLSerializer().serializeToString(svg);
  // XML prolog keeps the file valid as a standalone .svg document.
  const doc = `<?xml version="1.0" encoding="UTF-8"?>\n${source}`;
  const blob = new Blob([doc], { type: "image/svg+xml" });
  downloadBlob(blob, filename || "physics_drawing.svg");
}

/* ----- exportPng: rasterize the export SVG at a DPI onto a white canvas ----- */
export function exportPng(state, filename, dpi) {
  const s = state.get();
  const { w, h } = s.artboard;
  const x = -w / 2;
  const y = -h / 2;

  // mm ??px at the requested DPI (25.4mm = 1 inch).
  const pixelW = Math.round((w / MM_PER_INCH) * dpi);
  const pixelH = Math.round((h / MM_PER_INCH) * dpi);

  const svg = buildExportSvg(s);

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
      if (blob) downloadBlob(blob, filename || "physics_drawing.png");
    }, "image/png");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert("PNG濡??대낫?대뒗 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎.");
  };
  img.src = url;
}
