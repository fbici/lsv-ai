/* ═══════════════════════════════════════════════════════════════════════════
   LSV.ai — Module Analytics (indépendant, non critique)
   ───────────────────────────────────────────────────────────────────────────
   Règles :
   - N'EXPÉDIE JAMAIS de données privées (prompts, images, vidéos, conversations,
     clés API, URL de résultats).
   - Identifiant visiteur/anonyme aléatoire, non lié à une personne.
   - Asynchrone, non bloquant, tolérant aux pannes : toute erreur interne est
     absorbée. Si Analytics est indisponible, LSV.ai continue de fonctionner.
   - Aucun framework : fetch + file d'attente locale.

   API :
     LSVAnalytics.track('image_generated', { model: '...', ratio: '9:16' })
     LSVAnalytics.flush()
     LSVAnalytics.isConfigured()
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var STORAGE_VISITOR = 'lsv_an_vid';
    var STORAGE_QUEUE = 'lsv_an_q';
    var SESSION_KEY = 'lsv_an_sid';
    var SESSION_TOUCH = 'lsv_an_touch';

    var SESSION_TTL_MS = 30 * 60 * 1000;   // 30 min d'inactivité = nouvelle session
    var FLUSH_DELAY_MS = 3000;
    var MAX_BATCH = 25;
    var MAX_QUEUE = 60;
    var MAX_ATTEMPTS = 3;

    /* ── Identifiants anonymes ──────────────────────────────────────────── */
    function randomId() {
        var rnd = '';
        try {
            if (window.crypto && window.crypto.getRandomValues) {
                var arr = new Uint8Array(12);
                window.crypto.getRandomValues(arr);
                for (var i = 0; i < arr.length; i++) rnd += ('0' + arr[i].toString(16)).slice(-2);
                return Date.now().toString(36) + '_' + rnd;
            }
        } catch (e) {}
        return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
    }

    function safeGet(store, key) {
        try { return store.getItem(key); } catch (e) { return null; }
    }
    function safeSet(store, key, value) {
        try { store.setItem(key, value); } catch (e) {}
    }

    function visitorId() {
        var id = safeGet(window.localStorage, STORAGE_VISITOR);
        if (!id) { id = randomId(); safeSet(window.localStorage, STORAGE_VISITOR, id); }
        return id;
    }

    function sessionId() {
        var now = Date.now();
        var sid = safeGet(window.sessionStorage, SESSION_KEY);
        var touch = parseInt(safeGet(window.sessionStorage, SESSION_TOUCH) || '0', 10);
        if (!sid || !touch || (now - touch) > SESSION_TTL_MS) {
            sid = randomId();
            safeSet(window.sessionStorage, SESSION_KEY, sid);
        }
        safeSet(window.sessionStorage, SESSION_TOUCH, String(now));
        return sid;
    }

    /* ── Configuration ──────────────────────────────────────────────────── */
    var cfg = { url: '', key: '' };

    function readConfig() {
        try {
            var c = window.LSV_CONFIG || {};
            cfg.url = String(c.SUPABASE_URL || '').replace(/\/+$/, '');
            cfg.key = String(c.SUPABASE_ANON_KEY || '');
        } catch (e) { cfg.url = ''; cfg.key = ''; }
    }

    function isConfigured() {
        return !!(cfg.url && cfg.key &&
            cfg.url.indexOf('YOUR_PROJECT_REF') === -1 &&
            cfg.key.indexOf('YOUR_SUPABASE_ANON_KEY') === -1);
    }

    /* ── Assainissement des propriétés (aucune donnée sensible) ─────────── */
    var FORBIDDEN_KEY = /(prompt|token|secret|passw|authoriz|api_?key|bearer|credential|b64|base64|private|conversation|message|filename|datauri|data_uri)/i;
    var SENSITIVE_VALUE = /(sk-[A-Za-z0-9_\-]{8,}|Bearer\s+[A-Za-z0-9._\-]+|eyJ[A-Za-z0-9._\-]{20,})/;

    function cleanValue(value, depth) {
        if (value === null || value === undefined) return null;
        var t = typeof value;
        if (t === 'number') return isFinite(value) ? value : null;
        if (t === 'boolean') return value;
        if (t === 'string') {
            var s = value.replace(SENSITIVE_VALUE, '[redacted]');
            return s.length > 200 ? s.slice(0, 200) + '…' : s;
        }
        if (depth < 1 && Array.isArray(value)) {
            return value.slice(0, 10).map(function (v) { return cleanValue(v, depth + 1); });
        }
        if (depth < 1 && t === 'object') return cleanProps(value, depth + 1);
        return null;
    }

    function cleanProps(props, depth) {
        var out = {}, n = 0;
        if (!props || typeof props !== 'object') return out;
        for (var k in props) {
            if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
            if (n >= 20) break;
            if (FORBIDDEN_KEY.test(k)) continue;
            var v = cleanValue(props[k], depth || 0);
            if (v === null) continue;
            out[k.slice(0, 40)] = v;
            n++;
        }
        return out;
    }

    /* ── File d'attente locale (survit si le réseau tombe) ──────────────── */
    function loadQueue() {
        try {
            var raw = safeGet(window.localStorage, STORAGE_QUEUE);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function saveQueue(q) {
        try {
            if (q.length > MAX_QUEUE) q = q.slice(q.length - MAX_QUEUE);
            safeSet(window.localStorage, STORAGE_QUEUE, JSON.stringify(q));
        } catch (e) {}
    }

    var queue = loadQueue();
    var flushing = false;
    var timer = null;

    function scheduleFlush() {
        if (timer) return;
        timer = setTimeout(function () { timer = null; flush(); }, FLUSH_DELAY_MS);
    }

    function flush() {
        if (flushing || !isConfigured() || !queue.length) return;
        flushing = true;
        var batch = queue.slice(0, MAX_BATCH);
        var body;
        try { body = JSON.stringify(batch.map(function (e) { return e.row; })); }
        catch (e) { flushing = false; queue = []; saveQueue(queue); return; }

        var done = function (ok) {
            flushing = false;
            if (ok) {
                queue = queue.slice(batch.length);
            } else {
                queue = queue.map(function (e, i) {
                    if (i < batch.length) { e.tries = (e.tries || 0) + 1; }
                    return e;
                }).filter(function (e) { return (e.tries || 0) <= MAX_ATTEMPTS; });
            }
            saveQueue(queue);
            if (queue.length) scheduleFlush();
        };

        try {
            fetch(cfg.url + '/rest/v1/analytics_events', {
                method: 'POST',
                headers: {
                    'apikey': cfg.key,
                    'Authorization': 'Bearer ' + cfg.key,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: body,
                keepalive: true,
                mode: 'cors'
            }).then(function (res) { done(res && res.status < 300); })
              .catch(function () { done(false); });
        } catch (e) { done(false); }
    }

    /* ── API publique ───────────────────────────────────────────────────── */
    function track(event, props) {
        try {
            if (!event || typeof event !== 'string') return;
            readConfig();
            if (!isConfigured()) return;
            var row = {
                event: event.slice(0, 40),
                visitor_id: visitorId(),
                session_id: sessionId(),
                created_at: new Date().toISOString(),
                props: cleanProps(props, 0)
            };
            queue.push({ row: row, tries: 0 });
            if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
            saveQueue(queue);
            scheduleFlush();
        } catch (e) { /* Analytics ne doit jamais casser LSV.ai */ }
    }

    function pageView() {
        track('page_view', {
            path: (location.pathname || '/').slice(0, 120),
            lang: (navigator.language || '').slice(0, 10),
            mobile: window.matchMedia ? window.matchMedia('(max-width: 860px)').matches : false
        });
    }

    /* ── Démarrage ──────────────────────────────────────────────────────── */
    try {
        readConfig();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { readConfig(); pageView(); flush(); });
        } else {
            pageView();
        }
        window.addEventListener('pagehide', function () { flush(); });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') flush();
        });
        setInterval(function () { if (queue.length) flush(); }, 30000);
    } catch (e) {}

    window.LSVAnalytics = {
        track: track,
        flush: flush,
        isConfigured: isConfigured,
        visitorId: visitorId,
        version: '1.0.0'
    };
})();
