import { gzipSync } from 'zlib';
import {
  GZ_KEY,
  CompressedEnvelope,
  compressValue,
  decompressValue,
  isCompressedEnvelope,
  maybeDecompressValue,
} from '../lib/compression';

// Full-coverage unit tests for lib/compression.ts.
// These are pure (no Dapr, no network) and exercise every branch.
describe('compression', () => {
  describe('GZ_KEY', () => {
    it('is the reserved $gz key', () => {
      expect(GZ_KEY).toBe('$gz');
    });
  });

  describe('isCompressedEnvelope', () => {
    it('returns true for an object whose $gz is a string', () => {
      expect(isCompressedEnvelope({ $gz: 'abc' })).toBe(true);
    });

    it('returns true even when other keys are present (structural check only)', () => {
      expect(isCompressedEnvelope({ $gz: 'abc', extra: 1 })).toBe(true);
    });

    it('returns false when $gz is missing', () => {
      expect(isCompressedEnvelope({ foo: 'bar' })).toBe(false);
    });

    it('returns false when $gz is not a string', () => {
      expect(isCompressedEnvelope({ $gz: 123 })).toBe(false);
      expect(isCompressedEnvelope({ $gz: null })).toBe(false);
      expect(isCompressedEnvelope({ $gz: { nested: true } })).toBe(false);
    });

    it('returns false for null and undefined', () => {
      expect(isCompressedEnvelope(null)).toBe(false);
      expect(isCompressedEnvelope(undefined)).toBe(false);
    });

    it('returns false for arrays', () => {
      expect(isCompressedEnvelope([])).toBe(false);
      expect(isCompressedEnvelope([1, 2, 3])).toBe(false);
      // An array with a $gz-ish index should still be rejected
      const arr: any = [];
      arr.$gz = 'abc';
      expect(isCompressedEnvelope(arr)).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isCompressedEnvelope('hello')).toBe(false);
      expect(isCompressedEnvelope(42)).toBe(false);
      expect(isCompressedEnvelope(true)).toBe(false);
    });
  });

  describe('compressValue', () => {
    it('produces an envelope with a base64 string under $gz', async () => {
      const env = await compressValue({ a: 1 });
      expect(isCompressedEnvelope(env)).toBe(true);
      expect(typeof env.$gz).toBe('string');
      // base64 round-trips cleanly
      expect(Buffer.from(env.$gz, 'base64').toString('base64')).toBe(env.$gz);
    });

    it('round-trips objects', async () => {
      const original = { name: 'jeremy', count: 7, nested: { items: [1, 2, 3] } };
      expect(await decompressValue(await compressValue(original))).toEqual(original);
    });

    it('round-trips arrays', async () => {
      const original = [1, 'two', { three: 3 }, [4]];
      expect(await decompressValue(await compressValue(original))).toEqual(original);
    });

    it('round-trips primitives and null', async () => {
      expect(await decompressValue(await compressValue('a string'))).toBe('a string');
      expect(await decompressValue(await compressValue(123))).toBe(123);
      expect(await decompressValue(await compressValue(true))).toBe(true);
      expect(await decompressValue(await compressValue(null))).toBeNull();
    });

    it('round-trips unicode and large payloads', async () => {
      const original = { emoji: '🚀✅', big: 'x'.repeat(100_000), accents: 'naïve café' };
      expect(await decompressValue(await compressValue(original))).toEqual(original);
    });

    it('actually compresses large repetitive payloads', async () => {
      const original = { big: 'a'.repeat(50_000) };
      const env = await compressValue(original);
      // base64 of gzipped highly-repetitive data is far smaller than the raw JSON
      expect(env.$gz.length).toBeLessThan(JSON.stringify(original).length);
    });
  });

  describe('decompressValue', () => {
    it('decodes a manually-built envelope', async () => {
      const payload = { hello: 'world' };
      const env: CompressedEnvelope = {
        $gz: gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64'),
      };
      expect(await decompressValue(env)).toEqual(payload);
    });

    it('rejects when the payload is not valid gzip', async () => {
      await expect(decompressValue({ $gz: 'not-valid-gzip-data' })).rejects.toBeDefined();
    });

    it('rejects when the gzipped content is not valid JSON', async () => {
      const env: CompressedEnvelope = {
        $gz: gzipSync(Buffer.from('this is not json', 'utf8')).toString('base64'),
      };
      await expect(decompressValue(env)).rejects.toBeDefined();
    });
  });

  describe('maybeDecompressValue', () => {
    it('passes non-envelope values straight through', async () => {
      const plain = { hello: 'world' };
      expect(await maybeDecompressValue(plain)).toBe(plain);
      expect(await maybeDecompressValue('a string')).toBe('a string');
      expect(await maybeDecompressValue(null)).toBeNull();
      expect(await maybeDecompressValue([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('unwraps a genuine envelope', async () => {
      const original = { name: 'jeremy', nested: { a: [1, 2] } };
      const env = await compressValue(original);
      expect(await maybeDecompressValue(env)).toEqual(original);
    });

    it('returns the value untouched when it only looks like an envelope (false positive)', async () => {
      const fake = { $gz: 'not-real-gzip!!!' };
      const result = await maybeDecompressValue(fake);
      expect(result).toBe(fake);
    });
  });
});
