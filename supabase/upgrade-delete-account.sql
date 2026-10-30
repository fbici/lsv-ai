-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — Compte supprimé : liste de refroidissement (30 jours)
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter dans : Supabase Dashboard → SQL Editor → New query → Run
-- (puis déployer la fonction : npx supabase functions deploy delete-account)
--
-- Après une suppression de compte, l'e-mail est conservé 30 jours pour
-- empêcher la re-création immédiate du même compte. La table n'est lisible
-- par PERSONNE côté client (aucune policy) : seule la fonction d'environnement
-- delete-account (clé de service) y écrit, et la fonction SECURITY DEFINER
-- email_cooling_down() ne renvoie qu'une date de fin.
--
-- Idempotent : réexécutable sans erreur (create if not exists / create or replace).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Événement analytics « compte supprimé » (liste blanche) ────────────────
-- Recrée la contrainte de whitelist des événements en y ajoutant
-- 'account_deleted' (nom par défaut : analytics_events_event_check).
alter table public.analytics_events drop constraint if exists analytics_events_event_check;
alter table public.analytics_events add constraint analytics_events_event_check check (event in (
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
    'account_signed_in',
    'account_deleted'
));

-- ── Table de refroidissement ───────────────────────────────────────────────
create table if not exists public.deleted_emails (
    email       text primary key check (char_length(email) between 3 and 254),
    deleted_at  timestamptz not null default now()
);
alter table public.deleted_emails enable row level security;
-- Aucune policy : ni anon ni authenticated ne lisent ni n'écrivent.
revoke all on public.deleted_emails from anon, authenticated;
grant all on public.deleted_emails to service_role;

-- ── Fin du refroidissement pour un e-mail (ISO) ou null si libre ───────────
create or replace function public.email_cooling_down(p_email text) returns text
    language sql stable security definer
    set search_path = public
    as $$
        select to_char(d.deleted_at + interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        from public.deleted_emails d
        where d.email = lower(trim(coalesce(p_email, '')))
          and d.deleted_at > now() - interval '30 days'
        limit 1;
    $$;
grant execute on function public.email_cooling_down(text) to anon, authenticated;

-- ── Garde-fou serveur : GoTrue refuse l'inscription en refroidissement ─────
create or replace function public.lsv_block_deleted_email() returns trigger
    language plpgsql security definer
    set search_path = public
    as $$
    begin
        if exists (
            select 1 from public.deleted_emails d
            where d.email = lower(trim(coalesce(new.email, '')))
              and d.deleted_at > now() - interval '30 days'
        ) then
            raise exception 'email_in_cooldown';
        end if;
        return new;
    end;
    $$;
drop trigger if exists lsv_block_deleted_email on auth.users;
create trigger lsv_block_deleted_email
    before insert on auth.users
    for each row execute function public.lsv_block_deleted_email();

-- ── Lecture ponctuelle (après coupure, pour vérifier) ──────────────────────
-- select * from public.deleted_emails order by deleted_at desc limit 20;
-- select public.email_cooling_down('ancien@exemple.com');
-- delete from public.deleted_emails where email = 'ancien@exemple.com';