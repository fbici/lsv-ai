/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — modèle de projet
   Un projet est un objet sérialisable, VERSIONNÉ et indépendant du moteur de
   rendu. Les fichiers binaires n'y figurent JAMAIS (pas de base64) : ils
   vivent à part dans IndexedDB et sont référencés par `blobKey`.

   `validate()` est écrit pour des données NON FIABLES : tout projet importé
   depuis un fichier est traité comme hostile (cf. §16.3). Rien n'est exécuté,
   tout est borné, et un projet invalide est refusé sans corrompre le reste.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    /* Bornes dures : protègent la mémoire et empêchent les valeurs absurdes
       d'un fichier importé de faire planter le rendu. */
    const LIMITS = {
        MAX_NAME: 80,
        MAX_MEDIA: 500,
        MAX_TRACKS: 24,
        MAX_CLIPS_PER_TRACK: 2000,
        MAX_CLIPS: 8000,
        MAX_DURATION: 60 * 60,      // 1 heure de séquence
        MAX_DIMENSION: 7680,        // 8K
        MIN_DIMENSION: 16,
        MAX_FPS: 120,
        MIN_FPS: 1,
        MAX_TEXT: 2000,
        MAX_EFFECTS: 12
    };

    /* Formats prédéfinis (§8.1). Le vertical Full HD est le défaut, cible
       TikTok / Reels / Shorts. */
    const SEQUENCES = [
        { id: 'vertical-fhd', label: 'Vertical Full HD', width: 1080, height: 1920, fps: 30, use: 'TikTok, Reels, Shorts' },
        { id: 'vertical-hd', label: 'Vertical léger', width: 720, height: 1280, fps: 30, use: 'Export plus rapide' },
        { id: 'square', label: 'Carré', width: 1080, height: 1080, fps: 30, use: 'Publications carrées' },
        { id: 'horizontal-fhd', label: 'Horizontal Full HD', width: 1920, height: 1080, fps: 30, use: 'YouTube classique' }
    ];

    const TRACK_KINDS = ['video', 'overlay', 'text', 'audio'];

    function uid(prefix) {
        return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
            Math.random().toString(36).slice(2, 9);
    }

    /* Vérifie qu'une valeur est un nombre fini dans [min, max]. */
    function num(v, min, max, dflt) {
        const n = Number(v);
        if (!isFinite(n)) return dflt;
        return Math.min(max, Math.max(min, n));
    }

    /* Chaîne courte et sûre (pas de HTML injecté plus tard : on ne stocke que
       du texte, l'échappement se fait à l'affichage). */
    function str(v, max) {
        if (typeof v !== 'string') return '';
        return v.slice(0, max);
    }

    const ProjectModel = {
        SCHEMA_VERSION: 1,
        LIMITS: LIMITS,
        SEQUENCES: SEQUENCES,
        TRACK_KINDS: TRACK_KINDS,

        /* ── Création ───────────────────────────────────────────────────── */
        create(opts) {
            opts = opts || {};
            const seq = this.sequenceById(opts.sequenceId) || SEQUENCES[0];
            const now = new Date().toISOString();
            return {
                schemaVersion: this.SCHEMA_VERSION,
                id: uid('prj'),
                name: str(opts.name, LIMITS.MAX_NAME) || 'Nouveau montage',
                createdAt: now,
                updatedAt: now,
                sequence: { width: seq.width, height: seq.height, fps: seq.fps },
                media: [],
                tracks: [this._newTrack('video', 'Vidéo 1'), this._newTrack('audio', 'Audio 1')],
                exportSettings: { format: 'auto', quality: 'high', name: str(opts.name, LIMITS.MAX_NAME) || 'montage' }
            };
        },

        _newTrack(kind, name) {
            return { id: uid('trk'), kind: kind, name: name || kind, locked: false, muted: false, hidden: false, clips: [] };
        },

        sequenceById(id) { return SEQUENCES.find(s => s.id === id) || null; },

        /* Marque le projet modifié (appelé par TOUTE mutation du timeline-model). */
        touch(project) {
            if (project) project.updatedAt = new Date().toISOString();
            return project;
        },

        rename(project, name) {
            if (!project) return null;
            project.name = str(name, LIMITS.MAX_NAME) || 'Nouveau montage';
            return this.touch(project);
        },

        /* Durée totale = fin du dernier clip de toutes les pistes. */
        duration(project) {
            if (!project || !Array.isArray(project.tracks)) return 0;
            let end = 0;
            for (const t of project.tracks) {
                if (!t || !Array.isArray(t.clips)) continue;
                for (const c of t.clips) {
                    if (c && typeof c.start === 'number' && c.start + (c.duration || 0) > end) {
                        end = c.start + (c.duration || 0);
                    }
                }
            }
            return end;
        },

        /* ── Validation (données NON fiables) ───────────────────────────── */
        /* Renvoie { ok, errors[] }. Ne lève jamais. Ne modifie jamais. */
        validate(raw) {
            const errors = [];
            const fail = m => { errors.push(m); return { ok: false, errors: errors }; };
            const ok = () => ({ ok: errors.length === 0, errors: errors });

            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return fail('Le fichier projet n’est pas un objet JSON valide.');
            }
            /* Aucune fonction, aucune classe, aucune propriété dangereuse :
               on ne reconstruit l'objet que depuis des valeurs scalaires. */
            const dangerous = ['__proto__', 'constructor', 'prototype'];
            for (const k of dangerous) {
                if (Object.prototype.hasOwnProperty.call(raw, k)) {
                    return fail('Le fichier projet contient une propriété interdite.');
                }
            }

            const v = Number(raw.schemaVersion);
            if (!isFinite(v)) return fail('Version du schéma absente ou illisible.');
            if (v > this.SCHEMA_VERSION) {
                return fail('Ce projet a été créé avec une version plus récente de LSV Studio (' +
                    v + '). Mets à jour l’application pour l’ouvrir.');
            }
            if (v < 1) return fail('Version du schéma invalide.');

            if (typeof raw.name !== 'string' || !raw.name.trim()) return fail('Le nom du projet manque.');
            if (raw.name.length > LIMITS.MAX_NAME) return fail('Le nom du projet est trop long.');

            const seq = raw.sequence;
            if (!seq || typeof seq !== 'object') return fail('Le format de séquence manque.');
            const w = Number(seq.width), h = Number(seq.height), fps = Number(seq.fps);
            if (!isFinite(w) || !isFinite(h) || !isFinite(fps)) return fail('Dimensions ou fréquence illisibles.');
            if (w < LIMITS.MIN_DIMENSION || h < LIMITS.MIN_DIMENSION ||
                w > LIMITS.MAX_DIMENSION || h > LIMITS.MAX_DIMENSION) {
                return fail('Dimensions de séquence hors limites.');
            }
            if (fps < LIMITS.MIN_FPS || fps > LIMITS.MAX_FPS) return fail('Fréquence d’images hors limites.');

            if (!Array.isArray(raw.media)) return fail('La liste des médias manque.');
            if (raw.media.length > LIMITS.MAX_MEDIA) return fail('Trop de médias dans le projet.');

            if (!Array.isArray(raw.tracks)) return fail('La liste des pistes manque.');
            if (raw.tracks.length > LIMITS.MAX_TRACKS) return fail('Trop de pistes.');

            let clipTotal = 0;
            const mediaIds = new Set();
            for (const m of raw.media) {
                if (!m || typeof m !== 'object') return fail('Entrée de média invalide.');
                if (typeof m.id !== 'string' || !m.id) return fail('Média sans identifiant.');
                if (mediaIds.has(m.id)) return fail('Identifiant de média en double.');
                mediaIds.add(m.id);
                if (!['video', 'image', 'audio'].includes(m.kind)) return fail('Type de média inconnu : ' + m.kind);
                if (m.duration != null && !isFinite(Number(m.duration))) return fail('Durée de média illisible.');
            }

            for (const t of raw.tracks) {
                if (!t || typeof t !== 'object') return fail('Piste invalide.');
                if (typeof t.id !== 'string' || !t.id) return fail('Piste sans identifiant.');
                if (!TRACK_KINDS.includes(t.kind)) return fail('Type de piste inconnu : ' + t.kind);
                if (!Array.isArray(t.clips)) return fail('Piste sans liste de clips.');
                if (t.clips.length > LIMITS.MAX_CLIPS_PER_TRACK) return fail('Trop de clips sur une piste.');
                clipTotal += t.clips.length;
                for (const c of t.clips) {
                    if (!c || typeof c !== 'object') return fail('Clip invalide.');
                    if (typeof c.id !== 'string' || !c.id) return fail('Clip sans identifiant.');
                    if (typeof c.mediaId !== 'string') return fail('Clip sans média référencé.');
                    if (c.kind !== 'text' && !mediaIds.has(c.mediaId)) {
                        return fail('Un clip pointe vers un média absent du projet.');
                    }
                    if (!isFinite(Number(c.start)) || Number(c.start) < 0) return fail('Position de clip invalide.');
                    if (!isFinite(Number(c.duration)) || Number(c.duration) < 0) return fail('Durée de clip invalide.');
                    if (Number(c.start) + Number(c.duration) > LIMITS.MAX_DURATION) return fail('Clip hors durée maximale.');
                    if (c.in != null && (!isFinite(Number(c.in)) || Number(c.in) < 0)) return fail('Point d’entrée invalide.');
                    if (c.speed != null && (!isFinite(Number(c.speed)) || Number(c.speed) <= 0 || Number(c.speed) > 8)) {
                        return fail('Vitesse de lecture hors limites.');
                    }
                    if (c.effects != null) {
                        if (!Array.isArray(c.effects)) return fail('Liste d’effets invalide.');
                        if (c.effects.length > LIMITS.MAX_EFFECTS) return fail('Trop d’effets sur un clip.');
                    }
                    if (c.text != null && typeof c.text === 'string' && c.text.length > LIMITS.MAX_TEXT) {
                        return fail('Texte de clip trop long.');
                    }
                }
            }
            if (clipTotal > LIMITS.MAX_CLIPS) return fail('Trop de clips dans le projet.');

            return ok();
        },

        /* ── Migration ──────────────────────────────────────────────────── */
        /* Reconstruit un objet PROPRE à partir d'une source validée. C'est la
           seule fonction qui touche un projet importé : elle ne recopie que
           des scalaires bornés, donc ni prototype pollution ni exécution. */
        migrate(raw) {
            const now = new Date().toISOString();
            const seq = raw.sequence || {};
            const project = {
                schemaVersion: this.SCHEMA_VERSION,
                id: str(raw.id, 64) || uid('prj'),
                name: str(raw.name, LIMITS.MAX_NAME) || 'Projet importé',
                createdAt: str(raw.createdAt, 40) || now,
                updatedAt: now,
                sequence: {
                    width: num(seq.width, LIMITS.MIN_DIMENSION, LIMITS.MAX_DIMENSION, 1080),
                    height: num(seq.height, LIMITS.MIN_DIMENSION, LIMITS.MAX_DIMENSION, 1920),
                    fps: num(seq.fps, LIMITS.MIN_FPS, LIMITS.MAX_FPS, 30)
                },
                media: [],
                tracks: [],
                exportSettings: {
                    format: str((raw.exportSettings || {}).format, 10) || 'auto',
                    quality: str((raw.exportSettings || {}).quality, 10) || 'high',
                    name: str((raw.exportSettings || {}).name, LIMITS.MAX_NAME) || 'montage'
                }
            };

            for (const m of raw.media) {
                project.media.push({
                    id: str(m.id, 64) || uid('med'),
                    name: str(m.name, 200),
                    kind: ['video', 'image', 'audio'].includes(m.kind) ? m.kind : 'video',
                    mime: str(m.mime, 100),
                    duration: num(m.duration, 0, LIMITS.MAX_DURATION, 0),
                    width: num(m.width, 0, LIMITS.MAX_DIMENSION, 0),
                    height: num(m.height, 0, LIMITS.MAX_DIMENSION, 0),
                    size: num(m.size, 0, Number.MAX_SAFE_INTEGER, 0),
                    fps: num(m.fps, 0, LIMITS.MAX_FPS, 0),
                    /* Vignette dataURL (webp ~320 px) : 200 caractères la
                       tronquait en une source illisible au rechargement —
                       l'image disparaissait dès qu'on actualisait la page. */
                    thumb: str(m.thumb, 120000),
                    blobKey: str(m.blobKey, 80),
                    /* Un média dont le blob est introuvable n'est PAS supprimé :
                       on le marque et on propose de le re-relier (§5.2). */
                    missing: m.missing === true
                });
            }

            for (const t of raw.tracks) {
                const track = {
                    id: str(t.id, 64) || uid('trk'),
                    kind: TRACK_KINDS.includes(t.kind) ? t.kind : 'video',
                    name: str(t.name, 60),
                    locked: t.locked === true,
                    muted: t.muted === true,
                    hidden: t.hidden === true,
                    clips: []
                };
                for (const c of t.clips) {
                    track.clips.push({
                        id: str(c.id, 64) || uid('clp'),
                        kind: c.kind === 'text' ? 'text' : undefined,
                        mediaId: str(c.mediaId, 64),
                        start: num(c.start, 0, LIMITS.MAX_DURATION, 0),
                        duration: num(c.duration, 0, LIMITS.MAX_DURATION, 0),
                        in: num(c.in, 0, LIMITS.MAX_DURATION, 0),
                        out: num(c.out, 0, LIMITS.MAX_DURATION, 0),
                        speed: num(c.speed, 0.1, 8, 1),
                        volume: num(c.volume, 0, 4, 1),
                        muted: c.muted === true,
                        opacity: num(c.opacity, 0, 1, 1),
                        text: c.text != null ? str(c.text, LIMITS.MAX_TEXT) : undefined,
                        style: c.style && typeof c.style === 'object' ? sanitizeStyle(c.style) : undefined,
                        effects: Array.isArray(c.effects)
                            ? c.effects.slice(0, LIMITS.MAX_EFFECTS).map(sanitizeEffect).filter(Boolean)
                            : [],
                        transitionIn: sanitizeTransition(c.transitionIn),
                        transitionOut: sanitizeTransition(c.transitionOut)
                    });
                }
                project.tracks.push(track);
            }

            return project;
        },

        /* Clone profond d'un projet (pour dupliquer / annuler). */
        clone(project) {
            return JSON.parse(JSON.stringify(project));
        }
    };

    /* Les effets, styles et transitions viennent du même fichier hostile :
       on ne garde que des nombres bornés et des chaîtes courtes. */
    function sanitizeEffect(e) {
        if (!e || typeof e !== 'object') return null;
        const out = { type: str(e.type, 30) };
        for (const k of ['brightness', 'contrast', 'saturate', 'opacity', 'zoom', 'x', 'y', 'rotate']) {
            if (e[k] != null) out[k] = num(e[k], -10, 10, 0);
        }
        return out;
    }

    function sanitizeStyle(st) {
        const out = {};
        for (const k of ['font', 'color', 'bg', 'align', 'stroke', 'shadow', 'fontSize']) {
            if (st[k] != null) out[k] = typeof st[k] === 'number' ? num(st[k], 0, 2000, 0) : str(st[k], 80);
        }
        return out;
    }

    function sanitizeTransition(t) {
        if (!t || typeof t !== 'object') return null;
        const type = str(t.type, 30);
        if (!type) return null;
        return { type: type, duration: num(t.duration, 0.05, 5, 0.5) };
    }

    S.ProjectModel = ProjectModel;
})();
