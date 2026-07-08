import { fetchWithTimeout } from './providers';
import type { Env } from './types';

const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const DOUBAN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
  Referer: 'https://movie.douban.com/',
  Origin: 'https://movie.douban.com',
  Accept: 'application/json, text/plain, */*',
};

function normalized(value: string): string {
  return value.toLowerCase().normalize('NFKC').replace(/[\s\-_:：·•.，,()（）\[\]【】]/g, '').replace(/第?[一二三四五六七八九十0-9]+季$/u, '');
}

async function cachedJson(request: Request, ttl = 3600): Promise<any> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached.json();
  const response = await fetchWithTimeout(request.url, { headers: request.headers }, 8_000);
  if (!response.ok) throw new Error(`metadata HTTP ${response.status}`);
  const payload = await response.json();
  const cacheResponse = new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` } });
  await cache.put(request, cacheResponse.clone());
  return payload;
}

export function resolveMetadataSource(value: string, env: Env): 'tmdb' | 'douban' {
  const selected = String(value || 'auto').toLowerCase();
  if (selected === 'tmdb') return 'tmdb';
  if (selected === 'douban') return 'douban';
  return env.TMDB_BEARER_TOKEN ? 'tmdb' : 'douban';
}

export async function tmdb(path: string, env: Env, params: Record<string, string> = {}, ttl = 3600): Promise<any | null> {
  if (!env.TMDB_BEARER_TOKEN) return null;
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  Object.entries({ language: 'zh-CN', ...params }).forEach(([key, value]) => url.searchParams.set(key, value));
  const request = new Request(url.toString(), { headers: { Authorization: `Bearer ${env.TMDB_BEARER_TOKEN}`, Accept: 'application/json' } });
  try { return await cachedJson(request, ttl); } catch (error) { console.warn('TMDB failed', error); return null; }
}

export function mapTmdb(item: any) {
  const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
  const title = item.title || item.name || item.original_title || item.original_name || '';
  const date = item.release_date || item.first_air_date || '';
  return {
    id: Number(item.id), mediaType, title,
    originalTitle: item.original_title || item.original_name || '',
    year: date ? String(date).slice(0, 4) : '',
    overview: item.overview || '',
    poster: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : '',
    backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : '',
    rating: Number(item.vote_average || 0), votes: Number(item.vote_count || 0), popularity: Number(item.popularity || 0),
    genres: Array.isArray(item.genres) ? item.genres.map((g: any) => g.name) : [],
  };
}

export async function searchTmdb(query: string, env: Env): Promise<any[]> {
  const payload = await tmdb('/search/multi', env, { query, include_adult: 'false', page: '1' }, 1800);
  return (payload?.results || []).filter((x: any) => ['movie', 'tv'].includes(x.media_type)).slice(0, 20).map(mapTmdb);
}

export function bestTmdbMatch(name: string, year: string, candidates: any[]): any | null {
  const target = normalized(name);
  let best: any = null; let score = -1;
  for (const candidate of candidates) {
    const titles = [candidate.title, candidate.originalTitle].filter(Boolean).map(normalized);
    let current = titles.includes(target) ? 100 : titles.some((title: string) => title.includes(target) || target.includes(title)) ? 65 : 0;
    if (year && candidate.year === year) current += 20;
    current += Math.min(10, candidate.popularity / 100);
    if (current > score) { score = current; best = candidate; }
  }
  return score >= 60 ? best : null;
}

export async function tmdbDetail(id: number, mediaType: string, env: Env): Promise<any | null> {
  if (!id || !['movie', 'tv'].includes(mediaType)) return null;
  const payload = await tmdb(`/${mediaType}/${id}`, env, { append_to_response: 'credits,external_ids,videos' }, 21600);
  return payload ? mapTmdb(payload) : null;
}

export async function doubanList(type: 'movie' | 'tv', tag: string, ttl = 3600): Promise<any[]> {
  const url = new URL('https://movie.douban.com/j/search_subjects');
  url.searchParams.set('type', type);
  url.searchParams.set('tag', tag);
  url.searchParams.set('sort', 'recommend');
  url.searchParams.set('page_limit', '20');
  url.searchParams.set('page_start', '0');

  try {
    const payload = await cachedJson(new Request(url.toString(), { headers: DOUBAN_HEADERS }), ttl);
    return (payload?.subjects || []).filter((item: any) => item?.title && item?.cover).slice(0, 20).map((item: any) => ({
      id: String(item.id || ''),
      mediaType: type,
      title: String(item.title || ''),
      originalTitle: '',
      year: String(item.card_subtitle || '').match(/(19|20)\d{2}/)?.[0] || '',
      overview: '',
      poster: String(item.cover || ''),
      backdrop: '',
      rating: Number(item.rate || 0),
      votes: 0,
      popularity: 0,
      genres: [],
      douban: {
        id: String(item.id || ''),
        title: String(item.title || ''),
        rating: Number(item.rate || 0),
        url: item.id ? `https://movie.douban.com/subject/${item.id}/` : '',
      },
    }));
  } catch (error) {
    console.warn('Douban list failed', error);
    return [];
  }
}

async function directDoubanSearch(query: string): Promise<any | null> {
  const url = new URL('https://movie.douban.com/j/subject_suggest');
  url.searchParams.set('q', query);
  try {
    const payload = await cachedJson(new Request(url.toString(), { headers: DOUBAN_HEADERS }), 21600);
    const items = Array.isArray(payload) ? payload : [];
    const target = normalized(query);
    const item = items.find((candidate: any) => normalized(String(candidate.title || candidate.sub_title || '')) === target) || items[0];
    if (!item?.id) return null;
    return {
      id: String(item.id),
      title: String(item.title || item.sub_title || query),
      rating: Number(item.rating?.value || item.rating || 0),
      url: String(item.url || `https://movie.douban.com/subject/${item.id}/`).replace(/\\/g, ''),
      poster: String(item.pic || item.img || item.cover_url || '').replace(/\\/g, '').replace(/^http:/, 'https:'),
      year: String(item.year || ''),
      mediaType: item.type === 'tv' ? 'tv' : 'movie',
    };
  } catch {
    return null;
  }
}

export async function doubanSearch(query: string, env: Env): Promise<any | null> {
  if (env.DOUBAN_METADATA_URL) {
    try {
      const url = new URL(env.DOUBAN_METADATA_URL);
      if (url.protocol === 'https:') {
        url.searchParams.set('q', query);
        const response = await fetchWithTimeout(url.toString(), { headers: { Accept: 'application/json' } }, 6_000);
        if (response.ok) {
          const payload: any = await response.json();
          const item = (payload.items || payload.subjects || [])[0];
          if (item) {
            return {
              id: String(item.id || ''),
              title: String(item.title || item.name || ''),
              rating: Number(item.rating?.average || item.rating?.value || item.rating || 0),
              url: String(item.url || item.alt || ''),
              poster: String(item.poster || item.cover || item.pic?.normal || item.pic || ''),
              year: String(item.year || ''),
              mediaType: item.type === 'tv' ? 'tv' : 'movie',
            };
          }
        }
      }
    } catch { /* 使用豆瓣直连 */ }
  }
  return directDoubanSearch(query);
}
