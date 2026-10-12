-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — Schéma Analytics (Supabase / PostgreSQL)
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter dans : Supabase Dashboard → SQL Editor → New query → Run
--
-- Modèle de sécurité :
--   • INSERT anonyme  : autorisé (le public peut envoyer des événements),
--                       mais STRICTEMENT limité à la table analytics_events
--                       et à une liste blanche d'événements.
--   • SELECT          : réservé aux comptes authentifiés (Supabase Auth)
--                       dont l'e-mail figure dans la liste blanche
--                       public.admin_emails (table invisible côté client).
--   • Aucun UPDATE / DELETE anon : le public ne peut ni modifier ni purger.
--   • Le "service_role" key n'est jamais utilisé par le front.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── Table des événements ───────────────────────────────────────────────────
create table if not exists public.analytics_events (
    id          uuid primary key default gen_random_uuid(),
    created_at  timestamptz not null default now(),
    visitor_id  text not null check (char_length(visitor_id) between 1 and 64),
    session_id  text not null check (char_length(session_id) between 1 and 64),
    event       text not null check (event in (
                    'page_view',
                    'tab_view',
                    'image_generated',
                    'video_generated',
                    'chat_used',
                    'motion_generated',
                    'project_created',
                    'generation_error',
                    'enhancer_used',
                    'batch_completed',
                    'account_created',
                    'account_signed_in'
                )),
    props       jsonb not null default '{}'::jsonb,
    -- aucune donnée volumineuse : refuse les payloads > 4 Ko
    constraint props_size_ok check (coalesce(pg_column_size(props), 0) < 4096)
);

create index if not exists analytics_events_created_at_idx
    on public.analytics_events (created_at desc);
create index if not exists analytics_events_event_idx
    on public.analytics_events (event, created_at desc);
create index if not exists analytics_events_visitor_idx
    on public.analytics_events (visitor_id, created_at desc);

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table public.analytics_events enable row level security;

-- ── Liste blanche des comptes administrateurs ──────────────────────────────
create table if not exists public.admin_emails (
    email       text primary key,
    created_at  timestamptz not null default now()
);
alter table public.admin_emails enable row level security;
-- Supabase accorde tous les droits aux rôles client par défaut : on retire tout
-- (aucune policy ne s'applique non plus : la table n'est lisible par personne).
revoke all on public.admin_emails from anon, authenticated;

-- Fonction appelée par le back-office (bouton "suis-je admin ?") et par la
-- policy de lecture ci-dessous. SECURITY DEFINER : elle lit admin_emails en
-- tant que propriétaire de la table, ce que la RLS interdirait sinon.
create or replace function public.is_admin() returns boolean
    language sql stable security definer
    set search_path = public
    as $$
        select exists (
            select 1 from public.admin_emails a
            where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
        );
    $$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

drop policy if exists "anon_insert_events" on public.analytics_events;
create policy "anon_insert_events"
    on public.analytics_events
    for insert
    to anon, authenticated
    with check (true);

drop policy if exists "authenticated_select_events" on public.analytics_events;
create policy "authenticated_select_events"
    on public.analytics_events
    for select
    to authenticated
    using (public.is_admin());

-- Pas de policy UPDATE/DELETE pour anon : lecture/écriture interdites hors insert.

-- ── Droits explicites ──────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated;
grant insert on public.analytics_events to anon, authenticated;
grant select on public.analytics_events to authenticated;

-- ── Réglages applicatifs (clé du fournisseur, saisie dans le back-office) ──
-- La passerelle (Edge Function lsv-gateway) lit la clé avec la clé de service
-- du projet : elle n'est JAMAIS exposée aux visiteurs (aucun droit pour anon).
-- Seuls les comptes de la liste blanche peuvent la lire ou la modifier.
create table if not exists public.app_settings (
    key         text primary key,
    value       text not null,
    updated_at  timestamptz not null default now(),
    constraint app_settings_key_check check (key in ('provider_api_key'))
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon;
revoke all on public.app_settings from authenticated;
grant select, insert, update, delete on public.app_settings to authenticated;
grant all on public.app_settings to service_role;

drop policy if exists "admin_select_settings" on public.app_settings;
create policy "admin_select_settings"
    on public.app_settings
    for select
    to authenticated
    using (public.is_admin());

drop policy if exists "admin_insert_settings" on public.app_settings;
create policy "admin_insert_settings"
    on public.app_settings
    for insert
    to authenticated
    with check (public.is_admin());

drop policy if exists "admin_update_settings" on public.app_settings;
create policy "admin_update_settings"
    on public.app_settings
    for update
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());

drop policy if exists "admin_delete_settings" on public.app_settings;
create policy "admin_delete_settings"
    on public.app_settings
    for delete
    to authenticated
    using (public.is_admin());

-- insert into public.app_settings (key, value) values ('provider_api_key', '...')
--     on conflict (key) do update set value = excluded.value, updated_at = now();

-- ── Profils : le nom complet de chaque compte, en SQL ──────────────────────
-- Supabase Auth garde le compte (e-mail, mot de passe) dans auth.users.
-- Cette table ne recopie que le NOM (pas de secret, pas de mot de passe) pour
-- le rendre lisible dans le SQL Editor et lisible par la liste blanche.
-- Remplie automatiquement à l'inscription (trigger), jamais par le client.
create table if not exists public.profiles (
    id              uuid primary key references auth.users (id) on delete cascade,
    email           text,
    full_name       text check (char_length(full_name) between 1 and 120),
    last_sign_in_at timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
revoke all on public.profiles from authenticated;
grant select, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

-- Lecture : chacun voit son propre profil ; la liste blanche voit tous les noms.
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

-- Mise à jour : chacun corrige son propre nom ; pas d'INSERT ni de DELETE
-- côté client (c'est le trigger ci-dessous qui remplit la table).
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

-- Comptes créés avant l'existence de cette table : recopie du nom, de l'e-mail
-- et de la dernière connexion (exécution possible plusieurs fois sans effet).
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

-- ── LISTE BLANCHE : un e-mail = un accès admin ─────────────────────────────
-- Une seule ligne pour un seul administrateur ; ajoute-en une autre
-- uniquement si tu veux ouvrir l'accès à quelqu'un d'autre.
-- insert into public.admin_emails (email) values ('toi@exemple.com')
--     on conflict (email) do nothing;
-- delete from public.admin_emails where email = 'ancien@exemple.com';
--
-- Sans cette ligne, AUCUN compte (tien compris) ne voit les statistiques :
-- le back-office affiche "Compte non autorisé".

-- ── Données de test (optionnel) ────────────────────────────────────────────
-- insert into public.analytics_events (visitor_id, session_id, event, props) values
--   ('demo_visitor_1', 'demo_session_1', 'page_view', '{"path":"/"}'),
--   ('demo_visitor_1', 'demo_session_1', 'image_generated', '{"model":"agnes-image-2.1-flash","ratio":"16:9"}'),
--   ('demo_visitor_2', 'demo_session_2', 'video_generated', '{"model":"agnes-video-v2.0","mode":"text-to-video"}'),
--   ('demo_visitor_2', 'demo_session_2', 'generation_error', '{"feature":"video","detail":"HTTP 500"}');
