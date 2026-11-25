import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

/**
 * Streams k6's JSON output (one object per line, gzip when the name ends in .gz) without
 * loading it, so a multi-gigabyte staging run reads in constant memory.
 * @param {string} path
 * @returns {AsyncGenerator<{type: string, metric: string, data: any}>}
 */
export async function* readK6Json(path) {
  const file = createReadStream(path);
  const input = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.length === 0) continue;
    try {
      yield JSON.parse(line);
    } catch (err) {
      throw new Error(`${path}:${lineNumber}: not a k6 JSON line (${err.message})`);
    }
  }
}
