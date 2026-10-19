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
    showFreshness: true,   // 是否显示「数据 Xs 前」的新鲜度提示（改成 false 可完全隐藏）
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
    statusSeconds: 60,    // 仅「本地模式」用：浏览器自己查服的间隔（秒）
    listSeconds: 8,       // 云端模式读数据库的间隔（秒）。只读一次小接口，8 秒很轻
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
    { name: '农场物语', address: 'w41.kkwmc.cn:1359', note: '1服 · 整合包轮换' },
    { name: 'RLCraft', address: 'w41.kkwmc.cn:1360', note: '2服 · 1.20.1' },
    { name: '末日余晖', address: 'w41.kkwmc.cn:1361', note: '3服' },
  ],
};
