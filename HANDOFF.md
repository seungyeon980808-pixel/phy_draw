# 인수인계 문서 — PhysicsExamDrawer Web (HANDOFF.md)

> **다음 대화창에서 이 문서 + DESIGN.md를 함께 첨부하면 맥락이 복원된다.**
> 이 문서는 "지금 어디까지 왔고, 다음에 뭘 할지"를 담는다.
> 설계 결정의 *내용*은 DESIGN.md에 있다. 이 문서는 *진행 상황*만 담는다.

---

## 0. 한 줄 요약

**v0.32.x — 스냅 기능 재작업 진행 중.**
정렬 스냅 + 자석 부착은 이미 동작하나, 회전 오브젝트에서 자석이 어긋남.
→ **"Shift 단일 자석 + 2단 거리(80px 예고 / 40px 부착) + 빨간 점·점선 예고"** 모델로 재작업하기로 확정.
설계·결정 완료, 실행 프롬프트 준비됨(§12). **다음 세션(코덱스) 첫 작업 = 이 프롬프트 투입.**
대기: 그룹 관련 버그 4건(§8), Claude Code 훅 음성알림(전역 settings.json).

> ⚠️ v0.16 → v0.32 사이 작업 이력은 이 문서에 미반영(별도 세션들). 파일 구조·동작은 §4·§12의
> "검증된 사실"이 현재 기준. 불확실하면 `git log`로 확인.

---

## 1. 이 프로젝트가 무엇인가

- **무엇**: 중학교 과학(물리) 시험 문제용 그림을 그리는 웹 기반 SVG 에디터.
- **왜**: PyQt6 `physics_draw` 프로그램을 웹앱으로 이식. data-as-truth로 아키텍처 개선.
- **사용자**: 서울 대왕중학교 과학교사 본인. JS 학습 중. 코드는 Claude Code가 짜고 설계·리뷰만 직접.
- **범위**: **물리로 좁게 완성**이 현재 목표. 다른 과목은 물리 완성 후(또는 SVG 자산 라이브러리로 대체).
- **실사용 검증됨**: PNG 내보내기 → 한글(HWP) 삽입까지 이번 세션에 실제로 동작 확인 완료.

---

## 2. 현재 파일 구조

```
C:\Users\user\Desktop\project\51_phy_draw_web\
├── index.html
├── css/
│   ├── style.css
│   └── inspector.css
└── js/
    ├── state.js
    ├── store.js
    ├── render.js
    ├── viewport.js
    ├── tools.js
    ├── transform.js
    ├── inspector.js
    └── main.js
```

**버전 문자열**: 모든 import에 `?v=` 붙임.
⚠️ **이번 세션 핵심 교훈**: `?v=`를 한 파일이라도 빠뜨리면 ES 모듈이 별도 인스턴스로 중복 로드되어
초기화 안 된 복사본이 생긴다(아래 §3 핸들 버그 참조). **모든 프롬프트에 "전 파일 ?v= 일괄 통일" 조항을 반드시 넣을 것.**

---

## 3. 이번 세션(v0.11.1 → v0.16.x)에 완료한 것

### 곡선 닫기 (v0.12.0) — 완료
- 이전 세션 후보였던 것. 닫힌 곡선 채우기/히트테스트 완료(사용자가 "충분하다" 확인).

### 다크/라이트 테마 (v0.12.1) — 완료
- CSS 변수 기반 테마 시스템. **기본값 다크.**
- 우측 상단 ☀/🌙 토글 버튼, localStorage에 'theme' 저장.
- 상단 단축키 설명 텍스트 제거, "도구"/"인스펙터" 헤더 텍스트 제거.

### 프로젝트 저장/열기 (JSON) (v0.13.0) — 완료
- 상단 바 `파일` 영역에 저장/열기. **편집용 원본 = JSON** (내보내기와 역할 분리).
- 저장 포맷: `{ version, objects, layers, groups, artboard }`
  - **버전 필드 필수**(미래 마이그레이션 대비). load 시 migrate(data) 자리 마련(현재 통과만).
  - 저장 제외: undoStack/redoStack/selectedIds/targetedId/activeTool/activeLayerId/viewBox (순간 상태).
  - viewBox 복원 안 함(연 뒤 현재 화면 유지).

### 핸들 과대화 버그 픽스 (v0.13.1) — 완료 ⭐교훈
- **증상**: 선택 핸들이 줌과 무관하게 거대하게 고정.
- **진짜 원인**: render.js가 `viewport.js?v=0.12.0`을, 나머지는 `?v=0.13.0`을 import →
  ES 모듈이 둘을 별개 인스턴스로 취급 → render.js가 쓰는 viewport 복사본이 초기화 안 됨 →
  `getZoom()`이 항상 1 반환 → `5/zoom = 5` 고정.
- **교훈**: 핸들 크기 상수(5, 28)는 처음부터 정상이었음. 추측 수정 2회 모두 빗나감.
  → **버그 2회 빗나가면 "고치지 말고 진단만" 프롬프트로 전환**하는 패턴 확립.
- tools.js도 같은 stale import 있어 함께 수정.

### SVG/PNG 내보내기 (v0.14.x) — 완료
- 상단 바 `파일 ▾` 드롭다운: 프로젝트 저장 / 프로젝트 불러오기 / 이미지로 내보내기.
- **내보내기 다이얼로그(모달)**: 파일명 / 형식(PNG 기본·SVG) / 해상도(PNG만, **200·300·400dpi, 기본 300**).
- **SVG**: 아트보드 영역만(viewBox=아트보드), `width/height`를 mm로 박음(한글 실크기 삽입), 배경 투명.
- **PNG**: SVG→canvas→PNG. `pixelW = w/25.4*dpi`. **배경 흰색**(한글 삽입 표준). 숨긴 레이어 제외.
- 아트보드 밖 오브젝트는 viewBox로 자연 크롭(해석 A 확정 — 영역 드래그 지정은 안 함).

### 인스펙터 컴팩트화 + 좌표계 (v0.15.0) — 완료
- "선 색"/"채우기 색" 라벨 삭제, "채우기"→"면", "채우기 없음"을 "면" 헤더 옆으로, 레이어 설명 삭제.
- 채우기종류/선종류/화살표 → **텍스트 대신 SVG 아이콘 버튼**(+툴팁).
- **색 슬라이더 방향 수정**: 왼쪽 흰색(0) → 오른쪽 검정(255). 팔레트와 방향 일치.
- **색 레벨 숫자 입력칸**(0~255) 추가, 슬라이더와 양방향 동기화.
- 크기·위치 숫자칸 컴팩트(64px), 좌측 정렬, 클릭 시 전체 선택(input.select()).
- **Y축 = 수학 좌표(표시만)**: 중심 원점, 오른쪽 +X, **위쪽 +Y**.
  - ⚠️ **내부 데이터는 SVG 표준(아래로 +Y) 그대로.** 인스펙터 표시/입력 경계에서만 부호 반전
    (displayedY = -internalY, 입력 시 internalY = -inputY). 렌더/회전/변형 로직은 절대 안 건드림.
- 좌측 도구 패널: 3열 그리드 + 너비 축소.

### 아트보드 크기 조절 (v0.16.0) — 완료
- **단일 출처화**: 아트보드 크기를 `state.artboard = {w,h}`로 통합(이전엔 render.js에 90/65 하드코딩 +
  state.js viewBox에 암묵 중복이라 DESIGN 100×100과 불일치했음). render.js가 state에서 읽음.
- **기본 90×60** (이전 90×65에서 변경). 중심 원점, x∈[-w/2,+w/2], y∈[-h/2,+h/2].
- 인스펙터 **아트보드 섹션**(아무것도 선택 안 했을 때 표시): W/H 입력 + 프리셋 4개.
- 프리셋: 90×60 / 100×100 / 100×60 / 60×90. 최대 100×100 클램프.
- **크기 바꿔도 그림은 그대로**(아트보드 경계만 변경). JSON 저장/로드·SVG/PNG 내보내기 모두 state.artboard 참조.

### 1단계 UI 수정 (v0.16.1) — 진행 중(미확인)
- 한글 깨짐(내보내기 다이얼로그/zoom 옆 버튼) 수정.
- 아트보드 프리셋 2×2 그리드(라벨 잘림 해결).
- 선택 가이드/마퀴 점선 더 촘촘하게.
- ※ 이 프롬프트를 보냈으나 사용자 확인 전 세션 종료 가능성 있음 — **다음 세션에서 적용 여부 먼저 확인.**

### 스냅 재작업 (v0.32.x) — 설계 확정, 실행 대기 ⭐현재 작업
> PyQt 원본(`items.py`) 스냅 3종 중 정렬+자석은 이미 이식됨. 이번엔 모델 자체를 재설계.
> 상세 실행 프롬프트·검증 순서는 §12. 여기엔 결정 요약만.

- **현재 상태**: 정렬 스냅(7px 항상 켜짐) + 자석(22px, Ctrl) 동작 중. **회전 오브젝트에서 자석 어긋남**(후보점을 unrotated 좌표로 계산한 게 원인 추정).
- **확정한 변경** (사용자 합의 완료):
  1. 약한 정렬(항상 켜짐) **제거** → 스냅 평소 꺼짐.
  2. **Shift 누를 때만** 동작 (Ctrl 아님 — Ctrl은 복사/붙여넣기와 충돌. Shift는 이동 드래그 중 빔, 확인됨).
  3. 자석 후보 좌표를 **회전 적용**(`render.js` `singleObjBBox`/`rotPt` 기준) → 회전 버그 구조적 해결.
  4. 붙을 때 **상대 회전각 복사**로 각도까지 정렬(찰싹). 원본 `_magnetic_attach` 방식(A안).
  5. **2단 거리**: 80px 이내 = 예고만(닿을 두 지점에 빨간 점 2개 + 얇은 빨간 점선, 변이면 변 중점, 가장 가까운 한 쌍만) / 40px 이내 = 실제 부착.
  6. **곡선 제외**(DESIGN v2). 사각·타원·삼각의 변·꼭짓점만.
  7. 빨간 점·점선은 **데이터 아님 = 일시 오버레이**(선택 핸들과 같은 레이어). 드래그 끝·Shift 뗌·후보 없음 시 제거.
- **검증된 통합 위치**(재조사 불필요): §12 참조.

---

## 4. 스키마 현황 (data-as-truth 진실)

```js
// 공통
{ id, type, rotation, strokeLevel, strokeWidth,
  fillLevel, fillNone, locked, layerId, order, groupId }

// 갈래 A (rect / ellipse)        { ...공통, x, y, w, h, fillStyle }
// 갈래 A (triangle)              { ...공통, x, y, w, h, flipX, flipY, fillStyle }
// 갈래 B (line)                  { ...공통, p1, p2, arrowHead, dashLength, dashGap }
// 갈래 B (polyline)              { ...공통, points[], arrowHead, dashLength, dashGap, closed, fillStyle }
// 갈래 B (curve)                 { ...공통, points[], dashLength, dashGap }  (+ 곡선 닫기 필드)
// text                           { ...공통, x, y, fontSize, text }

// state 최상위
{ objects[], viewBox, activeTool, draft,
  selectedIds[], targetedId,
  layers[{id,name,visible}], activeLayerId,
  groups[{id,memberIds[]}],
  artboard:{ w, h },              // ★이번 세션 추가 — 기본 {w:90,h:60}, 중심 원점
  undoStack[], redoStack[] }
```

**좌표계**: 내부는 SVG 표준(아래로 +Y). 인스펙터 표시만 수학 좌표(위로 +Y, 부호 반전). 원점=아트보드 중심.

**저장 파일 포맷**: `{ version, objects, layers, groups, artboard }`. 옛 파일에 artboard 없으면 {w:90,h:60} 기본.

---

## 5. 단축키 현황 (변경 없음)

| 키 | 동작 |
|---|---|
| V / L / P / S / O / Y / C / T | 선택 / 직선 / 꺾은선 / 사각형 / 타원 / 삼각형 / 곡선 / 텍스트 |
| R | 회전 도구 |
| K | 개체 보호 토글 (V 도구) |
| G / Shift+G | 그룹 묶기 / 풀기 |
| Delete | 선택 개체 삭제 |
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | Undo / Redo |
| Ctrl+C / Ctrl+V | 복사 / 붙여넣기 (커서 위치) |
| 화살표키 (V) | nudge 이동 |
| **PageUp/Down (V 도구)** | **z순서 한 칸** |
| **PageUp/Down (R 도구)** | **회전 각도 조절** ← 도구별로 역할 다름(버그 아님) |
| Shift (크기조절) | 비율고정 / (선) 15도 스냅 |
| Ctrl (회전 중) | 15도 스냅 |
| 더블클릭(그룹 내) | 개체 지목 |

---

## 6. 가이드라인 색상 (변경 없음)

| 상태 | 색상 |
|---|---|
| 일반 선택 | 파란 #0969da |
| 개체 보호(locked) | 빨강 #e53e3e |
| 그룹 묶음 | 초록 #2f9e44 |
| 그룹 내 지목 | 주황 #e67700 |

---

## 7. 다음 작업 순서 (사용자와 합의된 묶음 순서)

> 원칙: 한 묶음씩 검증하며 진행. 한 번에 많이 묶으면 버그 추적 불가(이번 세션 핸들 버그 교훈).

### ⬛ 최우선 — 스냅 재작업 (§3 스냅 항목 + §12 실행 프롬프트)
설계 확정 완료. **다음 세션 첫 작업 = §12 영어 프롬프트를 코덱스에 투입.**
검증은 §12의 2단계(자석 자체 → 예고 오버레이) 순서로. 회전 사각형끼리 자석 되는지가 핵심.
끝나면 선 끝점 스냅(원본 `_find_snap_target` 이식)이 다음 묶음.

### ⬛ 그다음 — 그룹 버그 진단·수정 (§8 참조)
서로 얽힌 4건. **진단 프롬프트 먼저**(고치지 말고 "그룹 선택 상태 처리 경로" 보고만) → 보고 받고 일괄 수정.

### 2묶음 잔여 — 위치 고정 + 좌측 패널 너비 조절
- **위치 고정(positionLocked)**: 개체 보호와 별개. 이동·회전만 잠금, **인스펙터 수치 입력은 허용**(§8 상세).
- 좌측 도구 패널 너비 드래그 조절(우측 인스펙터엔 이미 있음).

### 3묶음 — 이미지 드래그 앤 드롭 불러오기 (확정됨)
- **용도**: 교과서/시험지 캡처(PNG/JPG)를 캔버스에 올려 **이동·크기조절·회전만**(내부 픽셀 편집 없음).
- **드래그 앤 드롭**으로 캔버스에 바로 올리기.
- **저장 방식 Base64**(JSON 안에 포함 — 파일 하나로 완결). 스키마에 `{type:"image", src(base64), x,y,w,h}` 추가.
- 지우개는 안 만듦 → **흰 사각형을 다른 레이어로 덮기**로 대체(사용자 합의).

### 4묶음 — 좌측 도구 토글 (기본 도구 on/off)

### 격자 (별도 묶음) — DESIGN 8-3
- 10mm 격자 + 50mm마다 숫자 + 진하기 조절 + **인쇄(내보내기) 시 제외.**

### 눈금자(ruler) + 가이드선 (별도 묶음) — Inkscape 스타일
- 상단·좌측 눈금자(줌·팬·수학좌표 연동). 가이드선(끌어당기는 보조선). 작업량 큼 → 독립 묶음.

### 그 후 — Phase 3 물리 템플릿 / Phase 4 미리보기·PDF / Phase 5 AI
- 템플릿(광학: 렌즈·거울), 대칭축 정렬, 스냅, 미리보기 모달, PDF 내보내기, AI 연동.

---

## 8. 결정만 됨 / 미구현 / 미해결 버그

### 🔴 미해결 버그 — 그룹 관련 (다음 세션 최우선, 서로 같은 뿌리로 의심)
1. **회전 도구(R)에서 PageUp/Down 회전 시, 그룹인데 중앙 개체 하나만 회전됨.**
   핸들로 돌리면 그룹 전체가 정상 회전 → **회전 경로가 둘로 갈려 한쪽(PageUp/Down)만 그룹 미인식.**
2. **그룹 선택 시 인스펙터에 위치·각도(좌표/회전)가 안 나타남.**
3. **여러 개체를 묶음 선택(또는 드래그 선택)했을 때 "개체 묶기" 버튼이 안 보임.**
4. **여러 객체 드래그 선택 시 선택 가이드(바운딩 박스 핸들)가 안 보임.**
→ 4건 모두 "다중선택/그룹 선택 상태 인식·표시"의 일관성 문제로 추정.
→ **진단 먼저**: Claude Code에 "그룹/다중선택 상태가 어떻게 판정되고, 회전·인스펙터·핸들·묶기버튼이
   각각 그 상태를 어떻게 읽는지 보고만 하라"고 시킨 뒤, 보고 받고 한 번에 수정. (핸들 버그와 동일 패턴.)

### 🟡 결정만 됨 / 미구현
- **위치 고정(positionLocked)**: 이동·회전 잠금 + 인스펙터 수치 입력은 허용 + 삭제는 가능.
  - 마우스·키보드 변형 경로는 `locked || positionLocked` 차단, 인스펙터 입력은 `locked`만 차단.
  - 개체 보호(locked)와 별개(보호는 전부 차단). 둘 다 켜지면 보호 우선. 가이드 색은 별색.
- **격자 / 눈금자 / 가이드선**: §7 참조, 미구현.

### 🟢 대기 — 프로젝트 무관 (전역 설정)
- **Claude Code 훅 음성알림**: 작업 완료 시 "작업이 완료되었습니다" 음성(SpeakAsync) + 자동닫힘 안내창(WScript Popup 3초).
  - **비차단 필수**(이전 MessageBox 차단형이 Claude Code 멈춤 유발). `~/.claude/settings.json` Stop 훅 수정.
  - 프롬프트 작성 완료, 새 창에서 `/clear` 후 실행 예정(사용자가 다른 계정 전환 중 보류).

---

## 9. 미뤄둔 것 (v2+ / 다른 과목)

- SVG **재편집** 불가(설계상): SVG는 결과물, 재편집은 JSON으로. (사용자에게 data-as-truth 원리 설명 완료.)
- JPG 내보내기: 안 만듦(투명 미지원·선 흐려짐, 물리 그림 부적합).
- 곡면 채우기 확장, 앵커/불리언, 컬러 도입(무채색 정체성과 상충 — 근거 먼저).
- 베지어 자유곡선, 폰트 선택, 물리 기호(아래첨자 θ λ 등) 텍스트 개선.
- 미리보기 2단 시험지 합성.

---

## 10. 작업 원칙 (CLAUDE.md 요약 + 이번 세션 추가 교훈)

- **역할 분리**: Claude(웹)=기획·설계·리뷰. 파일 생성·코드=Claude Code에서만.
- **프롬프트**: 한국어 요약 + 영어 실행 + 끝에 "Do not ask clarifying questions. Make reasonable assumptions and proceed."
  - 코드블록(펜스)으로 감싸 전달(복사 버튼). 필요한 파일 섹션만 읽게 지정.
- **Claude Code 실행**: `claude --dangerously-skip-permissions`, 작업 전 `/clear`.
- **버전**: vX.0.0=구조, v0.X.0=기능, v0.0.X=버그픽스. UI 하단 표기.
- ⭐ **`?v=` 전 파일 일괄 통일**: 모든 프롬프트에 "every ?v= in ALL files, no exceptions" 조항 필수.
  (이번 세션 핸들 버그의 원인 — 한 파일 누락이 모듈 중복 인스턴스 유발.)
- ⭐ **버그 2회 빗나가면 진단 전용 프롬프트로 전환**: "고치지 말고 실제 원인 위치만 보고하라."
  추측 수정 반복은 엉뚱한 곳을 건드림(핸들 버그에서 확립).
- ⭐ **되돌리기 비싼 결정은 먼저 확인**: 좌표계·아트보드 단일출처·저장 포맷 버전필드 등 이번 세션 사례.
- **커밋**: Conventional Commits(feat/fix/chore/docs/style). 완료 후 push.

---

## 11. GitHub

- 레포: `seungyeon980808-pixel / phy_draw`
- URL: `https://github.com/seungyeon980808-pixel/phy_draw.git`
- 브랜치: main, GitHub Pages 배포 기준.
- 이번 세션 핸들 버그 픽스 커밋: `3c73b74` (fix: 오브젝트 핸들이 과도하게 커지는 버그 해결) — push 완료.
- ⚠️ 이후 작업(v0.14~0.16)의 커밋/푸시 상태는 다음 세션에서 `git log`/`git status`로 확인 필요.
---

## 12. 스냅 재작업 — 실행 프롬프트 & 검증 (현재 작업)

> §3 "스냅 재작업" 항목의 실행 세부. 코덱스에 아래 영어 블록을 그대로 투입.

### 검증된 통합 위치 (코덱스가 재조사 불필요)

- **드래그 이동**: `transform.js` mousemove body-move 분기(~1101–1114). `_moveStartWorld` 기준 델타를
  `applyDelta(obj, orig, dx, dy)`로 `state.update(...)` 안에서 **매 mousemove마다 store에 live commit**.
  release(`finishGesture`)는 undo 스냅샷만 push. per-shape 좌표 수학은 `applyDelta`(~189–200).
- **단일/다중 통합**: 둘 다 `_moving` 제스처. mousedown이 `_moveObjIds` 배열 생성(~951–972),
  mousemove가 균일 순회(~1107–1114). 분기 없음.
- **회전 적용 좌표**: `render.js` `singleObjBBox(o, scene)`(~996) → `rotPt`(~903)로 회전 적용 네 꼭짓점
  (~1001–1006). 선택 박스·`combinedGroupBBox`(~1039) 사용.
  ⚠️ `tools.js` `hitTest`(~487)는 **회전 미적용** — 스냅 기준으로 쓰면 안 됨.
- **수정자 키**: 이동 드래그 중 Ctrl/Alt/Shift 모두 빔(회전에서만 Ctrl=15°, 크기조절에서 Shift=비율고정).
  → Shift를 자석 키로 써도 이동 드래그에선 충돌 없음.

### 실행 프롬프트 (영어, 그대로 투입)

```
Working directory: C:\Users\user\Desktop\project\51_phy_draw_web

Rework object snapping. Modify js/snap.js and add a snap-preview overlay.
Keep changes targeted; do not refactor unrelated code.

== REMOVE ==
- Remove the always-on weak align snap (the 7px alignment that runs without
  any modifier). Snapping must be OFF by default now.

== NEW BEHAVIOR: Shift-only magnet, two-stage by distance ==
Snapping runs ONLY while Shift is held during body-move drag.
(Verified: Shift is unused during translation drag. Ctrl is no longer the
magnet key.) Thresholds in screen px, converted via current zoom.

For the dragged selection and every OTHER object, compute candidate points
using ROTATION-APPLIED coordinates from render.js singleObjBBox / rotPt
(NOT unrotated x/y/w/h — that was the previous rotation bug). Candidates:
edge midpoints and corners of each shape (rect / ellipse / triangle only;
skip curves this pass). For multi-selection, treat _moveObjIds as one
combined bbox.

Find the single closest candidate pair (dragged point <-> target point)
within 80px. Then:

- If pair distance <= 80px AND > 40px  → PREVIEW ONLY (no attach):
  Draw a temporary overlay: a red dot at each of the two candidate points
  (for an edge, use the edge MIDPOINT), and a thin red dashed line
  connecting them. Closest pair only — never draw multiple pairs.
  This overlay is transient (not stored in state); clear it when the drag
  ends or when Shift is released or when no pair is within 80px.

- If pair distance <= 40px → ATTACH (magnet):
  Snap the dragged object so the two points coincide, AND copy the target
  object's rotation onto the dragged object so they sit flush (port the
  original PyQt _magnetic_attach angle-copy behavior). Show the same red
  dots/line at the attach moment too.

== INTEGRATION ==
- snap.js exports a resolve function called once per mousemove in the
  transform.js body-move branch BEFORE applyDelta; it returns adjusted
  {dx, dy} (raw delta if Shift not held), plus preview info (the two points
  or null).
- Render the red-dot/dashed-line overlay in the same transient layer as
  selection handles (NOT in state.objects). Remove on drag end.
- If Shift is NOT held: no snap, no overlay, raw delta.

== HARD CONSTRAINTS ==
- Update EVERY import ?v= string in ALL files to one new shared version,
  no exceptions (a single missed ?v= causes duplicate module instances).
- Section comment headers in snap.js and at every hook point.
- Bump the UI footer version string.
- Do not touch resize/rotate snap logic. Do not implement curve snapping.
- Conventional Commit when done (feat: ...), then report exactly what changed
  and which files' ?v= were updated.

Do not ask clarifying questions. Make reasonable assumptions and proceed.
```

### 검증 순서 (한 번에 보지 말고 2단계)

**1단계 — 자석 자체**
- Shift 누르고 사각형을 다른 사각형에 40px 이내로 → 찰싹 붙고 각도 맞는지.
- **회전시킨 사각형끼리도** 되는지 (핵심 — 기존 버그 지점).
- Shift 안 누르면 아무 스냅도 안 걸리는지(평소 꺼짐).

**2단계 — 예고 오버레이**
- 40~80px에서 빨간 점 2개 + 얇은 빨간 점선 뜨는지. 변끼리면 변 중점에 찍히는지.
- 더 가까이(40px) 가면 예고→부착 전환되는지.
- Shift 뗌/드래그 끝/멀어짐 시 오버레이 사라지는지. 가장 가까운 한 쌍만 그려지는지.

**회귀 확인**
- 평범한 이동 정상. **Undo로 스냅 이동이 한 번에 되돌려지는지**(live commit 구조). 다중 선택 이동 동작.

**실패 시**
- 고치라 하지 말고 "원인 위치만 보고"로 전환(핸들 버그 교훈).
- 스냅 아예 안 먹으면 **`?v=` 누락부터 의심**. 줌에서 임계값 이상하면 `40/zoom`·`80/zoom` 환산 오류.

### 끝난 뒤 다음 묶음
- **선 끝점 스냅**: 원본 `_find_snap_target`(items.py ~1534) 이식. release 시 끝점끼리 위치+각도 이어붙임. 광선 작도용.
- 변-평행 정밀 정렬(B안), 곡선 접점 스냅(v2), 객체별 on/off — 필요 느껴지면.
