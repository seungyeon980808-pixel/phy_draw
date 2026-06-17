# 인수인계 문서 — PhysicsExamDrawer Web (HANDOFF.md)

> **다음 대화창에서 이 문서 + DESIGN.md를 함께 첨부하면 맥락이 복원된다.**
> 이 문서는 "지금 어디까지 왔고, 다음에 뭘 할지"를 담는다.
> 설계 결정의 *내용*은 DESIGN.md에 있다. 이 문서는 *진행 상황*만 담는다.

---

## 0. 한 줄 요약

**v0.6.0 완료.** Phase 1의 1A(토대)·1B(도형 7종·줌팬)·1C-a(이동·Undo)·1C-b(핸들·크기조절) 완료.
다음은 **1C-c(회전)** → 이후 Delete·화살표키·Ctrl+C/V → Phase 2(레이어·인스펙터).

---

## 1. 이 프로젝트가 무엇인가

- **무엇**: 중학교 과학(물리) 시험 문제용 그림을 그리는 웹 기반 SVG 에디터.
- **왜**: PyQt6 `physics_draw` 프로그램을 웹앱으로 이식. data-as-truth로 아키텍처 개선.
- **사용자**: 서울 대왕중학교 과학교사 본인. JS 학습 3~4주차. 코드는 Claude가 짜고 설계·리뷰만 직접.

---

## 2. 현재 파일 구조

```
C:\Users\user\Desktop\project\51_phy_draw_web\
├── index.html          ← 앱 껍데기, 3패널, SVG#canvas, v0.6.0 표기
├── css/style.css
└── js/
    ├── state.js        ← 초기 상태 (objects, viewBox, activeTool, selectedId,
    │                      draft, undoStack, redoStack)
    ├── store.js        ← createStore (subscribe/update/get, 30줄)
    ├── render.js       ← render(state) + renderHandles() (핸들 7px/zoom 고정)
    ├── viewport.js     ← initViewport (휠줌·팬) + screenToWorld + getZoom
    ├── tools.js        ← initTools (8종 도구, hitTest 실제모양 기준)
    ├── transform.js    ← initTransform (이동·크기조절·Undo/Redo)
    └── main.js         ← 모듈 연결 (import 순서: state→render→viewport→tools→transform)
```

**버전 문자열**: 모든 import에 `?v=0.6.0` 붙임. 파일 수정 시 반드시 일괄 변경.

---

## 3. 완료된 기능 (v0.6.0 기준)

### Phase 1A — 토대
- store (subscribe/update/get), data-as-truth, SVG viewBox 좌표계
- 아트보드 90×65mm (중앙 원점, 흰 배경 + 회색 테두리)

### Phase 1B — 도형 7종 + 줌팬
- **갈래 A** (크기 기반): rect·ellipse·triangle — 드래그로 그리기
- **갈래 B** (끝점 기반): line·polyline·curve — 클릭으로 그리기 (P는 더블클릭/Enter 종료)
- **text**: 클릭 위치에 생성, 인라인 편집
- 그린 직후 V(선택도구)로 자동 복귀 + 방금 그린 것 선택됨
- hitTest: 실제 도형 모양 기준 (DESIGN 5-1), 빈 도형 = transparent fill로 클릭 가능 (DESIGN 5-3)
- 줌: Ctrl+휠 (커서 앵커), 팬: Space+드래그 / 중간버튼 / 휠(수직) / Shift+휠(수평)
- **삼각형 flipX**: 오른쪽 드래그=직각좌하, 왼쪽 드래그=직각우하. 스키마에 `flipX: boolean` 필드 있음.
  - flipY는 나중에 추가 예정 (비용 낮음, 같은 패턴)

### Phase 1C-a — 이동 + Undo/Redo (transform.js)
- V 선택 상태에서 선택된 도형 바디 드래그 → 이동
- 2단계 방식: 클릭=선택, 선택된 것을 다시 눌러야 드래그 시작 (tools.js 충돌 회피)
- 전체 스냅샷 Undo (structuredClone 대신 JSON 왕복). undoStack/redoStack in state.
- Ctrl+Z=undo, Ctrl+Shift+Z=redo, Ctrl+Y=redo
- 빈 클릭은 undoStack에 안 쌓임 (이동 threshold 0.01 world unit)

### Phase 1C-b — 핸들 렌더 + 크기조절 + 끝점 핸들
- **핸들**: 고정 7px (world = 7/zoom), 흰 채움 + 파란 테두리. render.js의 renderHandles()
- **갈래 A 크기조절**: 8방향 핸들 (nw/n/ne/e/se/s/sw/w). Shift=비율 고정
  - 비율고정: 핸들 종류로 기준 축 고정 (e/w=w기준, n/s=h기준, 코너=w기준). 매 프레임 비교 안 함 → 튀는 버그 없음
  - MIN_SIZE = 0.3 world unit 클램프
- **갈래 B 끝점 핸들**: line=p0·p1, polyline/curve=p{i} 핸들로 끝점 이동
- **text**: 핸들 없음 (fontSize는 나중에 인스펙터에서)
- 크기조절·끝점이동 모두 Ctrl+Z로 되돌아감
- **핸들 히트 감지 버그 수정**: tools.js mousedown 맨 앞에 `if (e.target.dataset.handle) return` 가드 추가 → 도형 바깥 핸들(타원 모서리 등)도 정상 작동

---

## 4. 아직 안 한 것 (다음 순서)

### 4-1. 1C-c — 회전 (다음 단계)
- 회전 핸들: 선택 bbox 위쪽 중앙에서 일정 거리 위, 원형 아이콘
- 드래그 시 도형 중심 기준 회전, Ctrl=15도 스냅 (DESIGN 4-1)
- 갈래 A만 해당 (rect/ellipse/triangle). 갈래 B(line 등)는 회전 없음 (끝점 이동으로 대체)
- rotation 필드는 이미 스키마에 있고 renderObject에서 transform="rotate(...)"로 반영 중

### 4-2. 나머지 편집 단축키
- Delete: 선택 개체 삭제
- 화살표키: 선택 개체 1단위 이동 (미세조정)
- Ctrl+C / Ctrl+V: 복사·붙여넣기 (붙여넣기는 마우스 커서 위치에 생성)

### 4-3. Phase 2 — 레이어 & 인스펙터
- 레이어 3개 고정 (활성 전환·비활성 투명), 레이어 내 z순서 (PageUp/Down)
- 인스펙터: 선 굵기·명도·채우기, 크기·회전, 개체 보호
  - **선 굵기 두 곳**: 기본값(설정, 새 도형용) + 오브젝트별(인스펙터, 이미 그린 것)
  - 지금 DEFAULT_STROKE_WIDTH 상수가 tools.js에 있음 → Phase 2에서 state.defaultStrokeWidth로 이관 예정
- 색 선택기 (무채색 1D: 그라데이션 바 + 팔레트 + 슬라이더)

### 4-4. 이후
- Phase 3: 그룹·물리 템플릿 (광학부터)
- Phase 4: 저장·내보내기·미리보기
- Phase 5: AI 연동 (Claude API)

---

## 5. 스키마 현황 (data-as-truth 진실)

```js
// 공통
{ id, type, rotation, strokeLevel, strokeWidth, fillLevel, fillNone, layerId, order }

// 갈래 A (rect / ellipse)
{ ...공통, x, y, w, h }

// 갈래 A (triangle)
{ ...공통, x, y, w, h, flipX: boolean }   // flipY는 나중에 추가

// 갈래 B (line)
{ ...공통, p1:{x,y}, p2:{x,y} }

// 갈래 B (polyline / curve)
{ ...공통, points:[{x,y}...] }

// text
{ ...공통, x, y, fontSize, text }

// state 최상위
{ objects:[], viewBox:{x,y,w,h}, activeTool, selectedId, draft,
  undoStack:[], redoStack:[] }
```

---

## 6. 맥락 복원 방법 (다음 대화 시작 시)

1. **이 문서(HANDOFF.md) + DESIGN.md 첨부**하고 시작
2. 현재 코드가 필요한 경우 `tools.js`, `render.js`, `transform.js` 추가 첨부
3. 첫 메시지 예시:
   > "PhysicsExamDrawer Web v0.6.0에서 이어서 합니다. HANDOFF.md와 DESIGN.md 첨부했어. 다음 단계는 1C-c(회전)입니다."

---

## 7. 작업 원칙 (CLAUDE.md 요약)

- **역할 분리**: Claude(웹)=기획·설계·리뷰만. 파일 생성·코드 작성=Claude Code에서만.
- **프롬프트 형식**: 한국어 요약 + 영어 실행 + 마지막에 "Do not ask clarifying questions. Make reasonable assumptions and proceed."
- **Claude Code 실행**: `claude --dangerously-skip-permissions`, 작업 전 `/clear`
- **버전 규칙**: `vX.0.0`=구조변경, `v0.X.0`=기능추가, `v0.0.X`=버그픽스. UI 하단에 표기.
- **import 버전 문자열**: `?v=숫자` 모든 import에 일괄. 버전 올릴 때 전부 바꿀 것.
- **커밋**: Conventional Commits (feat/fix/chore/docs/style). 작업 완료 후 push.
- **파일 수정 원칙**: 타깃만 수정, 광범위한 리팩토링 금지. 한 파일이 비대해지면 분리 제안.
- **되돌리기 비싼 결정** (변경 금지): 상태 모델, 좌표계, 데이터 스키마, 히트테스트 방식
- **되돌리기 싼 결정** (구현하며 조정 가능): 단축키 글자, 픽셀 간격, 기본값 상수

---

## 8. GitHub

- 레포: `seungyeon980808-pixel / phy_draw`
- URL: `https://github.com/seungyeon980808-pixel/phy_draw.git`
- 브랜치: main, GitHub Pages 배포 기준
