# 뉴스 원본 편집기

JTBC 영상취재 원본(P2·스마트폰·고프로·오스모·드론)을 빠르게 정리하고 최대한 복구해 JTBC 인제스트 규격(XDCAM HD422 MPEG-2 50M MXF)으로 출력하는 도구.
편집·출력 엔진은 설치된 Shotcut(MLT/FFmpeg)을 그대로 쓰고, 이 저장소는 그 위의 보조 프로그램(Node.js, 외부 의존성 없음)이다.

## 복구 엔진·CLI (DEVELOPMENT_SPEC 기준, 비생성형)
```
npm test                                         # 자동 테스트 (합성 fixture)
node cli/restoration-cli.mjs inspect INPUT       # 미디어 정보 JSON
node cli/restoration-cli.mjs new INPUT --project P.json
node cli/restoration-cli.mjs validate P.json
node cli/restoration-cli.mjs render P.json --output OUT.wav --report R.json [--removed REMOVED.wav]
node cli/restoration-cli.mjs self-test
```
명세: `DEVELOPMENT_SPEC.md`, `AGENTS.md`, `CLAUDE.md` / 진행: `docs/PROGRESS.md` / 결정: `docs/DECISIONS.md` / 시험: `docs/TEST_REPORT.md`

## 준비
1. Shotcut 설치 (`C:\Program Files\Shotcut`)
2. Node.js
3. 음성 복구 도구: `powershell -ExecutionPolicy Bypass -File tools\get-deep-filter.ps1`

## 실행
`뉴스 원본 편집기.bat` → 브라우저에서 `http://localhost:4310`

## 구성
| 경로 | 내용 |
|---|---|
| `app/server.mjs` | 로컬 서버 (API, 분석·음성 복구 작업 대기열, Shotcut 실행) |
| `app/public/index.html` | 화면 |
| `app/lib/library.mjs` | P2 + 일반 카메라 파일을 공통 샷 구조로 |
| `app/lib/p2.mjs` | P2 CONTENTS 파싱, 연결 클립 묶기 |
| `app/lib/analyzer.mjs` | 싱크/스케치, 흔들림, WB, 역광 분석 |
| `app/lib/voice.mjs` | DeepFilterNet3 음성 복구 |
| `app/lib/hdr.mjs` | HDR식 구역 노출 3D LUT |
| `app/lib/shotxml.mjs`, `project.mjs` | 샷·타임라인 MLT 생성, XDCAM 출력 |
| `tools/` | 비교 시험 스크립트, 도구 다운로드 |
| `research/` | DaVinci Resolve HDR·Voice Isolation 분석 요약(매뉴얼 기준) |
| `shotcut-patch/` | Shotcut 소스 직접 수정(C++) 버전 — 회사 백신 때문에 빌드 보류. `BASE_COMMIT.txt`의 커밋에 `git apply` |

자세한 사용법은 `사용설명서.md`, 개발 이력·설계는 `인수인계서.md`, `분석_및_개발계획.md`.
