/* Tests du back-office LSV.ai — scénarios d'accès (§24 de la mission) */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PROJECT = path.resolve(__dirname, '..');
const ADMIN_HTML = path.join(PROJECT, 'admin/index.html');

const EVENTS = [
    { created_at: new Date().toISOString(), visitor_id: 'v1', session_id: 's1', user_id: null, event: 'page_view', props: { path: '/' } },
    { created_at: new Date().toISOString(), visitor_id: 'v1', session_id: 's1', user_id: 'u1', event: 'image_generated', props: { model: 'agnes-image-2.1-flash', ratio: '16:9', size: '1312x736', style: 'cinematic' } },
    { created_at: new Date().toISOString(), visitor_id: 'v2', session_id: 's2', user_id: 'u2', event: 'video_generated', props: { model: 'agnes-video-v2.0', mode: 'text-to-video', duration: 5, segments: 2 } },
    { created_at: new Date().toISOString(), visitor_id: 'v2', session_id: 's2', user_id: 'u2', event: 'chat_used', props: { status: 'success' } },
    { created_at: new Date().toISOString(), visitor_id: 'v1', session_id: 's1', user_id: 'u1', event: 'generation_error', props: { feature: 'video', detail: 'HTTP 500 — Internal error' } },
    { created_at: new Date().toISOString(), visitor_id: 'v3', session_id: 's3', user_id: 'u1', event: 'project_created', props: { type: 'pub' } },
    { created_at: new Date().toISOString(), visitor_id: 'v3', session_id: 's3', user_id: null, event: 'tab_view', props: { tab: 'motion' } }
];

// Table public.admin_logs (journal d'audit du back-office, écriture seule)
const LOGS = [
    { created_at: new Date(Date.now() - 3600000).toISOString(), actor_email: 'admin@test.com', action: 'cle_fournisseur_modifiee', target: 'provider_api_key', detail: { longueur: 32 } },
    { created_at: new Date(Date.now() - 7200000).toISOString(), actor_email: 'admin@test.com', action: 'connexion', target: null, detail: {} }
];

// Table public.app_settings (clé fournisseur + quotas journaliers)
const SETTINGS = {};
[['quota_enabled', '1'], ['quota_suspended', '0'],
 ['quota_image_daily', '20'], ['quota_video_daily', '8'], ['quota_chat_daily', '30'],
 ['quota_motion_daily', '0'], ['quota_global_daily', '500']].forEach(([k, v]) => {
    SETTINGS[k] = { key: k, value: v, updated_at: new Date(Date.now() - 86400000).toISOString() };
});

// Table public.usage_counters (consommation du jour par compte)
const USAGE = [
    { user_id: 'u1', kind: 'image', units: 5, updated_at: new Date(Date.now() - 600000).toISOString() },
    { user_id: 'u1', kind: 'video', units: 2, updated_at: new Date(Date.now() - 300000).toISOString() },
    { user_id: 'u1', kind: 'chat', units: 11, updated_at: new Date().toISOString() },
    { user_id: 'u2', kind: 'image', units: 3, updated_at: new Date(Date.now() - 120000).toISOString() }
];

// Table public.profiles (noms + e-mails des comptes, remplie par trigger SQL)
const PROFILES = [
    { id: 'u1', email: 'ada@lsv.ai', full_name: 'Ada Lovelace', created_at: new Date(Date.now() - 2 * 86400000).toISOString(), last_sign_in_at: new Date(Date.now() - 3600000).toISOString() },
    { id: 'u2', email: 'sansnom@lsv.ai', full_name: null, created_at: new Date().toISOString(), last_sign_in_at: null }
];

const GOOD_EMAIL = 'admin@test.com';
const GOOD_PASSWORD = 'password-de-test';
const OTHER_EMAIL = 'user@test.com'; // compte réel mais hors liste blanche
const NEW_EMAIL = 'nouveau@test.com'; // créé par le scénario d'inscription
const CONFIRM_EMAIL = 'confirme@test.com'; // inscription nécessitant une confirmation
const WHITELIST = [GOOD_EMAIL, NEW_EMAIL];

let rlsEnabled = true; // simule la RLS Supabase : pas de session = pas de données

function makeFakeSupabase() {
    function builder(rowsForRequest) {
        const b = {
            select() { return b; }, gte() { return b; }, lt() { return b; },
            order() { return b; }, limit() { return b; },
            then(resolve) {
                const session = api._session;
                if (rlsEnabled && (!session || session.user.email !== GOOD_EMAIL)) {
                    resolve({ data: null, error: { message: 'permission denied for table analytics_events' } });
                } else {
                    resolve({ data: rowsForRequest, error: null });
                }
            }
        };
        return b;
    }
    const api = {
        _session: null,
        _listeners: [],
        auth: {
            getSession() { return Promise.resolve({ data: { session: api._session }, error: null }); },
            signInWithPassword({ email, password }) {
                if (email === GOOD_EMAIL && password === GOOD_PASSWORD) {
                    const session = { user: { id: 'uid-1', email: email }, expires_at: Math.floor(Date.now() / 1000) + 3600 };
                    api._session = session;
                    api._listeners.forEach(cb => cb('SIGNED_IN', session));
                    return Promise.resolve({ data: { user: session.user, session }, error: null });
                }
                return Promise.resolve({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } });
            },
            signOut() { api._session = null; api._listeners.forEach(cb => cb('SIGNED_OUT', null)); return Promise.resolve({ error: null }); },
            onAuthStateChange(cb) { api._listeners.push(cb); return { data: { subscription: {} } }; }
        },
        from(table) {
            if (table !== 'analytics_events') return builder([]);
            return builder(EVENTS);
        },
        rpc(name) {
            if (name !== 'is_admin') return Promise.resolve({ data: null, error: { message: 'unknown function' } });
            const s = api._session;
            const email = s && s.user && s.user.email;
            return Promise.resolve({ data: !!(email && ['admin@test.com', 'nouveau@test.com'].indexOf(email) !== -1), error: null });
        }
    };
    return { createClient: () => api, _api: api };
}

function prepare(html, fake, config) {
    let h = html
        .replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '')
        .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/,
            '<script>window.supabase = (' + fake.toString() + ')();</script>')
        .replace('<script src="../shared/config.js"></script>',
            '<script>window.LSV_CONFIG = ' + JSON.stringify(config) + ';</script>')
        .replace('<script src="./admin.js"></script>',
            '<script>' + fs.readFileSync(path.join(PROJECT, 'admin/admin.js'), 'utf8') + '</script>');
    return h;
}

async function load(html) {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
    vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
    vc.on('warn', () => {});
    const dom = new JSDOM(html, { url: 'https://lsv.test/admin/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
    await new Promise(r => { if (dom.window.document.readyState === 'complete') return r(); dom.window.addEventListener('load', r); setTimeout(r, 3000); });
    await new Promise(r => setTimeout(r, 250));
    return { dom, errors };
}

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond });
    console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login(dom, email, password) {
    const w = dom.window || (dom.dom && dom.dom.window);
    w.document.getElementById('login-email').value = email;
    w.document.getElementById('login-password').value = password;
    w.document.getElementById('login-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(300);
}

(async () => {
    const src = fs.readFileSync(ADMIN_HTML, 'utf8');
    const fake = function makeFakeSupabase() {
        function builder(rowsForRequest, table) {
            const b = {
                _table: table, _upsert: null, _isDelete: false, _insert: null, _eq: null,
                select() { return b; }, gte() { return b; }, lt() { return b; },
                order() { return b; }, limit() { return b; },
                eq(k, v) { b._eq = { k: k, v: v }; return b; }, not() { return b; },
                insert(row) { b._insert = row; return b; },
                upsert(row) { b._upsert = row; return b; },
                delete() { b._isDelete = true; return b; },
                then(resolve, reject) {
                    const session = api._session;
                    const listed = session && (window.__WHITELIST || []).indexOf(session.user.email) !== -1;
                    let result;
                    if (window.__rlsEnabled && !listed) {
                        result = { data: null, error: { message: 'permission denied for table ' + (b._table || 'analytics_events') } };
                    } else if (b._table === 'admin_logs' && b._insert) {
                        window.__LOGS = window.__LOGS || [];
                        window.__LOGS.unshift(Object.assign({ id: 'log-' + window.__LOGS.length }, b._insert));
                        result = { data: null, error: null };
                    } else if (b._table === 'app_settings') {
                        const store = window.__SETTINGS || {};
                        if (b._upsert) {
                            const rows = Array.isArray(b._upsert) ? b._upsert : [b._upsert];
                            rows.forEach(r => { store[r.key] = r; });
                            window.__SETTINGS = store;
                            result = { data: rows, error: null };
                        } else if (b._isDelete) {
                            if (b._eq && b._eq.k === 'key') delete store[b._eq.v];
                            window.__SETTINGS = store;
                            result = { data: null, error: null };
                        } else {
                            var rows = Object.keys(store).map(k => ({ key: k, value: store[k].value, updated_at: store[k].updated_at }));
                            if (b._eq && b._eq.k === 'key') rows = rows.filter(r => r.key === b._eq.v);
                            result = { data: rows, error: null };
                        }
                    } else if (b._table === 'usage_counters') {
                        result = { data: window.__USAGE || [], error: null };
                    } else {
                        result = { data: rowsForRequest, error: null };
                    }
                    return Promise.resolve(result).then(resolve, reject);
                }
            };
            return b;
        }
        const api = {
            _session: null, _listeners: [],
            auth: {
                getSession() { return Promise.resolve({ data: { session: api._session }, error: null }); },
                signInWithPassword(creds) {
                    const ok = creds.password === window.__GOOD_PASSWORD &&
                        (creds.email === window.__GOOD_EMAIL || creds.email === window.__USER_EMAIL);
                    if (ok) {
                        const session = { user: { id: 'uid-1', email: creds.email, user_metadata: {} }, expires_at: Math.floor(Date.now() / 1000) + 3600 };
                        api._session = session;
                        api._listeners.forEach(cb => cb('SIGNED_IN', session));
                        return Promise.resolve({ data: { user: session.user, session }, error: null });
                    }
                    return Promise.resolve({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } });
                },
                signUp(creds) {
                    const meta = (creds.options && creds.options.data) || {};
                    if (creds.email === window.__CONFIRM_EMAIL) {
                        return Promise.resolve({ data: { user: { id: 'uid-2', email: creds.email, user_metadata: meta }, session: null }, error: null });
                    }
                    const session = { user: { id: 'uid-2', email: creds.email, user_metadata: meta }, expires_at: Math.floor(Date.now() / 1000) + 3600 };
                    api._session = session;
                    api._listeners.forEach(cb => cb('SIGNED_IN', session));
                    return Promise.resolve({ data: { user: session.user, session }, error: null });
                },
                signOut() { api._session = null; api._listeners.forEach(cb => cb('SIGNED_OUT', null)); return Promise.resolve({ error: null }); },
                onAuthStateChange(cb) { api._listeners.push(cb); return { data: { subscription: {} } }; }
            },
            from(table) {
                if (table === 'profiles') return builder(window.__PROFILES || [], table);
                if (table === 'admin_logs') return builder(window.__LOGS || [], table);
                if (table === 'usage_counters') return builder(window.__USAGE || [], table);
                return builder(window.__EVENTS, table);
            },
            rpc(name) {
                if (name !== 'is_admin') return Promise.resolve({ data: null, error: { message: 'unknown function' } });
                const s = api._session;
                const email = s && s.user && s.user.email;
                const wl = window.__WHITELIST || [];
                return Promise.resolve({ data: !!(email && wl.indexOf(email) !== -1), error: null });
            }
        };
        return { createClient: () => api, _api: api };
    };

    const CONFIG_OK = { SUPABASE_URL: 'https://abcdefgh.supabase.co', SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.signature' };
    const CONFIG_KO = { SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co', SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY' };

    function inject(html, config) {
        return html
            .replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '')
            .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/,
                '<script>window.__rlsEnabled=true;window.__GOOD_EMAIL="' + GOOD_EMAIL + '";window.__GOOD_PASSWORD="' + GOOD_PASSWORD +
                '";window.__USER_EMAIL="' + OTHER_EMAIL + '";window.__CONFIRM_EMAIL="' + CONFIRM_EMAIL +
                '";window.__WHITELIST=' + JSON.stringify(WHITELIST) +
                ';window.__SETTINGS=' + JSON.stringify(SETTINGS) + ';window.__EVENTS=' + JSON.stringify(EVENTS) +
                ';window.__PROFILES=' + JSON.stringify(PROFILES) +
                ';window.__LOGS=' + JSON.stringify(LOGS) +
                ';window.__USAGE=' + JSON.stringify(USAGE) + ';window.supabase=(' + fake.toString() + ')();</script>')
            .replace('<script src="../shared/config.js"></script>', '<script>window.LSV_CONFIG=' + JSON.stringify(config) + ';</script>')
            .replace('<script src="./admin.js"></script>', '<script>' + fs.readFileSync(path.join(PROJECT, 'admin/admin.js'), 'utf8') + '</script>');
    }

    console.log('\n=== A. CONFIGURATION ABSENTE ===');
    let t = await load(inject(src, CONFIG_KO));
    check('page de connexion affichée', !t.dom.window.document.getElementById('auth-screen').classList.contains('hidden'));
    check('dashboard masqué', t.dom.window.document.getElementById('admin-app').classList.contains('hidden'));
    check('message de configuration', /config/i.test(t.dom.window.document.getElementById('auth-status').textContent));
    check('aucune erreur console', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== B. NON AUTHENTIFIÉ ===');
    t = await load(inject(src, CONFIG_OK));
    const w = t.dom.window;
    check('dashboard inaccessible', w.document.getElementById('admin-app').classList.contains('hidden'));
    check('login visible', !w.document.getElementById('auth-screen').classList.contains('hidden'));
    check('aucune donnée affichée', w.document.getElementById('kpi-grid').innerHTML.trim() === '');
    check('aucune erreur console', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== C. MAUVAIS IDENTIFIANTS ===');
    await login(t, 'admin@test.com', 'mauvais-mdp');
    const err = w.document.getElementById('login-error');
    check('accès refusé (message)', !err.classList.contains('hidden') && /incorrect/i.test(err.textContent), err.textContent);
    check('dashboard toujours masqué', w.document.getElementById('admin-app').classList.contains('hidden'));

    console.log('\n=== D. IDENTIFIANTS VALIDES ===');
    await login(t, GOOD_EMAIL, GOOD_PASSWORD);
    await sleep(500);
    check('dashboard accessible', !w.document.getElementById('admin-app').classList.contains('hidden'));
    check('login masqué', w.document.getElementById('auth-screen').classList.contains('hidden'));
    check('email affiché', w.document.getElementById('admin-email').textContent === GOOD_EMAIL);
    const kpis = w.document.getElementById('kpi-grid').textContent;
    check('KPI visiteurs=3', /Visiteurs[\s\S]*?3/.test(kpis), kpis.replace(/\s+/g, ' ').slice(0, 160));
    check('KPI images=1', /Images générées\s*1/.test(kpis.replace(/\s+/g, ' ')));
    check('graphique rendu (svg)', !!w.document.querySelector('#chart-activity svg'));
    check('barres utilisation rendues', w.document.getElementById('usage-bars').innerHTML.indexOf('usage-row') !== -1);
    check('feed activité rendu', w.document.getElementById('overview-feed').innerHTML.indexOf('feed-item') !== -1);

    console.log('\n=== E. PAGES DU DASHBOARD ===');
    const pages = ['images', 'videos', 'chat', 'motion', 'activity', 'errors', 'settings', 'users', 'overview'];
    let pagesOk = true;
    for (const p of pages) {
        try {
            w.document.querySelector('.nav-item[data-page="' + p + '"]').dispatchEvent(new w.Event('click', { bubbles: true }));
            await sleep(60);
            const active = w.document.querySelector('.page.active');
            if (!active || active.id !== 'page-' + p) { pagesOk = false; console.log('    page KO: ' + p); }
            if (w.document.getElementById('page-title').textContent.trim() === '') { pagesOk = false; }
        } catch (e) { pagesOk = false; console.log('    exception ' + p + ': ' + e.message); }
    }
    check('9 pages navigables sans exception', pagesOk);

    // contenu des pages
    w.document.querySelector('.nav-item[data-page="errors"]').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(60);
    check('table erreurs remplie', w.document.getElementById('errors-table').innerHTML.indexOf('VIDEO') !== -1 || w.document.getElementById('errors-table').innerHTML.indexOf('video') !== -1);
    check('badge type erreur', w.document.getElementById('errors-table').innerHTML.indexOf('GENERATION_ERROR') !== -1);

    w.document.querySelector('.nav-item[data-page="images"]').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(60);
    check('table images remplie', w.document.getElementById('images-table').innerHTML.indexOf('agnes-image-2.1-flash') !== -1);

    console.log('\n=== F. PLAGE TEMPORELLE ===');
    let rangeOk = true;
    for (const r of ['7d', '30d', 'all', 'today']) {
        try {
            w.document.querySelector('.range-btn[data-range="' + r + '"]').dispatchEvent(new w.Event('click', { bubbles: true }));
            await sleep(120);
            if (!w.document.querySelector('.range-btn[data-range="' + r + '"]').classList.contains('active')) rangeOk = false;
        } catch (e) { rangeOk = false; console.log('    exception range ' + r + ': ' + e.message); }
    }
    check('4 plages fonctionnelles', rangeOk);

    console.log('\n=== G. SESSION EXPIRÉE / RLS ===');
    w.__rlsEnabled = true;
    w.supabase._api._session = null; // le token a expiré côté serveur
    w.document.getElementById('refresh-btn').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(400);
    check('retour vers la connexion', !w.document.getElementById('auth-screen').classList.contains('hidden'));
    check('dashboard refermé', w.document.getElementById('admin-app').classList.contains('hidden'));

    console.log('\n=== H. DÉCONNEXION ===');
    await login(w, GOOD_EMAIL, GOOD_PASSWORD);
    await sleep(400);
    check('reconnexion OK', !w.document.getElementById('admin-app').classList.contains('hidden'));
    w.document.getElementById('logout-btn').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(300);
    check('déconnexion → login', !w.document.getElementById('auth-screen').classList.contains('hidden'));
    check('données effacées après logout', w.document.getElementById('kpi-grid').innerHTML.indexOf('kpi-value') === -1 || w.document.getElementById('admin-app').classList.contains('hidden'));

    console.log('\n=== I. INSCRIPTION DEPUIS L ÉCRAN CONNEXION ===');
    t = await load(inject(src, CONFIG_OK));
    let wi = t.dom.window;
    check('champ nom masqué en mode connexion', wi.document.getElementById('login-name-field').classList.contains('hidden'));
    wi.document.getElementById('signup-toggle').dispatchEvent(new wi.Event('click', { bubbles: true }));
    await sleep(80);
    check('titre = Créer un compte', wi.document.getElementById('auth-title').textContent === 'Créer un compte');
    check('indice d inscription visible', !wi.document.getElementById('signup-hint').classList.contains('hidden'));
    check('champ nom complet visible en inscription', !wi.document.getElementById('login-name-field').classList.contains('hidden'));
    check('bouton = Créer le compte', /Créer le compte/.test(wi.document.getElementById('login-btn').textContent));
    check('libellé inversé (j ai déjà un compte)', /déjà un compte/.test(wi.document.getElementById('signup-toggle').textContent));
    check('autocomplete = new-password', wi.document.getElementById('login-password').getAttribute('autocomplete') === 'new-password');
    check('login form masqué avant inscription', wi.document.getElementById('admin-app').classList.contains('hidden'));

    wi.document.getElementById('login-email').value = NEW_EMAIL;
    wi.document.getElementById('login-password').value = 'mot-de-passe-test';
    wi.document.getElementById('login-form').dispatchEvent(new wi.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(200);
    check('inscription sans nom refusée', /Nom complet requis/i.test(wi.document.getElementById('login-error').textContent), wi.document.getElementById('login-error').textContent);
    check('dashboard fermé sans nom', wi.document.getElementById('admin-app').classList.contains('hidden'));

    wi.document.getElementById('login-name').value = 'Jean Nouveau';
    wi.document.getElementById('login-form').dispatchEvent(new wi.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(500);
    check('inscription → dashboard (liste blanche)', !wi.document.getElementById('admin-app').classList.contains('hidden'));
    check('e-mail du nouveau compte affiché', wi.document.getElementById('admin-email').textContent === NEW_EMAIL, wi.document.getElementById('admin-email').textContent);
    const meta = wi.supabase._api._session && wi.supabase._api._session.user.user_metadata;
    check('nom complet transmis à Supabase Auth', meta && meta.full_name === 'Jean Nouveau', JSON.stringify(meta));

    const t2 = await load(inject(src, CONFIG_OK));
    const wc = t2.dom.window;
    wc.document.getElementById('signup-toggle').dispatchEvent(new wc.Event('click', { bubbles: true }));
    await sleep(60);
    wc.document.getElementById('login-name').value = 'Confirme Toi';
    wc.document.getElementById('login-email').value = CONFIRM_EMAIL;
    wc.document.getElementById('login-password').value = 'mot-de-passe-test';
    wc.document.getElementById('login-form').dispatchEvent(new wc.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(450);
    check('confirmation e-mail demandée', /confirme ton e-mail/i.test(wc.document.getElementById('auth-status').textContent), wc.document.getElementById('auth-status').textContent);
    check('dashboard fermé en attente de confirmation', wc.document.getElementById('admin-app').classList.contains('hidden'));
    check('retour au mode connexion', /Créer un compte/.test(wc.document.getElementById('signup-toggle').textContent));
    check('aucune erreur console (inscription)', t2.errors.length === 0, t2.errors.join('|'));

    console.log('\n=== J. COMPTE HORS LISTE BLANCHE ===');
    t = await load(inject(src, CONFIG_OK));
    const wo = t.dom.window;
    await login(t, OTHER_EMAIL, GOOD_PASSWORD);
    await sleep(450);
    check('dashboard masqué (non listé)', wo.document.getElementById('admin-app').classList.contains('hidden'));
    check('message non autorisé', /non autorisé/i.test(wo.document.getElementById('login-error').textContent), wo.document.getElementById('login-error').textContent);
    check('écran de connexion visible', !wo.document.getElementById('auth-screen').classList.contains('hidden'));
    check('aucune donnée affichée (hors liste)', wo.document.getElementById('kpi-grid').innerHTML.trim() === '');
    check('aucune erreur console (hors liste)', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== L. CLÉ DU FOURNISSEUR DANS PARAMÈTRES ===');
    t = await load(inject(src, CONFIG_OK));
    const wk = t.dom.window;
    await login(t, GOOD_EMAIL, GOOD_PASSWORD);
    await sleep(500);
    wk.document.querySelector('.nav-item[data-page="settings"]').dispatchEvent(new wk.Event('click', { bubbles: true }));
    await sleep(250);
    check('carte « Clé du fournisseur » présente', !!wk.document.getElementById('provider-key-input'));
    const keyStatus = () => wk.document.getElementById('settings-key-status').textContent;
    check('statut initial : aucune clé en base', /aucune clé/i.test(keyStatus()), keyStatus().replace(/\s+/g, ' ').slice(0, 90));

    wk.document.getElementById('provider-key-input').value = 'court';
    wk.document.getElementById('provider-key-save').dispatchEvent(new wk.Event('click', { bubbles: true }));
    await sleep(120);
    check('clé trop courte refusée', /8 caractères/.test(wk.document.getElementById('toast-text').textContent), wk.document.getElementById('toast-text').textContent);
    check('statut inchangé après refus', /aucune clé/i.test(keyStatus()));

    wk.document.getElementById('provider-key-input').value = 'cle-de-test-1234567890';
    wk.document.getElementById('provider-key-save').dispatchEvent(new wk.Event('click', { bubbles: true }));
    await sleep(250);
    check('clé enregistrée (confirmation)', /enregistrée/i.test(wk.document.getElementById('toast-text').textContent), wk.document.getElementById('toast-text').textContent);
    check('statut = configurée', /configurée/i.test(keyStatus()), keyStatus().replace(/\s+/g, ' ').slice(0, 90));
    check('clé masquée dans le statut', !/cle-de-test-1234567890/.test(keyStatus()) && /••••/.test(keyStatus()), keyStatus().replace(/\s+/g, ' ').slice(0, 90));
    check('champ vidé après enregistrement', wk.document.getElementById('provider-key-input').value === '');

    wk.document.getElementById('provider-key-clear').dispatchEvent(new wk.Event('click', { bubbles: true }));
    await sleep(250);
    check('clé retirée → statut initial', /aucune clé/i.test(keyStatus()), keyStatus().replace(/\s+/g, ' ').slice(0, 90));
    check('aucune erreur console (clé)', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== L2. CLÉS DU FOURNISSEUR PAR OUTIL ===');
    t = await load(inject(src, CONFIG_OK));
    const wt = t.dom.window;
    await login(t, GOOD_EMAIL, GOOD_PASSWORD);
    await sleep(500);
    wt.document.querySelector('.nav-item[data-page="settings"]').dispatchEvent(new wt.Event('click', { bubbles: true }));
    await sleep(350);
    check('carte « Clés … par outil » présente', !!wt.document.getElementById('tool-key-image'));
    check('3 champs (images / vidéos / chat)',
        !!wt.document.getElementById('tool-key-video') && !!wt.document.getElementById('tool-key-chat'));
    check('boutons enregistrer / retirer', !!wt.document.getElementById('tool-keys-save') && !!wt.document.getElementById('tool-keys-clear'));
    const toolStatus = () => wt.document.getElementById('tool-keys-status').textContent.replace(/\s+/g, ' ');
    check('statut initial : 0 / 3', /0 \/ 3/.test(toolStatus()), toolStatus().slice(0, 120));
    check('badge initial 0 / 3 actives', /0 \/ 3 actives/.test(wt.document.getElementById('tool-keys-count').textContent),
        wt.document.getElementById('tool-keys-count').textContent);

    wt.document.getElementById('tool-key-video').value = 'court';
    wt.document.getElementById('tool-keys-save').dispatchEvent(new wt.Event('click', { bubbles: true }));
    await sleep(120);
    check('clé d\'outil trop courte refusée', /8 caractères/.test(wt.document.getElementById('toast-text').textContent), wt.document.getElementById('toast-text').textContent);
    check('rien enregistré après refus', /0 \/ 3/.test(toolStatus()), toolStatus().slice(0, 120));

    wt.document.getElementById('tool-key-video').value = '';
    wt.document.getElementById('tool-keys-save').dispatchEvent(new wt.Event('click', { bubbles: true }));
    await sleep(120);
    check('aucune saisie → message d\'aide', /Aucune clé saisie/.test(wt.document.getElementById('toast-text').textContent), wt.document.getElementById('toast-text').textContent);

    wt.document.getElementById('tool-key-image').value = 'images-cle-00112233';
    wt.document.getElementById('tool-key-video').value = 'videos-cle-44556677';
    wt.document.getElementById('tool-key-chat').value = 'chat-cle-8899aabb';
    wt.document.getElementById('tool-keys-save').dispatchEvent(new wt.Event('click', { bubbles: true }));
    await sleep(350);
    check('3 clés enregistrées', /3 clé\(s\) enregistrée/.test(wt.document.getElementById('toast-text').textContent), wt.document.getElementById('toast-text').textContent);
    check('statut : 3 / 3', /3 \/ 3/.test(toolStatus()), toolStatus().slice(0, 160));
    check('clés masquées (aperçu 4 derniers caractères)',
        /••••••••2233/.test(toolStatus()) && !/images-cle-00112233/.test(toolStatus()), toolStatus().slice(0, 160));
    check('champs vidés après enregistrement',
        wt.document.getElementById('tool-key-image').value === '' &&
        wt.document.getElementById('tool-key-video').value === '');
    check('persistance en base (3 lignes app_settings)',
        wt.__SETTINGS && wt.__SETTINGS.provider_api_key_image && wt.__SETTINGS.provider_api_key_video && wt.__SETTINGS.provider_api_key_chat,
        Object.keys(wt.__SETTINGS || {}).join(','));
    check('valeur exacte stockée en base', wt.__SETTINGS.provider_api_key_chat.value === 'chat-cle-8899aabb');
    check('journal sans la valeur de clé',
        (wt.__LOGS || []).some(l => l.action === 'cles_outils_modifiees') &&
        !(wt.__LOGS || []).some(l => JSON.stringify(l).indexOf('images-cle-00112233') !== -1),
        JSON.stringify((wt.__LOGS || [])[0] || {}).slice(0, 120));

    wt.document.getElementById('tool-keys-clear').dispatchEvent(new wt.Event('click', { bubbles: true }));
    await sleep(350);
    check('retrait global → 0 / 3', /0 \/ 3/.test(toolStatus()), toolStatus().slice(0, 120));
    check('3 lignes supprimées de la base',
        !wt.__SETTINGS.provider_api_key_image && !wt.__SETTINGS.provider_api_key_video && !wt.__SETTINGS.provider_api_key_chat);
    check('aucune erreur console (clés outils)', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== M. PAGE UTILISATEURS ===');
    t = await load(inject(src, CONFIG_OK));
    const wu = t.dom.window;
    await login(t, GOOD_EMAIL, GOOD_PASSWORD);
    await sleep(500);
    check('entrée de nav « Utilisateurs »', !!wu.document.querySelector('.nav-item[data-page="users"]'));
    check('entrée de nav « Actions »', !!wu.document.querySelector('.nav-item[data-page="actions"]'));
    check('entrée de nav « Journal »', !!wu.document.querySelector('.nav-item[data-page="logs"]'));
    check('entrée de nav « Limites et quotas »', !!wu.document.querySelector('.nav-item[data-page="limits"]'));
    wu.document.querySelector('.nav-item[data-page="users"]').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(350);
    const activePage = wu.document.querySelector('.page.active');
    check('page Utilisateurs active', !!activePage && activePage.id === 'page-users', activePage && activePage.id);
    check('titre de page', wu.document.getElementById('page-title').textContent === 'Utilisateurs', wu.document.getElementById('page-title').textContent);
    const usersText = wu.document.getElementById('users-table').textContent.replace(/\s+/g, ' ');
    check('table des comptes remplie', /Ada Lovelace/.test(usersText) && /ada@lsv\.ai/.test(usersText), usersText.slice(0, 140));
    check('compte sans nom affiché proprement', /sansnom@lsv\.ai/.test(usersText), usersText.slice(0, 140));
    const usersKpi = wu.document.getElementById('kpi-users').textContent.replace(/\s+/g, ' ');
    check('KPI comptes = 2', /Comptes\s*2/.test(usersKpi), usersKpi.slice(0, 120));
    check('KPI avec nom = 1', /Avec nom complet\s*1/.test(usersKpi), usersKpi.slice(0, 120));
    check('aucun mot de passe ni jeton dans la table', !/password|secret|sbp_|eyJ/i.test(usersText), usersText.slice(0, 140));
    wu.document.getElementById('users-refresh').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(250);
    check('actualisation des comptes sans erreur', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== N. PAGE ACTIONS PAR UTILISATEUR ===');
    wu.document.querySelector('.nav-item[data-page="actions"]').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(450);
    const activeActions = wu.document.querySelector('.page.active');
    check('page Actions active', !!activeActions && activeActions.id === 'page-actions', activeActions && activeActions.id);
    check('titre Actions', wu.document.getElementById('page-title').textContent === 'Actions', wu.document.getElementById('page-title').textContent);
    const actionsText = wu.document.getElementById('actions-table').textContent.replace(/\s+/g, ' ');
    check('table Actions remplie (Ada Lovelace)', /Ada Lovelace/.test(actionsText), actionsText.slice(0, 160));
    check('compte u1 agrégé : images + erreur', /1/.test(actionsText) && /1/.test(actionsText), actionsText.slice(0, 200));
    const actionsKpi = wu.document.getElementById('kpi-actions').textContent.replace(/\s+/g, ' ');
    check('KPI comptes actifs ≥ 2', /Comptes actifs\s*[2-9]/.test(actionsKpi), actionsKpi.slice(0, 140));
    wu.document.getElementById('actions-refresh').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(250);
    check('actualisation Actions sans erreur', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== O. PAGE JOURNAL D\'AUDIT ===');
    wu.document.querySelector('.nav-item[data-page="logs"]').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(450);
    const activeLogs = wu.document.querySelector('.page.active');
    check('page Journal active', !!activeLogs && activeLogs.id === 'page-logs', activeLogs && activeLogs.id);
    check('titre Journal', wu.document.getElementById('page-title').textContent === 'Journal', wu.document.getElementById('page-title').textContent);
    const logsText = wu.document.getElementById('logs-table').textContent.replace(/\s+/g, ' ');
    check('table Journal remplie', /cle_fournisseur_modifiee/.test(logsText), logsText.slice(0, 160));
    check('auteur visible', /admin@test\.com/.test(logsText), logsText.slice(0, 160));
    wu.document.getElementById('logs-refresh').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(250);
    check('actualisation Journal sans erreur', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== P. PAGE LIMITES ET QUOTAS ===');
    wu.document.querySelector('.nav-item[data-page="limits"]').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(450);
    const activeLimits = wu.document.querySelector('.page.active');
    check('page Limites active', !!activeLimits && activeLimits.id === 'page-limits', activeLimits && activeLimits.id);
    check('titre Limites', wu.document.getElementById('page-title').textContent === 'Limites et quotas', wu.document.getElementById('page-title').textContent);
    check('quota images pré-rempli = 20', wu.document.getElementById('quota-image-daily').value === '20', wu.document.getElementById('quota-image-daily').value);
    check('quota vidéos pré-rempli = 8', wu.document.getElementById('quota-video-daily').value === '8', wu.document.getElementById('quota-video-daily').value);
    check('quota chat pré-rempli = 30', wu.document.getElementById('quota-chat-daily').value === '30', wu.document.getElementById('quota-chat-daily').value);
    check('limite globale pré-remplie = 500', wu.document.getElementById('quota-global-daily').value === '500', wu.document.getElementById('quota-global-daily').value);
    const suspendText = wu.document.getElementById('limits-suspend-status').textContent.replace(/\s+/g, ' ');
    check('générations actives affichées', /actives/.test(suspendText), suspendText.slice(0, 100));
    const limitsText = wu.document.getElementById('limits-table').textContent.replace(/\s+/g, ' ');
    check('consommation du jour remplie (Ada)', /Ada Lovelace/.test(limitsText), limitsText.slice(0, 160));
    check('consommation u1 agrégée (5+2+11=18)', /18/.test(limitsText), limitsText.slice(0, 200));

    /* Modification d'un quota → app_settings + journal d'audit. */
    wu.document.getElementById('quota-image-daily').value = '15';
    wu.document.getElementById('quota-save-user').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(300);
    check('quota images enregistré sans erreur', t.errors.length === 0, t.errors.join('|'));
    check('quota_image_daily = 15 en base', wu.__SETTINGS.quota_image_daily && wu.__SETTINGS.quota_image_daily.value === '15',
        JSON.stringify(wu.__SETTINGS.quota_image_daily));
    check('sauvegarde tracée dans le journal', wu.__LOGS.some(l => l.action === 'quotas_utilisateur_modifies'),
        JSON.stringify(wu.__LOGS.slice(0, 3)));

    /* Suspension d'urgence. */
    wu.document.getElementById('quota-suspend-on').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(300);
    check('suspension enregistrée', wu.__SETTINGS.quota_suspended && wu.__SETTINGS.quota_suspended.value === '1',
        JSON.stringify(wu.__SETTINGS.quota_suspended));
    check('suspension tracée dans le journal', wu.__LOGS.some(l => l.action === 'generations_suspendues'));
    check('statut suspendu affiché', /suspendues/.test(wu.document.getElementById('limits-suspend-status').textContent.replace(/\s+/g, ' ')));
    wu.document.getElementById('quota-suspend-off').dispatchEvent(new wu.Event('click', { bubbles: true }));
    await sleep(300);
    check('réactivation enregistrée', wu.__SETTINGS.quota_suspended.value === '0');
    check('aucune erreur console (limites)', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== K2. FAVICON + MODE SOMBRE ===');
    const adminHtmlOnly = fs.readFileSync(path.join(PROJECT, 'admin/index.html'), 'utf8');
    const adminCssOnly = fs.readFileSync(path.join(PROJECT, 'admin/admin.css'), 'utf8');
    check('favicon présent dans le back-office', /<link rel="icon"[^>]*lsv\.jpg/.test(adminHtmlOnly));
    check('apple-touch-icon présent', /<link rel="apple-touch-icon"[^>]*lsv\.jpg/.test(adminHtmlOnly));
    check('favicon relatif au dossier parent (../lsv.jpg)', /href="\.\.\/lsv\.jpg"/.test(adminHtmlOnly));
    check('thème appliqué avant le premier rendu (script inline en <head>)',
        /<script>[\s\S]*localStorage\.getItem\('lsv_admin_theme'\)[\s\S]*<\/script>/.test(adminHtmlOnly.split('</head>')[0]),
        adminHtmlOnly.split('</head>')[0].slice(-160));
    check('le script inline est bien dans <head> (pas après <body>)',
        adminHtmlOnly.indexOf('lsv_admin_theme') < adminHtmlOnly.indexOf('<body'));
    check('palette sombre définie dans admin.css', /html\.dark\s*\{/.test(adminCssOnly));
    check('palette sombre = tokens LSV (accent #2dd4bf)',
        /html\.dark\s*\{[\s\S]*?--accent:\s*#2dd4bf/.test(adminCssOnly));
    check('color-scheme: dark posé', /html\.dark\s*\{[\s\S]*?color-scheme:\s*dark/.test(adminCssOnly));
    check('contraste du toast corrigé en sombre', /html\.dark \.toast/.test(adminCssOnly));

    t = await load(inject(src, CONFIG_OK));
    const wth = t.dom.window;
    await login(t, GOOD_EMAIL, GOOD_PASSWORD);
    await sleep(500);
    const themeBtn = wth.document.getElementById('theme-toggle');
    check('bouton de thème dans le topbar', !!themeBtn);
    check('thème par défaut = clair (pas de classe sur <html>)',
        !wth.document.documentElement.classList.contains('dark'));
    check('icône initiale = dark_mode', themeBtn.querySelector('.ms').textContent === 'dark_mode',
        themeBtn.querySelector('.ms').textContent);

    themeBtn.dispatchEvent(new wth.Event('click', { bubbles: true }));
    await sleep(120);
    check('clic → mode sombre actif', wth.document.documentElement.classList.contains('dark'));
    check('icône basculée en light_mode', themeBtn.querySelector('.ms').textContent === 'light_mode',
        themeBtn.querySelector('.ms').textContent);
    check('choix mémorisé en localStorage', wth.localStorage.getItem('lsv_admin_theme') === 'dark',
        wth.localStorage.getItem('lsv_admin_theme'));
    check('libellé du bouton mis à jour', /mode clair/i.test(themeBtn.title), themeBtn.title);

    themeBtn.dispatchEvent(new wth.Event('click', { bubbles: true }));
    await sleep(120);
    check('second clic → retour au mode clair', !wth.document.documentElement.classList.contains('dark'));
    check('localStorage = light', wth.localStorage.getItem('lsv_admin_theme') === 'light');
    check('icône revenue en dark_mode', themeBtn.querySelector('.ms').textContent === 'dark_mode');
    check('aucune erreur console (thème)', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== K3. MODE SOMBRE SUR L\'ÉCRAN DE CONNEXION ===');
    t = await load(inject(src, CONFIG_OK));
    const wtc = t.dom.window;
    await sleep(350);
    check('écran de connexion visible avant login', !wtc.document.getElementById('auth-screen').classList.contains('hidden'));
    const authThemeBtn = wtc.document.getElementById('theme-toggle-auth');
    check('bouton de thème présent sur l\'écran de connexion', !!authThemeBtn);
    check('bouton de thème réellement accessible (dans l\'écran de connexion, pas dans le panneau masqué)',
        !!wtc.document.getElementById('auth-screen') &&
        wtc.document.getElementById('auth-screen').contains(authThemeBtn) &&
        wtc.document.getElementById('admin-app').classList.contains('hidden'));
    authThemeBtn.dispatchEvent(new wtc.Event('click', { bubbles: true }));
    await sleep(120);
    check('thème basculable SANS être connecté', wtc.document.documentElement.classList.contains('dark'));
    check('icône de l\'écran de connexion synchronisée', authThemeBtn.querySelector('.ms').textContent === 'light_mode',
        authThemeBtn.querySelector('.ms').textContent);
    check('écran de connexion toujours affiché', !wtc.document.getElementById('auth-screen').classList.contains('hidden'));
    check('mémorisé même hors session', wtc.localStorage.getItem('lsv_admin_theme') === 'dark');
    check('bouton du topbar synchronisé même s\'il est masqué',
        wtc.document.getElementById('theme-toggle').querySelector('.ms').textContent === 'light_mode');
    check('aucune erreur console (connexion + thème)', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== K. SANITÉ ===');
    check('aucune erreur console globale', t.errors.length === 0, t.errors.join('|'));
    const finalHtml = fs.readFileSync(path.join(PROJECT, 'admin/index.html'), 'utf8') + fs.readFileSync(path.join(PROJECT, 'admin/admin.js'), 'utf8');
    check('aucun mot de passe codé en dur', !/ADMIN_PASSWORD|password\s*===\s*['"][^'"]+['"]/.test(finalHtml));
    check('aucun service_role', !/service_role/i.test(finalHtml));

    const failed = results.filter(r => !r.ok);
    console.log('\n══════════════════════════════');
    console.log((results.length - failed.length) + '/' + results.length + ' tests admin OK');
    if (failed.length) console.log('ECHECS: ' + failed.map(f => f.label).join(', '));
    else console.log('SCÉNARIOS ADMIN CONFORMES');
    setTimeout(() => process.exit(failed.length ? 1 : 0), 100);
})();
