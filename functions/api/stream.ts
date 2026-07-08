import { HttpError, ok } from '../_shared/http';
import { fetchWithTimeout, findProvider, validateHttpsUrl } from '../_shared/providers';
import type { AppData, Env, Provider } from '../_shared/types';

const PLAYLIST_LIMIT = 3_000_000;
const SNIFF_LIMIT = 64 * 1024;

function allowedHost(provider: Provider, hostname: string): boolean {
  const allowed = new Set([new URL(provider.baseUrl).hostname.toLowerCase(), ...provider.mediaHosts.map(x => x.toLowerCase())]);
  return allowed.has(hostname.toLowerCase());
}

function assertMediaUrl(provider: Provider, raw: string): URL {
  const value = validateHttpsUrl(raw);
  const url = new URL(value);
  if (!allowedHost(provider, url.hostname)) throw new HttpError(403, `媒体主机 ${url.hostname} 不在该数据源白名单中`, 'MEDIA_HOST_BLOCKED');
  return url;
}

function proxied(provider: Provider, absolute: string): string {
  return `/api/stream?provider=${encodeURIComponent(provider.id)}&url=${encodeURIComponent(absolute)}`;
}

function rewriteM3u8(text: string, base: URL, provider: Provider): string {
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) {
      try { return proxied(provider, new URL(trimmed, base).toString()); } catch { return line; }
    }
    return line.replace(/URI="([^"]+)"/g, (_all, uri) => {
      try { return `URI="${proxied(provider, new URL(uri, base).toString())}"`; } catch { return `URI="${uri}"`; }
    });
  }).join('\n');
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function normalizeMpdBase(text: string, manifestUrl: URL): string {
  const directory = new URL('.', manifestUrl).toString();
  // dash.js otherwise resolves relative segments against /api/stream instead of the upstream manifest.
  return text.replace(/<MPD\b[^>]*>/i, match => `${match}<BaseURL>${escapeXml(directory)}</BaseURL>`);
}

async function fetchRedirectSafe(provider: Provider, url: URL, request: Request): Promise<Response> {
  let current = url;
  for (let i = 0; i < 4; i += 1) {
    assertMediaUrl(provider, current.toString());
    const headers = new Headers({ Accept: '*/*', 'User-Agent': 'CactusTV/0.6', ...provider.requestHeaders });
    const range = request.headers.get('range');
    if (range) headers.set('range', range);
    const response = await fetchWithTimeout(current.toString(), { headers, redirect: 'manual' }, 15_000);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current);
    assertMediaUrl(provider, current.toString());
  }
  throw new HttpError(502, '媒体地址重定向次数过多', 'TOO_MANY_REDIRECTS');
}

function declaredKind(contentType: string, url: URL): 'hls' | 'dash' | 'media' | '' {
  const path = `${url.pathname}${url.search}`;
  if (contentType.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(path)) return 'hls';
  if (contentType.includes('dash+xml') || /\.mpd(?:$|[?#])/i.test(path)) return 'dash';
  if (contentType.startsWith('video/') || contentType.startsWith('audio/')) return 'media';
  return '';
}

function sniffKind(bytes: Uint8Array): 'hls' | 'dash' | 'media' {
  const sample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, SNIFF_LIMIT)).trimStart();
  if (sample.startsWith('#EXTM3U')) return 'hls';
  if (/^<\?xml[\s\S]{0,500}<MPD\b|^<MPD\b/i.test(sample)) return 'dash';
  return 'media';
}

async function readPrefix(body: ReadableStream<Uint8Array> | null, limit = SNIFF_LIMIT): Promise<{
  prefix: Uint8Array;
  rest: ReadableStream<Uint8Array> | null;
}> {
  if (!body) return { prefix: new Uint8Array(), rest: null };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (total < limit) {
    const result = await reader.read();
    done = result.done;
    if (result.value) {
      chunks.push(result.value);
      total += result.value.byteLength;
    }
    if (done) break;
  }
  const prefix = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(chunk => { prefix.set(chunk, offset); offset += chunk.byteLength; });
  if (done) return { prefix, rest: null };
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) { controller.close(); reader.releaseLock(); }
      else controller.enqueue(result.value);
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return { prefix, rest };
}

function combinedBody(prefix: Uint8Array, rest: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> {
  let sent = false;
  const reader = rest?.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true;
        if (prefix.byteLength) controller.enqueue(prefix);
        if (!reader) controller.close();
        return;
      }
      if (!reader) { controller.close(); return; }
      const result = await reader.read();
      if (result.done) { controller.close(); reader.releaseLock(); }
      else controller.enqueue(result.value);
    },
    async cancel(reason) { await reader?.cancel(reason); },
  });
}

function mediaHeaders(upstream: Response, contentType: string): Headers {
  const headers = new Headers();
  ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(key => {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  });
  headers.set('cache-control', contentType.includes('video') || contentType.includes('audio') || contentType.includes('octet-stream')
    ? 'public, max-age=300, stale-while-revalidate=60'
    : 'public, max-age=60');
  headers.set('access-control-allow-origin', '*');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('vary', 'Range');
  return headers;
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  const requestUrl = new URL(request.url);
  const params = requestUrl.searchParams;
  const provider = await findProvider(env, params.get('provider') || '');
  if (!provider || !provider.enabled || !provider.proxyEnabled) throw new HttpError(404, '该数据源未启用受控代理', 'PROXY_DISABLED');
  const target = assertMediaUrl(provider, params.get('url') || '');
  const upstream = await fetchRedirectSafe(provider, target, request);
  if (!upstream.ok && upstream.status !== 206) throw new HttpError(502, `媒体上游返回 HTTP ${upstream.status}`, 'MEDIA_UPSTREAM_ERROR');

  const finalUrl = upstream.url ? new URL(upstream.url) : target;
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  let kind = declaredKind(contentType, finalUrl);
  let prefix = new Uint8Array();
  let rest: ReadableStream<Uint8Array> | null = upstream.body;

  if (!kind || contentType.includes('octet-stream') || contentType.includes('text/plain')) {
    const peeked = await readPrefix(upstream.body);
    prefix = peeked.prefix;
    rest = peeked.rest;
    kind = sniffKind(prefix);
  }

  if (params.get('probe') === '1') {
    try { await rest?.cancel(); } catch {}
    return ok({ kind, contentType, finalUrl: finalUrl.toString() }, 200, { 'cache-control': 'no-store, private' });
  }

  if (kind === 'hls') {
    let bytes = prefix;
    if (rest) {
      const remaining = await new Response(rest).arrayBuffer();
      if (bytes.byteLength + remaining.byteLength > PLAYLIST_LIMIT) throw new HttpError(502, '播放列表过大', 'PLAYLIST_TOO_LARGE');
      const combined = new Uint8Array(bytes.byteLength + remaining.byteLength);
      combined.set(bytes, 0);
      combined.set(new Uint8Array(remaining), bytes.byteLength);
      bytes = combined;
    }
    if (bytes.byteLength > PLAYLIST_LIMIT) throw new HttpError(502, '播放列表过大', 'PLAYLIST_TOO_LARGE');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return new Response(rewriteM3u8(text, finalUrl, provider), {
      headers: {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'cache-control': 'private, max-age=10, stale-while-revalidate=20',
        'access-control-allow-origin': '*',
        'x-cactus-media-kind': 'hls',
      },
    });
  }

  if (kind === 'dash') {
    let bytes = prefix;
    if (rest) {
      const remaining = await new Response(rest).arrayBuffer();
      if (bytes.byteLength + remaining.byteLength > PLAYLIST_LIMIT) throw new HttpError(502, 'DASH 清单过大', 'PLAYLIST_TOO_LARGE');
      const combined = new Uint8Array(bytes.byteLength + remaining.byteLength);
      combined.set(bytes, 0);
      combined.set(new Uint8Array(remaining), bytes.byteLength);
      bytes = combined;
    }
    if (bytes.byteLength > PLAYLIST_LIMIT) throw new HttpError(502, 'DASH 清单过大', 'PLAYLIST_TOO_LARGE');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return new Response(normalizeMpdBase(text, finalUrl), {
      headers: {
        'content-type': 'application/dash+xml; charset=utf-8',
        'cache-control': 'private, max-age=10, stale-while-revalidate=20',
        'access-control-allow-origin': '*',
        'x-cactus-media-kind': 'dash',
      },
    });
  }

  const allowedTypes = ['video/', 'audio/', 'application/octet-stream', 'application/dash+xml', 'text/xml', 'application/xml', 'text/plain'];
  if (contentType && !allowedTypes.some(type => contentType.includes(type))) {
    try { await rest?.cancel(); } catch {}
    throw new HttpError(415, `不支持代理该媒体类型：${contentType}`, 'UNSUPPORTED_MEDIA_TYPE');
  }

  const headers = mediaHeaders(upstream, contentType);
  headers.set('x-cactus-media-kind', kind || 'media');
  if (kind === 'dash') headers.set('content-type', 'application/dash+xml');
  else if (!headers.get('content-type') || contentType.includes('text/plain')) headers.set('content-type', 'application/octet-stream');
  const body = prefix.byteLength ? combinedBody(prefix, rest) : rest;
  return new Response(body, { status: upstream.status, headers });
};
