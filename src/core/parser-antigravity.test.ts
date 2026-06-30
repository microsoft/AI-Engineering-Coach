import { describe, it, expect } from 'vitest';
import { findAntigravityDirs, decodeProtobuf } from './parser-antigravity';

describe('Antigravity Discovery & Decoder', () => {
  it('should find directories', () => {
    const dirs = findAntigravityDirs();
    expect(Array.isArray(dirs)).toBe(true);
  });

  it('should decode simple protobuf', () => {
    // Proto message: field 1 = varint 15, field 2 = string "test"
    const buf = Buffer.from([0x08, 0x0f, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
    const res = decodeProtobuf(buf);
    expect(res[1]).toBe(15);
    expect(res[2]).toBe('test');
  });
});
