import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * The reserved key used to flag a compressed value on the wire.
 * A compressed value is stored as `{ "$gz": "<base64 gzip of the JSON>" }`.
 */
export const GZ_KEY = '$gz';

export type CompressedEnvelope = { [GZ_KEY]: string };

/**
 * Returns true only if the value has the exact shape of our compression
 * envelope: a plain object whose `$gz` property is a string.
 *
 * This is a structural check only — it does NOT guarantee the string is valid
 * gzip data. Callers that decompress must still handle failure gracefully so
 * that a coincidental `{ $gz: "..." }` in user data is never corrupted.
 */
export function isCompressedEnvelope(value: unknown): value is CompressedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[GZ_KEY] === 'string'
  );
}

/**
 * Compresses an already-serialized value into a `{ "$gz": "<base64>" }`
 * envelope. The value is JSON-stringified, gzipped, then base64-encoded.
 */
export async function compressValue(value: unknown): Promise<CompressedEnvelope> {
  const json = JSON.stringify(value);
  const compressed = await gzipAsync(Buffer.from(json, 'utf8'));
  return { [GZ_KEY]: compressed.toString('base64') };
}

/**
 * Decompresses a `{ "$gz": "<base64>" }` envelope back into the original value.
 * Throws if the payload is not valid base64 gzip or not valid JSON.
 */
export async function decompressValue(envelope: CompressedEnvelope): Promise<unknown> {
  const buf = Buffer.from(envelope[GZ_KEY], 'base64');
  const decompressed = await gunzipAsync(buf);
  return JSON.parse(decompressed.toString('utf8'));
}

/**
 * Safely unwraps a value that *may* be a compression envelope.
 *
 * - If the value is not an envelope, it is returned unchanged.
 * - If it is an envelope and decompresses cleanly, the original value is returned.
 * - If it merely looks like an envelope but cannot be decompressed (e.g. a
 *   coincidental `{ $gz: "..." }` in user data), the value is returned
 *   unchanged rather than throwing.
 *
 * This makes reads bulletproof regardless of whether the `compressed` flag is
 * currently on or off: genuine envelopes are always unwrapped, and anything
 * else passes straight through.
 */
export async function maybeDecompressValue(value: unknown): Promise<unknown> {
  if (!isCompressedEnvelope(value)) {
    return value;
  }
  try {
    return await decompressValue(value);
  } catch {
    return value;
  }
}
