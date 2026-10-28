-- LSV.ai — migration CLÉ MISTRAL (chat IA)
-- ───────────────────────────────────────────────────────────────────────────
-- À exécuter UNE FOIS dans : Supabase Dashboard → SQL Editor → New query → Run
-- Idempotent : relancer ce fichier ne casse rien.
--
-- Ce qu'elle apporte :
--   provider_api_key_mistral → clé du fournisseur Mistral, utilisée UNIQUEMENT
--       quand le modèle choisi dans le chat est un modèle Mistral (le modèle
--       déclaré dans le corps de la requête commence par « mistral- »).
--
-- OBLIGATOIRE avant d'enregistrer la clé depuis /admin : la table
-- app_settings est fermée par la contrainte app_settings_key_check, qui
-- refuse toute clé non listée. Sans cette migration, l'enregistrement échoue
-- avec un refus de contrainte et la passerelle ne voit jamais la clé.
--
-- Ce qu'elle ne change PAS :
--   - Aucune clé Agnes n'est touchée, aucun quota n'est modifié ;
--   - SANS clé Mistral, tout continue de fonctionner : le chat reste sur le
--     modèle intégré et l'option Mistral est simplement grisée côté client
--     (état lu via GET /v1/providers) ;
--   - La clé Mistral n'a AUCUN repli sur la clé partagée : les deux
--     fournisseurs sont distincts.
--
-- Après l'exécution : /admin → « Clé Mistral (chat IA) » → enregistrer.
-- La passerelle relit la table toutes les 30 s.

alter table public.app_settings
    drop constraint if exists app_settings_key_check;

alter table public.app_settings
    add constraint app_settings_key_check check (key in (
        'provider_api_key',
        'provider_api_key_image',
        'provider_api_key_video',
        'provider_api_key_chat',
        'provider_api_key_mistral',
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
