/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — export vidéo (MediaRecorder)
   Export EN TEMPS RÉEL (§12) : le compositeur dessine chaque frame sur un
   canvas hors écran, `captureStream()` fournit le flux vidéo, l'AudioMixer
   fournit le flux audio, et MediaRecorder assemble le tout.

   Choix assumés (validés) :
     • MP4/H.264 quand le navigateur le sait, sinon WebM — jamais de
       renommage de fichier : l'extension suit le conteneur réel.
     • Aucune dépendance externe, pas de FFmpeg.wasm (GitHub Pages n'offre
       pas COOP/COEP → pas de SharedArrayBuffer).
     • Temps réel : une vidéo de 30 s prend ~30 s. C'est le prix d'une
       absence totale de dépendance native.

   Une seule session d'export à la fois. Annulation propre possible.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    const Exporter = {
        _running: false,
        _cancelled: false,

        isRunning() { return this._running; },

        /* Vérifie tout ce qu'il faut avant de lancer. Renvoie null si OK,
           sinon un message utilisateur (jamais une stack technique).
           L'ordre compte : on signale d'abord ce que l'utilisateur peut
           corriger (timeline vide), puis l'environnement. */
        preflight(project) {
            if (!project) return 'Aucun projet à exporter.';
            if (S.TimelineModel.duration(project) <= 0) {
                return 'La timeline est vide : ajoute au moins un clip avant d’exporter.';
            }
            if (!S.Capability) return 'Module d’export indisponible.';
            const caps = S.Capability.detect();
            if (!caps.canvasCapture) {
                return 'Ce navigateur ne peut pas capturer le dessin : export impossible ici.';
            }
            if (!caps.mediaRecorder || !caps.bestMime) {
                return 'Ce navigateur ne sait pas enregistrer une vidéo. ' +
                    'Essaie Chrome, Edge, Firefox ou Safari récent.';
            }
            return null;
        },

        /* ── Export ─────────────────────────────────────────────────────── */
        /* onProgress(ratio 0→1, texte). Renvoie { blob, ext, mime, duration }. */
        async export(project, onProgress) {
            const err = this.preflight(project);
            if (err) return { ok: false, error: err };
            if (this._running) return { ok: false, error: 'Un export est déjà en cours.' };

            this._running = true;
            this._cancelled = false;
            const caps = S.Capability.detect();
            const duration = S.TimelineModel.duration(project);
            const fps = Math.max(12, Math.min(60, Math.round(project.sequence.fps) || 30));

            /* ── Canvas hors écran ── */
            const canvas = document.createElement('canvas');
            canvas.width = project.sequence.width;
            canvas.height = project.sequence.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) { this._running = false; return { ok: false, error: 'Canvas indisponible.' }; }

            /* ── Flux vidéo ── */
            let videoStream;
            try {
                videoStream = canvas.captureStream(fps);
            } catch (e) {
                this._running = false;
                return { ok: false, error: 'Capture du canvas impossible.' };
            }

            /* ── Flux audio (si Web Audio dispo) ── */
            const audioDest = S.AudioMixer.streamDestination();
            const tracks = [...videoStream.getVideoTracks()];
            if (audioDest) {
                /* Branche les vidéos du compositeur + les pistes audio seules. */
                this._prepareAudio(project);
                tracks.push(...audioDest.stream.getAudioTracks());
            }
            const stream = new MediaStream(tracks);

            /* ── Enregistreur ── */
            let recorder;
            try {
                recorder = new MediaRecorder(stream, {
                    mimeType: caps.bestMime,
                    videoBitsPerSecond: bitrateFor(project.sequence)
                });
            } catch (e) {
                this._cleanup(videoStream);
                this._running = false;
                return { ok: false, error: 'Initialisation de l’enregistreur impossible.' };
            }

            const chunks = [];
            recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

            const finished = new Promise(resolve => {
                recorder.onstop = () => resolve();
                recorder.onerror = () => resolve();
            });

            /* ── Lecture de la séquence ── */
            const t0 = performance.now();
            recorder.start(250);
            const drawAll = () => S.Compositor.drawFrame(ctx, project, this._time);

            /* Éléments vidéo : mise à l'heure + lecture. */
            const videos = S.Compositor._elementsForPlayback();
            this._time = 0;

            let raf = null;
            const tick = () => {
                if (this._cancelled) return;
                const elapsed = (performance.now() - t0) / 1000;
                this._time = Math.min(duration, elapsed);
                /* Synchro des vidéos. */
                for (const layer of S.TimelineModel.clipsAt(project, this._time)) {
                    for (const item of layer.items) {
                        if (item.clip.kind !== 'video') continue;
                        const media = S.TimelineModel.media(project, item.clip.mediaId);
                        const el = media && S.Compositor._elementById(media.id);
                        if (!el) continue;
                        try {
                            if (Math.abs(el.currentTime - item.sourceTime) > 0.08) el.currentTime = item.sourceTime;
                            if (el.paused) el.play().catch(() => {});
                        } catch (e) { /* seek non prêt */ }
                        S.AudioMixer.setLevel(media.id,
                            (item.clip.muted || layer.track.muted) ? 0 : item.clip.volume, false);
                    }
                }
                /* Coupe les vidéos absentes. */
                for (const el of videos) { if (el.paused === false && !this._isVideoActive(project, this._time, el)) el.pause(); }

                drawAll();
                if (onProgress) onProgress(Math.min(1, this._time / duration),
                    'Export en cours — ' + Math.round(this._time) + ' / ' + Math.round(duration) + ' s');

                if (elapsed >= duration + 0.15) {
                    this._stopAll(videos, audioDest);
                    try { recorder.stop(); } catch (e) {}
                    return;
                }
                raf = requestAnimationFrame(tick);
            };
            raf = requestAnimationFrame(tick);

            /* Attente de la fin (ou de l'annulation). */
            await finished;
            if (raf) cancelAnimationFrame(raf);
            this._stopAll(videos, audioDest);
            this._cleanup(videoStream);
            S.AudioMixer.disconnectExport();
            this._running = false;

            if (this._cancelled) return { ok: false, cancelled: true };
            if (!chunks.length) return { ok: false, error: 'Aucune donnée produite (format non supporté ?).' };

            const blob = new Blob(chunks, { type: caps.bestMime.split(';')[0] });
            return {
                ok: true,
                blob: blob,
                ext: caps.bestExt,
                mime: caps.bestMime,
                duration: duration,
                label: caps.bestLabel
            };
        },

        cancel() { this._cancelled = true; },

        /* ── Audio ──────────────────────────────────────────────────────── */
        _prepareAudio(project) {
            if (!S.AudioMixer.supported()) return;
            /* Les vidéos : déjà dans le cache du compositeur. */
            for (const m of project.media) {
                if (m.kind === 'video') {
                    const el = S.Compositor._elementById(m.id);
                    if (el) S.AudioMixer.attach(el, m.id);
                } else if (m.kind === 'audio') {
                    /* Les sons seuls ont besoin de leur propre élément. */
                    this._audioEls = this._audioEls || new Map();
                    if (this._audioEls.has(m.id)) continue;
                    const url = S.MediaStorage._cache.get(m.blobKey);
                    if (!url) continue;
                    const a = new Audio();
                    a.src = url;
                    a.preload = 'auto';
                    this._audioEls.set(m.id, a);
                    S.AudioMixer.attach(a, m.id);
                }
            }
        },

        _isVideoActive(project, time, el) {
            for (const layer of S.TimelineModel.clipsAt(project, time)) {
                for (const item of layer.items) {
                    const media = S.TimelineModel.media(project, item.clip.mediaId);
                    if (media && media.kind === 'video' && S.Compositor._elementById(media.id) === el) return true;
                }
            }
            return false;
        },

        _stopAll(videos, audioDest) {
            for (const el of videos) { try { el.pause(); } catch (e) {} }
            if (this._audioEls) {
                for (const a of this._audioEls.values()) { try { a.pause(); } catch (e) {} }
                this._audioEls.clear();
            }
            if (S.AudioMixer) S.AudioMixer.disconnectExport();
        },

        _cleanup(videoStream) {
            try { for (const t of videoStream.getTracks()) t.stop(); } catch (e) {}
        }
    };

    /* Débit vidéo raisonnable selon le format de séquence (§12.4). */
    function bitrateFor(seq) {
        const pixels = seq.width * seq.height;
        const base = Math.round(pixels * seq.fps * 0.12);   // ~0,12 bit/pixel/image
        return Math.max(2_000_000, Math.min(16_000_000, base));
    }

    S.Exporter = Exporter;
})();
