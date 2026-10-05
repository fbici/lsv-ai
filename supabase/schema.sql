-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — Schéma Analytics (Supabase / PostgreSQL)
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter dans : Supabase Dashboard → SQL Editor → New query → Run
--
-- Modèle de sécurité :
--   • INSERT anonyme  : autorisé (le public peut envoyer des événements),
--                       mais STRICTEMENT limité à la table analytics_events
--                       et à une liste blanche d'événements.
--   • SELECT          : réservé aux comptes authentifiés (Supabase Auth).
--                       Aucune donnée n'est lisible sans compte admin.
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
                    'batch_completed'
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
    using (true);

-- Pas de policy UPDATE/DELETE pour anon : lecture/écriture interdites hors insert.

-- ── Droits explicites ──────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated;
grant insert on public.analytics_events to anon, authenticated;
grant select on public.analytics_events to authenticated;

-- ── OPTIONNEL : restreindre la lecture à une liste blanche d'emails admin ──
-- 1) créer la table :
-- create table if not exists public.admin_emails (email text primary key, created_at timestamptz default now());
-- alter table public.admin_emails enable row level security;
-- grant select on public.admin_emails to authenticated;
-- 2) ajouter ton email :
-- insert into public.admin_emails (email) values ('toi@exemple.com') on conflict do nothing;
-- 3) remplacer la policy "authenticated_select_events" par :
-- drop policy if exists "authenticated_select_events" on public.analytics_events;
-- create policy "authenticated_select_events" on public.analytics_events
--     for select to authenticated
--     using ((auth.jwt() ->> 'email') in (select email from public.admin_emails));

-- ── Données de test (optionnel) ────────────────────────────────────────────
-- insert into public.analytics_events (visitor_id, session_id, event, props) values
--   ('demo_visitor_1', 'demo_session_1', 'page_view', '{"path":"/"}'),
--   ('demo_visitor_1', 'demo_session_1', 'image_generated', '{"model":"agnes-image-2.1-flash","ratio":"16:9"}'),
--   ('demo_visitor_2', 'demo_session_2', 'video_generated', '{"model":"agnes-video-v2.0","mode":"text-to-video"}'),
--   ('demo_visitor_2', 'demo_session_2', 'generation_error', '{"feature":"video","detail":"HTTP 500"}');
