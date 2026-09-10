-- Execute after schema.sql for new installations, or directly for existing ones.
-- Existing reports and profiles are preserved. Team access must be approved manually.
begin;

create table if not exists public.team_memberships (
  user_id uuid not null references public.profiles(id) on delete cascade,
  equipe text not null check (length(btrim(equipe)) between 1 and 120 and equipe = btrim(equipe)),
  created_at timestamptz not null default now(),
  primary key (user_id, equipe)
);
alter table public.team_memberships enable row level security;
revoke all on public.team_memberships from anon, authenticated;
grant select on public.team_memberships to authenticated;

create or replace function public.is_chefia()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p join auth.users u on u.id = p.id
    where p.id = auth.uid() and p.perfil = 'Chefia' and u.email_confirmed_at is not null
  );
$$;
revoke all on function public.is_chefia() from public;
grant execute on function public.is_chefia() to authenticated;

-- Signup metadata and email allowlists never grant administrative access.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, nome, equipe, perfil)
  values (new.id, lower(new.email),
    coalesce(nullif(btrim(new.raw_user_meta_data->>'nome'), ''), split_part(new.email, '@', 1)),
    null, 'Supervisor');
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop policy if exists team_memberships_select on public.team_memberships;
create policy team_memberships_select on public.team_memberships for select to authenticated
using (user_id = auth.uid() or public.is_chefia());

create or replace function public.can_write_team(target_team text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null)
    and (public.is_chefia() or exists (
      select 1 from public.team_memberships where user_id = auth.uid() and equipe = target_team
    ));
$$;
revoke all on function public.can_write_team(text) from public;
grant execute on function public.can_write_team(text) to authenticated;

-- Profiles and memberships are administered via trusted SQL, never user metadata.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
revoke all on public.app_admin_emails from anon, authenticated;
revoke all on public.plantoes from anon;
revoke delete, truncate, references, trigger on public.plantoes from authenticated;
grant select, insert, update on public.plantoes to authenticated;
drop policy if exists plantoes_delete_chefia on public.plantoes;

drop policy if exists plantoes_insert on public.plantoes;
create policy plantoes_insert on public.plantoes for insert to authenticated
with check (autor_id = auth.uid() and public.can_write_team(equipe));

drop policy if exists plantoes_update on public.plantoes;
create policy plantoes_update on public.plantoes for update to authenticated
using ((autor_id = auth.uid() or public.is_chefia()) and public.can_write_team(equipe))
with check ((autor_id = auth.uid() or public.is_chefia()) and public.can_write_team(equipe));

-- Validate new writes without rejecting legacy rows during migration.
create or replace function public.valid_plantao_items(items jsonb, kind text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare item jsonb;
begin
  if jsonb_typeof(items) is distinct from 'array' then return false; end if;
  if jsonb_array_length(items) > 500 then return false; end if;
  for item in select value from jsonb_array_elements(items) loop
    if kind = 'text' then
      if jsonb_typeof(item) is distinct from 'string' then return false; end if;
    elsif kind = 'absence' then
      if jsonb_typeof(item) is distinct from 'object'
        or jsonb_typeof(item->'nome') is distinct from 'string'
        or jsonb_typeof(item->'motivo') is distinct from 'string' then return false; end if;
    elsif kind = 'occurrence' then
      if jsonb_typeof(item) is distinct from 'object'
        or jsonb_typeof(item->'texto') is distinct from 'string'
        or jsonb_typeof(item->'gravidade') is distinct from 'string'
        or jsonb_typeof(item->'hora') is distinct from 'string' then return false; end if;
      if item->>'gravidade' not in ('Baixa','Media','Alta')
        or item->>'hora' !~ '^$|^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false; end if;
    else return false;
    end if;
  end loop;
  return true;
end;
$$;
alter table public.plantoes drop constraint if exists plantoes_payload_valid;
alter table public.plantoes add constraint plantoes_payload_valid check (
  length(btrim(equipe)) between 1 and 120 and equipe = btrim(equipe)
  and length(coalesce(coordenador,'')) <= 200
  and public.valid_plantao_items(integrantes, 'text')
  and public.valid_plantao_items(faltas, 'absence')
  and public.valid_plantao_items(dia, 'text') and public.valid_plantao_items(proximo, 'text')
  and public.valid_plantao_items(ocorrencias, 'occurrence')
  and octet_length(integrantes::text) + octet_length(faltas::text)
    + octet_length(dia::text) + octet_length(proximo::text)
    + octet_length(ocorrencias::text) <= 262144
) not valid;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;

create or replace function public.protect_plantao_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at = clock_timestamp();
    new.updated_at = new.created_at;
    return new;
  end if;
  if new.autor_id is distinct from old.autor_id or new.id is distinct from old.id
    or new.created_at is distinct from old.created_at then
    raise exception 'A autoria e a identidade do plantao nao podem ser alteradas.';
  end if;
  return new;
end;
$$;
drop trigger if exists plantoes_identity on public.plantoes;
create trigger plantoes_identity before insert or update on public.plantoes
for each row execute function public.protect_plantao_identity();

-- Audit entries survive deletion by a database administrator.
create table if not exists public.plantoes_audit (
  id bigint generated always as identity primary key,
  plantao_id uuid not null,
  actor_id uuid,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  occurred_at timestamptz not null default now(),
  previous_data jsonb,
  next_data jsonb
);
alter table public.plantoes_audit enable row level security;
revoke all on public.plantoes_audit from anon, authenticated;
revoke all on sequence public.plantoes_audit_id_seq from anon, authenticated;
grant select on public.plantoes_audit to authenticated;
drop policy if exists plantoes_audit_select on public.plantoes_audit;
create policy plantoes_audit_select on public.plantoes_audit for select to authenticated
using (public.is_chefia());

create or replace function public.audit_plantao()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.plantoes_audit (plantao_id, actor_id, operation, previous_data, next_data)
  values (coalesce(new.id, old.id), auth.uid(), tg_op,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end;
$$;
revoke all on function public.audit_plantao() from public, anon, authenticated;
drop trigger if exists plantoes_audit_changes on public.plantoes;
create trigger plantoes_audit_changes after insert or update or delete on public.plantoes
for each row execute function public.audit_plantao();

create index if not exists plantoes_data_id_idx on public.plantoes (data, id);
create index if not exists plantoes_autor_data_idx on public.plantoes (autor_id, data);
create index if not exists plantoes_audit_plantao_idx on public.plantoes_audit (plantao_id, occurred_at);
commit;
