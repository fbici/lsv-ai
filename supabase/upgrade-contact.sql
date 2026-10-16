-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — migration « messages de contact »
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter dans Supabase → SQL Editor → New query → Run.
-- ⚠️ OBLIGATOIRE avant le premier envoi de la Edge Function `lsv-contact`,
--    sinon la fonction échoue silencieusement à l'inscription des messages.
--
-- 1. table `contact_messages`     : journal durable des messages reçus
--                                    (aucun accès anon : RLS activée sans
--                                    policy, lecture/rédaction service_role) ;
-- 2. fonction `submit_contact`    : inscription + double rate limit sur 1 h
--                                    (par IP et par adresse), ATOMIQUE —
--                                    même verrouillage que consume_quota.
--
-- Lecture des messages reçus :
--   select created_at, channel, name, email, subject, status
--   from public.contact_messages order by created_at desc limit 50;
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.contact_messages (
    id         uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    channel    text not null check (channel in ('founder', 'site')),
    name       text not null,
    email      text not null,
    subject    text not null,
    body       text not null,
    ip         text,
    status     text not null default 'received',
    error      text
);

alter table public.contact_messages enable row level security;

revoke all on public.contact_messages from public, anon, authenticated;
grant select, insert, update, delete on public.contact_messages to service_role;

create index if not exists contact_messages_created_idx
    on public.contact_messages (created_at desc);
create index if not exists contact_messages_ip_idx
    on public.contact_messages (ip, created_at desc);
create index if not exists contact_messages_email_idx
    on public.contact_messages (lower(email), created_at desc);

create or replace function public.submit_contact(
    p_name    text,
    p_email   text,
    p_subject text,
    p_body    text,
    p_channel text,
    p_ip      text default '',
    p_status  text default 'received',
    p_error   text default ''
) returns jsonb
    language plpgsql security definer set search_path = public
    as $$
declare
    v_window    constant interval := interval '1 hour';
    v_max_ip    constant integer := 5;   -- messages / IP / heure
    v_max_mail  constant integer := 3;   -- messages / adresse / heure
    v_ip        text := coalesce(nullif(trim(p_ip), ''), 'inconnue');
    v_count     integer;
    v_id        uuid;
begin
    -- Canal inconnu : on refuse proprement (pas d'erreur SQL visible côté client).
    if p_channel is null or p_channel not in ('founder', 'site') then
        return jsonb_build_object('ok', false, 'reason', 'channel');
    end if;

    select count(*) into v_count
      from public.contact_messages
     where created_at > now() - v_window
       and ip = v_ip;
    if v_count >= v_max_ip then
        return jsonb_build_object('ok', false, 'reason', 'rate');
    end if;

    select count(*) into v_count
      from public.contact_messages
     where created_at > now() - v_window
       and lower(email) = lower(p_email);
    if v_count >= v_max_mail then
        return jsonb_build_object('ok', false, 'reason', 'rate');
    end if;

    insert into public.contact_messages (name, email, subject, body, channel, ip, status, error)
    values (
        left(coalesce(p_name, ''), 120),
        left(coalesce(p_email, ''), 200),
        left(coalesce(p_subject, ''), 160),
        left(coalesce(p_body, ''), 4000),
        p_channel,
        v_ip,
        coalesce(nullif(p_status, ''), 'received'),
        left(coalesce(p_error, ''), 300)
    )
    returning id into v_id;

    return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- Invoquable UNIQUEMENT par la Edge Function (clé de service) : un client
-- ne peut ni insérer un faux message, ni sonder la table.
revoke execute on function public.submit_contact(text, text, text, text, text, text, text, text)
    from public, anon, authenticated;
grant  execute on function public.submit_contact(text, text, text, text, text, text, text, text)
    to service_role;

-- Fin de la migration.
