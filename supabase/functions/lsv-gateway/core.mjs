/* ═══════════════════════════════════════════════════════════════════════════
   LSV API Gateway — cœur de la passerelle (indépendant de la plateforme)
   ───────────────────────────────────────────────────────────────────────────
   Rôle :
     - reçoit les requêtes du frontend LSV.ai (GitHub Pages) ;
     - injecte la clé du fournisseur lue UNIQUEMENT côté serveur : clé saisie
       dans le back-office (table app_settings), sinon secret AGNES_API_KEY ;
     - retire toute authorization envoyée par le client ;
     - identifie le COMPTE (jeton Supabase vérifié côté serveur) et applique
       des QUOTAS JOURNALIERS PAR UTILISATEUR (images / vidéos / chat),
       remis à zéro à minuit UTC, gérés depuis le back-office ;
     - pondère les images selon la RÉSOLUTION (1K = 1, 2K = 2, 3K = 3) ;
     - consomme de façon ATOMIQUE (deux requêtes simultanées ne dépassent pas
       le quota) et REMBOURSE si la génération échoue côté fournisseur ;
     - applique en plus une limite GLOBALE journalière et un rate limit par IP ;
     - ne transmet JAMAIS le détail des erreurs amont au navigateur.

   Exécuté par Supabase Edge Functions (Deno) via index.ts.
   Testable sous Node : tests/gateway.test.mjs
   ═══════════════════════════════════════════════════════════════════════════ */

const MSG_UPSTREAM = 'Impossible de g\u00e9n\u00e9rer le contenu pour le moment. Veuillez r\u00e9essayer dans quelques instants.';
const MSG_LIMIT = 'Vous avez atteint la limite temporaire de g\u00e9n\u00e9ration. Veuillez patienter avant de r\u00e9essayer.';
const MSG_NOT_FOUND = 'Ressource indisponible.';
const MSG_FORBIDDEN = 'Acc\u00e8s non autoris\u00e9.';
const MSG_NO_KEY = 'Service momentan\u00e9ment indisponible.';
const MSG_QUOTA = 'Quota du jour atteint. Reviens demain — ton compteur se r\u00e9initialise \u00e0 minuit.';
const MSG_SUSPENDED = 'Les g\u00e9n\u00e9rations sont momentan\u00e9ment suspendues. R\u00e9essaie dans quelques instants.';
const MSG_MEDIA = 'Impossible de r\u00e9cup\u00e9rer l\u2019image de r\u00e9f\u00e9rence. V\u00e9rifie qu\u2019elle existe toujours dans ta biblioth\u00e8que.';

const DEFAULT_AGNES_BASE = 'https://apihub.agnes-ai.com';
const FUNCTION_MOUNT = '/functions/v1/lsv-gateway';
const SHORT_MOUNT = '/lsv-gateway';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/* Une image de bibliothèque peut être lourde ; on borne la récupération. */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MEDIA_CHUNK = 0x8000;

function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += MEDIA_CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + MEDIA_CHUNK));
    }
    return btoa(bin);
}

/** Résout une référence d'image :
    - `data:…` / tout ce qui n'est pas une URL → renvoyé tel quel (le cas
      d'un fichier choisi sur l'appareil est STRICTEMENT inchangé) ;
    - `https://…` → récupéré ICI, côté serveur, où aucun CORS ne s'applique,
      puis encodé en data-URI, seul format accepté en aval. */
export async function resolveMediaRef(value, fetchImpl) {
    if (typeof value !== 'string' || !value) return { ok: true, value: value, converted: false };
    if (!/^https?:\/\//i.test(value)) return { ok: true, value: value, converted: false };

    let res;
    try {
        res = await fetchImpl(value, { method: 'GET', headers: { Accept: 'image/*' } });
    } catch (e) {
        return { ok: false, reason: 'network' };
    }
    if (!res || !res.ok) return { ok: false, reason: 'status', status: res ? res.status : 0 };

    const ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
    if (ct && ct.indexOf('image/') !== 0) return { ok: false, reason: 'type', detail: ct.split(';')[0] };

    let bytes;
    try {
        bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
        return { ok: false, reason: 'body' };
    }
    if (!bytes.length) return { ok: false, reason: 'empty' };
    if (bytes.length > MAX_MEDIA_BYTES) return { ok: false, reason: 'size', size: bytes.length };

    const mime = (ct.split(';')[0] || '').trim() || 'image/jpeg';
    return { ok: true, value: 'data:' + mime + ';base64,' + bytesToBase64(bytes), converted: true };
}

/** Applique resolveMediaRef aux champs d'image d'une requête vidéo.
    Ne touche qu'à `image` et `last_frame` ; tout le reste du corps est
    préservé à l'identique. */
export async function resolveVideoRefs(bodyText, fetchImpl) {
    let payload;
    try {
        payload = JSON.parse(bodyText || '');
    } catch (e) {
        return { ok: true, body: bodyText, converted: false };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: true, body: bodyText, converted: false };
    }

    const fields = ['image', 'last_frame'];
    let touched = false;
    for (const key of fields) {
        if (typeof payload[key] !== 'string') continue;
        const r = await resolveMediaRef(payload[key], fetchImpl);
        if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail || r.status || '' };
        if (r.converted) { payload[key] = r.value; touched = true; }
    }
    return { ok: true, body: touched ? JSON.stringify(payload) : bodyText, converted: touched };
}

function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clientIp(request) {
    const fwd = request.headers.get('x-forwarded-for');
    if (fwd) {
        const first = fwd.split(',')[0].trim();
        if (first) return first;
    }
    return (request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '').trim();
}

/** Décode le payload d'un JWT SANS le vérifier — uniquement pour savoir si
    c'est un jeton de compte (role=authenticated) ou la clé anonyme publique.
    La vérification réelle se fait côté serveur Supabase (/auth/v1/user). */
export function tokenRole(token) {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return '';
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const json = typeof atob === 'function'
            ? atob(padded)
            : Buffer.from(padded, 'base64').toString('utf8');
        const payload = JSON.parse(json);
        return String(payload && payload.role || '');
    } catch (e) { return ''; }
}

/** Sous-chemin réel vu par la gateway (le chemin inclut le préfixe
    /functions/v1/lsv-gateway lorsqu'elle est déployée sur Supabase). */
export function subPath(pathname) {
    let p = pathname || '/';
    const i = p.indexOf(FUNCTION_MOUNT);
    if (i !== -1) return p.slice(i + FUNCTION_MOUNT.length) || '/';
    const j = p.indexOf(SHORT_MOUNT);
    if (j !== -1) return p.slice(j + SHORT_MOUNT.length) || '/';
    return p;
}

/** Classe la requête pour les quotas journaliers.
    Le polling vidéo (GET /agnesapi) n'est PAS compté : il fait partie
    d'une même génération. */
export function classifyRequest(path, method) {
    if (path.startsWith('/v1/images')) return 'image';
    if (path.startsWith('/v1/chat')) return 'chat';
    if (path.startsWith('/v1/motion')) return 'motion';
    if (path.startsWith('/v1/videos')) return method === 'POST' ? 'video' : null;
    if (path.startsWith('/agnesapi')) return null;
    return null;
}

/** Poids d'une image selon sa RÉSOLUTION — base 1K.
    1K (≤ 1500 px de côté max) = 1 unité · 2K (≤ 2800) = 2 · 3K = 3.
    Un appel sans taille lisible vaut 1 unité (le plus restrictif). */
export function imageUnits(size) {
    const m = /^(\d{2,5})\s*x\s*(\d{2,5})$/.exec(String(size || '').trim());
    if (!m) return 1;
    const max = Math.max(parseInt(m[1], 10), parseInt(m[2], 10));
    if (!Number.isFinite(max) || max <= 0) return 1;
    if (max <= 1500) return 1;
    if (max <= 2800) return 2;
    return 3;
}

/** Nombre d'unités consommées par une requête donnée. */
export function requestUnits(type, bodyText) {
    if (type === 'image') {
        let size = '';
        try { size = (JSON.parse(bodyText || '{}') || {}).size || ''; } catch (e) { size = ''; }
        return imageUnits(size);
    }
    return 1;
}

/** Store mémoire (fenêtre glissante + compteurs journaliers).
    Réinitialisé à chaque froid de l'isolate — protections anti-abus de
    premier niveau. La vérité pour les quotas par compte est en base
    (table usage_counters), donc persistante et partagée entre isolates. */
export function createMemoryStore(maxEntries = 5000) {
    const windows = new Map();
    const counters = new Map();
    const inflight = new Map();
    const prune = map => { if (map.size > maxEntries) map.clear(); };
    return {
        allowWindow(key, limit, windowMs, now) {
            let hits = windows.get(key);
            if (!hits) { hits = []; windows.set(key, hits); prune(windows); }
            const recent = hits.filter(t => now - t < windowMs);
            if (recent.length >= limit) {
                const retryAfter = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
                return { ok: false, retryAfter };
            }
            recent.push(now);
            windows.set(key, recent);
            return { ok: true };
        },
        consumeDaily(key, limit, now) {
            const day = new Date(now).toISOString().slice(0, 10);
            const k = key + ':' + day;
            const used = counters.get(k) || 0;
            if (used >= limit) return { ok: false, used };
            counters.set(k, used + 1);
            prune(counters);
            return { ok: true, used: used + 1 };
        },
        /** Générations simultanées en cours pour une clé donnée.
            Empêche qu'un même compte enchaîne assez de requêtes
            parallèles pour dépasser son quota entre deux verrous. */
        enter(key, max) {
            const n = (inflight.get(key) || 0) + 1;
            inflight.set(key, n);
            if (max > 0 && n > max) { inflight.set(key, n - 1); return false; }
            return true;
        },
        leave(key) {
            const n = (inflight.get(key) || 0) - 1;
            if (n <= 0) inflight.delete(key); else inflight.set(key, n);
        },
        reset() { windows.clear(); counters.clear(); inflight.clear(); }
    };
}

export function createHandler(options = {}) {
    const env = options.env || {};
    const doFetch = options.fetchImpl || ((input, init) => globalThis.fetch(input, init));
    const store = options.store || createMemoryStore();
    const now = options.now || (() => Date.now());
    const log = options.log || ((...args) => console.error('[lsv-gateway]', ...args));

    const agnesBase = (env.AGNES_API_BASE || DEFAULT_AGNES_BASE).replace(/\/+$/, '');
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const ratePerMin = toInt(env.RATE_LIMIT_PER_MIN, 10);
    const maxConcurrent = toInt(env.MAX_CONCURRENT_PER_USER, 3);
    /* Limites de secours lues dans l'environnement — utilisées uniquement si
       la table app_settings est injoignable. Les valeurs de la base priment. */
    const envLimits = {
        image: toInt(env.IMAGE_LIMIT, 0),
        video: toInt(env.VIDEO_LIMIT, 0),
        chat: toInt(env.CHAT_LIMIT, 0),
        motion: toInt(env.MOTION_LIMIT, 0)
    };
    const envGlobal = toInt(env.QUOTA_GLOBAL_DAILY, 0);
    const maxBodyBytes = toInt(env.MAX_BODY_BYTES, 20 * 1024 * 1024);

    const supaUrl = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
    let secretDict = {};
    try { secretDict = JSON.parse(env.SUPABASE_SECRET_KEYS || '{}') || {}; } catch (e) { secretDict = {}; }
    const svcKey = String(env.SUPABASE_SERVICE_ROLE_KEY || secretDict.service_role || '').trim();

    /* ── Réglages applicatifs (clé fournisseur + quotas) ────────────────────
       Une SEULE lecture groupée par isolate et par 30 s : la clé du
       fournisseur et les quotas viennent de la même table. Tout se règle
       depuis /admin, sans redéployer la fonction. */
    const QUOTA_KEYS = [
        'quota_enabled', 'quota_suspended', 'quota_global_daily',
        'quota_image_daily', 'quota_video_daily', 'quota_chat_daily', 'quota_motion_daily',
        'quota_admin_image_daily', 'quota_admin_video_daily',
        'quota_admin_chat_daily', 'quota_admin_motion_daily'
    ];
    const SETTINGS_KEYS = [
        'provider_api_key', 'provider_api_key_image',
        'provider_api_key_video', 'provider_api_key_chat'
    ].concat(QUOTA_KEYS);
    const SETTINGS_CACHE_MS = 30000;
    let settingsCache = { at: -1, map: null };

    /** Lit un lot de clés de app_settings avec la clé de service du projet. */
    async function readSettings(keys) {
        if (!supaUrl || !svcKey) return {};
        const filter = 'key=in.(' + keys.join(',') + ')';
        try {
            const res = await doFetch(supaUrl + '/rest/v1/app_settings?select=key,value&' + filter, {
                headers: {
                    apikey: svcKey,
                    Authorization: 'Bearer ' + svcKey,
                    Accept: 'application/json'
                }
            });
            if (!res || !res.ok) { log('reglages-status', res && res.status); return {}; }
            const rows = await res.json();
            const out = {};
            (Array.isArray(rows) ? rows : []).forEach(r => {
                if (r && r.key != null) out[String(r.key)] = String(r.value == null ? '' : r.value);
            });
            return out;
        } catch (e) {
            log('reglages-lecture', (e && e.message) || 'erreur');
            return {};
        }
    }

    async function allSettings() {
        const t = now();
        if (settingsCache.map && t - settingsCache.at < SETTINGS_CACHE_MS) return settingsCache.map;
        const map = await readSettings(SETTINGS_KEYS);
        settingsCache = { at: t, map: map };
        return map;
    }

    /* ── Clés du fournisseur ────────────────────────────────────────────────
       Une clé DÉDIÉE par outil (images / vidéos / chat), saisie dans le
       back-office. Chaque outil a ainsi son propre budget et son propre rate
       limit chez le fournisseur : un lot d'images n'épuise pas la clé vidéo.
       Si la clé de l'outil est vide, on retombe sur la CLÉ PARTAGÉE
       (provider_api_key) — également utilisée pour le module Motion.
       Dernier recours : le secret serveur AGNES_API_KEY. La table est lue
       avec la clé de service du projet : les clés ne quittent jamais le
       serveur. Une seule lecture groupée toutes les 30 s (cache). */

    /** Clé utilisée pour un chemin donné : 'image' | 'video' | 'chat' | ''. */
    function keyKind(path, method) {
        /* Le polling vidéo appartient à la même génération que le POST. */
        if (path.startsWith('/agnesapi')) return 'video';
        return classifyRequest(path, method) || '';
    }

    /** Résout la clé pour un outil : clé dédiée → clé partagée → secret. */
    async function resolveKey(kind) {
        const envKey = (env.AGNES_API_KEY || '').trim();
        const k = String(kind || '');
        if (!supaUrl || !svcKey) return envKey;
        const map = await allSettings();
        if (k) {
            const dedicated = String(map['provider_api_key_' + k] || '').trim();
            if (dedicated) return dedicated;
        }
        return String(map.provider_api_key || '').trim() || envKey;
    }

    /** Limite effective pour un type donné (admin ou utilisateur standard). */
    function limitFrom(map, kind, isAdmin) {
        if (isAdmin) {
            const raw = map['quota_admin_' + kind + '_daily'];
            if (raw !== undefined && raw !== '') return toInt(raw, 0);
        }
        const raw = map['quota_' + kind + '_daily'];
        if (raw !== undefined && raw !== '') return toInt(raw, 0);
        return toInt(envLimits[kind], 0);
    }

    /* ── Identification du compte ──────────────────────────────────────────
       Le jeton Supabase du compte est VÉRIFIÉ par le serveur d'authentification
       (/auth/v1/user) : le navigateur ne peut pas se faire passer pour un
       autre compte. Résultat mis en cache 60 s par jeton. */
    const USER_CACHE_MS = 60000;
    const userCache = new Map();

    async function verifyUser(request) {
        const auth = request.headers.get('authorization') || '';
        const m = /^Bearer\s+(.+)$/i.exec(auth);
        const token = m ? m[1].trim() : '';
        if (!token) return null;
        /* La clé anonyme publique n'identifie personne : on ne va pas
           interroger le serveur d'auth pour rien. */
        if (tokenRole(token) !== 'authenticated') return null;
        if (!supaUrl || !svcKey) return null;
        const t = now();
        const hit = userCache.get(token);
        if (hit && t - hit.at < USER_CACHE_MS) return hit.user;
        let user = null;
        try {
            const res = await doFetch(supaUrl + '/auth/v1/user', {
                headers: {
                    apikey: svcKey,
                    Authorization: 'Bearer ' + token,
                    Accept: 'application/json'
                }
            });
            if (res && res.ok) {
                const u = await res.json();
                if (u && u.id) user = { id: String(u.id), email: String(u.email || '').toLowerCase() };
            } else {
                log('jwt-status', res && res.status);
            }
        } catch (e) {
            log('jwt-lecture', (e && e.message) || 'erreur');
        }
        userCache.set(token, { user: user, at: t });
        if (userCache.size > 400) userCache.clear();
        return user;
    }

    /** Appelle la fonction SQL de consommation atomique. Renvoie null si la
        base est injoignable (on retombe alors sur le compteur mémoire). */
    async function dbConsume(user, kind, units, globalLimit) {
        if (!supaUrl || !svcKey || !user) return null;
        try {
            const res = await doFetch(supaUrl + '/rest/v1/rpc/consume_quota', {
                method: 'POST',
                headers: {
                    apikey: svcKey,
                    Authorization: 'Bearer ' + svcKey,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    p_user: user.id,
                    p_email: user.email || '',
                    p_kind: kind,
                    p_units: units,
                    p_global: globalLimit || 0
                })
            });
            if (!res || !res.ok) { log('quota-rpc-status', res && res.status); return null; }
            return await res.json();
        } catch (e) {
            log('quota-rpc', (e && e.message) || 'erreur');
            return null;
        }
    }

    async function dbRefund(user, kind, units) {
        if (!supaUrl || !svcKey || !user) return;
        try {
            await doFetch(supaUrl + '/rest/v1/rpc/refund_quota', {
                method: 'POST',
                headers: {
                    apikey: svcKey,
                    Authorization: 'Bearer ' + svcKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ p_user: user.id, p_kind: kind, p_units: units })
            });
        } catch (e) { log('quota-remboursement', (e && e.message) || 'erreur'); }
    }

    async function dbQuotaState(user) {
        if (!supaUrl || !svcKey || !user) return null;
        try {
            const res = await doFetch(supaUrl + '/rest/v1/rpc/get_quota', {
                method: 'POST',
                headers: {
                    apikey: svcKey,
                    Authorization: 'Bearer ' + svcKey,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({ p_user: user.id, p_email: user.email || '' })
            });
            if (!res || !res.ok) return null;
            return await res.json();
        } catch (e) { return null; }
    }

    function cors(origin) {
        const allowed = !origin || allowedOrigins.length === 0 || allowedOrigins.indexOf(origin) !== -1;
        const headers = {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-lsv-visitor',
            'Access-Control-Max-Age': '86400',
            'Vary': 'Origin',
            'Cache-Control': 'no-store'
        };
        if (allowed) headers['Access-Control-Allow-Origin'] = origin || '*';
        return { allowed, headers };
    }

    function json(status, message, headers) {
        return new Response(JSON.stringify({ error: { message } }), {
            status,
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
        });
    }

    function okJson(payload, headers) {
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
        });
    }

    /** En-têtes de quota renvoyés avec CHAQUE réponse : le frontend met à jour
        son compteur « images restantes » sans appel supplémentaire. */
    function quotaHeaders(state) {
        const h = {};
        if (!state) return h;
        const put = (name, val) => { if (val !== undefined && val !== null) h[name] = String(val); };
        put('x-lsv-quota-image', state.image);
        put('x-lsv-quota-video', state.video);
        put('x-lsv-quota-chat', state.chat);
        put('x-lsv-quota-motion', state.motion);
        put('x-lsv-quota-global', state.global);
        if (state.suspended) h['x-lsv-quota'] = 'suspended';
        return h;
    }

    return async function handle(request) {
        const origin = request.headers.get('origin') || '';
        const c = cors(origin);

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.headers });
        if (!c.allowed) return json(403, MSG_FORBIDDEN, c.headers);

        const url = new URL(request.url);
        const path = subPath(url.pathname);

        /* ── État des quotas du compte (affichage « il te reste 4 images ») ── */
        if (path === '/v1/quota') {
            const user = await verifyUser(request);
            const map = await allSettings();
            const enabled = map.quota_enabled === undefined ? true : map.quota_enabled === '1';
            const suspended = map.quota_suspended === '1';
            if (!user) return okJson({ enabled: enabled, suspended: suspended, anonymous: true }, c.headers);
            const state = await dbQuotaState(user);
            if (!state) return okJson({ enabled: enabled, suspended: suspended }, c.headers);
            return okJson(state, c.headers);
        }

        const isProxy = path === '/v1' || path.startsWith('/v1/') || path.startsWith('/agnesapi');
        if (!isProxy) return json(404, MSG_NOT_FOUND, c.headers);

        /* Clé dédiée à l'outil concerné (images / vidéos / chat), avec repli
           sur la clé partagée puis sur le secret serveur. */
        const agnesKey = await resolveKey(keyKind(path, request.method));
        if (!agnesKey) {
            log('clé du fournisseur absente (back-office ou secret serveur)');
            return json(503, MSG_NO_KEY, c.headers);
        }

        const ip = clientIp(request);
        const visitor = (request.headers.get('x-lsv-visitor') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
        const t = now();

        /* ── 1. Débit (fenêtre glissante par IP et par visiteur) ─────────── */
        const windowKeys = [];
        if (ip) windowKeys.push('ip:' + ip);
        if (visitor) windowKeys.push('vis:' + visitor);
        for (const k of windowKeys) {
            const r = store.allowWindow(k, ratePerMin, 60000, t);
            if (!r.ok) {
                log('rate-limit', k);
                return json(429, MSG_LIMIT, Object.assign({ 'Retry-After': String(r.retryAfter) }, c.headers));
            }
        }

        /* ── 2. Interruption d'urgence (réglée dans le back-office) ──────── */
        const map = await allSettings();
        const enabled = map.quota_enabled === undefined ? true : map.quota_enabled === '1';
        const suspended = map.quota_suspended === '1';
        if (suspended) {
            log('generations-suspendues');
            return json(503, MSG_SUSPENDED, Object.assign({ 'x-lsv-quota': 'suspended' }, c.headers));
        }

        /* ── 3. Identification du compte ─────────────────────────────────── */
        const user = await verifyUser(request);

        /* ── 4. Corps de la requête (lu avant de classer : la taille d'image
              détermine le nombre d'unités consommées) ───────────────────── */
        let body = null;
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            try {
                body = await request.text();
            } catch (e) {
                log('body-illisible', (e && e.message) || '');
                return json(400, MSG_UPSTREAM, c.headers);
            }
            if (body && body.length > maxBodyBytes) return json(413, MSG_LIMIT, c.headers);
        }

        const type = classifyRequest(path, request.method);
        const units = type ? requestUnits(type, body) : 0;

        /* ── 5. Quotas journaliers par compte ────────────────────────────── */
        let quotaState = null;
        let consumed = false;
        const quotaKey = user ? 'usr:' + user.id + ':' + type : 'vis:' + (visitor || ip || 'anon') + ':' + type;

        if (type && enabled) {
            /* Un seul compte ne peut pas avoir plus de N générations en vol :
               sinon il pourrait dépasser son quota entre deux verrous. */
            if (user && !store.enter('inflight:' + user.id, maxConcurrent)) {
                log('concurrence', user.id);
                return json(429, MSG_LIMIT, Object.assign({ 'Retry-After': '5' }, c.headers));
            }

            const globalLimit = toInt(map.quota_global_daily, envGlobal);
            let allowed = true;
            let exhaustedScope = 'user';

            if (user) {
                const r = await dbConsume(user, type, units, globalLimit);
                if (r && r.ok === false) {
                    allowed = false;
                    exhaustedScope = r.scope === 'global' ? 'global' : 'user';
                    log('quota-atteint', type, r.scope, r.used + '/' + r.limit);
                } else if (r && r.ok === true) {
                    consumed = true;
                    quotaState = {
                        image: type === 'image' ? r.remaining : undefined,
                        video: type === 'video' ? r.remaining : undefined,
                        chat: type === 'chat' ? r.remaining : undefined,
                        motion: type === 'motion' ? r.remaining : undefined,
                        global: r.remaining != null && globalLimit > 0 ? r.remaining : undefined
                    };
                } else {
                    /* Base injoignable : repli sur le compteur mémoire. */
                    const limit = limitFrom(map, type, false);
                    if (limit > 0) {
                        const mr = store.consumeDaily(type + ':' + user.id, limit, t);
                        if (!mr.ok) { allowed = false; exhaustedScope = 'user'; }
                        else consumed = true;
                    }
                    if (globalLimit > 0) {
                        const gr = store.consumeDaily('global:' + user.id, globalLimit, t);
                        if (!gr.ok) { allowed = false; exhaustedScope = 'global'; }
                    }
                }
            } else {
                /* Visiteur non connecté : quota strictement personnel, mais sans
                   base de données — compteur mémoire par IP/visiteur. */
                const limit = limitFrom(map, type, false);
                if (limit > 0) {
                    const mr = store.consumeDaily(type + ':' + (visitor || ip || 'anon'), limit, t);
                    if (!mr.ok) { allowed = false; exhaustedScope = 'user'; }
                    else consumed = true;
                }
                if (globalLimit > 0) {
                    const gr = store.consumeDaily('global:anon', globalLimit, t);
                    if (!gr.ok) { allowed = false; exhaustedScope = 'global'; }
                }
            }

            if (!allowed) {
                if (user) store.leave('inflight:' + user.id);
                const hdrs = Object.assign({ 'x-lsv-quota': 'exhausted', 'x-lsv-quota-scope': exhaustedScope }, c.headers);
                return json(429, MSG_QUOTA, hdrs);
            }
        }

        /* ── 6. Image de référence : URL de bibliothèque → image encodée ────
              Un fichier choisi sur l'appareil arrive déjà encodé (data:…) et
              traverse ce bloc sans y être touché. Une création reprise de la
              bibliothèque n'est qu'une URL : le navigateur ne pourrait pas la
              récupérer (CORS), donc on la télécharge ici. ───────────────── */
        if (type === 'video' && body) {
            const media = await resolveVideoRefs(body, doFetch);
            if (!media.ok) {
                log('media-injoignable', media.reason, String(media.detail || ''));
                if (consumed && user) await dbRefund(user, type, units);
                if (user && type && enabled) store.leave('inflight:' + user.id);
                return json(400, MSG_MEDIA, c.headers);
            }
            if (media.converted) body = media.body;
        }

        const fwdHeaders = {
            /* La clé Agnes est injectée ICI, côté serveur. Aucune authorization
               du client n'est transmise. */
            'Authorization': 'Bearer ' + agnesKey,
            'Content-Type': request.headers.get('content-type') || 'application/json',
            'Accept': request.headers.get('accept') || 'application/json'
        };

        let res;
        try {
            res = await doFetch(agnesBase + path + url.search, {
                method: request.method,
                headers: fwdHeaders,
                body: body || undefined
            });
        } catch (e) {
            log('amont-reseau', (e && e.message) || 'erreur');
            /* La requête n'a JAMAIS atteint le fournisseur : le quota revient. */
            if (consumed && user) await dbRefund(user, type, units);
            if (user && type && enabled) store.leave('inflight:' + user.id);
            return json(502, MSG_UPSTREAM, c.headers);
        }

        if (user && type && enabled) store.leave('inflight:' + user.id);

        if (res.ok) {
            const headers = Object.assign({}, c.headers, quotaHeaders(quotaState));
            const ct = res.headers && res.headers.get && res.headers.get('content-type');
            if (ct) headers['Content-Type'] = ct;
            return new Response(res.body, { status: res.status, headers });
        }

        /* Erreur amont : le corps n'est JAMAIS renvoyé au client (il peut
           contenir endpoint, modèles, détails d'authentification). Seul un
           message générique est retourné ; le détail part dans les logs. */
        let snippet = '';
        try { snippet = (await res.text()).slice(0, 300); } catch (e) {}
        log('amont-status', res.status, path, snippet);

        /* Aucune génération n'a été lancée : on rembourse les unités. */
        if (consumed && user) await dbRefund(user, type, units);

        const safeStatus = (res.status === 400 || res.status === 429 || res.status === 503) ? res.status : 502;
        const message = res.status === 429 ? MSG_LIMIT : MSG_UPSTREAM;
        return json(safeStatus, message, c.headers);
    };
}
