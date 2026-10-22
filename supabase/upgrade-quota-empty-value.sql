-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — CORRECTION : lecture des quotas quand app_settings.value est vide
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter dans le SQL Editor du Dashboard Supabase.
-- Idempotent : relancer ce fichier ne casse rien.
--
-- BUG CORRIGÉ
--   consume_quota / get_quota lisaient app_settings.value (TEXT) DIRECTEMENT
--   dans une variable ENTIERE via SELECT INTO :
--
--       select value into v_limit from public.app_settings where key = ...;
--                                       ^^^^^^^^ integer
--
--   Postgres convertit au moment de l'affectation, donc AVANT toute garde
--   nullif. Dès que la valeur est la chaîne vide, toute la fonction échoue :
--
--       {"code":"22P02",
--        "message":"invalid input syntax for type integer: \"\""}
--
--   La passerelle journalise alors « quota-rpc-status 400 » et retombe sur son
--   compteur MÉMOIRE : les quotas journaliers ne sont plus comptés ni
--   persistants, et le remboursement échoue aussi.
--
--   Correctif : lecture dans une variable TEXT (v_raw), puis conversion en
--   deux temps, avec rejet des valeurs non numériques avant le cast.
--
-- CORRECTION DES DONNÉES
--   La requête ci-dessous diagnostique puis normalise les valeurs vides ou
--   non numériques en '0' (= illimité), ce que l'interface faisait déjà de son
--   côté via parseInt. Elle ne touche que les clés de quota.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Diagnostic : quelles valeurs sont cassées ? ─────────────────────────
select key, value, length(value) as longueur
  from public.app_settings
 where key like 'quota_%'
 order by key;

-- ── 2. Normalisation (facultatif, sûre, idempotent) ────────────────────────
update public.app_settings
   set value = '0'
 where key like 'quota_%'
   and btrim(coalesce(value, '')) !~ '^[0-9]+$';

-- ── 3. Fonctions corrigées ─────────────────────────────────────────────────
create or replace function public.consume_quota(
    p_user   uuid,
    p_email  text,
    p_kind   text,
    p_units  integer,
    p_global integer default 0
) returns jsonb
    language plpgsql
    security definer
    set search_path = public
    as $$
declare
    v_day        date := (now() at time zone 'utc')::date;
    v_zero       uuid := '00000000-0000-0000-0000-000000000000';
    v_units      integer := greatest(1, coalesce(p_units, 1));
    v_is_admin   boolean;
    v_limit      integer := 0;
    /* app_settings.value est TEXT. Le lire DIRECTEMENT dans une variable
       ENTIERE (SELECT INTO) fait échouer la conversion dès que la valeur est
       '' — 22P02 « invalid input syntax for type integer: "" » — en dehors de
       toute garde nullif, ce qui met la fonction entière en échec et fait
       retomber la passerelle sur son compteur mémoire. On lit en TEXT puis on
       convertit en deux temps. */
    v_raw      text;
    v_key        text;
    v_enabled    text;
    v_glimit     integer := greatest(0, coalesce(p_global, 0));
    v_used       integer;
    v_gused      integer;
begin
    if p_user is null then
        return jsonb_build_object('ok', false, 'scope', 'anonymous');
    end if;

    select coalesce((select value from public.app_settings where key = 'quota_enabled'), '1') into v_enabled;
    if v_enabled <> '1' then
        return jsonb_build_object('ok', true, 'scope', 'disabled', 'kind', p_kind, 'units', v_units);
    end if;

    v_is_admin := exists (
        select 1 from public.admin_emails a
        where a.email = lower(coalesce(p_email, ''))
    );

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

    -- ── limite globale d'abord (verrou sur la ligne globale) ──
    if v_glimit > 0 then
        insert into public.usage_counters (user_id, day, kind, units)
        values (v_zero, v_day, 'global', 0)
        on conflict (user_id, day, kind) do nothing;

        select units into v_gused
        from public.usage_counters
        where user_id = v_zero and day = v_day and kind = 'global'
        for update;

        if coalesce(v_gused, 0) + v_units > v_glimit then
            return jsonb_build_object(
                'ok', false, 'scope', 'global', 'kind', p_kind,
                'units', v_units, 'used', coalesce(v_gused, 0), 'limit', v_glimit,
                'remaining', greatest(0, v_glimit - coalesce(v_gused, 0)), 'unlimited', false
            );
        end if;
    end if;

    -- ── quota du compte ──
    if v_limit > 0 then
        insert into public.usage_counters (user_id, day, kind, units)
        values (p_user, v_day, p_kind, 0)
        on conflict (user_id, day, kind) do nothing;

        select units into v_used
        from public.usage_counters
        where user_id = p_user and day = v_day and kind = p_kind
        for update;

        if coalesce(v_used, 0) + v_units > v_limit then
            return jsonb_build_object(
                'ok', false, 'scope', 'user', 'kind', p_kind,
                'units', v_units, 'used', coalesce(v_used, 0), 'limit', v_limit,
                'remaining', greatest(0, v_limit - coalesce(v_used, 0)), 'unlimited', false
            );
        end if;
    end if;

    -- ── les deux tiennent : on incrémente ──
    if v_glimit > 0 then
        update public.usage_counters
           set units = units + v_units, updated_at = now()
         where user_id = v_zero and day = v_day and kind = 'global';
    end if;

    update public.usage_counters
       set units = units + v_units, updated_at = now()
     where user_id = p_user and day = v_day and kind = p_kind;
    if not found then
        insert into public.usage_counters (user_id, day, kind, units)
        values (p_user, v_day, p_kind, v_units)
        on conflict (user_id, day, kind)
        do update set units = public.usage_counters.units + excluded.units, updated_at = now();
    end if;

    select units into v_used
    from public.usage_counters
    where user_id = p_user and day = v_day and kind = p_kind;

    return jsonb_build_object(
        'ok', true, 'scope', 'user', 'kind', p_kind,
        'units', v_units, 'used', coalesce(v_used, 0),
        'limit', v_limit, 'remaining', case when v_limit > 0 then greatest(0, v_limit - coalesce(v_used, 0)) else null end,
        'unlimited', v_limit <= 0
    );
end;
$$;

revoke execute on function public.consume_quota(uuid, text, text, integer, integer) from public, anon, authenticated;
grant  execute on function public.consume_quota(uuid, text, text, integer, integer) to service_role;

create or replace function public.get_quota(
    p_user  uuid,
    p_email text
) returns jsonb
    language plpgsql
    security definer
    stable
    set search_path = public
    as $$
declare
    v_day      date := (now() at time zone 'utc')::date;
    v_zero     uuid := '00000000-0000-0000-0000-000000000000';
    v_is_admin boolean;
    v_result   jsonb := '{"enabled":true,"suspended":false,"limits":{},"used":{},"remaining":{}}'::jsonb;
    v_limit    integer;
    v_used     integer;
    v_kind     text;
    /* TEXT d'abord : voir le commentaire identique dans consume_quota —
       lire app_settings.value directement dans une variable ENTIERE casse la
       fonction dès que la valeur est ''. */
    v_raw      text;
begin
    v_result := v_result || jsonb_build_object(
        'enabled', coalesce((select value from public.app_settings where key = 'quota_enabled'), '1') = '1',
        'suspended', coalesce((select value from public.app_settings where key = 'quota_suspended'), '0') = '1',
        'day', v_day
    );

    if coalesce((select value from public.app_settings where key = 'quota_enabled'), '1') <> '1' then
        return v_result;
    end if;

    v_is_admin := exists (
        select 1 from public.admin_emails a
        where a.email = lower(coalesce(p_email, ''))
    );

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

        select units into v_used from public.usage_counters
         where user_id = p_user and day = v_day and kind = v_kind;

        v_result := v_result || jsonb_build_object(
            'limits',  (v_result->'limits')  || jsonb_build_object(v_kind, v_limit),
            'used',    (v_result->'used')    || jsonb_build_object(v_kind, coalesce(v_used, 0)),
            'remaining', (v_result->'remaining') || jsonb_build_object(
                v_kind, case when v_limit > 0 then greatest(0, v_limit - coalesce(v_used, 0)) else null end)
        );
    end loop;

    v_limit := coalesce(nullif((select btrim(value) from public.app_settings where key = 'quota_global_daily'), '')::integer, 0);
    select units into v_used from public.usage_counters
     where user_id = v_zero and day = v_day and kind = 'global';
    v_result := v_result || jsonb_build_object(
        'global', jsonb_build_object('limit', v_limit, 'used', coalesce(v_used, 0),
            'remaining', case when v_limit > 0 then greatest(0, v_limit - coalesce(v_used, 0)) else null end)
    );

    return v_result;
end;
$$;

revoke execute on function public.get_quota(uuid, text) from public, anon, authenticated;
grant  execute on function public.get_quota(uuid, text) to service_role;

-- ── 4. Vérification (lecture seule) ────────────────────────────────────────
-- Avant la correction, un quota vide produisait :
--   {"code":"22P02","message":"invalid input syntax for type integer: ""}
-- Après : enabled/limits renvoyés, jamais d'erreur.
select public.get_quota(
    '00000000-0000-0000-0000-000000000000', 'verification@lsv.ai'
);
