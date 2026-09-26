-- ============================================================================
--  BRJS 监控站 · 全局共享状态（所有人看到同一个数字）
--
--  作用：把「在线人数 / 空服时长（0 人在线持续多久）」的统计从访客浏览器
--        搬到数据库里。数据库每分钟自己去查一次 MC 服务器并落库，
--        所有访客读的都是同一行、同一个时间戳 → 数字完全一致，
--        而且没人在看网页的时候也在继续统计（不会漏掉有人上线的时刻）。
--
--  执行方式：Supabase → SQL Editor → 粘贴 → Run（可重复执行，幂等）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 依赖扩展
-- ---------------------------------------------------------------------------
create extension if not exists pg_net;    -- 让数据库能发 HTTP 请求（异步）
create extension if not exists pg_cron;   -- 让数据库能跑定时任务

-- ---------------------------------------------------------------------------
-- 2. 状态表：每个服务器一行，全站共享
-- ---------------------------------------------------------------------------
create table if not exists public.server_status (
  server_id        uuid primary key references public.servers(id) on delete cascade,
  online           boolean,
  players_online   integer,
  players_max      integer,
  version          text,
  motd             text,
  player_names     jsonb   not null default '[]'::jsonb,
  zero_since       timestamptz,                        -- 连续 0 人在线的起点；null = 有人在线
  last_players_at  timestamptz,                        -- 最近一次查到「有人在玩」的时刻
  longest_zero_ms  bigint  not null default 0,         -- 已结束的最长空服时长（毫秒）
  last_zero_ms     bigint  not null default 0,         -- 上一次空服持续了多久
  error            text,                               -- 最近一次查询失败的原因
  provider         text,                               -- 数据来自哪个接口
  checked_at       timestamptz,                        -- 最近一次「查询成功」的时刻
  updated_at       timestamptz not null default now()
);
comment on table public.server_status is 'BRJS 监控站：每个服务器的实时状态与空服时长（全局唯一）';

-- 待回执的请求（pg_net 是异步的，需要靠它把回执对应回服务器）
create table if not exists public.poll_requests (
  request_id bigint primary key,
  server_id  uuid not null,
  provider   text not null default 'mcstatus.io',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. 权限：所有人可读，任何人（含匿名密钥）都不能直接写
-- ---------------------------------------------------------------------------
alter table public.server_status enable row level security;

drop policy if exists "server_status_public_read" on public.server_status;
create policy "server_status_public_read" on public.server_status for select using (true);

grant select on public.server_status to anon, authenticated;
-- 不授予 insert/update/delete：状态只能由下面的函数（SECURITY DEFINER）写

alter table public.poll_requests enable row level security;
drop policy if exists "poll_requests_no_read" on public.poll_requests;
-- 不给任何策略 = 谁都读不到、写不了

-- ---------------------------------------------------------------------------
-- 4. 空服时长逻辑（唯一的权威实现，改动只在数据库里发生一次）
-- ---------------------------------------------------------------------------
create or replace function public.apply_status(
  p_server_id uuid,
  p_online     boolean,
  p_players    integer,
  p_max        integer,
  p_version    text,
  p_motd       text,
  p_names      jsonb,
  p_provider   text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s        public.server_status;
  ts       timestamptz := now();
  d        bigint;
  is_empty boolean;
begin
  -- 离线也算「0 人在线」（离线当然没人玩）；客户端可以自己选择不显示
  is_empty := case when p_online then coalesce(p_players, 0) <= 0 else true end;

  insert into public.server_status(server_id) values (p_server_id)
    on conflict (server_id) do nothing;
  select * into s from public.server_status where server_id = p_server_id for update;

  if is_empty then
    if s.zero_since is null then
      update public.server_status set zero_since = ts where server_id = p_server_id;
    end if;
  else
    if s.zero_since is not null then
      d := (extract(epoch from (ts - s.zero_since)) * 1000)::bigint;
      update public.server_status
         set zero_since      = null,
             last_zero_ms    = d,
             longest_zero_ms = greatest(longest_zero_ms, d)
       where server_id = p_server_id;
    end if;
    if p_online and coalesce(p_players, 0) > 0 then
      update public.server_status set last_players_at = ts where server_id = p_server_id;
    end if;
  end if;

  update public.server_status
     set online         = p_online,
         players_online = coalesce(p_players, 0),
         players_max    = coalesce(p_max, 0),
         version        = nullif(p_version, ''),
         motd           = nullif(p_motd, ''),
         player_names   = coalesce(p_names, '[]'::jsonb),
         provider       = p_provider,
         error          = null,
         checked_at     = ts,
         updated_at     = ts
   where server_id = p_server_id;
end $$;

create or replace function public.apply_status_error(
  p_server_id uuid, p_error text, p_provider text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.server_status(server_id) values (p_server_id)
    on conflict (server_id) do nothing;
  -- 注意：查询失败时不动 zero_since、也不动 checked_at，宁可多算也不错算
  update public.server_status
     set error = left(coalesce(p_error, '查询失败'), 300),
         provider = p_provider,
         updated_at = now()
   where server_id = p_server_id;
end $$;

-- ---------------------------------------------------------------------------
-- 5. 发起查询
-- ---------------------------------------------------------------------------
create or replace function public.mc_url(p_address text, p_provider text)
returns text language sql immutable as $$
  select case p_provider
    when 'mcsrvstat.us' then 'https://api.mcsrvstat.us/3/' || p_address
    else 'https://api.mcstatus.io/v2/status/java/' || p_address
  end;
$$;

create or replace function public.fire_poll(p_server_id uuid, p_address text, p_provider text)
returns void
language plpgsql security definer set search_path = public, net as $$
declare req bigint;
begin
  if coalesce(p_address, '') = '' then return; end if;
  select net.http_get(
           url                    := public.mc_url(replace(p_address, ' ', ''), p_provider),
           headers                := jsonb_build_object('Accept', 'application/json'),
           timeout_milliseconds   := 8000
         ) into req;
  insert into public.poll_requests(request_id, server_id, provider)
  values (req, p_server_id, p_provider)
  on conflict (request_id) do nothing;
end $$;

create or replace function public.poll_servers()
returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in select id, address from public.servers
            where enabled and coalesce(address, '') <> '' loop
    perform public.fire_poll(r.id, r.address, 'mcstatus.io');
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 6. 收取回执并落库（主接口失败自动换备用接口重试一次）
-- ---------------------------------------------------------------------------
create or replace function public.collect_responses()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  r         record;
  j         jsonb;
  n         integer := 0;
  v_ok      boolean;
  v_online  boolean;
  v_players integer;
  v_max     integer;
  v_ver     text;
  v_motd    text;
  v_names   jsonb;
  v_addr    text;
begin
  for r in
    select pr.request_id, pr.server_id, pr.provider,
           resp.status_code, resp.content, resp.error_msg, resp.timed_out
      from public.poll_requests pr
      join net._http_response resp on resp.id = pr.request_id
     order by pr.created_at
  loop
    delete from public.poll_requests where request_id = r.request_id;

    -- ★ 服务器可能已经被删掉了：直接丢弃这条回执。
    --   否则给它写 server_status 会触发外键错误，把整批回执一起回滚 —— 流水线会永久卡死。
    select address into v_addr from public.servers where id = r.server_id;
    if v_addr is null then
      continue;
    end if;

    begin
      v_ok := false; v_names := '[]'::jsonb;
      if r.status_code = 200 and r.content is not null then
        begin
          j := r.content::jsonb;
          if j ? 'online' then
            v_online  := coalesce((j ->> 'online')::boolean, false);
            v_players := coalesce((j -> 'players' ->> 'online')::integer, 0);
            v_max     := coalesce((j -> 'players' ->> 'max')::integer, 0);
            if r.provider = 'mcsrvstat.us' then
              v_ver   := coalesce(j ->> 'version', '');
              v_motd  := case when jsonb_typeof(j -> 'motd' -> 'clean') = 'array'
                              then coalesce(j -> 'motd' -> 'clean' ->> 0, '')
                              else coalesce(j -> 'motd' ->> 'clean', '') end;
              v_names := '[]'::jsonb;
            else
              v_ver   := coalesce(j -> 'version' ->> 'name_clean', j -> 'version' ->> 'name_raw', '');
              v_motd  := coalesce(j -> 'motd' ->> 'clean', j -> 'motd' ->> 'raw', '');
              v_names := case when jsonb_typeof(j -> 'players' -> 'list') = 'array'
                              then j -> 'players' -> 'list' else '[]'::jsonb end;
            end if;
            v_ok := true;
          end if;
        exception when others then
          v_ok := false;
        end;
      end if;

      if v_ok then
        perform public.apply_status(r.server_id, v_online, v_players, v_max, v_ver, v_motd, v_names, r.provider);
        n := n + 1;
      elsif r.provider = 'mcstatus.io' then
        -- 主接口没用 → 换备用接口再试一次
        perform public.fire_poll(r.server_id, v_addr, 'mcsrvstat.us');
      else
        perform public.apply_status_error(
          r.server_id,
          coalesce(r.error_msg, 'HTTP ' || coalesce(r.status_code::text, '?')), r.provider);
      end if;
    exception when others then
      -- ★ 兜底：单条回执出任何意外，也只影响这一条，不能让整批回执作废
      begin
        perform public.apply_status_error(r.server_id, sqlerrm, r.provider);
      exception when others then null;
      end;
    end;
  end loop;

  -- 清掉超时没回来的请求，避免堆积
  delete from public.poll_requests where created_at < now() - interval '3 minutes';
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 7. 新增/改地址时立刻查一次；改地址不清零空服计时
-- ---------------------------------------------------------------------------
create or replace function public.on_server_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.address is distinct from old.address then
    update public.server_status
       set online = null, players_online = null, players_max = null,
           version = null, motd = null, player_names = '[]'::jsonb,
           checked_at = null, updated_at = now()
     where server_id = new.id;
    -- 故意保留 zero_since：换了 IP 还是同一个服，空服计时延续
  end if;
  if new.enabled and coalesce(new.address, '') <> '' then
    perform public.fire_poll(new.id, new.address, 'mcstatus.io');
  end if;
  return new;
end $$;

drop trigger if exists servers_status_sync on public.servers;
create trigger servers_status_sync
  after insert or update on public.servers
  for each row execute function public.on_server_changed();

-- ---------------------------------------------------------------------------
-- 8. 管理员：手动立即查询 / 重置空服计时
-- ---------------------------------------------------------------------------
create or replace function public.poll_now()
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then
    raise exception '请先登录管理员账号';
  end if;
  n := public.poll_servers();
  perform public.collect_responses();
  return n;
end $$;

create or replace function public.reset_zero(p_server_id uuid default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then
    raise exception '请先登录管理员账号';
  end if;
  if p_server_id is null then
    update public.server_status set zero_since = now(), updated_at = now() where zero_since is not null;
  else
    update public.server_status set zero_since = now(), updated_at = now() where server_id = p_server_id;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 9. 对外只读视图：一次请求拿到「服务器 + 状态」，并带上数据库当前时间
--    （服务器时间用于校正访客本地时钟误差，保证所有人看到的秒数一致）
-- ---------------------------------------------------------------------------
drop view if exists public.servers_live;
create view public.servers_live as
select s.id, s.name, s.address, s.note, s.sort_order, s.enabled,
       s.created_at, s.updated_at,
       st.online, st.players_online, st.players_max,
       st.version, st.motd, st.player_names,
       st.zero_since, st.last_players_at, st.longest_zero_ms, st.last_zero_ms,
       st.error  as status_error,
       st.provider, st.checked_at,
       now()     as server_now
  from public.servers s
  left join public.server_status st on st.server_id = s.id;

-- 让视图按「查询者的权限」执行（Postgres 15+ 支持；不支持也不影响功能）
do $$
begin
  execute 'alter view public.servers_live set (security_invoker = true)';
exception when others then
  raise notice '当前 Postgres 版本不支持 security_invoker，已跳过（不影响功能）';
end $$;

grant select on public.servers_live to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. 锁死内部函数（否则拿到公开密钥的人可以伪造数据）
-- ---------------------------------------------------------------------------
revoke all on function public.apply_status(uuid, boolean, integer, integer, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.apply_status_error(uuid, text, text)            from public, anon, authenticated;
revoke all on function public.fire_poll(uuid, text, text)                     from public, anon, authenticated;
revoke all on function public.poll_servers()                                  from public, anon, authenticated;
revoke all on function public.collect_responses()                             from public, anon, authenticated;
revoke all on function public.on_server_changed()                             from public, anon, authenticated;
revoke all on function public.poll_now()                                      from public, anon;
grant execute on function public.poll_now() to authenticated;
revoke all on function public.reset_zero(uuid)                                from public, anon;
grant execute on function public.reset_zero(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. 定时任务
--     注意：pg_cron 的 cron 表达式【不支持秒字段】，只支持两种写法：
--       · 标准 5 段式：'* * * * *'（每分钟）
--       · 间隔写法：'30 seconds'（pg_cron 1.5+ 支持 1-59 秒）
--     所以：查询每分钟一次；收结果每 30 秒一次（错开，尽快把结果落库）。
-- ---------------------------------------------------------------------------
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('brjs-poll', 'brjs-collect') loop
    perform cron.unschedule(j.jobid);
  end loop;
exception when others then null;
end $$;

do $$
begin
  -- 查询：标准 5 段式，每分钟一次（最稳，所有 pg_cron 版本都支持）
  perform cron.schedule('brjs-poll', '* * * * *', $job$select public.poll_servers();$job$);
  -- 收结果：优先用间隔写法错峰到每 30 秒（pg_cron 只认 '[1-59] seconds'，不认 '1 minute'）
  begin
    perform cron.schedule('brjs-collect', '30 seconds', $job$select public.collect_responses();$job$);
  exception when others then
    perform cron.schedule('brjs-collect', '* * * * *', $job$select public.collect_responses();$job$);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 12. 立刻跑一次，确认能用（不需要等定时任务）
-- ---------------------------------------------------------------------------
select public.poll_servers() as 已发起查询数;
