import { requireAdmin } from '../../_shared/auth';
import { buildCmsUrl, fetchWithTimeout, getProviders } from '../../_shared/providers';
import { ok, readJson } from '../../_shared/http';
import type { AppData, Env } from '../../_shared/types';

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  requireAdmin(request, env);
  const body = await readJson<{ providerId?: string }>(request, 8_000);
  const providers = (await getProviders(env, true)).filter(p => !body.providerId || p.id === body.providerId);
  const results = await Promise.all(providers.map(async provider => {
    const started = Date.now();
    let healthy = false;
    let error = '';
    try {
      const response = await fetchWithTimeout(buildCmsUrl(provider, { ac: 'list', pg: '1' }), { headers: { Accept: 'application/json, text/plain', ...provider.requestHeaders } }, 8_000);
      healthy = response.ok;
      if (!response.ok) error = `HTTP ${response.status}`;
      else await response.body?.cancel();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : '测试失败';
    }
    const latency = Date.now() - started;
    if (env.DB) await env.DB.prepare(`INSERT INTO provider_health (provider_id, ok, latency_ms, last_error, checked_at)
      VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(provider_id) DO UPDATE SET ok=excluded.ok, latency_ms=excluded.latency_ms,
      last_error=excluded.last_error, checked_at=datetime('now')`).bind(provider.id, healthy ? 1 : 0, latency, error).run();
    return { providerId: provider.id, name: provider.name, ok: healthy, latency, error };
  }));
  return ok({ results });
};
