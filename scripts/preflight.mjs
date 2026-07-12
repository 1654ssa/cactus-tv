import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

const required = [
  'public/index.html', 'public/admin.html', 'public/styles.css', 'public/_headers', 'public/_redirects',
  'public/js/app.js', 'public/js/app-legacy.js', 'public/js/admin.js', 'public/js/api.js', 'public/js/player.js', 'public/js/player-ui.js', 'public/js/recommend.js', 'public/js/cache-controls.js',
  'public/vendor/hls.min.js', 'public/vendor/dash.all.min.js', 'functions/_middleware.ts', 'functions/_shared/auth.ts',
  'functions/api/health.ts', 'functions/api/stream.ts', 'functions/api/subtitle.ts', 'functions/api/library.ts', 'functions/api/browser-cache.ts',
  'functions/api/admin/providers.ts', 'migrations/0001_init.sql', 'migrations/0002_library.sql',
  'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/search-poster-test.mjs',
];

const failures = [];
for (const file of required) {
  try { await access(file, constants.R_OK); }
  catch { failures.push(`缺少文件：${file}`); }
}

for (const forbidden of [
  'functions/api/auth/login.ts', 'functions/api/auth/logout.ts', 'functions/api/me.ts',
  'functions/api/admin/users.ts', 'streamflow-worker', 'migrations/0003_streamflow.sql',
  'functions/api/cache', 'functions/_shared/streamflow.ts', 'CACTUS_STREAMFLOW.md', 'index.js',
]) {
  try { await access(forbidden, constants.F_OK); failures.push(`不应包含旧版文件：${forbidden}`); }
  catch {}
}

try {
  const vendor = await stat('public/vendor/hls.min.js');
  if (vendor.size < 200_000) failures.push('内置 hls.js 文件异常或不完整');
  const dashVendor = await stat('public/vendor/dash.all.min.js');
  if (dashVendor.size < 500_000) failures.push('内置 dash.js 文件异常或不完整');
} catch {}

try {
  const html = await readFile('public/index.html', 'utf8');
  for (const ref of ['/styles.css?v=1.3.2', '/js/app.js?v=1.3.2', '/js/cache-controls.js?v=1.3.2']) {
    if (!html.includes(ref)) failures.push(`首页缺少或未升级资源引用：${ref}`);
  }
  if (/登录 Cactus TV|loginForm|authDialog/.test(html)) failures.push('首页仍包含登录界面');
  if (/CactusStreamflow|streamflowToggle|playerStreamflow/.test(html)) failures.push('首页仍包含已停用的 Streamflow 界面');
  if (!html.includes('cleanStreamToggle')) failures.push('首页缺少 Cactus Clean Stream 开关');
  if (!html.includes('recommendationToggle')) failures.push('首页缺少个性化推荐开关');
  if (!html.includes('id="clearBrowserCache"')) failures.push('设置中缺少清除本地缓存按钮');
} catch {}

try {
  const helper = await readFile('public/js/cache-controls.js', 'utf8');
  for (const token of ['cactus:api:', 'window.caches', 'getRegistrations', '/api/browser-cache']) {
    if (!helper.includes(token)) failures.push(`缓存清理脚本缺少：${token}`);
  }
  if (/localStorage\.(clear|removeItem)/.test(helper)) failures.push('缓存清理脚本不应删除本地片单、历史、设置或 D1 镜像');
} catch {}

try {
  const cacheFunction = await readFile('functions/api/browser-cache.ts', 'utf8');
  if (!cacheFunction.includes('Clear-Site-Data') || !cacheFunction.includes('"cache"')) failures.push('浏览器缓存接口必须仅清理 cache');
  if (/DB|D1|library|history|favorites/i.test(cacheFunction)) failures.push('浏览器缓存接口不应访问 D1 或用户数据');
} catch {}

try {
  const styles = await readFile('public/styles.css', 'utf8');
  for (const token of ['v1.3.2 search-grid containment', 'repeat(3, minmax(0, 1fr))', '.settings-cache-button']) {
    if (!styles.includes(token)) failures.push(`搜索布局/缓存按钮样式缺少：${token}`);
  }
} catch {}

try {
  const app = await readFile('public/js/app.js', 'utf8');
  for (const token of ['applyCleanStream', "import('./player.js?v=1.3.2')", "import('./player-ui.js?v=1.3.2')", 'buildPersonalizedHome']) {
    if (!app.includes(token)) failures.push(`前端主程序缺少：${token}`);
  }
  if (/sendStreamflowHeartbeat|prepareStreamflow|streamflowEnabled/.test(app)) failures.push('前端仍包含主动 Streamflow 逻辑');
} catch {}

try {
  const recommend = await readFile('public/js/recommend.js', 'utf8');
  for (const token of ['buildPersonalizedHome', 'continueWatching', 'diversify', 'affinityScore']) {
    if (!recommend.includes(token)) failures.push(`推荐引擎缺少：${token}`);
  }
} catch {}

try {
  const player = await readFile('public/js/player.js', 'utf8');
  for (const token of ['maxBufferLength: profile.targetBuffer', 'memorySafeBuffer', 'requestSessionWakeLock', 'emergencyDownshift', 'capLevelOnFPSDrop', 'abrMaxWithRealBitrate', 'requestVideoFrameCallback', 'recoverVisualFreeze', 'scheduleSeekFrameVerification', 'startPosition: -1', 'setTrustedDuration', 'scheduleSeekFrameVerification', 'skipMarkedAd']) {
    if (!player.includes(token)) failures.push(`Cactus Player 2.0 播放内核缺少：${token}`);
  }
} catch {}

try {
  const gestures = await readFile('public/js/player-ui.js', 'utf8');
  for (const token of ['GESTURE_THRESHOLD', 'AXIS_LOCK_RATIO', 'showTapRipple', 'requestAnimationFrame', 'effectiveDuration', 'cactus:duration']) {
    if (!gestures.includes(token)) failures.push(`手势引擎缺少：${token}`);
  }
} catch {}

try {
  const search = await readFile('functions/api/search.ts', 'utf8');
  for (const token of ["cacheUrl.searchParams.set('v', '5')", 'doubanMatch?.poster', 'backfillSiblingPosters(enriched)', 'metadataYear || item.year']) {
    if (!search.includes(token)) failures.push(`搜索封面修复缺少：${token}`);
  }
} catch {}

try {
  const stream = await readFile('functions/api/stream.ts', 'utf8');
  for (const token of ['x-cactus-cleanstream', 'x-cactus-cleanstream-marked', 'rewriteM3u8', 'cactus_ad', 'allowedHost']) {
    if (!stream.includes(token)) failures.push(`Cactus Clean Stream 缺少：${token}`);
  }
  if (stream.includes('rewriteMediaSequence') || stream.includes('cleanHlsPlaylist')) failures.push('Clean Stream 2.0 不应删除分片或重写媒体序列');
} catch {}

try {
  const sql = await readFile('migrations/0001_init.sql', 'utf8');
  for (const table of ['settings', 'providers', 'provider_health', 'subtitles', 'favorites', 'watch_history']) {
    if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql)) failures.push(`数据库迁移缺少表：${table}`);
  }
  for (const table of ['users', 'sessions', 'login_attempts']) {
    if (new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql)) failures.push(`数据库不应创建账户表：${table}`);
  }
} catch {}

try {
  const wrangler = await readFile('wrangler.toml.example', 'utf8');
  if (!wrangler.includes('binding = "DB"')) failures.push('Pages Wrangler 缺少 DB Binding');
  for (const removed of ['STREAMFLOW_R2', 'STREAMFLOW_QUEUE']) {
    if (wrangler.includes(`binding = "${removed}"`)) failures.push(`Pages Wrangler 仍包含旧版 Binding：${removed}`);
  }
} catch {}

try {
  const headers = await readFile('public/_headers', 'utf8');
  if (!headers.includes("script-src 'self'")) failures.push('CSP 未限制脚本为本站资源');
} catch {}

if (failures.length) {
  console.error('Cactus TV 预检失败：\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log(`Cactus TV 预检通过：已检查 ${required.length} 个文件。`);
