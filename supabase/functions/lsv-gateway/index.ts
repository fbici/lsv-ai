// LSV API Gateway — point d'entrée Supabase Edge Function (Deno)
// ───────────────────────────────────────────────────────────────────────────
// Déploiement :
//   npx supabase functions deploy lsv-gateway --no-verify-jwt
//   Clé du fournisseur : saisie dans le back-office (/admin → Paramètres),
//   stockée dans la table app_settings. Secret de secours possible :
//   npx supabase secrets set AGNES_API_KEY=...   (JAMAIS dans le dépôt)
//   Chat Mistral (modèle mistral-*) : clé dédiée provider_api_key_mistral,
//   secret de secours MISTRAL_API_KEY — jamais la clé Agnes chez Mistral.
// La logique métier est dans core.mjs (testée par tests/gateway.test.mjs).
// @ts-nocheck
import { createHandler } from './core.mjs';

const handle = createHandler({
    env: {
        AGNES_API_KEY: Deno.env.get('AGNES_API_KEY') ?? '',
        AGNES_API_BASE: Deno.env.get('AGNES_API_BASE') ?? '',
        MISTRAL_API_KEY: Deno.env.get('MISTRAL_API_KEY') ?? '',
        MISTRAL_API_BASE: Deno.env.get('MISTRAL_API_BASE') ?? '',
        SUPABASE_URL: Deno.env.get('SUPABASE_URL') ?? '',
        SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        SUPABASE_SECRET_KEYS: Deno.env.get('SUPABASE_SECRET_KEYS') ?? '',
        ALLOWED_ORIGINS: Deno.env.get('ALLOWED_ORIGINS') ?? 'https://fbici.github.io,https://lsv-ai.lestudioviral.workers.dev,http://localhost:4173,http://127.0.0.1:4173',
        RATE_LIMIT_PER_MIN: Deno.env.get('RATE_LIMIT_PER_MIN') ?? '',
        MAX_CONCURRENT_PER_USER: Deno.env.get('MAX_CONCURRENT_PER_USER') ?? '',
        IMAGE_LIMIT: Deno.env.get('IMAGE_LIMIT') ?? '',
        VIDEO_LIMIT: Deno.env.get('VIDEO_LIMIT') ?? '',
        CHAT_LIMIT: Deno.env.get('CHAT_LIMIT') ?? '',
        MOTION_LIMIT: Deno.env.get('MOTION_LIMIT') ?? '',
        QUOTA_GLOBAL_DAILY: Deno.env.get('QUOTA_GLOBAL_DAILY') ?? '',
        MAX_BODY_BYTES: Deno.env.get('MAX_BODY_BYTES') ?? ''
    }
});

Deno.serve(handle);
