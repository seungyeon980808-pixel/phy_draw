/* ===== FORMULA (brace-syntax math rendering) =====
 *
 * A `formula` object is one atomic drawing object whose `source` is a small,
 * LaTeX-like, BRACE-based string (parentheses are LITERAL text — physics
 * formulas use them constantly, so commands never consume `()`):
 *
 *   frac{T_0}{4}      vertical fraction
 *   vec{F}            arrow over a symbol
 *   sqrt{2}           square root with a radical + vinculum
 *   T_0   v^2         subscript / superscript (attach to the preceding atom)
 *   lambda  pi  ...   Greek by NAME → glyph (also: paste a glyph directly)
 *
 * Examples: `F = ma`, `v^2 = v_0^2 + 2a(x - x_0)`, `T = 2pi sqrt{frac{l}{g}}`.
 *
 * DESIGN GUARANTEE — EXPORT CONSISTENCY: layout uses canvas measureText (sync,
 * no live DOM) and emits ONLY static SVG (<text>/<line>/<path>) with absolute
 * coordinates. So the SAME renderObject() output is what the editor shows AND
 * what SVG/PNG export serializes — pixel-identical, no getBBox dependency.
 *
 * Nesting IS supported (frac inside sqrt, etc.) via plain recursion; a depth cap
 * keeps a pathological string from running away. Parsing is wrapped so a bad
 * source degrades to literal text rather than blanking the canvas.
 */

import {
  DEFAULT_TEXT_FONT,
  DEFAULT_TEXT_SIZE_MM,
  resolveTextFontStyle,
  resolveTextLetterSpacing,
} from "./state.js?v=0.36.4";

const SVG_NS = "http://www.w3.org/2000/svg";
// Glyph + rule ink. Mirrors renderText(), which always paints #0d1117 (text has
// no stroke-color control); formulas follow the same single ink convention.
const INK = "#0d1117";
const MAX_DEPTH = 8; // recursion guard for nested frac/sqrt/vec

/* ----- Greek names → glyphs (whole-word match only; unknown words pass through) ----- */
const GREEK = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", rho: "ρ",
  sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ",
  psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

/* ===== PARSER (recursive descent over the brace grammar) ===== */
// AST node shapes:
//   { type:"row", items:[...] }
//   { type:"text", value:"…" }
//   { type:"frac", num:<node>, den:<node> }
//   { type:"vec",  body:<node> }
//   { type:"sqrt", body:<node> }
//   { type:"script", base:<node>, sub:<node|null>, sup:<node|null> }
function parseFormula(src) {
  const s = String(src == null ? "" : src);
  let i = 0;

  const isLetter = (c) => c >= "a" && c <= "z" || c >= "A" && c <= "Z";
  const isDigit = (c) => c >= "0" && c <= "9";

  function readWord() { let j = i; while (j < s.length && isLetter(s[j])) j++; const w = s.slice(i, j); i = j; return w; }
  function readNumber() { let j = i; while (j < s.length && (isDigit(s[j]) || s[j] === ".")) j++; const w = s.slice(i, j); i = j; return w; }
  function skipSpaces() { while (i < s.length && s[i] === " ") i++; }

  function parseGroup(depth) {
    // Caller guarantees s[i] === "{".
    i++; // consume "{"
    const node = parseSeq(depth + 1, true);
    if (s[i] === "}") i++; // consume matching "}" (tolerate a missing one)
    return node;
  }

  function parseSeq(depth, inGroup) {
    const items = [];
    let guard = 0;
    while (i < s.length) {
      if (inGroup && s[i] === "}") break;
      const before = i;
      const atom = parseAtomWithScripts(depth);
      if (atom) items.push(atom);
      if (i === before) i++;          // never stall
      if (++guard > 100000) break;    // hard safety
    }
    return { type: "row", items };
  }

  function parseScriptUnit(depth) {
    if (s[i] === "{") return parseGroup(depth);
    const c = s[i];
    if (c === undefined) return { type: "row", items: [] };
    if (isLetter(c)) { const w = readWord(); return { type: "text", value: GREEK[w] || w }; }
    if (isDigit(c)) return { type: "text", value: readNumber() };
    i++; return { type: "text", value: c };
  }

  function parseAtom(depth) {
    const c = s[i];
    if (c === undefined) return null;
    if (c === "{") return parseGroup(depth);
    if (isLetter(c)) {
      const w = readWord();
      if (depth < MAX_DEPTH && s[i] === "{" && (w === "frac" || w === "vec" || w === "sqrt")) {
        if (w === "frac") {
          const num = parseGroup(depth);
          skipSpaces();
          const den = s[i] === "{" ? parseGroup(depth) : { type: "row", items: [] };
          return { type: "frac", num, den };
        }
        if (w === "vec") return { type: "vec", body: parseGroup(depth) };
        return { type: "sqrt", body: parseGroup(depth) };
      }
      // Whole-word Greek substitution; otherwise the run is literal text.
      return { type: "text", value: GREEK[w] || w };
    }
    if (isDigit(c)) return { type: "text", value: readNumber() };
    i++; return { type: "text", value: c }; // space, operators, parens, unicode glyph
  }

  function parseAtomWithScripts(depth) {
    const base = parseAtom(depth);
    if (!base) return null;
    let sub = null, sup = null;
    while (s[i] === "_" || s[i] === "^") {
      const kind = s[i]; i++;
      const unit = parseScriptUnit(depth);
      if (kind === "_") { if (!sub) sub = unit; } else if (!sup) sup = unit;
    }
    return (sub || sup) ? { type: "script", base, sub, sup } : base;
  }

  return parseSeq(0, false);
}

/* ===== MEASUREMENT (offline canvas; linear in font-size so px ≡ world-mm units) ===== */
let _measureCanvas = null;
function _ctx() {
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  return _measureCanvas.getContext("2d");
}
function advance(str, F, font) {
  if (!str) return 0;
  const c = _ctx();
  c.font = `${font.style || "normal"} ${font.weight || "normal"} ${F}px ${font.family}`;
  return c.measureText(str).width;
}

/* ===== LAYOUT (box model; each node → {w, ascent, descent, draw(g, x, baseY)}) =====
 * ascent  = height above the baseline; descent = depth below it.
 * draw()  = append static SVG to <g>, left edge at x, baseline at baseY. */
const ASC = 0.74;   // text cap/ascender as a fraction of font-size
const DESC = 0.24;  // text descender as a fraction of font-size

function el(tag) { return document.createElementNS(SVG_NS, tag); }

function layoutText(value, F, font) {
  return {
    w: advance(value, F, font),
    ascent: F * ASC,
    descent: F * DESC,
    draw(g, x, baseY) {
      if (!value) return;
      const t = el("text");
      t.setAttribute("x", x);
      t.setAttribute("y", baseY);
      t.setAttribute("font-size", F);
      t.setAttribute("font-family", font.family);
      if (font.weight && font.weight !== "normal") t.setAttribute("font-weight", font.weight);
      t.setAttribute("font-style", resolveTextFontStyle({ fontFamily: font.family, fontStyle: font.style }));
      const letterSpacing = resolveTextLetterSpacing({ fontFamily: font.family });
      if (letterSpacing) t.setAttribute("letter-spacing", letterSpacing);
      t.setAttribute("fill", INK);
      t.setAttribute("text-anchor", "start");
      t.textContent = value;
      g.appendChild(t);
    },
  };
}

function layoutRow(node, F, font) {
  const kids = node.items.map((n) => layout(n, F, font));
  let w = 0, ascent = F * ASC, descent = F * DESC;
  for (const k of kids) { w += k.w; if (k.ascent > ascent) ascent = k.ascent; if (k.descent > descent) descent = k.descent; }
  return {
    w, ascent, descent,
    draw(g, x, baseY) { let cx = x; for (const k of kids) { k.draw(g, cx, baseY); cx += k.w; } },
  };
}

function layoutScript(node, F, font) {
  const base = layout(node.base, F, font);
  const sf = F * 0.66;
  const sub = node.sub ? layout(node.sub, sf, font) : null;
  const sup = node.sup ? layout(node.sup, sf, font) : null;
  const scriptW = Math.max(sub ? sub.w : 0, sup ? sup.w : 0);
  const w = base.w + scriptW + F * 0.04;
  const supDrop = F * 0.42; // sup baseline raised this far above the main baseline
  const subDrop = F * 0.20; // sub baseline lowered this far below it
  let ascent = base.ascent, descent = base.descent;
  if (sup) ascent = Math.max(ascent, supDrop + sup.ascent);
  if (sub) descent = Math.max(descent, subDrop + sub.descent);
  return {
    w, ascent, descent,
    draw(g, x, baseY) {
      base.draw(g, x, baseY);
      const sx = x + base.w + F * 0.02;
      if (sup) sup.draw(g, sx, baseY - supDrop);
      if (sub) sub.draw(g, sx, baseY + subDrop);
    },
  };
}

function rule(g, x1, y1, x2, y2, F) {
  const ln = el("line");
  ln.setAttribute("x1", x1); ln.setAttribute("y1", y1);
  ln.setAttribute("x2", x2); ln.setAttribute("y2", y2);
  ln.setAttribute("stroke", INK);
  ln.setAttribute("stroke-width", Math.max(F * 0.035, 0.08));
  ln.setAttribute("stroke-linecap", "round");
  g.appendChild(ln);
}

function layoutFrac(node, F, font) {
  const partF = F * 0.88;
  const num = layout(node.num, partF, font);
  const den = layout(node.den, partF, font);
  const pad = F * 0.08;
  const inner = Math.max(num.w, den.w);
  const w = inner + 2 * pad;
  const axis = F * 0.22;  // fraction bar sits this far above the baseline
  const gap = F * 0.08;   // compact clearance for small diagram labels
  const barRel = -axis;
  const numBaseRel = barRel - gap - num.descent;
  const denBaseRel = barRel + gap + den.ascent;
  const ascent = num.ascent - numBaseRel;       // distance from baseline up to num top
  const descent = denBaseRel + den.descent;     // distance from baseline down to den bottom
  return {
    w, ascent, descent,
    draw(g, x, baseY) {
      rule(g, x + pad * 0.45, baseY + barRel, x + w - pad * 0.45, baseY + barRel, F);
      num.draw(g, x + pad + (inner - num.w) / 2, baseY + numBaseRel);
      den.draw(g, x + pad + (inner - den.w) / 2, baseY + denBaseRel);
    },
  };
}

function layoutVec(node, F, font) {
  const body = layout(node.body, F, font);
  const minBodyW = Math.max(body.w, F * 0.18);
  const overhang = Math.min(F * 0.05, Math.max(minBodyW * 0.05, F * 0.015));
  const w = Math.max(minBodyW + overhang * 2, F * 0.32);
  const gap = F * 0.14;
  const stroke = Math.max(F * 0.055, 0.08);
  const head = Math.max(F * 0.085, stroke * 1.8);
  const arrowRel = -(body.ascent + gap + head * 0.55 + stroke * 0.5);
  const ascent = body.ascent + gap + head * 1.1 + stroke;
  return {
    w, ascent, descent: body.descent,
    draw(g, x, baseY) {
      body.draw(g, x + (w - body.w) / 2, baseY);
      const y = baseY + arrowRel;
      const bodyCenter = x + w / 2;
      const arrowLen = Math.min(Math.max(body.w, F * 0.24) * 1.04, w);
      const start = bodyCenter - arrowLen / 2;
      const end = bodyCenter + arrowLen / 2;
      const p = el("path");
      p.setAttribute("d",
        `M ${start} ${y} L ${end} ${y} ` +
        `M ${end - head} ${y - head * 0.55} L ${end} ${y} L ${end - head} ${y + head * 0.55}`);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", INK);
      p.setAttribute("stroke-width", stroke);
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      g.appendChild(p);
    },
  };
}

function layoutSqrt(node, F, font) {
  const body = layout(node.body, F, font);
  const lead = F * 0.55;       // width of the radical "√" zone before the content
  const topGap = F * 0.12;     // clearance between content top and the vinculum
  const tail = F * 0.06;       // small overhang past the content
  const w = lead + body.w + tail + F * 0.04;
  const vincRel = -(body.ascent + topGap);
  const ascent = body.ascent + topGap + F * 0.06;
  const descent = Math.max(body.descent, F * 0.12);
  return {
    w, ascent, descent,
    draw(g, x, baseY) {
      body.draw(g, x + lead, baseY);
      const yTop = baseY + vincRel;
      const yBottom = baseY + Math.min(descent, F * 0.2);
      const yMid = baseY - body.ascent * 0.35;
      const p = el("path");
      p.setAttribute("d",
        `M ${x} ${yMid} ` +
        `L ${x + lead * 0.35} ${yBottom} ` +
        `L ${x + lead * 0.72} ${yTop} ` +
        `L ${x + lead + body.w + tail} ${yTop}`);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", INK);
      p.setAttribute("stroke-width", F * 0.06);
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      g.appendChild(p);
    },
  };
}

function layout(node, F, font) {
  switch (node && node.type) {
    case "row": return layoutRow(node, F, font);
    case "text": return layoutText(node.value, F, font);
    case "script": return layoutScript(node, F, font);
    case "frac": return layoutFrac(node, F, font);
    case "vec": return layoutVec(node, F, font);
    case "sqrt": return layoutSqrt(node, F, font);
    default: return layoutText("", F, font);
  }
}

function fontOf(obj) {
  return {
    family: obj.fontFamily || DEFAULT_TEXT_FONT,
    weight: obj.fontWeight || "normal",
    style: resolveTextFontStyle(obj),
  };
}

/* ----- measureFormula: bbox of a source at a given size (stored as obj.w/obj.h) ----- */
export function measureFormula(source, fontSize, fontHint) {
  const F = fontSize || DEFAULT_TEXT_SIZE_MM;
  const font = fontHint || { family: DEFAULT_TEXT_FONT, weight: "normal", style: "normal" };
  let L;
  try { L = layout(parseFormula(source), F, font); }
  catch (_) { L = layoutText(String(source || ""), F, font); }
  return { w: L.w, ascent: L.ascent, descent: L.descent, h: L.ascent + L.descent };
}

/* ----- renderFormula: the projection used by BOTH the editor canvas and export ----- */
export function renderFormula(obj) {
  const F = obj.fontSize || DEFAULT_TEXT_SIZE_MM;
  const font = fontOf(obj);
  const g = el("g");
  if (obj.id) g.dataset.id = obj.id;

  let L;
  try { L = layout(parseFormula(obj.source || ""), F, font); }
  catch (_) { L = layoutText(String(obj.source || ""), F, font); }

  const left = obj.x;
  const top = obj.y;                 // top-left anchor, matching text (hanging)
  const baseY = top + L.ascent;
  const W = Math.max(L.w, F * 0.2);
  const H = Math.max(L.ascent + L.descent, F * 0.2);

  // Transparent body rect: makes the WHOLE box a click/drag target (gaps between
  // glyphs included), mirroring how axes/circuit use a transparent hit body.
  const hit = el("rect");
  hit.setAttribute("x", left);
  hit.setAttribute("y", top);
  hit.setAttribute("width", W);
  hit.setAttribute("height", H);
  hit.setAttribute("fill", "transparent");
  g.appendChild(hit);

  L.draw(g, left, baseY);

  if (obj.rotation) {
    g.setAttribute("transform", `rotate(${obj.rotation} ${left + W / 2} ${top + H / 2})`);
  }
  return g;
}

export { parseFormula, fontOf };
