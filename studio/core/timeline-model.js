/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — modèle de timeline
   Opérations NON destructives sur les pistes et les clips. Un clip ne stocke
   jamais de pixels : il garde une référence au média source (`mediaId`) et des
   points d'entrée/sortie (`in` / `out`). Couper ne supprime donc rien.

   Toutes les fonctions sont pures par rapport au DOM : elles modifient le
   projet et renvoient un résumé, ce qui les rend testables sans navigateur.
   Chaque mutation appelle `ProjectModel.touch()` pour l'horodatage.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    function uid(prefix) {
        return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
            Math.random().toString(36).slice(2, 9);
    }
    const round = (n, p) => { const f = Math.pow(10, p == null ? 3 : p); return Math.round(n * f) / f; };

    /* Types de média compatibles avec chaque type de piste. */
    const TRACK_ACCEPTS = {
        video: ['video', 'image'],
        overlay: ['video', 'image'],
        text: [],
        audio: ['audio', 'video']   // la piste audio peut aussi porter l'audio d'origine d'une vidéo
    };

    const TimelineModel = {
        TRACK_ACCEPTS: TRACK_ACCEPTS,

        /* ── Recherche ──────────────────────────────────────────────────── */
        track(project, trackId) {
            return (project.tracks || []).find(t => t.id === trackId) || null;
        },
        clip(project, clipId) {
            for (const t of project.tracks || []) {
                const c = (t.clips || []).find(c => c.id === clipId);
                if (c) return { clip: c, track: t };
            }
            return null;
        },
        media(project, mediaId) {
            return (project.media || []).find(m => m.id === mediaId) || null;
        },

        /* Fin (en s) du dernier clip de la séquence. */
        duration(project) {
            let end = 0;
            for (const t of project.tracks || []) {
                for (const c of t.clips || []) {
                    const e = c.start + c.duration;
                    if (e > end) end = e;
                }
            }
            return round(end);
        },

        /* ── Pistes ─────────────────────────────────────────────────────── */
        addTrack(project, kind, name) {
            if (!project) return null;
            const track = S.ProjectModel._newTrack(kind, name);
            /* On insère les pistes vidéo/overlay au-dessus des audio, pour que
               l'ordre d'affichage reste logique. */
            if (kind === 'audio') project.tracks.push(track);
            else {
                let i = project.tracks.findIndex(t => t.kind === 'audio');
                if (i === -1) i = project.tracks.length;
                project.tracks.splice(i, 0, track);
            }
            S.ProjectModel.touch(project);
            return track;
        },

        removeTrack(project, trackId) {
            const i = (project.tracks || []).findIndex(t => t.id === trackId);
            if (i === -1) return false;
            project.tracks.splice(i, 1);
            S.ProjectModel.touch(project);
            return true;
        },

        /* ── Création d'un clip ─────────────────────────────────────────── */
        /* Construit un clip cohérent à partir d'un média + une position. */
        makeClip(media, opts) {
            opts = opts || {};
            const kind = media ? media.kind : (opts.kind || 'image');
            const isMedia = kind === 'video' || kind === 'audio';
            const srcDuration = media && media.duration > 0 ? media.duration : (opts.duration || 3);
            const duration = isMedia ? srcDuration : (opts.duration || 3);
            return {
                id: uid('clp'),
                kind: kind === 'video' && opts.asText ? 'text' : kind,
                mediaId: media ? media.id : (opts.mediaId || ''),
                start: round(opts.start || 0),
                duration: round(duration),
                in: 0,
                out: round(srcDuration),
                speed: 1,
                volume: 1,
                muted: false,
                opacity: 1,
                text: opts.text,
                style: opts.style,
                effects: [],
                transitionIn: null,
                transitionOut: null
            };
        },

        /* Le type de média accepté par une piste ? */
        accepts(track, mediaKind) {
            const list = TRACK_ACCEPTS[track.kind];
            return !!list && list.indexOf(mediaKind) !== -1;
        },

        /* ── Ajout ──────────────────────────────────────────────────────── */
        /* Renvoie le clip ajouté, ou null (piste verrouillée / type refusé /
           chevauchement). Ne casse jamais l'ordre des autres clips. */
        addClip(project, trackId, clip) {
            const track = this.track(project, trackId);
            if (!track) return null;
            if (track.locked) return null;
            if (clip.kind !== 'text' && !this.accepts(track, clip.kind)) return null;
            if (this._overlaps(track, clip.start, clip.duration, null)) return null;
            track.clips.push(clip);
            track.clips.sort((a, b) => a.start - b.start);
            S.ProjectModel.touch(project);
            return clip;
        },

        /* Place le clip à la fin de la piste (utile au dépôt depuis la
           bibliothèque : on ne risque aucun chevauchement). */
        appendClip(project, trackId, clip) {
            const track = this.track(project, trackId);
            if (!track) return null;
            let end = 0;
            for (const c of track.clips) end = Math.max(end, c.start + c.duration);
            clip.start = round(end);
            return this.addClip(project, trackId, clip);
        },

        /* Un intervalle chevauche-t-il déjà un clip de la piste ? */
        _overlaps(track, start, duration, ignoreClipId) {
            const s = start, e = start + duration;
            for (const c of track.clips) {
                if (c.id === ignoreClipId) continue;
                if (s < c.start + c.duration - 1e-6 && e > c.start + 1e-6) return true;
            }
            return false;
        },

        /* ── Suppression ────────────────────────────────────────────────── */
        removeClip(project, clipId) {
            const found = this.clip(project, clipId);
            if (!found) return null;
            if (found.track.locked) return null;
            const i = found.track.clips.indexOf(found.clip);
            found.track.clips.splice(i, 1);
            S.ProjectModel.touch(project);
            return found.clip;
        },

        /* ── Déplacement ────────────────────────────────────────────────── */
        /* Déplace un clip dans le temps et/ou vers une autre piste. Renvoie
           { ok, track, clip } — `ok:false` si la destination est refusée
           (piste verrouillée, type incompatible, chevauchement). Les autres
           clips ne sont JAMAIS décalés : c'est une exigence du §7.3. */
        moveClip(project, clipId, targetTrackId, newStart) {
            const found = this.clip(project, clipId);
            if (!found) return { ok: false, reason: 'introuvable' };
            const target = this.track(project, targetTrackId || found.track.id);
            if (!target) return { ok: false, reason: 'piste inconnue' };
            if (target.locked) return { ok: false, reason: 'piste verrouillée' };
            if (found.clip.kind !== 'text' && !this.accepts(target, found.clip.kind)) {
                return { ok: false, reason: 'type incompatible' };
            }
            const start = Math.max(0, round(newStart));
            if (this._overlaps(target, start, found.clip.duration, found.clip.id)) {
                return { ok: false, reason: 'chevauchement' };
            }
            /* Retire d'abord, sinon le clip se chevauche lui-même. */
            const i = found.track.clips.indexOf(found.clip);
            found.track.clips.splice(i, 1);
            found.clip.start = start;
            if (found.track.id !== target.id) target.clips.push(found.clip);
            target.clips.sort((a, b) => a.start - b.start);
            if (found.track.id !== target.id) found.track.clips.sort((a, b) => a.start - b.start);
            S.ProjectModel.touch(project);
            return { ok: true, clip: found.clip, track: target };
        },

        /* ── Scission à la tête de lecture ──────────────────────────────── */
        /* Coupe le clip en deux à `at`. Le morceau de droite garde la bonne
           source (`in` avance). Renvoie le clip de droite, ou null. */
        splitClip(project, clipId, at) {
            const found = this.clip(project, clipId);
            if (!found) return null;
            if (found.track.locked) return null;
            const c = found.clip;
            const local = at - c.start;
            /* Coupe seulement à l'intérieur, avec une marge pour éviter des
               fragments de quelques millisecondes. */
            if (local <= 0.01 || local >= c.duration - 0.01) return null;

            const right = JSON.parse(JSON.stringify(c));
            right.id = uid('clp');
            right.start = round(c.start + local);
            right.duration = round(c.duration - local);
            right.in = round(c.in + local * c.speed);
            right.transitionIn = null;      // la transition d'entrée reste à gauche
            c.duration = round(local);
            c.out = round(right.in);

            const i = found.track.clips.indexOf(c);
            found.track.clips.splice(i + 1, 0, right);
            S.ProjectModel.touch(project);
            return right;
        },

        /* ── Recadrage (trim) ───────────────────────────────────────────── */
        /* side: 'left' | 'right'. `delta` = déplacement du bord, en secondes
           de timeline : POSITIF = le bord avance (l'image raccourcit côté
           gauche, s'allonge côté droit).
           Bornes : durée minimale MIN, et les points source `in`/`out` ne
           sortent jamais du média. */
        trimClip(project, clipId, side, delta) {
            const found = this.clip(project, clipId);
            if (!found) return { ok: false };
            if (found.track.locked) return { ok: false };
            const c = found.clip;
            const media = this.media(project, c.mediaId);
            const maxSource = media && media.duration > 0 ? media.duration : Infinity;
            const MIN = 0.05;
            const d = round(delta);

            if (side === 'right') {
                const newDur = round(c.duration + d);
                if (newDur < MIN) return { ok: false, reason: 'durée minimale' };
                const newOut = round(c.in + newDur * c.speed);
                if (newOut > maxSource + 1e-6) return { ok: false, reason: 'fin du média' };
                if (this._overlaps(found.track, c.start, newDur, c.id)) return { ok: false, reason: 'chevauchement' };
                c.duration = newDur;
                c.out = newOut;
            } else {
                const newStart = round(c.start + d);
                const newDur = round(c.duration - d);
                const newIn = round(c.in + d * c.speed);
                if (newDur < MIN) return { ok: false, reason: 'durée minimale' };
                if (newIn < -1e-6) return { ok: false, reason: 'début du média' };
                if (newStart < -1e-6) return { ok: false, reason: 'avant le début' };
                if (this._overlaps(found.track, newStart, newDur, c.id)) return { ok: false, reason: 'chevauchement' };
                c.start = newStart;
                c.in = newIn;
                c.duration = newDur;
            }
            S.ProjectModel.touch(project);
            return { ok: true, clip: c };
        },

        /* ── Duplication ────────────────────────────────────────────────── */
        /* Le clone est posé juste après l'original, ou au premier endroit
           libre si l'espace est occupé. */
        duplicateClip(project, clipId) {
            const found = this.clip(project, clipId);
            if (!found) return null;
            if (found.track.locked) return null;
            const copy = JSON.parse(JSON.stringify(found.clip));
            copy.id = uid('clp');
            let start = round(found.clip.start + found.clip.duration);
            if (this._overlaps(found.track, start, copy.duration, null)) {
                start = this._firstFree(found.track, copy.duration, start);
                if (start === null) return null;
            }
            copy.start = start;
            found.track.clips.push(copy);
            found.track.clips.sort((a, b) => a.start - b.start);
            S.ProjectModel.touch(project);
            return copy;
        },

        /* Premier créneau libre d'au moins `duration` à partir de `from`. */
        _firstFree(track, duration, from) {
            let pos = Math.max(0, from);
            for (let guard = 0; guard < 5000; guard++) {
                if (!this._overlaps(track, pos, duration, null)) return round(pos);
                let next = Infinity;
                for (const c of track.clips) {
                    if (c.start + c.duration > pos && c.start + c.duration < next) next = c.start + c.duration;
                }
                if (next === Infinity) return null;
                pos = next;
            }
            return null;
        },

        /* ── Aimantation (magnétisme) ───────────────────────────────────── */
        /* Aligne `value` sur le bord d'un clip, la tête de lecture ou 0 s'il
           est dans le rayon `threshold`. Renvoie la valeur finalisée. */
        snapTime(project, value, opts) {
            opts = opts || {};
            const threshold = opts.threshold == null ? 8 / (opts.zoom || 60) : opts.threshold;
            const targets = [0];
            if (opts.playhead != null) targets.push(opts.playhead);
            for (const t of project.tracks || []) {
                for (const c of t.clips || []) {
                    if (opts.ignoreClipId && c.id === opts.ignoreClipId) continue;
                    targets.push(c.start, c.start + c.duration);
                }
            }
            let best = value, bestDist = threshold;
            for (const tv of targets) {
                const d = Math.abs(tv - value);
                if (d < bestDist) { best = tv; bestDist = d; }
            }
            return round(best);
        },

        /* ── Lecture à une position ─────────────────────────────────────── */
        /* Tous les clips actifs à l'instant `t`, par piste, du fond vers
           l'avant (l'ordre des pistes du modèle est déjà du fond → premier
           plan, la dernière piste étant dessinée par-dessus). */
        clipsAt(project, t) {
            const out = [];
            for (const track of project.tracks || []) {
                if (track.hidden) continue;
                const hits = [];
                for (const c of track.clips || []) {
                    if (t >= c.start && t < c.start + c.duration) {
                        hits.push({
                            clip: c,
                            track: track,
                            /* Progression 0→1 dans le clip (pour les animations). */
                            progress: c.duration > 0 ? (t - c.start) / c.duration : 0,
                            /* Position dans le média source. */
                            sourceTime: round(c.in + (t - c.start) * c.speed)
                        });
                    }
                }
                if (hits.length) out.push({ track: track, items: hits });
            }
            return out;
        }
    };

    S.TimelineModel = TimelineModel;
})();
