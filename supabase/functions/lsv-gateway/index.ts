// LSV API Gateway — point d'entrée Supabase Edge Function (Deno)
// ───────────────────────────────────────────────────────────────────────────
// Déploiement :
//   npx supabase functions deploy lsv-gateway --no-verify-jwt
//   npx supabase secrets set AGNES_API_KEY=...   (secret, JAMAIS dans le dépôt)
// La logique métier est dans core.mjs (testée par tests/gateway.test.mjs).
// @ts-nocheck
import { createHandler } from './core.mjs';

const handle = createHandler({
    env: {
        AGNES_API_KEY: Deno.env.get('AGNES_API_KEY') ?? '',
        AGNES_API_BASE: Deno.env.get('AGNES_API_BASE') ?? '',
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
