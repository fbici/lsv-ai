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
    -- Compte Supabase ayant produit l'événement (null = visiteur anonyme).
    -- Permet au back-office le détail « par utilisateur ». RLS : ne peut être
    -- renseigné que pour soi-même (voir policy plus bas).
    user_id     uuid,
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
create index if not exists analytics_events_user_idx
    on public.analytics_events (user_id, created_at desc);

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
    -- user_id ne peut être renseigné que pour soi-même : un visiteur (anon,
    -- sans jeton utilisateur) ne peut jamais rattacher un événement à un
    -- compte existant. C'est ce contrôle qui rend la page « Actions » fiable.
    with check (user_id is null or user_id = auth.uid());

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

-- ── Réglages applicatifs (clés du fournisseur + quotas, back-office) ───────
-- Clés : une DÉDIÉE par outil (images / vidéos / chat) + une clé partagée de
-- secours (provider_api_key) utilisée si la clé de l'outil est vide, et pour
-- le module Motion. La passerelle les lit avec la clé de service du projet :
-- elles ne sont JAMAIS exposées aux visiteurs (aucun droit pour anon).
-- Quotas : valeurs journalières par compte, réglées dans /admin.
create table if not exists public.app_settings (
    key         text primary key,
    value       text not null,
    updated_at  timestamptz not null default now(),
    constraint app_settings_key_check check (key in (
        'provider_api_key',
        'provider_api_key_image',
        'provider_api_key_video',
        'provider_api_key_chat',
        'quota_enabled',
        'quota_suspended',
        'quota_image_daily',
        'quota_video_daily',
        'quota_chat_daily',
        'quota_motion_daily',
        'quota_global_daily',
        'quota_admin_image_daily',
        'quota_admin_video_daily',
        'quota_admin_chat_daily',
        'quota_admin_motion_daily'
    ))
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

-- ── Journal d'audit du back-office ─────────────────────────────────────────
-- Trace QUI a fait QUOI et QUAND, pour que plusieurs administrateurs puissent
-- se rendre compte entre eux (et pour garder une trace en cas d'incident).
--
-- Sécurité :
--   • actor_id / actor_email sont REMPLIS PAR UN TRIGGER à partir du JWT — le
--     client ne peut pas se faire passer pour un autre administrateur ;
--   • INSERT réservé à la liste blanche (is_admin()) ;
--   • SELECT réservé à la liste blanche ;
--   • AUCUN UPDATE ni DELETE : le journal est en écriture seule, on n'efface
--     pas l'historique de ce qui a été fait.
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

-- Le client n'écrit QUE son action ; l'identité de l'auteur est forcée ici.
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

-- ── QUOTAS JOURNALIERS PAR COMPTE ──────────────────────────────────────────
-- Limites réglables depuis /admin → « Limites et quotas » (table app_settings).
-- Par défaut : 20 images / 8 vidéos / 30 chats par jour et par compte,
-- remis à zéro à minuit UTC. Les images sont PONDÉRÉES par résolution :
-- 1K = 1 unité, 2K = 2 unités, 3K = 3 unités.
-- La consommation est ATOMIQUE (select … for update) : deux requêtes
-- simultanées ne peuvent pas dépasser le quota. Une génération échouée est
-- remboursée par public.refund_quota().
--
-- Voir supabase/upgrade-quotas.sql pour la version incrémentale détaillée.

create table if not exists public.usage_counters (
    user_id     uuid not null,
    day         date not null,
    kind        text not null check (kind in ('image', 'video', 'chat', 'motion', 'global')),
    units       integer not null default 0 check (units >= 0),
    updated_at  timestamptz not null default now(),
    primary key (user_id, day, kind)
);
create index if not exists usage_counters_day_idx on public.usage_counters (day desc);
create index if not exists usage_counters_kind_day_idx on public.usage_counters (kind, day desc);
alter table public.usage_counters enable row level security;
revoke all on public.usage_counters from anon;
revoke all on public.usage_counters from authenticated;
grant select on public.usage_counters to authenticated;
grant all on public.usage_counters to service_role;

drop policy if exists "admin_select_usage" on public.usage_counters;
create policy "admin_select_usage"
    on public.usage_counters
    for select
    to authenticated
    using (public.is_admin());

create or replace function public.consume_quota(
    p_user uuid, p_email text, p_kind text, p_units integer, p_global integer default 0
) returns jsonb
    language plpgsql security definer set search_path = public
    as $$
declare
    v_day      date := (now() at time zone 'utc')::date;
    v_zero     uuid := '00000000-0000-0000-0000-000000000000';
    v_units    integer := greatest(1, coalesce(p_units, 1));
    v_is_admin boolean;
    v_limit    integer := 0;
    /* app_settings.value est TEXT. Le lire DIRECTEMENT dans une variable
       ENTIERE (SELECT INTO) fait échouer la conversion dès que la valeur est
       '' — 22P02 « invalid input syntax for type integer: "" » — en dehors de
       toute garde nullif, ce qui met la fonction entière en échec et fait
       retomber la passerelle sur son compteur mémoire. On lit en TEXT puis on
       convertit en deux temps. */
    v_raw      text;
    v_key      text;
    v_enabled  text;
    v_glimit   integer := greatest(0, coalesce(p_global, 0));
    v_used     integer;
    v_gused    integer;
begin
    if p_user is null then
        return jsonb_build_object('ok', false, 'scope', 'anonymous');
    end if;
    select coalesce((select value from public.app_settings where key = 'quota_enabled'), '1') into v_enabled;
    if v_enabled <> '1' then
        return jsonb_build_object('ok', true, 'scope', 'disabled', 'kind', p_kind, 'units', v_units);
    end if;
    v_is_admin := exists (select 1 from public.admin_emails a where a.email = lower(coalesce(p_email, '')));
    v_key := 'quota_' || p_kind || '_daily';
    if v_is_admin then
        select value into v_raw from public.app_settings where key = 'quota_admin_' || p_kind || '_daily';
        if coalesce(btrim(v_raw), '') = '' then
            select value into v_raw from public.app_settings where key = v_key;
        end if;
    else
        select value into v_raw from public.app_settings where key = v_key;
    end if;
    v_limit := case when coalesce(btrim(v_raw), '') ~ '^[0-9]+$'
                    then btrim(v_raw)::integer else 0 end;
    if v_glimit > 0 then
        insert into public.usage_counters (user_id, day, kind, units) values (v_zero, v_day, 'global', 0)
        on conflict (user_id, day, kind) do nothing;
        select units into v_gused from public.usage_counters
         where user_id = v_zero and day = v_day and kind = 'global' for update;
        if coalesce(v_gused, 0) + v_units > v_glimit then
            return jsonb_build_object('ok', false, 'scope', 'global', 'kind', p_kind, 'units', v_units,
                'used', coalesce(v_gused, 0), 'limit', v_glimit,
                'remaining', greatest(0, v_glimit - coalesce(v_gused, 0)), 'unlimited', false);
        end if;
    end if;
    if v_limit > 0 then
        insert into public.usage_counters (user_id, day, kind, units) values (p_user, v_day, p_kind, 0)
        on conflict (user_id, day, kind) do nothing;
        select units into v_used from public.usage_counters
         where user_id = p_user and day = v_day and kind = p_kind for update;
        if coalesce(v_used, 0) + v_units > v_limit then
            return jsonb_build_object('ok', false, 'scope', 'user', 'kind', p_kind, 'units', v_units,
                'used', coalesce(v_used, 0), 'limit', v_limit,
                'remaining', greatest(0, v_limit - coalesce(v_used, 0)), 'unlimited', false);
        end if;
    end if;
    if v_glimit > 0 then
        update public.usage_counters set units = units + v_units, updated_at = now()
         where user_id = v_zero and day = v_day and kind = 'global';
    end if;
    update public.usage_counters set units = units + v_units, updated_at = now()
     where user_id = p_user and day = v_day and kind = p_kind;
    if not found then
        insert into public.usage_counters (user_id, day, kind, units) values (p_user, v_day, p_kind, v_units)
        on conflict (user_id, day, kind)
        do update set units = public.usage_counters.units + excluded.units, updated_at = now();
    end if;
    select units into v_used from public.usage_counters
     where user_id = p_user and day = v_day and kind = p_kind;
    return jsonb_build_object('ok', true, 'scope', 'user', 'kind', p_kind, 'units', v_units,
        'used', coalesce(v_used, 0), 'limit', v_limit,
        'remaining', case when v_limit > 0 then greatest(0, v_limit - coalesce(v_used, 0)) else null end,
        'unlimited', v_limit <= 0);
end;
$$;
revoke execute on function public.consume_quota(uuid, text, text, integer, integer) from public, anon, authenticated;
grant  execute on function public.consume_quota(uuid, text, text, integer, integer) to service_role;

create or replace function public.refund_quota(p_user uuid, p_kind text, p_units integer) returns void
    language plpgsql security definer set search_path = public
    as $$
declare
    v_day   date := (now() at time zone 'utc')::date;
    v_zero  uuid := '00000000-0000-0000-0000-000000000000';
    v_units integer := greatest(1, coalesce(p_units, 1));
begin
    if p_user is null then return; end if;
    update public.usage_counters set units = greatest(0, units - v_units), updated_at = now()
     where user_id = p_user and day = v_day and kind = p_kind;
    update public.usage_counters set units = greatest(0, units - v_units), updated_at = now()
     where user_id = v_zero and day = v_day and kind = 'global';
end;
$$;
revoke execute on function public.refund_quota(uuid, text, integer) from public, anon, authenticated;
grant  execute on function public.refund_quota(uuid, text, integer) to service_role;

create or replace function public.get_quota(p_user uuid, p_email text) returns jsonb
    language plpgsql security definer stable set search_path = public
    as $$
declare
    v_day      date := (now() at time zone 'utc')::date;
    v_zero     uuid := '00000000-0000-0000-0000-000000000000';
    v_is_admin boolean;
    v_result   jsonb := '{}'::jsonb;
    v_limit    integer;
    v_used     integer;
    v_kind     text;
    /* TEXT d'abord : voir le commentaire identique dans consume_quota —
       lire app_settings.value directement dans une variable ENTIERE casse la
       fonction dès que la valeur est ''. */
    v_raw      text;
begin
    v_result := jsonb_build_object(
        'enabled',   coalesce((select value from public.app_settings where key = 'quota_enabled'), '1') = '1',
        'suspended', coalesce((select value from public.app_settings where key = 'quota_suspended'), '0') = '1',
        'day', v_day, 'limits', '{}'::jsonb, 'used', '{}'::jsonb, 'remaining', '{}'::jsonb);
    if (v_result->>'enabled') <> 'true' then return v_result; end if;
    v_is_admin := exists (select 1 from public.admin_emails a where a.email = lower(coalesce(p_email, '')));
    foreach v_kind in array array['image', 'video', 'chat', 'motion'] loop
        v_limit := null;
        v_raw := null;
        if v_is_admin then
            select value into v_raw from public.app_settings where key = 'quota_admin_' || v_kind || '_daily';
        end if;
        if coalesce(btrim(v_raw), '') = '' then
            select value into v_raw from public.app_settings where key = 'quota_' || v_kind || '_daily';
        end if;
        v_limit := case when coalesce(btrim(v_raw), '') ~ '^[0-9]+$'
                        then btrim(v_raw)::integer else 0 end;
        select units into v_used from public.usage_counters where user_id = p_user and day = v_day and kind = v_kind;
        v_result := v_result || jsonb_build_object(
            'limits',    (v_result->'limits')    || jsonb_build_object(v_kind, v_limit),
            'used',      (v_result->'used')      || jsonb_build_object(v_kind, coalesce(v_used, 0)),
            'remaining', (v_result->'remaining') || jsonb_build_object(
                v_kind, case when v_limit > 0 then greatest(0, v_limit - coalesce(v_used, 0)) else null end));
    end loop;
    v_limit := coalesce(nullif((select btrim(value) from public.app_settings where key = 'quota_global_daily'), '')::integer, 0);
    select units into v_used from public.usage_counters where user_id = v_zero and day = v_day and kind = 'global';
    v_result := v_result || jsonb_build_object('global', jsonb_build_object(
        'limit', v_limit, 'used', coalesce(v_used, 0),
        'remaining', case when v_limit > 0 then greatest(0, v_limit - coalesce(v_used, 0)) else null end));
    return v_result;
end;
$$;
revoke execute on function public.get_quota(uuid, text) from public, anon, authenticated;
grant  execute on function public.get_quota(uuid, text) to service_role;

insert into public.app_settings (key, value) values
    ('quota_enabled', '1'), ('quota_suspended', '0'),
    ('quota_image_daily', '20'), ('quota_video_daily', '8'),
    ('quota_chat_daily', '30'), ('quota_motion_daily', '0'), ('quota_global_daily', '0')
on conflict (key) do nothing;

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
--   ('demo_visitor_2', 'demo_session_2', 'video_generated', '{"model":"agnes-video-2.5-flash","mode":"text-to-video"}'),
--   ('demo_visitor_2', 'demo_session_2', 'generation_error', '{"feature":"video","detail":"HTTP 500"}');
