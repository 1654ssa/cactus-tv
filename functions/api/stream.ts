import { HttpError } from '../_shared/http';
import { fetchWithTimeout, findProvider, validateHttpsUrl } from '../_shared/providers';
import type { AppData, Env, Provider } from '../_shared/types';

function allowedHost(provider: Provider, hostname: string): boolean {
  const allowed = new Set([new URL(provider.baseUrl).hostname.toLowerCase(), ...provider.mediaHosts.map(x => x.toLowerCase())]);
  return allowed.has(hostname.toLowerCase());
}
function assertMediaUrl(provider: Provider, raw: string): URL {
  const value = validateHttpsUrl(raw); const url = new URL(value);
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

async function fetchRedirectSafe(provider: Provider, url: URL, request: Request): Promise<Response> {
  let current = url;
  for (let i = 0; i < 4; i++) {
    assertMediaUrl(provider, current.toString());
    const headers = new Headers({ Accept: '*/*', 'User-Agent': 'CactusTV/0.4', ...provider.requestHeaders });
    const range = request.headers.get('range'); if (range) headers.set('range', range);
    const response = await fetchWithTimeout(current.toString(), { headers, redirect: 'manual' }, 15_000);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location'); if (!location) return response;
    current = new URL(location, current); assertMediaUrl(provider, current.toString());
  }
  throw new HttpError(502, '媒体地址重定向次数过多', 'TOO_MANY_REDIRECTS');
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env, data }) => {
  const params = new URL(request.url).searchParams;
  const provider = await findProvider(env, params.get('provider') || '');
  if (!provider || !provider.enabled || !provider.proxyEnabled) throw new HttpError(404, '该数据源未启用受控代理', 'PROXY_DISABLED');
  const target = assertMediaUrl(provider, params.get('url') || '');
  const upstream = await fetchRedirectSafe(provider, target, request);
  if (!upstream.ok && upstream.status !== 206) throw new HttpError(502, `媒体上游返回 HTTP ${upstream.status}`, 'MEDIA_UPSTREAM_ERROR');
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const looksPlaylist = contentType.includes('mpegurl') || /\.m3u8(?:$|\?)/i.test(target.pathname + target.search);
  if (looksPlaylist) {
    const text = await upstream.text();
    if (text.length > 3_000_000) throw new HttpError(502, '播放列表过大', 'PLAYLIST_TOO_LARGE');
    const playlistBase = upstream.url ? new URL(upstream.url) : target;
    return new Response(rewriteM3u8(text, playlistBase, provider), { headers: {
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8', 'cache-control': 'private, max-age=10', 'access-control-allow-origin': '*',
    }});
  }
  const allowedTypes = ['video/', 'audio/', 'application/octet-stream', 'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'text/vtt', 'application/dash+xml'];
  if (contentType && !allowedTypes.some(type => contentType.includes(type))) throw new HttpError(415, `不支持代理该媒体类型：${contentType}`, 'UNSUPPORTED_MEDIA_TYPE');
  const headers = new Headers();
  ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(key => { const value = upstream.headers.get(key); if (value) headers.set(key, value); });
  headers.set('cache-control', contentType.includes('video') || contentType.includes('audio') ? 'public, max-age=300' : 'public, max-age=60');
  headers.set('access-control-allow-origin', '*');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(upstream.body, { status: upstream.status, headers });
};
