import { expandKNotation, formatContextWindow, parseKNotation } from '@evu/harness-ui';
import { describe, expect, it } from 'vitest';

describe('parseKNotation', () => {
  it('treats empty as a clear', () => {
    expect(parseKNotation('')).toBeNull();
    expect(parseKNotation('   ')).toBeNull();
  });

  it('accepts a plain positive integer', () => {
    expect(parseKNotation('8192')).toBe(8192);
    expect(parseKNotation(' 32 ')).toBe(32);
  });

  it('expands SI prefixes as powers of 1000', () => {
    expect(parseKNotation('32k')).toBe(32_000);
    expect(parseKNotation('32K')).toBe(32_000);
    expect(parseKNotation('1.5M')).toBe(1_500_000);
    expect(parseKNotation('2G')).toBe(2_000_000_000);
  });

  it('expands IEC prefixes as powers of 1024', () => {
    expect(parseKNotation('32Ki')).toBe(32_768);
    expect(parseKNotation('32ki')).toBe(32_768);
    expect(parseKNotation('8Mi')).toBe(8_388_608);
    expect(parseKNotation('1Gi')).toBe(1_073_741_824);
  });

  it('allows space between the number and the suffix', () => {
    expect(parseKNotation('32 Ki')).toBe(32_768);
    expect(parseKNotation('2 m')).toBe(2_000_000);
  });

  it('rejects unparseable text', () => {
    expect(parseKNotation('32foo')).toBeUndefined();
    expect(parseKNotation('32KiB')).toBeUndefined();
    expect(parseKNotation('0')).toBeUndefined();
    expect(parseKNotation('-1k')).toBeUndefined();
  });
});

describe('expandKNotation', () => {
  it('converts a valid suffix to the integer string and leaves invalid text', () => {
    expect(expandKNotation('32Ki')).toBe('32768');
    expect(expandKNotation('  8k ')).toBe('8000');
    expect(expandKNotation('')).toBe('');
    expect(expandKNotation('nope')).toBe('nope');
  });
});

describe('formatContextWindow', () => {
  it('uses IEC only when the value is not a clean decimal multiple', () => {
    expect(formatContextWindow(32_768)).toBe('32Ki');
    expect(formatContextWindow(8_192)).toBe('8Ki');
    expect(formatContextWindow(1_048_576)).toBe('1Mi');
  });

  it('prefers the decimal reading when both are exact', () => {
    // 128000 is 125Ki as well, which is exact and unreadable.
    expect(formatContextWindow(128_000)).toBe('128K');
    expect(formatContextWindow(1_000_000)).toBe('1M');
  });

  it('falls back to a grouped integer', () => {
    expect(formatContextWindow(1_234)).toBe((1_234).toLocaleString());
    expect(formatContextWindow(7)).toBe('7');
  });

  it('round-trips through the parser', () => {
    for (const value of [4_096, 32_768, 128_000, 200_000, 1_048_576]) {
      expect(parseKNotation(formatContextWindow(value))).toBe(value);
    }
  });
});
