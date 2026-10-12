-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — Table public.profiles : nom + e-mail + dernière connexion
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter dans : Supabase Dashboard → SQL Editor → New query → Run
-- Idempotent : ré-exécutable sans risque (colonnes, triggers, recopie).
--
-- • Ne stocke AUCUN secret (pas de mot de passe, pas de clé) : seulement le
--   nom transmis à l'inscription, l'e-mail et la date de dernière connexion.
-- • Rempli automatiquement par un trigger à chaque inscription / connexion ;
--   les comptes déjà créés sont (re)recopiés à chaque exécution.
-- • Lecture : chacun voit sa propre ligne ; la liste blanche (admin_emails)
--   voit tous les comptes. Personne d'autre (anon compris) n'y accède.
-- • Sert de source à la page « Utilisateurs » du back-office.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.profiles (
    id              uuid primary key references auth.users (id) on delete cascade,
    email           text,
    full_name       text check (char_length(full_name) between 1 and 120),
    last_sign_in_at timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists last_sign_in_at timestamptz;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

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
        insert into public.profiles (id, email, full_name, last_sign_in_at)
        values (
            new.id,
            new.email,
            nullif(coalesce(
                new.raw_user_meta_data ->> 'full_name',
                new.raw_user_meta_data ->> 'name'
            ), ''),
            new.last_sign_in_at
        )
        on conflict (id) do update
            set email           = coalesce(excluded.email, public.profiles.email),
                full_name       = coalesce(excluded.full_name, public.profiles.full_name),
                last_sign_in_at = coalesce(excluded.last_sign_in_at, public.profiles.last_sign_in_at),
                updated_at      = now();
        return new;
    end;
    $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
    after update of raw_user_meta_data, email, last_sign_in_at on auth.users
    for each row execute function public.handle_new_user();

-- Comptes déjà inscrits : (re)copie du nom, de l'e-mail et de la connexion.
insert into public.profiles (id, email, full_name, last_sign_in_at)
select u.id, u.email, nullif(coalesce(
    u.raw_user_meta_data ->> 'full_name',
    u.raw_user_meta_data ->> 'name'
), ''), u.last_sign_in_at
from auth.users u
on conflict (id) do update
    set email           = coalesce(excluded.email, public.profiles.email),
        full_name       = coalesce(excluded.full_name, public.profiles.full_name),
        last_sign_in_at = coalesce(excluded.last_sign_in_at, public.profiles.last_sign_in_at),
        updated_at      = now();

-- ── Vérification ───────────────────────────────────────────────────────────
-- select p.email, p.full_name, p.created_at, p.last_sign_in_at
-- from public.profiles p
-- order by p.created_at desc;
--
-- Compte bloqué sur « vérifie ton e-mail » alors que l'e-mail n'arrive jamais :
--   update auth.users set email_confirmed_at = now(), confirmation_token = null
--   where email = 'toi@exemple.com' and email_confirmed_at is null;
