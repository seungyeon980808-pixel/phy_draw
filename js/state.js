/* ===== STATE (DESIGN 1-1: data is the single source of truth) ===== */
//
// The whole drawing is one plain data object. SVG is only a projection of it.
// `objects` holds every shape (a rectangle is one object — DESIGN 1-1). The
// render pass paints these; nothing reads back from the SVG DOM.
//
// `viewBox` mirrors the SVG viewBox and is the ONLY coordinate authority
// (DESIGN 1-2). Zoom/pan mutate this, never a CSS transform.

import { createStore } from "./store.js?v=0.36.7";

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

// 구간 번호(section/region markers)로 쓰인 ASCII I/II/III만 세리프(Times New Roman
// 정체)로 렌더링한다. 물리량 라벨은 labelType 기반(applyObjectLabelFont)으로 따로
// 처리하므로 여기서 건드리지 않는다.
export const ROMAN_NUMERAL_FONT_FAMILY = '"Times New Roman", "Batang", "바탕", serif';

// "구간"(with optional spaces) 뒤에 붙은 I / II / III 만 매칭한다. 라틴 단어 경계
// (뒤가 라틴 글자면 미매칭)로 "구간 Info" 같은 영어 단어는 제외된다.
const SECTION_ROMAN_RE = /구간(\s*)(I{1,3})(?![A-Za-z])/g;

// 텍스트를 "구간 로마 숫자 런"과 "일반 런"으로 쪼갠다. 로마 숫자 런이 되는 것은
// "구간 I", "마찰구간 II", "마찰 구간 III"처럼 구간 번호로 쓰인 I/II/III 뿐이다.
// 홀로 선 I, 영어 단어 속 I, 물리량 라벨은 여기서 변환되지 않는다.
// 반환: [{ text, roman }] 런 배열(인접 동종 런은 합쳐짐).
export function splitRomanRuns(text) {
  const s = String(text ?? "");
  const runs = [];
  const push = (str, roman) => {
    if (!str) return;
    const prev = runs[runs.length - 1];
    if (prev && prev.roman === roman) prev.text += str;
    else runs.push({ text: str, roman });
  };
  SECTION_ROMAN_RE.lastIndex = 0;
  let last = 0, m;
  while ((m = SECTION_ROMAN_RE.exec(s))) {
    // 로마 토큰은 "구간" + 공백 뒤에서 시작한다. 그 앞(한글 "구간"과 간격 포함)은
    // 일반 텍스트 글꼴을 유지한다.
    const romanStart = m.index + "구간".length + m[1].length;
    if (romanStart > last) push(s.slice(last, romanStart), false);
    push(m[2], true);
    last = romanStart + m[2].length;
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
  if (typeof obj.italic === "boolean") return obj.italic ? "italic" : "normal";
  if (isEquationFontFamily(obj.fontFamily)) return EQUATION_FONT_STYLE;
  return obj.italic === true || obj.fontStyle === "italic" ? "italic" : "normal";
}

export function resolveTextLetterSpacing(obj = {}) {
  return isEquationFontFamily(obj.fontFamily) ? EQUATION_LETTER_SPACING : null;
}

export function textRunStyleFromObject(obj = {}) {
  const italic = typeof obj.italic === "boolean"
    ? obj.italic
    : obj.fontStyle === "italic" || isEquationFontFamily(obj.fontFamily);
  return {
    role: obj.role || "normal",
    fontFamily: obj.fontFamily || DEFAULT_TEXT_FONT,
    fontSize: obj.fontSize || DEFAULT_TEXT_SIZE_MM,
    fontWeight: obj.fontWeight || "normal",
    italic,
    underline: !!obj.underline,
    strikeout: !!obj.strikeout,
  };
}

export function normalizeTextRunStyle(style = {}, fallback = {}) {
  const base = textRunStyleFromObject(fallback);
  const italic = typeof style.italic === "boolean"
    ? style.italic
    : style.fontStyle === "italic" || base.italic;
  return {
    // role carries palette-inserted symbol metadata (sectionRoman/quantity). It is
    // the reason a run keeps its own font instead of the object's whole-text font.
    role: style.role || base.role || "normal",
    fontFamily: style.fontFamily || base.fontFamily,
    fontSize: Number.isFinite(style.fontSize) ? style.fontSize : base.fontSize,
    fontWeight: style.fontWeight || (style.bold ? "bold" : base.fontWeight),
    italic,
    underline: typeof style.underline === "boolean" ? style.underline : base.underline,
    strikeout: typeof style.strikeout === "boolean" ? style.strikeout : base.strikeout,
  };
}

function sameTextRunStyle(a = {}, b = {}) {
  return (a.role || "normal") === (b.role || "normal") &&
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikeout === b.strikeout;
}

/* ----- symbol-palette run styles (DESIGN: palette inserts STYLED runs) -----
 * A palette button does NOT insert a plain character; it inserts a run carrying
 * its own font metadata via `role`. sectionRoman = Times New Roman upright (구간
 * 번호 I/II/III); quantity = Times New Roman italic (물리량 m/v/F/a/t). These are
 * merged onto the object/draft base style by normalizeTextRunStyle, so size is
 * inherited from the current text while font-family/style come from the role. */
export const SECTION_ROMAN_STYLE = Object.freeze({
  role: "sectionRoman",
  fontFamily: '"Times New Roman", serif',
  fontWeight: "normal",
  italic: false,
});
export const QUANTITY_STYLE = Object.freeze({
  role: "quantity",
  fontFamily: '"Times New Roman", serif',
  fontWeight: "normal",
  italic: true,
});

export function normalizeTextRuns(obj = {}) {
  const sourceRuns = Array.isArray(obj.textRuns) && obj.textRuns.length
    ? obj.textRuns
    : [{ text: obj.text ?? "", style: textRunStyleFromObject(obj) }];
  const out = [];
  for (const run of sourceRuns) {
    const text = String(run?.text ?? "");
    if (!text) continue;
    const style = normalizeTextRunStyle(run?.style || {}, obj);
    const prev = out[out.length - 1];
    if (prev && sameTextRunStyle(prev.style, style)) prev.text += text;
    else out.push({ text, style });
  }
  if (!out.length && (obj.text ?? "") !== "") {
    out.push({ text: String(obj.text ?? ""), style: textRunStyleFromObject(obj) });
  }
  return out;
}

// 텍스트 객체가 "실제 사용자 서식이 담긴 여러 런"을 가지는지 여부. 런이 하나뿐이면
// 그것은 객체 레벨 글꼴 필드(fontFamily/italic/…)를 그대로 복제한 것이라, 일반(plain)
// 렌더 경로와 시각적으로 동일하다. 그리고 그 일반 경로가 "구간 I/II/III" 세리프 처리를
// 담당한다. 선택 글자 서식이 제거되어 새 객체는 다중 런을 만들지 않으며, 오직 예전 저장
// 파일만 다중 런을 가질 수 있다. 그런 경우에만 명시적 런을 보존한다.
export function hasStyledTextRuns(obj = {}) {
  const runs = obj.textRuns;
  if (!Array.isArray(runs) || !runs.length) return false;
  // Multiple runs = real per-run formatting. A single run also counts when it is a
  // palette-inserted symbol (role !== normal), so a lone I/F still renders styled
  // instead of falling back to the plain path (which would drop its Times font).
  if (runs.length > 1) return true;
  const role = runs[0] && runs[0].style && runs[0].style.role;
  return !!(role && role !== "normal");
}

export function textRunsToText(runs = []) {
  return Array.isArray(runs) ? runs.map((run) => String(run?.text ?? "")).join("") : "";
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
