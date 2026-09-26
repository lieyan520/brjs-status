/* =========================================================================
 * Minecraft Java 版服务器状态查询
 * 走公共 HTTP 接口（浏览器无法直接连 MC 的 TCP 25565 端口）：
 *   1) api.mcstatus.io/v2   （默认首选）
 *   2) api.mcsrvstat.us/v3  （自动兜底）
 * 两个接口都支持跨域(CORS)，任意一个成功即可。
 * ========================================================================= */
(function (global) {
  'use strict';

  var CONCURRENCY = 2;      // 同时最多发起的请求数，避免触发限流
  var MIN_GAP_MS = 250;     // 两次请求之间的最小间隔

  var _active = 0;
  var _queue = [];
  var _lastStart = 0;

  function acquire() {
    if (_active < CONCURRENCY) { _active++; return Promise.resolve(); }
    return new Promise(function (resolve) { _queue.push(resolve); });
  }
  function release() {
    _active--;
    var next = _queue.shift();
    if (next) { _active++; next(); }
  }
  function throttle() {
    var wait = Math.max(0, MIN_GAP_MS - (Date.now() - _lastStart));
    _lastStart = Date.now() + wait;
    return wait > 0 ? new Promise(function (r) { setTimeout(r, wait); }) : Promise.resolve();
  }

  /* ---------------- 工具 ---------------- */

  function normalizeAddress(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ''); // 去掉 http:// 之类
    s = s.split('/')[0].split('?')[0].split('#')[0];    // 去掉路径
    s = s.replace(/\s+/g, '');
    return s;
  }

  function encodeAddress(addr) {
    var m = /^\[(.+)\](?::(\d+))?$/.exec(addr); // IPv6
    if (m) return '[' + encodeURIComponent(m[1]) + ']' + (m[2] ? ':' + m[2] : '');
    return addr.split(':').map(encodeURIComponent).join(':');
  }

  function cleanMotd(value) {
    if (!value) return '';
    var arr = Array.isArray(value) ? value : String(value).split('\n');
    var text = arr.join(' ');
    return text
      .replace(/§#[0-9a-fA-F]{6}/g, '')   // 1.16+ RGB 颜色
      .replace(/§[0-9a-fk-orA-FK-OR]/g, '') // 传统颜色/格式代码
      .replace(/\s+/g, ' ')
      .trim();
  }

  function num(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return isFinite(n) && n >= 0 ? n : 0;
  }

  function friendlyError(err) {
    var msg = (err && err.message) || String(err);
    if (err && (err.name === 'AbortError' || /aborted|abort/i.test(msg))) return '请求超时';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return '网络错误或接口被拦截';
    if (/HTTP 429/.test(msg)) return '接口限流(429)，稍后自动重试';
    if (/HTTP 5\d\d/.test(msg)) return '接口服务器故障(' + msg.replace(/\D/g, '') + ')';
    return msg;
  }

  function getJson(url, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    var timerPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        var e = new Error('请求超时'); e.name = 'AbortError'; reject(e);
      }, timeoutMs);
    });
    var fetchPromise = fetch(url, {
      signal: ctrl ? ctrl.signal : undefined,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      mode: 'cors',
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
    return Promise.race([fetchPromise, timerPromise]).then(function (json) {
      clearTimeout(timer);
      return json;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  /* ---------------- 接口实现 ---------------- */

  var PROVIDERS = [
    {
      id: 'mcstatus.io',
      label: 'mcstatus.io',
      buildUrl: function (addr) { return 'https://api.mcstatus.io/v2/status/java/' + encodeAddress(addr); },
      parse: function (j, addr) {
        if (!j || typeof j !== 'object' || typeof j.online !== 'boolean') throw new Error('接口返回格式异常');
        var p = j.players || {};
        var list = Array.isArray(p.list) ? p.list : [];
        return {
          online: !!j.online,
          playersOnline: num(p.online),
          playersMax: num(p.max),
          version: (j.version && (j.version.name_clean || j.version.name_raw)) || '',
          motd: cleanMotd(j.motd && (j.motd.clean || j.motd.raw)),
          icon: typeof j.icon === 'string' ? j.icon : '',
          playerNames: list.map(function (x) { return (x && (x.name_clean || x.name_raw)) || ''; }).filter(Boolean),
          software: j.software || '',
          host: j.host || addr,
          port: j.port || null,
          provider: 'mcstatus.io',
        };
      },
    },
    {
      id: 'mcsrvstat.us',
      label: 'mcsrvstat.us',
      buildUrl: function (addr) { return 'https://api.mcsrvstat.us/3/' + encodeAddress(addr); },
      parse: function (j, addr) {
        if (!j || typeof j !== 'object' || typeof j.online !== 'boolean') throw new Error('接口返回格式异常');
        var p = j.players || {};
        var list = Array.isArray(p.list) ? p.list : [];
        return {
          online: !!j.online,
          playersOnline: num(p.online),
          playersMax: num(p.max),
          version: j.version || '',
          motd: cleanMotd(j.motd && (j.motd.clean || j.motd.raw)),
          icon: typeof j.icon === 'string' ? j.icon : '',
          playerNames: list.map(function (x) { return (x && (x.name || x.name_clean)) || ''; }).filter(Boolean),
          software: j.software || '',
          host: j.hostname || j.ip || addr,
          port: j.port || null,
          provider: 'mcsrvstat.us',
        };
      },
    },
  ];

  var lastGood = {}; // address -> provider id，上次成功的接口优先复用

  function orderedProviders(addr) {
    var preferred = lastGood[addr];
    if (!preferred) return PROVIDERS.slice();
    return PROVIDERS.slice().sort(function (a, b) {
      return (a.id === preferred ? -1 : 0) - (b.id === preferred ? -1 : 0);
    });
  }

  /**
   * 查询一个 Java 服务器的状态。
   * @param {string} address 例如 "play.example.com" 或 "1.2.3.4:25566"
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<object>} 统一格式的状态对象（online=false 也是成功返回）
   */
  function fetchStatus(address, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 10000;
    var addr = normalizeAddress(address);
    if (!addr) return Promise.reject(new Error('服务器地址为空'));

    var providers = orderedProviders(addr);
    var errors = [];

    function attempt(i) {
      if (i >= providers.length) {
        var e = new Error(errors.join('；') || '查询失败');
        e.code = 'ALL_PROVIDERS_FAILED';
        e.details = errors.slice();
        throw e;
      }
      var prov = providers[i];
      return getJson(prov.buildUrl(addr), timeoutMs).then(function (json) {
        var data = prov.parse(json, addr);
        lastGood[addr] = prov.id;
        data.address = addr;
        data.fetchedAt = Date.now();
        return data;
      }, function (err) {
        errors.push(prov.label + '(' + friendlyError(err) + ')');
        return attempt(i + 1);
      });
    }

    return acquire()
      .then(throttle)
      .then(function () { return attempt(0); })
      .then(function (r) { release(); return r; }, function (e) { release(); throw e; });
  }

  global.BRJS = global.BRJS || {};
  global.BRJS.mcstatus = {
    fetchStatus: fetchStatus,
    normalizeAddress: normalizeAddress,
    cleanMotd: cleanMotd,
    providers: PROVIDERS.map(function (p) { return { id: p.id, label: p.label }; }),
  };
})(window);
