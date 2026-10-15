/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — amorçage
   Chargé en dernier. Prépare le thème, les messages et l'écran d'accueil, puis
   laisse la main aux modules quand ils sont présents. Chaque accès à un module
   est vérifié : si un fichier manque, la page reste utilisable au lieu de
   lever une exception au chargement.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    /* ── État partagé de la session d'édition ─────────────────────────────── */
    S.App = {
        project: null,     // projet courant (objet du modèle)
        dirty: false,      // modifications non sauvegardées
        selectedClipId: null,
        playhead: 0,       // position de lecture, en secondes
        playing: false,
        zoom: 60           // pixels par seconde
    };

    /* ── Petits utilitaires d'affichage ───────────────────────────────────── */
    function $(id) { return document.getElementById(id); }

    let toastTimer = null;
    S.toast = function (msg, kind) {
        const el = $('sv-toast');
        if (!el) return;
        $('sv-toast-text').textContent = msg;
        $('sv-toast-icon').textContent =
            kind === 'error' ? 'error' : (kind === 'success' ? 'check_circle' : 'info');
        el.className = 'sv-toast visible' + (kind ? ' ' + kind : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'sv-toast' + (kind ? ' ' + kind : ''); }, 3200);
    };

    /* ── Thème (partagé avec l'application principale : clé lsv4_theme) ──── */
    function applyTheme(theme) {
        document.body.classList.toggle('dark', theme === 'dark');
        ['sv-theme', 'sv-home-theme'].forEach(id => {
            const b = $(id);
            if (!b) return;
            const icon = b.querySelector('.ms');
            if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
            b.title = theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre';
        });
    }

    function initTheme() {
        let saved = null;
        try { saved = localStorage.getItem('lsv4_theme'); } catch (e) { /* mode privé */ }
        applyTheme(saved === 'dark' ? 'dark' : 'light');
        ['sv-theme', 'sv-home-theme'].forEach(id => {
            const b = $(id);
            if (!b) return;
            b.addEventListener('click', () => {
                const next = document.body.classList.contains('dark') ? 'light' : 'dark';
                try { localStorage.setItem('lsv4_theme', next); } catch (e) { /* mode privé */ }
                applyTheme(next);
            });
        });
    }

    /* ── État de sauvegarde (reflects l'état réel de AutosaveManager) ─────── */
    S.setSaveState = function (state) {
        const wrap = $('sv-save-state');
        const text = $('sv-save-text');
        if (!wrap || !text) return;
        wrap.className = 'sv-save-state ' + (state || '');
        const map = {
            saving: ['sync', 'Enregistrement…'],
            saved: ['cloud_done', 'Enregistré localement'],
            error: ['cloud_off', 'Échec de sauvegarde'],
            idle: ['cloud_done', 'Prêt']
        };
        const row = map[state] || map.idle;
        wrap.querySelector('.ms').textContent = row[0];
        text.textContent = row[1];
    };

    /* ── Capacités du navigateur ──────────────────────────────────────────── */
    function renderCapabilityNotice() {
        const caps = S.Capability.detect();
        const el = $('sv-caps-notice');
        const txt = $('sv-caps-text');
        if (!el || !txt) return;
        const msgs = (caps.blockers || []).concat(caps.warnings || []);
        if (!msgs.length) { el.hidden = true; return; }
        txt.textContent = msgs.join(' ');
        el.hidden = false;
        /* Un bloquant empêche réellement de monter : on le signale aussi. */
        if (caps.blockers.length) S.toast(caps.blockers[0], 'error');
    }

    /* ── Retour à l'accueil / ouverture d'un projet ───────────────────────── */
    S.showHome = function () {
        const home = $('sv-home');
        if (home) home.hidden = false;
        if (S.Projects && typeof S.Projects.refresh === 'function') S.Projects.refresh();
    };

    S.showEditor = function () {
        const home = $('sv-home');
        if (home) home.hidden = true;
        if (S.TimelineView && typeof S.TimelineView.render === 'function') S.TimelineView.render();
        if (S.Preview && typeof S.Preview.refresh === 'function') S.Preview.refresh();
    };

    /* ── Nom du projet dans la barre supérieure ───────────────────────────── */
    function initProjectName() {
        const input = $('sv-project-name');
        if (!input) return;
        input.addEventListener('change', () => {
            if (!S.App.project) return;
            const name = (input.value || '').trim() || 'Nouveau montage';
            input.value = name;
            if (S.ProjectModel) S.ProjectModel.rename(S.App.project, name);
            if (S.Autosave) S.Autosave.touch();
        });
    }

    /* ── Amorçage ─────────────────────────────────────────────────────────── */
    function bootstrap() {
        initTheme();
        initProjectName();
        renderCapabilityNotice();
        S.setSaveState('idle');

        /* Les modules de M1+ font leur propre câblage lorsqu'ils existent. */
        if (S.Home && typeof S.Home.init === 'function') S.Home.init();
        if (S.Layout && typeof S.Layout.init === 'function') S.Layout.init();

        /* Aucun montage ouvert au démarrage : on affiche l'accueil. */
        if (!S.App.project) S.showHome();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
