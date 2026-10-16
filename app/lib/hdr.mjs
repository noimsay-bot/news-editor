// HDR식 구역 노출 보정 (역광 인물용).
// DaVinci Resolve 매뉴얼 132장 "HDR Palette"에 설명된 동작을 독자적으로 구현한 것이다(바이너리 분석 없음).
//  - 밝기를 18% 회색 기준 '스톱'으로 보고, 구역(Shadow)의 노출만 스톱 단위로 올린다.
//  - 구역 경계(pivot)에서 falloff만큼 부드럽게 섞어 밝은 구역(배경)은 그대로 둔다.
//  - 선형광에서 RGB를 같은 비율로 곱해 색도(채도)를 유지한다.
//  - 가장 어두운 부분(Black Offset 근처)은 들어 올리지 않아 노이즈가 뜨지 않게 한다.
// 결과는 3D LUT(.cube)로 만들어 Shotcut의 '3D LUT' 필터로 적용한다(필터 패널에서 켜고 끌 수 있음).
import fs from 'node:fs';
import path from 'node:path';

const GAMMA = 2.4; // BT.1886 표시 감마 근사
const MID_GRAY = 0.18;
const toLin = (v) => Math.pow(Math.max(0, v), GAMMA);
const toDisp = (v) => Math.pow(Math.max(0, Math.min(1, v)), 1 / GAMMA);
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const stopsOf = (displayValue8bit) => Math.log2(Math.max(1e-6, toLin(displayValue8bit / 255)) / MID_GRAY);

// 분석값(얼굴/배경 밝기, 8bit)으로 구역 파라미터를 정한다.
export function zoneParams(faceLuma, bgLuma, strength = 1) {
  const sFace = stopsOf(faceLuma);
  const sBg = stopsOf(bgLuma);
  const pivot = sFace + 0.6 * (sBg - sFace); // 이 위(배경 쪽)는 거의 건드리지 않음
  const falloff = Math.max(0.5, (pivot - sFace) * 0.9); // 얼굴 밝기에서 보정이 거의 100%가 되도록
  // 얼굴을 배경보다 1스톱 아래까지 끌어올리되 최대 2스톱 (노이즈 한계)
  const exposure = Math.max(0, Math.min(2.0, sBg - 1.0 - sFace)) * strength;
  return { exposureStops: exposure, pivotStops: pivot, falloffStops: falloff, faceStops: sFace, bgStops: sBg };
}

// 한 화소 변환 (0~1 표시값)
export function zoneTransform([r, g, b], p) {
  const lin = [toLin(r), toLin(g), toLin(b)];
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  if (y <= 1e-7 || p.exposureStops <= 0) return [r, g, b];
  const s = Math.log2(y / MID_GRAY);
  let w = 1 - smooth(p.pivotStops - p.falloffStops, p.pivotStops, s); // Shadow 구역 가중치
  w *= smooth(-9, -6.5, s); // Black Offset 근처 보호
  let gain = Math.pow(2, p.exposureStops * w);
  const peak = Math.max(...lin) * gain;
  if (peak > 1) gain /= peak; // 색상 유지한 채 클리핑 방지
  return lin.map((c) => toDisp(c * gain));
}

export function writeZoneCube(file, p, size = 33) {
  const lines = [
    '# news-editor HDR zone exposure (shadow lift, saturation preserving)',
    `# exposure ${p.exposureStops.toFixed(3)} stops, pivot ${p.pivotStops.toFixed(3)}, falloff ${p.falloffStops.toFixed(3)}`,
    'TITLE "News Editor HDR Zone"',
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0 0 0',
    'DOMAIN_MAX 1 1 1',
  ];
  // .cube 순서: R이 가장 빨리 변함
  for (let bi = 0; bi < size; bi++)
    for (let gi = 0; gi < size; gi++)
      for (let ri = 0; ri < size; ri++) {
        const o = zoneTransform([ri / (size - 1), gi / (size - 1), bi / (size - 1)], p);
        lines.push(o.map((v) => v.toFixed(6)).join(' '));
      }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
