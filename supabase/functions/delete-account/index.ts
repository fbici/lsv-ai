// LSV — Suppression de compte (Supabase Edge Function, Deno)
// ───────────────────────────────────────────────────────────────────────────
// Reçoit le jeton de l'utilisateur connecté, puis dans l'ordre :
//   1. inscrit l'e-mail dans public.deleted_emails (refroidissement 30 jours) ;
//   2. purge les lignes dépendantes (analytics, compteurs de quota —
//      le profil part en cascade avec auth.users) ;
//   3. supprime le compte via l'API admin GoTrue (auth.admin.deleteUser).
// Chaque étape est réessayable : l'ordre va du plus censé être répété au plus
// définitif, et la fonction est idempotente si on la relance après un échec.
//
// Déploiement :
//   npx supabase functions deploy delete-account
//   Migration obligatoire AVANT le premier appel :
//   exécuter supabase/upgrade-delete-account.sql dans l'éditeur SQL Supabase.
//
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont injectés automatiquement —
// aucune clé n'est présente dans le dépôt ni côté navigateur.
// @ts-nocheck
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ||
    'https://fbici.github.io,https://lsv-ai.lestudioviral.workers.dev,http://localhost:4173,http://127.0.0.1:4173')
    .split(',').map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
    const allow = (!origin) ? (ALLOWED[0] || '*')
        : (ALLOWED.includes(origin) ? origin : 'null');
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '86400'
    };
}

function json(origin, status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
    });
}

const COOLDOWN_DAYS = 30;

Deno.serve(async req => {
    const origin = req.headers.get('origin') || '';
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (req.method !== 'POST') {
        return json(origin, 405, { error: 'méthode refusée' });
    }
    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!url || !serviceKey) {
        return json(origin, 500, { error: 'service mal configuré' });
    }
    const auth = String(req.headers.get('authorization') || '');
    const jwt = auth.replace(/^Bearer\s+/i, '').trim();
    if (!jwt || jwt === 'null' || jwt === 'undefined') {
        return json(origin, 401, { error: 'connexion requise' });
    }

    const svc = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });

    // Vérifie le jeton auprès de GoTrue : seul le propriétaire du compte parle.
    let user = null;
    try {
        const r = await svc.auth.getUser(jwt);
        user = (r && r.data && r.data.user) || null;
    } catch (e) { user = null; }
    if (!user || !user.email) {
        return json(origin, 401, { error: 'connexion invalide' });
    }

    const email = String(user.email).trim().toLowerCase();
    const uid = user.id;

    // 1. Refroidissement : l'e-mail est conservé 30 jours (réessayable).
    const cooled = await svc
        .from('deleted_emails')
        .upsert({ email: email, deleted_at: new Date().toISOString() }, { onConflict: 'email' });
    if (cooled.error) {
        return json(origin, 500, { error: 'suppression impossible pour le moment' });
    }

    // 2. Données dépendantes : événements et compteurs (réessayable).
    //    public.profiles part en cascade (clé étrangère → auth.users).
    await svc.from('analytics_events').delete().eq('user_id', uid);
    await svc.from('usage_counters').delete().eq('user_id', uid);

    // 3. Le compte lui-même : étape définitive, en dernier.
    const gone = await svc.auth.admin.deleteUser(uid);
    if (gone.error) {
        return json(origin, 500, { error: 'suppression impossible pour le moment' });
    }

    return json(origin, 200, { ok: true, cooldown_days: COOLDOWN_DAYS });
});
