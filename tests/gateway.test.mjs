/* ═══════════════════════════════════════════════════════════════════════════
   Tests de la LSV API Gateway
   ───────────────────────────────────────────────────────────────────────────
   Couvre : routage (y compris préfixe Supabase), injection de la clé serveur,
   rejet de l'authorization client, CORS, rate limit, quotas journaliers,
   sanitisation des erreurs amont, clé absente.
   Usage : node tests/gateway.test.mjs
   ═══════════════════════════════════════════════════════════════════════════ */
import { createHandler, createMemoryStore, classifyRequest, subPath, imageUnits, requestUnits, tokenRole, resolveMediaRef, resolveVideoRefs, newRequestId } from '../supabase/functions/lsv-gateway/core.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond });
    console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
}

const UP = 'https://apihub.agnes-ai.com';
const GW = 'https://ref.supabase.co/functions/v1/lsv-gateway';
const SECRET = 'agnes-secret-key-XYZ';

function makeReq(url, init) { return new Request(url, init); }

async function run() {
    console.log('\n=== 1. ROUTAGE ET INJECTION DE CLÉ ===');
    const calls = [];
    let t = 1700000000000;
    const store = createMemoryStore();
    const env = {
        AGNES_API_KEY: SECRET,
        ALLOWED_ORIGINS: 'https://fbici.github.io',
        RATE_LIMIT_PER_MIN: '50',
        IMAGE_LIMIT: '0',
        VIDEO_LIMIT: '0',
        CHAT_LIMIT: '0',
        MOTION_LIMIT: '0'
    };
    const handle = createHandler({
        env,
        store,
        now: () => t,
        log: () => {},
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/i.png' }] }), {
                status: 200, headers: { 'content-type': 'application/json' }
            });
        }
    });

    const r1 = await handle(makeReq(GW + '/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-client-trente-neuf' },
        body: JSON.stringify({ prompt: 'un chat', model: 'agnes-image-2.1-flash' })
    }));
    check('requête image relayée', r1.status === 200, r1.status);
    check('URL amont exacte', calls[0] && calls[0].url === UP + '/v1/images/generations', calls[0] && calls[0].url);
    check('clé SE injectée côté serveur', calls[0] && calls[0].init.headers['Authorization'] === 'Bearer ' + SECRET, calls[0] && calls[0].init.headers['Authorization']);
    check('authorization CLIENT jamais transmise', calls[0] && !JSON.stringify(calls[0].init.headers).includes('sk-client'), JSON.stringify(calls[0] && calls[0].init.headers));
    check('corps préservé (modèle inclus)', calls[0] && calls[0].init.body.includes('agnes-image-2.1-flash'));

    const rPoll = await handle(makeReq(GW + '/agnesapi?video_id=abc&model_name=agnes-video-2.5-flash', { method: 'GET' }));
    check('polling relayé', rPoll.status === 200 && calls[1].url === UP + '/agnesapi?video_id=abc&model_name=agnes-video-2.5-flash', calls[1] && calls[1].url);

    console.log('\n=== 2. PRÉFIXE SUPABASE / CHEMINS ===');
    check('subPath déployé', subPath('/functions/v1/lsv-gateway/v1/videos') === '/v1/videos');
    check('subPath local', subPath('/v1/videos') === '/v1/videos');
    check('classify image', classifyRequest('/v1/images/generations', 'POST') === 'image');
    check('classify vidéo (création)', classifyRequest('/v1/videos', 'POST') === 'video');
    check('classify polling non compté', classifyRequest('/agnesapi?video_id=1', 'GET') === null);
    check('classify chat', classifyRequest('/v1/chat/completions', 'POST') === 'chat');
    const r404 = await handle(makeReq(GW + '/admin/secrets', { method: 'GET' }));
    const b404 = await r404.json();
    check('route inconnue = 404 générique', r404.status === 404 && b404.error.message === 'Ressource indisponible.', r404.status);

    console.log('\n=== 3. CORS ===');
    const rOpt = await handle(makeReq(GW + '/v1/images/generations', { method: 'OPTIONS', headers: { origin: 'https://fbici.github.io' } }));
    check('preflight 204', rOpt.status === 204, rOpt.status);
    check('preflight CORS accepté', rOpt.headers.get('access-control-allow-origin') === 'https://fbici.github.io');
    const rBad = await handle(makeReq(GW + '/v1/images/generations', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }));
    check('origine non autorisée = 403', rBad.status === 403, rBad.status);
    const rOrigin = await handle(makeReq(GW + '/v1/images/generations', { method: 'POST', headers: { origin: 'https://fbici.github.io', 'content-type': 'application/json' }, body: '{}' }));
    check('origine autorisée relayée', rOrigin.headers.get('access-control-allow-origin') === 'https://fbici.github.io');

    console.log('\n=== 4. RATE LIMIT (fenêtre 60s) ===');
    const envRate = Object.assign({}, env, { RATE_LIMIT_PER_MIN: '3' });
    const storeRate = createMemoryStore();
    let tRate = 1700000000000;
    const handleRate = createHandler({
        env: envRate, store: storeRate, now: () => tRate, log: () => {},
        fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    });
    const mk = h => makeReq(GW + '/v1/images/generations', { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9', 'content-type': 'application/json' }, body: '{}' });
    const s1 = (await handleRate(mk())).status;
    const s2 = (await handleRate(mk())).status;
    const s3 = (await handleRate(mk())).status;
    const r4 = await handleRate(mk());
    const b4 = await r4.json();
    check('3 requêtes autorisées', s1 === 200 && s2 === 200 && s3 === 200, [s1, s2, s3].join(','));
    check('4e bloquée = 429', r4.status === 429, r4.status);
    check('Retry-After présent', !!r4.headers.get('retry-after'), r4.headers.get('retry-after'));
    check('message 429 générique FR', /limite temporaire/.test(b4.error.message), b4.error.message);
    tRate += 61000;
    check('fenêtre libérée après 60s', (await handleRate(mk())).status === 200);

    console.log('\n=== 5. QUOTAS JOURNALIERS ===');
    const envQ = Object.assign({}, env, { RATE_LIMIT_PER_MIN: '100', IMAGE_LIMIT: '2' });
    const storeQ = createMemoryStore();
    let tQ = 1700000000000;
    const handleQ = createHandler({
        env: envQ, store: storeQ, now: () => tQ, log: () => {},
        fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    });
    const mq = () => makeReq(GW + '/v1/images/generations', { method: 'POST', headers: { 'x-forwarded-for': '8.8.8.8', 'content-type': 'application/json' }, body: '{}' });
    const q1 = (await handleQ(mq())).status;
    const q2 = (await handleQ(mq())).status;
    const rQ3 = await handleQ(mq());
    const bQ3 = await rQ3.json();
    check('quota 2 images acceptées', q1 === 200 && q2 === 200, [q1, q2].join(','));
    check('3e image bloquée = 429', rQ3.status === 429, rQ3.status);
    check('message quota générique', /Quota du jour|limite temporaire/.test(bQ3.error.message), bQ3.error.message);
    tQ += 24 * 3600 * 1000;
    check('quota réinitialisé le lendemain', (await handleQ(mq())).status === 200);

    console.log('\n=== 6. SANITISATION DES ERREURS AMONT ===');
    const handleErr = createHandler({
        env, store: createMemoryStore(), now: () => t, log: () => {},
        fetchImpl: async () => new Response(
            JSON.stringify({ error: { message: 'Invalid API key sk-ABCDEF sur apihub.agnes-ai.com' } }),
            { status: 401, headers: { 'content-type': 'application/json' } })
    });
    const rErr = await handleErr(makeReq(GW + '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const bErr = await rErr.json();
    const rawErr = JSON.stringify(await handleErr(makeReq(GW + '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).then(r => r.json()));
    check('401 amont → 502 masqué', rErr.status === 502, rErr.status);
    check('aucun détail amont dans la réponse', !/apihub|sk-|agnes|Bearer/.test(rawErr), rawErr);
    check('message utilisateur générique', /Impossible de g/.test(bErr.error.message), bErr.error.message);

    const handle429 = createHandler({
        env, store: createMemoryStore(), now: () => t, log: () => {},
        fetchImpl: async () => new Response('{"error":"rate limited by provider"}', { status: 429, headers: { 'content-type': 'application/json' } })
    });
    const rUp429 = await handle429(makeReq(GW + '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const bUp429 = await rUp429.json();
    check('429 amont transmis (retry client)', rUp429.status === 429, rUp429.status);
    check('429 amont sans détail', !/provider/.test(JSON.stringify(bUp429)));

    const handleNet = createHandler({
        env, store: createMemoryStore(), now: () => t, log: () => {},
        fetchImpl: async () => { throw new Error('ENOTFOUND apihub.agnes-ai.com'); }
    });
    const rNet = await handleNet(makeReq(GW + '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const bNet = await rNet.json();
    check('panne réseau amont = 502 générique', rNet.status === 502 && !/ENOTFOUND|apihub/.test(JSON.stringify(bNet)), JSON.stringify(bNet));

    console.log('\n=== 7. CLÉ ABSENTE / CONFIGURATION ===');
    const handleNoKey = createHandler({
        env: { AGNES_API_KEY: '' }, store: createMemoryStore(), now: () => t, log: () => {},
        fetchImpl: async () => new Response('{}', { status: 200 })
    });
    const rNoKey = await handleNoKey(makeReq(GW + '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const bNoKey = await rNoKey.json();
    check('sans clé serveur → 503 (pas de requête amont)', rNoKey.status === 503 && /indisponible/.test(bNoKey.error.message), rNoKey.status);

    console.log('\n=== 8. SÉCURITÉ : AUCUN SECRET DANS LES RÉPONSES ===');
    const all = [JSON.stringify(await r1.json()), JSON.stringify(b404), JSON.stringify(b4), JSON.stringify(bQ3), JSON.stringify(bErr), JSON.stringify(bNet)];
    const joined = all.join(' ');
    check('aucune clé Agnes dans les réponses', !joined.includes(SECRET) && !/Bearer\s+[A-Za-z0-9]/.test(joined));
    check('aucun endpoint amont dans les réponses', !/apihub|agnes-ai\.com/.test(joined));
    check('aucun token sk- dans les réponses', !/sk-/.test(joined));

    console.log('\n=== 9. CLÉ SAISIE DANS LE BACK-OFFICE (table app_settings) ===');
    const SUPA = 'https://umhsxebemspyyqrecsuq.supabase.co';
    const SVC = 'secret-service-key-123456';
    const DB_KEY = 'cle-de-la-base-XYZ';
    const dbEnv = extra => Object.assign({}, env, {
        AGNES_API_KEY: '',
        SUPABASE_URL: SUPA,
        SUPABASE_SERVICE_ROLE_KEY: SVC
    }, extra || {});

    let tDb = 1700000000000;
    const settingsCalls = [];
    const upCalls = [];
    const mkDb = () => makeReq(GW + '/v1/images/generations', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    const handleDb = createHandler({
        env: dbEnv(), store: createMemoryStore(), now: () => tDb, log: () => {},
        fetchImpl: async (url, init) => {
            const u = String(url);
            if (u.indexOf('/rest/v1/app_settings') !== -1) {
                settingsCalls.push({ url: u, init: init });
                return new Response(JSON.stringify([{ key: 'provider_api_key', value: DB_KEY }]), {
                    status: 200, headers: { 'content-type': 'application/json' }
                });
            }
            upCalls.push({ url: u, init: init });
            return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });

    const d1 = await handleDb(mkDb());
    const d2 = await handleDb(mkDb());
    check('requête relayée avec la clé de la base', d1.status === 200 && upCalls.length === 2 &&
        upCalls[0].init.headers['Authorization'] === 'Bearer ' + DB_KEY, upCalls[0] && upCalls[0].init.headers['Authorization']);
    check('lecture de la table en une seule fois (cache)', settingsCalls.length === 1, settingsCalls.length);
    check('lecture filtrée sur la clé du fournisseur', /select=key,value&key=in\.\(provider_api_key/.test(settingsCalls[0].url), settingsCalls[0].url);
    check('lecture avec la clé de service du projet', settingsCalls[0].init.headers.apikey === SVC, settingsCalls[0].init.headers.apikey);
    const d1Body = JSON.stringify(await d1.json());
    check('clé de service jamais renvoyée au client', d1Body.indexOf(SVC) === -1);
    check('clé de la base jamais renvoyée au client', d1Body.indexOf(DB_KEY) === -1);
    tDb += 61000;
    await handleDb(mkDb());
    check('cache expiré → nouvelle lecture', settingsCalls.length === 2, settingsCalls.length);

    const dictCalls = [];
    const handleDict = createHandler({
        env: Object.assign({}, env, {
            AGNES_API_KEY: '',
            SUPABASE_URL: SUPA,
            SUPABASE_SECRET_KEYS: JSON.stringify({ service_role: SVC })
        }),
        store: createMemoryStore(), now: () => tDb, log: () => {},
        fetchImpl: async (url, init) => {
            const u = String(url);
            if (u.indexOf('/rest/v1/app_settings') !== -1) {
                dictCalls.push(init);
                return new Response(JSON.stringify([{ key: 'provider_api_key', value: DB_KEY }]), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });
    const dictRes = await handleDict(mkDb());
    check('clé de service lue dans SUPABASE_SECRET_KEYS', dictRes.status === 200 &&
        dictCalls.length === 1 && dictCalls[0].headers.apikey === SVC, dictCalls.length);

    console.log('\n=== 10. SECOURS : SECRET SERVEUR + PANNES ===');
    let tSec = 1700000000000;
    const secSettings = [];
    const secUps = [];
    const mkSec = () => makeReq(GW + '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    const handleEnv = createHandler({
        env: dbEnv({ AGNES_API_KEY: 'cle-du-secret-CLI' }),
        store: createMemoryStore(), now: () => tSec, log: () => {},
        fetchImpl: async (url, init) => {
            const u = String(url);
            if (u.indexOf('/rest/v1/app_settings') !== -1) {
                secSettings.push(u);
                return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
            }
            secUps.push(init);
            return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });
    const sec1 = await handleEnv(mkSec());
    check('base vide → secret serveur utilisé', sec1.status === 200 &&
        secUps[0].headers['Authorization'] === 'Bearer cle-du-secret-CLI', secUps[0] && secUps[0].headers['Authorization']);
    await handleEnv(mkSec());
    check('base relue en une seule fois (cache)', secSettings.length === 1, secSettings.length);

    const failSettings = [];
    const handleFail = createHandler({
        env: dbEnv({ AGNES_API_KEY: 'cle-de-secours' }),
        store: createMemoryStore(), now: () => tSec, log: () => {},
        fetchImpl: async url => {
            if (String(url).indexOf('/rest/v1/app_settings') !== -1) { failSettings.push(1); throw new Error('ENOTFOUND supabase.co'); }
            return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });
    const f1 = await handleFail(mkSec());
    await handleFail(mkSec());
    check('lecture impossible → secours sans blocage', f1.status === 200, f1.status);
    check('échec mis en cache aussi (1 tentative)', failSettings.length === 1, failSettings.length);

    const handleNone = createHandler({
        env: dbEnv(), store: createMemoryStore(), now: () => tSec, log: () => {},
        fetchImpl: async url => {
            if (String(url).indexOf('/rest/v1/app_settings') !== -1) {
                return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
            }
            throw new Error('ne devrait pas être appelé');
        }
    });
    const n1 = await handleNone(mkSec());
    const bNone = await n1.json();
    check('ni clé en base ni secret → 503', n1.status === 503 && /indisponible/.test(bNone.error.message), n1.status);

    /* ═══ QUOTAS PAR COMPTE ═══════════════════════════════════════════════
       La passerelle vérifie le jeton Supabase du compte puis appelle les
       fonctions SQL atomiques (simulateur ci-dessous). */
    const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwtFor = (id, email) => 'hdr.' + b64url({ sub: id, role: 'authenticated', email }) + '.sig';

    console.log('\n=== 11. POIDS PAR RÉSOLUTION (images) ===');
    check('1K 1312x736 = 1 unité', imageUnits('1312x736') === 1, imageUnits('1312x736'));
    check('1K 1024x1024 = 1 unité', imageUnits('1024x1024') === 1, imageUnits('1024x1024'));
    check('2K 2624x1472 = 2 unités', imageUnits('2624x1472') === 2, imageUnits('2624x1472'));
    check('2K 2048x2048 = 2 unités', imageUnits('2048x2048') === 2, imageUnits('2048x2048'));
    check('3K 3936x2208 = 3 unités', imageUnits('3936x2208') === 3, imageUnits('3936x2208'));
    check('3K 3072x3072 = 3 unités', imageUnits('3072x3072') === 3, imageUnits('3072x3072'));
    check('taille absente = 1 unité (restrictif)', imageUnits('') === 1 && imageUnits(null) === 1);
    check('taille illisible = 1 unité', imageUnits('gros') === 1 && imageUnits('1x1') === 1);
    check('requestUnits image lit le corps', requestUnits('image', '{"size":"2624x1472"}') === 2);
    check('requestUnits vidéo = 1', requestUnits('video', '{}') === 1);
    check('jeton anon ignoré (role != authenticated)',
        tokenRole('h.' + b64url({ role: 'anon' }) + '.s') !== 'authenticated' &&
        tokenRole('h.' + b64url({ role: 'authenticated' }) + '.s') === 'authenticated');

    /* Simulateur de la base : app_settings + consume/refund/get_quota. */
    function makeDb(settings) {
        const db = { settings: Object.assign({}, settings), counters: {} };
        const dayOf = now => new Date(now).toISOString().slice(0, 10);
        db.consume = (userId, email, kind, units, globalLimit, now) => {
            const day = dayOf(now);
            const k = userId + ':' + day + ':' + kind;
            const gk = '00000000-0000-0000-0000-000000000000:' + day + ':global';
            const limit = parseInt(db.settings['quota_' + kind + '_daily'] || '0', 10);
            if (globalLimit > 0) {
                const g = db.counters[gk] || 0;
                if (g + units > globalLimit) {
                    return { ok: false, scope: 'global', used: g, limit: globalLimit, remaining: Math.max(0, globalLimit - g), units };
                }
            }
            if (limit > 0) {
                const u = db.counters[k] || 0;
                if (u + units > limit) {
                    return { ok: false, scope: 'user', used: u, limit, remaining: Math.max(0, limit - u), units };
                }
            }
            if (globalLimit > 0) db.counters[gk] = (db.counters[gk] || 0) + units;
            db.counters[k] = (db.counters[k] || 0) + units;
            return { ok: true, scope: 'user', used: db.counters[k], limit, units,
                remaining: limit > 0 ? Math.max(0, limit - db.counters[k]) : null };
        };
        db.refund = (userId, kind, units, now) => {
            const day = dayOf(now);
            const k = userId + ':' + day + ':' + kind;
            const gk = '00000000-0000-0000-0000-000000000000:' + day + ':global';
            db.counters[k] = Math.max(0, (db.counters[k] || 0) - units);
            db.counters[gk] = Math.max(0, (db.counters[gk] || 0) - units);
        };
        db.used = (userId, kind, now) => db.counters[userId + ':' + dayOf(now) + ':' + kind] || 0;
        return db;
    }

    function quotaHarness(db, user, upstreamStatus = 200) {
        const up = [];
        let tt = 1700000000000;
        const handle = createHandler({
            env: {
                AGNES_API_KEY: SECRET,
                SUPABASE_URL: 'https://ref.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'svc-key-0123456789',
                ALLOWED_ORIGINS: 'https://fbici.github.io',
                RATE_LIMIT_PER_MIN: '1000',
                IMAGE_LIMIT: '0', VIDEO_LIMIT: '0', CHAT_LIMIT: '0', MOTION_LIMIT: '0'
            },
            store: createMemoryStore(),
            now: () => tt,
            log: () => {},
            fetchImpl: async (url, init) => {
                const u = String(url);
                if (u.includes('/rest/v1/app_settings')) {
                    return new Response(JSON.stringify(Object.keys(db.settings).map(k => ({ key: k, value: db.settings[k] }))),
                        { status: 200, headers: { 'content-type': 'application/json' } });
                }
                if (u.includes('/auth/v1/user')) {
                    const auth = (init && init.headers && init.headers.Authorization) || '';
                    if (user && auth === 'Bearer ' + user.jwt) {
                        return new Response(JSON.stringify({ id: user.id, email: user.email }),
                            { status: 200, headers: { 'content-type': 'application/json' } });
                    }
                    return new Response('{"msg":"invalid token"}', { status: 401, headers: { 'content-type': 'application/json' } });
                }
                if (u.includes('/rest/v1/rpc/consume_quota')) {
                    const b = JSON.parse(init.body);
                    return new Response(JSON.stringify(db.consume(b.p_user, b.p_email, b.p_kind, b.p_units, b.p_global, tt)),
                        { status: 200, headers: { 'content-type': 'application/json' } });
                }
                if (u.includes('/rest/v1/rpc/refund_quota')) {
                    const b = JSON.parse(init.body);
                    db.refund(b.p_user, b.p_kind, b.p_units, tt);
                    return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
                }
                if (u.includes('/rest/v1/rpc/get_quota')) {
                    return new Response(JSON.stringify({ enabled: true, suspended: false, limits: {}, used: {}, remaining: {} }),
                        { status: 200, headers: { 'content-type': 'application/json' } });
                }
                /* Amont */
                up.push(u);
                return new Response('{}', { status: upstreamStatus, headers: { 'content-type': 'application/json' } });
            }
        });
        return { handle, up, advance: ms => { tt += ms; }, day: () => new Date(tt).toISOString().slice(0, 10) };
    }

    const ADA = { id: '11111111-1111-4111-8111-111111111111', email: 'ada@lsv.ai', jwt: jwtFor('11111111-1111-4111-8111-111111111111', 'ada@lsv.ai') };
    const POST_IMG = (jwt, size) => makeReq(GW + '/v1/images/generations', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + jwt, 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' },
        body: JSON.stringify({ size: size })
    });

    console.log('\n=== 12. QUOTA PAR COMPTE : 4 unités d\'images ===');
    const db12 = makeDb({ quota_image_daily: '4', quota_video_daily: '8', quota_chat_daily: '30', quota_global_daily: '0' });
    const h12 = quotaHarness(db12, ADA);
    const a1 = await h12.handle(POST_IMG(ADA.jwt, '1312x736'));   // 1K = 1
    const a2 = await h12.handle(POST_IMG(ADA.jwt, '2624x1472'));  // 2K = 2
    const a3 = await h12.handle(POST_IMG(ADA.jwt, '1312x736'));   // 1K = 1 → total 4
    check('1K acceptée', a1.status === 200, a1.status);
    check('2K acceptée (2 unités)', a2.status === 200, a2.status);
    check('3e acceptée → total 4 unités', a3.status === 200, a3.status);
    check('consommation = 4 unités', db12.counters[ADA.id + ':' + h12.day() + ':image'] === 4,
        JSON.stringify(db12.counters));
    const a4 = await h12.handle(POST_IMG(ADA.jwt, '1312x736'));
    const bA4 = await a4.json();
    check('5e image bloquée = 429', a4.status === 429, a4.status);
    check('en-tête x-lsv-quota = exhausted', a4.headers.get('x-lsv-quota') === 'exhausted', a4.headers.get('x-lsv-quota'));
    check('portée = user', a4.headers.get('x-lsv-quota-scope') === 'user', a4.headers.get('x-lsv-quota-scope'));
    check('message quota du jour', /Quota du jour/.test(bA4.error.message), bA4.error.message);
    check('aucun appel amont après quota', h12.up.length === 3, h12.up.length);
    h12.advance(24 * 3600 * 1000);
    const a5 = await h12.handle(POST_IMG(ADA.jwt, '1312x736'));
    check('minuit UTC : quota réinitialisé', a5.status === 200, a5.status);

    console.log('\n=== 13. PLAFOND PAR RÉSOLUTION (quota = 4) ===');
    const db13 = makeDb({ quota_image_daily: '4' });
    const h13 = quotaHarness(db13, ADA);
    const k1 = await h13.handle(POST_IMG(ADA.jwt, '3936x2208'));  // 3K = 3
    const k2 = await h13.handle(POST_IMG(ADA.jwt, '3936x2208'));  // +3 = 6 > 4
    check('3K acceptée (3 unités)', k1.status === 200, k1.status);
    check('2e 3K refusée (6 > 4)', k2.status === 429, k2.status);
    const k3 = await h13.handle(POST_IMG(ADA.jwt, '1312x736'));   // reste 1
    check('1K acceptée dans le reliquat (3+1=4)', k3.status === 200, k3.status);
    const k4 = await h13.handle(POST_IMG(ADA.jwt, '1312x736'));
    check('puis bloquée', k4.status === 429, k4.status);

    console.log('\n=== 14. REMBOURSEMENT SI GÉNÉRATION ÉCHOUÉE ===');
    const db14 = makeDb({ quota_image_daily: '1' });
    const h14 = quotaHarness(db14, ADA, 500);   // amont en erreur
    const fai1 = await h14.handle(POST_IMG(ADA.jwt, '1312x736'));
    check('échec amont → 502 masqué', fai1.status === 502, fai1.status);
    check('unité remboursée (compteur = 0)',
        db14.counters[ADA.id + ':' + h14.day() + ':image'] === 0,
        db14.counters[ADA.id + ':' + h14.day() + ':image']);
    const h14ok = quotaHarness(db14, ADA, 200);
    const fai2 = await h14ok.handle(POST_IMG(ADA.jwt, '1312x736'));
    check('nouvelle tentative acceptée après remboursement', fai2.status === 200, fai2.status);

    console.log('\n=== 15. LIMITE GLOBALE JOURNALIÈRE ===');
    const db15 = makeDb({ quota_image_daily: '100', quota_global_daily: '3' });
    const h15 = quotaHarness(db15, ADA);
    const g1 = await h15.handle(POST_IMG(ADA.jwt, '2624x1472'));  // 2 unités
    const g2 = await h15.handle(POST_IMG(ADA.jwt, '2624x1472'));  // +2 = 4 > 3
    check('2K acceptée dans la limite globale', g1.status === 200, g1.status);
    check('2e 2K refusée par la limite globale', g2.status === 429, g2.status);
    check('portée = global', g2.headers.get('x-lsv-quota-scope') === 'global', g2.headers.get('x-lsv-quota-scope'));
    const g3 = await h15.handle(POST_IMG(ADA.jwt, '1312x736'));   // reste 1 globale
    check('1K acceptée dans le reliquat global', g3.status === 200, g3.status);

    console.log('\n=== 16. SUSPENSION D\'URGENCE ===');
    const db16 = makeDb({ quota_image_daily: '20', quota_suspended: '1' });
    const h16 = quotaHarness(db16, ADA);
    const sus1 = await h16.handle(POST_IMG(ADA.jwt, '1312x736'));
    const bS1 = await sus1.json();
    check('générations suspendues → 503', sus1.status === 503, sus1.status);
    check('en-tête x-lsv-quota = suspended', sus1.headers.get('x-lsv-quota') === 'suspended', sus1.headers.get('x-lsv-quota'));
    check('message suspension', /suspendu/i.test(bS1.error.message), bS1.error.message);
    check('aucun appel amont pendant la suspension', h16.up.length === 0, h16.up.length);
    check('compteur non consommé',
        !db16.counters[ADA.id + ':' + h16.day() + ':image'], JSON.stringify(db16.counters));

    console.log('\n=== 17. QUOTAS VIDÉO ET CHAT PAR COMPTE ===');
    const db17 = makeDb({ quota_image_daily: '20', quota_video_daily: '2', quota_chat_daily: '3' });
    const h17 = quotaHarness(db17, ADA);
    const mv = () => makeReq(GW + '/v1/videos', { method: 'POST', headers: { 'authorization': 'Bearer ' + ADA.jwt, 'content-type': 'application/json' }, body: '{}' });
    const mc = () => makeReq(GW + '/v1/chat/completions', { method: 'POST', headers: { 'authorization': 'Bearer ' + ADA.jwt, 'content-type': 'application/json' }, body: '{}' });
    check('vidéo 1 acceptée', (await h17.handle(mv())).status === 200);
    check('vidéo 2 acceptée', (await h17.handle(mv())).status === 200);
    check('vidéo 3 refusée (quota 2)', (await h17.handle(mv())).status === 429);
    check('chat 1 accepté', (await h17.handle(mc())).status === 200);
    check('chat 2 accepté', (await h17.handle(mc())).status === 200);
    check('chat 3 accepté', (await h17.handle(mc())).status === 200);
    check('chat 4 refusé (quota 3)', (await h17.handle(mc())).status === 429);
    check('le polling vidéo n\'est PAS compté',
        (await h17.handle(makeReq(GW + '/agnesapi?video_id=1', { headers: { 'authorization': 'Bearer ' + ADA.jwt } }))).status === 200);

    console.log('\n=== 18. ÉTAT DES QUOTAS (/v1/quota) ===');
    const db18 = makeDb({ quota_image_daily: '20', quota_video_daily: '8', quota_chat_daily: '30' });
    const h18 = quotaHarness(db18, ADA);
    await h18.handle(POST_IMG(ADA.jwt, '2624x1472'));   // 2 unités
    const qs = await h18.handle(makeReq(GW + '/v1/quota', { headers: { 'authorization': 'Bearer ' + ADA.jwt } }));
    check('endpoint /v1/quota répond 200', qs.status === 200, qs.status);
    const qBody = await qs.json();
    check('état renvoyé au compte', qBody && qBody.enabled === true, JSON.stringify(qBody).slice(0, 120));
    const qa = await h18.handle(makeReq(GW + '/v1/quota'));
    const qaBody = await qa.json();
    check('visiteur anonyme : état minimal sans erreur', qa.status === 200 && qaBody.anonymous === true, JSON.stringify(qaBody).slice(0, 80));

    console.log('\n=== 19. JETON DE COMPTE VÉRIFIÉ CÔTÉ SERVEUR ===');
    const db19 = makeDb({ quota_image_daily: '1' });
    const h19 = quotaHarness(db19, ADA);
    const forged = jwtFor(ADA.id, 'intrus@lsv.ai');   // payload plausible, signature non vérifiée ici
    const hForged = quotaHarness(db19, { id: ADA.id, email: 'intrus@lsv.ai', jwt: 'mauvais-jeton' });
    const x1 = await hForged.handle(POST_IMG(forged, '1312x736'));
    check('jeton non reconnu → traité en anonyme (pas de quota par compte)', x1.status === 200, x1.status);
    const y1 = await h19.handle(POST_IMG(ADA.jwt, '1312x736'));
    const y2 = await h19.handle(POST_IMG(ADA.jwt, '1312x736'));
    check('compte réel : 1 image puis quota', y1.status === 200 && y2.status === 429, y1.status + '/' + y2.status);

    console.log('\n=== 20. CONCATENATION / CONCURRENCE (store mémoire) ===');
    const st = createMemoryStore();
    check('3 requêtes simultanées admises (max 3)', st.enter('u1', 3) && st.enter('u1', 3) && st.enter('u1', 3));
    check('4e simultanée refusée', st.enter('u1', 3) === false);
    st.leave('u1');
    check('libération → à nouveau admis', st.enter('u1', 3) === true);

    console.log('\n=== 21. CLÉ DU FOURNISSEUR PAR OUTIL ===');
    /* Une clé dédiée par outil : un lot d'images n'utilise pas la clé vidéo.
       Repli sur la clé partagée, puis sur le secret serveur. */
    const KEYS = { image: 'CLE-IMAGES-111', video: 'CLE-VIDEOS-222', chat: 'CLE-CHAT-333', shared: 'CLE-PARTAGEE-444' };
    function keyHarness(settings) {
        const seen = [];
        const handle = createHandler({
            env: {
                AGNES_API_KEY: 'secret-CLI',
                SUPABASE_URL: 'https://ref.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'svc-key-0123456789',
                ALLOWED_ORIGINS: 'https://fbici.github.io',
                RATE_LIMIT_PER_MIN: '1000',
                IMAGE_LIMIT: '0', VIDEO_LIMIT: '0', CHAT_LIMIT: '0', MOTION_LIMIT: '0'
            },
            store: createMemoryStore(), now: () => 1700000000000, log: () => {},
            fetchImpl: async (url, init) => {
                const u = String(url);
                if (u.includes('/rest/v1/app_settings')) {
                    return new Response(JSON.stringify(Object.keys(settings).map(k => ({ key: k, value: settings[k] }))),
                        { status: 200, headers: { 'content-type': 'application/json' } });
                }
                seen.push({ url: u, auth: (init.headers && init.headers.Authorization) || '' });
                return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
            }
        });
        return { handle, seen };
    }
    const mkTool = (path, method) => makeReq(GW + path, {
        method: method || 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '5.5.5.5' },
        body: method === 'GET' ? undefined : '{}'
    });

    const kh1 = keyHarness({
        provider_api_key_image: KEYS.image, provider_api_key_video: KEYS.video,
        provider_api_key_chat: KEYS.chat, provider_api_key: KEYS.shared
    });
    await kh1.handle(mkTool('/v1/images/generations'));
    await kh1.handle(mkTool('/v1/videos'));
    await kh1.handle(mkTool('/v1/chat/completions'));
    check('images → clé dédiée images', kh1.seen[0].auth === 'Bearer ' + KEYS.image, kh1.seen[0].auth);
    check('vidéos → clé dédiée vidéos', kh1.seen[1].auth === 'Bearer ' + KEYS.video, kh1.seen[1].auth);
    check('chat → clé dédiée chat', kh1.seen[2].auth === 'Bearer ' + KEYS.chat, kh1.seen[2].auth);

    const kh2 = keyHarness({
        provider_api_key_image: KEYS.image, provider_api_key: KEYS.shared
    });
    await kh2.handle(mkTool('/v1/images/generations'));
    await kh2.handle(mkTool('/v1/videos'));
    await kh2.handle(mkTool('/v1/chat/completions'));
    check('clé vidéo absente → repli sur la clé partagée', kh2.seen[1].auth === 'Bearer ' + KEYS.shared, kh2.seen[1].auth);
    check('clé chat absente → repli sur la clé partagée', kh2.seen[2].auth === 'Bearer ' + KEYS.shared, kh2.seen[2].auth);
    check('clé images toujours dédiée', kh2.seen[0].auth === 'Bearer ' + KEYS.image, kh2.seen[0].auth);

    const kh3 = keyHarness({ provider_api_key_image: KEYS.image });
    await kh3.handle(mkTool('/v1/images/generations'));
    await kh3.handle(mkTool('/agnesapi?video_id=1', 'GET'));
    check('seule la clé images renseignée → images dédiée', kh3.seen[0].auth === 'Bearer ' + KEYS.image, kh3.seen[0].auth);
    check('aucune clé vidéo ni partagée → secret serveur', kh3.seen[1].auth === 'Bearer secret-CLI', kh3.seen[1].auth);

    const kh4 = keyHarness({
        provider_api_key_image: KEYS.image, provider_api_key_video: KEYS.video, provider_api_key: KEYS.shared
    });
    await kh4.handle(makeReq(GW + '/agnesapi?video_id=1', { headers: { 'x-forwarded-for': '5.5.5.5' } }));
    check('polling vidéo → clé vidéo (même génération)', kh4.seen[0].auth === 'Bearer ' + KEYS.video, kh4.seen[0].auth);

    const kh5 = keyHarness({ provider_api_key: KEYS.shared });
    await kh5.handle(mkTool('/v1/images/generations'));
    check('aucune clé d\'outil → clé partagée utilisée', kh5.seen[0].auth === 'Bearer ' + KEYS.shared, kh5.seen[0].auth);
    check('jamais la clé du client ni sk- dans l\'en-tête amont',
        kh5.seen[0].auth.indexOf('sk-') === -1, kh5.seen[0].auth);

    console.log('\n=== 22. CONCURRENCE MULTI-UTILISATEURS (schéma SQL) ===');
    /* Plusieurs utilisateurs peuvent monter en parallèle : les quotas doivent
       rester justes. La garantie vient de `consume_quota`, une fonction
       SECURITY DEFINER qui verrouille la ligne du compteur (`FOR UPDATE`)
       avant de vérifier puis d'incrémenter — deux appels simultanés sont
       sérialisés par Postgres, la limite ne peut donc pas être dépassée. */
    const schema = readFileSync(join(PROJECT, 'supabase', 'schema.sql'), 'utf8');
    const fnBody = schema.slice(schema.indexOf('function public.consume_quota'));
    check('consume_quota est une fonction plpgsql', /language plpgsql security definer/.test(fnBody.slice(0, 300)));
    check('verrouillage de la ligne du compteur (FOR UPDATE)',
        /for update/.test(fnBody), (fnBody.match(/for update/g) || []).length + ' verrou(x)');
    check('incrément atomique (UPDATE ... SET units = units + n)',
        /update public\.usage_counters set units = units \+ v_units/.test(fnBody));
    check('repli atomique si la ligne n\'existe pas encore (ON CONFLICT DO UPDATE)',
        /on conflict \(user_id, day, kind\)\s*\n?\s*do update set units = public\.usage_counters\.units \+ excluded\.units/.test(fnBody));
    check('compteur global verrouillé séparément (plafond partagé)',
        /user_id = v_zero and day = v_day and kind = 'global' for update/.test(fnBody));
    /* Invoquable uniquement par la Gateway (service_role) : un client ne peut
       pas consommer/consommer deux fois en contournant la Gateway. */
    check('consume_quota retiré à anon + authenticated',
        /revoke execute on function public\.consume_quota\([^)]*\) from public, anon, authenticated;/.test(schema));
    check('consume_quota accordé uniquement à service_role',
        /grant\s+execute on function public\.consume_quota\([^)]*\) to service_role;/.test(schema));
    check('usage_counters : RLS activé', /alter table public\.usage_counters enable row level security;/.test(schema));
    check('usage_counters : aucun INSERT/UPDATE/DELETE pour anon',
        !/grant (insert|update|delete|all)[^;]*on public\.usage_counters to (anon|authenticated)/i.test(schema));
    check('refund_quota aussi réservé à service_role',
        /revoke execute on function public\.refund_quota[^;]*from public, anon, authenticated;/.test(schema));

    console.log('\n=== 23. IMAGE DE RÉFÉRENCE DEPUIS LA BIBLIOTHÈQUE ===');
    /* Une création reprise de la bibliothèque n'est qu'une URL distante : le
       navigateur ne peut pas la récupérer (CORS). La passerelle la télécharge
       donc elle-même et l'encode. Un fichier choisi sur l'appareil arrive déjà
       sous forme de data-URI et doit traverser ce chemin sans être touché. */
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const DATA_URI = 'data:image/jpeg;base64,' + btoa('fichier-local');
    let imgCalls = [];
    const imgFetch = url => { imgCalls.push(url); return Promise.resolve(new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })); };

    /* — resolveMediaRef — */
    const rData = await resolveMediaRef(DATA_URI, () => { imgCalls.push('ne-doit-pas'); return Promise.resolve(null); });
    check('data-URI renvoyé tel quel (aucun téléchargement)',
        rData.ok === true && rData.converted === false && rData.value === DATA_URI && imgCalls.length === 0);

    const rEmpty = await resolveMediaRef('', imgFetch);
    check('chaine vide ignorée', rEmpty.ok === true && rEmpty.converted === false && imgCalls.length === 0);

    imgCalls = [];
    const rUrl = await resolveMediaRef('https://cdn.test/creation.png', imgFetch);
    check('URL http encodée en data-URI',
        rUrl.ok === true && rUrl.converted === true && /^data:image\/png;base64,/.test(rUrl.value), rUrl.value && rUrl.value.slice(0, 30));
    check('URL téléchargée exactement une fois', imgCalls.length === 1, imgCalls.join(','));
    check('payload base64 non vide', rUrl.value.split(',')[1].length > 0);

    const m404 = await resolveMediaRef('https://cdn.test/parti.png', () => Promise.resolve(new Response('nope', { status: 404 })));
    check('404 amont → échec signalé', m404.ok === false && m404.reason === 'status' && m404.status === 404);

    const mNet = await resolveMediaRef('https://cdn.test/x.png', () => Promise.reject(new Error('ENOTFOUND')));
    check('réseau en échec → échec signalé', mNet.ok === false && mNet.reason === 'network');

    const mType = await resolveMediaRef('https://cdn.test/page.html', () =>
        Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    check('réponse non-image refusée', mType.ok === false && mType.reason === 'type');

    const mZero = await resolveMediaRef('https://cdn.test/vide.png', () =>
        Promise.resolve(new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/png' } })));
    check('corps vide refusé', mZero.ok === false && mZero.reason === 'empty');

    /* — resolveVideoRefs — */
    const untouched = '{"prompt":"un film","model":"agnes-video-2.5-flash"}';
    const rNoop = await resolveVideoRefs(untouched, imgFetch);
    check('corps sans référence d\'image inchangé (même chaîne)',
        rNoop.ok === true && rNoop.converted === false && rNoop.body === untouched);

    const rBadJson = await resolveVideoRefs('{pas-du-json', imgFetch);
    check('JSON illisible : aucun effet de bord', rBadJson.ok === true && rBadJson.body === '{pas-du-json');

    imgCalls = [];
    const rBoth = await resolveVideoRefs(JSON.stringify({
        model: 'agnes-video-2.5-flash', prompt: 'un film',
        image: 'https://cdn.test/debut.png', last_frame: 'https://cdn.test/fin.png',
        num_frames: 12, frame_rate: 24
    }), imgFetch);
    const parsed = JSON.parse(rBoth.body);
    check('image ET last_frame convertis', rBoth.converted === true && /^data:image\/png/.test(parsed.image) && /^data:image\/png/.test(parsed.last_frame));
    check('les autres champs sont préservés', parsed.prompt === 'un film' && parsed.num_frames === 12 && parsed.frame_rate === 24 && parsed.model === 'agnes-video-2.5-flash');
    check('deux téléchargements', imgCalls.length === 2, imgCalls.length);

    const rFailField = await resolveVideoRefs(JSON.stringify({ image: 'data:image/jpeg;base64,AAA', last_frame: 'https://cdn.test/mort.png' }),
        () => Promise.reject(new Error('boom')));
    check('un champ en échec fait échouer la requête', rFailField.ok === false && rFailField.reason === 'network');

    /* — à travers le handler — */
    const vEnv = Object.assign({}, env, { RATE_LIMIT_PER_MIN: '50' });
    const vCalls = [];
    const handleVid = createHandler({
        env: vEnv, store: createMemoryStore(), now: () => t, log: () => {},
        fetchImpl: async (url, init) => {
            vCalls.push({ url: url, init: init });
            if (String(url).indexOf('https://cdn.test/') === 0) {
                return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
            }
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });
    const vidReq = body => makeReq(GW + '/v1/videos', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });

    const rVid = await handleVid(vidReq({ model: 'agnes-video-2.5-flash', prompt: 'un film', image: 'https://cdn.test/creation.png' }));
    const upstreamVid = vCalls.find(c => String(c.url).indexOf(UP) === 0);
    check('vidéo avec URL de bibliothèque relayée', rVid.status === 200 && !!upstreamVid, rVid.status);
    check('l\'amont reçoit une image encodée, jamais une URL',
        !!upstreamVid && /^data:image\/png;base64,/.test(JSON.parse(upstreamVid.init.body).image), upstreamVid && JSON.parse(upstreamVid.init.body).image.slice(0, 24));

    vCalls.length = 0;
    const rVidLocal = await handleVid(vidReq({ model: 'agnes-video-2.5-flash', prompt: 'un film', image: DATA_URI }));
    const upstreamLocal = vCalls.find(c => String(c.url).indexOf(UP) === 0);
    check('fichier d\'appareil transmis SANS modification',
        rVidLocal.status === 200 && upstreamLocal && JSON.parse(upstreamLocal.init.body).image === DATA_URI);
    check('fichier d\'appareil : aucun téléchargement amont supplémentaire',
        vCalls.filter(c => String(c.url).indexOf('https://cdn.test/') === 0).length === 0);

    vCalls.length = 0;
    const rImgUrl = await handleVid(makeReq(GW + '/v1/images/generations', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', image: 'https://cdn.test/ignoré.png' })
    }));
    check('génération d\'image : URL NON convertie (champ vidéo seulement)',
        rImgUrl.status === 200 && vCalls.filter(c => String(c.url).indexOf('https://cdn.test/') === 0).length === 0);

    vCalls.length = 0;
    const handleDead = createHandler({
        env: vEnv, store: createMemoryStore(), now: () => t, log: () => {},
        fetchImpl: async url => {
            vCalls.push({ url: url });
            if (String(url).indexOf('https://cdn.test/') === 0) throw new Error('ENOTFOUND cdn.test');
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });
    const rDead = await handleDead(vidReq({ model: 'agnes-video-2.5-flash', prompt: 'un film', image: 'https://cdn.test/disparu.png' }));
    const bDead = await rDead.json();
    check('image injoignable → 400 avant tout appel au fournisseur',
        rDead.status === 400 && vCalls.filter(c => String(c.url).indexOf(UP) === 0).length === 0, rDead.status);
    check('aucun détail technique ni URL de CDN dans la réponse',
        !/cdn\.test|ENOTFOUND|https?:/.test(JSON.stringify(bDead)), JSON.stringify(bDead));
    check('message lisible pour l\'utilisateur', /image/i.test(bDead.error.message), bDead.error.message);

    console.log('\n=== 24. IDENTIFIANT DE REQUÊTE ET DIAGNOSTIC AMONT ===');
    /* Un échec affiché dans le back-office n'a aucune valeur si on ne peut pas
       le retrouver dans les journaux de la fonction. Chaque réponse porte donc
       un id que la passerelle écrit aussi dans ses logs, à côté du VRAI statut
       amont et de son extrait — que le client ne reçoit jamais. */

    const id1 = newRequestId();
    const id2 = newRequestId();
    check('identifiant court (13 caractères)', id1.length === 13, id1);
    check('identifiant non répété', id1 !== id2, id1 + ' / ' + id2);
    check('identifiant sans caractère sensible', /^[a-z0-9-]+$/.test(id1), id1);

    const logs24 = [];
    const t24 = 1700000000000;
    const env24 = {
        AGNES_API_KEY: SECRET,
        ALLOWED_ORIGINS: 'https://fbici.github.io',
        RATE_LIMIT_PER_MIN: '50',
        IMAGE_LIMIT: '0', VIDEO_LIMIT: '0', CHAT_LIMIT: '0', MOTION_LIMIT: '0'
    };
    const upStatus = { code: 503, body: '{"error":"upstream busy","trace":"agnes-video-2.5-flash"}' };
    const handle24 = createHandler({
        env: env24, store: createMemoryStore(), now: () => t24,
        log: (...a) => logs24.push(a.join(' ')),
        fetchImpl: async () => new Response(upStatus.body, {
            status: upStatus.code, headers: { 'content-type': 'application/json' }
        })
    });

    const ok24 = await handle24(makeReq(GW + '/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': 'https://fbici.github.io' },
        body: JSON.stringify({ prompt: 'un chat', model: 'agnes-image-2.1-flash' })
    }));
    const ridOk = ok24.headers.get('x-lsv-request-id');
    check('réussite : id de requête présent', /^[a-z0-9-]{6,}$/.test(ridOk || ''), ridOk);
    check('en-têtes CORS exposés au navigateur (cross-origin)',
        String(ok24.headers.get('access-control-expose-headers') || '').indexOf('x-lsv-request-id') !== -1 &&
        String(ok24.headers.get('access-control-expose-headers') || '').indexOf('x-lsv-quota-video') !== -1,
        ok24.headers.get('access-control-expose-headers'));
    /* Invariant : tout en-tête `x-lsv-*` réellement porté par une réponse doit
       figurer dans `Access-Control-Expose-Headers`, sinon le navigateur le
       masque et le client croit à tort que la donnée n'a pas été envoyée. */
    const exposed = String(ok24.headers.get('access-control-expose-headers') || '').toLowerCase();
    const carried = Array.from(ok24.headers.keys()).filter(n => n.toLowerCase().indexOf('x-lsv-') === 0);
    check('tous les en-têtes x-lsv-* portés sont exposés au navigateur',
        carried.length > 0 && carried.every(n => exposed.indexOf(n.toLowerCase()) !== -1),
        carried.join(',') || 'aucun');

    const err24 = await handle24(makeReq(GW + '/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': 'https://fbici.github.io' },
        body: JSON.stringify({ model: 'agnes-video-2.5-flash', prompt: 'un film' })
    }));
    const b24 = await err24.json();
    const ridErr = err24.headers.get('x-lsv-request-id');
    check('échec amont → 503 conservé (statut utile pour le client)',
        err24.status === 503, err24.status);
    check('échec amont : id de requête renvoyé', /^[a-z0-9-]{6,}$/.test(ridErr || ''), ridErr);
    check('id différent d\'une requête à l\'autre', ridOk !== ridErr, ridOk + ' vs ' + ridErr);
    const line24 = logs24.filter(l => l.indexOf('amont-status') === 0).pop() || '';
    check('le journal cite le même identifiant que la réponse',
        line24.indexOf(ridErr) !== -1, line24);
    check('le journal porte le VRAI statut amont (503)',
        line24.indexOf(' 503 ') !== -1 || /amont-status 503/.test(line24), line24);
    check('le journal cite le chemin concerné', line24.indexOf('/v1/videos') !== -1, line24);
    check('le journal contient un extrait de la réponse amont',
        line24.indexOf('upstream busy') !== -1, line24);
    check('la réponse client ne contient AUCUN détail amont',
        !/upstream busy|agnes-video|trace/.test(JSON.stringify(b24)), JSON.stringify(b24));

    /* Les trois 503 possibles restent distinguables par leur message : le
       back-office peut séparer « pas de clé », « suspendu » et « amont ». */
    const noKey24 = createHandler({
        env: { AGNES_API_KEY: '', ALLOWED_ORIGINS: 'https://fbici.github.io' },
        store: createMemoryStore(), now: () => t24, log: (...a) => logs24.push(a.join(' ')),
        fetchImpl: async () => new Response('{}', { status: 200 })
    });
    const nk24 = await noKey24(makeReq(GW + '/v1/videos', {
        method: 'POST', headers: { 'content-type': 'application/json', 'origin': 'https://fbici.github.io' },
        body: JSON.stringify({ model: 'agnes-video-2.5-flash', prompt: 'x' })
    }));
    const bNk = await nk24.json();
    check('503 « pas de clé » = message distinct',
        nk24.status === 503 && /indisponible/i.test(bNk.error.message) && !/suspendu/i.test(bNk.error.message),
        bNk.error.message);
    check('503 « pas de clé » : id de requête présent',
        /^[a-z0-9-]{6,}$/.test(nk24.headers.get('x-lsv-request-id') || ''),
        nk24.headers.get('x-lsv-request-id'));

    /* 502 : tout statut amont hors 400/429/503 est sanitisé côté client mais
       le vrai code reste dans le journal. */
    upStatus.code = 500;
    upStatus.body = 'Internal Server Error at /agnesapi/videos';
    const err500 = await handle24(makeReq(GW + '/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': 'https://fbici.github.io' },
        body: JSON.stringify({ model: 'agnes-video-2.5-flash', prompt: 'un film' })
    }));
    const b500 = await err500.json();
    const line500 = logs24.filter(l => l.indexOf('amont-status') === 0).pop() || '';
    check('500 amont → 502 sanitisé pour le client', err500.status === 502, err500.status);
    check('500 amont : vrai statut conservé dans le journal',
        /amont-status 500/.test(line500), line500);
    check('500 amont : extrait serveur dans le journal',
        line500.indexOf('Internal Server Error') !== -1, line500);
    check('500 amont : rien de ce détail dans la réponse',
        !/Internal Server Error|agnesapi/.test(JSON.stringify(b500)), JSON.stringify(b500));

    /* Panne réseau : jamais atteint le fournisseur, journalisée avec l'id. */
    logs24.length = 0;
    const handleNet24 = createHandler({
        env: env24, store: createMemoryStore(), now: () => t24,
        log: (...a) => logs24.push(a.join(' ')),
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });
    const net24 = await handleNet24(makeReq(GW + '/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': 'https://fbici.github.io' },
        body: JSON.stringify({ model: 'agnes-video-2.5-flash', prompt: 'x' })
    }));
    const netBody = await net24.json();
    const netLine = logs24.filter(l => l.indexOf('amont-reseau') === 0).pop() || '';
    check('panne réseau → 502 + id dans le journal',
        net24.status === 502 && /^[a-z0-9-]{6,}$/.test(net24.headers.get('x-lsv-request-id') || '') &&
        netLine.indexOf(net24.headers.get('x-lsv-request-id')) !== -1,
        net24.status + ' | ' + netLine);
    check('panne réseau : aucune fuite technique dans la réponse',
        !/ECONNREFUSED/.test(JSON.stringify(netBody)), JSON.stringify(netBody));

    console.log('\n=== 25. REFUS DE VALIDATION : CODE ET PARAMÈTRE SEULS ===');
    /* Un fournisseur qui répond « num_frames is a forbidden field » donne tout
       ce qu'il faut pour corriger — mais son texte ne doit PAS partir tel quel
   au client. On extrait deux champs structurés, filtrés caractère par
       caractère, et rien d'autre. */
    const valLogs = [];
    const mkVal = (status, upstreamBody) => createHandler({
        env: env24, store: createMemoryStore(), now: () => t24,
        log: (...a) => valLogs.push(a.join(' ')),
        fetchImpl: async () => new Response(upstreamBody, {
            status, headers: { 'content-type': 'application/json' }
        })
    });
    const vidPost = body => makeReq(GW + '/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': 'https://fbici.github.io' },
        body: JSON.stringify(body)
    });

    const FORBIDDEN = JSON.stringify({
        code: 'invalid_request',
        message: 'num_frames is a forbidden field (request id: 20261017213901273902164VDlQFDZL)',
        data: { param: 'num_frames' }
    });
    const v400 = await mkVal(400, FORBIDDEN)(vidPost({ model: 'agnes-video-2.5-flash', prompt: 'un film', num_frames: 121 }));
    const bV400 = await v400.json();
    check('400 amont → code remonté', v400.headers.get('x-lsv-upstream-code') === 'invalid_request',
        v400.headers.get('x-lsv-upstream-code'));
    check('400 amont → paramètre refusé remonté', v400.headers.get('x-lsv-upstream-param') === 'num_frames',
        v400.headers.get('x-lsv-upstream-param'));
    check('les deux en-têtes sont exposés au navigateur',
        String(v400.headers.get('access-control-expose-headers') || '').indexOf('x-lsv-upstream-code') !== -1 &&
        String(v400.headers.get('access-control-expose-headers') || '').indexOf('x-lsv-upstream-param') !== -1);
    check('le message utilisateur reste générique',
        bV400.error.message === 'Impossible de générer le contenu pour le moment. Veuillez réessayer dans quelques instants.',
        bV400.error.message);
    check('aucun texte libre du fournisseur dans la réponse',
        !/forbidden|request id|20261017|VDlQFDZL/.test(JSON.stringify(bV400)), JSON.stringify(bV400));
    check('l\'identifiant de requête reste présent', /^[a-z0-9-]{6,}$/.test(v400.headers.get('x-lsv-request-id') || ''));

    /* Filtrage : ni chemins, ni espaces, ni majuscules parasites. */
    const UGLY = JSON.stringify({
        code: 'Bad Request/../etc', message: 'x',
        data: { param: 'a b:c/d"e' }
    });
    const vUgly = await mkVal(400, UGLY)(vidPost({ model: 'm', prompt: 'p' }));
    check('code assaini (lettres, chiffres, - et _ seuls)',
        vUgly.headers.get('x-lsv-upstream-code') === 'BadRequestetc', vUgly.headers.get('x-lsv-upstream-code'));
    check('paramètre assaini', vUgly.headers.get('x-lsv-upstream-param') === 'abcde',
        vUgly.headers.get('x-lsv-upstream-param'));

    /* Corps non JSON → aucun en-tête inventé. */
    const vPlain = await mkVal(400, 'Bad Request — something went wrong')(vidPost({ model: 'm', prompt: 'p' }));
    check('400 non-JSON → aucun code ni paramètre',
        !vPlain.headers.get('x-lsv-upstream-code') && !vPlain.headers.get('x-lsv-upstream-param'));

    /* Réservé au 400 : un 503 avec un code ne divulgue rien. */
    const v503 = await mkVal(503, FORBIDDEN)(vidPost({ model: 'm', prompt: 'p' }));
    check('503 → aucun code ni paramètre (réservé à la validation)',
        !v503.headers.get('x-lsv-upstream-code') && !v503.headers.get('x-lsv-upstream-param'));
    const b503v = await v503.json();
    check('503 → message inchangé', /Impossible de générer/.test(b503v.error.message));

    /* 401/402 : pareil, jamais de détail. */
    const v401 = await mkVal(401, FORBIDDEN)(vidPost({ model: 'm', prompt: 'p' }));
    check('401 → aucun code ni paramètre',
        !v401.headers.get('x-lsv-upstream-code') && !v401.headers.get('x-lsv-upstream-param'));
    check('401 sanitisé en 502', v401.status === 502, v401.status);

    /* Tableau en tête de corps : pas de crash, pas d'en-tête. */
    const vArr = await mkVal(400, '[{"code":"invalid_request"}]')(vidPost({ model: 'm', prompt: 'p' }));
    check('corps table → aucun en-tête, aucun crash',
        vArr.status === 400 && !vArr.headers.get('x-lsv-upstream-code'));

    const failed = results.filter(r => !r.ok);
    console.log('\n════════════════════════════════');
    console.log((results.length - failed.length) + '/' + results.length + ' tests gateway OK');
    if (failed.length) console.log('ECHECS : ' + failed.map(f => f.label).join(', '));
    else console.log('GATEWAY CONFORME');
    process.exit(failed.length ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
