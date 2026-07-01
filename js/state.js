/* ===== STATE (DESIGN 1-1: data is the single source of truth) ===== */
//
// The whole drawing is one plain data object. SVG is only a projection of it.
// `objects` holds every shape (a rectangle is one object — DESIGN 1-1). The
// render pass paints these; nothing reads back from the SVG DOM.
//
// `viewBox` mirrors the SVG viewBox and is the ONLY coordinate authority
// (DESIGN 1-2). Zoom/pan mutate this, never a CSS transform.

import { createStore } from "./store.js?v=0.36.4";

export const TEXT_FONT_FAMILY = '"돋움", "Dotum", "Apple SD Gothic Neo", "맑은 고딕", "Malgun Gothic", sans-serif';
export const EQUATION_FONT_FAMILY = '"HYhwpEQ", "HWhwpEQ", "Cambria Math", "Times New Roman", "Batang", "바탕", serif';
export const EQUATION_FONT_STYLE = "italic";
export const EQUATION_LETTER_SPACING = "-0.04em";
export const TOOL_LABEL_FONT_FAMILY = EQUATION_FONT_FAMILY;
export const VARIABLE_LABEL_FONT_STYLE = "italic";
export const CALLOUT_LABEL_FONT_STYLE = "normal";
export const OBJECT_LABEL_TYPES = ["quantity", "label"];
export const OBJECT_LABEL_QUANTITY_FONT_FAMILY = '"Times New Roman", "Cambria Math", "HYhwpEQ", "HWhwpEQ", "Batang", "바탕", serif';
// 라벨(물체명·비물리량) 기본 글꼴: 신명중명조 정체. 물리량(이탤릭 Times)과 구분.
// 일반 텍스트 도구(돋움)와도 분리 — 객체 라벨 "라벨" 종류 전용.
export const OBJECT_LABEL_TEXT_FONT_FAMILY = '"신명중명조", "Shin Myeongjo", "SMMyungJo", "Batang", "바탕", serif';

// 로마 숫자(ASCII I·II·III … 와 유니코드 Ⅰ·Ⅱ·Ⅲ …)는 세리프(명조) 글리프로
// 렌더한다. 신명중명조가 있으면 우선 사용하고, 없으면 바탕→generic serif로 폴백해
// 어떤 환경에서도 세리프(장식 획) 글리프가 보장된다. 라벨용 정체 글꼴과 같은 체인.
export const ROMAN_NUMERAL_FONT_FAMILY = OBJECT_LABEL_TEXT_FONT_FAMILY;

// 대문자 ASCII 로마 숫자 형식 검증(빈 문자열 제외). "MIX"처럼 우연히 유효한 라틴
// 단어가 드물게 걸릴 수 있으나 실사용(로마 숫자 표기)에선 허용 범위로 둔다.
const ROMAN_ASCII_RE = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

function isRomanToken(tok) {
  // 유니코드 로마 숫자 코드포인트(Ⅰ..ↈ)는 그 자체로 로마 숫자.
  if (/^[Ⅰ-ↈ]+$/.test(tok)) return true;
  // 대문자 로마 문자로만 이뤄지고 로마 숫자 형식을 만족하는 라틴 단어.
  return /^[MDCLXVI]+$/.test(tok) && ROMAN_ASCII_RE.test(tok);
}

// 텍스트를 "로마 숫자 런"과 "일반 런"으로 쪼갠다. 로마 숫자 토큰 후보는
// (1) 유니코드 로마 숫자 연속, (2) 라틴 단어 경계로 끊긴 대문자 로마 문자열.
// 라틴 글자와 붙어 있는 I(예: "In")는 하나의 라틴 단어로 묶여 로마 숫자로 오인되지
// 않는다. 반환: [{ text, roman }] 런 배열(인접 동종 런은 합쳐짐).
export function splitRomanRuns(text) {
  const s = String(text ?? "");
  const runs = [];
  const push = (str, roman) => {
    if (!str) return;
    const prev = runs[runs.length - 1];
    if (prev && prev.roman === roman) prev.text += str;
    else runs.push({ text: str, roman });
  };
  const re = /[Ⅰ-ↈ]+|[A-Za-z]+/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) push(s.slice(last, m.index), false);
    push(m[0], isRomanToken(m[0]));
    last = m.index + m[0].length;
  }
  if (last < s.length) push(s.slice(last), false);
  return runs;
}

// 텍스트에 세리프 처리가 필요한 로마 숫자가 하나라도 있는지.
export function hasRomanNumeral(text) {
  return splitRomanRuns(text).some((r) => r.roman);
}

function normalizeFontFamily(value) {
  return String(value || "")
    .replace(/['"]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function isEquationFontFamily(value) {
  const normalized = normalizeFontFamily(value);
  return normalized === normalizeFontFamily(EQUATION_FONT_FAMILY) ||
    normalized.startsWith("hyhwpeq,");
}

export function resolveTextFontStyle(obj = {}) {
  if (isEquationFontFamily(obj.fontFamily)) return EQUATION_FONT_STYLE;
  return obj.italic === true || obj.fontStyle === "italic" ? "italic" : "normal";
}

export function resolveTextLetterSpacing(obj = {}) {
  return isEquationFontFamily(obj.fontFamily) ? EQUATION_LETTER_SPACING : null;
}

/* ===== TEXT FONT OPTIONS (single source for inspector + font modal) =====
 * `css` is used verbatim as both the SVG <text> font-family AND the editor
 * caret font, so draft and committed text always resolve the same font. */
export const TEXT_FONTS = [
  // Default: system gothic stack by NAME (no @font-face / no embedding).
  // Windows resolves 돋움; macOS falls back to Apple SD Gothic Neo. Export
  // renders from the exporting machine's installed font (no inlining).
  { label: "돋움 (시스템)",      css: TEXT_FONT_FAMILY },
  { label: "함초롬바탕",        css: '"HamchoromBatang", serif' },
  { label: "신명중명조",        css: '"신명중명조", "바탕", serif' },
  { label: "IBM Plex Sans KR", css: "'IBM Plex Sans KR', sans-serif" },
  { label: "Noto Sans KR",     css: "'Noto Sans KR', sans-serif" },
  { label: "맑은 고딕",         css: "'Malgun Gothic', sans-serif" },
  { label: "Malgun Gothic",    css: "'Malgun Gothic', sans-serif" },
  { label: "Arial",            css: "Arial, sans-serif" },
  { label: "Times New Roman",  css: "'Times New Roman', serif" },
  { label: "명조 (serif)",      css: "serif" },
  { label: "sans-serif",       css: "sans-serif" },
  { label: "고정폭 (monospace)", css: "monospace" },
];
export const DEFAULT_TEXT_FONT = TEXT_FONT_FAMILY;
// On-screen px the new-text caret/glyph targets; converted to world units at
// creation via the true render scale (see tools.js setupTextTool).
export const DEFAULT_TEXT_SIZE_PX = 14;
export const DEFAULT_TEXT_SIZE_MM = 3.7;  // fixed world size (mm), zoom-independent (mirrors PyQt PX_PER_MM)

// Circuit element body length along the p1→p2 axis (mm). FIXED world constant
// (same pattern as DEFAULT_TEXT_SIZE_MM): the body is always this size, so the
// two leads — the leftover wire from each terminal to the centered body — are
// equal by construction. Lead lengths are NEVER stored; they're derived at render.
export const CIRCUIT_BODY_MM = 8;

// Font style presets (font-weight × font-style) for the 글꼴 설정 modal.
export const TEXT_STYLES = [
  { label: "Regular",     fontWeight: "normal", fontStyle: "normal" },
  { label: "Bold",        fontWeight: "bold",   fontStyle: "normal" },
  { label: "Italic",      fontWeight: "normal", fontStyle: "italic" },
  { label: "Bold Italic", fontWeight: "bold",   fontStyle: "italic" },
];

// Typographic size presets (points). Stored fontSize is in WORLD units (mm);
// the UI presents points and converts via MM_PER_PT so 6–72 read naturally.
export const TEXT_SIZE_PRESETS = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
// Minimum selectable/typed text size (points). Inputs clamp to this floor.
export const MIN_TEXT_PT = 6;
export const MM_PER_PT = 25.4 / 72;
export const ptToMm = (pt) => pt * MM_PER_PT;
export const mmToPt = (mm) => mm / MM_PER_PT;

/* ----- initial state ----- */
export const state = createStore({
  // objects: array of { id, type, ...props } — the real drawing data.
  objects: [],

  // Editing-only ruler guides, kept separate from exported objects.
  guides: [],
  selectedGuideId: null,

  // artboard: the page region, single source of truth for its size (DESIGN 1-1).
  // 1 world unit = 1 mm. Centered on world origin, so it spans
  // x ∈ [-w/2, +w/2], y ∈ [-h/2, +h/2] (origin derived as -w/2, -h/2).
  // Default 90×60. Max size is 100×100 (size-adjust UI lands later; not enforced yet).
  artboard: { w: 90, h: 60 },

  // viewBox: world-space rectangle currently shown (x, y, w, h).
  // Initial view: 90×60 artboard centered at origin with ~10mm margin on each side.
  viewBox: { x: -55, y: -40, w: 110, h: 80 },

  // activeTool: which tool is armed. "V" = select, "R" = rectangle (DESIGN §3).
  // Drawing auto-returns to "V" right after a shape lands (DESIGN 4-3).
  activeTool: "V",

  // draft: the in-progress shape shown live during a drag. null when idle.
  // It is NOT a committed object — on mouse-up it becomes one in `objects`.
  draft: null,

  // draftText: the in-progress text being typed (T tool). Shape:
  //   { x, y, text, fontSize, fontFamily }
  // Displayed through the native textarea while editing so its caret and glyphs
  // share one browser layout. Never exported or saved; commit creates the real
  // text object and ESC discards the draft.
  draftText: null,

  // editingFormulaId: id of the formula object currently open in the inline
  // formula editor (tools.js), or null. Transient — never saved/exported; render
  // skips this object so its committed glyphs don't show behind the input.
  editingFormulaId: null,

  // selectedIds: array of selected object ids; empty = nothing selected.
  selectedIds: [],

  // undoStack / redoStack: each entry is a deep-cloned objects array snapshot.
  // Populated by transform.js; nothing else should touch these directly.
  undoStack: [],
  redoStack: [],

  // groups: array of { id, memberIds: [] }. Objects reference their group via obj.groupId.
  groups: [],

  // targetedId: id of the single group member targeted by double-click (주황색 지목 상태). null when idle.
  targetedId: null,

  // activeLayerId: the layer currently being drawn/edited.
  activeLayerId: 1,

  // layers: ordered list of layers; each shape will reference its layer via obj.layerId.
  layers: [
    { id: 1, name: "레이어 1", visible: true },
    { id: 2, name: "레이어 2", visible: true },
    { id: 3, name: "레이어 3", visible: true },
  ],

  // grid: canvas reference grid (never exported). opacity maps 1-10 → 0.05-1.0.
  grid: { visible: false, opacity: 3, interval: 10 },
});
