import { adminConfigured } from '../_shared/auth';
import { getSetting } from '../_shared/db';
import { ok } from '../_shared/http';
import { getStreamflowGeneration, streamflowReady } from '../_shared/streamflow';
import { getProviders } from '../_shared/providers';
import type { AppData, Env } from '../_shared/types';

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ env }) => {
  const providers = await getProviders(env);
  const siteName = await getSetting(env, 'site_name', env.SITE_NAME || 'Cactus TV');
  const streamflowGeneration = await getStreamflowGeneration(env);
  return ok({
    siteName,
    dbReady: Boolean(env.DB),
    tmdbReady: Boolean(env.TMDB_BEARER_TOKEN),
    adminReady: adminConfigured(env),
    privateMode: true,
    streamflowReady: streamflowReady(),
    streamflowEngine: 'cache-api',
    streamflowGeneration,
    providers: providers.map(({ id, name, proxyEnabled }) => ({ id, name, proxyEnabled })),
  }, 200, { 'cache-control': 'private, max-age=10, stale-while-revalidate=30' });
};
