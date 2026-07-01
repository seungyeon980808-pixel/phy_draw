# 픽스처 기대 모습 (label_text_export_fixture.json)

`label_text_export_fixture.json`을 불러왔을 때 캔버스가 어떻게 보여야 하는지 정리한다.
아트보드는 **90×60 mm**, 원점 중심이며 좌표는 `x ∈ [-45,45]`, `y ∈ [-30,30]`(y는 아래로 증가).

## 전체 배치 개요 (개념도)

```
좌상단                          상단                         우상단
[일반텍스트 돋움]                                       [㉠ 라벨러] ← 지시선
[v=at Times italic]                          [도르래/(질량무시) 라벨러] ← 지시선
[물체명 신명중명조]                                  [물체 A] (라벨 above)
                                                     ┌────────┐
[타원 "도르래"]      [θ 호]   [α 호]                 │ 사각형 │
                                                     └────────┘
[Ⅰ~Ⅳ / ㉠~㉤ 라벨러]                       [F] (회전 25° 사각형, 라벨 above)
                              [───── ℓ ─────] (라벨 달린 선)
```

## 객체별 기대 (id 기준)

| id | 종류 | 텍스트/라벨 | 기대 글꼴·스타일 | 기대 모습 |
|----|------|-------------|------------------|-----------|
| `fx_text_normal` | text | 일반 텍스트 (돋움 normal) | 돋움 계열, normal | 좌상단, 똑바른 고딕체 |
| `fx_text_quantity` | text | v = at (물리량 Times italic) | Times New Roman, italic | 기울어진 세리프체 |
| `fx_text_objectlabel` | text | 물체명 라벨 (신명중명조 normal) | 신명중명조/바탕 명조, normal | 명조체 normal |
| `fx_labeler_single` | labeler | ㉠ | 돋움 normal | 지시선 끝 한 글자, 지시선이 글자에 안 겹침 |
| `fx_labeler_multiline` | labeler | 도르래 / (질량 무시) | 돋움 normal | 2줄 중앙정렬, 지시선이 블록 가장자리에서 멈춤 |
| `fx_labeler_mixed` | labeler | Ⅰ Ⅱ Ⅲ Ⅳ / ㉠ ㉡ ㉢ ㉣ ㉤ | 돋움 normal | 로마숫자·원문자 2줄, 깨짐 없음 |
| `fx_anglearc_theta` | anglearc | θ | quantity → Times italic | 호 + θ, 시작각 0°, 벌림 60° |
| `fx_anglearc_custom` | anglearc | α | quantity → Times italic | 호 + α, 시작각 20°, 벌림 70° |
| `fx_line_label` | line | ℓ | quantity → Times italic | 수평선 위 일정 간격으로 ℓ |
| `fx_rect_objectlabel` | rect | 물체 A | label → 명조 normal | 사각형 위(above)에 라벨 |
| `fx_rect_rotated_quantity` | rect | F | **사각형 라벨은 항상 명조 normal 강제** (labelType=quantity여도 이탤릭 아님) | 25° 회전 사각형, 글자 F는 upright·명조 normal |
| `fx_ellipse_label` | ellipse | 도르래 | label → 명조 normal | 외곽선 타원(채움 없음), 아래(below)에 라벨 |

## 글꼴 정책 핵심 (체크리스트 C와 대응)

- **일반 텍스트·라벨러** → 돋움 계열 **normal**.
- **물리량/수식 (`labelType: "quantity"`, 각도호, 선 라벨, v=at)** → **Times New Roman italic**.
- **오브젝트 일반 라벨 (`labelType: "label"`, 물체 A·도르래·물체명)** → **신명중명조/명조 normal**.
- **사각형(rect) 내부 라벨 (A·B·C·F …)** → labelType과 무관하게 **항상 신명중명조 명조 normal**로 강제.
  A·B·C가 서로 다른 스타일(이탤릭 등)로 갈리지 않도록 font-style을 normal로 명시한다.
- **로마 숫자 (I·II·III, Ⅰ·Ⅱ·Ⅲ)** → 어떤 글꼴 맥락이든 **세리프(명조) 정체 런**으로 렌더(예: "마찰 구간 I").
- 위 정책이 한 화면에서 서로 다른 글꼴로 분기되어야 하며, export(PNG/SVG)에서도 동일해야 한다.

## 선택영역 export 추천 영역

- **우상단 클러스터**(`fx_labeler_single`, `fx_labeler_multiline`, `fx_rect_objectlabel`, `fx_rect_rotated_quantity`)를
  드래그로 선택해 PNG/SVG로 내보내면 라벨러·라벨·회전 객체가 한 번에 포함된다.
- 줌 인/아웃/pan을 바꿔가며 같은 클러스터를 잘랐을 때 **항상 같은 객체가 잘림 없이** 포함되는지 본다.
- export 결과에 가이드/선택핸들/스냅 표시가 들어가면 Fail.

> 스크린샷은 글꼴·OS 환경에 따라 달라지므로 본 문서에는 포함하지 않는다.
> 캔버스 화면과 export 결과를 직접 비교하는 것을 기준으로 한다.
