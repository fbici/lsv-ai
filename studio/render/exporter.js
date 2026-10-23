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
                /* `await` OBLIGATOIRE : les éléments (vidéos du cache
                   compositeur + <audio> de la musique) doivent exister et
                   être raccordés au mixeur AVANT d'ajouter ses pistes. */
                await this._prepareAudio(project);
                tracks.push(...audioDest.stream.getAudioTracks());
            }
            const stream = new MediaStream(tracks);

            /* ── Enregistreur ── */
            let recorder;
            try {
                recorder = new MediaRecorder(stream, {
                    mimeType: caps.bestMime,
                    videoBitsPerSecond: this.bitrateFor(project.sequence,
                        (project.exportSettings && project.exportSettings.quality) || 'high')
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
            this._time = 0;
            const drawAll = () => S.Compositor.drawFrame(ctx, project, this._time);

            /* Éléments sonores (vidéos ET musique) : mise à l'heure + lecture. */
            const mediaEls = S.Compositor._elementsForPlayback();
            const interval = Math.max(16, Math.round(1000 / fps));

            const stopRecording = () => {
                this._stopAll(mediaEls);
                try { recorder.stop(); } catch (e) { /* déjà arrêté */ }
            };

            /* Boucle pilotée par un TIMER, pas par requestAnimationFrame :
               rAF est GELÉ quand l'onglet passe en arrière-plan, ce qui
               laissait un export interrompu, une barre bloquée et
               `_running` coincé à true pour le reste de la session. */
            let timer = null;
            const tick = async () => {
                /* Annulation : il faut COUPER l'enregistreur, sinon la
                   promesse `finished` ne se résout jamais. */
                if (this._cancelled) { stopRecording(); return; }
                const elapsed = (performance.now() - t0) / 1000;
                this._time = Math.min(duration, elapsed);

                /* Synchro des médias sonores (vidéo comme musique). */
                for (const layer of S.TimelineModel.clipsAt(project, this._time)) {
                    for (const item of layer.items) {
                        const clip = item.clip;
                        if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
                        const media = S.TimelineModel.media(project, clip.mediaId);
                        if (!media || media.missing) continue;
                        const el = S.Compositor._elementById(media.id);
                        if (!el) continue;
                        try {
                            if (Math.abs(el.currentTime - item.sourceTime) > 0.08) el.currentTime = item.sourceTime;
                            if (el.paused) el.play().catch(() => {});
                        } catch (e) { /* seek non prêt */ }
                        S.AudioMixer.setLevel(media.id,
                            (clip.muted || layer.track.muted) ? 0 : (clip.volume == null ? 1 : clip.volume), false);
                    }
                }
                /* Coupe les médias absents de l'instant. */
                for (const el of mediaEls) {
                    if (el.paused === false && !this._isMediaActive(project, this._time, el)) el.pause();
                }

                try { await drawAll(); } catch (e) { /* frame non dessinée */ }
                if (onProgress) onProgress(Math.min(1, this._time / duration),
                    'Export en cours — ' + Math.round(this._time) + ' / ' + Math.round(duration) + ' s');

                if (elapsed >= duration + 0.15) { stopRecording(); return; }
                timer = setTimeout(tick, interval);
            };
            timer = setTimeout(tick, interval);

            /* Attente de la fin (ou de l'annulation). */
            await finished;
            if (timer) clearTimeout(timer);
            this._stopAll(mediaEls);
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

        /* Débit vidéo (§12.4) : `quality` le double/halve autour de la
           référence ~0,12 bit/pixel/image — le réglage de l'UI était
           écrit dans le modèle mais JAMAIS lu par l'exporteur. */
        bitrateFor(seq, quality) {
            const pixels = seq.width * seq.height;
            const base = Math.round(pixels * seq.fps * (quality === 'low' ? 0.06 : 0.12));
            const v = Math.max(2_000_000, Math.min(16_000_000, base));
            return quality === 'low' ? Math.max(1_000_000, Math.round(v / 2)) : v;
        },

        /* ── Audio ──────────────────────────────────────────────────────── */
        /* Branche CHAQUE média sonore (vidéo ET musique) sur le mixeur, puis
           LE RELIE à la destination d'export — sans quoi le fichier produit
           était silencieux, l'audio n'allant qu'au haut-parleur. */
        async _prepareAudio(project) {
            if (!S.AudioMixer.supported()) return;
            for (const m of project.media) {
                if (m.kind !== 'video' && m.kind !== 'audio') continue;
                let el = S.Compositor._elementById(m.id);
                if (!el) {
                    try { el = await S.Compositor.elementFor(m, project); } catch (e) { el = null; }
                }
                if (!el) continue;
                if (S.AudioMixer.attach(el, m.id)) S.AudioMixer.connectToExport(m.id);
            }
        },

        _isMediaActive(project, time, el) {
            for (const layer of S.TimelineModel.clipsAt(project, time)) {
                for (const item of layer.items) {
                    if (item.clip.kind !== 'video' && item.clip.kind !== 'audio') continue;
                    const media = S.TimelineModel.media(project, item.clip.mediaId);
                    if (media && S.Compositor._elementById(media.id) === el) return true;
                }
            }
            return false;
        },

        _stopAll(els) {
            for (const el of els || []) { try { el.pause(); } catch (e) {} }
            if (S.AudioMixer) S.AudioMixer.disconnectExport();
        },

        _cleanup(videoStream) {
            try { for (const t of videoStream.getTracks()) t.stop(); } catch (e) {}
        }
    };

    S.Exporter = Exporter;
})();
