import { assertPublicUrl, isBlockedAddress } from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.9',
    '172.16.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it('allows a public unicast address', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('rejects loopback hostnames and non-http schemes', async () => {
    await expect(assertPublicUrl('http://localhost/secret')).rejects.toThrow(/private or local/);
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(/private or local/);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
  });

  it('rejects RFC1918 and metadata literals', async () => {
    await expect(assertPublicUrl('http://192.168.1.1/')).rejects.toThrow(/private or local/);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private or local/,
    );
  });

  it('allows a public IP and an explicit host allowlist', async () => {
    await expect(assertPublicUrl('https://8.8.8.8/resolve')).resolves.toMatchObject({
      hostname: '8.8.8.8',
    });
    await expect(
      assertPublicUrl('http://127.0.0.1:9/', { allowHosts: ['127.0.0.1'] }),
    ).resolves.toMatchObject({ hostname: '127.0.0.1' });
  });
});
