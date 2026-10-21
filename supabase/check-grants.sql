-- ─────────────────────────────────────────────────────────────────────────────
-- VÉRIFICATIONS Supabase (à coller dans Dashboard → SQL Editor → Run)
-- LECTURE UNIQUEMENT : aucune donnée modifiée, aucun quota consommé.
--
-- Deux sujets distincts dans le même fichier :
--   A. Les fonctions de quota PostgREST sont-elles appelables ?  → si NON,
--      c'est LA cause de « quota-rpc-status 400 » dans les journaux.
--   B. Les tables publiques ont-elles leurs GRANT explicites ?   → à faire
--      pour toute table créée après le 30/10/2025 (voir e-mail Supabase).
-- ─────────────────────────────────────────────────────────────────────────────

-- A. FONCTIONS DE QUOTA -------------------------------------------------------
-- Attendu : une ligne par fonction, service_role_execute = true.
-- * Rien du tout  -> les fonctions n'existent pas dans la base LIVE
--                    (supabase/upgrade-quotas.sql n'a jamais été exécuté).
--                    PostgREST répond alors PGRST202 / 400 : c'est le bug.
-- * false         -> la fonction existe mais l'exécution n'est pas accordée
--                    -> GRANT EXPLICIT MANQUANT.
select p.proname                                      as fonction,
       pg_get_function_identity_arguments(p.oid)      as arguments,
       has_function_privilege('service_role', p.oid, 'execute') as service_role_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('consume_quota', 'refund_quota', 'get_quota',
                    'submit_contact', 'is_admin')
order by p.proname;

-- Signature exacte attendue de consume_quota. Si cette ligne est vide, c'est
-- que l'argument diffère (typage) : PostgREST rejette l'appel en 400.
select to_regprocedure('public.consume_quota(uuid,text,text,integer,integer)')
         is not null as signature_conforme;

-- B. GRANT DES TABLES PUBLIQUES ----------------------------------------------
-- Attendu : les tables lues/écrites par l'app sont à true selon le rôle.
-- Les 'false' attendus et SAINS :
--   * admin_emails  : aucun accès anon/authenticated (révoqué volontairement,
--                     lu uniquement par des fonctions SECURITY DEFINER).
--   * tout ce qui est false pour anon ET authenticated sur des tables protégées
--     par RLS sans policy : l'appelant ne verra jamais de ligne.
select c.relname                                   as table_name,
       has_table_privilege('anon',          c.oid, 'select') as anon_select,
       has_table_privilege('authenticated', c.oid, 'select') as authenticated_select,
       has_table_privilege('authenticated', c.oid, 'insert') as authenticated_insert,
       has_table_privilege('service_role',  c.oid, 'select') as service_role_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;

-- Qui a accès à app_settings (lecture des clés par le back-office) ?
select grantee::text                                    as grantee,
       string_agg(privilege_type::text, ', '
                  order by privilege_type)              as privileges
from information_schema.table_privileges
where table_schema = 'public' and table_name = 'app_settings'
group by grantee
order by grantee;

-- ─────────────────────────────────────────────────────────────────────────────
-- MODÈLE À REPRENDRE DANS TOUTE CRÉATION DE TABLE (règle du 30/10/2025)
-- Les tables existantes gardent leurs droits ; toute table nouvelle doit
-- recevoir ses GRANT dans la MÊME migration qui la crée, sinon supabase-js /
-- PostgREST renvoient « permission denied ».
--
--   -- anon UNIQUEMENT si le public doit réellement lire la table
--   grant select                              on public.ma_table to anon;
--
--   grant select, insert, update, delete      on public.ma_table
--     to authenticated;
--
--   grant select, insert, update, delete      on public.ma_table
--     to service_role;
--
-- RLS reste la protection réelle : un GRANT sans policy ne laisse voir
-- AUCUNE ligne. Pour les tables soustraites au client (admin_emails) : ne rien
-- accorder à anon ni à authenticated, et s'appuyer uniquement sur des
-- fonctions SECURITY DEFINER pour les lire.
-- ─────────────────────────────────────────────────────────────────────────────
