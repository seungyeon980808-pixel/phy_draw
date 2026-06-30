함초롬바탕 (HamchoromBatang) — 자체 호스팅 기본 글꼴
=====================================================

이 폴더에 아래 파일을 넣어주세요:

    fonts/HamchoromBatang.woff2

요구 사항
---------
- 파일명: HamchoromBatang.woff2  (대소문자 정확히)
- 형식: WOFF2 (웹 임베딩용 압축 폰트)
- 글리프: 한글 + 라틴(영문) 모두 포함하는 정자(바탕/명조) 버전

이 파일만 넣으면 별도 코드 수정 없이 즉시 적용됩니다.
- 화면(캔버스)의 모든 텍스트·라벨이 함초롬바탕으로 렌더링됩니다.
  (@font-face는 css/style.css 에 이미 등록되어 있습니다.)
- SVG / PNG 내보내기 시 이 woff2가 base64로 SVG 안에 그대로 임베드되어,
  다른 컴퓨터에서 열거나 PNG로 래스터화해도 함초롬바탕으로 보입니다.
  (svg-export.js 의 loadEmbeddedFontCss() 가 export 시점에 이 파일을 읽어 임베드)

파일이 없을 때 동작
-------------------
woff2가 없으면 글꼴 체인 "HamchoromBatang", serif 의 fallback(serif)으로
표시되며 오류는 발생하지 않습니다. 파일을 넣는 순간 자동 반영됩니다.

라이선스
--------
함초롬바탕(함초롬체)은 상업적 사용 및 웹 임베딩이 허용된 무료 글꼴입니다.
배포본에 동봉된 라이선스 고지를 함께 보관하세요.

TTF만 가지고 있다면 woff2로 변환해서 넣으면 됩니다 (예시):
    pip install fonttools brotli
    fonttools ttLib.woff2 compress -o HamchoromBatang.woff2 HamchoromBatang.ttf
