/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — panneau Médias (bibliothèque du projet)
   Se branche sur le markup de studio/index.html (aucune structure générée) :
   #sv-dropzone, #sv-media-list, #sv-file-input, #sv-import, #sv-import-btn,
   #sv-lib, #sv-lib-list, #sv-lib-all.
   Gère l'import disque, l'import direct depuis LSV.ai, le drag vers la
   timeline et le relinking.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    const KIND_ICON = { video: 'movie', image: 'image', audio: 'audio_file' };
    const KIND_LABEL = { video: 'Vidéo', image: 'Image', audio: 'Audio' };
    const REJECT_LABEL = {
        doublon: 'déjà importé',
        limite: 'limite de médias atteinte',
        unsupported: 'format non supporté',
        'not-a-file': 'fichier illisible'
    };

    /* Libellé d'un rejet d'import. Un échec d'écriture est décrit par
       `MediaStorage.explainWriteFailure` (cause réelle + occupation du
       stockage) : on ne se contente plus de « plein ou bloqué ». */
    async function rejectLabel(r, fallback) {
        if (r && r.reason === 'write-failed' && S.MediaStorage &&
            S.MediaStorage.explainWriteFailure) {
            try { return await S.MediaStorage.explainWriteFailure(r.error); } catch (e) {}
        }
        if (fallback) return fallback(r && r.reason);
        return (REJECT_LABEL[r && r.reason]) || (r && r.reason) || 'refusé';
    }

    function fmtDuration(sec) {
        if (!sec || sec < 0.05) return '';
        const m = Math.floor(sec / 60), s = (sec % 60);
        return m + ':' + (m || s >= 10 ? '' : '0') + (m ? String(Math.round(s)).padStart(2, '0') : s.toFixed(1));
    }
    function fmtSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' Ko';
        return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const MediaPanel = {
        els: {},

        init() {
            const q = id => document.getElementById(id);
            this.els.dropzone = q('sv-dropzone');
            this.els.list = q('sv-media-list');
            this.els.input = q('sv-file-input');
            this.els.importBtn = q('sv-import-btn');
            this.els.import = q('sv-import');
            this.els.lib = q('sv-lib');
            this.els.libList = q('sv-lib-list');
            this.els.libAll = q('sv-lib-all');

            if (this.els.importBtn) this.els.importBtn.addEventListener('click', () => this.els.input.click());
            if (this.els.import) this.els.import.addEventListener('click', () => this.els.input.click());
            if (this.els.libAll) this.els.libAll.addEventListener('click', () => this.importFromLibrary());
            if (this.els.input) this.els.input.addEventListener('change', () => {
                if (this.els.input.files.length) this.importFiles(this.els.input.files);
                this.els.input.value = '';
            });

            const dz = this.els.dropzone;
            if (dz) {
                dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
                dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
                dz.addEventListener('drop', e => {
                    e.preventDefault();
                    dz.classList.remove('dragover');
                    if (e.dataTransfer && e.dataTransfer.files.length) this.importFiles(e.dataTransfer.files);
                });
            }
        },

        /* ── Import ─────────────────────────────────────────────────────── */
        async importFiles(files) {
            const project = S.App.project;
            if (!project) return;
            const res = await S.MediaManager.importFiles(project, files, (p, name) => {
                if (S.App.setProgress) S.App.setProgress(p, name);
            });
            if (S.App.setProgress) S.App.setProgress(0, '');

            if (res.added.length && !res.rejected.length) {
                S.App.toast(res.added.length + ' média' + (res.added.length > 1 ? 's importés' : ' importé'), 'success');
            } else if (res.added.length) {
                const r = res.rejected[0];
                S.App.toast('Import partiel — ' + r.file + ' : ' + await rejectLabel(r), 'warn');
            } else if (res.rejected.length) {
                const r = res.rejected[0];
                S.App.toast('Import impossible — ' + r.file + ' : ' + await rejectLabel(r), 'error');
            }
            this.render();
            if (S.TimelineView) S.TimelineView.render();
            S.App.setSaveState('dirty');
        },

        /* ── Import depuis LSV.ai ───────────────────────────────────────── */
        /* Lit la bibliothèque locale du site (même origine) et propose chaque
           création non encore importée. Un clic suffit : pas de
           téléchargement puis re-téléversement. */
        async importOneFromLibrary(asset) {
            const project = S.App.project;
            if (!project) return;
            if (S.App.setProgress) S.App.setProgress(0.1, asset.name);
            const r = await S.LibraryImport.import(project, asset);
            if (S.App.setProgress) S.App.setProgress(0, '');
            if (r.ok) {
                S.App.toast('« ' + asset.name + ' » importé depuis LSV.ai', 'success');
                S.HistoryManager.run(project, 'import-bibliothèque');
                this.render();
                if (S.TimelineView) S.TimelineView.render();
                if (S.Preview) S.Preview.refresh();
                S.App.setSaveState('dirty');
            } else if (r.reason === 'session') {
                S.App.toast(
                    '« ' + asset.name + ' » : session expirée — rouvre LSV.ai pour rafraîchir ta connexion, ' +
                    'puis réessaie.', 'error');
            } else if (r.reason === 'cors') {
                S.App.toast(
                    '« ' + asset.name + ' » est hébergé chez le fournisseur et n’a pas pu être récupéré. ' +
                    'Télécharge-le depuis la Bibliothèque, puis dépose-le ici.', 'error');
            } else if (r.reason === 'déjà présent') {
                S.App.toast('« ' + asset.name + ' » est déjà dans le projet', 'warn');
            } else if (r.reason === 'limite') {
                S.App.toast('Limite de médias du projet atteinte (' + S.ProjectModel.LIMITS.MAX_MEDIA + ')', 'error');
            } else {
                S.App.toast('Import impossible — « ' + asset.name + ' » : ' +
                    await rejectLabel(r, S.LibraryImport.reasonLabel), 'error');
            }
        },

        async importFromLibrary() {
            const project = S.App.project;
            if (!project || !S.LibraryImport) return;
            const done = this.importedUrls();
            const pending = S.LibraryImport.list().filter(a => !done.has(a.url));
            if (!pending.length) {
                S.App.toast('Aucune création à importer — tout est déjà dans le projet', 'warn');
                return;
            }
            const res = await S.LibraryImport.importMany(project, pending, (p, name) => {
                if (S.App.setProgress) S.App.setProgress(p, name);
            });
            if (S.App.setProgress) S.App.setProgress(0, '');
            if (res.added.length) {
                S.HistoryManager.run(project, 'import-bibliothèque');
                S.App.toast(
                    res.added.length + ' média' + (res.added.length > 1 ? 's importés' : ' importé') +
                    ' depuis LSV.ai' + (res.failed.length ? ' — ' + res.failed.length + ' échec(s)' : ''),
                    res.failed.length ? 'warn' : 'success');
            } else if (res.failed.length) {
                const f = res.failed[0];
                S.App.toast('Import impossible — « ' + f.asset.name + ' » : ' +
                    await rejectLabel(f, S.LibraryImport.reasonLabel), 'error');
            }
            this.render();
            if (S.TimelineView) S.TimelineView.render();
            if (S.Preview) S.Preview.refresh();
            S.App.setSaveState('dirty');
        },

        importedUrls() {
            const project = S.App.project;
            return S.LibraryImport.importedSet(project);
        },

        renderLibrary() {
            const lib = this.els.lib, list = this.els.libList, all = this.els.libAll;
            if (!lib || !S.LibraryImport) return;
            const assets = S.LibraryImport.list();
            if (!assets.length) { lib.hidden = true; return; }
            lib.hidden = false;

            const done = this.importedUrls();
            list.innerHTML = assets.map(a =>
                '<li class="sv-lib-item' + (done.has(a.url) ? ' imported' : '') + '" data-url="' + esc(a.url) + '">' +
                '  <span class="sv-lib-thumb">' + (a.type === 'video'
                    ? '<span class="ms">movie</span>'
                    : '<span class="ms">image</span>') + '</span>' +
                '  <span class="sv-lib-meta">' +
                '    <span class="sv-lib-name" title="' + esc(a.name) + '">' + esc(a.name) + '</span>' +
                '    <span class="sv-lib-sub">' + (a.ratio || a.type) +
                (a.duration ? ' · ' + fmtDuration(a.duration) : '') + '</span>' +
                '  </span>' +
                '  <button class="sv-lib-add" type="button" title="' +
                (done.has(a.url) ? 'Déjà dans le projet' : 'Ajouter au projet') + '">' +
                '    <span class="ms ms-sm">' + (done.has(a.url) ? 'check' : 'add') + '</span></button>' +
                '</li>'
            ).join('');

            list.querySelectorAll('.sv-lib-add').forEach(btn => {
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    const url = btn.closest('[data-url]').dataset.url;
                    const asset = assets.find(x => x.url === url);
                    if (asset) this.importOneFromLibrary(asset);
                });
            });

            const pending = assets.filter(a => !done.has(a.url)).length;
            if (all) {
                all.hidden = pending === 0;
                all.textContent = 'Tout importer (' + pending + ')';
            }
        },

        /* ── Rendu ──────────────────────────────────────────────────────── */
        render() {
            this.renderLibrary();
            const project = S.App.project;
            const list = this.els.list, dz = this.els.dropzone;
            if (!list) return;
            list.innerHTML = '';
            if (!project || !project.media.length) {
                if (dz) dz.hidden = false;
                return;
            }
            if (dz) dz.hidden = true;

            for (const m of project.media) {
                const li = document.createElement('li');
                li.className = 'sv-media-item' + (m.missing ? ' missing' : '');
                li.draggable = !m.missing;
                li.dataset.mediaId = m.id;
                li.innerHTML =
                    '<span class="sv-media-thumb">' +
                    (m.thumb
                        ? '<img alt="" src="' + m.thumb + '">'
                        : '<span class="ms">' + (m.missing ? 'link_off' : (KIND_ICON[m.kind] || 'draft')) + '</span>') +
                    '</span>' +
                    '<span class="sv-media-meta">' +
                    '  <span class="sv-media-name" title="' + esc(m.name) + '">' + esc(m.name) + '</span>' +
                    '  <span class="sv-media-sub">' + (KIND_LABEL[m.kind] || '') +
                    (m.duration ? ' · ' + fmtDuration(m.duration) : '') +
                    (m.size ? ' · ' + fmtSize(m.size) : '') + '</span>' +
                    '</span>' +
                    '<button class="sv-media-del" type="button" title="Retirer du projet" aria-label="Retirer le média">' +
                    '<span class="ms ms-sm">delete</span></button>';

                if (m.missing) {
                    const relink = document.createElement('button');
                    relink.className = 'sv-btn sm';
                    relink.type = 'button';
                    relink.style.marginTop = '0.3rem';
                    relink.innerHTML = '<span class="ms ms-sm">link</span> Relier le fichier';
                    relink.addEventListener('click', e => { e.stopPropagation(); this.relink(m.id); });
                    li.querySelector('.sv-media-meta').appendChild(relink);
                }

                li.addEventListener('dragstart', e => {
                    e.dataTransfer.setData('text/lsv-media', m.id);
                    e.dataTransfer.effectAllowed = 'copy';
                });
                li.querySelector('.sv-media-del').addEventListener('click', e => {
                    e.stopPropagation();
                    if (!confirm('Retirer « ' + m.name + ' » du projet ?\nLes clips qui l’utilisent seront supprimés.')) return;
                    const n = S.MediaManager.remove(project, m.id);
                    S.App.toast(n ? 'Média retiré (' + n + ' clip' + (n > 1 ? 's' : '') + ' supprimé' + (n > 1 ? 's' : '') + ')' : 'Média retiré', 'success');
                    this.render();
                    if (S.TimelineView) S.TimelineView.render();
                    S.App.setSaveState('dirty');
                });
                list.appendChild(li);
            }
        },

        relink(mediaId) {
            const project = S.App.project;
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'video/*,image/*,audio/*';
            input.onchange = async () => {
                if (!input.files.length) return;
                const res = await S.MediaManager.relink(project, mediaId, input.files[0]);
                if (res.ok) {
                    S.App.toast('Média relié', 'success');
                    if (S.TimelineView) S.TimelineView.render();
                    if (S.Preview) S.Preview.refresh();
                    S.App.setSaveState('dirty');
                } else {
                    S.App.toast('Relinking impossible : ' + (REJECT_LABEL[res.reason] || res.reason || 'erreur'), 'error');
                }
                this.render();
            };
            input.click();
        }
    };

    S.MediaPanel = MediaPanel;
})();
