/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — gestionnaire de médias du projet courant
   Fait le lien entre l'import disque, le stockage IndexedDB et la liste
   `project.media`. Émet des événements pour que l'UI se rafraîchisse sans
   connaître les détails du stockage.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    const MediaManager = {
        listeners: [],

        on(fn) { this.listeners.push(fn); },
        emit(type, detail) {
            for (const fn of this.listeners) {
                try { fn(type, detail); } catch (e) { /* une UI cassée ne casse pas l'import */ }
            }
        },

        /* ── Import d'un ou plusieurs fichiers ──────────────────────────── */
        /* Traite séquentiellement : une progression parlot lisible, et un
           échec d'un fichier n'annule pas les autres. */
        async importFiles(project, files, onProgress) {
            const list = Array.from(files || []);
            const added = [], rejected = [];
            for (let i = 0; i < list.length; i++) {
                const f = list[i];
                if (onProgress) onProgress(i / list.length, f.name);
                const res = await S.MediaStorage.import(f);
                if (res.ok) {
                    /* Doublon ? Même nom + même taille : on réutilise. */
                    const dup = project.media.find(m =>
                        m.name === res.media.name && m.size === res.media.size && !m.missing);
                    if (dup) {
                        rejected.push({ file: f.name, reason: 'doublon' });
                        continue;
                    }
                    if (project.media.length >= S.ProjectModel.LIMITS.MAX_MEDIA) {
                        rejected.push({ file: f.name, reason: 'limite' });
                        break;
                    }
                    project.media.push(res.media);
                    added.push(res.media);
                } else {
                    rejected.push({ file: f.name, reason: res.reason, error: res.error });
                }
            }
            if (added.length) {
                S.ProjectModel.touch(project);
                this.emit('imported', { media: added, rejected: rejected });
            }
            if (onProgress) onProgress(1, '');
            return { added: added, rejected: rejected };
        },

        /* ── Suppression ────────────────────────────────────────────────── */
        /* Supprime le média de la liste ET les clips qui l'utilisaient. */
        remove(project, mediaId) {
            const i = project.media.findIndex(m => m.id === mediaId);
            if (i === -1) return 0;
            const m = project.media[i];
            project.media.splice(i, 1);
            let clipsRemoved = 0;
            for (const t of project.tracks) {
                const before = t.clips.length;
                t.clips = t.clips.filter(c => c.mediaId !== mediaId);
                clipsRemoved += before - t.clips.length;
            }
            if (m.blobKey) S.MediaStorage.revoke(m.blobKey);
            S.ProjectModel.touch(project);
            this.emit('removed', { mediaId: mediaId, clipsRemoved: clipsRemoved });
            return clipsRemoved;
        },

        /* ── Relinking (projet importé dont les blobs manquent) ────────── */
        async relink(project, mediaId, file) {
            const m = project.media.find(x => x.id === mediaId);
            if (!m) return { ok: false, reason: 'introuvable' };
            const res = await S.MediaStorage.import(file);
            if (!res.ok) return res;
            /* On conserve l'ID du média : tous les clips pointant dessus
               fonctionnent à nouveau, sans rien recréer. */
            const oldKey = m.blobKey;
            Object.assign(m, {
                blobKey: res.media.blobKey,
                thumb: res.media.thumb,
                duration: res.media.duration,
                width: res.media.width,
                height: res.media.height,
                size: res.media.size,
                mime: res.media.mime,
                missing: false
            });
            if (oldKey) S.MediaStorage.revoke(oldKey);
            S.ProjectModel.touch(project);
            this.emit('relinked', { media: m });
            return { ok: true, media: m };
        },

        /* ── Dépôt sur la timeline ──────────────────────────────────────── */
        /* Tente la piste demandée, sinon la première piste compatible, sinon
           une nouvelle piste (le dépôt doit TOUJOURS aboutir, §7.2). */
        dropOnTimeline(project, mediaId, trackId, time) {
            const m = project.media.find(x => x.id === mediaId);
            if (!m) return { ok: false, reason: 'média inconnu' };
            const TM = S.TimelineModel;
            let track = trackId ? TM.track(project, trackId) : null;

            if (track && !TM.accepts(track, m.kind)) track = null;
            if (!track) track = project.tracks.find(t => !t.locked && TM.accepts(t, m.kind)) || null;
            if (!track) {
                track = S.ProjectModel.addTrack(project, m.kind === 'audio' ? 'audio' : 'video',
                    m.kind === 'audio' ? 'Audio ' + (project.tracks.filter(t => t.kind === 'audio').length + 1)
                        : 'Vidéo ' + (project.tracks.filter(t => t.kind !== 'audio').length + 1));
            }

            const clip = TM.makeClip(m, { start: time });
            const added = TM.appendClip(project, track.id, clip);
            if (!added) return { ok: false, reason: 'chevauchement' };
            this.emit('dropped', { clip: added, track: track, media: m });
            return { ok: true, clip: added, track: track };
        },

        /* ── Résolution d'une URL de média pour le rendu ────────────────── */
        async resolveURL(mediaId, project) {
            const m = project.media.find(x => x.id === mediaId);
            if (!m) return null;
            if (m.missing || !m.blobKey) return null;
            return S.MediaStorage.getURL(m.blobKey);
        }
    };

    S.MediaManager = MediaManager;
})();
