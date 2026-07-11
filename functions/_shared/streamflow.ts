import { HttpError } from './http';
import type { Env, Provider, StreamflowMessage } from './types';

export const STREAMFLOW_PREFIX = 'streamflow';
export const STREAMFLOW_MAX_BYTES = 950 * 1024 * 1024;
export const STREAMFLOW_MIN_RATIO = 1 / 3;
export const STREAMFLOW_OVERLAP_SECONDS = 24;

let schemaReady: Promise<void> | null = null;

export function ensureStreamflowSchema(env: Env): Promise<void> {
  if (!env.DB) throw new HttpError(503, 'CactusStreamflow 需要绑定 D1', 'STREAMFLOW_DB_REQUIRED');
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS streamflow_sessions (
        id TEXT PRIMARY KEY,
        item_key TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        episode_name TEXT NOT NULL DEFAULT '',
        line_index INTEGER NOT NULL DEFAULT 0,
        episode_index INTEGER NOT NULL DEFAULT 0,
        position_seconds REAL NOT NULL DEFAULT 0,
        duration_seconds REAL NOT NULL DEFAULT 0,
        target_start_seconds REAL NOT NULL DEFAULT 0,
        target_end_seconds REAL NOT NULL DEFAULT 0,
        cached_start_seconds REAL NOT NULL DEFAULT 0,
        cached_end_seconds REAL NOT NULL DEFAULT 0,
        cached_bytes INTEGER NOT NULL DEFAULT 0,
        cached_objects INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        playback_state TEXT NOT NULL DEFAULT 'idle',
        cache_state TEXT NOT NULL DEFAULT 'idle',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_heartbeat INTEGER NOT NULL DEFAULT 0,
        last_queued_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_streamflow_sessions_updated ON streamflow_sessions(updated_at DESC)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_streamflow_sessions_item ON streamflow_sessions(item_key, episode_index)'),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS streamflow_objects (
        session_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        source_url TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'segment',
        track_id TEXT NOT NULL DEFAULT 'main',
        start_seconds REAL NOT NULL DEFAULT 0,
        end_seconds REAL NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        range_header TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, object_id),
        FOREIGN KEY (session_id) REFERENCES streamflow_sessions(id) ON DELETE CASCADE
      )`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_streamflow_objects_session_time ON streamflow_objects(session_id, end_seconds)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_streamflow_objects_created ON streamflow_objects(created_at)'),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS streamflow_hints (
        session_id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL DEFAULT 'main',
        playlist_url TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      )`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_streamflow_hints_updated ON streamflow_hints(updated_at)'),
    ]).then(() => undefined).catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export function streamflowReady(env: Env): boolean {
  return Boolean(env.DB && env.STREAMFLOW_R2 && env.STREAMFLOW_QUEUE);
}

export function validStreamflowId(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function validObjectId(value: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(value);
}

export function streamflowObjectKey(sessionId: string, objectId: string): string {
  if (!validStreamflowId(sessionId) || !validObjectId(objectId)) {
    throw new HttpError(400, 'CactusStreamflow 缓存标识无效', 'STREAMFLOW_INVALID_KEY');
  }
  return `${STREAMFLOW_PREFIX}/${sessionId}/objects/${objectId}`;
}

export function providerAllowsUrl(provider: Provider, raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, '缓存源地址无效', 'STREAMFLOW_INVALID_SOURCE'); }
  if (url.protocol !== 'https:') throw new HttpError(400, '缓存仅支持 HTTPS 片源', 'STREAMFLOW_HTTPS_REQUIRED');
  const allowed = new Set([
    new URL(provider.baseUrl).hostname.toLowerCase(),
    ...provider.mediaHosts.map(host => host.toLowerCase()),
  ]);
  if (!allowed.has(url.hostname.toLowerCase())) {
    throw new HttpError(403, `媒体主机 ${url.hostname} 不在数据源白名单中`, 'STREAMFLOW_HOST_BLOCKED');
  }
  url.hash = '';
  return url;
}

export function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function cacheWindow(position: number, duration: number): { eligible: boolean; start: number; end: number } {
  if (!(duration > 0) || position / duration < STREAMFLOW_MIN_RATIO || position >= duration - 5) {
    return { eligible: false, start: 0, end: 0 };
  }
  const start = Math.max(0, position - STREAMFLOW_OVERLAP_SECONDS);
  const end = Math.min(duration, position + (duration - position) / 2);
  return { eligible: end > start + 5, start, end };
}

export async function queueStreamflow(env: Env, message: StreamflowMessage, delaySeconds = 0): Promise<void> {
  if (!env.STREAMFLOW_QUEUE) throw new HttpError(503, '尚未绑定 CactusStreamflow Queue', 'STREAMFLOW_QUEUE_REQUIRED');
  await env.STREAMFLOW_QUEUE.send(message, delaySeconds > 0 ? { delaySeconds } : undefined);
}
