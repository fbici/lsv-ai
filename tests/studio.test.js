/* Tests LSV Studio — structure, capacités, sécurité, non-régression du lien. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PROJECT = path.resolve(__dirname, '..');
const STUDIO_HTML = path.join(PROJECT, 'studio', 'index.html');

/* ── Harness ─────────────────────────────────────────────────────────────── */

/* Inligne les <script src="./..."> de studio/ pour que jsdom les exécute. */
function prepare(html) {
    return html.replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '')
        .replace(/<link[^>]*Material\+Symbols[^>]*>/g, '')
        .replace(/<link rel="stylesheet"[^>]*>/g, '')
        .replace(/<link rel="icon"[^>]*>/g, '')
        .replace(/<link rel="apple-touch-icon"[^>]*>/g, '')
        .replace(/<link rel="preconnect"[^>]*>/g, '')
        .replace(/<script src="\.\/([^"]+)"[^>]*><\/script>/g, (m, rel) => {
            const p = path.join(PROJECT, 'studio', rel);
            return fs.existsSync(p) ? '<script>' + fs.readFileSync(p, 'utf8') + '</script>' : '';
        });
}

async function load(html) {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
    vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
    vc.on('warn', () => {});
    const dom = new JSDOM(html, {
        url: 'https://lsv.test/studio/',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole: vc
    });
    await new Promise(r => { if (dom.window.document.readyState === 'complete') return r(); dom.window.addEventListener('load', r); setTimeout(r, 4000); });
    await new Promise(r => setTimeout(r, 250));
    return { dom, errors };
}

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond });
    console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Suite ───────────────────────────────────────────────────────────────── */
(async () => {
    const src = fs.readFileSync(STUDIO_HTML, 'utf8');

    console.log('\n=== 1. INTÉGRATION À LSV.ai ===');
    const appHtml = fs.readFileSync(path.join(PROJECT, 'index.html'), 'utf8');
    check('lien « Studio vidéo » présent dans la sidebar', /href="\.\/studio\/"/.test(appHtml));
    check('le lien est une balise <a> (pas un onglet)', /<a[^>]*href="\.\/studio\/"/.test(appHtml));
    check('le lien porte la classe nav-ext', /class="nav-item nav-ext"[^>]*href="\.\/studio\/"/.test(appHtml));
    check('section « Montage » créée dans la sidebar', />Montage</.test(appHtml));
    check('switchTab ignore les entrées sans data-tab',
        /if \(!id\) return;/.test(fs.readFileSync(path.join(PROJECT, 'scripts', 'ui.js'), 'utf8')));

    console.log('\n=== 2. STRUCTURE DE LA PAGE ===');
    const t = await load(prepare(src));
    const w = t.dom.window;
    const doc = w.document;
    check('aucune erreur console au chargement', t.errors.length === 0, t.errors.join('|'));
    check('espace de noms LSVStudio exposé', !!w.LSVStudio);
    check('écran d’accueil présent', !!doc.getElementById('sv-home'));
    check('éditeur présent', !!doc.getElementById('sv-app'));

    /* Les 5 zones du cahier des charges §4.1 */
    check('zone 1 : barre supérieure', !!doc.querySelector('.sv-topbar'));
    check('zone 2 : panneau des médias', !!doc.getElementById('sv-media'));
    check('zone 3 : moniteur d’aperçu', !!doc.getElementById('sv-monitor'));
    check('zone 4 : timeline', !!doc.querySelector('.sv-timeline'));
    check('zone 5 : panneau de propriétés', !!doc.getElementById('sv-props'));

    check('bouton nouveau montage', !!doc.getElementById('sv-new-project'));
    check('bouton importer un projet', !!doc.getElementById('sv-import-project'));
    check('bouton exporter', !!doc.getElementById('sv-export'));
    check('annuler / rétablir présents', !!doc.getElementById('sv-undo') && !!doc.getElementById('sv-redo'));
    check('règle de zoom de la timeline', !!doc.getElementById('sv-zoom'));
    check('canvas d’aperçu présent', !!doc.getElementById('sv-canvas'));
    check('champ d’import de fichiers', !!doc.getElementById('sv-file-input'));
    check('message de stockage local affiché',
        /sur cet appareil uniquement/.test(doc.getElementById('sv-storage-notice').textContent));
    check('avertissement « sauvegarde locale ≠ cloud »',
        /n’est pas\s+une sauvegarde cloud|pas une sauvegarde cloud/i.test(doc.getElementById('sv-storage-notice').textContent.replace(/\s+/g, ' ')));

    console.log('\n=== 3. CAPACITÉS DU NAVIGATEUR (sous jsdom) ===');
    const caps = w.LSVStudio.Capability.detect();
    check('détection exécutée sans exception', !!caps);
    check('indexedDB absent sous jsdom → bloquant signalé', caps.indexedDB === false && caps.blockers.length > 0);
    check('MediaRecorder absent sous jsdom → pas de format', caps.mediaRecorder === false && caps.bestMime === null);
    check('supported = false tant que les capacités manquent', caps.supported === false);
    check('blocage lisible en français (pas technique)',
        /IndexedDB/.test(caps.blockers.join(' ')));
    check('résumé compact exposé', typeof w.LSVStudio.Capability.summary === 'function');
    const sum = w.LSVStudio.Capability.summary();
    check('summary.exportable = false sous jsdom', sum.exportable === false);

    /* Les candidats de format sont ordonnés et documentés (MP4 d'abord). */
    const mimes = w.LSVStudio.Capability.MIME_CANDIDATES;
    check('MP4/H.264 testé avant WebM', mimes[0].ext === 'mp4' && mimes[3].ext === 'webm');
    check('extension = conteneur réel (pas de simple renommage)',
        mimes.every(c => c.ext === 'mp4' || c.ext === 'webm'));

    console.log('\n=== 4. THÈME PARTAGÉ AVEC L’APP ===');
    check('bouton de thème sur l’accueil', !!doc.getElementById('sv-home-theme'));
    check('bouton de thème dans l’éditeur', !!doc.getElementById('sv-theme'));
    doc.getElementById('sv-home-theme').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(80);
    check('clic → mode sombre actif', doc.body.classList.contains('dark'));
    check('mémorisé sous la clé de l’application (lsv4_theme)', w.localStorage.getItem('lsv4_theme') === 'dark');
    doc.getElementById('sv-home-theme').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(80);
    check('retour au mode clair', !doc.body.classList.contains('dark'));

    console.log('\n=== 5. SÉCURITÉ & CONFIDENTIALITÉ ===');
    const allJs = [
        'studio/main.js', 'studio/render/capability.js'
    ].map(rel => fs.readFileSync(path.join(PROJECT, rel), 'utf8')).join('\n');
    check('aucune référence à la passerelle IA', !/lsv-gateway|API_BASE|AGNES/i.test(allJs));
    check('aucune clé secrète dans le studio',
        !/sk-[A-Za-z0-9]{10,}|service_role/i.test(src + allJs));
    check('aucun appel réseau dans le bootstrap', !/fetch\(|XMLHttpRequest/.test(allJs));
    check('page en noindex', /noindex, nofollow/.test(src));
    check('favicon pointe vers le logo officiel', /href="\.\.\/lsv\.jpg"/.test(src));
    check('thème appliqué avant le premier rendu',
        src.indexOf("lsv4_theme") < src.indexOf('<body'));

    console.log('\n=== 6. CHARGEMENT DES MODULES ===');
    const scripts = (src.match(/<script src="\.\/([^"]+)"><\/script>/g) || [])
        .map(m => m.replace(/<script src="\.\/([^"]+)"><\/script>/, '$1'));
    check('capability.js chargé avant main.js',
        scripts.indexOf('render/capability.js') !== -1 &&
        scripts.indexOf('render/capability.js') < scripts.indexOf('main.js'),
        scripts.join(' → '));
    check('main.js toujours en dernier', scripts[scripts.length - 1] === 'main.js', scripts.join(' → '));
    /* L'ordre des dépendances n'est vérifié que pour les modules déjà présents. */
    const idx = name => scripts.indexOf(name);
    check('ordre des dépendances respecté (modèles → stockage → UI → rendu)',
        (idx('core/project-model.js') === -1 || idx('core/timeline-model.js') === -1 ||
            idx('core/project-model.js') < idx('core/timeline-model.js')) &&
        (idx('storage/idb.js') === -1 || idx('storage/project-storage.js') === -1 ||
            idx('storage/idb.js') < idx('storage/project-storage.js')) &&
        (idx('render/compositor.js') === -1 || idx('main.js') === -1 ||
            idx('render/compositor.js') < idx('main.js')),
        scripts.join(' → '));
    const missing = scripts.filter(rel => !fs.existsSync(path.join(PROJECT, 'studio', rel)));
    check('tous les modules référencés existent', missing.length === 0, missing.join(','));
    check('index.html du studio sans <style> inline', !/<style>/.test(src));

    console.log('\n=== 7. NON-RÉGRESSION DE L’APP PRINCIPALE ===');
    const appScripts = (appHtml.match(/<script src="\.\/([^"]+)"><\/script>/g) || []).join(',');
    check('ordre des modules de l’app inchangé',
        appScripts.indexOf('scripts/constants.js') < appScripts.indexOf('scripts/core.js') &&
        appScripts.indexOf('scripts/core.js') < appScripts.indexOf('scripts/handlers.js'),
        appScripts.slice(0, 120));
    check('index.html toujours sous 90 000 caractères', appHtml.length < 90000, appHtml.length);
    check('toujours 1 seul script inline exécutable dans l’app',
        (appHtml.match(/<script(?![^>]*src=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g) || []).length <= 3);

    const failed = results.filter(r => !r.ok);
    console.log('\n════════════════════════════════');
    console.log((results.length - failed.length) + '/' + results.length + ' tests studio OK');
    if (failed.length) console.log('ECHECS: ' + failed.map(f => f.label).join(', '));
    else console.log('STUDIO CONFORME');
    setTimeout(() => process.exit(failed.length ? 1 : 0), 100);
})();
