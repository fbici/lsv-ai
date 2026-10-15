/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — vue Timeline
   Se branche sur le markup de studio/index.html : #sv-tl-scroll, #sv-tl-ruler,
   #sv-tl-tracks, #sv-playhead, #sv-zoom, #sv-add-track, #sv-split, #sv-delete.
   Rendu multipiste, tête de lecture, zoom, sélection, glisser-déposer,
   recadrage, scission. Cette vue ne contient AUCUNE règle métier : elle
   appelle le TimelineModel et se contente de rendre le résultat.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});
    const TM = () => S.TimelineModel;

    const MIN_ZOOM = 4, MAX_ZOOM = 400, DEFAULT_ZOOM = 60;
    const TRACK_WIDTH = 92;   // largeur du `.sv-track-head` collant (voir studio.css)

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const TimelineView = {
        els: {},
        zoom: DEFAULT_ZOOM,
        playhead: 0,
        selection: null,

        init() {
            const q = id => document.getElementById(id);
            this.els.scroll = q('sv-tl-scroll');
            this.els.ruler = q('sv-tl-ruler');
            this.els.tracks = q('sv-tl-tracks');
            this.els.playhead = q('sv-playhead');
            this.els.zoom = q('sv-zoom');
            this.els.time = q('sv-time');
            this.els.seq = q('sv-seq');

            if (this.els.zoom) {
                this.els.zoom.value = String(this.zoom);
                this.els.zoom.addEventListener('input', () => this.setZoom(Number(this.els.zoom.value)));
            }
            const bind = (id, fn) => { const el = q(id); if (el) el.addEventListener('click', fn); };
            bind('sv-add-track', () => this.addTrack());
            bind('sv-split', () => this.splitAtPlayhead());
            bind('sv-delete', () => this.deleteSelection());
            bind('sv-duplicate', () => this.duplicateSelection());

            /* Clic / glisser sur la règle = déplacer la tête de lecture. */
            if (this.els.ruler) {
                this.els.ruler.addEventListener('pointerdown', e => {
                    this.els.ruler.setPointerCapture(e.pointerId);
                    const seek = ev => this.setPlayhead(this._timeFromEvent(ev));
                    seek(e);
                    const move = ev => seek(ev);
                    const up = () => {
                        this.els.ruler.removeEventListener('pointermove', move);
                        this.els.ruler.removeEventListener('pointerup', up);
                    };
                    this.els.ruler.addEventListener('pointermove', move);
                    this.els.ruler.addEventListener('pointerup', up);
                });
            }

            /* Dépôt d'un média depuis la bibliothèque. */
            if (this.els.tracks) {
                this.els.tracks.addEventListener('dragover', e => {
                    if (e.dataTransfer.types.indexOf('text/lsv-media') !== -1) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'copy';
                    }
                });
                this.els.tracks.addEventListener('drop', e => {
                    const mediaId = e.dataTransfer.getData('text/lsv-media');
                    if (!mediaId) return;
                    e.preventDefault();
                    const trackEl = e.target.closest('.sv-track');
                    const trackId = trackEl ? trackEl.dataset.trackId : null;
                    const res = S.MediaManager.dropOnTimeline(S.App.project, mediaId, trackId, this._timeFromEvent(e));
                    if (res.ok) {
                        this.selection = res.clip.id;
                        this.render();
                        S.App.setSaveState('dirty');
                    } else {
                        S.App.toast('Dépôt refusé : ' + res.reason, 'warn');
                    }
                });
            }

            this._bindKeys();
        },

        _bindKeys() {
            document.addEventListener('keydown', e => {
                if (!S.App.project || !S.App.inEditor) return;
                const tag = (e.target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
                if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSelection(); e.preventDefault(); }
                else if (e.key === 's' || e.key === 'S') { this.splitAtPlayhead(); e.preventDefault(); }
                else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) { this.duplicateSelection(); e.preventDefault(); }
                else if (e.key === 'ArrowLeft') { this.setPlayhead(Math.max(0, this.playhead - (e.shiftKey ? 1 : 1 / 30))); e.preventDefault(); }
                else if (e.key === 'ArrowRight') { this.setPlayhead(this.playhead + (e.shiftKey ? 1 : 1 / 30)); e.preventDefault(); }
            });
        },

        /* ── Zoom & tête de lecture ─────────────────────────────────────── */
        setZoom(z) {
            this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
            if (this.els.zoom) this.els.zoom.value = String(Math.round(this.zoom));
            this.render();
        },

        setPlayhead(t) {
            const dur = (TM() && S.App.project) ? TM().duration(S.App.project) : 0;
            this.playhead = Math.max(0, Math.min(dur, t));
            this._paintPlayhead();
            if (S.Preview && S.Preview.syncToPlayhead) S.Preview.syncToPlayhead(this.playhead);
        },

        _paintPlayhead() {
            if (this.els.playhead) this.els.playhead.style.left = (TRACK_WIDTH + this.playhead * this.zoom) + 'px';
            if (this.els.time) {
                const t = this.playhead;
                const m = Math.floor(t / 60), s = t % 60;
                this.els.time.textContent =
                    String(m).padStart(2, '0') + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
            }
        },

        _timeFromEvent(e) {
            if (!this.els.scroll) return 0;
            const rect = this.els.scroll.getBoundingClientRect();
            return Math.max(0, (e.clientX - rect.left + this.els.scroll.scrollLeft - TRACK_WIDTH) / this.zoom);
        },

        /* ── Actions de clip ────────────────────────────────────────────── */
        select(clipId) { this.selection = clipId; this.render(); },

        splitAtPlayhead() {
            const project = S.App.project;
            if (!project || !this.selection) { S.App.toast('Sélectionne d’abord un clip', 'warn'); return; }
            const r = TM().splitClip(project, this.selection, this.playhead);
            if (r) { this.selection = r.id; this.render(); S.App.setSaveState('dirty'); }
            else S.App.toast('Scission impossible à cette position', 'warn');
        },

        duplicateSelection() {
            const project = S.App.project;
            if (!project || !this.selection) return;
            const r = TM().duplicateClip(project, this.selection);
            if (r) { this.selection = r.id; this.render(); S.App.setSaveState('dirty'); }
            else S.App.toast('Duplication impossible ici', 'warn');
        },

        deleteSelection() {
            const project = S.App.project;
            if (!project || !this.selection) return;
            const r = TM().removeClip(project, this.selection);
            if (r) { this.selection = null; this.render(); S.App.setSaveState('dirty'); }
        },

        addTrack() {
            const project = S.App.project;
            if (!project) return;
            const kind = prompt('Type de piste (video, overlay, text, audio) :', 'video');
            if (!kind) return;
            if (TM().TRACK_ACCEPTS[kind] === undefined) { S.App.toast('Type de piste inconnu', 'error'); return; }
            const n = project.tracks.filter(t => t.kind === kind).length + 1;
            S.ProjectModel.addTrack(project, kind, kind.charAt(0).toUpperCase() + kind.slice(1) + ' ' + n);
            this.render();
            S.App.setSaveState('dirty');
        },

        /* ── Rendu ──────────────────────────────────────────────────────── */
        render() {
            const project = S.App.project;
            const tracksEl = this.els.tracks;
            if (!project || !tracksEl) return;

            tracksEl.innerHTML = '';
            const duration = Math.max(TM().duration(project), 12);
            const laneWidth = duration * this.zoom;

            if (this.els.ruler) {
                this.els.ruler.style.width = (TRACK_WIDTH + laneWidth) + 'px';
                this._renderRuler(duration);
            }
            if (this.els.seq) {
                this.els.seq.textContent =
                    project.sequence.width + ' × ' + project.sequence.height + ' · ' +
                    Math.round(project.sequence.fps) + ' i/s';
            }

            for (const track of project.tracks) {
                const row = document.createElement('div');
                row.className = 'sv-track';
                row.dataset.trackId = track.id;

                const head = document.createElement('div');
                head.className = 'sv-track-head';
                head.innerHTML =
                    '<span title="' + esc(track.name) + '">' + esc(track.kind) + '</span>' +
                    '<button type="button" data-act="mute" title="' + (track.muted ? 'Réactiver le son' : 'Couper le son') + '" aria-label="Son">' +
                    '<span class="ms ms-sm">' + (track.muted ? 'volume_off' : 'volume_up') + '</span></button>' +
                    '<button type="button" data-act="lock" title="' + (track.locked ? 'Déverrouiller' : 'Verrouiller') + '" aria-label="Verrouiller">' +
                    '<span class="ms ms-sm">' + (track.locked ? 'lock' : 'lock_open') + '</span></button>' +
                    '<button type="button" data-act="hide" title="' + (track.hidden ? 'Afficher' : 'Masquer') + '" aria-label="Masquer">' +
                    '<span class="ms ms-sm">' + (track.hidden ? 'visibility_off' : 'visibility') + '</span></button>' +
                    '<button type="button" data-act="del" title="Supprimer la piste" aria-label="Supprimer la piste">' +
                    '<span class="ms ms-sm">close</span></button>';
                head.querySelectorAll('button').forEach(btn => {
                    btn.addEventListener('click', e => { e.stopPropagation(); this._trackAction(track.id, btn.dataset.act); });
                });

                const body = document.createElement('div');
                body.className = 'sv-track-body';
                body.style.width = laneWidth + 'px';
                for (const clip of track.clips) body.appendChild(this._renderClip(clip, track));

                row.appendChild(head);
                row.appendChild(body);
                tracksEl.appendChild(row);
            }
            this._paintPlayhead();
        },

        _renderRuler(duration) {
            const r = this.els.ruler;
            r.innerHTML = '';
            const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
            const step = steps.find(s => s * this.zoom >= 55) || 600;
            for (let t = 0; t <= duration; t += step) {
                const tick = document.createElement('span');
                tick.style.cssText = 'position:absolute;left:' + (TRACK_WIDTH + t * this.zoom) +
                    'px;top:4px;font:600 9px var(--font-mono);color:var(--ink-3);transform:translateX(-50%);';
                tick.textContent = t < 60 ? t + 's'
                    : Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0');
                r.appendChild(tick);
            }
        },

        _renderClip(clip, track) {
            const el = document.createElement('div');
            el.className = 'sv-clip ' + (clip.kind || 'video');
            if (clip.id === this.selection) el.classList.add('selected');
            el.style.left = (clip.start * this.zoom) + 'px';
            el.style.width = Math.max(3, clip.duration * this.zoom) + 'px';
            el.dataset.clipId = clip.id;

            const media = TM().media(S.App.project, clip.mediaId);
            const label = clip.kind === 'text' ? (clip.text || 'Texte') : (media ? media.name : 'Média manquant');
            el.textContent = label;
            el.title = label + ' — ' + clip.duration.toFixed(2) + ' s';
            if (media && media.missing) el.style.opacity = '0.45';

            el.addEventListener('pointerdown', e => this._clipPointerDown(e, clip, track));
            return el;
        },

        _trackAction(trackId, act) {
            const project = S.App.project;
            const track = TM().track(project, trackId);
            if (!track) return;
            if (act === 'mute') track.muted = !track.muted;
            else if (act === 'lock') track.locked = !track.locked;
            else if (act === 'hide') track.hidden = !track.hidden;
            else if (act === 'del') {
                if (track.clips.length &&
                    !confirm('Supprimer la piste « ' + track.name + ' » et ses ' + track.clips.length + ' clip(s) ?')) return;
                TM().removeTrack(project, trackId);
            }
            S.ProjectModel.touch(project);
            this.render();
            S.App.setSaveState('dirty');
        },

        /* ── Interaction : déplacement / recadrage d'un clip ────────────── */
        _clipPointerDown(e, clip, track) {
            e.preventDefault();
            e.stopPropagation();
            this.selection = clip.id;
            this.render();
            if (track.locked) return;

            const startX = e.clientX;
            const orig = { start: clip.start, duration: clip.duration, in: clip.in, out: clip.out };
            /* Poignées invisibles : 6 px aux extrémités du clip. */
            const rect = e.currentTarget.getBoundingClientRect();
            const side = (e.clientX - rect.left) < 6 ? 'left'
                : (rect.right - e.clientX) < 6 ? 'right' : null;
            const mode = side ? 'trim-' + side : 'move';
            let lastResult = null;

            const onMove = ev => {
                const dt = (ev.clientX - startX) / this.zoom;
                if (mode === 'move') {
                    const snapped = TM().snapTime(S.App.project, Math.max(0, orig.start + dt), {
                        threshold: 8 / this.zoom,
                        playhead: this.playhead,
                        ignoreClipId: clip.id
                    });
                    lastResult = TM().moveClip(S.App.project, clip.id, track.id, snapped);
                } else {
                    lastResult = TM().trimClip(S.App.project, clip.id,
                        side === 'left' ? 'left' : 'right', dt);
                }
                /* Re-rendu immédiat : le clip suit le doigt sans latence. */
                const model = (lastResult && lastResult.clip) ? lastResult.clip : clip;
                this._paintClip(model, track);
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                if (lastResult && lastResult.ok === false && mode !== 'move') {
                    clip.start = orig.start; clip.duration = orig.duration;
                    clip.in = orig.in; clip.out = orig.out;
                } else if (lastResult) {
                    S.App.setSaveState('dirty');
                }
                this.render();
                if (S.Preview) S.Preview.refresh();
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        },

        /* Déplace/redimensionne le DOM d'un clip sans reconstruire la piste. */
        _paintClip(clip, track) {
            const el = this.els.tracks.querySelector('.sv-clip[data-clip-id="' + clip.id + '"]');
            if (!el) return;
            el.style.left = (clip.start * this.zoom) + 'px';
            el.style.width = Math.max(3, clip.duration * this.zoom) + 'px';
        },

        clearSelection() { this.selection = null; this.render(); }
    };

    S.TimelineView = TimelineView;
})();
