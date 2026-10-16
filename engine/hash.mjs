// 원본 무결성: SHA-256 (스트리밍, 대용량 MXF 대응)
import crypto from 'node:crypto';
import fs from 'node:fs';

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

export const sha256Buffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
