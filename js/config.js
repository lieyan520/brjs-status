/* =========================================================================
 * BRJS公益服务器 · 监控站配置文件
 * 改完这个文件后提交到 GitHub，GitHub Pages 会自动重新部署。
 * ========================================================================= */
window.BRJS_CONFIG = {

  /* ---------------- 1. 站点信息 ---------------- */
  site: {
    title: 'BRJS公益服务器',
    subtitle: 'Java 版服务器实时在线人数监控',
    footerTitle: 'BRJS公益服务器',
    githubUrl: 'https://github.com/lieyan520/brjs-status',   // 页脚显示的仓库链接，留空则不显示
  },

  /* ---------------- 2. Supabase 云数据库 ----------------
   * 服务器列表（名字 + IP）存在这里，所有人打开网页看到的是同一份。
   * 填好下面两项即可生效；详细步骤见 README.md 或页面「管理 → Supabase 接入步骤」。
   */
  supabase: {
    url: 'https://sklxftvplszxxhrjkpkf.supabase.co',   // ← Supabase 的 Project URL
    anonKey: 'sb_publishable_YVqaMUcKltEzhj3ZtGBlUQ_jkyehwf3',  // ← 公开密钥（可安全放在前端，写入权限由登录 + RLS 控制）
    table: 'servers',     // 数据表名，用建表 SQL 默认的 servers 即可
  },

  /* ---------------- 3. 刷新设置 ---------------- */
  poll: {
    statusSeconds: 60,    // 玩家人数刷新间隔（秒）。公共接口有限流，建议不要低于 30
    listSeconds: 15,      // 服务器列表同步间隔（秒）：你在后台改了 IP，多久对所有访客生效
    timeoutMs: 10000,     // 单次查询超时（毫秒）
  },

  /* ---------------- 4. 默认显示设置（访客可在「管理 → 显示设置」自行修改） ---------------- */
  defaults: {
    countOffline: true,   // 服务器离线时，是否也计入「0 人在线时长」
    showPlayers: true,    // 是否显示在线玩家名单
  },

  /* ---------------- 5. 兜底服务器列表 ----------------
   * 仅在「未接入 Supabase」或「云端读取失败」时用于显示，可以留空 []。
   * 格式：{ name: '显示名称', address: 'IP 或 域名:端口', note: '备注' }
   */
  fallbackServers: [
    { name: 'BRJS 1服', address: 't36.sjcmc.cn:14421', note: '1服 · 整合包轮换' },
    { name: 'BRJS 2服', address: 't36.sjcmc.cn:14484', note: '2服 · 1.20.1' },
  ],
};
