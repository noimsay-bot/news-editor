# 진행 상황 (PROGRESS)

기준: `DEVELOPMENT_SPEC.md` §8. 마지막 갱신 2026-10-16.

## M0. 저장소 조사·실행 가능 골격
- [x] 기존 코드/환경/라이선스/Git 상태 조사, 설계 결정 문서 작성 → `docs/DECISIONS.md`
  - 환경: Windows 11, Node v24.22, FFmpeg/ffprobe n9.0.2(Shotcut 26.9.27 동봉), Python 없음, GPU GeForce GT 750M + Intel HD 4600(최신 GPU 프레임워크 불가 → CPU 경로)
- [~] 기본 앱 GUI + CLI + `engine` 패키지와 test runner
  - [x] `engine/` (GUI 독립), `cli/restoration-cli.mjs` (inspect/new/validate/render/self-test, 종료 코드 0/2/3/4/5/130), `npm test`(node:test)
  - [ ] 기존 웹 GUI(`app/`)에서 engine 호출(메타데이터 패널·프로젝트 저장/열기·A/B) — **미구현, 다음 작업**
  - [ ] CI 구성(로컬 `npm test`만 있음)
- [x] ffmpeg/ffprobe 탐지(NRS_FFMPEG/NRS_FFPROBE → Shotcut → PATH), 메타데이터(분수 FPS, VFR, 필드 순서, 픽셀 형식·비트 심도, 색공간·HDR 감지, 타임코드, 오디오 채널)
- [x] 원본 SHA-256, 프로젝트 JSON(schema v1) 저장·재열기, 누락/변경 감지, bypass 렌더(PCM 동일)
- [x] 최소 샘플 실행 명령 문서화 → `docs/TEST_REPORT.md`

## M1. 오디오 복구 MVP
- [x] PCM 기반 입력(원본 채널·샘플레이트 보존), 하이패스/노치/EQ/잡음 프로파일/스펙트럼 감쇠
- [x] strength, wet/dry, bypass, 구간별 바이패스, 제거된 성분 출력, 파형 요약 함수(`waveformPeaks`)
- [x] 영상/오디오 동기(지연 5샘플)·무음·클리핑 경고 테스트
- [x] 결과 WAV와 영상 재결합 렌더(영상 스트림 복사, 프레임 수·패킷 동일)
- [ ] GUI(파형·스펙트로그램 비교, A/B 순간 전환, 키프레임 자동화) — 엔진 함수만 있음
- [ ] 구간별 강도 키프레임(현재는 구간 바이패스만)
- [ ] 긴 파일 청크 처리(현재 전체를 메모리에 올림: 10분 스테레오 약 230MB)

## M2 ~ M5
- [ ] M2 인물 노출(수동 마스크) — 프로젝트 스키마에 `masked_exposure`/`masks` 자리만 있음, 렌더 시 켜면 NOT_IMPLEMENTED
- [ ] M3 영상 노이즈·영역별 WB
- [ ] M4 컷편집·사용자 정의 MPEG-2 프리셋·ffprobe 검증 보고
- [ ] M5 포장

## 기존 앱(`app/`, 이전 세션)과의 관계
- 기존 앱은 P2/다중 카메라 불러오기·자동 분석·Shotcut 타임라인·XDCAM 출력을 이미 한다. 명세 P0에 맞춰 **자동 보정 4종 기본 OFF, DeepFilterNet 연구용·기본 비활성, 출력 프리셋 "송출 규격 미확정" 표시**로 바꿨다(D-003~D-005).
- 기존 앱의 HDR 역광 보정·자동 WB는 명세 M2/M3의 "수동 마스크·사용자 승인" 요구를 아직 만족하지 않는다(자동 분석 기반). M2/M3 구현 시 엔진으로 옮기고 수동 제어를 추가해야 한다.

## 알려진 제약·위험
- 노치 고조파(120/180Hz…)는 남성 목소리 기본음과 겹쳐 음성 성분을 깎는다 → 기본 0, 사용 시 경고(NOTCH_SPEECH_OVERLAP)
- 스펙트럼 감쇠는 잔향을 줄이지 않는다(잔향 억제 미구현)
- 실제 수신·송출 시스템 인제스트는 미검증
