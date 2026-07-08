import { requireAdmin } from '../../_shared/auth';
import { requireDb } from '../../_shared/db';
import { cleanText, HttpError, ok, readJson } from '../../_shared/http';
import { validateHttpsUrl } from '../../_shared/providers';
import type { AppData, Env } from '../../_shared/types';

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  requireAdmin(request, env);
  const db = requireDb(env);
  const itemKey = cleanText(new URL(request.url).searchParams.get('itemKey'), 200);
  const stmt = itemKey
    ? db.prepare('SELECT * FROM subtitles WHERE item_key = ? ORDER BY created_at DESC').bind(itemKey)
    : db.prepare('SELECT * FROM subtitles ORDER BY created_at DESC LIMIT 300');
  return ok({ subtitles: (await stmt.all()).results || [] });
};

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  requireAdmin(request, env);
  const db = requireDb(env);
  const body = await readJson<any>(request, 20_000);
  const itemKey = cleanText(body.itemKey, 200);
  const name = cleanText(body.name, 120);
  const lang = cleanText(body.lang || 'zh', 20);
  const format = cleanText(body.format || 'vtt', 20).toLowerCase();
  const url = validateHttpsUrl(String(body.url || ''));
  if (!itemKey || !name || !['vtt', 'srt'].includes(format)) throw new HttpError(400, '字幕参数无效', 'INVALID_SUBTITLE');
  const subtitle = { id: crypto.randomUUID(), itemKey, name, lang, format, url };
  await db.prepare(`INSERT INTO subtitles (id, item_key, name, lang, url, format, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))`).bind(subtitle.id, itemKey, name, lang, url, format).run();
  return ok({ subtitle }, 201);
};
