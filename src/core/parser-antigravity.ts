import * as fs from 'fs';
import * as path from 'path';

export function findAntigravityDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return [];
  const dirs: string[] = [];
  const paths = [
    path.join(home, '.gemini', 'antigravity', 'conversations'),
    path.join(home, '.gemini', 'antigravity-cli', 'conversations'),
    path.join(home, '.gemini', 'antigravity-ide', 'conversations'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) dirs.push(p);
  }
  return dirs;
}

function readVarint(buf: Buffer, offset: { val: number }): number {
  let result = 0;
  let shift = 0;
  while (true) {
    if (offset.val >= buf.length) throw new Error('Varint out of bounds');
    const b = buf[offset.val++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return result;
}

export function decodeProtobuf(buf: Buffer): Record<number, any> {
  const result: Record<number, any> = {};
  const offset = { val: 0 };
  while (offset.val < buf.length) {
    try {
      const key = readVarint(buf, offset);
      const fieldNum = key >> 3;
      const wireType = key & 0x07;
      if (wireType === 0) {
        result[fieldNum] = readVarint(buf, offset);
      } else if (wireType === 1) {
        if (offset.val + 8 > buf.length) break;
        result[fieldNum] = buf.subarray(offset.val, offset.val + 8);
        offset.val += 8;
      } else if (wireType === 2) {
        const len = readVarint(buf, offset);
        if (offset.val + len > buf.length) break;
        const val = buf.subarray(offset.val, offset.val + len);
        offset.val += len;

        const str = val.toString('utf-8');
        let isPrintable = true;
        for (let i = 0; i < Math.min(str.length, 100); i++) {
          const code = str.charCodeAt(i);
          if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
            isPrintable = false;
            break;
          }
        }
        if (isPrintable && val.length > 0) {
          result[fieldNum] = str;
        } else {
          try {
            result[fieldNum] = decodeProtobuf(val);
          } catch {
            result[fieldNum] = val;
          }
        }
      } else if (wireType === 5) {
        if (offset.val + 4 > buf.length) break;
        result[fieldNum] = buf.subarray(offset.val, offset.val + 4);
        offset.val += 4;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return result;
}
