/* ═══════════════════════════════════════════════════════════════════════════
   LSV API Gateway — cœur de la passerelle (indépendant de la plateforme)
   ───────────────────────────────────────────────────────────────────────────
   Rôle :
     - reçoit les requêtes du frontend LSV.ai (GitHub Pages) ;
     - injecte la clé Agnes lue UNIQUEMENT côté serveur (env AGNES_API_KEY) ;
     - retire toute authorization envoyée par le client ;
     - applique rate limit + quotas journaliers configurables (IMAGE_LIMIT,
       VIDEO_LIMIT, CHAT_LIMIT, MOTION_LIMIT — 0 = illimité) ;
     - ne transmet JAMAIS le détail des erreurs amont au navigateur.

   Exécuté par Supabase Edge Functions (Deno) via index.ts.
   Testable sous Node : tests/gateway.test.mjs
   ═══════════════════════════════════════════════════════════════════════════ */

const MSG_UPSTREAM = 'Impossible de g\u00e9n\u00e9rer le contenu pour le moment. Veuillez r\u00e9essayer dans quelques instants.';
const MSG_LIMIT = 'Vous avez atteint la limite temporaire de g\u00e9n\u00e9ration. Veuillez patienter avant de r\u00e9essayer.';
const MSG_NOT_FOUND = 'Ressource indisponible.';
const MSG_FORBIDDEN = 'Acc\u00e8s non autoris\u00e9.';
const MSG_NO_KEY = 'Service momentan\u00e9ment indisponible.';

const DEFAULT_AGNES_BASE = 'https://apihub.agnes-ai.com';
const FUNCTION_MOUNT = '/functions/v1/lsv-gateway';
const SHORT_MOUNT = '/lsv-gateway';

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

/** Store mémoire (fenêtre glissante + compteurs journaliers).
    Réinitialisé à chaque froid de l'isolate — suffisant pour de la
    protection anti-abus ; remplaçable par un store Supabase plus tard. */
export function createMemoryStore(maxEntries = 5000) {
    const windows = new Map();
    const counters = new Map();
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
        reset() { windows.clear(); counters.clear(); }
    };
}

export function createHandler(options = {}) {
    const env = options.env || {};
    const doFetch = options.fetchImpl || ((input, init) => globalThis.fetch(input, init));
    const store = options.store || createMemoryStore();
    const now = options.now || (() => Date.now());
    const log = options.log || ((...args) => console.error('[lsv-gateway]', ...args));

    const agnesBase = (env.AGNES_API_BASE || DEFAULT_AGNES_BASE).replace(/\/+$/, '');
    const agnesKey = (env.AGNES_API_KEY || '').trim();
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const ratePerMin = toInt(env.RATE_LIMIT_PER_MIN, 10);
    const limits = {
        image: toInt(env.IMAGE_LIMIT, 0),
        video: toInt(env.VIDEO_LIMIT, 0),
        chat: toInt(env.CHAT_LIMIT, 0),
        motion: toInt(env.MOTION_LIMIT, 0)
    };
    const maxBodyBytes = toInt(env.MAX_BODY_BYTES, 20 * 1024 * 1024);

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

    return async function handle(request) {
        const origin = request.headers.get('origin') || '';
        const c = cors(origin);

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.headers });
        if (!c.allowed) return json(403, MSG_FORBIDDEN, c.headers);

        const url = new URL(request.url);
        const path = subPath(url.pathname);

        const isProxy = path === '/v1' || path.startsWith('/v1/') || path.startsWith('/agnesapi');
        if (!isProxy) return json(404, MSG_NOT_FOUND, c.headers);

        if (!agnesKey) {
            log('AGNES_API_KEY absente du secrets de la fonction');
            return json(503, MSG_NO_KEY, c.headers);
        }

        const ip = clientIp(request);
        const visitor = (request.headers.get('x-lsv-visitor') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
        const t = now();

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

        const type = classifyRequest(path, request.method);
        if (type && limits[type] > 0) {
            const r = store.consumeDaily(type + ':' + (visitor || ip || 'anon'), limits[type], t);
            if (!r.ok) {
                log('quota-atteint', type, r.used);
                return json(429, MSG_LIMIT, c.headers);
            }
        }

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
            return json(502, MSG_UPSTREAM, c.headers);
        }

        if (res.ok) {
            const headers = Object.assign({}, c.headers);
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

        const safeStatus = (res.status === 400 || res.status === 429 || res.status === 503) ? res.status : 502;
        const message = res.status === 429 ? MSG_LIMIT : MSG_UPSTREAM;
        return json(safeStatus, message, c.headers);
    };
}
