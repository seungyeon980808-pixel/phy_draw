# 인수인계 문서 — PhysicsExamDrawer Web (HANDOFF.md)

> **다음 대화창에서 이 문서 + DESIGN.md를 함께 첨부하면 맥락이 복원된다.**
> 이 문서는 "지금 어디까지 왔고, 다음에 뭘 할지"를 담는다.
> 설계 결정의 *내용*은 DESIGN.md에 있다. 이 문서는 *진행 상황*만 담는다.

---

## 0. 한 줄 요약

**v0.7.1 완료.** Phase 1 완료, Phase 2 인스펙터 완료, 그룹 묶기 + 더블클릭 지목 완료.
다음은 **Phase 2 나머지 — 레이어 3개**.

---

## 1. 이 프로젝트가 무엇인가

- **무엇**: 중학교 과학(물리) 시험 문제용 그림을 그리는 웹 기반 SVG 에디터.
- **왜**: PyQt6 `physics_draw` 프로그램을 웹앱으로 이식. data-as-truth로 아키텍처 개선.
- **사용자**: 서울 대왕중학교 과학교사 본인. JS 학습 중. 코드는 Claude가 짜고 설계·리뷰만 직접.

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

**버전 문자열**: 모든 import에 `?v=` 붙임. 파일 수정 시 반드시 일괄 변경.

---

## 3. 완료된 기능

### Phase 1 — 기본 캔버스 엔진 (완료)
- SVG+viewBox, store, data-as-truth 토대
- 도형 7종: 직선(L)·꺾은선(P)·사각형(S)·타원(O)·직각삼각형(Y)·곡선(C)·텍스트(T)
- 줌·팬 (Ctrl+휠 커서앵커, Space+드래그, 중간버튼, 휠/Shift+휠)
- 선택(V)·이동·Undo/Redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y)
- 크기조절 (핸들 8방향, Shift=비율고정)
- 회전 도구 (R): 코너 핸들 드래그, 피벗=대각 반대 꼭짓점, 저장은 중심기준 정규화
- R 도구: 방향키로 flipX·flipY 토글, PageUp/Down으로 5도씩 회전
- V 도구: Delete 삭제·화살표 nudge(0.5/Ctrl=5)·Ctrl+C/V·PageUp/Down z순서
- 개체 잠금 (K): locked=true 시 빨간 가이드라인, 수정 불가
- 삼각형 flipX·flipY (4방향 조합)
- 드래그 박스 선택 (V 도구에서 빈 캔버스 드래그)
- Shift+클릭 다중선택, 다중선택 상태에서 함께 이동
- 히트테스트: 실제 도형 모양 기준 (DESIGN 5-1)
- 빈 도형 클릭 가능: transparent fill (DESIGN 5-3)
- 핸들: 고정 10px (10/zoom), 회전존 28/zoom

### Phase 2 — 인스펙터 (완료)
- 선 명도·굵기 (색 선택기: 그라데이션 바 + 팔레트 7단계 + 드래그 핸들)
- 채우기 없음 토글·채우기 명도
- 크기·위치 (X/Y/W/H/회전각) — 갈래 A만, Enter/blur 시 확정 + Undo
- 개체 잠금 체크박스
- 다중선택 시 선·채우기 섹션만 표시
- 단일선택 시 전체 섹션 표시
- 선택 없음 시 "선택된 오브젝트 없음" 표시

### 그룹 묶기 (완료)
- G: 다중선택 → 그룹 묶기 (초록 가이드라인) — 동작
- Shift+G / 인스펙터 "개체 풀기": 그룹 전체 해제 — 동작
- 그룹 클릭 → 전체 선택 — 동작
- 그룹 이동·비율고정 크기조절 — 동작
- 더블클릭 지목: 그룹 내 개체 하나 지목 → 주황 가이드라인, 모든 변형 차단 — 동작
  - 빈 공간 클릭·다른 개체 클릭·마퀴 선택 시 지목 해제

---

## 4. 스키마 현황 (data-as-truth 진실)

```js
// 공통
{ id, type, rotation, strokeLevel, strokeWidth,
  fillLevel, fillNone, locked, layerId, order, groupId }

// 갈래 A (rect / ellipse)
{ ...공통, x, y, w, h }

// 갈래 A (triangle)
{ ...공통, x, y, w, h, flipX, flipY }

// 갈래 B (line)
{ ...공통, p1:{x,y}, p2:{x,y} }

// 갈래 B (polyline / curve)
{ ...공통, points:[{x,y}...] }

// text
{ ...공통, x, y, fontSize, text }

// state 최상위
{ objects:[],
  viewBox:{x,y,w,h},
  activeTool,
  draft,
  selectedIds:[],       // 단일/다중 선택 id 배열
  targetedId: null,     // 그룹 내 더블클릭으로 지목된 개체 id
  groups:[{ id, memberIds:[] }],
  undoStack:[],
  redoStack:[] }
```

---

## 5. 단축키 현황

| 키 | 동작 |
|---|---|
| V | 선택 도구 |
| L | 직선 |
| P | 꺾은선 |
| S | 사각형 |
| O | 타원 |
| Y | 직각삼각형 |
| C | 곡선 |
| T | 텍스트 |
| R | 회전 도구 |
| K | 개체 잠금 토글 (V 도구) |
| G | 그룹 묶기 (V 도구, 다중선택 시) |
| Shift+G | 그룹 풀기 |
| Delete | 선택 개체 삭제 |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z / Ctrl+Y | Redo |
| Ctrl+C / Ctrl+V | 복사·붙여넣기 (커서 위치+오프셋) |
| 화살표키 (V 도구) | nudge 이동 (0.5 / Ctrl=5 world unit) |
| 화살표키 (R 도구) | ←→ flipX 토글 / ↑↓ flipY 토글 |
| PageUp/Down (V 도구) | z순서 한 칸 이동 |
| PageUp/Down (R 도구) | 5도씩 회전 |

---

## 6. 가이드라인 색상

| 상태 | 색상 |
|---|---|
| 일반 선택 | 파란색 #0969da |
| 잠금(locked) | 빨간색 #e53e3e |
| 그룹 묶음 | 초록색 #2f9e44 |
| 그룹 내 지목 (더블클릭) | 주황색 #e67700 |

---

## 7. 다음 작업 순서

### 즉시 — Phase 2 나머지: 레이어 3개
   - 고정 3개 레이어 (추가·삭제 없음, 이름변경만)
   - 활성 레이어 전환 (클릭)
   - 비활성 레이어 = 클릭 통과 + 살짝 투명 (opacity 0.5)
   - PageUp/Down: 같은 레이어 안에서만 z순서 이동

2. Phase 3 — 물리 템플릿 (광학부터: 렌즈·거울 등)

3. Phase 4 — 저장·내보내기·미리보기
   - JSON 저장/불러오기
   - PNG(300dpi)·SVG 내보내기
   - 100mm 아트보드 출력
   - 미리보기 모달 (샘플 문제 틀 합성)

4. Phase 5 — AI 연동 (Claude API 채팅, SVG 생성→정규화 삽입)

---

## 8. 맥락 복원 방법 (다음 대화 시작 시)

1. **이 문서(HANDOFF.md) + DESIGN.md 첨부**하고 시작
2. 버그 수정 시 tools.js·transform.js·render.js 추가 첨부
3. 첫 메시지 예시:
   > "PhysicsExamDrawer Web 이어서 합니다. HANDOFF.md와 DESIGN.md 첨부했어.
   > 그룹 내 더블클릭 지목 버그부터 수정합니다."

---

## 9. 작업 원칙 (CLAUDE.md 요약)

- **역할 분리**: Claude(웹) = 기획·설계·리뷰만. 파일 생성·코드 작성 = Claude Code에서만.
- **프롬프트 형식**: 한국어 요약 + 영어 실행 + 마지막에 "Do not ask clarifying questions. Make reasonable assumptions and proceed."
- **Claude Code 실행**: `claude --dangerously-skip-permissions`, 작업 전 `/clear`
- **버전 규칙**: `vX.0.0`=구조변경, `v0.X.0`=기능추가, `v0.0.X`=버그픽스. UI 하단에 표기.
- **import 버전 문자열**: `?v=숫자` 모든 import에 일괄. 버전 올릴 때 전부 바꿀 것.
- **커밋**: Conventional Commits (feat/fix/chore/docs/style). 작업 완료 후 push.
- **파일 수정 원칙**: 타깃만 수정, 광범위한 리팩토링 금지. 필요한 줄/섹션만 읽게 지정.
- **되돌리기 비싼 결정** (변경 금지): 상태 모델, 좌표계, 데이터 스키마, 히트테스트 방식
- **되돌리기 싼 결정** (구현하며 조정 가능): 단축키 글자, 픽셀 간격, 기본값 상수

---

## 10. GitHub

- 레포: `seungyeon980808-pixel / phy_draw`
- URL: `https://github.com/seungyeon980808-pixel/phy_draw.git`
- 브랜치: main, GitHub Pages 배포 기준
