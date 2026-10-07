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

-- ── LISTE BLANCHE : ajoute (ou retire) les e-mails administrateurs ─────────
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
