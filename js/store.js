/* =========================================================================
 * 数据层：服务器列表（名字 + IP）的读取与编辑
 *   cloud 模式：Supabase（Postgres）→ 所有人共享同一份数据
 *   local 模式：浏览器 localStorage → 只有本机可见（未接入数据库时的兜底）
 * 只依赖 fetch，不需要任何第三方 SDK，可直接跑在 GitHub Pages 上。
 * ========================================================================= */
(function (global) {
  'use strict';

  var CFG = global.BRJS_CONFIG || {};
  var KEYS = {
    servers: 'brjs:servers:v1',   // local 模式的服务器列表
    auth: 'brjs:auth:v1',         // 登录会话
    db: 'brjs:supabase:v1',       // 本机覆盖的 Supabase 配置
    cache: 'brjs:cloudcache:v1',  // 云端列表缓存（云端故障时兜底显示）
  };

  /* ---------------- localStorage 安全封装 ---------------- */
  function lsGet(k, def) {
    try { var v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function uid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ---------------- 配置 ---------------- */
  function dbConfig() {
    var base = CFG.supabase || {};
    var over = lsGet(KEYS.db, null) || {};
    var url = String(over.url || base.url || '').trim().replace(/\/+$/, '');
    var key = String(over.anonKey || base.anonKey || '').trim();
    var table = String(base.table || 'servers').trim().replace(/[^a-zA-Z0-9_]/g, '') || 'servers';
    var liveView = String(base.liveView || (table + '_live')).trim().replace(/[^a-zA-Z0-9_]/g, '') || (table + '_live');
    return { url: url, anonKey: key, table: table, liveView: liveView };
  }
  function isCloud() {
    var c = dbConfig();
    return !!(c.url && c.anonKey && /^https?:\/\//i.test(c.url));
  }

  /* ---------------- 登录会话 ---------------- */
  var _auth = lsGet(KEYS.auth, null);
  var _listeners = [];

  function notifyAuth() {
    var u = currentUser();
    _listeners.forEach(function (cb) { try { cb(u); } catch (e) {} });
  }
  function onAuth(cb) { if (typeof cb === 'function') _listeners.push(cb); }
  function currentUser() {
    if (!_auth) return null;
    return {
      email: _auth.email || '', id: _auth.user_id || '',
      expired: !!(_auth.expires_at && Date.now() >= _auth.expires_at),
    };
  }
  function saveSession(r) {
    if (!r || !r.access_token) throw new Error('登录接口返回异常');
    var prev = _auth || {};
    _auth = {
      access_token: r.access_token,
      refresh_token: r.refresh_token || prev.refresh_token || null,
      expires_at: Date.now() + ((parseInt(r.expires_in, 10) || 3600) * 1000),
      email: (r.user && r.user.email) || prev.email || '',
      user_id: (r.user && r.user.id) || prev.user_id || '',
    };
    lsSet(KEYS.auth, _auth);
  }
  function clearSession() { _auth = null; lsDel(KEYS.auth); notifyAuth(); }

  /* ---------------- HTTP ---------------- */
  function mapError(status, json, text) {
    var msg = (json && (json.message || json.error_description || json.msg || json.error || json.hint || json.details)) || (text || '').slice(0, 200) || ('HTTP ' + status);
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    if (status === 400 && /invalid login credentials/i.test(msg)) return '邮箱或密码不正确';
    if (status === 400 && /email not confirmed/i.test(msg)) return '该邮箱尚未验证，请到 Supabase 后台确认用户';
    if (status === 401) return '认证失败(401)：' + msg;
    if (status === 403) return '没有权限(403)：' + msg + '（请检查数据表的 RLS 策略）';
    if (status === 404 && /does not exist|relation|schema cache/i.test(msg)) return '数据表不存在：请先在 Supabase SQL Editor 执行建表 SQL';
    if (status === 409) return '数据冲突(409)：' + msg;
    if (status === 429) return '请求过于频繁(429)：' + msg;
    return '请求失败(' + status + ')：' + msg;
  }

  function sbRequest(path, opts) {
    opts = opts || {};
    var cfg = dbConfig();
    if (!isCloud()) return Promise.reject(new Error('尚未配置 Supabase 数据库'));

    var headers = {
      apikey: cfg.anonKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (opts.prefer) headers.Prefer = opts.prefer;

    var tokenPromise = opts.auth ? ensureToken() : Promise.resolve(cfg.anonKey);

    return tokenPromise.then(function (token) {
      if (!token) throw new Error('登录状态已失效，请重新登录');

      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, opts.timeoutMs || 15000);
      headers.Authorization = 'Bearer ' + token;

      return fetch(cfg.url + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl ? ctrl.signal : undefined,
        cache: 'no-store',
      }).then(function (res) {
        return res.text().then(function (text) {
          clearTimeout(timer);
          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) {}
          if (!res.ok) throw new Error(mapError(res.status, json, text));
          return json;
        });
      }, function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') throw new Error('连接 Supabase 超时（' + (opts.timeoutMs || 15000) / 1000 + ' 秒）');
        throw new Error('无法连接 Supabase：请检查 Project URL、网络，或项目是否被暂停');
      });
    });
  }

  function ensureToken() {
    if (!_auth || !_auth.refresh_token) return Promise.resolve(null);
    if (_auth.expires_at && Date.now() < _auth.expires_at - 60000) return Promise.resolve(_auth.access_token);
    return sbRequest('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: _auth.refresh_token },
    }).then(function (r) { saveSession(r); notifyAuth(); return _auth.access_token; })
      .catch(function () { clearSession(); return null; });
  }

  /* ---------------- 行数据规范化 ---------------- */
  function normalizeRow(row, index) {
    return {
      id: String(row.id == null ? uid() : row.id),
      name: String(row.name == null ? '' : row.name).trim() || ('服务器 ' + ((index || 0) + 1)),
      address: String(row.address == null ? '' : row.address).trim(),
      note: String(row.note == null ? '' : row.note).trim(),
      sort_order: typeof row.sort_order === 'number' ? row.sort_order : (parseInt(row.sort_order, 10) || 0),
      enabled: row.enabled !== false,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
    };
  }

  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      var an = a.name || '', bn = b.name || '';
      if (an !== bn) return an < bn ? -1 : 1;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
  }

  /** 解析数据库时间戳（Postgres 给的是带微秒的 ISO 字符串） */
  function parseTs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    var t = Date.parse(String(v).replace(/(\.\d{3})\d+/, '$1'));
    return isFinite(t) ? t : null;
  }

  function toNames(v) {
    var arr = Array.isArray(v) ? v : [];
    return arr.map(function (p) {
      if (typeof p === 'string') return p;
      if (!p) return '';
      return p.name_clean || p.name || p.name_raw || '';
    }).filter(Boolean);
  }

  /**
   * 判断是不是「没有真实身份的占位玩家」。
   * 有些服务器会在 status 的玩家列表里塞空名字 + 全零 UUID 的条目（游戏里显示为 Anonymous Player），
   * 这种不该当成一个真人显示出来。
   */
  var PLACEHOLDER_NAMES = { 'anonymous player': 1, 'anonymous': 1, 'unknown': 1, '未知玩家': 1, '匿名玩家': 1 };
  function isPlaceholderPlayer(p) {
    var name = typeof p === 'string' ? p : (p && (p.name_clean || p.name || p.name_raw)) || '';
    name = String(name).trim();
    if (!name) return true;
    if (PLACEHOLDER_NAMES[name.toLowerCase()]) return true;
    var uuid = (p && typeof p === 'object' && (p.uuid || p.id)) || '';
    var hex = String(uuid).replace(/[^0-9a-fA-F]/g, '');
    if (hex && /^0+$/.test(hex)) return true;      // 全零 UUID = 没有真实身份
    return false;
  }

  /** 拆成「真实玩家名单」+「被过滤掉的占位条目数」 */
  function splitPlayers(value) {
    var arr = Array.isArray(value) ? value : [];
    var names = [];
    var hidden = 0;
    arr.forEach(function (p) {
      var name = typeof p === 'string' ? p : (p && (p.name_clean || p.name || p.name_raw)) || '';
      name = String(name).trim();
      if (!name) return;
      if (isPlaceholderPlayer(p)) { hidden++; return; }
      if (names.indexOf(name) < 0) names.push(name);
    });
    return { names: names, hidden: hidden };
  }

  /**
   * 把「服务器 + 全局状态」视图的一行，整理成前端直接可用的对象。
   * 空服时长（zero_since / longest_zero_ms …）来自数据库，所有人共享同一个值。
   */
  function normalizeLiveRow(row, index) {
    var item = normalizeRow(row, index);
    item.zeroSince = parseTs(row.zero_since);
    item.lastPlayersAt = parseTs(row.last_players_at);
    item.longestZeroMs = Number(row.longest_zero_ms) || 0;
    item.lastZeroMs = Number(row.last_zero_ms) || 0;
    item.checkedAt = parseTs(row.checked_at);
    item.statusError = row.status_error || null;
    item.provider = row.provider || '';
    if (row.online === null || row.online === undefined) {
      item.status = null;                       // 还没查到过
    } else {
      var players = splitPlayers(row.player_names);
      item.status = {
        online: !!row.online,
        playersOnline: Number(row.players_online) || 0,
        playersMax: Number(row.players_max) || 0,
        version: row.version || '',
        motd: row.motd || '',
        playerNames: players.names,
        hiddenPlayers: players.hidden,
        provider: row.provider || '',
        shared: true,                           // 标记：来自数据库，全站一致
      };
    }
    return item;
  }

  /* ---------------- local 模式 ---------------- */
  function seedLocal(force) {
    var existing = lsGet(KEYS.servers, null);
    if (!force && Array.isArray(existing)) return;
    var seeded = (CFG.fallbackServers || []).map(function (s, i) {
      return normalizeRow({
        id: uid(), name: s.name, address: s.address, note: s.note,
        sort_order: (i + 1) * 10, enabled: true, created_at: new Date().toISOString(),
      });
    });
    lsSet(KEYS.servers, seeded);
  }
  function localRows() {
    seedLocal(false);
    var arr = lsGet(KEYS.servers, []);
    if (!Array.isArray(arr)) arr = [];
    return arr.map(normalizeRow);
  }
  function localSave(rows) { lsSet(KEYS.servers, rows); }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 读取服务器列表（云端模式下读的是 servers_live 视图：
   * 一次请求同时拿到「服务器信息 + 数据库统计出来的状态和空服时长」）
   * -> {items, serverNow, shared, stale, error, mode}
   */
  function list() {
    if (!isCloud()) {
      return Promise.resolve({ items: sortRows(localRows()), serverNow: null, shared: false, stale: false, error: null, mode: 'local' });
    }
    var cfg = dbConfig();
    var order = '&order=sort_order.asc.nullslast,created_at.asc';

    return sbRequest('/rest/v1/' + cfg.liveView + '?select=*' + order).then(function (rows) {
      if (!Array.isArray(rows)) throw new Error('数据表返回格式异常');
      var serverNow = rows.length ? parseTs(rows[0].server_now) : null;
      var items = sortRows(rows.map(normalizeLiveRow));
      lsSet(KEYS.cache, { at: Date.now(), items: items, serverNow: serverNow, live: true });
      return { items: items, serverNow: serverNow, shared: true, stale: false, error: null, mode: 'cloud' };
    }).catch(function (err) {
      var msg = err.message || '';
      // 视图不存在（还没执行 supabase/status.sql）→ 退回只读服务器列表，
      // 人数改回由浏览器自己查（老行为），站点不会白屏
      if (/不存在|does not exist|schema cache|Could not find the table|404/i.test(msg)) {
        return sbRequest('/rest/v1/' + cfg.table + '?select=*' + order).then(function (rows) {
          var items = sortRows(rows.map(normalizeRow));
          lsSet(KEYS.cache, { at: Date.now(), items: items, live: false });
          return { items: items, serverNow: null, shared: false, stale: false, error: null, mode: 'cloud' };
        });
      }
      var cached = lsGet(KEYS.cache, null);
      if (cached && Array.isArray(cached.items)) {
        return {
          items: sortRows(cached.items), serverNow: cached.serverNow || null,
          shared: !!cached.live, stale: true, error: msg, mode: 'cloud', cachedAt: cached.at || null,
        };
      }
      return { items: [], serverNow: null, shared: false, stale: false, error: msg, mode: 'cloud' };
    });
  }

  /** 管理员：让数据库立刻查一次所有服务器（结果 1~20 秒内落库） */
  function pollNow() {
    if (!isCloud()) return Promise.reject(new Error('尚未接入 Supabase'));
    return sbRequest('/rest/v1/rpc/poll_now', { method: 'POST', body: {}, auth: true });
  }

  /** 管理员：重置空服计时（不传 id = 重置全部） */
  function resetZero(serverId) {
    if (!isCloud()) return Promise.reject(new Error('尚未接入 Supabase'));
    var body = serverId ? { p_server_id: serverId } : {};
    return sbRequest('/rest/v1/rpc/reset_zero', { method: 'POST', body: body, auth: true });
  }

  /** 新增服务器 */
  function add(item) {
    var row = {
      name: String(item.name || '').trim(),
      address: String(item.address || '').trim(),
      note: String(item.note || '').trim(),
      sort_order: parseInt(item.sort_order, 10) || 0,
      enabled: item.enabled !== false,
    };
    if (!row.name) return Promise.reject(new Error('请填写显示名称'));
    if (!row.address) return Promise.reject(new Error('请填写服务器地址'));

    if (!isCloud()) {
      var rows = localRows();
      var created = normalizeRow(Object.assign({ id: uid(), created_at: new Date().toISOString() }, row));
      rows.push(created);
      localSave(rows);
      return Promise.resolve(created);
    }
    var cfg = dbConfig();
    return sbRequest('/rest/v1/' + cfg.table, {
      method: 'POST', body: row, auth: true, prefer: 'return=representation',
    }).then(function (res) { return normalizeRow(Array.isArray(res) ? res[0] : res); });
  }

  /** 修改服务器（改名 / 改 IP / 排序 / 启停） */
  function update(id, patch) {
    var clean = {};
    ['name', 'address', 'note'].forEach(function (k) {
      if (patch[k] !== undefined) clean[k] = String(patch[k] || '').trim();
    });
    if (patch.sort_order !== undefined) clean.sort_order = parseInt(patch.sort_order, 10) || 0;
    if (patch.enabled !== undefined) clean.enabled = !!patch.enabled;
    if (!Object.keys(clean).length) return Promise.resolve(null);

    if (!isCloud()) {
      var rows = localRows();
      var hit = null;
      rows = rows.map(function (r) {
        if (String(r.id) === String(id)) { hit = Object.assign({}, r, clean, { updated_at: new Date().toISOString() }); return hit; }
        return r;
      });
      localSave(rows);
      return Promise.resolve(hit);
    }
    var cfg = dbConfig();
    return sbRequest('/rest/v1/' + cfg.table + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', body: clean, auth: true, prefer: 'return=representation',
    }).then(function (res) {
      if (Array.isArray(res) && res.length === 0) throw new Error('没有找到这条记录（可能已被其他管理员删除）');
      return normalizeRow(Array.isArray(res) ? res[0] : res);
    });
  }

  /** 删除服务器 */
  function remove(id) {
    if (!isCloud()) {
      localSave(localRows().filter(function (r) { return String(r.id) !== String(id); }));
      return Promise.resolve(true);
    }
    var cfg = dbConfig();
    return sbRequest('/rest/v1/' + cfg.table + '?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE', auth: true, prefer: 'return=representation',
    }).then(function (res) {
      if (Array.isArray(res) && res.length === 0) throw new Error('没有找到这条记录（可能已被其他管理员删除）');
      return true;
    });
  }

  /** 批量写入（导入 JSON 时使用） */
  function addMany(items) {
    var list_ = Array.isArray(items) ? items : [];
    return list_.reduce(function (p, it) {
      return p.then(function () { return add(it); });
    }, Promise.resolve());
  }

  /** 替换 local 模式下的全部数据（导入时使用） */
  function replaceLocal(items) {
    if (isCloud()) return Promise.reject(new Error('云端模式下不支持整表替换，请逐条添加'));
    localSave((items || []).map(function (it, i) {
      return normalizeRow(Object.assign({ id: uid(), created_at: new Date().toISOString(), sort_order: (i + 1) * 10 }, it));
    }));
    return Promise.resolve(true);
  }

  function resetLocal() { seedLocal(true); return Promise.resolve(true); }

  /* ---------------- 登录/登出 ---------------- */
  function signIn(email, password) {
    if (!isCloud()) return Promise.reject(new Error('尚未配置 Supabase 数据库'));
    if (!email || !password) return Promise.reject(new Error('请填写邮箱和密码'));
    return sbRequest('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email: String(email).trim(), password: String(password) },
    }).then(function (r) { saveSession(r); notifyAuth(); return currentUser(); });
  }
  function signOut() {
    var had = !!_auth;
    return (had && isCloud()
      ? sbRequest('/auth/v1/logout', { method: 'POST', auth: true }).catch(function () {})
      : Promise.resolve()
    ).then(function () { clearSession(); return true; });
  }

  /** 连接自检 */
  function test() {
    if (!isCloud()) return Promise.resolve({ ok: false, message: '尚未配置 Supabase：请先填写 Project URL 与 anon key' });
    var cfg = dbConfig();
    return sbRequest('/rest/v1/' + cfg.table + '?select=id&limit=1')
      .then(function (rows) {
        return { ok: true, message: '连接成功，数据表 ' + cfg.table + ' 可用（读到 ' + (Array.isArray(rows) ? rows.length : 0) + ' 行）' };
      }, function (err) { return { ok: false, message: err.message }; });
  }

  global.BRJS = global.BRJS || {};
  global.BRJS.store = {
    mode: function () { return isCloud() ? 'cloud' : 'local'; },
    isCloud: isCloud,
    dbConfig: dbConfig,
    setDbConfig: function (url, key) {
      lsSet(KEYS.db, { url: String(url || '').trim(), anonKey: String(key || '').trim() });
      notifyAuth();
    },
    clearDbConfig: function () { lsDel(KEYS.db); clearSession(); },
    list: list,
    add: add,
    addMany: addMany,
    update: update,
    remove: remove,
    replaceLocal: replaceLocal,
    resetLocal: resetLocal,
    pollNow: pollNow,
    resetZero: resetZero,
    parseTs: parseTs,
    signIn: signIn,
    signOut: signOut,
    currentUser: currentUser,
    onAuth: onAuth,
    test: test,
    sortRows: sortRows,
  };
})(window);
