import {
  ROMAN_NUMERAL_FONT_FAMILY,
  splitRomanRuns,
} from "./state.js?v=0.36.4";

const SVG_NS = "http://www.w3.org/2000/svg";

function applyRomanRunStyle(el) {
  if (el.namespaceURI === SVG_NS) {
    el.setAttribute("font-family", ROMAN_NUMERAL_FONT_FAMILY);
    el.setAttribute("font-style", "normal");
    el.setAttribute("letter-spacing", "normal");
    return;
  }
  el.style.fontFamily = ROMAN_NUMERAL_FONT_FAMILY;
  el.style.fontStyle = "normal";
  el.style.letterSpacing = "normal";
}

export function fillSvgTextWithRomanRuns(parent, str) {
  const s = String(str ?? "");
  const runs = splitRomanRuns(s);
  if (!runs.some((r) => r.roman)) {
    parent.textContent = s;
    return;
  }
  for (const run of runs) {
    if (run.roman) {
      const ts = document.createElementNS(SVG_NS, "tspan");
      applyRomanRunStyle(ts);
      ts.textContent = run.text;
      parent.appendChild(ts);
    } else {
      parent.appendChild(document.createTextNode(run.text));
    }
  }
}

export function fillHtmlTextWithRomanRuns(parent, str) {
  const s = String(str ?? "");
  const runs = splitRomanRuns(s);
  if (!runs.some((r) => r.roman)) {
    parent.textContent = s;
    return;
  }
  for (const run of runs) {
    if (run.roman) {
      const span = document.createElement("span");
      span.className = "roman-numeral-run";
      applyRomanRunStyle(span);
      span.textContent = run.text;
      parent.appendChild(span);
    } else {
      parent.appendChild(document.createTextNode(run.text));
    }
  }
}
