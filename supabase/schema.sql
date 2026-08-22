-- Field Operations Book — schema Supabase (Postgres)
-- Rode este arquivo inteiro no SQL Editor do seu projeto Supabase.
-- Este arquivo é seguro de rodar mais de uma vez (idempotente).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- TABELAS
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  name text not null,
  role text not null check (role in ('operador', 'gestor', 'supervisor')),
  created_at timestamptz not null default now()
);

-- Se a tabela já existia de uma versão anterior (sem "supervisor"), atualiza a regra:
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('operador', 'gestor', 'supervisor'));

create table if not exists public.farms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.retiros (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.fields (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms (id) on delete cascade,
  retiro_id uuid references public.retiros (id) on delete cascade,
  name text not null,
  area_ha numeric not null default 0,
  coords jsonb, -- anel do polígono importado do KML: [[lng,lat], [lng,lat], ...]
  created_at timestamptz not null default now()
);
alter table public.fields add column if not exists retiro_id uuid references public.retiros (id) on delete cascade;

create table if not exists public.machines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Tipos de operação: os 5 padrão (seed abaixo) + os que o Administrador criar.
create table if not exists public.op_types (
  key text primary key,
  label text not null,
  color text not null,
  is_builtin boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.op_types (key, label, color, is_builtin, enabled) values
  ('preparo', 'Preparo de Solo', '#8B5E34', true, true),
  ('plantio', 'Plantio', '#4F7942', true, true),
  ('pulverizacao', 'Pulverização', '#3E7C8C', true, true),
  ('colheita', 'Colheita', '#C9A227', true, true),
  ('outra', 'Outra', '#8A7F6A', true, true)
on conflict (key) do nothing;

create table if not exists public.operations (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms (id) on delete cascade,
  retiro_id uuid references public.retiros (id) on delete cascade,
  field_id uuid not null references public.fields (id) on delete cascade,
  op_type text not null,
  date date not null,
  area_worked numeric not null,
  hours numeric,
  horimetro_inicial numeric,
  horimetro_final numeric,
  quantity numeric,
  unit text,
  machine_id uuid references public.machines (id) on delete set null,
  machine text, -- nome da máquina no momento do lançamento (histórico)
  notes text,
  operator_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);
alter table public.operations drop constraint if exists operations_op_type_check;
alter table public.operations add column if not exists retiro_id uuid references public.retiros (id) on delete cascade;
alter table public.operations add column if not exists horimetro_inicial numeric;
alter table public.operations add column if not exists horimetro_final numeric;
alter table public.operations add column if not exists machine_id uuid references public.machines (id) on delete set null;
alter table public.operations add column if not exists machine text;

-- ---------------------------------------------------------------------
-- FUNÇÕES AUXILIARES
-- ---------------------------------------------------------------------

-- login por usuário em vez de e-mail (o app usa "usuário", Supabase Auth exige e-mail)
create or replace function public.get_email_by_username(p_username text)
returns text
language sql
security definer
set search_path = public
as $$
  select au.email
  from auth.users au
  join public.profiles p on p.id = au.id
  where lower(p.username) = lower(p_username)
  limit 1;
$$;
grant execute on function public.get_email_by_username(text) to anon, authenticated;

create or replace function public.is_gestor()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'gestor');
$$;
grant execute on function public.is_gestor() to authenticated;

create or replace function public.is_operador()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'operador');
$$;
grant execute on function public.is_operador() to authenticated;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.farms enable row level security;
alter table public.retiros enable row level security;
alter table public.fields enable row level security;
alter table public.machines enable row level security;
alter table public.op_types enable row level security;
alter table public.operations enable row level security;

-- profiles
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated" on public.profiles for select to authenticated using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles for insert to authenticated with check (id = auth.uid());

drop policy if exists "profiles_update_gestor" on public.profiles;
create policy "profiles_update_gestor" on public.profiles for update to authenticated using (public.is_gestor());

drop policy if exists "profiles_delete_gestor" on public.profiles;
create policy "profiles_delete_gestor" on public.profiles for delete to authenticated using (public.is_gestor());

-- farms
drop policy if exists "farms_select_authenticated" on public.farms;
create policy "farms_select_authenticated" on public.farms for select to authenticated using (true);
drop policy if exists "farms_write_gestor" on public.farms;
create policy "farms_write_gestor" on public.farms for insert to authenticated with check (public.is_gestor());
drop policy if exists "farms_update_gestor" on public.farms;
create policy "farms_update_gestor" on public.farms for update to authenticated using (public.is_gestor());
drop policy if exists "farms_delete_gestor" on public.farms;
create policy "farms_delete_gestor" on public.farms for delete to authenticated using (public.is_gestor());

-- retiros
drop policy if exists "retiros_select_authenticated" on public.retiros;
create policy "retiros_select_authenticated" on public.retiros for select to authenticated using (true);
drop policy if exists "retiros_write_gestor" on public.retiros;
create policy "retiros_write_gestor" on public.retiros for insert to authenticated with check (public.is_gestor());
drop policy if exists "retiros_update_gestor" on public.retiros;
create policy "retiros_update_gestor" on public.retiros for update to authenticated using (public.is_gestor());
drop policy if exists "retiros_delete_gestor" on public.retiros;
create policy "retiros_delete_gestor" on public.retiros for delete to authenticated using (public.is_gestor());

-- fields (talhões só são criados/editados pelo fluxo de importação KML, feito pelo Administrador)
drop policy if exists "fields_select_authenticated" on public.fields;
create policy "fields_select_authenticated" on public.fields for select to authenticated using (true);
drop policy if exists "fields_write_gestor" on public.fields;
create policy "fields_write_gestor" on public.fields for insert to authenticated with check (public.is_gestor());
drop policy if exists "fields_update_gestor" on public.fields;
create policy "fields_update_gestor" on public.fields for update to authenticated using (public.is_gestor());
drop policy if exists "fields_delete_gestor" on public.fields;
create policy "fields_delete_gestor" on public.fields for delete to authenticated using (public.is_gestor());

-- machines
drop policy if exists "machines_select_authenticated" on public.machines;
create policy "machines_select_authenticated" on public.machines for select to authenticated using (true);
drop policy if exists "machines_write_gestor" on public.machines;
create policy "machines_write_gestor" on public.machines for insert to authenticated with check (public.is_gestor());
drop policy if exists "machines_delete_gestor" on public.machines;
create policy "machines_delete_gestor" on public.machines for delete to authenticated using (public.is_gestor());

-- op_types
drop policy if exists "op_types_select_authenticated" on public.op_types;
create policy "op_types_select_authenticated" on public.op_types for select to authenticated using (true);
drop policy if exists "op_types_write_gestor" on public.op_types;
create policy "op_types_write_gestor" on public.op_types for insert to authenticated with check (public.is_gestor());
drop policy if exists "op_types_update_gestor" on public.op_types;
create policy "op_types_update_gestor" on public.op_types for update to authenticated using (public.is_gestor());
drop policy if exists "op_types_delete_gestor" on public.op_types;
create policy "op_types_delete_gestor" on public.op_types for delete to authenticated using (public.is_gestor() and not is_builtin);

-- operations
drop policy if exists "operations_select_authenticated" on public.operations;
create policy "operations_select_authenticated" on public.operations for select to authenticated using (true);

-- só Operador lança em seu próprio nome; Gestor (Administrador) também pode lançar; Supervisor não lança nada.
drop policy if exists "operations_insert_own_or_gestor" on public.operations;
create policy "operations_insert_own_or_gestor"
  on public.operations for insert
  to authenticated
  with check ((operator_id = auth.uid() and public.is_operador()) or public.is_gestor());

drop policy if exists "operations_delete_gestor" on public.operations;
create policy "operations_delete_gestor" on public.operations for delete to authenticated using (public.is_gestor());

-- ---------------------------------------------------------------------
-- Depois de rodar este arquivo, vá em Authentication > Providers > Email
-- e DESATIVE "Confirm email" (o app usa e-mails internos fictícios,
-- então a confirmação por e-mail real não se aplica aqui).
-- ---------------------------------------------------------------------
