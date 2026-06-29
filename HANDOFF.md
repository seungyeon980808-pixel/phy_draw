**버전 문자열**: 모든 import에 `?v=` 붙임. 파일 수정 시 반드시 일괄 변경. 현재 전부 `0.16.0`.
**버전 주의**: 과거 Claude Code가 버전을 임의로 과하게 올려 0.44.1·1.1.0·1.2.0까지 튄 적 있음 → 0.14.0으로 강제 교정함. **앞으로 버전 숫자는 프롬프트에서 직접 지정**(Claude Code 판단에 맡기지 않음).

---

## 3. 완료된 기능

### Phase 1 — 기본 캔버스 엔진 (완료)
- SVG+viewBox, store, data-as-truth 토대
- 도형 7종: 직선(L)·꺾은선(P)·사각형(S)·타원(O)·직각삼각형(Y)·곡선(C)·텍스트(T)
- 줌·팬, 선택(V)·이동·Undo/Redo, 크기조절(8핸들·Shift비율), 회전(R·Ctrl 15도 스냅)
- 히트테스트 실제 모양 기준, 빈 도형 transparent fill 클릭, 고정 핸들(10/zoom)

### Phase 2 — 인스펙터 & 레이어 (완료)
- 색 선택기(무채색 1D), 선 명도·굵기·채우기, 크기·위치 수치 입력
- 개체 보호(K), 레이어 3개 고정(활성 전환·비활성 투명)

### 선 계열·fill 시스템 (완료)
- 화살표(none/end/both/center), 점선(프리셋+간격·길이)
- 채우기 패턴 3종(도트·엑스·헤칭), 닫힌 polyline 채우기(closed=true→polygon)

### 그룹 (완료)
- G 묶기(초록)·Shift+G 풀기, 전체 선택·함께 변형(비율고정), 더블클릭 지목(주황)

### 닫힌 곡선 (v0.12.x, 완료)
- curve closed 토글, <path>(Q/C) 렌더+채우기, 곡선 내부 히트테스트(폴리곤 근사)

### ★ 오브젝트 레지스트리 통합 (v0.13.x, 완료) — 구조 변경
- **이전엔 진실의 출처가 셋으로 갈려 있었음**: templates.js(좌표축·각도호 2개만) + index.html 하드코딩 CIRCUIT 10개 + 하드코딩 OPTICS 13개.
- **templates.js TEMPLATES 레지스트리로 일원화.** 각 항목: `label` · `category` · `keywords` · `kind`(atomic/shape) · `create`(기존 생성경로 참조).
- 좌측 패널 버튼을 레지스트리 순회로 생성. 재분류 완료(공통/회로/광학/역학).
- **다중선택 버그 수정**: syncButtons가 data-tool만 비교 → 같은 도구 공유 버튼이 전부 하이라이트되던 문제. 개체 고유 id 기준으로 변경해 하나만 켜지게.

### ★ 아이콘 버튼 (v0.13.x, 완료)
- 좌측 패널 버튼을 글자→미니 SVG 아이콘으로. **개체의 기존 렌더 함수를 축소 재사용**(별도 아이콘 안 그림). 호버 시 이름 툴팁. 격자 배열.
- **[나중에 잡을 것] 아이콘 시인성 개선 + 회로에서 도선 아이콘 제거** — 미완료, 디테일 묶음.

### ★ 검색 (v0.13.x, 완료)
- Ctrl+F(브라우저 기본 찾기 차단) → 검색 모달. label+keywords 매칭.
- 결과 = 미니 아이콘+이름+배지(즉시/드래그), 카테고리별 묶음. 더블클릭/Enter 생성.
- 생성 규칙 레지스트리 따름: atomic=즉시, shape=도구 장전 후 드래그. 별도 모듈 `search.js`.

### ★ 좌표축 완성 (v0.14.0, 완료)
- `axisVariant` 3종: cross(십자)·quadrant(L자)·single(직선). 인스펙터 전환.
- 화살표 1.5배(좌표축만, 공용 makeArrowHead 안 건드림).
- labelX/labelY 텍스트 편집, tickSpacing 눈금 간격 — 인스펙터 전용 섹션(좌표축 단일선택 시만).
- **[나중에 잡을 것] 좌표축 세부 디테일** — 미완료, 디테일 묶음.

---

## 4. 오브젝트 레지스트리 현황 (templates.js, 총 25개)

| category | symbolId · label |
|---|---|
| **공통** (2) | axes 좌표축 · anglearc 각도 호 |
| **회로** (10) | resistor 저항 · dc_source 전지 · ac_source 교류전원 · capacitor 축전기 · inductor 코일 · unknown 미지소자 · diode 다이오드 · lamp 전구 · ammeter 전류계 · voltmeter 전압계 |
| **광학** (8) | convex_lens 볼록렌즈 · concave_lens 오목렌즈 · convex_mirror 볼록거울 · concave_mirror 오목거울 · plane_mirror 평면거울 · object_arrow 물체 · screen 스크린 · point_light 점광원 |
| **역학** (5) | pulley 도르래 · support_tri 받침대 · pivot 회전축 · node 마디 · bar_magnet 막대자석 |

- `axes`만 atomic(즉시 생성), 나머지 24개는 shape(도구 장전 후 캔버스 드래그).

---

## 5. 스키마 현황 (data-as-truth 진실)

```js
// 공통
{ id, type, rotation, strokeLevel, strokeWidth,
  fillLevel, fillNone, locked, layerId, order, groupId }

// 갈래 A (rect/ellipse): { ...공통, x, y, w, h, fillStyle }
// 갈래 A (triangle):     { ...공통, x, y, w, h, flipX, flipY, fillStyle }
// 갈래 B (line):    { ...공통, p1, p2, arrowHead, dashLength, dashGap }
// 갈래 B (polyline):{ ...공통, points[], arrowHead, dashLength, dashGap, closed, fillStyle }
// 갈래 B (curve):   { ...공통, points[], dashLength, dashGap, closed }
// text: { ...공통, x, y, fontSize, text }

// 좌표축 (axes): { ...공통, axisVariant("cross"|"quadrant"|"single"),
//                  labelX, labelY, tickSpacing }
```

---

## 6. 단축키 현황

| 키 | 동작 |
|---|---|
| V/L/P/S/O/Y/C/T | 선택/직선/꺾은선/사각형/타원/삼각형/곡선/텍스트 |
| R | 회전 도구 |
| K | 개체 보호 토글 |
| G / Shift+G | 그룹 묶기 / 풀기 |
| Ctrl+F | 오브젝트 검색 모달 |
| Delete | 삭제 |
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | Undo / Redo |
| Ctrl+C / Ctrl+V | 복사 / 붙여넣기(커서 위치) |
| 화살표키 | nudge(0.5 / Ctrl=5) |
| PageUp/Down | z순서 한 칸 |
| Ctrl(회전 중) | 15도 스냅 |
| Shift(크기조절) | 비율고정 / (선) 15도 스냅 |
| 더블클릭(그룹 내) | 개체 지목 |
| 더블클릭/Enter(P 그리는 중) | 꺾은선 종료 |

---

## 7. 가이드라인 색상

| 상태 | 색상 |
|---|---|
| 일반 선택 | 파란 #0969da |
| 개체 보호 | 빨강 #e53e3e |
| 그룹 묶음 | 초록 #2f9e44 |
| 그룹 내 지목 | 주황 #e67700 |

---

## 8. 다음 작업 순서 (후보)

### 곧 — 물리 도형 외형 다듬기 (도메인별)
세 도메인이 남음. **각 도메인은 개체가 이미 레지스트리에 등록돼 있고, "외형을 원본답게 다듬는" 작업.** 되돌리기 싼 결정이라 번호 매겨 묶음으로 던지고 1:1 대조.

- **광학 (가장 깨끗 — 먼저 권장)**: 렌즈·거울·물체·스크린·점광원·중심축. 추가 설계 결정 적음.
- **회로 (설계 결정 선행 필요)**:
  - 전류계/전압계 표준 기호 형태 확정 필요(원 안에 Ⓐ/Ⓥ. "영어 밑 바"는 비표준일 가능성). "인터넷 참고" 지시는 Claude Code 불가 → 설계자가 형태 확정해 프롬프트에 박아야 함.
  - 자동텍스트 기본값·편집 방식·위치 정의 필요(전기소자·박스물체·원형물체 공유 인프라).
  - **[나중에 잡을 것] 회로에서 도선 아이콘 제거** 포함.
- **역학 (설계 결정 선행 필요)**:
  - **도선 참고 이미지 미확보**(이전 자료에서 도선=8번 사진이 우주인 그림이라 안 맞았음). "선 두 개 사이 색이 든 형태" 실제 참고 필요.
  - 자동텍스트 공유 인프라(회로와 동일).
  - 무거운 일러스트(우주선·우주인·궤도 템플릿)는 후순위 별도 배치.

### 디테일 묶음 (나중에 한꺼번에)
- 아이콘 시인성 개선
- 회로에서 도선 아이콘 제거
- 좌표축 세부 디테일

### 그다음 — Phase 4 저장·내보내기·미리보기
- JSON 저장/불러오기(project-io.js 존재), PNG(300dpi)·SVG·JPG·PDF 내보내기
- 100mm 아트보드 출력, 미리보기 모달(샘플 문제 틀 합성, DESIGN 8-4)

### 그다음 — Phase 5 AI 연동
- Claude API 채팅(토글), SVG 생성 → 데이터 정규화 삽입

---

## 9. 미래 — 과목 확장 구상 (물리 완성 후, 되돌리기 비쌈)

선생님이 화학·생명·지구과학 버전도 계획 중. 방향 정리됨(아직 착수 안 함):

- **엔진/오브젝트 분리**: 엔진(store·viewport·tools·transform 등)은 공유, 오브젝트 정의만 과목별 파일로(`js/objects/physics.js`, `chemistry.js` …). 지금 레지스트리 구조라 깨끗하게 가능.
- **오브젝트 두 종류 구분**:
  - **코드 렌더형** — 렌즈처럼 곡선·수식 필요. 렌더 함수(JS)가 본체. JSON만으론 추가 불가.
  - **JSON 조립형** — 선·사각형·원·텍스트 부품 조합으로 충분한 것. **범용 조립 렌더러**를 만들면 코드 없이 JSON 한 덩어리로 추가 가능.
- **순서**: 물리 완성 → "어떤 게 코드형·조립형인지" 패턴 파악된 뒤 → 조립 렌더러 설계(미리 만들면 추측이 됨).
- 자유곡선까지 JSON화는 먼 미래(무거움).

---

## 10. 결정만 됨 / 구현 대기

- **위치 고정 (positionLocked)** — 개념 확정, 미구현. locked와 별개(이동·회전 잠금, 인스펙터 수치 입력은 허용).
- **직교 격자** — DESIGN 8-3 사양(10mm + 50mm 숫자 + 진하기 + 저장 제외). 미구현.

---

## 11. 작업 원칙 (CLAUDE.md 요약)

- **역할 분리**: Claude(웹)=기획·설계·리뷰. 파일 생성·코드=Claude Code에서만.
- **프롬프트**: 한국어 요약 + 영어 실행 + 끝에 "Do not ask clarifying questions. Make reasonable assumptions and proceed." 펜스(```)로 감쌈(복사용).
- **줄 범위 지정**: 파일 전체 읽기 금지, 필요한 줄/섹션만.
- **버전**: 정식 출시 전 메이저 0 고정. 기능=마이너, 버그=패치. **프롬프트에서 숫자 직접 지정**(임의 상승 방지). UI 푸터 + 모든 `?v=` 통일.
- **커밋**: Conventional Commits(feat/fix/chore/docs/style), 버전은 끝에 괄호 `(v0.XX.0)`. 완료 후 push.
- **태그**: 의미 있는 완성 시점에 `vX.X.X` 태그 → GitHub Releases. (아직 첫 태그 안 찍음. v0.14.0이 첫 후보.)
- **배치 원칙**: 외형 수정 등 싼 작업은 번호 매겨 묶음으로. 구조 변경은 단독. 두 번 실패하면 진단 모드 전환.
- **되돌리기 비싼 결정**(변경 금지): 상태 모델, 좌표계, 데이터 스키마, 히트테스트 방식, 스냅 기준, 그룹 비율고정.

---

## 12. GitHub

- 레포: `seungyeon980808-pixel / phy_draw`
- URL: `https://github.com/seungyeon980808-pixel/phy_draw.git`
- 브랜치: main, GitHub Pages 배포 기준
- 아직 버전 태그 없음 → **v0.14.0이 첫 태그 후보**.

---

## 13. 알려진 문제 / 보류 (known issues / deferred)

- Line endpoint → straight-edge (e.g. rectangle top face) snap does not engage in real click-select-drag use; endpoint should stick anywhere ALONG the edge (not only at corners). Deferred for later.