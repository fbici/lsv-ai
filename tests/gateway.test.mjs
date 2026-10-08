/* ═══════════════════════════════════════════════════════════════════════════
   Tests de la LSV API Gateway
   ───────────────────────────────────────────────────────────────────────────
   Couvre : routage (y compris préfixe Supabase), injection de la clé serveur,
   rejet de l'authorization client, CORS, rate limit, quotas journaliers,
   sanitisation des erreurs amont, clé absente.
   Usage : node tests/gateway.test.mjs
   ═══════════════════════════════════════════════════════════════════════════ */
import { createHandler, createMemoryStore, classifyRequest, subPath } from '../supabase/functions/lsv-gateway/core.mjs';

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

    const rPoll = await handle(makeReq(GW + '/agnesapi?video_id=abc&model_name=agnes-video-v2.0', { method: 'GET' }));
    check('polling relayé', rPoll.status === 200 && calls[1].url === UP + '/agnesapi?video_id=abc&model_name=agnes-video-v2.0', calls[1] && calls[1].url);

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
    check('message quota générique', /limite temporaire/.test(bQ3.error.message), bQ3.error.message);
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
                return new Response(JSON.stringify([{ value: DB_KEY }]), {
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
    check('lecture filtrée sur la clé du fournisseur', /select=value&key=eq\.provider_api_key/.test(settingsCalls[0].url), settingsCalls[0].url);
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
                return new Response(JSON.stringify([{ value: DB_KEY }]), { status: 200, headers: { 'content-type': 'application/json' } });
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

    const failed = results.filter(r => !r.ok);
    console.log('\n════════════════════════════════');
    console.log((results.length - failed.length) + '/' + results.length + ' tests gateway OK');
    if (failed.length) console.log('ECHECS : ' + failed.map(f => f.label).join(', '));
    else console.log('GATEWAY CONFORME');
    process.exit(failed.length ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
