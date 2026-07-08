import { HttpError, ok } from '../_shared/http';
import { bestTmdbMatch, doubanSearch, searchTmdb } from '../_shared/metadata';
import { buildCmsUrl, fetchJson, getProviders } from '../_shared/providers';
import type { AppData, Env } from '../_shared/types';

function cleanName(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[\s\-_:：·•.，,()（）\[\]【】]/g, '')
    .replace(/(第?[一二三四五六七八九十0-9]+季|国语|粤语|中字|高清|完整版)$/gu, '');
}

function keyFor(name: string, year: string) { return `${cleanName(name)}:${year || ''}`; }

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async context => {
  const { request, env } = context;
  const query = new URL(request.url).searchParams.get('q')?.trim() || '';
  if (!query || query.length > 80) throw new HttpError(400, '请输入 1—80 个字符的关键词', 'INVALID_QUERY');

  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set('q', query.normalize('NFKC'));
  cacheUrl.searchParams.set('v', '4');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const providers = await getProviders(env);
  if (!providers.length) {
    return ok({ items: [], errors: [], query }, 200, {
      'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=300',
    });
  }

  const metadataPromise = searchTmdb(query, env);
  const doubanPromise = doubanSearch(query, env);
  const settled = await mapLimit(providers, 5, async provider => {
    const started = Date.now();
    const payload = await fetchJson(buildCmsUrl(provider, { ac: 'detail', wd: query }), provider, 8_000);
    const list = Array.isArray(payload?.list) ? payload.list : [];
    return {
      latency: Date.now() - started,
      provider,
      items: list.slice(0, 40).map((item: any) => ({
        id: String(item.vod_id ?? ''),
        provider: provider.id,
        providerName: provider.name,
        name: String(item.vod_name ?? '未命名'),
        pic: String(item.vod_pic ?? ''),
        remarks: String(item.vod_remarks ?? ''),
        year: String(item.vod_year ?? ''),
        type: String(item.type_name ?? item.vod_class ?? ''),
        proxyEnabled: provider.proxyEnabled,
      })).filter((item: any) => item.id && item.name),
    };
  });

  const grouped = new Map<string, any>();
  const errors: any[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      errors.push({
        provider: providers[index].name,
        error: result.reason instanceof Error ? result.reason.message : '未知错误',
      });
      return;
    }
    for (const item of result.value.items) {
      const key = keyFor(item.name, item.year);
      const existing = grouped.get(key);
      const source = {
        id: item.id,
        provider: item.provider,
        providerName: item.providerName,
        remarks: item.remarks,
        latency: result.value.latency,
        proxyEnabled: item.proxyEnabled,
      };
      if (existing) {
        existing.sources.push(source);
        if (!existing.pic && item.pic) existing.pic = item.pic;
        if (!existing.type && item.type) existing.type = item.type;
      } else {
        grouped.set(key, { ...item, key, sources: [source] });
      }
    }
  });

  const [tmdbCandidates, douban] = await Promise.all([metadataPromise, doubanPromise]);
  const items = [...grouped.values()].map(item => {
    const tmdb = bestTmdbMatch(item.name, item.year, tmdbCandidates);
    const preferred = [...item.sources].sort((a, b) => a.latency - b.latency)[0];
    return {
      ...item,
      id: preferred.id,
      provider: preferred.provider,
      providerName: preferred.providerName,
      pic: tmdb?.poster || item.pic,
      year: item.year || tmdb?.year || '',
      tmdb,
      douban: douban && cleanName(douban.title) === cleanName(item.name) ? douban : null,
      sourceCount: item.sources.length,
    };
  }).sort((a, b) => (b.sourceCount - a.sourceCount) || ((b.tmdb?.popularity || 0) - (a.tmdb?.popularity || 0)));

  const response = ok({ items: items.slice(0, 80), errors, query }, 200, {
    'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
  });
  context.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
};
