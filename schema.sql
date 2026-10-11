-- =====================================================================
-- Auto Post FB — สร้างฐานข้อมูลทั้งหมดในครั้งเดียว (ตรงกับโปรแกรม v1.3.0)
--
-- ใช้กับโปรเจกต์ Supabase ใหม่ (เช่นโปรเจกต์ไว้ทดสอบ):
--   Supabase Dashboard → SQL Editor → New query → วางทั้งไฟล์ → Run
--
-- ได้ครบ: ตาราง licenses + plans (Basic/Plus/Pro) + license_events + app_info
--         ฟังก์ชัน check_license / get_app_info ที่โปรแกรมเรียก
-- รันซ้ำได้ และทั้งไฟล์อยู่ใน transaction เดียว (ผิดพลาดตรงไหน = ย้อนกลับทั้งหมด)
--
-- ⚠ โปรเจกต์ทดสอบมี URL และ publishable key คนละชุดกับของจริง — โปรแกรมจะใช้โปรเจกต์นี้
--   ก็ต่อเมื่อเปลี่ยน SUPABASE_URL / SUPABASE_KEY ใน licensing.py และ admin_secret.txt
-- =====================================================================
begin;

-- =====================================================================
-- 1) ตาราง licenses   (จาก supabase/license.sql)
-- =====================================================================
create table if not exists public.licenses (
  key            text primary key,
  duration_hours integer     not null check (duration_hours > 0),
  activated_at   timestamptz,                 -- เวลาที่ลูกค้าใช้คีย์ครั้งแรก (เริ่มนับเวลา)
  expires_at     timestamptz,                 -- activated_at + duration_hours (ต่ออายุได้)
  hwid           text,                        -- รหัสเครื่องที่ผูกกับคีย์
  status         text        not null default 'active' check (status in ('active', 'revoked')),
  note           text,                        -- ชื่อลูกค้า / ช่องทางติดต่อ
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz
);

alter table public.licenses add column if not exists max_accounts integer;
alter table public.licenses drop constraint if exists licenses_max_accounts_check;
alter table public.licenses add constraint licenses_max_accounts_check check (max_accounts between 1 and 9999);

alter table public.licenses enable row level security;
revoke all on table public.licenses from anon, authenticated;

-- =====================================================================
-- 2) แพ็กเกจ + ประวัติ + check_license   (จาก supabase/plans.sql)
-- =====================================================================
create table if not exists public.plans (
  code         text        primary key check (code ~ '^[a-z0-9_]+$'),
  name         text        not null,
  max_accounts integer     not null check (max_accounts between 1 and 9999),
  features     text[]      not null default '{}',
  limits       jsonb       not null default '{}'::jsonb,
  sort_order   integer     not null default 0,     -- ใช้เรียงลำดับ และบอกว่าแพ็กเกจไหน "สูงกว่า"
  is_active    boolean     not null default true,  -- false = เลิกขายแพ็กเกจนี้ (คีย์เดิมยังใช้ได้)
  updated_at   timestamptz not null default now()
);

insert into public.plans (code, name, max_accounts, features, sort_order) values
  ('basic', 'Basic', 1,    '{post,comment,post_links,check_links,joined_groups,discord}', 1),
  ('plus',  'Plus',  2,    '{post,comment,post_links,check_links,joined_groups,discord}', 2),
  ('pro',   'Pro',   9999, '{post,comment,post_links,check_links,joined_groups,discord,like}', 3)
on conflict (code) do nothing;  -- รันซ้ำไม่ทับค่าที่แก้ไว้

alter table public.plans enable row level security;
revoke all on table public.plans from anon, authenticated;

alter table public.licenses add column if not exists plan           text;
alter table public.licenses add column if not exists extra_features text[]      not null default '{}';
alter table public.licenses add column if not exists updated_at     timestamptz not null default now();

alter table public.licenses alter column max_accounts drop not null;
alter table public.licenses alter column max_accounts drop default;
update public.licenses
   set plan = case when max_accounts >= 5 then 'pro'
                   when max_accounts >= 2 then 'plus'
                   else 'basic' end,
       max_accounts = case when max_accounts in (1, 2) or max_accounts >= 5 then null
                           else max_accounts end   -- 3–4 บัญชี = Plus ที่ให้บัญชีเพิ่มพิเศษ
 where plan is null;

alter table public.licenses alter column plan set default 'basic';
alter table public.licenses alter column plan set not null;
do $$ begin
  alter table public.licenses add constraint licenses_plan_fkey
    foreign key (plan) references public.plans (code) on update cascade;
exception when duplicate_object then null;
end $$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists licenses_touch_updated_at on public.licenses;
create trigger licenses_touch_updated_at before update on public.licenses
  for each row
  when (old.last_seen_at is not distinct from new.last_seen_at)
  execute function public.touch_updated_at();  -- ไม่นับตอนโปรแกรมลูกค้าเช็คคีย์ (ซึ่งอัปเดต last_seen_at)

drop trigger if exists plans_touch_updated_at on public.plans;
create trigger plans_touch_updated_at before update on public.plans
  for each row execute function public.touch_updated_at();

create table if not exists public.license_events (
  id         bigint      generated always as identity primary key,
  key        text        not null references public.licenses (key) on delete cascade,
  type       text        not null check (type in ('created', 'activated', 'device_bound', 'extended',
                                                  'plan_changed', 'features_changed', 'hwid_reset',
                                                  'revoked', 'restored')),
  detail     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists license_events_key_created_idx on public.license_events (key, created_at desc);

alter table public.license_events enable row level security;
revoke all on table public.license_events from anon, authenticated;

create or replace function public.check_license(p_key text, p_hwid text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.licenses;
  p public.plans;
  first_use boolean;
begin
  if p_key is null or p_hwid is null or length(p_hwid) < 16 or length(p_key) > 64 then
    return json_build_object('valid', false, 'reason', 'bad_request', 'server_time', now());
  end if;

  select * into r from public.licenses where key = upper(btrim(p_key)) for update;
  if not found then
    return json_build_object('valid', false, 'reason', 'not_found', 'server_time', now());
  end if;

  if r.status <> 'active' then
    return json_build_object('valid', false, 'reason', 'revoked', 'server_time', now());
  end if;

  if r.hwid is null then
    -- ใช้ครั้งแรก: ผูกเครื่อง + เริ่มนับเวลา
    -- (ถ้าเคยเริ่มนับแล้วแต่แอดมินรีเซ็ตเครื่อง ให้ผูกเครื่องใหม่โดยไม่รีเซ็ตเวลา)
    first_use := r.activated_at is null;
    update public.licenses
       set hwid         = p_hwid,
           activated_at = coalesce(activated_at, now()),
           expires_at   = coalesce(expires_at, now() + make_interval(hours => duration_hours)),
           last_seen_at = now()
     where key = r.key
    returning * into r;
    insert into public.license_events (key, type, detail)
    values (r.key, case when first_use then 'activated' else 'device_bound' end,
            jsonb_build_object('hwid', left(p_hwid, 16)));
  elsif r.hwid <> p_hwid then
    return json_build_object('valid', false, 'reason', 'other_device', 'server_time', now());
  else
    update public.licenses set last_seen_at = now() where key = r.key;
  end if;

  if r.expires_at <= now() then
    return json_build_object('valid', false, 'reason', 'expired',
                             'expires_at', r.expires_at, 'server_time', now());
  end if;

  select * into p from public.plans where code = r.plan;

  return json_build_object(
    'valid',         true,
    'expires_at',    r.expires_at,
    'server_time',   now(),
    'plan',          r.plan,
    'plan_name',     coalesce(p.name, r.plan),
    'max_accounts',  coalesce(r.max_accounts, p.max_accounts, 1),
    'features',      (select coalesce(array_agg(distinct f order by f), '{}')
                        from unnest(coalesce(p.features, '{}') || r.extra_features) as f),
    'limits',        coalesce(p.limits, '{}'::jsonb),
    -- แพ็กเกจต่ำสุดที่มีแต่ละฟีเจอร์ (ไว้ให้โปรแกรมบอกลูกค้าว่าต้องอัปเกรดเป็นอะไร)
    'feature_plans', (select coalesce(json_object_agg(feature, plan_name), '{}'::json)
                        from (select distinct on (f) f as feature, x.name as plan_name
                                from public.plans x, unnest(x.features) as f
                               where x.is_active
                               order by f, x.sort_order) as cheapest)
  );
end;
$$;

revoke all on function public.check_license(text, text) from public;
grant execute on function public.check_license(text, text) to anon, authenticated;

-- =====================================================================
-- 3) เวอร์ชันล่าสุด + ประกาศ (get_app_info)   (จาก supabase/app_info.sql)
-- =====================================================================
create table if not exists public.app_info (
  id                  integer primary key default 1 check (id = 1),  -- มีแถวเดียว
  latest_version      text        not null default '1.0.0',
  min_version         text        not null default '1.0.0',          -- ต่ำกว่านี้ = บังคับอัปเดต
  download_url        text,
  changelog           text,
  announcement        text,
  announcement_level  text        not null default 'info' check (announcement_level in ('info', 'warn', 'critical')),
  announcement_at     timestamptz,
  updated_at          timestamptz not null default now()
);

insert into public.app_info (id) values (1) on conflict (id) do nothing;

alter table public.app_info enable row level security;
revoke all on table public.app_info from anon, authenticated;

create or replace function public.get_app_info()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'latest_version',     latest_version,
    'min_version',        min_version,
    'download_url',       download_url,
    'changelog',          changelog,
    'announcement',       announcement,
    'announcement_level', announcement_level,
    'announcement_at',    announcement_at
  )
  from public.app_info
  where id = 1;
$$;

revoke all on function public.get_app_info() from public;
grant execute on function public.get_app_info() to anon, authenticated;

commit;

-- =====================================================================
-- 4) คีย์ทดสอบ (ไม่บังคับ) — ใส่ไว้ให้ลองได้ทันที ลบส่วนนี้ออกได้ถ้าไม่ต้องการ
--    รันซ้ำไม่สร้างซ้ำ (on conflict do nothing)
-- =====================================================================
insert into public.licenses (key, duration_hours, plan, note) values
  ('APF-TEST-BASI-C000-0001', 24,  'basic', 'ทดสอบ Basic 1 วัน'),
  ('APF-TEST-PLUS-0000-0002', 72,  'plus',  'ทดสอบ Plus 3 วัน'),
  ('APF-TEST-PROO-0000-0003', 168, 'pro',   'ทดสอบ Pro 7 วัน')
on conflict (key) do nothing;

-- ตรวจผล: ควรเห็น 3 แพ็กเกจ พร้อมฟีเจอร์และจำนวนคีย์
select p.code, p.name, p.max_accounts, p.features, count(l.key) as keys
  from public.plans p left join public.licenses l on l.plan = p.code
 group by p.code, p.name, p.max_accounts, p.features, p.sort_order
 order by p.sort_order;
