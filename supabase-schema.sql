-- Run this script in Supabase SQL Editor before using cloud sync.
create table if not exists public.user_stores (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"settings":{},"purchases":[],"sales":[],"expenses":[],"taxPayments":[],"refunds":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Optimistic locking: a stale device cannot silently overwrite newer cloud data.
alter table public.user_stores add column if not exists version bigint not null default 0;

alter table public.user_stores enable row level security;

drop policy if exists "Users can read their own store" on public.user_stores;
create policy "Users can read their own store" on public.user_stores for select using (auth.uid() = user_id);

drop policy if exists "Users can insert their own store" on public.user_stores;
create policy "Users can insert their own store" on public.user_stores for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update their own store" on public.user_stores;
create policy "Users can update their own store" on public.user_stores for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.save_user_store(p_data jsonb, p_expected_version bigint)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare next_version bigint;
begin
  insert into public.user_stores (user_id, data, version)
  values (auth.uid(), p_data, 1)
  on conflict (user_id) do nothing;

  update public.user_stores
     set data = p_data, updated_at = now(), version = version + 1
   where user_id = auth.uid() and version = p_expected_version
   returning version into next_version;

  if next_version is null then
    -- A first save creates version 1; any other null result is a stale editor.
    select version into next_version from public.user_stores where user_id = auth.uid();
    if next_version <> 1 or p_expected_version <> 0 then
      raise exception 'Data conflict: records were changed on another device' using errcode = '40001';
    end if;
  end if;
  return next_version;
end;
$$;

grant execute on function public.save_user_store(jsonb, bigint) to authenticated;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_reason text
);

alter table public.profiles add column if not exists disabled_at timestamptz;
alter table public.profiles add column if not exists disabled_reason text;

alter table public.profiles enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.create_profile_for_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_user();

insert into public.profiles (user_id, email)
select id, email from auth.users
on conflict (user_id) do update set email = excluded.email;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile" on public.profiles for select using (auth.uid() = user_id);

drop policy if exists "Users can create own profile" on public.profiles;
create policy "Users can create own profile" on public.profiles for insert with check (auth.uid() = user_id and role = 'user');

drop policy if exists "Admins can update profiles" on public.profiles;
create policy "Admins can update profiles" on public.profiles for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins can read profiles" on public.profiles;
create policy "Admins can read profiles" on public.profiles for select using (public.is_admin());

create or replace function public.admin_list_users()
returns table (user_id uuid, email text, role text, created_at timestamptz, disabled_at timestamptz, disabled_reason text)
language plpgsql
security definer
set search_path = public, auth
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can list users';
  end if;
  return query
    select u.id, u.email::text, coalesce(p.role, 'user')::text, u.created_at, p.disabled_at, p.disabled_reason
    from auth.users u
    left join public.profiles p on p.user_id = u.id
    order by u.created_at desc;
end;
$$;

grant execute on function public.admin_list_users() to authenticated;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;

drop policy if exists "Admins can read audit logs" on public.audit_logs;
create policy "Admins can read audit logs" on public.audit_logs for select using (public.is_admin());

drop policy if exists "Admins can create audit logs" on public.audit_logs;
create policy "Admins can create audit logs" on public.audit_logs for insert with check (public.is_admin() and admin_user_id = auth.uid());

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'inactive' check (status in ('active', 'inactive')),
  plan text not null default 'monthly',
  amount integer not null default 15000,
  currency text not null default 'KZT',
  current_period_end timestamptz,
  is_permanent boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

drop policy if exists "Users can read own subscription" on public.subscriptions;
create policy "Users can read own subscription" on public.subscriptions for select using (auth.uid() = user_id);

drop policy if exists "Admins can manage subscriptions" on public.subscriptions;
create policy "Admins can manage subscriptions" on public.subscriptions for all using (
  public.is_admin()
) with check (public.is_admin());

create table if not exists public.subscription_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null,
  plan text not null,
  current_period_end timestamptz,
  is_permanent boolean not null default false,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Apply the new price to existing standard/manual subscriptions as well.
update public.subscriptions set amount = 15000 where amount = 1000 and plan in ('monthly', 'manual');

alter table public.subscription_history enable row level security;
drop policy if exists "Users can read own subscription history" on public.subscription_history;
create policy "Users can read own subscription history" on public.subscription_history for select using (auth.uid() = user_id);
drop policy if exists "Admins can read subscription history" on public.subscription_history;
create policy "Admins can read subscription history" on public.subscription_history for select using (public.is_admin());

create or replace function public.log_subscription_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscription_history (user_id, status, plan, current_period_end, is_permanent, changed_by)
  values (new.user_id, new.status, new.plan, new.current_period_end, new.is_permanent, auth.uid());
  return new;
end;
$$;

drop trigger if exists on_subscription_changed on public.subscriptions;
create trigger on_subscription_changed
  after insert or update on public.subscriptions
  for each row execute procedure public.log_subscription_change();

-- Access is enforced in the database as well as in the UI. An account with an
-- inactive/expired subscription cannot read or change its financial data even
-- if it keeps an old browser tab or calls the API directly.
create or replace function public.is_account_active()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select public.is_admin() or exists (
    select 1 from public.profiles p
    left join public.subscriptions s on s.user_id = p.user_id
    where p.user_id = auth.uid()
      and p.disabled_at is null
      and (s.status is distinct from 'inactive')
      and (p.created_at > now() - interval '2 hours'
        or (s.status = 'active' and (s.is_permanent or s.current_period_end > now())))
  );
$$;

drop policy if exists "Users can read their own store" on public.user_stores;
create policy "Users can read their own active store" on public.user_stores for select using (auth.uid() = user_id and public.is_account_active());
drop policy if exists "Users can insert their own store" on public.user_stores;
create policy "Users can insert their own active store" on public.user_stores for insert with check (auth.uid() = user_id and public.is_account_active());
drop policy if exists "Users can update their own store" on public.user_stores;
create policy "Users can update their own active store" on public.user_stores for update using (auth.uid() = user_id and public.is_account_active()) with check (auth.uid() = user_id and public.is_account_active());

create or replace function public.save_user_store(p_data jsonb, p_expected_version bigint)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare next_version bigint;
begin
  if not public.is_account_active() then
    raise exception 'Access denied: inactive or expired subscription' using errcode = '42501';
  end if;
  insert into public.user_stores (user_id, data, version) values (auth.uid(), p_data, 1) on conflict (user_id) do nothing;
  update public.user_stores set data = p_data, updated_at = now(), version = version + 1
    where user_id = auth.uid() and version = p_expected_version returning version into next_version;
  if next_version is null then
    select version into next_version from public.user_stores where user_id = auth.uid();
    if next_version <> 1 or p_expected_version <> 0 then raise exception 'Data conflict: records were changed on another device' using errcode = '40001'; end if;
  end if;
  return next_version;
end;
$$;

-- Run once after registering your own account, replacing the email.
-- update public.profiles set role = 'admin' where email = 'your-email@example.com';
