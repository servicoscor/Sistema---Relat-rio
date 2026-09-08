create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  nome text not null,
  equipe text,
  perfil text not null check (perfil in ('Chefia', 'Supervisor')),
  created_at timestamptz not null default now()
);

create table if not exists public.app_admin_emails (
  email text primary key
);

insert into public.app_admin_emails (email)
values ('admin@plantao.local')
on conflict (email) do nothing;

create table if not exists public.plantoes (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  turno text not null check (turno in ('Diurno', 'Noturno')),
  equipe text not null,
  coordenador text,
  integrantes jsonb not null default '[]'::jsonb,
  faltas jsonb not null default '[]'::jsonb,
  dia jsonb not null default '[]'::jsonb,
  proximo jsonb not null default '[]'::jsonb,
  ocorrencias jsonb not null default '[]'::jsonb,
  autor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (data, turno, equipe)
);

create or replace function public.is_chefia()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and perfil = 'Chefia'
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, nome, equipe, perfil)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'nome', split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data->>'equipe', ''),
    case
      when exists (select 1 from public.app_admin_emails where email = lower(new.email)) then 'Chefia'
      else 'Supervisor'
    end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists plantoes_touch_updated_at on public.plantoes;
create trigger plantoes_touch_updated_at
before update on public.plantoes
for each row execute function public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.app_admin_emails enable row level security;
alter table public.plantoes enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
for select to authenticated
using (id = auth.uid() or public.is_chefia());

drop policy if exists "profiles_update_self" on public.profiles;

drop policy if exists "admin_emails_select_chefia" on public.app_admin_emails;
create policy "admin_emails_select_chefia" on public.app_admin_emails
for select to authenticated
using (public.is_chefia());

drop policy if exists "plantoes_select" on public.plantoes;
create policy "plantoes_select" on public.plantoes
for select to authenticated
using (autor_id = auth.uid() or public.is_chefia());

drop policy if exists "plantoes_insert" on public.plantoes;
create policy "plantoes_insert" on public.plantoes
for insert to authenticated
with check (autor_id = auth.uid() or public.is_chefia());

drop policy if exists "plantoes_update" on public.plantoes;
create policy "plantoes_update" on public.plantoes
for update to authenticated
using (autor_id = auth.uid() or public.is_chefia())
with check (autor_id = auth.uid() or public.is_chefia());

drop policy if exists "plantoes_delete_chefia" on public.plantoes;
create policy "plantoes_delete_chefia" on public.plantoes
for delete to authenticated
using (public.is_chefia());
