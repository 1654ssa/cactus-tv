import { HttpError } from '../_shared/http';
import { fetchWithTimeout, validateHttpsUrl } from '../_shared/providers';
import type { AppData, Env } from '../_shared/types';

const MAX_SUBTITLE_BYTES = 5_000_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function fetchSubtitleRedirectSafe(raw: string): Promise<Response> {
  let current = new URL(validateHttpsUrl(raw));
  for (let i = 0; i < 4; i += 1) {
    validateHttpsUrl(current.toString());
    const response = await fetchWithTimeout(current.toString(), {
      headers: {
        Accept: 'text/vtt, application/x-subrip, text/plain;q=0.9, */*;q=0.5',
        'User-Agent': 'CactusTV/0.6',
        Referer: current.origin + '/',
      },
      redirect: 'manual',
    }, 10_000);
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current);
    validateHttpsUrl(current.toString());
  }
  throw new HttpError(502, '字幕地址重定向次数过多', 'SUBTITLE_TOO_MANY_REDIRECTS');
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const url = new URL(request.url);
  const upstream = await fetchSubtitleRedirectSafe(url.searchParams.get('url') || '');
  if (!upstream.ok) throw new HttpError(502, `字幕上游返回 HTTP ${upstream.status}`, 'SUBTITLE_UPSTREAM_ERROR');
  const declared = Number(upstream.headers.get('content-length') || 0);
  if (declared > MAX_SUBTITLE_BYTES) throw new HttpError(413, '字幕文件不能超过 5 MB', 'SUBTITLE_TOO_LARGE');
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const allowed = !contentType || contentType.startsWith('text/')
    || contentType.includes('subrip') || contentType.includes('vtt')
    || contentType.includes('octet-stream');
  if (!allowed) throw new HttpError(415, `不支持该字幕类型：${contentType}`, 'UNSUPPORTED_SUBTITLE_TYPE');
  const data = await upstream.arrayBuffer();
  if (data.byteLength > MAX_SUBTITLE_BYTES) throw new HttpError(413, '字幕文件不能超过 5 MB', 'SUBTITLE_TOO_LARGE');
  return new Response(data, {
    headers: {
      'content-type': contentType || 'text/plain; charset=utf-8',
      'content-length': String(data.byteLength),
      'cache-control': 'private, max-age=300, stale-while-revalidate=600',
      'x-content-type-options': 'nosniff',
    },
  });
};
