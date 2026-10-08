// LSV API Gateway — point d'entrée Supabase Edge Function (Deno)
// ───────────────────────────────────────────────────────────────────────────
// Déploiement :
//   npx supabase functions deploy lsv-gateway --no-verify-jwt
//   Clé du fournisseur : saisie dans le back-office (/admin → Paramètres),
//   stockée dans la table app_settings. Secret de secours possible :
//   npx supabase secrets set AGNES_API_KEY=...   (JAMAIS dans le dépôt)
// La logique métier est dans core.mjs (testée par tests/gateway.test.mjs).
// @ts-nocheck
import { createHandler } from './core.mjs';

const handle = createHandler({
    env: {
        AGNES_API_KEY: Deno.env.get('AGNES_API_KEY') ?? '',
        AGNES_API_BASE: Deno.env.get('AGNES_API_BASE') ?? '',
        SUPABASE_URL: Deno.env.get('SUPABASE_URL') ?? '',
        SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        SUPABASE_SECRET_KEYS: Deno.env.get('SUPABASE_SECRET_KEYS') ?? '',
        ALLOWED_ORIGINS: Deno.env.get('ALLOWED_ORIGINS') ?? 'https://fbici.github.io,http://localhost:4173,http://127.0.0.1:4173',
        RATE_LIMIT_PER_MIN: Deno.env.get('RATE_LIMIT_PER_MIN') ?? '',
        IMAGE_LIMIT: Deno.env.get('IMAGE_LIMIT') ?? '',
        VIDEO_LIMIT: Deno.env.get('VIDEO_LIMIT') ?? '',
        CHAT_LIMIT: Deno.env.get('CHAT_LIMIT') ?? '',
        MOTION_LIMIT: Deno.env.get('MOTION_LIMIT') ?? '',
        MAX_BODY_BYTES: Deno.env.get('MAX_BODY_BYTES') ?? ''
    }
});

Deno.serve(handle);
