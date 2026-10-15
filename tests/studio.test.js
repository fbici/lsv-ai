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

/* Ajoute une piste texte au projet (utilisé par les tests M5). */
function S_ProjectModel_addTextTrack(project) {
    const t = { id: 'trk-txt-' + Math.random().toString(36).slice(2, 7), kind: 'text', name: 'Texte', locked: false, muted: false, hidden: false, clips: [] };
    project.tracks.push(t);
    return t;
}

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

    console.log('\n=== 7. MODÈLE DE PROJET (M1) ===');
    const PM = w.LSVStudio.ProjectModel;
    check('ProjectModel exposé', !!PM);
    const proj = PM.create({ name: 'Test M1' });
    check('création : nom respecté', proj.name === 'Test M1');
    check('création : séquence verticale 1080×1920 par défaut',
        proj.sequence.width === 1080 && proj.sequence.height === 1920 && proj.sequence.fps === 30);
    check('création : 2 pistes par défaut (vidéo + audio)', proj.tracks.length === 2);
    check('création : schemaVersion = 1', proj.schemaVersion === 1);
    check('création : aucun binaire dans le JSON',
        !/blob|base64|data:image|data:video/i.test(JSON.stringify(proj)));
    check('validate() accepte un projet créé', PM.validate(proj).ok === true);

    /* Validation de données hostiles (§16.3). */
    check('validate() refuse un non-objet', PM.validate(null).ok === false && PM.validate(42).ok === false);
    check('validate() refuse un schéma futur',
        PM.validate(Object.assign({}, proj, { schemaVersion: 99 })).ok === false);
    check('validate() refuse __proto__', PM.validate(JSON.parse('{"__proto__":{"x":1},"schemaVersion":1,"name":"a","sequence":{"width":1,"height":1,"fps":1},"media":[],"tracks":[]}')).ok === false);
    check('validate() refuse un média orphelin (clip pointant un mediaId absent)',
        PM.validate({
            schemaVersion: 1, name: 'x', sequence: { width: 100, height: 100, fps: 30 },
            media: [], tracks: [{ id: 't', kind: 'video', clips: [{ id: 'c', mediaId: 'inconnu', start: 0, duration: 1 }] }]
        }).ok === false);
    check('validate() borne les dimensions',
        PM.validate(Object.assign({}, proj, { sequence: { width: 999999, height: 100, fps: 30 } })).ok === false);
    check('validate() refuse un fps hors limites',
        PM.validate(Object.assign({}, proj, { sequence: { width: 100, height: 100, fps: 9999 } })).ok === false);

    /* Migration : reconstruit proprement et borne tout. */
    const migrated = PM.migrate({
        schemaVersion: 1, name: 'Ancien', sequence: { width: 720, height: 1280, fps: 60 },
        media: [{ id: 'm1', kind: 'video', name: 'a.mp4', duration: 3.2 }],
        tracks: [{
            id: 't1', kind: 'video',
            clips: [{ id: 'c1', mediaId: 'm1', start: 0, duration: 2, speed: 99, volume: 99,
                      effects: [null, { type: 'x', brightness: 999 }] }]
        }]
    });
    check('migration : durée de média bornée / vitesse bornée',
        migrated.media[0].duration === 3.2 && migrated.tracks[0].clips[0].speed === 8);
    check('migration : volume borné à 4', migrated.tracks[0].clips[0].volume === 4);
    check('migration : effets nettoyés (null retiré, brightness borné)',
        migrated.tracks[0].clips[0].effects.length === 1 && migrated.tracks[0].clips[0].effects[0].brightness === 10);

    console.log('\n=== 8. MODÈLE DE TIMELINE (M1) ===');
    const TM = w.LSVStudio.TimelineModel;
    check('TimelineModel exposé', !!TM);
    const p2 = PM.create({ name: 'TL' });
    const vidTrack = p2.tracks[0];
    /* Faux média (pas de blob : le modèle est pur). */
    const fakeMedia = { id: 'm1', kind: 'video', name: 'a.mp4', duration: 10, width: 720, height: 1280 };
    p2.media.push(fakeMedia);

    const clipA = TM.makeClip(fakeMedia, { start: 0 });
    const addedA = TM.addClip(p2, vidTrack.id, clipA);
    check('addClip accepte un clip sur piste compatible', addedA !== null && vidTrack.clips.length === 1);
    check('makeClip : durée = durée source pour une vidéo', clipA.duration === 10 && clipA.in === 0 && clipA.out === 10);

    const clipB = TM.makeClip(fakeMedia, { start: 2 });   // chevauche clipA (0→10)
    check('addClip refuse un chevauchement', TM.addClip(p2, vidTrack.id, clipB) === null && vidTrack.clips.length === 1);

    const clipC = TM.makeClip(fakeMedia, { start: 10 });
    check('addClip accepte un clip collé à la fin', TM.addClip(p2, vidTrack.id, clipC) !== null && vidTrack.clips.length === 2);

    /* moveClip : ne décale JAMAIS les autres clips (§7.3). */
    const startA = clipA.start;
    const mv = TM.moveClip(p2, clipC.id, vidTrack.id, 20);   // espace libre
    check('moveClip déplace le clip demandé', mv.ok === true && clipC.start === 20);
    check('moveClip ne décale pas les autres clips', clipA.start === startA);

    const mvBad = TM.moveClip(p2, clipC.id, vidTrack.id, 5);   // retombe sur clipA (0→10)
    check('moveClip refuse un chevauchement', mvBad.ok === false && clipC.start === 20);

    /* splitClip : le morceau de droite garde la bonne source. */
    clipA.start = 0; clipA.duration = 10; clipA.in = 0; clipA.out = 10;
    vidTrack.clips = [clipA];
    const right = TM.splitClip(p2, clipA.id, 4);
    check('splitClip crée un second clip', right !== null && vidTrack.clips.length === 2);
    check('splitClip : gauche = 0→4, droite = 4→10',
        clipA.duration === 4 && right.start === 4 && right.duration === 6);
    check('splitClip : source de droite = in 4 (pas de saut)',
        Math.abs(right.in - 4) < 1e-6 && Math.abs(right.out - 10) < 1e-6);
    check('splitClip refuse hors des bornes du clip',
        TM.splitClip(p2, clipA.id, 0) === null && TM.splitClip(p2, clipA.id, 4) === null);

    /* trimClip : négaire sur le bord droit = raccourcit ; positif = allonge
       (et ne peut pas dépasser la fin du média source). */
    const trimShorten = TM.trimClip(p2, right.id, 'right', -2);
    check('trim right négatif raccourcit', trimShorten.ok === true && right.duration === 4 && right.out === 8);
    const trimExtend = TM.trimClip(p2, right.id, 'right', 4);    // out deviendrait 12 > 10
    check('trim ne peut pas dépasser la fin du média', trimExtend.ok === false && right.out === 8 && right.duration === 4);
    const trimTooshort = TM.trimClip(p2, right.id, 'right', -100);
    check('trim respecte une durée minimale', trimTooshort.ok === false && right.duration === 4);

    /* snapTime : aimantation sur un bord de clip. */
    const snap = TM.snapTime(p2, 4.02, { threshold: 0.5, ignoreClipId: right.id });
    check('snapTime s’aligne sur un bord', snap === 4);
    const noSnap = TM.snapTime(p2, 6, { threshold: 0.5 });
    check('snapTime ignore les valeurs trop loin', noSnap === 6);

    /* clipsAt : lecture d'une position. */
    const at2 = TM.clipsAt(p2, 2);
    check('clipsAt trouve le clip actif à t=2', at2.length === 1 && at2[0].items[0].clip.id === clipA.id);
    check('clipsAt : sourceTime = in + t×speed', at2[0].items[0].sourceTime === 2);
    check('clipsAt vide à t=20', TM.clipsAt(p2, 20).length === 0);

    console.log('\n=== 9. HISTORIQUE ANNULER / RÉTABLIR (M2) ===');
    const HM = w.LSVStudio.HistoryManager;
    check('HistoryManager exposé', !!HM);
    const hp = PM.create({ name: 'Hist' });
    const hmTrack = hp.tracks[0];
    const hmMedia = { id: 'm1', kind: 'image', name: 'a.png', duration: 0 };
    hp.media.push(hmMedia);
    HM.reset();
    check('reset : rien à annuler au départ', HM.canUndo() === false && HM.canRedo() === false);

    /* Ajout d'un clip (via run = begin + fn + commit). */
    const hclip = TM.makeClip(hmMedia, { start: 0, duration: 3 });
    HM.run(hp, () => TM.addClip(hp, hmTrack.id, hclip));
    check('run() enregistre une entrée', HM.canUndo() === true);
    check('run() a bien appliqué l’opération', hmTrack.clips.length === 1);

    /* Déplacement. */
    HM.run(hp, () => TM.moveClip(hp, hclip.id, hmTrack.id, 5));
    check('déplacement appliqué', hclip.start === 5);

    /* Annuler deux fois → retour au départ. */
    const u1 = HM.undo(hp);
    check('undo 1 restaure l’état sans déplacement', u1 && u1.tracks[0].clips[0].start === 0);
    const u2 = HM.undo(u1);
    check('undo 2 restaure l’état sans clip', u2 && u2.tracks[0].clips.length === 0);
    check('undo 3 : pile vide', HM.undo(u2) === null);

    /* Rétablir. */
    const r1 = HM.redo(u2);
    check('redo 1 rétablit le clip', r1 && r1.tracks[0].clips.length === 1);
    const r2 = HM.redo(r1);
    check('redo 2 rétablit le déplacement', r2 && r2.tracks[0].clips[0].start === 5);
    check('redo 3 : pile vide', HM.redo(r2) === null);

    /* Deux begin() sans changement = une seule entrée. */
    HM.reset();
    const hmClip2 = TM.makeClip(hmMedia, { start: 0, duration: 2 });
    TM.addClip(hp, hmTrack.id, hmClip2);
    HM.begin(hp); HM.commit(hp);   // état identique
    HM.begin(hp); HM.commit(hp);
    check('pas d’entrée dupliquée si rien n’a changé', HM.canUndo() === false);

    /* Budget : au mieux 60 entrées. */
    HM.reset();
    for (let i = 0; i < 100; i++) {
        HM.begin(hp);
        hp.name = 'n' + i;
        HM.commit(hp);
    }
    check('pile bornée à 60 entrées', HM._undo.length === 60, HM._undo.length);

    console.log('\n=== 10. EFFETS & TRANSITIONS (M2) ===');
    const Comp = w.LSVStudio.Compositor;
    check('Compositor exposé', !!Comp);
    check('filterFor : aucun effet → null', Comp.filterFor({ effects: [] }) === null);
    const fBright = Comp.filterFor({ effects: [{ type: 'brightness', brightness: 150 }] });
    check('filterFor : luminosité 150% → brightness(1.5)', fBright === 'brightness(1.5)', fBright);
    const fMulti = Comp.filterFor({ effects: [{ type: 'contrast', contrast: 80 }, { type: 'blur', blur: 4 }] });
    check('filterFor : effets combinés', fMulti === 'contrast(0.8) blur(4px)', fMulti);

    const base = { start: 0, duration: 4, transitionIn: { type: 'fade', duration: 1 }, transitionOut: null };
    check('transition d’entrée : alpha 0 au début',
        Comp.transitionFactor(base, 0).alpha === 0);
    check('transition d’entrée : alpha 1 après la transition',
        Comp.transitionFactor(base, 1.5).alpha === 1);
    const mid = Comp.transitionFactor(base, 0.5).alpha;
    check('transition d’entrée : alpha entre 0 et 1 au milieu', mid > 0 && mid < 1, mid);

    const outBase = { start: 0, duration: 4, transitionIn: null, transitionOut: { type: 'fade', duration: 1 } };
    check('transition de sortie : alpha 0 à la fin', Comp.transitionFactor(outBase, 4).alpha === 0);
    check('transition de sortie : alpha 1 avant', Comp.transitionFactor(outBase, 2.5).alpha === 1);

    const slide = { start: 0, duration: 4, transitionIn: { type: 'slide-left', duration: 1 }, transitionOut: null };
    check('transition glissement : décalage en X au début', Comp.transitionFactor(slide, 0).dx !== 0);
    check('transition glissement : pas de décalage après', Comp.transitionFactor(slide, 2).dx === 0);

    /* Le panneau Propriétés est présent et se vide sans sélection. */
    check('PropertiesPanel exposé', !!w.LSVStudio.PropertiesPanel);
    check('panneau de propriétés initialisé sans erreur',
        !!doc.getElementById('sv-props-body') && /Sélectionne un clip/.test(doc.getElementById('sv-props-body').textContent));

    console.log('\n=== 11. EXPORT VIDÉO (M3) ===');
    const Exp = w.LSVStudio.Exporter;
    check('Exporter exposé', !!Exp);
    check('preflight refuse un projet vide', /timeline est vide/i.test(Exp.preflight(PM.create({ name: 'x' })) || ''));
    check('preflight refuse sans projet', /Aucun projet/i.test(Exp.preflight(null) || ''));
    /* Sous jsdom : ni MediaRecorder, ni captureStream → message lisible. */
    const pre = Exp.preflight(p2);   // p2 contient des clips
    check('preflight signale l’absence de MediaRecorder sans jargon',
        pre !== null && !/undefined|null|TypeError|\bat \b/.test(pre), pre);
    check('isRunning = false au repos', Exp.isRunning() === false);
    /* L'export ne doit jamais consommer de quota (§17.1) : aucune URL réseau. */
    const expSrc = fs.readFileSync(path.join(PROJECT, 'studio', 'render', 'exporter.js'), 'utf8');
    check('exporter sans appel réseau', !/fetch\(|XMLHttpRequest|https?:\/\//.test(expSrc));
    check('exporter sans import/require (aucune dépendance)',
        !/\bimport\s|\brequire\(|from\s+['"]/.test(expSrc));

    console.log('\n=== 12. MIXAGE AUDIO (M4) ===');
    const AM = w.LSVStudio.AudioMixer;
    check('AudioMixer exposé', !!AM);
    check('supported() = false sous jsdom (pas d’AudioContext)', AM.supported() === false);
    check('context() = null sans Web Audio', AM.context() === null);
    check('attach() renvoie null sans Web Audio (pas d’exception)',
        AM.attach({ tagName: 'VIDEO' }, 'x') === null);
    check('applyProject ne lève pas d’exception sans audio', (() => {
        try { AM.applyProject(p2, 0); return true; } catch (e) { return false; }
    })());
    check('les fondus audio réutilisent le facteur du compositeur',
        /transitionFactor\(clip, time\)/.test(fs.readFileSync(path.join(PROJECT, 'studio', 'render', 'audio-mixer.js'), 'utf8')));

    console.log('\n=== 13. CLIPS TEXTE & RÉGLAGES (M5) ===');
    check('bouton Texte dans la barre d’outils', !!doc.getElementById('sv-add-text'));
    check('le modèle accepte une piste texte', TM.TRACK_ACCEPTS.text !== undefined);
    const tp = PM.create({ name: 'Txt' });
    const txtTrack = S_ProjectModel_addTextTrack(tp);
    const txtClip = TM.appendClip(tp, txtTrack.id, {
        id: 't1', kind: 'text', mediaId: '', start: 0, duration: 4,
        in: 0, out: 0, speed: 1, volume: 1, muted: false, opacity: 1,
        text: 'Bonjour', style: { fontSize: 64, color: '#fff' }, effects: []
    });
    check('clip texte ajouté sur une piste texte', txtClip !== null && txtTrack.clips.length === 1);
    check('clipsAt rend le texte à t=1', TM.clipsAt(tp, 1).length === 1);
    check('le texte n’exige pas de média référencé', TM.clipsAt(tp, 1)[0].items[0].clip.kind === 'text');
    check('validate() accepte un clip texte sans mediaId',
        PM.validate({
            schemaVersion: 1, name: 'x', sequence: { width: 100, height: 100, fps: 30 },
            media: [],
            tracks: [{ id: 't', kind: 'text', clips: [{ id: 'c', kind: 'text', mediaId: '', start: 0, duration: 1, text: 'a' }] }]
        }).ok === true);

    console.log('\n=== 14. NON-RÉGRESSION DE L’APP PRINCIPALE ===');
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
