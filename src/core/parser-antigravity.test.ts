import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findAntigravityDirs, decodeProtobuf, parseAntigravitySessions, parseAntigravitySessionsAsync } from './parser-antigravity';

vi.mock('child_process', async () => {
  const original = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...original,
    execFileSync: vi.fn(),
    execFile: vi.fn(),
  };
});

vi.mock('fs', async () => {
  const original = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...original,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
  };
});

describe('Antigravity Discovery & Decoder', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should find directories', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const dirs = findAntigravityDirs();
    expect(dirs.length).toBe(3);
  });

  it('should decode simple protobuf', () => {
    // Proto message: field 1 = varint 15, field 2 = string "test"
    const buf = Buffer.from([0x08, 0x0f, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
    const res = decodeProtobuf(buf);
    expect(res[1]).toBe(15);
    expect(res[2]).toBe('test');
  });

  it('should parse database sessions successfully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync as unknown as () => string[]).mockReturnValue(['session-1.db']);
    vi.mocked(fs.statSync as unknown as () => Partial<fs.Stats>).mockReturnValue({ birthtimeMs: 10000, mtimeMs: 10000 });

    // Mock sqlite3 responses
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd === 'sqlite3') {
        const arr = args as string[];
        const sql = arr?.[arr.length - 1] || '';
        if (sql.includes('trajectory_metadata_blob') && sql.includes('steps')) {
          const metaHex = '3a1c66696c653a2f2f2f55736572732f616c65782f7372632f7377617a7a1206088ef4d7d006';
          const step0Hex = '9a010e120c68656c6c6f2070726f6d7074';
          const step1Hex = 'a201100a0e68656c6c6f20726573706f6e7365';
          const step2Hex = '2a2e222c120a77726974655f66696c651a1e7b2254617267657446696c65223a222f706174682f746f2f66696c65227d';
          return JSON.stringify([{ hex_data: metaHex }]) + '\n' + JSON.stringify([
            { idx: 0, step_type: 14, payload_hex: step0Hex },
            { idx: 1, step_type: 15, payload_hex: step1Hex },
            { idx: 2, step_type: 21, payload_hex: step2Hex },
          ]);
        }
      }
      return '3.41.0';
    });

    const fakeHome = os.homedir();
    const sessions = parseAntigravitySessions(path.join(fakeHome, 'fake-dir'));
    expect(sessions.length).toBe(1);
    const s = sessions[0];
    expect(s.sessionId).toBe('session-1');
    expect(s.workspaceName).toBe('swazz');
    expect(s.requests.length).toBe(1);
    expect(s.requests[0].messageText).toBe('hello prompt');
    expect(s.requests[0].responseText).toBe('hello response');
    expect(s.requests[0].toolsUsed).toContain('write_file');
    expect(s.requests[0].editedFiles).toContain('/path/to/file');
  });

  it('should parse database sessions asynchronously successfully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync as unknown as () => string[]).mockReturnValue(['session-1.db']);
    vi.mocked(fs.statSync as unknown as () => Partial<fs.Stats>).mockReturnValue({ birthtimeMs: 10000, mtimeMs: 10000 });

    // Mock sqlite3 responses
    vi.mocked(execFileSync).mockReturnValue('3.41.0');
    // Using vi.mocked(execFile) is not needed because execFile is mock-injected inside vi.mock('child_process')
    const { execFile: mockedExecFile } = await import('child_process');
    vi.mocked(mockedExecFile).mockImplementation((_cmd, args, _opts, callback) => {
      const cb = callback as (err: Error | null, stdout: string, stderr: string) => void;
      const arr = args as string[];
      const sql = arr?.[arr.length - 1] || '';
      if (sql.includes('trajectory_metadata_blob') && sql.includes('steps')) {
        const metaHex = '3a1c66696c653a2f2f2f55736572732f616c65782f7372632f7377617a7a1206088ef4d7d006';
        const step0Hex = '9a010e120c68656c6c6f2070726f6d7074';
        const step1Hex = 'a201100a0e68656c6c6f20726573706f6e7365';
        const step2Hex = '2a2e222c120a77726974655f66696c651a1e7b2254617267657446696c65223a222f706174682f746f2f66696c65227d';
        cb(
          null,
          JSON.stringify([{ hex_data: metaHex }]) + '\n' + JSON.stringify([
            { idx: 0, step_type: 14, payload_hex: step0Hex },
            { idx: 1, step_type: 15, payload_hex: step1Hex },
            { idx: 2, step_type: 21, payload_hex: step2Hex },
          ]),
          ''
        );
      } else {
        cb(null, '3.41.0', '');
      }
      return {} as unknown as import('child_process').ChildProcess;
    });

    const fakeHome = os.homedir();
    const sessions = await parseAntigravitySessionsAsync(path.join(fakeHome, 'fake-dir'));
    expect(sessions.length).toBe(1);
    const s = sessions[0];
    expect(s.sessionId).toBe('session-1');
    expect(s.workspaceName).toBe('swazz');
    expect(s.requests.length).toBe(1);
    expect(s.requests[0].messageText).toBe('hello prompt');
    expect(s.requests[0].responseText).toBe('hello response');
    expect(s.requests[0].toolsUsed).toContain('write_file');
    expect(s.requests[0].editedFiles).toContain('/path/to/file');
  });
});
