import { HttpError, ok } from '../_shared/http';
import { bestTmdbMatch, doubanSearch, searchTmdb, tmdbDetail } from '../_shared/metadata';
import { buildCmsUrl, fetchJson, findProvider } from '../_shared/providers';
import type { AppData, Env, Provider } from '../_shared/types';

function proxyUrl(provider: Provider, target: string): string {
  if (!provider.proxyEnabled) return target;
  try {
    const host = new URL(target).hostname.toLowerCase();
    const allowed = new Set([new URL(provider.baseUrl).hostname.toLowerCase(), ...provider.mediaHosts]);
    if (!allowed.has(host)) return target;
    return `/api/stream?provider=${encodeURIComponent(provider.id)}&url=${encodeURIComponent(target)}`;
  } catch { return target; }
}

function parseLines(fromRaw: string, urlRaw: string, provider: Provider) {
  const names = fromRaw.split('$$$');
  return urlRaw.split('$$$').map((group, index) => ({
    name: names[index] || `线路 ${index + 1}`,
    episodes: group.split('#').map(entry => {
      const splitAt = entry.indexOf('$');
      if (splitAt < 0) return null;
      const url = entry.slice(splitAt + 1).trim();
      if (!/^https?:\/\//i.test(url)) return null;
      return { name: entry.slice(0, splitAt).trim() || '播放', url, playbackUrl: proxyUrl(provider, url), proxied: proxyUrl(provider, url) !== url };
    }).filter(Boolean),
  })).filter(line => line.episodes.length > 0);
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env, data }) => {
  const url = new URL(request.url);
  const providerId = url.searchParams.get('provider') || '';
  const id = url.searchParams.get('id') || '';
  if (!providerId || !id || id.length > 128) throw new HttpError(400, '缺少 provider 或 id', 'INVALID_DETAIL_REQUEST');
  const provider = await findProvider(env, providerId);
  if (!provider || !provider.enabled) throw new HttpError(404, '数据源不存在或未启用', 'PROVIDER_NOT_FOUND');
  const payload = await fetchJson(buildCmsUrl(provider, { ac: 'detail', ids: id }), provider);
  const item = Array.isArray(payload?.list) ? payload.list[0] : null;
  if (!item) throw new HttpError(404, '没有找到详情', 'DETAIL_NOT_FOUND');
  const name = String(item.vod_name ?? '未命名');
  const year = String(item.vod_year ?? '');
  const candidates = await searchTmdb(name, env);
  const matched = bestTmdbMatch(name, year, candidates);
  const [tmdb, douban] = await Promise.all([
    matched ? tmdbDetail(matched.id, matched.mediaType, env) : Promise.resolve(null),
    doubanSearch(name, env),
  ]);
  const itemKey = `${provider.id}:${String(item.vod_id ?? id)}`;
  let subtitles: any[] = [];
  if (env.DB) {
    try {
      const result = await env.DB.prepare('SELECT id, name, lang, url, format FROM subtitles WHERE item_key = ? AND enabled = 1 ORDER BY created_at ASC').bind(itemKey).all();
      subtitles = result.results || [];
    } catch { /* 数据库尚未初始化 */ }
  }
  const rawSubtitle = String(item.vod_sub || '').trim();
  if (/^https:\/\//i.test(rawSubtitle)) subtitles.unshift({ id: 'source', name: '数据源字幕', lang: 'zh', url: rawSubtitle, format: rawSubtitle.split('.').pop() || 'vtt' });
  return ok({ item: {
    key: itemKey, id: String(item.vod_id ?? id), provider: provider.id, providerName: provider.name,
    name, pic: tmdb?.poster || String(item.vod_pic ?? ''), backdrop: tmdb?.backdrop || '', remarks: String(item.vod_remarks ?? ''),
    year: year || tmdb?.year || '', type: String(item.type_name ?? item.vod_class ?? ''), area: String(item.vod_area ?? ''),
    lang: String(item.vod_lang ?? ''), content: tmdb?.overview || String(item.vod_content ?? item.vod_blurb ?? '').replace(/<[^>]+>/g, '').slice(0, 3000),
    director: String(item.vod_director ?? ''), actors: String(item.vod_actor ?? ''), lines: parseLines(String(item.vod_play_from ?? ''), String(item.vod_play_url ?? ''), provider),
    tmdb, douban, subtitles, proxyEnabled: provider.proxyEnabled,
  }});
};
