import { describe, expect, it } from 'vitest';
import { createFrameDecoder } from '../src/runtime/docker-log-frames.js';

function frame(text: string, streamType = 1): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('createFrameDecoder', () => {
  it('decodes whole frames', () => {
    const d = createFrameDecoder();
    expect(d.push(frame('hello\n'))).toBe('hello\n');
  });

  it('decodes several frames in one chunk', () => {
    const d = createFrameDecoder();
    expect(d.push(Buffer.concat([frame('a\n'), frame('b\n')]))).toBe('a\nb\n');
  });

  it('carries a header split across chunks without leaking control bytes', () => {
    const d = createFrameDecoder();
    const full = frame('split-header\n');
    expect(d.push(full.subarray(0, 3))).toBe('');   // partial header: nothing yet
    expect(d.push(full.subarray(3))).toBe('split-header\n');
  });

  it('carries a payload split across chunks', () => {
    const d = createFrameDecoder();
    const full = frame('long-payload-line\n');
    expect(d.push(full.subarray(0, 12))).toBe('');
    expect(d.push(full.subarray(12))).toBe('long-payload-line\n');
  });

  it('stays in sync for frames following a split one', () => {
    const d = createFrameDecoder();
    const buf = Buffer.concat([frame('one\n'), frame('two\n'), frame('three\n')]);
    const cut = 11;
    const first = d.push(buf.subarray(0, cut));
    const second = d.push(buf.subarray(cut));
    expect(first + second).toBe('one\ntwo\nthree\n');
  });

  it('passes through unframed (TTY) output', () => {
    const d = createFrameDecoder();
    expect(d.push(Buffer.from('plain tty output here\n', 'utf8'))).toBe('plain tty output here\n');
  });

  it('flush returns an unterminated tail', () => {
    const d = createFrameDecoder();
    const full = frame('tail');
    d.push(full.subarray(0, 4));
    expect(d.flush().length).toBeGreaterThan(0);
  });
});
