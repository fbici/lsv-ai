-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — MIGRATION : comptes utilisateurs + liste blanche admin
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter dans : Supabase Dashboard → SQL Editor → New query → Run
--
-- Pour une base DÉJÀ créée (la table analytics_events existe déjà).
-- Idempotent : peut être relancé sans risque.
--
-- Après l'exécution, OUBLIE PAS d'ajouter ton e-mail (étape 3 en bas),
-- sinon AUCUN compte ne verra les statistiques.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Table de la liste blanche (invisible côté client) ──────────────────────
create table if not exists public.admin_emails (
    email       text primary key,
    created_at  timestamptz not null default now()
);
alter table public.admin_emails enable row level security;
revoke all on public.admin_emails from anon, authenticated;

-- 2) Fonction de contrôle d'accès ───────────────────────────────────────────
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

-- 3) Lecture des statistiques : uniquement les e-mails de la liste blanche ──
drop policy if exists "authenticated_select_events" on public.analytics_events;
create policy "authenticated_select_events"
    on public.analytics_events
    for select
    to authenticated
    using (public.is_admin());

-- 4) Événements « comptes » autorisés dans la liste de la colonne event ─────
alter table public.analytics_events
    drop constraint if exists analytics_events_event_check;
alter table public.analytics_events
    add constraint analytics_events_event_check check (event in (
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
    ));

-- 5) ⚠️  AJOUTE TON E-MAIL — ET UNIQUEMENT LE TIEN — CI-DESSOUS ⚠️ ────────
-- (si tu ouvres l'accès à quelqu'un : même procédure, une ligne par e-mail)
insert into public.admin_emails (email) values ('toi@exemple.com')
    on conflict (email) do nothing;
-- (remplace toi@exemple.com par l'e-mail exact de ton compte Supabase Auth)

-- Retirer quelqu'un :
-- delete from public.admin_emails where email = 'ancien@exemple.com';

-- Vérification (doit renvoyer UNE seule ligne : la tienne) :
-- select * from public.admin_emails;
