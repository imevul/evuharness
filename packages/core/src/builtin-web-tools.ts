import type { SearchProviderKind } from '@evu/harness-protocol';
import { assertPublicUrl, type HttpRequestPolicy } from './ssrf.js';
import type { ToolDefinition } from './tools.js';
import { wrapUntrustedToolResult } from './untrusted.js';

export interface SearchProviderRuntime {
  id: string;
  kind: SearchProviderKind;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}

export interface WebToolsDeps {
  fetch: typeof globalThis.fetch;
  activeSearch: () => Promise<SearchProviderRuntime | null>;
  httpPolicy?: HttpRequestPolicy;
}

export function builtinWebSearchTool(deps: WebToolsDeps): ToolDefinition {
  return {
    name: 'web_search',
    description:
      'Search the public web. Returns titles, URLs, and snippets. Use for current facts, not for fetching a known URL (use http_request).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    mutates: false,
    approval: 'always_allow',
    builtin: true,
    handler: async (args) => {
      const query = String(args.query ?? '').trim();
      if (query === '') return wrapUntrustedToolResult('web_search', 'Empty query.');
      const provider = await deps.activeSearch();
      if (provider === null) {
        return wrapUntrustedToolResult('web_search', 'No search provider configured.');
      }
      try {
        const hits =
          provider.kind === 'searxng'
            ? await searchSearxng(deps.fetch, provider, query)
            : await searchDuckDuckGo(deps.fetch, query);
        return wrapUntrustedToolResult(
          'web_search',
          hits.length === 0
            ? 'No results.'
            : hits
                .map((hit, index) => `${index + 1}. ${hit.title}\n${hit.url}\n${hit.snippet}`)
                .join('\n\n'),
        );
      } catch (cause) {
        return wrapUntrustedToolResult(
          'web_search',
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    },
  };
}

export function builtinHttpRequestTool(deps: WebToolsDeps): ToolDefinition {
  return {
    name: 'http_request',
    description:
      'HTTP request to a public URL. GET and HEAD run without approval; other methods require approval. Private and local addresses are blocked.',
    parameters: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method. Defaults to GET.',
        },
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        headers: { type: 'object', description: 'Optional request headers.' },
        body: { type: 'string', description: 'Optional request body.' },
      },
      required: ['url'],
    },
    mutates: true,
    approval: 'requires_approval',
    builtin: true,
    handler: async (args) => {
      const method = String(args.method ?? 'GET').toUpperCase();
      try {
        const url = await assertPublicUrl(String(args.url ?? ''), deps.httpPolicy);
        const headers = headersFrom(args.headers);
        const init: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(15_000),
        };
        if (args.body !== undefined && method !== 'GET' && method !== 'HEAD') {
          init.body = String(args.body);
        }
        const response = await deps.fetch(url.toString(), init);
        const text = await response.text();
        const clipped = text.length > 32_000 ? `${text.slice(0, 32_000)}\n…` : text;
        return wrapUntrustedToolResult(
          'http_request',
          `${response.status} ${response.statusText}\n${clipped}`,
        );
      } catch (cause) {
        return wrapUntrustedToolResult(
          'http_request',
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    },
  };
}

function headersFrom(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') headers[key] = entry;
  }
  return headers;
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function searchDuckDuckGo(fetchImpl: typeof fetch, query: string): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url, { headers: { 'user-agent': 'evuharness/0' } });
  if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);
  const html = await response.text();
  const hits: SearchHit[] = [];
  const result = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi;
  const snippets = [...html.matchAll(snippetRe)].map((match) => stripTags(match[1] ?? ''));
  let index = 0;
  for (const match of html.matchAll(result)) {
    const href = decodeDuckUrl(match[1] ?? '');
    const title = stripTags(match[2] ?? '');
    if (href === '' || title === '') continue;
    hits.push({ title, url: href, snippet: snippets[index] ?? '' });
    index += 1;
    if (hits.length >= 8) break;
  }
  return hits;
}

function decodeDuckUrl(href: string): string {
  try {
    const url = new URL(href, 'https://html.duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg ?? url.toString();
  } catch {
    return href;
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function searchSearxng(
  fetchImpl: typeof fetch,
  provider: SearchProviderRuntime,
  query: string,
): Promise<SearchHit[]> {
  const base = provider.baseUrl?.replace(/\/+$/, '');
  if (base === undefined || base === '') {
    throw new Error('SearXNG provider has no base URL');
  }
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (provider.apiKey !== undefined && provider.apiKey !== '') {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }
  const response = await fetchImpl(url, { headers });
  if (!response.ok) throw new Error(`SearXNG returned ${response.status}`);
  const payload = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (payload.results ?? []).slice(0, 8).map((row) => ({
    title: row.title ?? '',
    url: row.url ?? '',
    snippet: row.content ?? '',
  }));
}
