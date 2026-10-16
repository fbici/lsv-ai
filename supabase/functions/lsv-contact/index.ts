// LSV Contact — point d'entrée Supabase Edge Function (Deno)
// ───────────────────────────────────────────────────────────────────────────
// Reçoit les formulaires de contact de LSV.ai (page /contact/) et de la page
// À propos (formulaire personnel de Salaou Souleyman), puis envoie un e-mail.
//
// Déploiement :
//   npx supabase functions deploy lsv-contact
//   Migration obligatoire AVANT le premier envoi :
//   exécuter supabase/upgrade-contact.sql dans l'éditeur SQL Supabase.
//
// Variables requises (JAMAIS dans le dépôt) :
//   npx supabase secrets set EMAIL_PROVIDER=brevo EMAIL_API_KEY=...
//   npx supabase secrets set EMAIL_FROM="LeStudioViral <no-reply@ton-domaine>"
//   EMAIL_PROVIDER : "brevo" ou "resend"
//   CONTACT_AUTO_REPLY=0 pour désactiver l'accusé de réception (défaut 1)
//
// La logique métier est dans core.mjs (testée par tests/contact.test.mjs),
// les modèles d'e-mails dans templates.mjs.
// @ts-nocheck
import { createHandler, createMemoryStore } from './core.mjs';

const handle = createHandler({
    env: {
        SUPABASE_URL: Deno.env.get('SUPABASE_URL') ?? '',
        SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        EMAIL_PROVIDER: Deno.env.get('EMAIL_PROVIDER') ?? '',
        EMAIL_API_KEY: Deno.env.get('EMAIL_API_KEY') ?? '',
        EMAIL_FROM: Deno.env.get('EMAIL_FROM') ?? '',
        CONTACT_AUTO_REPLY: Deno.env.get('CONTACT_AUTO_REPLY') ?? '1',
        CONTACT_RATE_PER_MIN: Deno.env.get('CONTACT_RATE_PER_MIN') ?? '',
        CONTACT_RATE_PER_DAY: Deno.env.get('CONTACT_RATE_PER_DAY') ?? ''
    },
    store: createMemoryStore(),
    allowOrigin: origin => {
        const allowed = (Deno.env.get('ALLOWED_ORIGINS') ||
            'https://fbici.github.io,http://localhost:4173,http://127.0.0.1:4173')
            .split(',').map(s => s.trim()).filter(Boolean);
        if (!origin) return allowed[0] || '*';
        return allowed.includes(origin) ? origin : 'null';
    }
});

Deno.serve(handle);
