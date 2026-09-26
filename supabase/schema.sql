-- ============================================================================
--  BRJS公益服务器 · 监控站  建表脚本
--  用法：打开 Supabase 控制台 → 左侧「SQL Editor」→ New query →
--        把本文件全部内容粘贴进去 → 点 Run。执行一次即可（可重复执行）。
-- ============================================================================

create extension if not exists "pgcrypto";   -- 提供 gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 服务器列表：网站首页展示的每一条就是一个「Java 版服务器」
-- ---------------------------------------------------------------------------
create table if not exists public.servers (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,               -- 显示名称，例如：BRJS 1服 · 宝可梦整合包
  address     text        not null,               -- Java 地址：play.example.com 或 1.2.3.4:25566
  note        text        default '',             -- 备注 / 分组（1服、2服、整合包名…）
  sort_order  integer     not null default 0,     -- 排序，越小越靠前
  enabled     boolean     not null default true,  -- false = 暂不显示（也不查询）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.servers is 'BRJS 监控站：需要监控的 Minecraft Java 版服务器列表';

create index if not exists servers_sort_idx on public.servers (sort_order, created_at);

-- ---------------------------------------------------------------------------
-- updated_at 自动更新
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists servers_touch_updated_at on public.servers;
create trigger servers_touch_updated_at
  before update on public.servers
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 行级安全（RLS）：所有人可读，登录的管理员可增删改
--   ★ 请务必到 Authentication → Sign In / Providers → Email
--     关闭 "Allow new users to sign up"，只保留你自己创建的管理员账号。
-- ---------------------------------------------------------------------------
alter table public.servers enable row level security;

drop policy if exists "servers_public_read"   on public.servers;
create policy "servers_public_read" on public.servers
  for select using (true);

drop policy if exists "servers_auth_insert"   on public.servers;
create policy "servers_auth_insert" on public.servers
  for insert to authenticated with check (true);

drop policy if exists "servers_auth_update"   on public.servers;
create policy "servers_auth_update" on public.servers
  for update to authenticated using (true) with check (true);

drop policy if exists "servers_auth_delete"   on public.servers;
create policy "servers_auth_delete" on public.servers
  for delete to authenticated using (true);

-- 给匿名/登录角色授权（RLS 之上还需要表权限）
grant select on public.servers to anon, authenticated;
grant insert, update, delete on public.servers to authenticated;


-- ============================================================================
--  【可选·更严格】只允许指定的几个账号修改数据
--  如果担心别人自己注册账号来改你的服务器列表，可以执行下面的语句：
--
--  1) 先建管理员白名单表：
--       create table if not exists public.admins (
--         user_id uuid primary key references auth.users(id) on delete cascade,
--         added_at timestamptz not null default now()
--       );
--       alter table public.admins enable row level security;
--       -- 白名单本身不给任何人读写权限（只有服务端/你自己能看）
--
--  2) 把自己的账号加进去（邮箱换成你创建管理员时用的邮箱）：
--       insert into public.admins (user_id)
--       select id from auth.users where email = 'you@example.com'
--       on conflict do nothing;
--
--  3) 把上面的三条 authenticated 策略换成「必须在白名单里」：
--       drop policy if exists "servers_auth_insert" on public.servers;
--       drop policy if exists "servers_auth_update" on public.servers;
--       drop policy if exists "servers_auth_delete" on public.servers;
--
--       create policy "servers_admin_insert" on public.servers
--         for insert to authenticated
--         with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
--       create policy "servers_admin_update" on public.servers
--         for update to authenticated
--         using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
--         with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
--       create policy "servers_admin_delete" on public.servers
--         for delete to authenticated
--         using (exists (select 1 from public.admins a where a.user_id = auth.uid()));
-- ============================================================================
