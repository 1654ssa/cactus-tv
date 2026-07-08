import { ok } from '../_shared/http';
import { getSetting } from '../_shared/db';
import { mapTmdb, tmdb } from '../_shared/metadata';
import type { AppData, Env } from '../_shared/types';

function mapList(payload: any) { return (payload?.results || []).filter((x: any) => x.poster_path && (x.title || x.name)).slice(0, 20).map(mapTmdb); }

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ env, data }) => {
  const homeNotice = await getSetting(env, 'home_notice', '');
  if (!env.TMDB_BEARER_TOKEN) return ok({ sections: [], notice: homeNotice || '配置 TMDB_BEARER_TOKEN 后将显示分类首页和元数据。' });
  const [trending, movies, tv, animation] = await Promise.all([
    tmdb('/trending/all/day', env, {}, 1800),
    tmdb('/discover/movie', env, { sort_by: 'popularity.desc', include_adult: 'false', page: '1' }, 3600),
    tmdb('/discover/tv', env, { sort_by: 'popularity.desc', include_adult: 'false', page: '1' }, 3600),
    tmdb('/discover/tv', env, { with_genres: '16', sort_by: 'popularity.desc', include_adult: 'false', page: '1' }, 3600),
  ]);
  return ok({ notice: homeNotice, sections: [
    { id: 'trending', title: '今日热门', kicker: 'TRENDING', items: mapList(trending) },
    { id: 'movies', title: '热门电影', kicker: 'MOVIES', items: mapList(movies) },
    { id: 'tv', title: '热门剧集', kicker: 'SERIES', items: mapList(tv) },
    { id: 'animation', title: '动画精选', kicker: 'ANIMATION', items: mapList(animation) },
  ].filter(section => section.items.length) });
};
