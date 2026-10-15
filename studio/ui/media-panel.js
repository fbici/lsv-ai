/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — panneau Médias (bibliothèque du projet)
   Se branche sur le markup de studio/index.html (aucune structure générée) :
   #sv-dropzone, #sv-media-list, #sv-file-input, #sv-import, #sv-import-btn.
   Gère l'import disque, le drag vers la timeline et le relinking.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    const KIND_ICON = { video: 'movie', image: 'image', audio: 'audio_file' };
    const KIND_LABEL = { video: 'Vidéo', image: 'Image', audio: 'Audio' };
    const REJECT_LABEL = {
        doublon: 'déjà importé',
        limite: 'limite de médias atteinte',
        unsupported: 'format non supporté',
        'not-a-file': 'fichier illisible',
        'write-failed': 'stockage local plein ou bloqué'
    };

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

            if (this.els.importBtn) this.els.importBtn.addEventListener('click', () => this.els.input.click());
            if (this.els.import) this.els.import.addEventListener('click', () => this.els.input.click());
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
                S.App.toast('Import partiel — ' + r.file + ' : ' + (REJECT_LABEL[r.reason] || r.reason), 'warn');
            } else if (res.rejected.length) {
                const r = res.rejected[0];
                S.App.toast('Import impossible — ' + r.file + ' : ' + (REJECT_LABEL[r.reason] || r.reason), 'error');
            }
            this.render();
            if (S.TimelineView) S.TimelineView.render();
            S.App.setSaveState('dirty');
        },

        /* ── Rendu ──────────────────────────────────────────────────────── */
        render() {
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
