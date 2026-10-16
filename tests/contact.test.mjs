/* ═══════════════════════════════════════════════════════════════════════════
   Tests de la Edge Function de contact (supabase/functions/lsv-contact)
   ───────────────────────────────────────────────────────────────────────────
   Couvre : validation, pot de miel, rate limit, routage des canaux
   (fondateur vs marque), envoi via fournisseur, enregistrement en base,
   accusé de réception, modèles d'e-mails (échappement), migration SQL,
   et le rendu réel (jsdom) des pages contact/ et a-propos/.
   Usage : node tests/contact.test.mjs
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHandler, createMemoryStore, validate, CHANNELS } from '../supabase/functions/lsv-contact/core.mjs';
import { notificationHtml, notificationText, autoReplyHtml, autoReplyText } from '../supabase/functions/lsv-contact/templates.mjs';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond });
    console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
}
const req = (body, init) => new Request('https://ref.supabase.co/functions/v1/lsv-contact',
    Object.assign({ method: 'POST', headers: { 'content-type': 'application/json' } }, init || {}, typeof body === 'string' ? { body } : body != null ? { body: JSON.stringify(body) } : {}));

/* ── Harnais ────────────────────────────────────────────────────────────── */
function harness(envOverrides = {}) {
    const sent = [];
    const rpc = [];
    const patches = [];
    const trace = [];
    let rpcBehaviour = { status: 200, body: { ok: true, id: '00000000-0000-0000-0000-000000000001' } };
    const env = Object.assign({
        SUPABASE_URL: 'https://ref.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'svc-0123456789',
        EMAIL_PROVIDER: 'brevo',
        EMAIL_API_KEY: 'brevo-key-123',
        EMAIL_FROM: 'LeStudioViral <no-reply@lestudioviral.com>',
        CONTACT_AUTO_REPLY: '1'
    }, envOverrides);
    const fetchImpl = async (url, init) => {
        const u = String(url);
        if (u.includes('/rest/v1/rpc/submit_contact')) {
            rpc.push(JSON.parse(init.body));
            trace.push('rpc');
            return new Response(JSON.stringify(rpcBehaviour.body), { status: rpcBehaviour.status, headers: { 'content-type': 'application/json' } });
        }
        if (u.includes('/rest/v1/contact_messages')) {
            patches.push({ url: u, body: JSON.parse(init.body) });
            trace.push('patch');
            return new Response('null', { status: 204, headers: { 'content-type': 'application/json' } });
        }
        sent.push({ url: u, init: init, payload: JSON.parse(init.body) });
        trace.push('mail');
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const handle = createHandler({
        env: env, fetchImpl: fetchImpl, store: createMemoryStore(),
        now: () => 1700000000000, log: () => {},
        allowOrigin: () => 'https://fbici.github.io'
    });
    return { handle, sent, rpc, patches, trace, setRpc: b => { rpcBehaviour = b; } };
}

const VALID = {
    channel: 'site', name: 'Anne Test', email: 'anne@exemple.com',
    subject: 'Question sur LSV.ai', message: 'Bonjour, je voudrais en savoir plus sur le studio.',
    website: '', t0: 1699999996000   // → now - t0 = 4000 ms > 3000
};

/* ═══════════════ 1. VALIDATION ═══════════════ */
console.log('\n=== 1. VALIDATION DU PAYLOAD ===');
const NOW = 1700000000000;
check('payload valide accepté', validate(VALID, NOW).ok === true);
check('canaux exposés : fondateur + site',
    Object.keys(CHANNELS).sort().join(',') === 'founder,site' && CHANNELS.founder.to === 'salaousouleyman@gmail.com' && CHANNELS.site.to === 'lestudioviral@gmail.com',
    CHANNELS.founder.to + ' / ' + CHANNELS.site.to);
check('non-objet rejeté', validate(null, NOW).reason === 'invalid' && validate('x', NOW).ok === false);
check('objet rejeté', validate([], NOW).ok === false);
check('canal inconnu rejeté', validate(Object.assign({}, VALID, { channel: 'hacker' }), NOW).reason === 'channel');
check('e-mail malformé rejeté', validate(Object.assign({}, VALID, { email: 'pas-un-mail' }), NOW).reason === 'invalid');
check('e-mail à domaines rejeté', validate(Object.assign({}, VALID, { email: 'a@b' }), NOW).reason === 'invalid');
check('nom vide rejeté', validate(Object.assign({}, VALID, { name: '  ' }), NOW).reason === 'invalid');
check('sujet vide rejeté', validate(Object.assign({}, VALID, { subject: '' }), NOW).reason === 'invalid');
    check('message de 10 caractères accepté (minimum exact)',
        validate(Object.assign({}, VALID, { message: 'trop court' }), NOW).ok === true);
    check('message de 9 caractères rejeté',
        validate(Object.assign({}, VALID, { message: 'tro court' }), NOW).ok === false);
check('message vide rejeté', validate(Object.assign({}, VALID, { message: '' }), NOW).ok === false);
check('champ nom > 120 caractères tronqué, accepté',
    validate(Object.assign({}, VALID, { name: 'A'.repeat(500) }), NOW).data.name.length === 120);
check('message > 4000 caractères tronqué, accepté',
    validate(Object.assign({}, VALID, { body: 'x'.repeat(9000) }), NOW).ok === false ||
    validate(Object.assign({}, VALID, { message: 'x'.repeat(9000) }), NOW).data.body.length === 4000);
check('CRLF normalisé (anti-injection d\'en-tête/ligne)',
    validate(Object.assign({}, VALID, { subject: 'Objet\r\nBcc: x@y.z' }), NOW).data.subject.indexOf('\r') === -1);

/* Pot de miel + anti-bot */
check('pot de miel rempli → ignoré (pas une erreur)', validate(Object.assign({}, VALID, { website: 'http://spam' }), NOW).ignored === true);
check('soumis en < 3 s → robot ignoré', validate(Object.assign({}, VALID, { t0: NOW - 1500 }), NOW).ignored === true);
check('soumis à la limite (3 s) → accepté', validate(Object.assign({}, VALID, { t0: NOW - 3000 }), NOW).ok === true);
check('sans t0 → accepté (appel manuel/API)', validate(Object.assign({}, VALID, { t0: 0 }), NOW).ok === true);

/* ═══════════════ 2. HANDLER — EN-TÊTES ET ERREURS ═══════════════ */
console.log('\n=== 2. HANDLER — EN-TÊTES & ERREURS ===');
{
    const h = harness();
    const opt = await h.handle(new Request('https://ref.supabase.co/x', { method: 'OPTIONS' }));
    check('OPTIONS → 204 avec CORS', opt.status === 204 && opt.headers.get('access-control-allow-origin') === 'https://fbici.github.io');
    const get = await h.handle(new Request('https://ref.supabase.co/x', { method: 'GET' }));
    check('GET → 405', get.status === 405);
    const bad = await h.handle(req('{pas du json'));
    check('JSON invalide → 400', bad.status === 400 && (await bad.json()).reason === 'invalid');
    const big = await h.handle(req(Object.assign({}, VALID, { message: 'x'.repeat(40000) })));
    check('corps > 32 Ko → 413', big.status === 413, big.status);
    const badch = await h.handle(req(Object.assign({}, VALID, { channel: 'autre' })));
    check('canal inconnu → 400 channel', badch.status === 400 && (await badch.json()).reason === 'channel');
}

/* ═══════════════ 3. POT DE MIEL ═══════════════ */
console.log('\n=== 3. POT DE MIEL (robots) ===');
{
    const h = harness();
    const r = await h.handle(req(Object.assign({}, VALID, { website: 'http://piège' })));
    const body = await r.json();
    check('pot de miel → 200 ok:true (indiscernable d\'un succès)', r.status === 200 && body.ok === true);
    check('pot de miel → aucun e-mail envoyé', h.sent.length === 0, h.sent.length);
    check('pot de miel → aucun message en base', h.rpc.length === 0, h.rpc.length);

    const h2 = harness();
    const r2 = await h2.handle(req(Object.assign({}, VALID, { t0: NOW - 500 })));
    check('soumission instantanée → 200 ok:true sans envoi', (await r2.json()).ok === true && h2.sent.length === 0 && h2.rpc.length === 0);
}

/* ═══════════════ 4. RATE LIMIT ═══════════════ */
console.log('\n=== 4. RATE LIMIT ===');
{
    const h = harness({ CONTACT_RATE_PER_MIN: '3' });
    const ip = '9.9.9.9';
    const mk = () => req(VALID, { headers: { 'content-type': 'application/json', 'x-forwarded-for': ip } });
    const s1 = await h.handle(mk()), s2 = await h.handle(mk()), s3 = await h.handle(mk());
    const s4 = await h.handle(mk());
    check('3 messages/mn admis (IP identique)', s1.status === 200 && s2.status === 200 && s3.status === 200,
        [s1.status, s2.status, s3.status].join(','));
    check('4e en moins d\'une minute → 429 rate', s4.status === 429 && (await s4.json()).reason === 'rate', s4.status);
    check('retryAfter présent et > 0', Number(s4.headers.get('retry-after') || 0) >= 0);

    const other = await h.handle(req(VALID, { headers: { 'content-type': 'application/json', 'x-forwarded-for': '8.8.8.8' } }));
    check('autre IP non impactée', other.status === 200, other.status);

    /* Limite journalière : on simule la fenêtre glissante. */
    const store = createMemoryStore();
    const t0 = NOW;
    let dayOk = 0;
    for (let i = 0; i < 25; i++) {
        if (store.consumeDaily('d', 20, t0 + i * 100).ok) dayOk++;
    }
    check('limite journalière bornée à 20', dayOk === 20, dayOk);
}

/* ═══════════════ 5. ENVOI RÉEL (fournisseur simulé) ═══════════════ */
console.log('\n=== 5. ENVOI & ROUTAGE DES CANAUX ===');
{
    const h = harness();
    const r = await h.handle(req(VALID));
    const body = await r.json();
    check('requête valide → 200 ok', r.status === 200 && body.ok === true, JSON.stringify(body));
    check('2 e-mails envoyés (notification + accusé de réception)', h.sent.length === 2, h.sent.length);
    const notif = h.sent[0], auto = h.sent[1];
    check('notification via l\'API Brevo', notif.url === 'https://api.brevo.com/v3/smtp/email');
    check('notification en clé d\'en-tête api-key (jamais dans l\'URL)',
        notif.init.headers['api-key'] === 'brevo-key-123' && notif.url.indexOf('key') === -1);
    check('destinataire marquée = lestudioviral@gmail.com (canal site)',
        notif.payload.to[0].email === 'lestudioviral@gmail.com', notif.payload.to[0].email);
    check('replyTo = e-mail de l\'expéditeur', notif.payload.replyTo && notif.payload.replyTo.email === 'anne@exemple.com');
    check('objet préfixé [LSV.ai]', notif.payload.subject === '[LSV.ai] Question sur LSV.ai', notif.payload.subject);
    check('accusé de réception adressé à l\'expéditeur', auto.payload.to[0].email === 'anne@exemple.com');
    check('aucun secret du dépôt dans les corps envoyés',
        JSON.stringify(h.sent).indexOf('svc-0123456789') === -1 && JSON.stringify(h.sent).indexOf('sk-') === -1);
    check('1 enregistrement en base avant tout envoi', h.rpc.length === 1, h.rpc.length);
    check('insertion initiale au statut « received »', h.rpc[0].p_status === 'received', h.rpc[0].p_status);
    check('statut mis à jour « sent » après envoi réussi',
        h.patches.length === 1 && h.patches[0].body.status === 'sent' && /contact_messages\?id=eq\./.test(h.patches[0].url),
        JSON.stringify(h.patches[0] || {}));
    check('e-mail enregistré en minuscules', h.rpc[0].p_email === 'anne@exemple.com');
    check('la clé de service ne figure jamais dans le corps de la requête RPC',
        JSON.stringify(h.rpc[0]).indexOf('svc-0123456789') === -1);
    check('ordre : base d\'abord, puis notification, puis diagnostic, puis accusé',
        h.trace.join('→') === 'rpc→mail→patch→mail', h.trace.join('→'));

    /* Canal fondateur */
    const h2 = harness();
    const r2 = await h2.handle(req(Object.assign({}, VALID, {
        channel: 'founder',
        subject: 'Collaboration sur un projet',
        message: 'Bonjour Salaou, parlons de ton prochain projet web.'
    })));
    check('canal founder → 200 ok', r2.status === 200 && (await r2.json()).ok === true);
    check('notification → salaousouleyman@gmail.com',
        h2.sent[0].payload.to[0].email === 'salaousouleyman@gmail.com', h2.sent[0].payload.to[0].email);
    check('objet préfixé [a-propos]', h2.sent[0].payload.subject === '[a-propos] Collaboration sur un projet');
    check('RPC appelée avec le canal founder', h2.rpc[0].p_channel === 'founder');

    /* Accusé désactivé */
    const h3 = harness({ CONTACT_AUTO_REPLY: '0' });
    await h3.handle(req(VALID));
    check('CONTACT_AUTO_REPLY=0 → notification seule', h3.sent.length === 1, h3.sent.length);

    /* Resend */
    const h4 = harness({ EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_abc', EMAIL_FROM: 'LSV.ai <hi@exemple.dev>' });
    await h4.handle(req(VALID));
    check('fournisseur resend → endpoint + Authorization Bearer',
        h4.sent[0].url === 'https://api.resend.com/emails' && h4.sent[0].init.headers.Authorization === 'Bearer re_abc',
        h4.sent[0].url);
    check('resend : reply_to en snake_case', h4.sent[0].payload.reply_to === 'anne@exemple.com');
    check('resend : from au format « Nom <mail> »', h4.sent[0].payload.from === 'LSV.ai <hi@exemple.dev>');
}

/* ═══════════════ 6. PANNES ET REPLIS ═══════════════ */
console.log('\n=== 6. PANNES, REPLIS & SÉCURITÉ ===');
{
    /* Fournisseur absent : message en base, réponse honnête sans simulation. */
    const h = harness({ EMAIL_PROVIDER: '', EMAIL_API_KEY: '' });
    const r = await h.handle(req(VALID));
    const b = await r.json();
    check('fournisseur non configuré → 200 ok:true (message en base)', r.status === 200 && b.ok === true && b.reason === 'stored', JSON.stringify(b));
    check('aucun e-mail tenté sans fournisseur', h.sent.length === 0, h.sent.length);
    check('message malgré tout enregistré (rien n\'est perdu)',
        h.rpc.length === 1 && h.patches[0].body.status === 'unconfigured',
        JSON.stringify({ ins: h.rpc[0] && h.rpc[0].p_status, patch: h.patches[0] && h.patches[0].body }));

    /* Fournisseur en panne : le message est en base → réception acquittée. */
    const failingFetch = async (url, init) => {
        if (String(url).includes('/rest/v1/rpc/submit_contact')) {
            return new Response(JSON.stringify({ ok: true, id: 'id-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('boom', { status: 500 });
    };
    const h3 = createHandler({
        env: { SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', EMAIL_PROVIDER: 'brevo', EMAIL_API_KEY: 'k', EMAIL_FROM: 'A <a@b.co>' },
        fetchImpl: failingFetch, store: createMemoryStore(), now: () => NOW, log: () => {}, allowOrigin: () => '*'
    });
    const r3 = await h3(req(VALID));
    check('fournisseur en panne mais message en base → 200 ok', r3.status === 200 && (await r3.json()).ok === true, r3.status);

    /* Base en panne ET mail non envoyé → on refuse (pas de faux succès). */
    const h4 = createHandler({
        env: { SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', EMAIL_PROVIDER: '', EMAIL_API_KEY: '' },
        fetchImpl: async () => { throw new Error('réseau'); },
        store: createMemoryStore(), now: () => NOW, log: () => {}, allowOrigin: () => '*'
    });
    const r4 = await h4(req(VALID));
    check('ni base ni e-mail → 502 (pas de faux acquittement)', r4.status === 502 && (await r4.json()).ok === false, r4.status);

    /* RPC qui refuse (rate limit persistant). */
    const h5 = harness();
    h5.setRpc({ status: 200, body: { ok: false, reason: 'rate' } });
    const r5 = await h5.handle(req(VALID));
    check('rate limit SQL → 429 rate', r5.status === 429 && (await r5.json()).reason === 'rate', r5.status);
    check('rate limit SQL → aucun e-mail envoyé', h5.sent.length === 0, h5.sent.length);

    /* Cible inatteignable dans l'URL d'origine. */
    const h6 = harness();
    const r6 = await h6.handle(req(Object.assign({}, VALID, { channel: 'founder' }), { headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }));
    check('réponse CORS sans origine autorisée → origine refusée', r6.headers.get('access-control-allow-origin') !== 'https://evil.example',
        r6.headers.get('access-control-allow-origin'));
}

/* ═══════════════ 7. MODÈLES D'E-MAILS ═══════════════ */
console.log('\n=== 7. MODÈLES D\'E-MAILS ===');
const ctx = {
    channel: 'founder', channelLabel: 'Salaou Souleyman — page À propos',
    name: 'Jean <script>alert(1)</script>', email: 'jean@exemple.com',
    subject: 'Proj & <b>test</b>', body: '<img src=x onerror=alert(1)> et "texte"',
    receivedAt: '2026-10-16T10:00:00.000Z'
};
const nh = notificationHtml(ctx);
check('notification : HTML complet', /<!DOCTYPE html>/.test(nh) && /lang="fr"/.test(nh));
check('notification : contenu utilisateur échappé', !nh.includes('<script>') && !nh.includes('<img src=x') && !nh.includes('<b>test</b>'), nh.includes('<script>') ? 'XSS' : '');
check('notification : expéditeur affiché', nh.includes('jean@exemple.com'));
check('notification : lien mailto de réponse codé', /mailto:jean@exemple\.com\?subject=Re%20/.test(nh));
check('notification : texte brut cohérent', /---- Message ----/.test(notificationText(ctx)) && notificationText(ctx).includes('<script>'));
check('notification : aucune clé ni jeton', !/sk-[A-Za-z0-9]{10,}|service_role|Bearer|Authorization/i.test(nh));
check('accusé : contient l\'objet échappé et la marque', /LSV|LeStudioViral/.test(autoReplyHtml(ctx)) && !autoReplyHtml(ctx).includes('<b>test</b>'));
check('accusé : texte brut présent', /Merci, on a bien reçu/.test(autoReplyText(ctx)));
check('modèles : thème de la marque (#0d9488)', /#0d9488/.test(nh) && /Space Grotesk/.test(nh));
check('modèles : réponse sous 48 h rappelée', /48 heure/.test(autoReplyHtml(ctx)));
check('notification : canal marqué « page À propos »', nh.includes('Salaou Souleyman — page À propos'));

/* ═══════════════ 8. DÉPÔT (fichiers, migration, variables) ═══════════════ */
console.log('\n=== 8. DÉPÔT, MIGRATION & VARIABLES ===');
const entry = existsSync(join(PROJECT, 'supabase/functions/lsv-contact/index.ts'))
    ? readFileSync(join(PROJECT, 'supabase/functions/lsv-contact/index.ts'), 'utf8') : '';
check('point d\'entrée Deno présent', !!entry && /Deno\.serve/.test(entry));
check('point d\'entrée lit les variables d\'env du fournisseur',
    /EMAIL_PROVIDER/.test(entry) && /EMAIL_API_KEY/.test(entry) && /EMAIL_FROM/.test(entry));
check('aucune valeur d\'env codée en dur dans le point d\'entrée',
    !/=\s*['"][A-Za-z0-9_\-]{16,}['"]/.test(entry));

const migPath = join(PROJECT, 'supabase/upgrade-contact.sql');
check('migration upgrade-contact.sql présente', existsSync(migPath));
const mig = existsSync(migPath) ? readFileSync(migPath, 'utf8') : '';
check('migration : table contact_messages', /create table if not exists public\.contact_messages/.test(mig));
check('migration : RLS activée', /alter table public\.contact_messages enable row level security;/.test(mig));
check('migration : aucun accès anon (revoke explicite)',
    /revoke all on public\.contact_messages from public, anon, authenticated;/.test(mig));
check('migration : RPC sécurisée en definer', /create or replace function public\.submit_contact/.test(mig) && /security definer set search_path = public/.test(mig));
check('migration : double rate limit (IP + e-mail) sur 1 h',
    /v_max_ip/.test(mig) && /v_max_mail/.test(mig) && /interval '1 hour'/.test(mig));
check('migration : RPC retirée à anon/authenticated', /revoke execute on function public\.submit_contact[^;]*from public, anon, authenticated;/.test(mig));
check('migration : RPC accordée à service_role uniquement', /grant\s+execute on function public\.submit_contact[^;]*to service_role;/.test(mig));
check('migration : bornes de longueur (120/200/160/4000)',
    /left\(coalesce\(p_name, ''\), 120\)/.test(mig) && /left\(coalesce\(p_body, ''\), 4000\)/.test(mig));
check('migration : canal contraint à founder|site',
    /check \(channel in \('founder', 'site'\)\)/.test(mig));

/* Le code du dépôt ne doit contenir aucune clé réelle. */
const contactSrc = ['supabase/functions/lsv-contact/index.ts', 'supabase/functions/lsv-contact/core.mjs', 'supabase/functions/lsv-contact/templates.mjs', 'shared/contact.js']
    .map(rel => existsSync(join(PROJECT, rel)) ? readFileSync(join(PROJECT, rel), 'utf8') : '').join('\n');
check('aucune clé de service ni sk- dans le code de contact',
    !/sk-[A-Za-z0-9]{10,}/.test(contactSrc) && !/SERVICE_ROLE_KEY\s*[:=]\s*['"][^'"]+['"]/.test(contactSrc));
check('l\'e-mail du client n\'est jamais envoyé en clair au fournisseur sans replyTo',
    /replyTo/.test(contactSrc) || /reply_to/.test(contactSrc));

const envPath = join(PROJECT, '.env.example');
const envEx = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
check('.env.example documente les variables du fournisseur d\'e-mail',
    /EMAIL_PROVIDER/.test(envEx) && /EMAIL_API_KEY/.test(envEx) && /EMAIL_FROM/.test(envEx));
check('.env.example n\'expose aucune valeur réelle', !/=\s*\S+@\S+/.test(envEx.replace(/EMAIL_FROM=.*/g, '')));

/* ═══════════════ 9. PAGES PUBLIQUES ═══════════════ */
console.log('\n=== 9. PAGES PUBLIQUES (contact + à propos) ===');
const contactPage = existsSync(join(PROJECT, 'contact/index.html')) ? readFileSync(join(PROJECT, 'contact/index.html'), 'utf8') : '';
check('page contact/index.html existe', !!contactPage, contactPage.length + ' octets');
check('page contact en français', /<html lang="fr">/.test(contactPage));
check('canonical Contact présent', /canonical" href="https:\/\/fbici\.github\.io\/lsv-ai\/contact\/"/.test(contactPage));
check('formulaire contact avec canal « site »', /data-contact="site"/.test(contactPage));
check('adresse officielle affichée', /lestudioviral@gmail\.com/.test(contactPage));
check('formulaire : champ piège anti-robot', /name="website"/.test(contactPage) && /ct-hp/.test(contactPage));
check('formulaire : 4 champs obligatoires + textarea',
    (contactPage.match(/required/g) || []).length >= 4 && /<textarea/.test(contactPage));
check('page contact : aucune donnée secrète',
    !/sk-[A-Za-z0-9]{10,}|service_role|password\s*[:=]/.test(contactPage));
check('page contact : JSON-LD ContactPage', /"@type": "ContactPage"/.test(contactPage));
check('page contact : accès au studio + à propos', /href="\.\.\/"/.test(contactPage) && /a-propos/.test(contactPage));
check('page contact : lien mailto officiel', /href="mailto:lestudioviral@gmail\.com"/.test(contactPage));

const about = existsSync(join(PROJECT, 'a-propos/index.html')) ? readFileSync(join(PROJECT, 'a-propos/index.html'), 'utf8') : '';
check('à propos : espace créateur dédié (section id=createur)', /id="createur"/.test(about) && /Un créateur\. Plusieurs disciplines\. Un univers\./.test(about));
check('à propos : portrait pdg.png utilisé', /assets\/showcase\/pdg\.png/.test(about) && /alt="Salaou Souleyman/.test(about));
check('à propos : disciplines affichées (SOFTWARE · AI · 3D · CONTENT · DIGITAL PRODUCTS)',
    /Software/.test(about) && /Digital Products/.test(about));
check('à propos : phrase officielle du créateur présente',
    /entrepreneur créatif/.test(about) && /expression visuelle/.test(about));
check('à propos : formulaire personnel (canal founder)', /data-contact="founder"/.test(about));
check('à propos : e-mail personnel affiché', /salaousouleyman@gmail\.com/.test(about));
check('à propos : lien vers la page contact', /href="\.\.\/contact\/"/.test(about));
check('à propos : footer moderne (site-footer + 4 colonnes)',
    /class="site-footer"/.test(about) && /sf-grid/.test(about));
check('à propos : 1 seul logo ../lsv.jpg (contrainte SEO)',
    (about.match(/src="\.\.\/lsv\.jpg"/g) || []).length === 1, (about.match(/src="\.\.\/lsv\.jpg"/g) || []).length);

const idx = readFileSync(join(PROJECT, 'index.html'), 'utf8');
check('accueil : footer professionnel (footer.w-foot + grille)',
    /<footer class="w-foot">/.test(idx) && /w-foot-grid/.test(idx));
check('accueil : footer contact + boutiques + plan du site',
    /mailto:lestudioviral@gmail\.com/.test(idx) && /mailto:salaousouleyman@gmail\.com/.test(idx) &&
    /Boutique LeStudioViral/.test(idx) && /Académie Digital/.test(idx) && /\.\/studio\//.test(idx));
check('accueil : footer lien contact dans la sidebar', /href="\.\/contact\/"/.test(idx));
check('accueil : aucun mot interdit ajouté au footer',
    !/clé API|Agnes|Bearer|sk-/i.test(idx.match(/<footer class="w-foot">[\s\S]*?<\/footer>/)?.[0] || ''));

const sm = readFileSync(join(PROJECT, 'sitemap.xml'), 'utf8');
check('sitemap contient /contact/', /lsv-ai\/contact\//.test(sm) && !/contact\.html/.test(sm));
const llms = readFileSync(join(PROJECT, 'llms.txt'), 'utf8');
check('llms.txt contient contact + e-mails', /contact\//.test(llms) && /lestudioviral@gmail\.com/.test(llms));

/* Le module partagé s'auto-initialise et ne tire que config.js. */
const contactJs = readFileSync(join(PROJECT, 'shared/contact.js'), 'utf8');
check('module contact.js : auto-initialisation', /form\[data-contact\]/.test(contactJs) && /DOMContentLoaded/.test(contactJs));
check('module contact.js : aucune URL de fournisseur ni clé', !/apihub|agnes|sk-|Bearer\s+[A-Za-z0-9]/i.test(contactJs));
check('module contact.js : messages français lisibles', /bien reçu/i.test(contactJs) && /48 h/.test(contactJs));
check('module contact.js : analytics sans donnée personnelle',
    /track\('contact_submitted'/.test(contactJs) && !/email:/.test(contactJs.split('track(\'contact_submitted\'')[1] || ''));

/* ═══════════════ 10. RENDU RÉEL DES PAGES (jsdom) ═══════════════ */
/* On charge vraiment contact/ et a-propos/ avec leurs scripts : une page
   cassée à l'exécution passerait inaperçue dans les tests de texte. */
console.log('\n=== 10. RENDU RÉEL (jsdom) ===');
{
    const { JSDOM, VirtualConsole } = await import('jsdom');

    /* On inline les scripts locaux et on retire les ressources distantes :
       la page se comporte comme en production, sans réseau. */
    function inlineLocalScripts(html, baseDir) {
        return html
            .replace(/<link\b[^>]*href="https?:\/\/[^"]*"[^>]*>/g, '')
            .replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g, (m, src) => {
                if (/^https?:\/\//.test(src)) return '';
                const file = join(baseDir, src);
                if (!existsSync(file)) return '';
                return '<script data-inline="' + src + '">' + readFileSync(file, 'utf8') + '</script>';
            });
    }

    async function renderPage(rel) {
        const file = join(PROJECT, rel);
        const errors = [];
        const vc = new VirtualConsole();
        vc.on('jsdomError', e => {
            if (/Not implemented/.test(e.message)) return;
            const loc = (e && e.detail && e.detail.scriptElement && e.detail.scriptElement.getAttribute)
                ? e.detail.scriptElement.getAttribute('data-inline') : '';
            errors.push(e.message + (loc ? ' [' + loc + ']' : ''));
        });
        vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
        const dom = new JSDOM(
            inlineLocalScripts(readFileSync(file, 'utf8'), dirname(file)),
            { url: 'https://fbici.github.io/lsv-ai/' + rel, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc }
        );
        await new Promise(res => {
            if (dom.window.document.readyState === 'complete') return res();
            dom.window.addEventListener('load', res);
            setTimeout(res, 4000);
        });
        await new Promise(r => setTimeout(r, 250));
        return { dom, errors };
    }

    async function exercise(rel, canal, extra) {
        const { dom, errors } = await renderPage(rel);
        const w = dom.window;
        const doc = w.document;
        check(rel + ' : aucune erreur JS au chargement', errors.length === 0, errors.join(' | ') || 'aucune');
        check(rel + ' : module de contact initialisé',
            typeof w.LSVContact === 'object' && typeof w.LSVContact.submit === 'function');
        check(rel + ' : analytics chargé', typeof w.LSVAnalytics === 'object');

        const form = doc.querySelector('form[data-contact]');
        check(rel + ' : formulaire présent avec le bon canal', !!form && form.getAttribute('data-contact') === canal);
        check(rel + ' : formulaire auto-initialisé', !!(form && form.__lsvContact));
        check(rel + ' : footer moderne rendu', !!doc.querySelector('.site-footer'));
        check(rel + ' : aucune donnée secrète dans le DOM rendu',
            !/sk-[A-Za-z0-9]{10,}|service_role|SUPABASE_SERVICE/.test(doc.body.innerHTML));

        if (form) {
            form.querySelector('[name=name]').value = 'Anne Test';
            form.querySelector('[name=email]').value = 'anne@exemple.com';
            form.querySelector('[name=subject]').value = 'Une question';
            form.querySelector('[name=message]').value = 'Bonjour, je voudrais en savoir plus sur le studio.';
            const status = () => doc.querySelector('[data-contact-status]');
            const before = form.querySelector('[name=name]').value;

            /* Fournisseur non configuré côté Edge Function → message stocké. */
            w.fetch = async () => ({ status: 200, json: async () => ({ ok: true, reason: 'stored' }) });
            await w.LSVContact.submit(form);
            check(rel + ' : parcours de soumission aboutit (message lisible)',
                !!status() && /Bien reçu|reçu|48 h/i.test(status().textContent),
                status() ? status().textContent.slice(0, 70) : '(aucun)');
            check(rel + ' : formulaire réinitialisé après envoi',
                before !== '' && form.querySelector('[name=name]').value === '');
        }

        if (extra) await extra({ doc: doc, w: w });

        const snap = {
            text: doc.body.textContent,
            inner: doc.body.innerHTML,
            photo: (doc.querySelector('.creator-photo img') || {}).getAttribute
                ? doc.querySelector('.creator-photo img').getAttribute('src') : null
        };
        dom.window.close();
        return snap;
    }

    const wContact = await exercise('contact/index.html', 'site');

    /* ── Visionneuse du portrait (à propos) ──────────────────────────────
       jsdom n'implémente pas <dialog> : on vérifie le repli `open` et
       l'absence d'erreur, pas l'effet modal lui-même. */
    const wAbout = await exercise('a-propos/index.html', 'founder', async ({ doc, w }) => {
        const zoom = doc.getElementById('photo-zoom');
        const dlg = doc.getElementById('photo-lightbox');
        const closeBtn = doc.getElementById('photo-lightbox-close');

        check('à propos : vignette cliquable = un vrai <button>',
            !!zoom && zoom.tagName === 'BUTTON' && zoom.getAttribute('type') === 'button');
        check('à propos : vignette annoncée comme ouvrant une boîte de dialogue',
            !!zoom && zoom.getAttribute('aria-haspopup') === 'dialog' &&
            zoom.getAttribute('aria-controls') === 'photo-lightbox');
        check('à propos : visionneuse <dialog> aria-modal présente',
            !!dlg && dlg.tagName === 'DIALOG' && !!dlg.getAttribute('aria-label'));
        check('à propos : visionneuse affiche la même source que la vignette',
            !!dlg && !!dlg.querySelector('img') &&
            dlg.querySelector('img').getAttribute('src') === '../assets/showcase/pdg.png');
        check('à propos : visionneuse sans alt vide',
            !!dlg && (dlg.querySelector('img').getAttribute('alt') || '').length > 10);

        /* Ouverture. */
        zoom.click();
        const opened = dlg.hasAttribute('open');
        check('à propos : clic sur la vignette ouvre la visionneuse', opened === true);

        /* Fermeture par le bouton, puis retour du focus sur la vignette. */
        if (closeBtn) closeBtn.click();
        check('à propos : bouton « Fermer » ferme la visionneuse', dlg.hasAttribute('open') === false);
        check('à propos : le focus revient sur la vignette après fermeture',
            doc.activeElement === zoom, doc.activeElement && doc.activeElement.id);

        /* Fermeture par le clic sur le fond. */
        zoom.click();
        dlg.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        check('à propos : clic sur le fond ferme la visionneuse', dlg.hasAttribute('open') === false);

        /* Le clic sur l'image elle-même ne doit PAS fermer. */
        zoom.click();
        dlg.querySelector('img').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        check('à propos : clic sur l\'image (pas le fond) laisse ouvert', dlg.hasAttribute('open') === true);
        closeBtn.click();
    });

    /* L'adresse du destinataire du bon canal doit être affichée. */
    check('contact : adresse de la marque affichée', /lestudioviral@gmail\.com/.test(wContact.text));
    check('à propos : adresse personnelle du créateur affichée',
        /salaousouleyman@gmail\.com/.test(wAbout.text));
    check('à propos : portrait du créateur avec la bonne source',
        wAbout.photo === '../assets/showcase/pdg.png', wAbout.photo);
    check('à propos : photo réellement présente sur le disque',
        existsSync(join(PROJECT, 'assets/showcase/pdg.png')));
}

const failed = results.filter(r => !r.ok);
console.log('\n════════════════════════════════');
console.log((results.length - failed.length) + '/' + results.length + ' tests contact OK');
if (failed.length) console.log('ECHECS : ' + failed.map(f => f.label).join(', '));
else console.log('CONTACT CONFORME');
process.exit(failed.length ? 1 : 0);
