(function () {
  'use strict';

  var button = document.getElementById('clearBrowserCache');
  if (!button) return;

  var label = button.querySelector('.settings-cache-button-label');
  var toast = document.getElementById('toast');

  function show(message, kind) {
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast ' + (kind || '');
    clearTimeout(show.timer);
    show.timer = setTimeout(function () { toast.classList.add('hidden'); }, 4200);
  }

  function clearApiSessionCache() {
    try {
      Object.keys(sessionStorage).forEach(function (key) {
        if (key.indexOf('cactus:api:') === 0) sessionStorage.removeItem(key);
      });
    } catch (_) {}
  }

  function clearCacheStorage() {
    if (!window.caches || typeof window.caches.keys !== 'function') return Promise.resolve();
    return window.caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) { return window.caches.delete(key); }));
    }).then(function () {});
  }

  function removeOldServiceWorkers() {
    if (!navigator.serviceWorker || typeof navigator.serviceWorker.getRegistrations !== 'function') return Promise.resolve();
    return navigator.serviceWorker.getRegistrations().then(function (registrations) {
      return Promise.all(registrations.map(function (registration) { return registration.unregister(); }));
    }).then(function () {});
  }

  function requestHttpCacheClear() {
    if (typeof fetch !== 'function') return Promise.resolve();
    return fetch('/api/browser-cache', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    }).then(function () {}).catch(function () {});
  }

  function reloadFresh() {
    var url;
    try {
      url = new URL(window.location.href);
      url.searchParams.set('_fresh', Date.now().toString(36));
      window.location.replace(url.toString());
    } catch (_) {
      window.location.reload();
    }
  }

  button.addEventListener('click', function () {
    var confirmed = window.confirm('只清除当前浏览器中的 Cactus TV 缓存，不会删除 D1 云端数据、片单、观看历史或播放进度。继续吗？');
    if (!confirmed || button.disabled) return;

    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (label) label.textContent = '清理中';
    show('正在清理本地缓存…');
    clearApiSessionCache();

    Promise.all([
      requestHttpCacheClear(),
      clearCacheStorage(),
      removeOldServiceWorkers()
    ]).then(function () {
      show('本地缓存已清除，正在重新加载');
      if (label) label.textContent = '完成';
      setTimeout(reloadFresh, 520);
    }).catch(function () {
      show('已清理可访问缓存，正在重新加载', 'warning');
      setTimeout(reloadFresh, 520);
    });
  });
})();
