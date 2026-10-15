-- ═══════════════════════════════════════════════════════════════════════════
-- LSV.ai — migration CLÉS DU FOURNISSEUR PAR OUTIL
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter UNE FOIS dans le SQL Editor du Dashboard Supabase.
-- Idempotent : relancer ce fichier ne casse rien.
-- À exécuter APRÈS supabase/upgrade-quotas.sql (il réutilise app_settings).
--
-- Apporte 3 clés DÉDIÉES, une par outil :
--   provider_api_key_image   → générations d'images
--   provider_api_key_video   → générations de vidéos (+ leur polling)
--   provider_api_key_chat    → chat IA et amélioration de prompts
--
-- La clé existante provider_api_key devient la CLÉ PARTAGÉE DE SECOURS :
--   • utilisée si la clé de l'outil est vide ;
--   • utilisée pour le module Motion (pas encore de clé dédiée).
-- Rien ne casse si seule l'ancienne clé est renseignée.
--
-- Intérêt : chaque outil a son propre budget et son propre rate limit chez
-- le fournisseur. Un lot d'images n'épuise donc pas la clé vidéo, et la
-- panne d'une clé n'arrête qu'un seul outil.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.app_settings
    drop constraint if exists app_settings_key_check;

alter table public.app_settings
    add constraint app_settings_key_check check (key in (
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
    ));

-- Aucune valeur par défaut : les clés se saisissent dans /admin → Paramètres.
-- La clé partagée déjà en place continue de servir tant qu'une clé d'outil
-- n'a pas été renseignée.

-- Vérification rapide (facultative) :
--   select key, left(value, 4) || repeat('•', 20) as apercu, updated_at
--     from public.app_settings where key like 'provider_api_key%' order by key;
