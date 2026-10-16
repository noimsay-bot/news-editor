// 외부 실행 파일과 작업 폴더 위치. 설치된 Shotcut(서명된 공식 배포본)의 엔진을 그대로 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const candidates = [
  process.env.SHOTCUT_DIR,
  'C:/Program Files/Shotcut',
  path.join(os.homedir(), 'AppData/Local/Programs/Shotcut'),
].filter(Boolean);

export const SHOTCUT_DIR = candidates.find((d) => fs.existsSync(path.join(d, 'melt.exe'))) || candidates[0];
export const SHOTCUT = path.join(SHOTCUT_DIR, 'shotcut.exe');
export const MELT = path.join(SHOTCUT_DIR, 'melt.exe');
export const FFMPEG = path.join(SHOTCUT_DIR, 'ffmpeg.exe');
export const FFPROBE = path.join(SHOTCUT_DIR, 'ffprobe.exe');

export const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'NewsEditor');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// card: P2Card (경로 + 카드 고유값으로 구분)
export function cardWorkDir(card) {
  const key = path.resolve(card.dir).replace(/[^A-Za-z0-9]+/g, '_') + '_' + card.id;
  return path.join(DATA_DIR, 'p2', key);
}
