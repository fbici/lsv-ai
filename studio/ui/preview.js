/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — moniteur d'aperçu
   Se branche sur le markup de studio/index.html : #sv-canvas,
   #sv-monitor-empty, #sv-play, #sv-to-start, #sv-to-end, #sv-time.
   La lecture avance en temps réel via requestAnimationFrame ; le rendu est
   délégué au Compositor (un seul endroit dessine, aperçu et export partagent
   le même code — §12).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    const Preview = {
        els: {},
        ctx: null,
        time: 0,
        playing: false,
        _raf: null,
        _last: 0,
        _needsDraw: true,

        init() {
            const q = id => document.getElementById(id);
            this.els.canvas = q('sv-canvas');
            this.els.empty = q('sv-monitor-empty');
            this.els.play = q('sv-play');
            this.els.toStart = q('sv-to-start');
            this.els.toEnd = q('sv-to-end');
            this.els.time = q('sv-time');

            if (this.els.canvas) this.ctx = this.els.canvas.getContext('2d');

            if (this.els.play) {
                this.els.play.addEventListener('click', () => this.toggle());
                this.els.play.title = 'Lecture / Pause (Espace)';
            }
            if (this.els.toStart) this.els.toStart.addEventListener('click', () => this.seek(0));
            if (this.els.toEnd) this.els.toEnd.addEventListener('click', () => this.seek(this.duration()));

            document.addEventListener('keydown', e => {
                if (!S.App.inEditor) return;
                const tag = (e.target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
                if (e.code === 'Space') { this.toggle(); e.preventDefault(); }
                else if (e.key === 'Home') { this.seek(0); e.preventDefault(); }
                else if (e.key === 'End') { this.seek(this.duration()); e.preventDefault(); }
            });

            this._resize();
            this._loop();
        },

        duration() {
            return (S.App.project && S.TimelineModel) ? S.TimelineModel.duration(S.App.project) : 0;
        },

        /* Le canvas suit le format de séquence, pas la taille écran. */
        _resize() {
            const project = S.App.project;
            const seq = project ? project.sequence : { width: 1080, height: 1920 };
            const c = this.els.canvas;
            if (!c) return;
            if (c.width !== seq.width) c.width = seq.width;
            if (c.height !== seq.height) c.height = seq.height;
            this._needsDraw = true;
        },

        /* ── Transport ──────────────────────────────────────────────────── */
        toggle() { this.playing ? this.pause() : this.play(); },

        play() {
            if (!S.App.project) return;
            if (this.time >= this.duration() - 0.01) this.time = 0;
            this.playing = true;
            this._setPlayIcon(true);
            this._last = performance.now();
            for (const el of this._videos()) { try { el.play(); } catch (e) { /* autoplay refusé */ } }
        },

        pause() {
            this.playing = false;
            this._setPlayIcon(false);
            for (const el of this._videos()) { try { el.pause(); } catch (e) {} }
        },

        _setPlayIcon(playing) {
            const icon = this.els.play && this.els.play.querySelector('.ms');
            if (icon) icon.textContent = playing ? 'pause' : 'play_arrow';
            if (this.els.play) this.els.play.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
        },

        _videos() {
            return (S.Compositor && S.Compositor._elementsForPlayback) ? S.Compositor._elementsForPlayback() : [];
        },

        seek(t) {
            this.time = Math.max(0, Math.min(this.duration(), t));
            this._needsDraw = true;
            if (S.TimelineView) {
                S.TimelineView.playhead = this.time;
                S.TimelineView._paintPlayhead();
            }
            for (const el of this._videos()) {
                try { el.currentTime = this._sourceTimeFor(el); } catch (e) {}
            }
            this._updateTimeLabel();
        },

        /* Appelé par la timeline quand la tête de lecture bouge. */
        syncToPlayhead(t) {
            this.time = t;
            this._needsDraw = true;
        },

        _sourceTimeFor(el) {
            const project = S.App.project;
            if (!project) return 0;
            for (const layer of S.TimelineModel.clipsAt(project, this.time)) {
                for (const item of layer.items) {
                    if (item.clip.kind !== 'video') continue;
                    const media = S.TimelineModel.media(project, item.clip.mediaId);
                    if (media && S.Compositor._elementById(media.id) === el) return item.sourceTime;
                }
            }
            return 0;
        },

        /* ── Boucle de rendu ────────────────────────────────────────────── */
        _loop() {
            const tick = now => {
                this._raf = requestAnimationFrame(tick);
                if (this.playing) {
                    const dt = Math.min(0.25, (now - this._last) / 1000);
                    this._last = now;
                    this.time += dt;
                    if (this.time >= this.duration()) {
                        this.time = this.duration();
                        this.pause();
                    }
                    this._needsDraw = true;
                    if (S.TimelineView) {
                        S.TimelineView.playhead = this.time;
                        S.TimelineView._paintPlayhead();
                    }
                }
                if (this._needsDraw) {
                    this._needsDraw = false;
                    this._draw();
                }
                this._updateTimeLabel();
            };
            this._raf = requestAnimationFrame(tick);
        },

        async _draw() {
            const project = S.App.project;
            if (!project || !this.ctx) return;
            this._resize();
            const n = await S.Compositor.drawFrame(this.ctx, project, this.time);
            S.Compositor.applyVolumes(project, this.time);
            if (this.els.empty) this.els.empty.hidden = n > 0;
        },

        _updateTimeLabel() {
            const fmt = t => {
                const m = Math.floor(t / 60), s = t % 60;
                return String(m).padStart(2, '0') + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
            };
            if (this.els.time) this.els.time.textContent = fmt(this.time) + ' / ' + fmt(this.duration());
        },

        /* Appelé après chaque mutation de projet. */
        refresh() {
            this._resize();
            this._needsDraw = true;
            if (S.TimelineView) S.TimelineView.setPlayhead(Math.min(this.time, this.duration()));
        },

        destroy() {
            this.pause();
            if (this._raf) cancelAnimationFrame(this._raf);
        }
    };

    S.Preview = Preview;
})();
