/* =========================================================================
 * BRJS公益服务器 · 监控站主逻辑
 *   - 实时拉取每个 Java 服务器的在线人数
 *   - 统计每个服务器「连续 0 人在线」的时长（D:H:M:S，每秒走字，刷新页面不丢）
 *   - 管理端：添加/改名/改 IP/排序/停用/删除（云端模式需登录）
 * ========================================================================= */
(function (global) {
  'use strict';

  var CFG = global.BRJS_CONFIG || {};
  var MC = global.BRJS.mcstatus;
  var Store = global.BRJS.store;

  var KEYS = {
    track: 'brjs:track:v1',
    settings: 'brjs:settings:v1',
    banner: 'brjs:banner-closed:v1',
  };

  /* ============================ 小工具 ============================ */
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function loadJson(key, def) {
    try { var v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function saveJson(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 毫秒 -> D:H:M:S */
  function fmtDHMS(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return d + ':' + pad2(h) + ':' + pad2(m) + ':' + pad2(sec);
  }
  function copyText(text, label) {
    if (!text) return;
    var done = function () { toast('已复制' + (label ? '：' + label : '')); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    var ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动复制：' + text, 'err'); }
    document.body.removeChild(ta);
  }

  var toastBox = null;
  function toast(msg, type, ms) {
    if (!toastBox) toastBox = $('#toasts');
    var t = el('div', 'toast' + (type ? ' ' + type : ''), msg);
    toastBox.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, ms || 3200);
  }

  /* ============================ 状态 ============================ */
  var defaults = CFG.defaults || {};
  var state = {
    servers: [],
    runtime: new Map(),          // id -> {status, error, loading, latency, fetchedAt}
    tracking: loadJson(KEYS.track, {}) || {},
    settings: Object.assign(
      { statusSeconds: 60, listSeconds: 15, countOffline: true, showPlayers: true },
      defaults,
      loadJson(KEYS.settings, {}) || {}
    ),
    cards: new Map(),            // id -> {el, refs}
    refreshing: false,
    pendingStatus: [],
    loadingList: false,
    nextStatusAt: 0,
    nextListAt: 0,
    lastUpdatedAt: 0,
    listSig: '',
    dbError: null,
    dbStale: false,
    sharedStatus: false,      // 状态是否来自数据库（全站共享）
    serverOffset: 0,          // 数据库时间 - 本机时间，用于消除访客时钟误差
    editingId: null,
    booted: false,
  };
  var poll = CFG.poll || {};
  state.settings.statusSeconds = clampNum(state.settings.statusSeconds, 15, 3600, 60);
  state.settings.listSeconds = clampNum(state.settings.listSeconds, 10, 3600, 15);
  function clampNum(v, min, max, def) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = def;
    return Math.min(max, Math.max(min, n));
  }

  function getRt(id) {
    var rt = state.runtime.get(id);
    if (!rt) {
      rt = { status: null, error: null, loading: false, latency: 0, fetchedAt: 0 };
      state.runtime.set(id, rt);
    }
    return rt;
  }
  var EMPTY_TRACK = { zeroSince: null, lastPlayersAt: null, longestMs: 0, longestStart: null, lastZeroMs: 0 };
  function tracking(id) {
    var t = state.tracking[id];
    if (!t) {
      t = { zeroSince: null, lastPlayersAt: null, longestMs: 0, longestStart: null, lastZeroMs: 0 };
      state.tracking[id] = t;
    }
    return t;
  }
  function trackingRead(id) { return state.tracking[id] || EMPTY_TRACK; }

  /* ---------------- 数据来自数据库（全站共享）时的辅助函数 ---------------- */
  function isCloud() { return Store.mode() === 'cloud'; }
  /** true = 状态与空服时长由数据库统计，所有人看到同一个数字 */
  function sharedMode() { return isCloud() && state.sharedStatus; }
  /** 校正过本地时钟误差的“现在”（用数据库时间对齐，保证每个人算出的秒数一致） */
  function nowMs() { return Date.now() + (state.serverOffset || 0); }

  /** 取某个服务器的空服计时数据：共享模式读数据库，否则读本机 localStorage */
  function trackingOf(server) {
    if (sharedMode()) {
      return {
        zeroSince: server.zeroSince || null,
        lastPlayersAt: server.lastPlayersAt || null,
        longestMs: server.longestZeroMs || 0,
        longestStart: null,
        lastZeroMs: server.lastZeroMs || 0,
        shared: true,
      };
    }
    return trackingRead(server.id);
  }
  function saveTracking() { saveJson(KEYS.track, state.tracking); }
  function visibleServers() { return state.servers.filter(function (s) { return s.enabled !== false; }); }
  function canEdit() {
    if (Store.mode() === 'local') return true;
    return !!Store.currentUser();
  }

  /* ============================ 站点信息 ============================ */
  function applySiteConfig() {
    var site = CFG.site || {};
    if (site.title) {
      document.title = site.title + ' · Java 服务器在线人数监控';
      $('#siteTitle').textContent = site.title;
    }
    if (site.subtitle) $('#siteSubtitle').textContent = site.subtitle;
  }

  /* ============================ 卡片 ============================ */
  function kindOf(rt) {
    if (!rt.status) return rt.error ? 'error' : 'loading';
    if (!rt.status.online) return 'offline';
    return rt.status.playersOnline > 0 ? 'online' : 'empty';
  }
  var KIND_TEXT = { online: '在线', empty: '空服中', offline: '离线', error: '查询失败', loading: '查询中' };

  function createCard(server) {
    var card = el('article', 'card is-loading');
    card.setAttribute('data-id', server.id);
    card.innerHTML = [
      '<div class="card-head">',
      '  <div class="card-icon" data-r="icon">?</div>',
      '  <div class="card-titles">',
      '    <h3 class="card-name"><span class="dot"></span><span data-r="name"></span><span class="badge" data-r="badge"></span></h3>',
      '    <div class="addr" data-r="addr" title="点击复制服务器地址"><span data-r="addrtext"></span></div>',
      '  </div>',
      '</div>',
      '<div class="players">',
      '  <div class="players-num"><b data-r="online">--</b><i>/</i><i data-r="max">--</i></div>',
      '  <div class="players-meta" data-r="meta"></div>',
      '</div>',
      '<div class="bar"><i data-r="bar" style="width:0%"></i></div>',
      '<div class="player-names hidden" data-r="names"></div>',
      '<div class="zero hidden" data-r="zero">',
      '  <div class="zero-label">0 人在线已持续</div>',
      '  <div class="zero-time" data-r="zerotime">—</div>',
      '</div>',
      '<div class="card-foot hidden" data-r="foot">',
      '  <div class="card-actions" data-r="actions"></div>',
      '</div>',
    ].join('');
    var refs = {};
    Array.prototype.forEach.call(card.querySelectorAll('[data-r]'), function (n) { refs[n.getAttribute('data-r')] = n; });
    refs.addr.addEventListener('click', function () { copyText(server.address, server.address); });

    if (canEdit()) {
      refs.foot.classList.remove('hidden');
      var bEdit = el('button', 'icon-btn', '编辑');
      bEdit.title = '编辑名称 / IP';
      bEdit.addEventListener('click', function () { openEditor(server.id); });
      var bDel = el('button', 'icon-btn', '删除');
      bDel.title = '删除这个服务器';
      bDel.addEventListener('click', function () { removeServer(server); });
      refs.actions.appendChild(bEdit);
      refs.actions.appendChild(bDel);
    }
    return { el: card, refs: refs };
  }

  function updateCard(server, rt) {
    var c = state.cards.get(server.id);
    if (!c) return;
    var r = c.refs;
    var kind = kindOf(rt);
    var cls = 'card is-' + kind;
    if (rt.loading) cls += ' is-loading';
    c.el.className = cls;

    r.name.textContent = server.name;
    r.addrtext.textContent = server.address || '';
    r.addr.title = '点击复制：' + (server.address || '');

    var st = rt.status;
    var badgeClass = kind === 'online' || kind === 'empty' ? 'online' : (kind === 'offline' ? 'offline' : (kind === 'error' ? 'error' : ''));
    var badgeText = KIND_TEXT[kind] || '';
    if (rt.error && st) { badgeClass = 'error'; badgeText = '查询异常'; }   // 显示的是上一次的数据
    r.badge.className = 'badge' + (badgeClass ? ' ' + badgeClass : '');
    r.badge.textContent = badgeText;

    // 图标
    if (st && st.icon) {
      r.icon.style.backgroundImage = 'url("' + st.icon + '")';
      r.icon.style.backgroundSize = 'cover';
      r.icon.textContent = '';
    } else {
      r.icon.style.backgroundImage = '';
      r.icon.textContent = kind === 'offline' ? '☠' : (kind === 'error' ? '?' : '⛏');
    }

    // 人数
    if (st) {
      r.online.textContent = st.online ? String(st.playersOnline) : '0';
      r.max.textContent = st.playersMax > 0 ? String(st.playersMax) : '?';
      var pct = st.playersMax > 0 ? Math.min(100, (st.playersOnline / st.playersMax) * 100) : (st.playersOnline > 0 ? 100 : 0);
      r.bar.style.width = pct + '%';
    } else {
      r.online.textContent = '--';
      r.max.textContent = '--';
      r.bar.style.width = '0%';
    }

    // 右侧信息：只留版本号
    if (st) {
      r.meta.textContent = st.version ? ('版本 ' + st.version) : '';
    } else {
      r.meta.textContent = '';
    }

    // 玩家名单
    var names = st && st.online && st.playerNames ? st.playerNames : [];
    if (state.settings.showPlayers && names.length) {
      r.names.classList.remove('hidden');
      r.names.textContent = '';
      names.forEach(function (n) { r.names.appendChild(el('span', null, n)); });
    } else {
      r.names.classList.add('hidden');
      r.names.textContent = '';
    }

    paintTimer(server, Date.now());
  }

  /** 只更新会走字的部分（每秒调用） */
  function paintTimer(server, now) {
    var c = state.cards.get(server.id);
    if (!c) return;
    var r = c.refs;
    var kind = kindOf(getRt(server.id));
    var t = trackingOf(server);
    // 离线 + 关闭「离线计入」时，即使数据库还在计时，本机也不显示
    var offlineNotCounted = (kind === 'offline') && !state.settings.countOffline;
    var counting = t.zeroSince != null && !offlineNotCounted;

    // 只有真的「0 人在线」时才显示这一块，界面保持干净
    r.zero.classList.toggle('hidden', !counting);
    if (counting) r.zerotime.textContent = fmtDHMS(now - t.zeroSince);
  }

  function renderGrid() {
    var grid = $('#grid');
    grid.textContent = '';
    state.cards.clear();
    visibleServers().forEach(function (s) {
      var c = createCard(s);
      state.cards.set(s.id, c);
      grid.appendChild(c.el);
      updateCard(s, getRt(s.id));
    });
  }

  function removeCard(id) {
    var c = state.cards.get(id);
    if (c && c.el.parentNode) c.el.parentNode.removeChild(c.el);
    state.cards.delete(id);
  }

  function updateEmptyState() {
    var empty = $('#emptyState');
    var none = visibleServers().length === 0;
    empty.classList.toggle('hidden', !none);
    if (!none) return;
    if (state.dbError) {
      $('#emptyTitle').textContent = '读取服务器列表失败';
      $('#emptyDesc').textContent = state.dbError + (canEdit() ? '（可在「管理」里检查数据库配置）' : '（请稍后刷新重试）');
    } else if (canEdit()) {
      $('#emptyTitle').textContent = '还没有添加任何服务器';
      $('#emptyDesc').textContent = '点下面的按钮添加 Java 版服务器（填 IP 或 IP:端口），可以自定义显示名称，支持 1服 / 2服 / 3服 同时监控。';
    } else {
      $('#emptyTitle').textContent = '管理员还没有添加服务器';
      $('#emptyDesc').textContent = '请稍后再来看看，或联系服务器管理员。';
    }
  }

  /* ============================ 总览 ============================ */
  function updateSummary() {
    var list = visibleServers();
    var online = 0, players = 0, empty = 0, failed = 0;
    list.forEach(function (s) {
      var rt = getRt(s.id);
      var st = rt.status;
      if (!st) { if (rt.error) failed++; return; }
      if (st.online) {
        online++;
        players += st.playersOnline;
        if (st.playersOnline === 0) empty++;
      } else if (state.settings.countOffline) {
        empty++;
      }
    });
    $('#statOnline').textContent = String(online);
    $('#statTotal').textContent = String(list.length);
    $('#statPlayers').textContent = String(players);
    $('#statEmpty').textContent = String(empty);
    updateFreshness(nowMs());
  }

  function updateDbPill() {
    var pill = $('#dbPill');
    var mode = Store.mode();
    var user = Store.currentUser();
    var text = '', cls = '', title = '';
    if (mode === 'local') {
      // 没接数据库时，这是必须让站长看到的提示
      cls = 'pill warn'; text = '本地模式';
      title = '尚未接入 Supabase 数据库：服务器列表只保存在你自己的浏览器里';
    } else if (state.dbError) {
      cls = 'pill err';
      text = state.dbStale ? '连接异常（显示缓存）' : '连接异常';
      title = state.dbError;
    } else if (user) {
      // 管理员登录后显示登录状态，方便确认
      cls = 'pill ok'; text = '已登录 ' + (user.email || ''); title = '服务器数据来自 Supabase 数据库';
    }
    // 一切正常且不是管理员时：不显示任何状态标签，界面更干净
    pill.className = cls ? cls : 'pill hidden';
    pill.textContent = text;
    pill.title = title;
    pill.classList.toggle('hidden', !text);

    var banner = $('#setupBanner');
    var dismissed = loadJson(KEYS.banner, false);
    banner.classList.toggle('hidden', mode !== 'local' || !!dismissed);
  }

  /* ============================ 状态轮询 ============================ */
  function runStatus(servers) {
    if (sharedMode()) return refreshList({ silent: true });   // 云端共享：状态由数据库定时刷新
    var list = (servers || visibleServers()).filter(function (s) { return s.enabled !== false && s.address; });
    if (!list.length) return Promise.resolve();
    if (state.refreshing) {
      list.forEach(function (s) { if (state.pendingStatus.indexOf(s) < 0) state.pendingStatus.push(s); });
      return Promise.resolve();
    }
    state.refreshing = true;
    var timeoutMs = poll.timeoutMs || 10000;

    var tasks = list.map(function (server) {
      var rt = getRt(server.id);
      rt.loading = true;
      updateCard(server, rt);
      var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
      return MC.fetchStatus(server.address, { timeoutMs: timeoutMs }).then(function (st) {
        rt.status = st;
        rt.error = null;
      }, function (err) {
        rt.error = (err && err.message) || String(err);
      }).then(function () {
        var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
        rt.loading = false;
        rt.latency = Math.round(t1 - t0);
        rt.fetchedAt = Date.now();
        if (!rt.error) updateTracking(server, rt);
        updateCard(server, rt);
      });
    });

    return Promise.all(tasks).then(function () {
      state.refreshing = false;
      state.lastUpdatedAt = Date.now();
      saveTracking();
      updateSummary();
      if (state.pendingStatus.length) {
        var next = state.pendingStatus.slice();
        state.pendingStatus.length = 0;
        return runStatus(next);
      }
    }, function () {
      state.refreshing = false;
      updateSummary();
    });
  }

  /** 结束一次空服计时并记录最长记录 */
  function closeZero(t, now) {
    if (!t || t.zeroSince == null) return 0;
    var d = now - t.zeroSince;
    t.lastZeroMs = d;
    if (d > (t.longestMs || 0)) { t.longestMs = d; t.longestStart = t.zeroSince; }
    t.zeroSince = null;
    return d;
  }

  /** 0 人在线时长统计 */
  function updateTracking(server, rt) {
    var st = rt.status;
    if (!st) return;
    var now = Date.now();
    var t = tracking(server.id);
    var isEmpty = st.online ? (st.playersOnline <= 0) : !!state.settings.countOffline;

    if (isEmpty) {
      if (t.zeroSince == null) t.zeroSince = now;
    } else {
      closeZero(t, now);
      if (st.online && st.playersOnline > 0) t.lastPlayersAt = now;
    }
  }

  /** 设置改动后立刻结算：原来在计时的离线服务器，若已改成「离线不计入」，就在此刻结束计时 */
  function reconcileTracking() {
    if (state.settings.countOffline) return;
    var now = Date.now();
    var touched = false;
    state.servers.forEach(function (s) {
      var rt = getRt(s.id);
      if (rt.status && !rt.status.online && closeZero(state.tracking[s.id], now) > 0) touched = true;
    });
    if (touched) saveTracking();
  }

  /* ============================ 列表同步 ============================ */
  function refreshList(opts) {
    opts = opts || {};
    if (state.loadingList) return Promise.resolve();
    state.loadingList = true;
    return Store.list().then(function (res) {
      state.dbError = res.error || null;
      state.dbStale = !!res.stale;
      state.sharedStatus = !!res.shared;
      if (res.serverNow) state.serverOffset = res.serverNow - Date.now();
      applyServers(res.items || []);
      updateDbPill();
      if (res.error && !opts.silent) {
        toast('读取服务器列表失败：' + res.error + (res.stale ? '（已显示本地缓存）' : ''), 'err', 6500);
      }
    }, function (err) {
      state.dbError = err.message || String(err);
      updateDbPill();
      if (!opts.silent) toast('读取列表异常：' + state.dbError, 'err', 6500);
    }).then(function () { state.loadingList = false; });
  }

  function applyServers(items) {
    items = (items || []).filter(function (s) { return s && s.address; });
    var prev = {};
    state.servers.forEach(function (s) { prev[s.id] = s; });

    var shared = sharedMode();
    var changed = [];
    items.forEach(function (s) {
      var p = prev[s.id];
      var rt = getRt(s.id);
      if (shared) {
        // 状态直接来自数据库，浏览器不再自己查询
        rt.status = s.status || null;
        rt.error = s.statusError || null;
        rt.fetchedAt = s.checkedAt || 0;
        rt.latency = 0;
        rt.loading = false;
        rt.shared = true;
      } else if (!p || p.address !== s.address) {
        rt.status = null; rt.error = null; rt.fetchedAt = 0; rt.latency = 0;
        changed.push(s);
      }
    });
    // 清理被删除的服务器
    state.servers.forEach(function (s) {
      var still = items.some(function (x) { return x.id === s.id; });
      if (!still) {
        state.runtime.delete(s.id);
        delete state.tracking[s.id];
        removeCard(s.id);
      }
    });

    state.servers = items;
    var sig = items.map(function (s) {
      return [s.id, s.name, s.address, s.note, s.sort_order, s.enabled].join('~');
    }).join('|');
    if (sig !== state.listSig) {
      state.listSig = sig;
      renderGrid();
      renderAdminList();
    }
    updateEmptyState();
    updateSummary();
    if (changed.length && !shared) runStatus(changed);
  }

  /* ============================ 每秒调度 ============================ */
  function tick() {
    var wall = Date.now();
    var shown = nowMs();
    if (!document.hidden) {
      if (sharedMode()) {
        // 云端共享模式：状态和计时都在数据库里，浏览器只需要定时重新读一次
        if (wall >= state.nextListAt && !state.loadingList) {
          state.nextListAt = wall + state.settings.listSeconds * 1000;
          refreshList({ silent: true });
        }
      } else {
        if (wall >= state.nextStatusAt && !state.refreshing) {
          var list = visibleServers().filter(function (s) { return s.address; });
          if (list.length) {
            state.nextStatusAt = wall + state.settings.statusSeconds * 1000;
            runStatus(list);
          } else {
            state.nextStatusAt = wall + 1000;   // 还没有服务器，1 秒后再看
          }
        }
        if (wall >= state.nextListAt && !state.loadingList) {
          state.nextListAt = wall + state.settings.listSeconds * 1000;
          refreshList({ silent: true });
        }
      }
    }
    var nextAt = sharedMode() ? state.nextListAt : state.nextStatusAt;
    $('#statCountdown').textContent = String(Math.max(0, Math.ceil((nextAt - wall) / 1000)));
    updateFreshness(shown);
    state.servers.forEach(function (s) { paintTimer(s, shown); });
  }

  /** 平时不显示任何文字；只有数据确实卡住超过 5 分钟才提示一句 */
  function updateFreshness(shown) {
    var box = $('#statUpdated');
    if (!box) return;
    var msg = '';
    if (sharedMode()) {
      var newest = 0;
      visibleServers().forEach(function (s) { if (s.checkedAt && s.checkedAt > newest) newest = s.checkedAt; });
      if (newest) {
        var lag = shown - newest;
        if (lag > 300000) msg = '⚠ 数据已 ' + Math.floor(lag / 60000) + ' 分钟未更新';
      }
    }
    box.textContent = msg;
    box.classList.toggle('hidden', !msg);
  }

  /* ============================ 管理端 ============================ */
  function openModal() {
    $('#modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    renderAdminPanels();
  }
  function closeModal() {
    $('#modal').classList.add('hidden');
    document.body.style.overflow = '';
  }

  function renderAdminPanels() {
    var mode = Store.mode();
    var user = Store.currentUser();
    var isCloud = mode === 'cloud';

    $('#panelLogin').classList.toggle('hidden', !isCloud);
    $('#panelForm').classList.toggle('hidden', !canEdit());
    $('#btnShowSetup').textContent = isCloud ? '数据源 / 更换数据库' : 'Supabase 接入步骤';

    var cfg = Store.dbConfig();
    $('#cfgUrl').value = cfg.url || '';
    $('#cfgKey').value = cfg.anonKey || '';

    if (isCloud) {
      if (state.dbError) {
        $('#dbDesc').textContent = '云端读取异常：' + state.dbError;
      } else if (state.sharedStatus) {
        $('#dbDesc').textContent = '已连接：' + cfg.url + '（数据表 ' + cfg.table + '）· 在线人数和空服时长由数据库统一统计，'
          + '每分钟自动查询一次，所有访客看到的是同一个数字（没人在看网页时也在继续统计）。';
      } else {
        $('#dbDesc').textContent = '已连接：' + cfg.url + '（数据表 ' + cfg.table + '）· 但还没执行 supabase/status.sql，'
          + '目前是「每个访客各自查询」，不同人看到的空服时长可能不一样。执行后即可全站统一。';
      }
      $('#btnPollNow').classList.toggle('hidden', !(state.sharedStatus && canEdit()));
      $('#fieldStatusPoll').classList.toggle('hidden', !!state.sharedStatus);
      $('#loginState').textContent = user ? ('已登录：' + (user.email || '管理员')) : '未登录（只能查看，不能修改）';
      $('#btnLogout').classList.toggle('hidden', !user);
      $('#btnLogin').classList.toggle('hidden', !!user);
      $('#loginEmail').parentNode.classList.toggle('hidden', !!user);
      $('#loginPassword').parentNode.classList.toggle('hidden', !!user);
      $('#formHint').textContent = user ? '' : '登录后即可添加 / 修改服务器';
    } else {
      $('#dbDesc').textContent = '本地模式：服务器列表和空服时长都只保存在这个浏览器里，其他访客看不到。按下面的步骤接入 Supabase 后，所有人共享同一份数据和同一个计时。';
    }
    renderAdminList();
  }

  function renderAdminList() {
    var box = $('#adminList');
    if (!box) return;
    box.textContent = '';
    if (!state.servers.length) {
      box.appendChild(el('div', 'empty-line', '还没有服务器。用上面的表单添加第一个吧。'));
      return;
    }
    state.servers.forEach(function (s, idx) {
      var row = el('div', 'admin-item');
      var main = el('div', 'ai-main');
      var name = el('div', 'ai-name');
      name.appendChild(el('span', null, s.name));
      if (s.note) name.appendChild(el('span', 'ai-tag', s.note));
      if (s.enabled === false) name.appendChild(el('span', 'ai-tag off', '已停用'));
      name.appendChild(el('span', 'ai-tag', '排序 ' + s.sort_order));
      main.appendChild(name);
      main.appendChild(el('div', 'ai-sub', s.address + (getRt(s.id).status ? (' · ' + KIND_TEXT[kindOf(getRt(s.id))] + ' ' + (getRt(s.id).status.online ? getRt(s.id).status.playersOnline + ' 人' : '')) : '')));
      row.appendChild(main);

      var editable = canEdit();
      var bUp = el('button', 'icon-btn', '↑');
      bUp.title = '上移';
      bUp.disabled = !editable || idx === 0;
      bUp.addEventListener('click', function () { moveServer(s.id, -1); });
      var bDown = el('button', 'icon-btn', '↓');
      bDown.title = '下移';
      bDown.disabled = !editable || idx === state.servers.length - 1;
      bDown.addEventListener('click', function () { moveServer(s.id, 1); });
      var bToggle = el('button', 'icon-btn', s.enabled === false ? '启用' : '停用');
      bToggle.title = s.enabled === false ? '恢复在首页显示' : '暂时从首页隐藏（不再查询）';
      bToggle.disabled = !editable;
      bToggle.addEventListener('click', function () { toggleServer(s); });
      var bEdit = el('button', 'icon-btn', '编辑');
      bEdit.disabled = !editable;
      bEdit.addEventListener('click', function () { openEditor(s.id); });
      var bDel = el('button', 'icon-btn', '删除');
      bDel.disabled = !editable;
      bDel.addEventListener('click', function () { removeServer(s); });
      [bUp, bDown, bToggle, bEdit, bDel].forEach(function (b) {
        b.style.opacity = b.disabled ? '.35' : '';
        b.style.cursor = b.disabled ? 'not-allowed' : 'pointer';
        row.appendChild(b);
      });
      box.appendChild(row);
    });
  }

  function openEditor(id) {
    var s = state.servers.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    if (!canEdit()) { toast('请先登录管理员账号', 'warn'); openModal(); return; }
    state.editingId = id;
    $('#fId').value = id;
    $('#fName').value = s.name;
    $('#fAddress').value = s.address;
    $('#fNote').value = s.note || '';
    $('#fSort').value = s.sort_order;
    $('#formTitle').textContent = '编辑服务器';
    $('#btnSave').textContent = '保存修改';
    $('#formHint').textContent = '正在编辑：' + s.name;
    openModal();
    $('#panelForm').scrollIntoView({ block: 'nearest' });
    $('#fName').focus();
  }

  function resetForm() {
    state.editingId = null;
    $('#fId').value = '';
    $('#serverForm').reset();
    $('#fSort').value = '0';
    $('#formTitle').textContent = '添加服务器';
    $('#btnSave').textContent = '保存';
    $('#formHint').textContent = '';
  }

  function submitForm(ev) {
    ev.preventDefault();
    if (!canEdit()) { toast('请先登录管理员账号', 'warn'); return; }
    var data = {
      name: $('#fName').value.trim(),
      address: MC.normalizeAddress($('#fAddress').value),
      note: $('#fNote').value.trim(),
      sort_order: parseInt($('#fSort').value, 10) || 0,
    };
    if (!data.name) { toast('请填写显示名称', 'err'); return; }
    if (!data.address) { toast('请填写服务器地址', 'err'); return; }

    var btn = $('#btnSave');
    btn.disabled = true;
    var promise = state.editingId
      ? Store.update(state.editingId, data)
      : Store.add(data);
    promise.then(function () {
      toast(state.editingId ? '已保存修改' : '已添加：' + data.name);
      resetForm();
      return refreshList();
    }).catch(function (err) {
      toast('保存失败：' + (err.message || err), 'err', 6000);
    }).then(function () { btn.disabled = false; });
  }

  function removeServer(server) {
    if (!canEdit()) { toast('请先登录管理员账号', 'warn'); return; }
    if (!global.confirm('确定删除「' + server.name + '」吗？\n删除后该服务器的空服计时也会一起清除。')) return;
    Store.remove(server.id).then(function () {
      toast('已删除：' + server.name);
      delete state.tracking[server.id];
      state.runtime.delete(server.id);
      saveTracking();
      return refreshList();
    }).catch(function (err) { toast('删除失败：' + (err.message || err), 'err', 6000); });
  }

  function toggleServer(server) {
    if (!canEdit()) { toast('请先登录管理员账号', 'warn'); return; }
    var next = server.enabled === false;
    Store.update(server.id, { enabled: next }).then(function () {
      toast(next ? ('已启用：' + server.name) : ('已停用：' + server.name));
      return refreshList();
    }).then(function () { if (next) runStatus([server]); })
      .catch(function (err) { toast('操作失败：' + (err.message || err), 'err', 6000); });
  }

  function moveServer(id, dir) {
    if (!canEdit()) { toast('请先登录管理员账号', 'warn'); return; }
    var list = state.servers.slice();
    var idx = -1;
    list.forEach(function (s, i) { if (s.id === id) idx = i; });
    var target = idx + dir;
    if (idx < 0 || target < 0 || target >= list.length) return;
    var tmp = list[idx]; list[idx] = list[target]; list[target] = tmp;

    var tasks = [];
    list.forEach(function (s, i) {
      var desired = (i + 1) * 10;
      if (s.sort_order !== desired) tasks.push(Store.update(s.id, { sort_order: desired }));
    });
    Promise.all(tasks).then(function () { return refreshList(); })
      .catch(function (err) { toast('排序失败：' + (err.message || err), 'err', 6000); });
  }

  /* ============================ 登录 ============================ */
  function doLogin() {
    var email = $('#loginEmail').value.trim();
    var pwd = $('#loginPassword').value;
    var btn = $('#btnLogin');
    btn.disabled = true;
    Store.signIn(email, pwd).then(function (u) {
      toast('登录成功：' + (u && u.email ? u.email : email));
      $('#loginPassword').value = '';
      onAuthChanged();
      return refreshList();
    }).catch(function (err) {
      toast('登录失败：' + (err.message || err), 'err', 6000);
    }).then(function () { btn.disabled = false; });
  }
  function doLogout() {
    Store.signOut().then(function () {
      toast('已退出登录');
      state.editingId = null;
      onAuthChanged();
      renderGrid();
    });
  }
  function onAuthChanged() {
    var u = Store.currentUser();
    var mode = Store.mode();
    updateDbPill();
    renderAdminPanels();
    renderGrid();
    $('#panelLogin').classList.toggle('hidden', mode !== 'cloud');
    $('#panelForm').classList.toggle('hidden', !canEdit());
    if (!u && mode === 'cloud') $('#loginState').textContent = '未登录（只能查看，不能修改）';
  }

  /* ============================ 设置 / 工具 ============================ */
  function bindSettings() {
    $('#setPoll').value = String(state.settings.statusSeconds);
    $('#setListPoll').value = String(state.settings.listSeconds);
    $('#setCountOffline').checked = !!state.settings.countOffline;
    $('#setShowPlayers').checked = !!state.settings.showPlayers;
  }
  function saveSettings() {
    state.settings.statusSeconds = parseInt($('#setPoll').value, 10) || 60;
    state.settings.listSeconds = parseInt($('#setListPoll').value, 10) || 15;
    state.settings.countOffline = $('#setCountOffline').checked;
    state.settings.showPlayers = $('#setShowPlayers').checked;
    saveJson(KEYS.settings, state.settings);
    state.nextStatusAt = 0;
    state.nextListAt = 0;
    reconcileTracking();
    renderGrid();
    updateSummary();
    toast('设置已保存（仅本机生效）');
  }

  function exportJson() {
    var data = state.servers.map(function (s, i) {
      return { name: s.name, address: s.address, note: s.note, sort_order: s.sort_order, enabled: s.enabled !== false };
    });
    if (!data.length) { toast('还没有服务器可以导出', 'warn'); return; }
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'brjs-servers.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('已导出 ' + data.length + ' 个服务器');
  }

  function importJson(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); } catch (e) { toast('JSON 解析失败：' + e.message, 'err'); return; }
      if (data && !Array.isArray(data) && Array.isArray(data.servers)) data = data.servers;
      if (!Array.isArray(data)) { toast('JSON 格式不对，应为服务器数组', 'err'); return; }
      if (!canEdit()) { toast('请先登录管理员账号', 'warn'); return; }
      var p = Store.mode() === 'cloud' ? Store.addMany(data) : Store.replaceLocal(data);
      p.then(function () {
        toast('已导入 ' + data.length + ' 个服务器');
        return refreshList();
      }).catch(function (err) { toast('导入失败：' + (err.message || err), 'err', 6000); });
    };
    reader.readAsText(file, 'utf-8');
  }

  function resetTimers() {
    if (sharedMode()) {
      if (!canEdit()) { toast('请先登录管理员账号', 'warn'); return; }
      if (!global.confirm('确定重置全站的空服计时吗？\n（所有服务器从 0 重新开始，所有访客都会看到归零）')) return;
      Store.resetZero().then(function () {
        toast('已重置全站空服计时');
        return refreshList();
      }).catch(function (err) { toast('重置失败：' + (err.message || err), 'err', 6000); });
      return;
    }
    if (!global.confirm('确定重置所有服务器的空服计时吗？\n（当前正在统计的时长会从 0 重新开始）')) return;
    state.tracking = {};
    saveTracking();
    state.servers.forEach(function (s) { paintTimer(s, nowMs()); });
    toast('空服计时已重置');
  }

  /** 管理员：让数据库立刻查一次（正常情况每分钟自动查，这里用于手动催一下） */
  function pollNow() {
    if (!canEdit()) { toast('请先登录管理员账号', 'warn'); return; }
    if (!isCloud()) { toast('本地模式下浏览器自己查询，无需此操作'); return; }
    var btn = $('#btnPollNow');
    btn.disabled = true;
    toast('已通知数据库查询，约 5~20 秒后更新…');
    Store.pollNow().then(function () {
      return new Promise(function (r) { setTimeout(r, 5000); });
    }).then(function () {
      return refreshList({ silent: true });
    }).then(function () {
      toast('已刷新');
      state.nextListAt = 0;
    }).catch(function (err) {
      toast('操作失败：' + (err.message || err), 'err', 6000);
    }).then(function () { btn.disabled = false; });
  }

  var SQL_FALLBACK = [
    'create table if not exists public.servers (',
    '  id uuid primary key default gen_random_uuid(),',
    '  name text not null,',
    '  address text not null,',
    '  note text default \'\',',
    '  sort_order integer not null default 0,',
    '  enabled boolean not null default true,',
    '  created_at timestamptz not null default now(),',
    '  updated_at timestamptz not null default now()',
    ');',
    'alter table public.servers enable row level security;',
    'create policy "servers_public_read" on public.servers for select using (true);',
    'create policy "servers_auth_write" on public.servers for insert to authenticated with check (true);',
    'create policy "servers_auth_update" on public.servers for update to authenticated using (true) with check (true);',
    'create policy "servers_auth_delete" on public.servers for delete to authenticated using (true);',
  ].join('\n');

  function copySql() {
    fetch('supabase/schema.sql', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : SQL_FALLBACK; })
      .catch(function () { return SQL_FALLBACK; })
      .then(function (sql) { copyText(sql, '建表 SQL（粘贴到 Supabase 的 SQL Editor 执行）'); });
  }

  function copySql2() {
    fetch('supabase/status.sql', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (sql) { copyText(sql, '共享状态 SQL（让全站空服时长统一，粘贴到 SQL Editor 执行）'); })
      .catch(function () { toast('读取失败，请手动打开仓库里的 supabase/status.sql 复制内容', 'err', 6000); });
  }

  function saveDbConfig() {
    var url = $('#cfgUrl').value.trim();
    var key = $('#cfgKey').value.trim();
    if (!url || !key) { toast('请把 Project URL 和 anon key 都填上', 'err'); return; }
    if (!/^https?:\/\//i.test(url)) { toast('Project URL 应以 https:// 开头', 'err'); return; }
    Store.setDbConfig(url, key);
    toast('已保存本机配置，正在测试连接…');
    Store.test().then(function (r) {
      toast(r.message || (r.ok ? '连接成功' : '连接失败'), r.ok ? undefined : 'err', r.ok ? 3500 : 7000);
      state.dbError = r.ok ? null : r.message;
      updateDbPill();
      onAuthChanged();
      refreshList();
    });
  }

  /* ============================ 事件绑定 ============================ */
  function bindEvents() {
    $('#btnRefresh').addEventListener('click', function () {
      state.nextStatusAt = 0;
      state.nextListAt = 0;
      toast('正在刷新…');
      refreshList({ silent: true }).then(function () { runStatus(); });
    });
    $('#btnAdmin').addEventListener('click', openModal);
    $('#modalClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', function (e) { if (e.target === $('#modal')) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    $('#emptyAction').addEventListener('click', function () {
      openModal();
      if (canEdit()) { resetForm(); $('#fName').focus(); }
    });

    $('#serverForm').addEventListener('submit', submitForm);
    $('#btnCancelEdit').addEventListener('click', function () { resetForm(); renderAdminPanels(); });
    $('#btnLogin').addEventListener('click', doLogin);
    $('#loginPassword').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('#btnLogout').addEventListener('click', doLogout);

    $('#btnShowSetup').addEventListener('click', function () {
      $('#panelSetup').classList.toggle('hidden');
      if (!$('#panelSetup').classList.contains('hidden')) {
        $('#panelSetup').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    $('#btnCopySql').addEventListener('click', copySql);
    $('#btnCopySql2').addEventListener('click', copySql2);
    $('#btnPollNow').addEventListener('click', pollNow);
    $('#btnSaveCfg').addEventListener('click', saveDbConfig);
    $('#btnClearCfg').addEventListener('click', function () {
      Store.clearDbConfig();
      toast('已清除本机 Supabase 配置');
      onAuthChanged();
      refreshList();
    });
    $('#btnTestDb').addEventListener('click', function () {
      Store.test().then(function (r) { toast(r.message, r.ok ? undefined : 'err', r.ok ? 3500 : 7000); });
    });

    $('#bannerAction').addEventListener('click', function () {
      openModal();
      $('#panelSetup').classList.remove('hidden');
    });
    $('#bannerClose').addEventListener('click', function () {
      saveJson(KEYS.banner, true);
      $('#setupBanner').classList.add('hidden');
    });

    $('#setPoll').addEventListener('change', saveSettings);
    $('#setListPoll').addEventListener('change', saveSettings);
    $('#setCountOffline').addEventListener('change', function () {
      saveSettings();
      state.nextStatusAt = 0;
    });
    $('#setShowPlayers').addEventListener('change', saveSettings);

    $('#btnExport').addEventListener('click', exportJson);
    $('#btnImport').addEventListener('click', function () { $('#fileImport').click(); });
    $('#fileImport').addEventListener('change', function (e) {
      importJson(e.target.files && e.target.files[0]);
      e.target.value = '';
    });
    $('#btnResetTimers').addEventListener('click', resetTimers);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (Date.now() - state.lastUpdatedAt > state.settings.statusSeconds * 1000) state.nextStatusAt = 0;
      if (Date.now() - state.nextListAt > 0) state.nextListAt = 0;
    });
  }

  /* ============================ 启动 ============================ */
  function boot() {
    if (!MC || !Store) {
      document.body.innerHTML = '<p style="padding:24px">脚本加载失败，请刷新页面。</p>';
      return;
    }
    applySiteConfig();
    bindEvents();
    bindSettings();
    Store.onAuth(onAuthChanged);
    updateDbPill();
    updateEmptyState();
    updateSummary();
    refreshList();
    state.nextStatusAt = Date.now() + 400;   // 列表读回来后马上查一次人数
    state.nextListAt = Date.now() + state.settings.listSeconds * 1000;
    tick();
    setInterval(tick, 1000);
    state.booted = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
