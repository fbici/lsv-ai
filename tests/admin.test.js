/* Tests du back-office LSV.ai — scénarios d'accès (§24 de la mission) */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PROJECT = path.resolve(__dirname, '..');
const ADMIN_HTML = path.join(PROJECT, 'admin/index.html');

const EVENTS = [
    { created_at: new Date().toISOString(), visitor_id: 'v1', session_id: 's1', event: 'page_view', props: { path: '/' } },
    { created_at: new Date().toISOString(), visitor_id: 'v1', session_id: 's1', event: 'image_generated', props: { model: 'agnes-image-2.1-flash', ratio: '16:9', size: '1312x736', style: 'cinematic' } },
    { created_at: new Date().toISOString(), visitor_id: 'v2', session_id: 's2', event: 'video_generated', props: { model: 'agnes-video-v2.0', mode: 'text-to-video', duration: 5, segments: 2 } },
    { created_at: new Date().toISOString(), visitor_id: 'v2', session_id: 's2', event: 'chat_used', props: { status: 'success' } },
    { created_at: new Date().toISOString(), visitor_id: 'v1', session_id: 's1', event: 'generation_error', props: { feature: 'video', detail: 'HTTP 500 — Internal error' } },
    { created_at: new Date().toISOString(), visitor_id: 'v3', session_id: 's3', event: 'project_created', props: { type: 'pub' } },
    { created_at: new Date().toISOString(), visitor_id: 'v3', session_id: 's3', event: 'tab_view', props: { tab: 'motion' } }
];

const GOOD_EMAIL = 'admin@test.com';
const GOOD_PASSWORD = 'password-de-test';

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
        function builder(rowsForRequest) {
            const b = {
                select() { return b; }, gte() { return b; }, lt() { return b; },
                order() { return b; }, limit() { return b; },
                then(resolve) {
                    const session = api._session;
                    if (window.__rlsEnabled && (!session || session.user.email !== window.__GOOD_EMAIL)) {
                        resolve({ data: null, error: { message: 'permission denied for table analytics_events' } });
                    } else resolve({ data: rowsForRequest, error: null });
                }
            };
            return b;
        }
        const api = {
            _session: null, _listeners: [],
            auth: {
                getSession() { return Promise.resolve({ data: { session: api._session }, error: null }); },
                signInWithPassword(creds) {
                    if (creds.email === window.__GOOD_EMAIL && creds.password === window.__GOOD_PASSWORD) {
                        const session = { user: { id: 'uid-1', email: creds.email }, expires_at: Math.floor(Date.now() / 1000) + 3600 };
                        api._session = session;
                        api._listeners.forEach(cb => cb('SIGNED_IN', session));
                        return Promise.resolve({ data: { user: session.user, session }, error: null });
                    }
                    return Promise.resolve({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } });
                },
                signOut() { api._session = null; api._listeners.forEach(cb => cb('SIGNED_OUT', null)); return Promise.resolve({ error: null }); },
                onAuthStateChange(cb) { api._listeners.push(cb); return { data: { subscription: {} } }; }
            },
            from() { return builder(window.__EVENTS); }
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
                '";window.__EVENTS=' + JSON.stringify(EVENTS) + ';window.supabase=(' + fake.toString() + ')();</script>')
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
    const pages = ['images', 'videos', 'chat', 'motion', 'activity', 'errors', 'settings', 'overview'];
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
    check('8 pages navigables sans exception', pagesOk);

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

    console.log('\n=== I. SANITÉ ===');
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
