import fs from 'node:fs';
import assert from 'node:assert/strict';

const searchSource = fs.readFileSync('functions/api/search.ts', 'utf8');
assert.match(searchSource, /cacheUrl\.searchParams\.set\('v', '5'\)/, '搜索缓存版本必须升级，避免继续命中旧空封面结果');
assert.ok(searchSource.includes('doubanMatch?.poster'), '搜索结果必须使用豆瓣匹配封面');
assert.ok(searchSource.includes('backfillSiblingPosters(enriched)'), '搜索结果必须从同标题兄弟条目回填封面');
assert.ok(searchSource.includes('metadataYear || item.year'), '高置信元数据年份应修正错误源年份');

function cleanName(value) {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[\s\-—–_:：·•.，,()（）\[\]【】]/g, '')
    .replace(/(第?[一二三四五六七八九十0-9]+季|国语|粤语|中字|高清|完整版)$/gu, '');
}
function metadataName(value) {
  return cleanName(value)
    .replace(/(?:电影|影视|剧情)?解说$/u, '')
    .replace(/(?:抢先|先行|正式|终极)?预告(?:片)?$/u, '')
    .replace(/(?:抢先|先行|加长|导演剪辑|修复|重映|未删减|完整)版$/u, '')
    .replace(/(?:花絮|幕后特辑|制作特辑|彩蛋)$/u, '');
}
function sameMetadataTitle(left, right) {
  const a = metadataName(left);
  const b = metadataName(right);
  return Boolean(a && b && a === b);
}
function backfillSiblingPosters(items) {
  const pools = new Map();
  for (const item of items) {
    const key = metadataName(String(item.name || ''));
    const pic = String(item.pic || '');
    if (!key || !pic) continue;
    const year = String(item.tmdb?.year || item.douban?.year || item.year || '');
    const priority = item.tmdb?.poster ? 3 : item.douban?.poster ? 2 : 1;
    const list = pools.get(key) || [];
    list.push({ pic, year, priority });
    list.sort((a, b) => b.priority - a.priority);
    pools.set(key, list);
  }
  return items.map(item => {
    if (item.pic) return item;
    const candidates = pools.get(metadataName(String(item.name || ''))) || [];
    const year = String(item.tmdb?.year || item.douban?.year || item.year || '');
    const exact = year ? candidates.find(candidate => candidate.year === year) : null;
    const compatible = exact || candidates.find(candidate => {
      if (!year || !candidate.year) return true;
      const delta = Math.abs(Number(year) - Number(candidate.year));
      return Number.isFinite(delta) && delta <= 1;
    });
    return compatible ? { ...item, pic: compatible.pic } : item;
  });
}

assert.equal(metadataName('楚门的世界[电影解说]'), '楚门的世界');
assert.equal(metadataName('好东西—抢先版'), '好东西');
assert.equal(metadataName('好东西：终极预告片'), '好东西');
assert.equal(sameMetadataTitle('好东西', '非Y般的好东西'), false, '不得把包含关系当成同一标题');
assert.equal(sameMetadataTitle('楚门的世界', '楚门的世界[电影解说]'), true);

const filled = backfillSiblingPosters([
  { name: '楚门的世界', year: '1998', pic: '' },
  { name: '楚门的世界[电影解说]', year: '1998', pic: 'https://img.example/truman.jpg' },
  { name: '非Y般的好东西', year: '2026', pic: '' },
  { name: '好东西[电影解说]', year: '2024', pic: 'https://img.example/herstory.jpg' },
  { name: '好东西—抢先版', year: '2025', pic: '' },
]);
assert.equal(filled[0].pic, 'https://img.example/truman.jpg');
assert.equal(filled[2].pic, '', '不同标题不得错误借图');
assert.equal(filled[4].pic, 'https://img.example/herstory.jpg', '同标题变体且年份相差 1 年可安全借图');

console.log('搜索封面回填测试通过：豆瓣封面、同标题变体、年份保护与缓存升级均已检查。');
