import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface HttpRequestPolicy {
  /** Hostnames the SSRF check will not reject, even if they resolve privately. */
  allowHosts?: string[];
  /** When true, skip the private-address check entirely. Host-owned. */
  allowPrivate?: boolean;
}

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.', '0.0.0.0', '::', '::1']);

/**
 * Reject URLs that would let a model reach the host's own network.
 *
 * Loopback, link-local, RFC1918, and cloud metadata addresses are blocked
 * unless the host opts in. DNS is resolved so a public name that points at a
 * private address cannot slip through.
 */
export async function assertPublicUrl(raw: string, policy: HttpRequestPolicy = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const allow = new Set((policy.allowHosts ?? []).map((entry) => entry.toLowerCase()));
  if (policy.allowPrivate === true || allow.has(host)) {
    return url;
  }

  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Requests to private or local addresses are blocked');
  }

  const literal = isIP(host);
  if (literal !== 0) {
    if (isBlockedAddress(host)) {
      throw new Error('Requests to private or local addresses are blocked');
    }
    return url;
  }

  const resolved = await resolveHost(host);
  if (resolved.some(isBlockedAddress)) {
    throw new Error('Requests to private or local addresses are blocked');
  }
  return url;
}

async function resolveHost(host: string): Promise<string[]> {
  const found: string[] = [];
  const settled = await Promise.allSettled([resolve4(host), resolve6(host)]);
  for (const result of settled) {
    if (result.status === 'fulfilled') found.push(...result.value);
  }
  if (found.length === 0) {
    throw new Error(`Could not resolve ${host}`);
  }
  return found;
}

export function isBlockedAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized === '::'
    );
  }

  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  const [a, b] = parts;
  if (a === undefined || b === undefined || parts.some((part) => Number.isNaN(part))) {
    return true;
  }
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
