import { requireAdmin } from '../../_shared/auth';
import { getSettings, setSetting } from '../../_shared/db';
import { cleanText, ok, readJson } from '../../_shared/http';
import type { AppData, Env } from '../../_shared/types';

const ALLOWED = new Set(['site_name', 'home_notice']);

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  requireAdmin(request, env);
  return ok({ settings: { site_name: env.SITE_NAME || 'Cactus TV', home_notice: '', ...(await getSettings(env)) } });
};

export const onRequestPut: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  requireAdmin(request, env);
  const body = await readJson<Record<string, unknown>>(request, 20_000);
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED.has(key)) await setSetting(env, key, cleanText(value, key === 'home_notice' ? 1000 : 120));
  }
  return ok({ settings: await getSettings(env) });
};
