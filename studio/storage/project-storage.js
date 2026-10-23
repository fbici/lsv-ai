/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — persistance des projets
   Couche applicative au-dessus d'IndexedDB : valide et migre TOUS les
   projets lus (§16.3 — une base locale peut contenir une ancienne version ou
   un fichier corrompu). Un projet illisible n'est jamais supprimé
   automatiquement : il est signalé, l'utilisateur décide.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});
    const M = () => S.ProjectModel;

    const ProjectStorage = {
        supported() { return S.IDB && S.IDB.supported(); },

        /* ── Enregistrement ─────────────────────────────────────────────── */
        async save(project) {
            if (!this.supported()) return { ok: false, reason: 'no-idb' };
            if (!M().validate(project).ok) return { ok: false, reason: 'invalid' };
            try {
                await S.IDB.putProject(project);
                return { ok: true };
            } catch (e) {
                return { ok: false, reason: 'write-failed', error: e };
            }
        },

        /* ── Lecture ────────────────────────────────────────────────────── */
        /* Migre systématiquement (même pour la version courante, cela
           normalise les champs manquants). */
        async load(id) {
            if (!this.supported()) return { ok: false, reason: 'no-idb' };
            let raw;
            try {
                raw = await S.IDB.getProject(id);
            } catch (e) {
                return { ok: false, reason: 'read-failed', error: e };
            }
            if (!raw) return { ok: false, reason: 'missing' };
            const v = M().validate(raw);
            if (!v.ok) return { ok: false, reason: 'invalid', errors: v.errors, raw: raw };
            try {
                return { ok: true, project: M().migrate(raw) };
            } catch (e) {
                return { ok: false, reason: 'migrate-failed', error: e, raw: raw };
            }
        },

        /* ── Liste (écran d'accueil) ────────────────────────────────────── */
        /* Renvoie des fiches légères pour ne pas charger tous les projets. */
        async list() {
            if (!this.supported()) return [];
            try {
                const all = await S.IDB.listProjects();
                return all.map(p => ({
                    id: p.id,
                    name: p.name || 'Sans nom',
                    createdAt: p.createdAt,
                    updatedAt: p.updatedAt,
                    sequence: p.sequence,
                    mediaCount: Array.isArray(p.media) ? p.media.length : 0,
                    duration: M().duration(p),
                    /* Un projet dont le schéma est trop récent apparaît mais
                       est marqué : il ne sera pas ouvert à l'aveugle. */
                    unreadable: !M().validate(p).ok
                }));
            } catch (e) {
                return [];
            }
        },

        async remove(id) {
            if (!this.supported()) return false;
            try {
                /* Avant de supprimer la fiche, on nettoie les blobs qui ne
                   servent plus à aucun autre projet. */
                await S.IDB.deleteProject(id);
                const rest = await S.IDB.listProjects();
                const used = new Set();
                for (const p of rest) {
                    for (const m of (p.media || [])) {
                        if (m.blobKey) used.add(m.blobKey);
                    }
                }
                await S.IDB.pruneOrphans(used);
                return true;
            } catch (e) {
                return false;
            }
        },

        /* ── Export fichier (.lsvstudio.json) ───────────────────────────── */
        /* Le JSON exporté ne contient PAS les blobs : ils restent en local.
           Le fichier est donc léger et partageable ; à l'import ailleurs, les
           médias seront marqués « manquant » (§5.2) et devront être re-reliés. */
        serialize(project) {
            /* Les vignettes dataURL pèsent quelques dizaines de Ko chacune :
               le fichier exporté reste léger et « sans les médias ». */
            const light = JSON.parse(JSON.stringify(project));
            for (const m of light.media || []) m.thumb = '';
            return JSON.stringify({
                format: 'lsv-studio-project',
                schemaVersion: M().SCHEMA_VERSION,
                app: 'LSV Studio',
                exportedAt: new Date().toISOString(),
                project: light
            }, null, 2);
        },

        /* Import d'un fichier texte. Renvoie { ok, project } ou { ok, errors }. */
        importJSON(text) {
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (e) {
                return { ok: false, errors: ['Le fichier n’est pas un JSON valide.'] };
            }
            if (!parsed || typeof parsed !== 'object') {
                return { ok: false, errors: ['Le fichier n’est pas un projet LSV Studio.'] };
            }
            /* Tolère à la fois l'enveloppe d'export et un projet brut. */
            const raw = (parsed.format === 'lsv-studio-project' && parsed.project) ? parsed.project : parsed;
            const v = M().validate(raw);
            if (!v.ok) return { ok: false, errors: v.errors };
            try {
                return { ok: true, project: M().migrate(raw) };
            } catch (e) {
                return { ok: false, errors: ['Migration impossible : ' + (e && e.message)] };
            }
        },

        /* Téléchargement navigateur (aucun serveur). */
        download(project) {
            const blob = new Blob([this.serialize(project)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (project.name || 'montage').replace(/[^\w\-]+/g, '_').slice(0, 60) + '.lsvstudio.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            return true;
        }
    };

    S.ProjectStorage = ProjectStorage;
})();
