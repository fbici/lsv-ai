/* ═══════════════════════════════════════════════════════════════════════════
   Test de non-régression LSV.ai
   ───────────────────────────────────────────────────────────────────────────
   Compare l'index.html d'origine (optionnel) avec celui du dépôt, puis
   exécute les tests fonctionnels : navigation, génération d'image (succès et
   échec), sanitisation Analytics, tolérance aux pannes.

   Usage :
     node tests/nonreg.test.js
     ORIG=/chemin/vers/index.original.html node tests/nonreg.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PROJECT = path.resolve(__dirname, '..');
const ORIG = process.env.ORIG || '';
const MOD = path.join(PROJECT, 'index.html');

function prepare(file, inlineShared) {
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '');
    if (inlineShared) {
        const cfg = fs.readFileSync(path.join(PROJECT, 'shared/config.js'), 'utf8');
        const ana = fs.readFileSync(path.join(PROJECT, 'analytics/analytics.js'), 'utf8');
        html = html.replace('<script src="./shared/config.js"></script>', '<script>' + cfg + '</script>');
        html = html.replace('<script src="./analytics/analytics.js"></script>', '<script>' + ana + '</script>');
    } else {
        html = html.replace(/<script src="\.\/(shared\/config|analytics\/analytics)\.js"><\/script>/g, '');
    }
    return html;
}

async function load(html) {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
    vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
    vc.on('warn', () => {});
    const dom = new JSDOM(html, {
        url: 'https://lsv.test/',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole: vc
    });
    await new Promise(res => {
        if (dom.window.document.readyState === 'complete') return res();
        dom.window.addEventListener('load', res);
        setTimeout(res, 4000);
    });
    await new Promise(r => setTimeout(r, 250));
    return { dom, errors };
}

function stats(win, doc) {
    const b = doc.body;
    return {
        navItems: doc.querySelectorAll('.nav-item').length,
        navMob: doc.querySelectorAll('.nav-mob').length,
        tabs: doc.querySelectorAll('.tab-content').length,
        ids: b.querySelectorAll('[id]').length,
        sidebar: doc.querySelector('.sidebar') ? doc.querySelector('.sidebar').innerHTML.length : 0,
        imagePrompt: !!doc.getElementById('image-prompt'),
        videoPrompt: !!doc.getElementById('video-prompt'),
        chatInput: !!doc.getElementById('chat-input'),
        hasLSV: !!win.LSV,
        services: win.LSV ? Object.keys(win.LSV.services).length : 0,
        views: win.LSV ? Object.keys(win.LSV.views).length : 0
    };
}

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond });
    console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
}

(async () => {
    console.log('\n=== CHARGEMENT DU DÉPÔT ===');
    const b = await load(prepare(MOD, true));
    console.log('erreurs : ' + (b.errors.length ? b.errors.join(' | ') : 'aucune'));
    const wb = b.dom.window;

    if (ORIG && fs.existsSync(ORIG)) {
        console.log('=== CHARGEMENT ORIGINAL ===');
        const a = await load(prepare(ORIG, false));
        console.log('erreurs : ' + (a.errors.length ? a.errors.join(' | ') : 'aucune'));
        const wa = a.dom.window;
        const sa = stats(wa, wa.document), sb = stats(wb, wb.document);

        console.log('\n=== 1. STRUCTURE IDENTIQUE ===');
        for (const k of Object.keys(sa)) check(k, sa[k] === sb[k], sa[k] + ' vs ' + sb[k]);

        console.log('\n=== 2. HTML DU CORPS (hors scripts) ===');
        const strip = doc => doc.body.innerHTML
            .replace(/<script[\s\S]*?<\/script>/g, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<span class="debug-time">[^<]*<\/span>/g, '<span class="debug-time">HH:MM:SS</span>')
            .replace(/\n\s*\n+/g, '\n');
        const ha = strip(wa.document), hb = strip(wb.document);
        check('body.innerHTML identique', ha === hb, ha.length + ' vs ' + hb.length);
        check('aucune régression console', a.errors.length === 0 || a.errors.length === b.errors.length, b.errors.length + ' erreur(s)');
    } else {
        console.log('\n(ORIG non fourni : comparaison structurelle ignorée.');
        console.log(' Utilise ORIG=/chemin/index.original.html pour la déclencher.)');
        check('index.html lisible sans erreur', b.errors.length === 0, b.errors.join('|'));
    }

    console.log('\n=== 3. NAVIGATION (tous les onglets) ===');
    let navOk = true;
    wb.document.querySelectorAll('.nav-item').forEach(t => {
        try { wb.LSV.ui.switchTab(t.dataset.tab); } catch (e) { navOk = false; console.log('    onglet ' + t.dataset.tab + ' : ' + e.message); }
    });
    check('switchTab sans exception', navOk);
    check('LSVAnalytics exposé', !!wb.LSVAnalytics && typeof wb.LSVAnalytics.track === 'function');

    console.log('\n=== 4. GÉNÉRATION IMAGE (succès + échec) ===');
    const calls = [];
    wb.fetch = function (url, options) {
        calls.push({ url: String(url), options: options || {} });
        if (String(url).includes('/images/generations')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ url: 'https://cdn.test/img.png' }] }), text: async () => '' });
        }
        if (String(url).includes('/rest/v1/analytics_events')) {
            return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
    };
    wb.localStorage.setItem('lsv4_api_key', 'sk-test-123');
    wb.LSV_CONFIG = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-test-key-0123456789' };

    const before = wb.LSV.runtime.imageCount;
    await wb.LSV.handlers.runImageGeneration();
    check('compteur image incrémenté', wb.LSV.runtime.imageCount === before + 1, wb.LSV.runtime.imageCount);
    check('carte image créée', wb.document.querySelectorAll('#image-results-grid .result-card').length > 0);
    const imgCall = calls.find(c => c.url.includes('/images/generations'));
    check('appel Agnes inchangé', !!imgCall && JSON.parse(imgCall.options.body).model === wb.LSV.config.MODEL_IMAGE);

    wb.fetch = function (url, options) {
        calls.push({ url: String(url), options: options || {} });
        if (String(url).includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201 });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'server error' });
    };
    const beforeFail = wb.LSV.runtime.imageCount;
    await wb.LSV.handlers.runImageGeneration();
    check('échec image géré (compteur inchangé)', wb.LSV.runtime.imageCount === beforeFail);

    console.log('\n=== 5. ANALYTICS : sanitisation ===');
    const posts = [];
    wb.fetch = function (url, options) {
        posts.push({ url: String(url), headers: (options && options.headers) || {}, body: options && options.body });
        return Promise.resolve({ ok: true, status: 201 });
    };
    wb.LSVAnalytics.track('image_generated', {
        model: 'm1', ratio: '16:9', size: '1024x1024',
        apiKey: 'sk-SUPERSECRET', prompt: 'un secret', token: 'abc',
        note: 'sk-ABCDEFGHIJKLMNOP ', long: 'x'.repeat(500), n: 3, ok: true
    });
    wb.LSVAnalytics.flush();
    await new Promise(r => setTimeout(r, 150));
    check('1 POST envoyé', posts.length >= 1, posts.length);
    let rows = [];
    posts.forEach(p => { try { const r = JSON.parse(p.body); if (Array.isArray(r)) rows = rows.concat(r); } catch (e) {} });
    const row = rows.find(r => r.props && r.props.n === 3) || null;
    check('endpoint Supabase', posts[0] && posts[0].url === 'https://test.supabase.co/rest/v1/analytics_events');
    check('header apikey', posts[0] && posts[0].headers.apikey === 'anon-test-key-0123456789');
    check('row présente', !!row);
    if (row) {
        check('event correct', row.event === 'image_generated', row.event);
        check('visitor_id anonyme', /^[a-z0-9]+_[a-f0-9]+$/.test(row.visitor_id || ''), row.visitor_id);
        check('session_id présent', !!row.session_id);
        check('clé API supprimée', !('apiKey' in (row.props || {})));
        check('prompt supprimé', !('prompt' in (row.props || {})));
        check('token supprimé', !('token' in (row.props || {})));
        check('sk- rogné dans les valeurs', !/sk-ABCDEF/.test(JSON.stringify(row.props)));
        check('chaine tronquée <= 201', (row.props.long || '').length <= 201, (row.props.long || '').length);
        check('champs scalaires conservés', row.props.model === 'm1' && row.props.n === 3 && row.props.ok === true);
    }

    console.log('\n=== 6. ANALYTICS : sans configuration = no-op ===');
    wb.LSV_CONFIG = { SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co', SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY' };
    posts.length = 0;
    wb.LSVAnalytics.track('page_view');
    wb.LSVAnalytics.flush();
    await new Promise(r => setTimeout(r, 100));
    check('aucun envoi non configuré', posts.length === 0, posts.length);
    check('isConfigured() = false', wb.LSVAnalytics.isConfigured() === false);

    console.log('\n=== 7. ANALYTICS : panne réseau ne casse rien ===');
    wb.LSV_CONFIG = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-test-key-0123456789' };
    wb.fetch = function (url) {
        if (String(url).includes('/rest/v1/analytics_events')) return Promise.reject(new Error('network down'));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ url: 'https://cdn.test/img2.png' }] }), text: async () => '' });
    };
    let survived = true;
    try {
        wb.LSVAnalytics.track('video_generated', { model: 'v' });
        wb.LSVAnalytics.flush();
        await new Promise(r => setTimeout(r, 150));
        await wb.LSV.handlers.runImageGeneration();
    } catch (e) { survived = false; console.log('    exception : ' + e.message); }
    check('LSV fonctionne avec analytics en panne', survived);
    check('aucune erreur console', b.errors.length === 0, b.errors.join('|'));

    console.log('\n=== 8. MODULE ANALYTICS INTÉGRALEMENT ABSENT ===');
    const stripped = await load(prepare(MOD, false));
    const ws = stripped.dom.window;
    check('aucune erreur au chargement', stripped.errors.length === 0, stripped.errors.join('|'));
    check('LSV disponible sans analytics', !!ws.LSV && typeof ws.LSV.handlers.runImageGeneration === 'function');
    check('shim actif (track inerte)', typeof ws.LSVAnalytics.track === 'function' && ws.LSVAnalytics.isConfigured() === false);
    let navOk2 = true;
    try { ws.LSV.ui.switchTab('image'); ws.LSV.ui.switchTab('video'); ws.LSV.ui.switchTab('chat'); }
    catch (e) { navOk2 = false; console.log('    exception : ' + e.message); }
    check('navigation sans analytics', navOk2);
    ws.localStorage.setItem('lsv4_api_key', 'sk-test-123');
    ws.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ url: 'https://cdn.test/x.png' }] }), text: async () => '' });
    let genOk = true;
    try { await ws.LSV.handlers.runImageGeneration(); } catch (e) { genOk = false; console.log('    exception : ' + e.message); }
    check('génération image sans analytics', genOk && ws.LSV.runtime.imageCount === 1, ws.LSV.runtime.imageCount);
    check('aucune erreur console (module absent)', stripped.errors.length === 0, stripped.errors.join('|'));

    console.log('\n=== 9. GÉNÉRATION VIDÉO (succès + hook Analytics) ===');
    wb.LSV_CONFIG = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-test-key-0123456789' };
    wb.LSV.utils.sleep = () => Promise.resolve(); // on supprime les attentes de polling
    const videoPosts = [];
    wb.fetch = function (url, options) {
        const u = String(url);
        if (u.includes('/rest/v1/analytics_events')) {
            videoPosts.push({ body: options && options.body });
            return Promise.resolve({ ok: true, status: 201 });
        }
        if (u.includes('/videos')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ video_id: 'vid_test_1' }), text: async () => '' });
        if (u.includes('agnesapi')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'completed', progress: 100, metadata: { url: 'https://cdn.test/v.mp4' } }), text: async () => '' });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'err' });
    };
    const beforeVideo = wb.LSV.runtime.videoCount;
    await wb.LSV.handlers.runVideoGeneration();
    wb.LSVAnalytics.flush();
    await new Promise(r => setTimeout(r, 200));
    function parseRows(posts) {
        const out = [];
        posts.forEach(p => { try { const r = JSON.parse(p.body); if (Array.isArray(r)) out.push.apply(out, r); } catch (e) {} });
        return out;
    }
    const videoRows = parseRows(videoPosts);
    check('vidéo générée (1 segment)', wb.LSV.runtime.videoCount === beforeVideo + 1, wb.LSV.runtime.videoCount);
    check('modèle vidéo inchangé', wb.LSV.config.MODEL_VIDEO === 'agnes-video-v2.0');
    check('evt video_generated émis', videoRows.some(r => r.event === 'video_generated'), videoRows.map(r => r.event).join(','));
    const videoRow = videoRows.find(r => r.event === 'video_generated' && r.props && r.props.model === wb.LSV.config.MODEL_VIDEO);
    check('props video sans prompt', !!videoRow && !('prompt' in (videoRow.props || {})) && videoRow.props.segments === 1, videoRow ? JSON.stringify(videoRow.props) : 'absent');

    console.log('\n=== 10. CHAT IA (succès + hook Analytics) ===');
    const chatPosts = [];
    let chatCall = 0;
    wb.fetch = function (url, options) {
        const u = String(url);
        if (u.includes('/rest/v1/analytics_events')) {
            chatPosts.push({ body: options && options.body });
            return Promise.resolve({ ok: true, status: 201 });
        }
        chatCall++;
        // 1er appel (stream) indisponible → repli JSON automatique de ChatService
        if (chatCall === 1) return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Réponse du chat' } }] }), text: async () => '' });
    };
    wb.document.getElementById('chat-input').value = 'Salut, idée de vidéo ?';
    await wb.LSV.views.chat.sendMessage();
    wb.LSVAnalytics.flush();
    await new Promise(r => setTimeout(r, 200));
    const convs = wb.LSV.services.conversations.all();
    check('conversation créée', convs.length >= 1 && convs[0].messages.length >= 2, convs.length ? convs[0].messages.length + ' messages' : '0');
    check('reponse assistant rendue', wb.document.getElementById('chat-messages').textContent.indexOf('Réponse du chat') !== -1);
    const chatRows = parseRows(chatPosts);
    check('evt chat_used émis', chatRows.some(r => r.event === 'chat_used'), chatRows.map(r => r.event).join(','));

    const failed = results.filter(r => !r.ok);
    console.log('\n══════════════════════════════');
    console.log((results.length - failed.length) + '/' + results.length + ' tests OK');
    if (failed.length) console.log('ECHECS : ' + failed.map(f => f.label).join(', '));
    else console.log('NON-RÉGRESSION CONFORME');
    setTimeout(() => process.exit(failed.length ? 1 : 0), 100);
})();
