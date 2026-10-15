/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — bootstrap
   Point d'entrée de la page studio/. Gère l'écran d'accueil (création,
   import, liste, suppression de projets), l'ouverture d'un projet dans
   l'éditeur, l'autosauvegarde et le partage de thème avec LSV.ai.
   Aucun appel réseau : tout est local (§17.1 — le montage ne consomme jamais
   de quota du compte).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    const AUTOSAVE_MS = 1500;

    const App = {
        project: null,
        inEditor: false,
        _saveTimer: null,
        _dirty: false,
        _lastSaved: null,
        els: {},

        /* ── Utilitaires UI ────────────────────────────────────────────── */
        toast(msg, kind) {
            const el = document.getElementById('sv-toast');
            const text = document.getElementById('sv-toast-text');
            const icon = document.getElementById('sv-toast-icon');
            if (!el || !text) return;
            text.textContent = msg;
            el.classList.remove('error', 'success', 'warn');
            if (kind === 'error') { el.classList.add('error'); if (icon) icon.textContent = 'error'; }
            else if (kind === 'success') { el.classList.add('success'); if (icon) icon.textContent = 'check_circle'; }
            else if (kind === 'warn') { el.classList.add('warn'); if (icon) icon.textContent = 'warning'; }
            else if (icon) icon.textContent = 'info';
            el.classList.add('visible');
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
        },

        /* Barre de progression (import long, export futur). */
        setProgress(p, label) {
            let bar = document.getElementById('sv-progress');
            if (!bar) {
                bar = document.createElement('div');
                bar.id = 'sv-progress';
                bar.style.cssText = 'position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;' +
                    'align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;';
                bar.innerHTML = '<div style="width:min(320px,70vw);height:6px;background:rgba(255,255,255,.2);' +
                    'border-radius:3px;overflow:hidden"><div id="sv-progress-fill" style="height:100%;width:0;' +
                    'background:var(--accent,#7c5cff);transition:width .15s"></div></div>' +
                    '<p id="sv-progress-label" style="margin:.6rem 0 0;font-size:.8rem"></p>';
                document.body.appendChild(bar);
            }
            const fill = document.getElementById('sv-progress-fill');
            const lbl = document.getElementById('sv-progress-label');
            if (p > 0) {
                bar.style.display = 'flex';
                if (fill) fill.style.width = Math.round(p * 100) + '%';
                if (lbl) lbl.textContent = label || '';
            } else {
                bar.style.display = 'none';
            }
        },

        /* ── État de sauvegarde ─────────────────────────────────────────── */
        /* dirty ≠ saved : on n'écrit pas à chaque frappe, on attend le
           debounce. `error` ne revient à `saved` qu'après une vraie écriture. */
        setSaveState(state) {
            const box = document.getElementById('sv-save-state');
            const txt = document.getElementById('sv-save-text');
            if (state === 'dirty') {
                this._dirty = true;
                if (txt) txt.textContent = 'Modifications…';
                if (box) box.className = 'sv-save-state';
                this._scheduleSave();
                return;
            }
            if (state === 'saving') {
                if (txt) txt.textContent = 'Enregistrement…';
                if (box) box.className = 'sv-save-state saving';
                return;
            }
            if (state === 'saved') {
                this._dirty = false;
                this._lastSaved = Date.now();
                if (txt) txt.textContent = 'Enregistré';
                if (box) box.className = 'sv-save-state saved';
                return;
            }
            if (state === 'error') {
                if (txt) txt.textContent = 'Erreur d’enregistrement';
                if (box) box.className = 'sv-save-state error';
            }
        },

        _scheduleSave() {
            clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => this._saveNow(), AUTOSAVE_MS);
        },

        async _saveNow() {
            if (!this.project) return;
            this.setSaveState('saving');
            const res = await S.ProjectStorage.save(this.project);
            if (res.ok) this.setSaveState('saved');
            else this.setSaveState('error');
        },

        /* ── Thème (partagé avec LSV.ai : clé `lsv4_theme`) ────────────── */
        applyTheme(dark) {
            document.documentElement.classList.toggle('dark', dark);
            document.body.classList.toggle('dark', dark);
            try { localStorage.setItem('lsv4_theme', dark ? 'dark' : 'light'); } catch (e) {}
        },
        initTheme() {
            let dark = false;
            try {
                const saved = localStorage.getItem('lsv4_theme');
                /* `matchMedia` peut être absent (jsdom, navigateurs anciens) :
                   on retombe sur le clair plutôt que de laisser `undefined`
                   faire basculer la classe via classList.toggle. */
                dark = saved ? saved === 'dark'
                    : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
            } catch (e) { dark = false; }
            this.applyTheme(dark);
            const bind = id => {
                const el = document.getElementById(id);
                if (el) el.addEventListener('click', () => this.applyTheme(!document.body.classList.contains('dark')));
            };
            bind('sv-theme');
            bind('sv-home-theme');
        },

        /* ── Écran d'accueil ────────────────────────────────────────────── */
        async showHome() {
            this.inEditor = false;
            this.project = null;
            if (S.Compositor) S.Compositor.clearCache();
            if (S.Preview) S.Preview.pause();

            document.getElementById('sv-app').hidden = true;
            document.getElementById('sv-home').hidden = false;
            await this.renderHome();
        },

        async renderHome() {
            const wrap = document.getElementById('sv-projects');
            const notice = document.getElementById('sv-storage-notice');
            if (notice) notice.hidden = !(S.ProjectStorage && S.ProjectStorage.supported());

            if (!S.ProjectStorage || !S.ProjectStorage.supported()) {
                wrap.innerHTML = '<p class="sv-muted">IndexedDB indisponible : les projets ne peuvent pas être conservés ' +
                    'dans ce navigateur. Utilise un navigateur récent, ou exporte tes projets en fichier après usage.</p>';
                return;
            }

            const list = await S.ProjectStorage.list();
            if (!list.length) {
                wrap.innerHTML = '<p class="sv-muted">Aucun montage pour l’instant. Crée-en un pour commencer.</p>';
                return;
            }
            wrap.innerHTML = '';
            for (const p of list) {
                const card = document.createElement('div');
                card.className = 'sv-project-card';
                card.innerHTML =
                    '<h3>' + esc(p.name) + '</h3>' +
                    '<p>' + fmtDate(p.updatedAt) + ' · ' + p.mediaCount + ' média' + (p.mediaCount > 1 ? 's' : '') +
                    (p.duration ? ' · ' + fmtDur(p.duration) : '') + '</p>' +
                    (p.unreadable ? '<p style="color:var(--red)">Illisible (version plus récente)</p>' : '') +
                    '<div class="sv-card-actions">' +
                    '  <button class="sv-btn sm" data-act="open"' + (p.unreadable ? ' disabled' : '') + '>' +
                    '    <span class="ms ms-sm">edit</span> Ouvrir</button>' +
                    '  <button class="sv-btn sm danger" data-act="del" title="Supprimer" aria-label="Supprimer">' +
                    '    <span class="ms ms-sm">delete</span></button>' +
                    '</div>';
                card.addEventListener('click', e => {
                    const act = e.target.closest('[data-act]');
                    if (act && act.dataset.act === 'del') {
                        e.stopPropagation();
                        if (confirm('Supprimer définitivement « ' + p.name + ' » ?\nCette action est irréversible.')) {
                            S.ProjectStorage.remove(p.id).then(() => this.renderHome());
                        }
                        return;
                    }
                    if (!p.unreadable) this.openProject(p.id);
                });
                wrap.appendChild(card);
            }
        },

        /* ── Cycle de vie d'un projet ───────────────────────────────────── */
        async newProject() {
            const name = prompt('Nom du montage :', 'Nouveau montage');
            if (name === null) return;
            const project = S.ProjectModel.create({ name: name.trim() || 'Nouveau montage' });
            await this.enterEditor(project);
        },

        async openProject(id) {
            const res = await S.ProjectStorage.load(id);
            if (!res.ok) {
                const why = {
                    missing: 'Projet introuvable.',
                    invalid: 'Projet illisible :\n' + (res.errors || []).join('\n'),
                    'migrate-failed': 'Migration impossible.',
                    'no-idb': 'IndexedDB indisponible.'
                }[res.reason] || 'Ouverture impossible.';
                this.toast(why, 'error');
                return;
            }
            /* Signale les médias dont le blob n'est pas sur cet appareil. */
            const nMissing = await S.MediaStorage.markMissing(res.project);
            await this.enterEditor(res.project);
            if (nMissing) {
                this.toast(nMissing + ' média' + (nMissing > 1 ? 's' : '') +
                    ' absent' + (nMissing > 1 ? 's' : '') + ' de cet appareil — relier manuellement', 'warn');
            }
        },

        async importProjectFile(file) {
            const text = await file.text();
            const res = S.ProjectStorage.importJSON(text);
            if (!res.ok) {
                this.toast('Import impossible :\n' + res.errors.slice(0, 3).join('\n'), 'error');
                return;
            }
            /* Toujours enregistrer sous un nouvel ID : ne jamais écraser. */
            res.project.id = S.ProjectModel.create({ name: res.project.name }).id;
            await S.MediaStorage.markMissing(res.project);
            await this.enterEditor(res.project);
            const n = res.project.media.filter(m => m.missing).length;
            this.toast(n ? 'Projet importé — ' + n + ' média' + (n > 1 ? 's' : '') + ' à relier'
                : 'Projet importé', n ? 'warn' : 'success');
        },

        async enterEditor(project) {
            this.project = project;
            this.inEditor = true;
            if (S.Compositor) S.Compositor.clearCache();

            document.getElementById('sv-home').hidden = true;
            document.getElementById('sv-app').hidden = false;

            const nameInput = document.getElementById('sv-project-name');
            if (nameInput) {
                nameInput.value = project.name;
                nameInput.onchange = () => {
                    S.ProjectModel.rename(project, nameInput.value);
                    nameInput.value = project.name;
                    this.setSaveState('dirty');
                };
            }

            /* Enregistre à l'entrée pour que le projet apparaisse dans la liste. */
            await S.ProjectStorage.save(project);
            this.setSaveState('saved');
            if (S.HistoryManager) S.HistoryManager.reset(project);

            if (S.MediaPanel) S.MediaPanel.render();
            if (S.TimelineView) { S.TimelineView.selection = null; S.TimelineView.playhead = 0; S.TimelineView.render(); }
            if (S.PropertiesPanel) S.PropertiesPanel.onSelection(null);
            if (S.Preview) { S.Preview.time = 0; S.Preview.refresh(); }
        },

        exportProjectFile() {
            if (!this.project) return;
            S.ProjectStorage.download(this.project);
            this.toast('Projet exporté (fichier JSON, sans les médias)', 'success');
        },

        /* ── Annuler / rétablir ─────────────────────────────────────────── */
        undo() {
            const restored = S.HistoryManager.undo(this.project);
            if (!restored) return;
            this.project = restored;
            this._afterRestore();
            this.toast('Annulé', 'success');
        },

        redo() {
            const restored = S.HistoryManager.redo(this.project);
            if (!restored) return;
            this.project = restored;
            this._afterRestore();
            this.toast('Rétabli', 'success');
        },

        /* Reconstruit toute l'UI après un aller-retour dans l'historique :
           le projet restauré est un objet neuf, donc toutes les vues doivent
           se ré-afficher (aucune référence ancienne n'est conservée). */
        _afterRestore() {
            if (S.TimelineView) {
                /* La sélection peut avoir disparu avec l'état restauré. */
                if (S.TimelineView.selection && !S.TimelineModel.clip(this.project, S.TimelineView.selection)) {
                    S.TimelineView.selection = null;
                }
                S.TimelineView.render();
                if (S.PropertiesPanel) S.PropertiesPanel.onSelection(S.TimelineView.selection);
            }
            if (S.MediaPanel) S.MediaPanel.render();
            if (S.Preview) S.Preview.refresh();
            S.HistoryManager.syncButtons();
            this.setSaveState('dirty');
        },

        /* ── Démarrage ──────────────────────────────────────────────────── */
        init() {
            this.els.home = document.getElementById('sv-home');
            this.els.app = document.getElementById('sv-app');
            this.initTheme();

            const on = (id, fn) => {
                const el = document.getElementById(id);
                if (el) el.addEventListener('click', fn);
            };
            on('sv-new-project', () => this.newProject());
            on('sv-export-project', () => this.exportProjectFile());
            on('sv-undo', () => this.undo());
            on('sv-redo', () => this.redo());

            const fileInput = document.getElementById('sv-project-file');
            const importBtn = document.getElementById('sv-import-project');
            if (importBtn && fileInput) {
                importBtn.addEventListener('click', () => fileInput.click());
                fileInput.addEventListener('change', () => {
                    if (fileInput.files.length) this.importProjectFile(fileInput.files[0]);
                    fileInput.value = '';
                });
            }

            /* Quitter avec des modifications non enregistrées. */
            window.addEventListener('beforeunload', e => {
                if (this._dirty) { e.preventDefault(); e.returnValue = ''; }
            });

            /* Modules UI optionnels : chacun peut être absent sans planter. */
            const safe = (obj, method, arg) => {
                try { if (obj && typeof obj[method] === 'function') return obj[method](arg); }
                catch (err) { console.warn('[LSV Studio]', method, err); }
            };
            safe(S.MediaPanel, 'init');
            safe(S.TimelineView, 'init');
            safe(S.Preview, 'init');
            safe(S.PropertiesPanel, 'init');
            if (S.HistoryManager) S.HistoryManager.syncButtons();

            this.renderCapabilityNotice();
            this.showHome();
        },

        renderCapabilityNotice() {
            const box = document.getElementById('sv-caps-notice');
            const text = document.getElementById('sv-caps-text');
            if (!box || !text || !S.Capability) return;
            const caps = S.Capability.detect();
            const problems = [];
            if (caps.blockers && caps.blockers.length) problems.push(caps.blockers.join(' · '));
            if (caps.warnings && caps.warnings.length) problems.push(caps.warnings.join(' · '));
            if (problems.length) {
                text.textContent = 'Fonctions limitées sur cet appareil : ' + problems.join(' — ');
                box.hidden = false;
            }
        }
    };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtDate(iso) {
        if (!iso) return '—';
        try {
            const d = new Date(iso);
            return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        } catch (e) { return '—'; }
    }
    function fmtDur(sec) {
        const m = Math.floor(sec / 60), s = Math.round(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    S.App = App;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => App.init());
    } else {
        App.init();
    }
})();
