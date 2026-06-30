/* ===== OBJECT STYLE (free styling only) =====
//
// The legacy "평가원 형태 / 자유 설정" object mode was removed in v0.22.0. Objects
// no longer carry a styleMode field and never have 수능형 비율/스타일 auto-applied —
// every object is styled purely from its own properties ("자유 설정").
//
// These helpers remain as thin shims so existing call sites stay stable and so old
// saved files (which still contain a styleMode field) keep loading without error. */

// Render-time resolution is now identity: the object's own props are authoritative.
export function resolveObjectStyle(obj) {
  return obj;
}

// New objects carry no style mode. Kept as a no-op for call sites that wrap object
// creation; intentionally does not write a styleMode field anymore.
export function applyNewObjectStyleDefaults(obj) {
  return obj;
}

// Old saved files may still contain a styleMode field — strip it on load so the
// dead field never dangles in current state.
export function migrateObjectStyleMode(obj) {
  if (obj && "styleMode" in obj) delete obj.styleMode;
  return obj;
}
