-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — Table public.profiles : nom complet de chaque compte
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter dans : Supabase Dashboard → SQL Editor → New query → Run
-- Idempotent : ré-exécutable sans risque.
--
-- • Ne stocke AUCUN secret (pas de mot de passe, pas de clé) : seulement le
--   nom transmis à l'inscription (user_metadata.full_name).
-- • Remplie automatiquement par un trigger à chaque inscription ; les
--   comptes déjà créés sont recopiés au moment de l'exécution.
-- • Lecture : chacun voit son propre nom ; la liste blanche (admin_emails)
--   voit tous les noms. Personne d'autre (anon compris) n'y accède.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.profiles (
    id          uuid primary key references auth.users (id) on delete cascade,
    full_name   text check (char_length(full_name) between 1 and 120),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
revoke all on public.profiles from authenticated;
grant select, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
    on public.profiles
    for select
    to authenticated
    using (auth.uid() = id);

drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin"
    on public.profiles
    for select
    to authenticated
    using (public.is_admin());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
    on public.profiles
    for update
    to authenticated
    using (auth.uid() = id)
    with check (auth.uid() = id);

create or replace function public.handle_new_user() returns trigger
    language plpgsql security definer
    set search_path = public
    as $$
    begin
        insert into public.profiles (id, full_name)
        values (new.id, nullif(coalesce(
            new.raw_user_meta_data ->> 'full_name',
            new.raw_user_meta_data ->> 'name'
        ), ''))
        on conflict (id) do update
            set full_name = excluded.full_name,
                updated_at = now();
        return new;
    end;
    $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
    after update of raw_user_meta_data on auth.users
    for each row execute function public.handle_new_user();

-- Comptes déjà inscrits : recopie du nom existant (une seule fois).
insert into public.profiles (id, full_name)
select u.id, nullif(coalesce(
    u.raw_user_meta_data ->> 'full_name',
    u.raw_user_meta_data ->> 'name'
), '')
from auth.users u
on conflict (id) do nothing;

-- ── Vérification ───────────────────────────────────────────────────────────
-- select p.id, p.full_name, p.created_at, u.email
-- from public.profiles p
-- join auth.users u on u.id = p.id
-- order by p.created_at desc;
