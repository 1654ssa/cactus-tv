import { api } from './api.js';
import { store } from './storage.js';
import { loadSubtitle, localSubtitle, playStream, stopStream } from './player.js';

const $ = selector => document.querySelector(selector);
const els = {
  brandName: $('#brandName'), footerName: $('#footerName'), topbar: $('#topbar'), hero: $('#hero'), heroBackdrop: $('#heroBackdrop'), heroArtwork: $('#heroArtwork'),
  heroTitle: $('#heroTitle'), heroMeta: $('#heroMeta'), heroOverview: $('#heroOverview'), heroPlayButton: $('#heroPlayButton'), heroInfoButton: $('#heroInfoButton'),
  searchForm: $('#searchForm'), searchInput: $('#searchInput'), homeSections: $('#homeSections'), resultsSection: $('#resultsSection'),
  mediaGrid: $('#mediaGrid'), emptyState: $('#emptyState'), skeletons: $('#skeletons'), notice: $('#notice'), sectionTitle: $('#sectionTitle'),
  sectionKicker: $('#sectionKicker'), resultCount: $('#resultCount'), detailDialog: $('#detailDialog'), detailContent: $('#detailContent'),
  playerDialog: $('#playerDialog'), player: $('#videoPlayer'), playerTitle: $('#playerTitle'), playerSubtitle: $('#playerSubtitle'),
  playerMessage: $('#playerMessage'), subtitleSelect: $('#subtitleSelect'), subtitleFile: $('#subtitleFile'), resumeHint: $('#resumeHint'),
  settingsDialog: $('#settingsDialog'), settingsButton: $('#settingsButton'), searchToggle: $('#searchToggle'), searchClose: $('#searchClose'), historyToggle: $('#historyToggle'), nativeHlsToggle: $('#nativeHlsToggle'),
  resumeToggle: $('#resumeToggle'), sourcePills: $('#sourcePills'), metadataCredit: $('#metadataCredit'), toast: $('#toast'),
};

let currentView = 'home';
let settings = store.settings();
let currentPlayback = null;
let featuredItem = null;

els.historyToggle.checked = settings.recordHistory;
els.nativeHlsToggle.checked = settings.preferNativeHls;
els.resumeToggle.checked = settings.resumePlayback;
els.heroArtwork.addEventListener('error', () => {
  els.hero.classList.remove('poster-mode');
  els.heroArtwork.removeAttribute('src');
});

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}
function safeImage(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';

  try {
    const parsed = new URL(value);
    if (/(^|\.)doubanio\.com$/i.test(parsed.hostname)) {
      return `/api/image?url=${encodeURIComponent(value)}`;
    }
  } catch {
    return '';
  }

  return value;
}
function keyOf(item) { return item.key || `${item.provider}:${item.id}`; }
function titleOf(item) { return item.name || item.title || '未命名'; }
function savedItem(item) {
  return {
    key: keyOf(item), id: item.id, provider: item.provider, providerName: item.providerName,
    name: titleOf(item), pic: item.pic || item.poster, remarks: item.remarks,
    year: item.year, type: item.type, sources: item.sources, tmdb: item.tmdb,
  };
}
function toast(message, kind = '') {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
}
function showNotice(message = '', kind = '') {
  clearTimeout(showNotice.timer);
  els.notice.textContent = message;
  els.notice.className = `notice ${message ? '' : 'hidden'} ${kind}`;
  if (message && kind === 'warning') {
    showNotice.timer = setTimeout(() => els.notice.classList.add('hidden'), 5200);
  }
}
function formatTime(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function setLoading(loading) {
  els.skeletons.classList.toggle('hidden', !loading);
  els.mediaGrid.classList.toggle('hidden', loading);
  if (loading) {
    els.skeletons.innerHTML = Array.from({ length: 12 }, () => '<div class="skeleton"></div>').join('');
    els.emptyState.classList.add('hidden');
  }
}
function setActiveTab(view) {
  document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
}
function setCompactView(compact) {
  document.body.classList.toggle('compact-view', compact);
}

function renderHero(item) {
  featuredItem = item || null;
  els.hero.classList.remove('poster-mode');
  els.heroArtwork.removeAttribute('src');

  if (!item) {
    els.heroBackdrop.style.backgroundImage = 'radial-gradient(circle at 72% 28%, #3c0a0e 0, #18090b 25%, #090909 62%)';
    els.heroTitle.textContent = '今晚看什么？';
    els.heroMeta.innerHTML = '';
    els.heroOverview.textContent = '';
    return;
  }

  const backdrop = safeImage(item.backdrop || item.tmdb?.backdrop);
  const poster = safeImage(item.poster || item.pic || item.tmdb?.poster);
  const heroImage = backdrop || poster;

  els.heroBackdrop.style.backgroundImage = heroImage
    ? `url("${heroImage.replace(/["\\]/g, '\\$&')}")`
    : 'radial-gradient(circle at 72% 28%, #3c0a0e 0, #18090b 25%, #090909 62%)';

  if (!backdrop && poster) {
    els.hero.classList.add('poster-mode');
    els.heroArtwork.src = poster;
    els.heroArtwork.alt = titleOf(item);
  }

  els.heroTitle.textContent = titleOf(item);
  const rating = Number(item.rating || item.tmdb?.rating || item.douban?.rating || 0);
  const type = item.mediaType === 'tv' ? '剧集' : item.mediaType === 'movie' ? '电影' : item.type;
  const meta = [rating ? `★ ${rating.toFixed(1)}` : '', item.year, type].filter(Boolean);
  els.heroMeta.innerHTML = meta.map(value => `<span>${escapeHtml(value)}</span>`).join('');
  els.heroOverview.textContent = item.overview || item.tmdb?.overview || '';
}

function cardHtml(item, index, context = 'results') {
  const name = titleOf(item);
  const visual = safeImage(item.backdrop || item.tmdb?.backdrop || item.pic || item.poster);
  const key = keyOf(item);
  const rating = Number(item.tmdb?.rating || item.rating || item.douban?.rating || 0);
  const favorite = context !== 'home' && store.isFavorite(key);
  const type = item.type || (item.mediaType === 'tv' ? '剧集' : item.mediaType === 'movie' ? '电影' : item.providerName || '');
  const primaryMeta = rating ? `★ ${rating.toFixed(1)}` : item.sourceCount > 1 ? `${item.sourceCount} 个片源` : '';
  const fallback = name.trim().slice(0, 1).toUpperCase() || 'C';

  return `<article class="media-card" tabindex="0" role="button" aria-label="查看 ${escapeHtml(name)}" data-index="${index}" data-context="${context}">
    <div class="poster">${visual ? `<img loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" src="${escapeHtml(visual)}" alt="${escapeHtml(name)}">` : `<div class="poster-fallback">${escapeHtml(fallback)}</div>`}
      ${item.remarks ? `<span class="badge">${escapeHtml(item.remarks)}</span>` : rating ? `<span class="rating">★ ${rating.toFixed(1)}</span>` : ''}
      ${context !== 'home' ? `<button type="button" class="favorite-button ${favorite ? 'active' : ''}" data-favorite="${escapeHtml(key)}" aria-label="${favorite ? '取消收藏' : '收藏'}">${favorite ? '♥' : '+'}</button>` : ''}
      <div class="card-overlay"><strong>${escapeHtml(name)}</strong><div class="card-meta">${primaryMeta ? `<span class="match">${escapeHtml(primaryMeta)}</span>` : ''}${item.year ? `<span>${escapeHtml(item.year)}</span>` : ''}${type ? `<span>${escapeHtml(type)}</span>` : ''}</div></div>
    </div>
  </article>`;
}

function bindCards(container, items, context) {
  const activateCard = async (card, event) => {
    const item = items[Number(card.dataset.index)];
    if (!item) return;
    if (event?.target?.closest?.('[data-favorite]')) {
      event.stopPropagation();
      toggleFavorite(item, event.target.closest('[data-favorite]'));
      return;
    }
    if (context === 'home') {
      const query = titleOf(item);
      els.searchInput.value = query;
      await search(query);
    } else {
      await openDetail(item);
    }
  };

  container.querySelectorAll('.media-card').forEach(card => {
    card.addEventListener('click', event => activateCard(card, event));
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateCard(card, event);
      }
    });
  });
  container.querySelectorAll('img').forEach(img => img.addEventListener('error', () => {
    img.replaceWith(Object.assign(document.createElement('div'), { className: 'poster-fallback', textContent: img.dataset.fallback || 'C' }));
  }, { once: true }));
}

function render(items, title, kicker) {
  const list = items || [];
  setCompactView(true);
  els.resultsSection.classList.remove('hidden');
  els.homeSections.classList.add('hidden');
  els.sectionTitle.textContent = title;
  els.sectionKicker.textContent = kicker;
  els.resultCount.textContent = list.length ? `${list.length} 个结果` : '';
  els.emptyState.classList.toggle('hidden', list.length > 0);
  els.mediaGrid.innerHTML = list.map((item, index) => cardHtml(item, index)).join('');
  bindCards(els.mediaGrid, list, 'results');
}

function renderHome(sections) {
  currentView = 'home';
  setCompactView(false);
  setActiveTab('home');
  els.resultsSection.classList.add('hidden');
  els.homeSections.classList.remove('hidden');
  if (!sections?.length) {
    renderHero(null);
    els.homeSections.innerHTML = '<div class="empty-state"><div class="empty-icon">C</div><h3>首页暂无内容</h3><p>可以直接使用上方搜索。</p></div>';
    return;
  }

  const firstSection = sections.find(section => section.items?.length);
  renderHero(firstSection?.items?.[0]);
  els.homeSections.innerHTML = sections.map((section, sectionIndex) => `<section class="catalog-section">
    <div class="section-heading"><h2>${escapeHtml(section.title)}</h2>
      <div class="row-controls" aria-label="滚动片单"><button type="button" class="row-control" data-row="${sectionIndex}" data-dir="-1" aria-label="向左">‹</button><button type="button" class="row-control" data-row="${sectionIndex}" data-dir="1" aria-label="向右">›</button></div>
    </div>
    <div class="media-row" data-section="${sectionIndex}">${section.items.map((item, index) => cardHtml(item, index, 'home')).join('')}</div>
  </section>`).join('');

  sections.forEach((section, index) => bindCards(els.homeSections.querySelector(`[data-section="${index}"]`), section.items, 'home'));
  els.homeSections.querySelectorAll('.row-control').forEach(button => button.addEventListener('click', () => {
    const row = els.homeSections.querySelector(`[data-section="${button.dataset.row}"]`);
    row?.scrollBy({ left: Number(button.dataset.dir) * Math.max(row.clientWidth * .82, 320), behavior: 'smooth' });
  }));
}

function toggleFavorite(item, button) {
  const normalized = savedItem(item);
  const active = store.toggleFavorite(normalized);
  button.classList.toggle('active', active);
  button.textContent = active ? '♥' : '+';
  button.setAttribute('aria-label', active ? '取消收藏' : '收藏');
  if (currentView === 'favorites') renderSavedView('favorites');
}

async function search(query) {
  currentView = 'search';
  setActiveTab('home');
  setCompactView(true);
  showNotice('');
  setLoading(true);
  els.resultsSection.classList.remove('hidden');
  els.homeSections.classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try {
    const payload = await api.search(query);
    render(payload.items || [], `“${query}”`, 'SEARCH RESULTS');
    if (payload.errors?.length) showNotice(`部分数据源不可用：${payload.errors.map(error => error.provider).join('、')}`, 'warning');
  } catch (error) {
    render([], '搜索失败', 'ERROR');
    showNotice(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function openDetail(item, sourceOverride = null) {
  const source = sourceOverride || { provider: item.provider, id: item.id, providerName: item.providerName };
  els.detailContent.innerHTML = '<div class="empty-state"><div class="empty-icon">C</div><p>正在加载详情…</p></div>';
  if (!els.detailDialog.open) els.detailDialog.showModal();
  try {
    const payload = await api.detail(source.provider, source.id);
    const detail = payload.item;
    const poster = safeImage(detail.pic);
    const lines = detail.lines || [];
    const sourceButtons = (item.sources || []).map(candidate => `<button class="source-choice ${candidate.provider === detail.provider ? 'active' : ''}" data-provider="${escapeHtml(candidate.provider)}" data-id="${escapeHtml(candidate.id)}">${escapeHtml(candidate.providerName)}${candidate.latency ? ` · ${candidate.latency}ms` : ''}</button>`).join('');
    els.detailContent.innerHTML = `<div class="detail-backdrop" ${detail.backdrop ? `style="background-image:url('${escapeHtml(detail.backdrop)}')"` : ''}></div><div class="detail-hero">
      ${poster ? `<img class="detail-poster" referrerpolicy="no-referrer" src="${escapeHtml(poster)}" alt="${escapeHtml(detail.name)}">` : '<div class="detail-poster poster-fallback">C</div>'}
      <div class="detail-copy"><span class="eyebrow">${escapeHtml(detail.providerName || 'SOURCE')}</span><h2>${escapeHtml(detail.name)}</h2>
      <div class="detail-meta">${[detail.tmdb?.rating ? `★ ${Number(detail.tmdb.rating).toFixed(1)}` : '', detail.year, detail.type, detail.area, detail.lang, detail.douban?.rating ? `豆瓣 ${detail.douban.rating.toFixed(1)}` : ''].filter(Boolean).map(value => `<span>${escapeHtml(value)}</span>`).join('')}</div>
      ${sourceButtons ? `<div class="source-choices">${sourceButtons}</div>` : ''}<p>${escapeHtml(detail.content || '暂无简介')}</p>${detail.director ? `<small>导演：${escapeHtml(detail.director)}</small>` : ''}${detail.actors ? `<small>演员：${escapeHtml(detail.actors)}</small>` : ''}</div></div>
      ${lines.map((line, lineIndex) => `<div class="episode-block"><h3>${escapeHtml(line.name || `线路 ${lineIndex + 1}`)}</h3><div class="episodes">${line.episodes.map((episode, episodeIndex) => `<button class="episode" data-line="${lineIndex}" data-episode="${episodeIndex}">${escapeHtml(episode.name || `第 ${episodeIndex + 1} 集`)}${episode.proxied ? '<i>代理</i>' : ''}</button>`).join('')}</div></div>`).join('') || '<div class="episode-block"><p class="muted">此数据源没有返回可播放条目。</p></div>'}`;
    els.detailContent.querySelectorAll('.source-choice').forEach(button => button.addEventListener('click', () => openDetail(item, { provider: button.dataset.provider, id: button.dataset.id })));
    els.detailContent.querySelectorAll('.episode').forEach(button => button.addEventListener('click', () => {
      const episode = lines[Number(button.dataset.line)].episodes[Number(button.dataset.episode)];
      openPlayer(detail, episode);
    }));
  } catch (error) {
    els.detailContent.innerHTML = `<div class="empty-state"><div class="empty-icon">!</div><h3>详情加载失败</h3><p>${escapeHtml(error.message)}</p><button class="primary-button" id="retryDetail">重试</button></div>`;
    $('#retryDetail')?.addEventListener('click', () => openDetail(item, source));
  }
}

async function openPlayer(detail, episode) {
  els.playerTitle.textContent = detail.name;
  els.playerSubtitle.textContent = episode.name;
  els.playerMessage.classList.add('hidden');
  if (!els.playerDialog.open) els.playerDialog.showModal();
  const historyItem = store.progress(detail.key);
  const resumeAt = settings.resumePlayback && historyItem?.url === episode.playbackUrl ? Number(historyItem.position || 0) : 0;
  els.resumeHint.textContent = resumeAt > 5 ? `将从 ${formatTime(resumeAt)} 继续` : '';
  currentPlayback = { detail, episode, item: { ...savedItem(detail), key: detail.key }, lastSync: 0 };
  populateSubtitles(detail.subtitles || []);
  if (settings.recordHistory) saveHistory(0, 0);
  try {
    await playStream(els.player, episode.playbackUrl || episode.url, settings.preferNativeHls, resumeAt);
  } catch (error) {
    els.playerMessage.textContent = `${error.message}。请检查播放地址、媒体域名白名单、CORS 或受控代理配置。`;
    els.playerMessage.classList.remove('hidden');
  }
}

function populateSubtitles(subtitles) {
  els.subtitleSelect.innerHTML = '<option value="">关闭</option>' + subtitles.map((subtitle, index) => `<option value="${index}">${escapeHtml(subtitle.name)} · ${escapeHtml(subtitle.lang || '')}</option>`).join('');
  els.subtitleSelect._items = subtitles;
  els.subtitleFile.value = '';
}

function saveHistory(position = els.player.currentTime || 0, duration = els.player.duration || 0) {
  if (!currentPlayback || !settings.recordHistory) return;
  const { episode, item } = currentPlayback;
  const record = { ...item, episodeName: episode.name, url: episode.playbackUrl || episode.url, position, duration };
  store.addHistory(record);
  store.updateProgress(item.key, position, duration, record.url);
}

function renderSavedView(view) {
  currentView = view;
  setActiveTab(view);
  setCompactView(true);
  showNotice('');
  const list = view === 'favorites' ? store.favorites() : store.history();
  render(list, view === 'favorites' ? '我的片单' : '继续观看', 'SAVED ON THIS DEVICE');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openSearch() {
  document.body.classList.add('search-open');
  requestAnimationFrame(() => els.searchInput.focus());
}

function closeSearch() {
  document.body.classList.remove('search-open');
}

els.searchForm.addEventListener('submit', event => {
  event.preventDefault();
  const query = els.searchInput.value.trim();
  if (query) {
    closeSearch();
    search(query);
  }
});
els.searchToggle.addEventListener('click', openSearch);
els.searchClose.addEventListener('click', closeSearch);
els.heroPlayButton.addEventListener('click', () => {
  const query = featuredItem ? titleOf(featuredItem) : els.searchInput.value.trim();
  if (query) {
    els.searchInput.value = query;
    search(query);
  } else {
    openSearch();
  }
});
els.heroInfoButton.addEventListener('click', () => els.homeSections.querySelector('.catalog-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

document.querySelectorAll('.nav-tab').forEach(tab => tab.addEventListener('click', async () => {
  const view = tab.dataset.view;
  if (view === 'home') {
    setActiveTab('home');
    try {
      const home = await api.home();
      renderHome(home.sections);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (home.notice) showNotice(home.notice, 'warning');
    } catch (error) {
      showNotice(error.message, 'error');
    }
  } else {
    renderSavedView(view);
  }
}));

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
}));
els.settingsButton.addEventListener('click', () => els.settingsDialog.showModal());
[els.historyToggle, els.nativeHlsToggle, els.resumeToggle].forEach(input => input.addEventListener('change', () => {
  settings = {
    recordHistory: els.historyToggle.checked,
    preferNativeHls: els.nativeHlsToggle.checked,
    resumePlayback: els.resumeToggle.checked,
  };
  store.saveSettings(settings);
}));
els.subtitleSelect.addEventListener('change', async () => {
  try {
    const item = els.subtitleSelect.value === '' ? null : els.subtitleSelect._items[Number(els.subtitleSelect.value)];
    await loadSubtitle(els.player, item);
  } catch (error) {
    toast(error.message, 'error');
  }
});
els.subtitleFile.addEventListener('change', async () => {
  const file = els.subtitleFile.files?.[0];
  if (!file) return;
  try {
    const subtitle = await localSubtitle(file);
    await loadSubtitle(els.player, subtitle);
    toast('本地字幕已加载');
  } catch (error) {
    toast(error.message, 'error');
  }
});
els.player.addEventListener('timeupdate', () => {
  if (!currentPlayback || Date.now() - currentPlayback.lastSync < 15000) return;
  currentPlayback.lastSync = Date.now();
  saveHistory();
});
els.playerDialog.addEventListener('close', () => {
  saveHistory();
  stopStream(els.player);
  currentPlayback = null;
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('search-open')) closeSearch();
});
window.addEventListener('scroll', () => els.topbar.classList.toggle('scrolled', window.scrollY > 28), { passive: true });
window.addEventListener('unhandledrejection', event => {
  console.error(event.reason);
  toast(event.reason?.message || '页面发生未处理错误', 'error');
});

(async function init() {
  renderHero(null);
  try {
    const health = await api.health();
    const siteName = health.siteName || 'Cactus TV';
    const brandBase = siteName.replace(/\s*TV\s*$/i, '').trim() || 'Cactus';
    els.brandName.textContent = brandBase.toUpperCase();
    els.footerName.textContent = siteName;
    document.title = siteName;
    if (health.tmdbReady) {
      els.metadataCredit.innerHTML = '<a class="footer-link" href="https://www.themoviedb.org" target="_blank" rel="noreferrer">Metadata by TMDB</a>';
    } else {
      els.metadataCredit.textContent = '影片资料来自豆瓣';
    }
    els.sourcePills.innerHTML = (health.providers || []).map(provider => `<span class="source-pill ${provider.proxyEnabled ? 'proxied' : ''}">${escapeHtml(provider.name)}</span>`).join('');
    if (!health.providers?.length) showNotice('尚未配置数据源。请打开 /admin.html 添加兼容接口。', 'warning');
    const home = await api.home();
    renderHome(home.sections);
    if (home.notice) showNotice(home.notice, 'warning');
  } catch (error) {
    showNotice(error.message || '后端函数未连接', 'error');
  }
})();
