import { adminConfigured } from '../_shared/auth';
import { getSetting } from '../_shared/db';
import { ok } from '../_shared/http';
import { getProviders } from '../_shared/providers';
import type { AppData, Env } from '../_shared/types';

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ env }) => {
  const providers = await getProviders(env);
  const siteName = await getSetting(env, 'site_name', env.SITE_NAME || 'Cactus TV');
  return ok({
    siteName,
    dbReady: Boolean(env.DB),
    tmdbReady: Boolean(env.TMDB_BEARER_TOKEN),
    adminReady: adminConfigured(env),
    privateMode: true,
    providers: providers.map(({ id, name, proxyEnabled }) => ({ id, name, proxyEnabled })),
  });
};
