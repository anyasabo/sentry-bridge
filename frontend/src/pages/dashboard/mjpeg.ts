// Minimal parser for the multipart/x-mixed-replace stream served by /stream.
// Each part carries a Content-Length header, which this parser relies on.

const HEADER_END = [13, 10, 13, 10]; // "\r\n\r\n"
const INITIAL_CAPACITY = 256 * 1024;
// A frame never comes close to this; more buffered data means the stream is
// out of sync, so drop it and resync on the next part header.
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function indexOfSequence(buf: Uint8Array, seq: number[]): number {
  outer: for (let i = 0; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (buf[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Returns a push function that feeds chunks and emits complete JPEG frames. */
export function createMjpegParser(
  onFrame: (jpeg: Uint8Array) => void
): (chunk: Uint8Array) => void {
  // Unparsed bytes live in store[start, end); the store grows by doubling.
  let store = new Uint8Array(INITIAL_CAPACITY);
  let start = 0;
  let end = 0;
  const decoder = new TextDecoder();

  const append = (chunk: Uint8Array) => {
    const live = end - start;
    if (live + chunk.length > MAX_BUFFER_BYTES) {
      start = end = 0;
      if (chunk.length > MAX_BUFFER_BYTES) return;
    } else if (end + chunk.length > store.length) {
      let capacity = store.length;
      while (capacity < live + chunk.length) capacity *= 2;
      if (capacity === store.length) {
        store.copyWithin(0, start, end);
      } else {
        const next = new Uint8Array(capacity);
        next.set(store.subarray(start, end), 0);
        store = next;
      }
      start = 0;
      end = live;
    }
    store.set(chunk, end);
    end += chunk.length;
  };

  return (chunk) => {
    append(chunk);
    for (;;) {
      const buf = store.subarray(start, end);
      const headerEnd = indexOfSequence(buf, HEADER_END);
      if (headerEnd < 0) return;
      const headers = decoder.decode(buf.subarray(0, headerEnd));
      const match = /content-length:\s*(\d+)/i.exec(headers);
      const bodyStart = headerEnd + HEADER_END.length;
      if (!match) {
        // Not a part header (e.g. stray bytes) — skip past it.
        start += bodyStart;
        continue;
      }
      const length = Number(match[1]);
      if (buf.length < bodyStart + length) return;
      onFrame(buf.slice(bodyStart, bodyStart + length));
      start += bodyStart + length;
      if (start === end) start = end = 0;
    }
  };
}
