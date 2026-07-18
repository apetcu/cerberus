/**
 * Docker multiplexes non-TTY container output into frames:
 *   [stream_type(1), 0, 0, 0, payload_length(uint32 BE)] followed by payload bytes.
 * Chunks from the socket do NOT align to frame boundaries, so a decoder must carry
 * undecoded bytes across chunks: a split header would otherwise leak control bytes
 * into the output, and a split payload would desync every frame after it.
 */
export interface FrameDecoder {
  /** Decode as much of the accumulated buffer as possible; returns the text decoded so far. */
  push(chunk: Buffer): string;
  /** Text remaining after the stream ends (an unterminated tail). */
  flush(): string;
}

export function createFrameDecoder(): FrameDecoder {
  let pending: Buffer = Buffer.alloc(0);

  return {
    push(chunk: Buffer): string {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let out = '';
      let offset = 0;

      while (offset < pending.length) {
        const remaining = pending.length - offset;
        // Not enough bytes to decide whether this is a header: wait for the next chunk.
        if (remaining < 8) break;

        const framed =
          pending[offset]! <= 2 &&
          pending[offset + 1] === 0 &&
          pending[offset + 2] === 0 &&
          pending[offset + 3] === 0;

        if (!framed) {
          // TTY-allocated containers emit unframed bytes; pass them through untouched.
          out += pending.subarray(offset).toString('utf8');
          offset = pending.length;
          break;
        }

        const size = pending.readUInt32BE(offset + 4);
        if (remaining < 8 + size) break; // payload incomplete: carry it to the next chunk
        out += pending.subarray(offset + 8, offset + 8 + size).toString('utf8');
        offset += 8 + size;
      }

      pending = pending.subarray(offset);
      return out;
    },

    flush(): string {
      if (pending.length === 0) return '';
      const rest = pending.toString('utf8');
      pending = Buffer.alloc(0);
      return rest;
    },
  };
}
