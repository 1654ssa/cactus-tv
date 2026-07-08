import { requireAdmin } from '../../_shared/auth';
import { ok, readJson } from '../../_shared/http';
import { getProviders, normalizeProvider, saveProvider } from '../../_shared/providers';
import type { AppData, Env } from '../../_shared/types';

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  requireAdmin(request, env);
  const providers = await getProviders(env, true);
  let health: Record<string, any> = {};
  if (env.DB) {
    try {
      const rows = (await env.DB.prepare('SELECT provider_id, ok, latency_ms, last_error, checked_at FROM provider_health').all<any>()).results || [];
      health = Object.fromEntries(rows.map(row => [row.provider_id, row]));
    } catch { /* 数据库尚未初始化 */ }
  }
  return ok({ providers: providers.map(provider => ({ ...provider, health: health[provider.id] || null })) });
};

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  requireAdmin(request, env);
  const provider = normalizeProvider(await readJson<any>(request, 40_000));
  await saveProvider(env, provider);
  return ok({ provider }, 201);
};
