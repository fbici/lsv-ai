/* ═══════════════════════════════════════════════════════════════════════════
   LSV Contact — logique métier de la Edge Function d'envoi d'e-mails
   ───────────────────────────────────────────────────────────────────────────
   Deux canaux, deux destinataires :
     • "founder" → salaousouleyman@gmail.com  (page a-propos : collaboration,
       prestations, projets)
     • "site"    → lestudioviral@gmail.com    (page contact : support LSV.ai)

   Parcours d'une requête :
     1. validation stricte du payload ;
     2. pot de miel (champ piège rempli par les robots) → accusé de réception
        silencieux, aucun e-mail ;
     3. rate limit en mémoire par IP (3/min, 20/jour) ;
     4. insertion en base via la RPC `submit_contact` (rate limit IP + e-mail
        sur 1 h, persistant entre les isolates) ;
     5. envoi d'un e-mail de notification, puis d'un accusé de réception à
        l'expéditeur (best effort).

   Le message est TOUJOURS enregistré en base : même si le fournisseur
   d'envoi est absent ou en panne, rien n'est perdu (table contact_messages).

   La logique est dans ce fichier .mjs pour être testable sous Node :
   tests/contact.test.mjs l'importe comme la gateway.
   ═══════════════════════════════════════════════════════════════════════════ */

import { notificationHtml, notificationText, autoReplyHtml, autoReplyText } from './templates.mjs';

/* ── Canaux ─────────────────────────────────────────────────────────────── */
export const CHANNELS = Object.freeze({
    founder: Object.freeze({
        to: 'salaousouleyman@gmail.com',
        toName: 'Salaou Souleyman',
        prefix: '[a-propos] ',
        label: 'Salaou Souleyman — page À propos'
    }),
    site: Object.freeze({
        to: 'lestudioviral@gmail.com',
        toName: 'LeStudioViral',
        prefix: '[LSV.ai] ',
        label: 'LeStudioViral — page Contact'
    })
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LIMITS = Object.freeze({ name: [2, 120], email: [5, 200], subject: [3, 160], body: [10, 4000] });

function toInt(v, dflt) {
    const n = parseInt(String(v == null ? '' : v).trim(), 10);
    return Number.isFinite(n) ? n : dflt;
}

/* Store en mémoire isolé à la fonction : fenêtre glissante + compteur
   journalier. Réinitialisé à chaque froid d'isolate (protection de premier
   niveau) ; la vérité persistante est en base (RPC `submit_contact`). */
export function createMemoryStore(maxEntries = 2000) {
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

function str(v, max) {
    /* Normalise sans jamais faire échouer la validation : CRLF → LF, espace
       autour, puis troncature au max. */
    return String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/\s+$/, '').trim().slice(0, max);
}

function inRange(s, range) { return s.length >= range[0] && s.length <= range[1]; }

/* ── Validation ─────────────────────────────────────────────────────────── */
/* Renvoie { ok, reason?, data?, ignored? }.
   `ignored: true` signifie « robot silencieusement ignoré » : on répond
   ok:true pour ne pas alerter le bot, mais rien n'est ni stocké ni envoyé. */
export function validate(payload, now) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, reason: 'invalid' };
    }

    /* Pot de miel : champ que les humains ne remplissent jamais. */
    const honeypot = str(payload.website, 400);
    if (honeypot) return { ok: true, ignored: true };

    /* Anti-bot à base de temps : le formulaire affiche au moins 3 s avant
       d'être soumissible. Un robot qui envoie JSON brut n'envoie pas t0. */
    const t0 = Number(payload.t0);
    if (Number.isFinite(t0) && t0 > 0 && now - t0 < 3000) return { ok: true, ignored: true };

    const channel = str(payload.channel, 20);
    if (!Object.prototype.hasOwnProperty.call(CHANNELS, channel)) {
        return { ok: false, reason: 'channel' };
    }

    const data = {
        channel: channel,
        name: str(payload.name, LIMITS.name[1]),
        email: str(payload.email, LIMITS.email[1]).toLowerCase(),
        subject: str(payload.subject, LIMITS.subject[1]),
        body: str(payload.message != null ? payload.message : payload.body, LIMITS.body[1])
    };

    if (!inRange(data.name, LIMITS.name)) return { ok: false, reason: 'invalid' };
    if (!inRange(data.email, LIMITS.email) || !EMAIL_RE.test(data.email)) return { ok: false, reason: 'invalid' };
    if (!inRange(data.subject, LIMITS.subject)) return { ok: false, reason: 'invalid' };
    if (!inRange(data.body, LIMITS.body)) return { ok: false, reason: 'invalid' };

    return { ok: true, data: data };
}

/* ── Fournisseur d'envoi ────────────────────────────────────────────────── */
/* Deux adaptateurs HTTP, sans dépendance : Brevo (SMTP Brevo documenté dans
   le README) et Resend. EMAIL_FROM au format « Nom <adresse@domaine> ». */
function splitFrom(from) {
    const m = String(from).match(/^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/);
    if (m) return { name: m[1].replace(/^"|"$/g, '') || 'LSV.ai', email: m[2] };
    return { name: 'LSV.ai', email: String(from).trim() };
}

export async function sendEmail(opts) {
    const { env, fetchImpl, to, toName, replyTo, subject, html, text } = opts;
    const provider = String(env.EMAIL_PROVIDER || '').trim().toLowerCase();
    const key = String(env.EMAIL_API_KEY || '').trim();
    const from = String(env.EMAIL_FROM || 'LSV.ai <no-reply@lestudioviral.com>');

    if (!provider || !key) return { ok: false, reason: 'not-configured' };

    let res;
    try {
        if (provider === 'brevo') {
            const f = splitFrom(from);
            res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({
                    sender: { name: f.name, email: f.email },
                    to: [{ name: toName, email: to }],
                    ...(replyTo ? { replyTo: { email: replyTo } } : {}),
                    subject: subject,
                    htmlContent: html,
                    textContent: text
                })
            });
        } else if (provider === 'resend') {
            res = await fetchImpl('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
                body: JSON.stringify({
                    from: from,
                    to: [to],
                    ...(replyTo ? { reply_to: replyTo } : {}),
                    subject: subject,
                    html: html,
                    text: text
                })
            });
        } else {
            return { ok: false, reason: 'not-configured' };
        }
    } catch (e) {
        return { ok: false, reason: 'network', detail: String((e && e.message) || e) };
    }

    if (!res || !res.ok) {
        const status = res ? res.status : 0;
        let body = '';
        try { body = await res.text(); } catch (e) { /* corps illisible */ }
        /* On ne remonte JAMAIS la réponse du fournisseur au client. */
        return { ok: false, reason: 'provider', detail: status + ' ' + body.slice(0, 300) };
    }
    return { ok: true };
}

/* ── Base de données ────────────────────────────────────────────────────── */
/* Insère + rate limit persistant via la RPC `submit_contact`. */
async function callRpc(opts) {
    const { env, fetchImpl, body } = opts;
    const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/rpc/submit_contact';
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
                'content-type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.text()).slice(0, 300); } catch (e) {}
            return { ok: false, reason: 'storage', detail: res.status + ' ' + detail };
        }
        const json = await res.json();
        if (!json || json.ok !== true) return { ok: false, reason: (json && json.reason) || 'storage' };
        return { ok: true, id: json.id };
    } catch (e) {
        return { ok: false, reason: 'storage', detail: String((e && e.message) || e) };
    }
}

/* Mise à jour best effort de l'issue de l'envoi (diagnostic côté SQL). */
async function markMessage(opts) {
    const { env, fetchImpl, id, status, error } = opts;
    if (!id) return;
    const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
    try {
        await fetchImpl(base + '/rest/v1/contact_messages?id=eq.' + encodeURIComponent(id) + '&select=id', {
            method: 'PATCH',
            headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
                'content-type': 'application/json',
                Prefer: 'return=minimal'
            },
            body: JSON.stringify({ status: status, error: String(error || '').slice(0, 300) })
        });
    } catch (e) { /* diagnostic seulement : jamais bloquant */ }
}

/* ── Handler ────────────────────────────────────────────────────────────── */
export function createHandler(options = {}) {
    const env = options.env || {};
    const doFetch = options.fetchImpl || ((input, init) => globalThis.fetch(input, init));
    const store = options.store || createMemoryStore();
    const now = options.now || (() => Date.now());
    const log = options.log || ((...args) => console.error('[lsv-contact]', ...args));
    const allowOrigin = options.allowOrigin || (() => '*');
    const ratePerMin = toInt(env.CONTACT_RATE_PER_MIN, 3);
    const ratePerDay = toInt(env.CONTACT_RATE_PER_DAY, 20);
    const autoReply = String(env.CONTACT_AUTO_REPLY || '1') !== '0';

    const json = (status, payload, extra) =>
        new Response(JSON.stringify(payload), {
            status: status,
            headers: Object.assign({
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store'
            }, extra || {})
        });

    return async function handler(request) {
        const origin = request.headers.get('origin') || '';
        const cors = {
            'access-control-allow-origin': allowOrigin(origin),
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
            'access-control-max-age': '86400',
            vary: 'Origin'
        };

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (request.method !== 'POST') {
            return json(405, { ok: false, reason: 'method' }, cors);
        }

        /* Taille du corps bornée avant toute lecture. */
        const declared = Number(request.headers.get('content-length') || 0);
        if (declared > 32 * 1024) return json(413, { ok: false, reason: 'size' }, cors);

        let payload = null;
        try {
            const text = await request.text();
            if (text.length > 32 * 1024) return json(413, { ok: false, reason: 'size' }, cors);
            payload = text ? JSON.parse(text) : null;
        } catch (e) {
            return json(400, { ok: false, reason: 'invalid' }, cors);
        }

        const ip = String(
            (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
            request.headers.get('x-real-ip') || 'inconnue'
        ).slice(0, 64);
        const t = now();

        const v = validate(payload, t);
        if (v.ignored) {
            /* Réponse identique à un succès : un bot ne peut pas distinguer. */
            return json(200, { ok: true }, cors);
        }
        if (!v.ok) return json(400, { ok: false, reason: v.reason }, cors);

        /* Rate limit mémoire : protège l'envoi avant même la base. */
        const perMin = store.allowWindow('contact:min:' + ip, ratePerMin, 60000, t);
        if (!perMin.ok) return json(429, { ok: false, reason: 'rate', retryAfter: perMin.retryAfter }, cors);
        const perDay = store.consumeDaily('contact:day:' + ip, ratePerDay, t);
        if (!perDay.ok) return json(429, { ok: false, reason: 'rate' }, cors);

        const channel = CHANNELS[v.data.channel];
        const subject = channel.prefix + v.data.subject;
        const context = {
            channel: v.data.channel,
            channelLabel: channel.label,
            name: v.data.name,
            email: v.data.email,
            subject: v.data.subject,
            body: v.data.body,
            receivedAt: new Date(t).toISOString()
        };

        /* 1. Enregistrement + rate limit persistant : C'EST LA PORTE D'ENTRÉE.
              Aucun e-mail ne part avant que la base ait accepté le message —
              sinon un bot pourrait faire consommer des envois puis se voir
              refuser. Le message est donc toujours journalisé. */
        const saved = await callRpc({
            env: env, fetchImpl: doFetch,
            body: {
                p_name: v.data.name,
                p_email: v.data.email,
                p_subject: v.data.subject,
                p_body: v.data.body,
                p_channel: v.data.channel,
                p_ip: ip,
                p_status: 'received',
                p_error: ''
            }
        });
        if (!saved.ok) {
            log('enregistrement impossible :', saved.reason, saved.detail || '');
            if (saved.reason === 'rate') return json(429, { ok: false, reason: 'rate' }, cors);
            /* Base injoignable : on tente quand même l'e-mail (le message
               serait livré sans journal). Échec des deux → 502 plus bas. */
        }

        /* 2. Notification au destinataire du canal (best effort). */
        let mail = { ok: false, reason: 'skipped' };
        try {
            mail = await sendEmail({
                env: env, fetchImpl: doFetch, channel: v.data.channel,
                to: channel.to, toName: channel.toName, replyTo: v.data.email,
                subject: subject,
                html: notificationHtml(context),
                text: notificationText(context)
            });
        } catch (e) {
            mail = { ok: false, reason: 'network', detail: String((e && e.message) || e) };
        }
        const sent = !!mail.ok;
        let mailError = '';
        if (!sent && mail.reason && mail.reason !== 'skipped') {
            mailError = mail.reason + (mail.detail ? ' — ' + mail.detail : '');
            log('notification non envoyée (' + v.data.channel + ') :', mailError);
        }

        /* 3. Diagnostic : on note dans la journal si l'notification est partie. */
        await markMessage({
            env: env, fetchImpl: doFetch, id: saved.id,
            status: sent ? 'sent' : (mail.reason === 'not-configured' ? 'unconfigured' : 'stored'),
            error: mailError
        });

        /* 4. Accusé de réception à l'expéditeur (best effort, jamais bloquant). */
        if (sent && autoReply) {
            try {
                await sendEmail({
                    env: env, fetchImpl: doFetch, channel: v.data.channel,
                    to: v.data.email, toName: v.data.name, replyTo: '',
                    subject: 'Bien reçu — ' + v.data.subject,
                    html: autoReplyHtml(context), text: autoReplyText(context)
                });
            } catch (e) {
                log('accusé de réception non envoyé :', String((e && e.message) || e));
            }
        }

        if (sent) return json(200, { ok: true }, cors);
        /* Le message est en base : réception acquittée, même si le courriel
           de notification a échoué ou n'est pas encore configuré. */
        if (saved.ok) return json(200, { ok: true, reason: 'stored' }, cors);
        /* Ni journal ni e-mail : on refuse plutôt que de simuler. */
        return json(502, { ok: false, reason: 'storage' }, cors);
    };
}
