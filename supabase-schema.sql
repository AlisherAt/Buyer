-- Run this script in Supabase SQL Editor before using cloud sync.
create table if not exists public.user_stores (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"settings":{},"purchases":[],"sales":[],"expenses":[],"taxPayments":[],"refunds":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_stores enable row level security;

drop policy if exists "Users can read their own store" on public.user_stores;
create policy "Users can read their own store" on public.user_stores for select using (auth.uid() = user_id);

drop policy if exists "Users can insert their own store" on public.user_stores;
create policy "Users can insert their own store" on public.user_stores for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update their own store" on public.user_stores;
create policy "Users can update their own store" on public.user_stores for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

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

drop policy if exists "Admins can read profiles" on public.profiles;
create policy "Admins can read profiles" on public.profiles for select using (public.is_admin());

create or replace function public.admin_list_users()
returns table (user_id uuid, email text, role text, created_at timestamptz)
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
    select u.id, u.email::text, coalesce(p.role, 'user')::text, u.created_at
    from auth.users u
    left join public.profiles p on p.user_id = u.id
    order by u.created_at desc;
end;
$$;

grant execute on function public.admin_list_users() to authenticated;

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'inactive' check (status in ('active', 'inactive')),
  plan text not null default 'monthly',
  amount integer not null default 1000,
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

-- Run once after registering your own account, replacing the email.
-- update public.profiles set role = 'admin' where email = 'your-email@example.com';
