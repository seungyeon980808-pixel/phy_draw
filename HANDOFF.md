# 인수인계 문서 — PhysicsExamDrawer Web (HANDOFF.md)

> **다음 대화창에서 이 문서 + DESIGN.md를 함께 첨부하면 맥락이 복원된다.**
> 이 문서는 "지금 어디까지 왔고, 다음에 뭘 할지"를 담는다.
> 설계 결정의 *내용*은 DESIGN.md에 있다. 이 문서는 *진행 상황*만 담는다.

---

## 0. 한 줄 요약

**v0.11.1 — 알려진 버그 없음.** Phase 1·2 완료, fill 시스템(닫힌 polyline + 패턴) 완료.
다음 후보: **곡선 닫기(v0.12.0)** 또는 **Phase 3 물리 템플릿(광학)**.

---

## 1. 이 프로젝트가 무엇인가

- **무엇**: 중학교 과학(물리) 시험 문제용 그림을 그리는 웹 기반 SVG 에디터.
- **왜**: PyQt6 `physics_draw` 프로그램을 웹앱으로 이식. data-as-truth로 아키텍처 개선.
- **사용자**: 서울 대왕중학교 과학교사 본인. JS 학습 중. 코드는 Claude Code가 짜고 설계·리뷰만 직접.
- **범위**: **물리로 좁게 완성**이 현재 목표. 다른 과목은 물리 완성 후(또는 SVG 자산 라이브러리로 대체).

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
- **회전 Ctrl 15도 스냅**: 회전 중 Ctrl(또는 Meta) 누르면 15도 단위로 끊김
- V 도구: Delete 삭제·화살표 nudge(0.5/Ctrl=5)·Ctrl+C/V·PageUp/Down z순서
- 드래그 박스 선택 + Shift+클릭 다중선택, 다중선택 함께 이동
- 히트테스트: 실제 도형 모양 기준 (DESIGN 5-1)
- 빈 도형 클릭 가능: transparent fill (DESIGN 5-3)
- 핸들: 고정 10px (10/zoom), 회전존 28/zoom

### Phase 2 — 인스펙터 & 레이어 (완료)
- 선 명도·굵기 (색 선택기: 그라데이션 바 + 팔레트 + 드래그 핸들 — 무채색 1D)
- 채우기 없음 토글·채우기 명도
- 크기·위치 (X/Y/W/H/회전각) — 갈래 A, Enter/blur 확정 + Undo
- 다중선택 시 공통 섹션만 / 단일선택 시 전체 섹션 / 선택없음 안내
- **개체 보호 (K)**: locked=true 시 빨간 가이드, 이동·회전·크기·삭제·그룹 전부 차단
  (가드는 isMutable() 한 곳으로 공유 — 마우스/키보드/삭제/그룹 모든 경로)
- **레이어 3개 고정 (1/2/3)**: 추가·삭제 없음, 이름변경만
  - 리스트 3→2→1 순(위=앞, "위 행이 앞에 그려집니다")
  - 체크박스 = 가시성 / 행 클릭 = 활성 레이어 / 활성행 파란 막대+배경
  - 레이어 단위 lock 없음(제거됨). 패널은 인스펙터 하단 고정
  - 비활성 레이어 = 클릭 통과 + 살짝 투명

### 선 계열 — 화살표·점선 (완료)
- 화살표(line+polyline): 단일 arrowHead "none"/"end"/"both"/"center"
  - makeArrowHead() 공유, 굵기 연동, 끝선분 retract
- 점선(line/polyline/curve): 프리셋 실선/점선1/2/3 + 간격·길이 조정
- 선 계열은 채우기 섹션 숨김(단, 닫힌 polyline은 예외 — 아래 fill 참조)

### fill 시스템 (완료)
- **채우기 패턴 3종**: 도트 / 엑스 / 헤칭 (+ 기존 solid). fillStyle 필드.
  - 패턴도 fillLevel(명도)을 마크 색으로 사용 — 무채색 유지
  - 패턴 타일에 transparent 베이스 → 빈 곳도 클릭 잡힘 (DESIGN 5-3)
  - 오브젝트별 고유 패턴 id(pat_{id}) → 명도 달라도 충돌 없음
- **닫힌 polyline 채우기**: closed=true → <polygon> 렌더 + 공유 fill
  - "닫기" 토글(polyline 단일선택 시). 닫으면 채우기 섹션 노출
  - **면 상호작용**: 내부 클릭 선택(point-in-polygon), 회전, 비율고정 크기조절
    - 변형은 점 좌표에 직접 굽기(bake) — rotation 필드 없이 점이 항상 월드 진실
    - "갈래 B 저장(점 배열) + 갈래 A 상호작용(면)"
- 채우기 섹션 표시 규칙: rect/ellipse/triangle/닫힌 polyline = 표시,
  line/열린 polyline/curve/text = 숨김

### 그룹 (완료)
- G: 다중선택 → 그룹 묶기(초록 가이드). Shift+G / 인스펙터: 그룹 해제
- 그룹 클릭 → 전체 선택, 함께 이동·회전·비율고정 크기조절
- 그룹 내 더블클릭 지목(주황 가이드, 수정 차단·풀기만) — 동작

---

## 4. 스키마 현황 (data-as-truth 진실)

```js
// 공통
{ id, type, rotation, strokeLevel, strokeWidth,
  fillLevel, fillNone, locked, layerId, order, groupId }

// 갈래 A (rect / ellipse)
{ ...공통, x, y, w, h, fillStyle }

// 갈래 A (triangle)
{ ...공통, x, y, w, h, flipX, flipY, fillStyle }

// 갈래 B (line)
{ ...공통, p1:{x,y}, p2:{x,y}, arrowHead, dashLength, dashGap }

// 갈래 B (polyline)
{ ...공통, points:[{x,y}...], arrowHead, dashLength, dashGap,
  closed, fillStyle }              // closed=true면 면처럼 변형(점에 굽기)

// 갈래 B (curve)
{ ...공통, points:[{x,y}...], dashLength, dashGap }

// text
{ ...공통, x, y, fontSize, text } // fontSize는 world 단위(화면px÷zoom로 저장)

// state 최상위
{ objects:[], viewBox:{x,y,w,h}, activeTool, draft,
  selectedIds:[], targetedId:null,
  layers:[{id,name,visible}],      // 3개 고정, locked 없음
  activeLayerId,
  groups:[{id,memberIds:[]}],
  undoStack:[], redoStack:[] }
```

---

## 5. 단축키 현황

| 키 | 동작 |
|---|---|
| V / L / P / S / O / Y / C / T | 선택 / 직선 / 꺾은선 / 사각형 / 타원 / 삼각형 / 곡선 / 텍스트 |
| R | 회전 도구 |
| K | 개체 보호 토글 (V 도구) |
| G / Shift+G | 그룹 묶기 / 풀기 |
| Delete | 선택 개체 삭제 |
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | Undo / Redo |
| Ctrl+C / Ctrl+V | 복사 / 붙여넣기 (커서 위치) |
| 화살표키 (V) | nudge 이동 (0.5 / Ctrl=5) |
| PageUp/Down (V) | z순서 한 칸 |
| **Ctrl (회전 중)** | **15도 스냅** |
| Shift (크기조절) | 비율고정 / (선 그리기) 15도 스냅 |
| 더블클릭 (그룹 내) | 개체 지목 |
| 더블클릭 / Enter (P 그리는 중) | 꺾은선 종료 |

---

## 6. 가이드라인 색상

| 상태 | 색상 |
|---|---|
| 일반 선택 | 파란색 #0969da |
| 개체 보호(locked) | 빨간색 #e53e3e |
| 그룹 묶음 | 초록색 #2f9e44 |
| 그룹 내 지목 | 주황색 #e67700 |

---

## 7. 다음 작업 순서 (후보)

### 곧 — 곡선 닫기 (v0.12.0)
- curve에 closed 토글 추가. 단 닫는 구간을 **직선 아닌 곡선(부드럽게)** 으로.
- 닫힌 polyline과 달리 <polygon> 아니라 <path>(Q/C 곡선)로 렌더 + 채우기.
- 히트테스트: 곡선 path 내부 판정(곡선 잘게 쪼개 폴리곤 근사 후 point-in-polygon).
- 회전·비율고정(점에 굽기)은 닫힌 polyline 로직 재사용.
- **완성된 닫힌 polyline을 패턴 삼아 옮기는 작업** — 그래서 polyline 먼저 한 것.

### 그다음 — Phase 3 물리 템플릿
- 물리 도형 라이브러리(광학부터: 렌즈·거울 등). 좌측 템플릿 패널 내용물.
- 대칭축 정렬(렌즈를 광축에), 곡선 접점 스냅 정교화.
- 회전 중 각도 표시기(rotation 값을 예각으로, 회전 중에만 표시).
- 동심원 도형(중심+반지름, 극좌표 격자 아님).

### 그다음 — Phase 4 저장·내보내기·미리보기
- JSON 저장/불러오기
- 내보내기: PNG(300dpi)·SVG·**JPG·PDF**
- 100mm 아트보드 출력(경계 밖 제외)
- 미리보기 모달(샘플 문제 틀 합성)

### 그다음 — Phase 5 AI 연동
- Claude API 채팅(토글), SVG 생성 → 데이터 정규화 삽입

---

## 8. 결정만 됨 / 구현 대기

- **위치 고정 (positionLocked)** — 개념 확정, 미구현.
  - 개체 보호(locked)와 별개. 위치 고정 = 이동·회전 잠금, **인스펙터 수치 입력은 허용**.
  - 마우스·키보드 변형 경로는 `locked || positionLocked` 차단, 인스펙터 입력은 `locked`만 차단.
  - 둘 다 켜지면 보호 우선. 가이드 색은 별색(구현 시 정함).
  - **구현 시점**: 개체 보호 가드 손볼 때 같이(transform.js + inspector.js).
- **배경 텍스처(도트/엑스/거친)** — 채우기 패턴이 생겨 대체 가능성. 거친 바닥 = 사각형+헤칭.
  필요하면 그때 "아트보드 배경" 따로 만들지 재판단.
- **직교 격자** — DESIGN 8-3 사양(10mm + 50mm 숫자 + 진하기 + 저장 제외). 미구현.

---

## 9. 미뤄둔 것 (v2+ / 다른 과목)

- **곡선 닫힌 면 채우기** — 곡선 닫기(v0.12.0)에서 다룸. 다른 과목 곡면 채우기는 그 위에.
- **앵커 오브젝트 / 선→면 변환 / 불리언 유니온** — 다른 과목용. SVG 자산 라이브러리로 대체 가능성.
- **컬러 도입** — 기술적으로 열려있음(객체에 strokeColor/fillColor 필드 추가, 없으면 명도 폴백;
  색 선택기 1D→2D 교체). **단 "무채색만"은 이 도구의 정체성(시험지 흑백)이라 상충 —
  도입하려면 "왜 색이 필요한가" 근거부터.** 지금 결정할 일 아님.
- 베지어 자유곡선, 원호 전용 도형, 폰트 선택, 면 채우기 패턴 확장(지구과학 지층 등).
- 격자 스냅 전체 토글, 미리보기 2단 시험지 합성.
- 극좌표 격자 — **폐기**(동심원은 Phase 3 도형으로).
- 우클릭 컨텍스트 메뉴 — **폐기**(인스펙터 고정으로 충분).

---

## 10. 작업 원칙 (CLAUDE.md 요약)

- **역할 분리**: Claude(웹)=기획·설계·리뷰. 파일 생성·코드=Claude Code에서만.
- **프롬프트**: 한국어 요약 + 영어 실행 + 끝에 "Do not ask clarifying questions. Make reasonable assumptions and proceed."
- **Claude Code 실행**: `claude --dangerously-skip-permissions`, 작업 전 `/clear`
  - **작업 완료 알림**: ~/.claude/settings.json의 Stop 훅(Windows MessageBox)
- **버전**: vX.0.0=구조, v0.X.0=기능, v0.0.X=버그픽스. UI 하단 표기. import ?v= 일괄.
- **커밋**: Conventional Commits(feat/fix/chore/docs/style). 완료 후 push.
- **파일 수정**: 타깃만, 광범위 리팩토링 금지. 필요한 줄/섹션만 읽게 지정.
- **되돌리기 비싼 결정**(변경 금지): 상태 모델, 좌표계, 데이터 스키마, 히트테스트 방식, 스냅 기준, 그룹 비율고정.

---

## 11. GitHub

- 레포: `seungyeon980808-pixel / phy_draw`
- URL: `https://github.com/seungyeon980808-pixel/phy_draw.git`
- 브랜치: main, GitHub Pages 배포 기준
