# BRJS公益服务器 · 监控站

一个纯静态的 Minecraft **Java 版**服务器监控网站：实时显示每个服务器的在线人数，并统计每个服务器**连续 0 人在线**的时长（`D:H:M:S` 天:时:分:秒）。
前端托管在 **GitHub Pages**（免费、无需服务器）；服务器列表和状态都存在 **Supabase 免费云数据库**里，**由数据库自己每分钟去查一次所有服务器**——所以所有人看到的人数、空服时长都是同一个数字，而且没人在看网页的时候也在继续统计。

```
┌── GitHub Pages ───────────────┐   读   ┌── Supabase (Postgres) ─────────────┐
│  网页 (HTML/CSS/JS)           │ <────> │  servers 表   （名字/IP/排序）      │
│  · 卡片显示人数 + 空服计时     │        │  server_status（人数/空服起点/记录）│
│  · 管理端增删改（需登录）      │  写    │  servers_live 视图（一次读完）      │
└───────────────────────────────┘        └───────────────┬────────────────────┘
                                                         │ pg_cron 每分钟
                                                         ▼
                              api.mcstatus.io  ⇄  api.mcsrvstat.us
                              （数据库直接查询，失败自动换备用接口）
```

---

## 一、功能

| 功能 | 说明 |
| --- | --- |
| 实时人数 | 每个服务器显示「在线人数 / 最大人数」、进度条、版本、MOTD、在线玩家名单 |
| 空服时长 | 「0 人在线已持续 D:H:M:S」，每秒走字；**由数据库统一统计，所有人看到的数字完全一致**，关掉网页也在继续计时 |
| 空服记录 | 顺手记录「最长空服记录」「上次有人在线」「本次空服开始时间」 |
| 动态加服 | 管理端可随时添加服务器，自定义显示名称（支持 1服 / 2服 / 3服 多服并行监控） |
| 改 IP | 整合包轮换导致 IP 经常变？管理端点「编辑」改地址即可，全站 1 分钟内看到新数据，IP 变更不会清零空服计时 |
| 排序 / 停用 | 上下移动调整顺序；临时维护的服可以「停用」，首页不显示也不再查询 |
| 总览 | 顶部汇总「在线服务器数 / 总在线人数 / 空服中服务器数 / 下次刷新倒计时」 |
| 容错 | 主接口失败自动换备用接口；数据库临时挂了显示本地缓存，不会白屏 |
| 导出备份 | 一键导出服务器列表 JSON |

---

## 二、目录结构

```
├─ index.html                  网页结构
├─ css/style.css               样式
├─ js/config.js                ★ 配置文件（站点名、Supabase 地址、刷新间隔）
├─ js/mcstatus.js              MC 状态查询（未接数据库时的本机查询 / 双接口容错）
├─ js/store.js                 数据层（Supabase REST + 本地 localStorage）
├─ js/app.js                   主逻辑（渲染、计时、管理端）
├─ supabase/schema.sql         ★ 建表脚本（服务器列表 + 权限）
├─ supabase/status.sql         ★ 全局状态脚本（数据库定时查询 + 统一空服计时）
└─ .nojekyll                   让 GitHub Pages 原样发布（不走 Jekyll）
```

---

## 三、部署到 GitHub Pages（约 3 分钟）

1. 在 GitHub 上新建一个 **Public** 仓库，例如 `brjs-status`
   （免费账号的 Pages 只支持公开仓库；Private 仓库要 GitHub Pro）。
2. 在本地这个文件夹里执行（把地址换成你自己的仓库地址）：

   ```bash
   git init
   git add .
   git commit -m "BRJS 服务器监控站"
   git branch -M main
   git remote add origin https://github.com/你的用户名/brjs-status.git
   git push -u origin main
   ```

3. 打开仓库 **Settings → Pages → Build and deployment → Source**，选 **Deploy from a branch**，
   Branch 选 **main**，目录选 **/ (root)**，保存。
4. 等 1 分钟左右刷新页面，访问地址是：

   ```
   https://你的用户名.github.io/brjs-status/
   ```

> 之后每次 `git push`，网站约 1 分钟内自动更新。
> 想改用 GitHub Actions 发布：在 `Settings → Pages → Source` 选 `GitHub Actions`，
> 并把一份 Pages 工作流放进 `.github/workflows/`（注意：推送工作流文件需要 GitHub Token 具备 `workflow` 权限）。

---

## 四、接入 Supabase 数据库（约 5 分钟，免费）

没有数据库时网站也能跑，但添加的服务器**只存在你自己浏览器里**（页面顶部会显示黄色「本地模式」提示）。

1. 打开 <https://supabase.com> 注册，**New project** 建一个项目（Region 随便选，免费版够用）。
2. 左侧 **SQL Editor → New query**，把 `supabase/schema.sql` 的全部内容粘进去，点 **Run**。
   （也可以直接在网页「管理 → Supabase 接入步骤 → 复制建表 SQL」一键复制。）
3. **再新建一个查询**，把 `supabase/status.sql` 的全部内容粘进去，点 **Run**。
   这一步让数据库每分钟自己去查所有服务器、统一统计空服时长——**跳过这一步网站也能跑，但空服时长会变成"每个访客各算各的"**。
4. 左侧 **Project Settings → API**，复制两个值：
   - **Project URL**，例如 `https://abcdefghijkl.supabase.co`
   - **anon public key**（`eyJ...` 或 `sb_publishable_...` 开头）
5. 把这两个值填到 `js/config.js`：

   ```js
   supabase: {
     url: 'https://abcdefghijkl.supabase.co',
     anonKey: 'eyJhbGciOi...',
     table: 'servers',        // servers_live 视图会自动按 servers_live 读取
   },
   ```

   然后 `git commit && git push`。**必须在这里填**，因为这样所有访客打开网页才知道去哪里读数据。
   （页面「管理 → Supabase 接入步骤」里填的只保存在你自己浏览器，适合先测试。）
6. 创建管理员账号：**Authentication → Users → Add user → Create new user**，
   填一个邮箱 + 密码，勾选 **Auto Confirm User**。
7. ⚠️ **重要**：**Authentication → Sign In / Providers → Email**，关闭 **Allow new users to sign up**。
   否则任何人都能自己注册账号来改你的服务器列表。
   （想更严格可以执行 `schema.sql` 末尾注释里的「白名单方案」。）
8. 刷新网站，右上角应显示绿色「云端已连接」，卡片上会标注「数据库统计」。点「管理」用邮箱密码登录，就可以加服 / 改 IP 了。

---

## 五、日常使用

**添加服务器**：管理 → 登录 → 填「显示名称」+「服务器地址（IP 或 域名:端口）」→ 保存。
名称随你写，例如 `BRJS 1服 · 宝可梦整合包`；地址只填 `play.example.com` 时默认按 25565 端口查询。

**改 IP（整合包轮换）**：卡片右上角「编辑」或管理列表里的「编辑」→ 改地址 → 保存。
地址一变会立刻重新查询；**空服计时不会被清零**（同一个服务器的身份跟着记录走，方便看「这个服到底空了多久」）。

**排序**：管理列表里的 `↑` `↓`；也可以在编辑框里直接填排序数字（越小越靠前）。

**临时维护**：管理列表里的「停用」——首页不再显示、也不再发查询请求，数据保留，随时「启用」回来。

**访客能做什么**：只能看。所有修改都需要登录（本地模式下例外，因为数据只在你自己的浏览器里）。

---

## 六、「0 人在线时长」的计算规则（全站统一）

- **由数据库统计，不是浏览器**：Supabase 里的定时任务（pg_cron）每分钟对每个服务器发一次查询，
  把「在线人数 + 连续 0 人的起点时间」写进 `server_status` 表。所有访客读的都是同一行、同一个时间戳，
  所以**每个人看到的数字完全一致**；没人在看网页的时候也在继续统计。
- **离线也算 0 人**（离线当然没人玩）。想按自己的习惯看，可以在「管理 → 显示设置」里关掉「离线计入」，
  那只是你自己界面上不显示，不影响全局的那个数字。
- **只认成功的查询**：查询失败（超时/限流）时不会改动计时，宁可多算也不错算——所以服务器挂了、接口抽风都不会让计时归零。
- 计时格式 `D:H:M:S`（天:时:分:秒），每秒刷新；精度是「分钟级」（数据库每分钟查一次），秒数显示的是真实流逝时间。
- **换 IP 不清零**：同一个服务器的身份跟着记录走，改了地址计时继续，方便看「这个服到底空了多久」。
- 想手动归零：管理 → 数据工具 → 「重置空服计时」（仅管理员，全站生效）。
- 数据库里同时记录「最长空服记录」和「上次有人在线时间」，这两个也是全局共享的。

> 没执行 `supabase/status.sql`（或没有用 Supabase）时，网站会自动退回「每个访客用浏览器自己查」的老模式：
> 人数照常显示，但空服时长会变成各人各算。页面在管理端会明确提示当前处于哪种模式。

---

## 七、本地预览

不要直接双击 `index.html`（`file://` 下部分浏览器会拦截接口请求），用任意静态服务器：

```bash
# 任选一种
python -m http.server 8000
npx serve .
```

然后访问 <http://127.0.0.1:8000>。

---

## 八、常见问题

**Q：为什么人数和游戏里差一两个？**
公共接口有缓存（mcstatus.io 约 30 秒，mcsrvstat.us 约 5 分钟），网页本身也有刷新间隔。服务端装了假人/隐身插件时也可能统计不到。

**Q：查询失败 / 一直显示「查询失败」？**
① 地址写错（必须是 Java 版地址，基岩版端口不一样）；② 服务器开了 `online-mode` 白名单或防压测插件，拒绝第三方 ping；③ 免费接口临时限流，等 1 分钟会自动重试；④ 服务器确实离线。

**Q：Supabase 免费项目会被暂停吗？**
一周完全没有任何请求才会暂停，用网页点一下就能恢复。届时网站会自动显示本地缓存的列表，不会白屏。

**Q：anon key 放在前端安全吗？**
安全。它是 Supabase 设计给浏览器用的公开密钥，**权限由 RLS 策略控制**：匿名只能 `select`，写入必须登录。真正的密码（`service_role` key）千万不要放进网页。

**Q：能改网站名字/图标吗？**
改 `js/config.js` 里的 `site.title` / `site.subtitle`；图标是 `index.html` 开头的 `link rel="icon"`（内嵌 SVG，直接改颜色即可）。

**Q：想用自己的域名？**
仓库 Settings → Pages → Custom domain 填域名，然后在域名商加一条 CNAME 指向 `你的用户名.github.io`。

---

## 九、用到的公共接口

- <https://api.mcstatus.io/v2/status/java/{地址}>（首选）
- <https://api.mcsrvstat.us/3/{地址}>（自动兜底）

两个都是第三方免费服务，请勿把刷新间隔设得过短（默认 60 秒很安全，最低建议 ≥30 秒）。

想再加一个接口（比如国内更快的中转接口）很简单：打开 `js/mcstatus.js`，在 `PROVIDERS` 数组里照着现有的两项加一个对象即可，程序会按顺序自动尝试、失败就换下一个：

```js
{
  id: 'my-api',
  label: '我的接口',
  buildUrl: function (addr) { return 'https://我的接口/status/' + addr; },
  parse: function (j, addr) {
    return {
      online: !!j.online,
      playersOnline: j.players.online,
      playersMax: j.players.max,
      version: j.version,
      motd: j.motd,
      icon: '',
      playerNames: [],
      provider: '我的接口',
    };
  },
}
```

前提是该接口必须允许跨域（响应头带 `Access-Control-Allow-Origin: *`），否则浏览器不允许网页调用它。
