-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — Migration : actions par utilisateur + journal d'audit
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter dans : Supabase Dashboard → SQL Editor → New query → Run
--
-- AJOUTE (sans rien écraser) :
--   1. analytics_events.user_id  — rattache un événement au compte connecté
--      (null = visiteur anonyme). Permet la page « Actions » du back-office.
--   2. public.admin_logs         — journal d'audit « qui a fait quoi, quand »,
--      en écriture seule, auteur forcé par trigger (voir §Logs du README).
--
-- Idempotent : plusieurs exécutions sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Colonne user_id sur les événements ──────────────────────────────────
alter table public.analytics_events
    add column if not exists user_id uuid;

create index if not exists analytics_events_user_idx
    on public.analytics_events (user_id, created_at desc);

-- Politique d'insertion : user_id ne peut être renseigné que pour soi-même.
drop policy if exists "anon_insert_events" on public.analytics_events;
create policy "anon_insert_events"
    on public.analytics_events
    for insert
    to anon, authenticated
    with check (user_id is null or user_id = auth.uid());

-- ── 2. Journal d'audit du back-office ──────────────────────────────────────
create table if not exists public.admin_logs (
    id          uuid primary key default gen_random_uuid(),
    created_at  timestamptz not null default now(),
    actor_id    uuid,
    actor_email text,
    action      text not null check (char_length(action) between 1 and 60),
    target      text check (target is null or char_length(target) between 1 and 160),
    detail      jsonb not null default '{}'::jsonb,
    constraint admin_logs_detail_size_ok check (coalesce(pg_column_size(detail), 0) < 2048)
);
alter table public.admin_logs enable row level security;
revoke all on public.admin_logs from anon;
revoke all on public.admin_logs from authenticated;
grant insert, select on public.admin_logs to authenticated;
grant all on public.admin_logs to service_role;

create index if not exists admin_logs_created_at_idx
    on public.admin_logs (created_at desc);
create index if not exists admin_logs_actor_idx
    on public.admin_logs (actor_email, created_at desc);
create index if not exists admin_logs_action_idx
    on public.admin_logs (action, created_at desc);

create or replace function public.set_log_actor() returns trigger
    language plpgsql security definer
    set search_path = public
    as $$
    begin
        new.actor_id    := auth.uid();
        new.actor_email := lower(coalesce(auth.jwt() ->> 'email', ''));
        if new.actor_email = '' then
            raise exception 'journal d audit : compte non authentifié';
        end if;
        return new;
    end;
    $$;

drop trigger if exists admin_logs_set_actor on public.admin_logs;
create trigger admin_logs_set_actor
    before insert on public.admin_logs
    for each row execute function public.set_log_actor();

drop policy if exists "admin_insert_logs" on public.admin_logs;
create policy "admin_insert_logs"
    on public.admin_logs
    for insert
    to authenticated
    with check (public.is_admin());

drop policy if exists "admin_select_logs" on public.admin_logs;
create policy "admin_select_logs"
    on public.admin_logs
    for select
    to authenticated
    using (public.is_admin());

-- ── 3. Première trace (optionnel, vérifie que tout fonctionne) ─────────────
-- insert into public.admin_logs (action, target, detail)
--     values ('migration_appliquee', 'upgrade-activity-logs.sql', '{"note":"actions par utilisateur + journal d audit"}');
