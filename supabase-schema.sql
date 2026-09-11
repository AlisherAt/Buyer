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
