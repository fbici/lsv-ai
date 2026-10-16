/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — import depuis la bibliothèque LSV.ai
   BUT : éviter à l'utilisateur de télécharger puis re-téléverser ses
   créations. Le Studio et LSV.ai partagent la même origine, donc le Studio
   peut lire directement `localStorage['lsv4_assets']` — la bibliothèque
   locale où le site enregistre chaque image/vidéo générée.

   À l'import, le média est RÉCUPÉRÉ en Blob puis stocké dans IndexedDB :
   deux bénéfices — le Studio n'a plus dépendre d'une URL externe, et une
   URL signée qui expirerait chez le fournisseur n'entraîne plus la perte du
   média (problème latente de la bibliothèque du site).

   Si le navigateur refuse la récupération (CORS), on le signale clairement
   et on propose le repli (télécharger depuis la Bibliothèque, puis déposer).
   On ne simule jamais un import qui n'a pas eu lieu (§20.14).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    /* Clé écrite par LSV.ai (scripts/constants.js → STORAGE_KEYS.ASSETS).
       On la redéclare : le Studio ne charge PAS les modules de l'app. */
    const ASSETS_KEY = 'lsv4_assets';

    const LibraryImport = {
        /* ── Lecture de la bibliothèque du site ─────────────────────────── */
        /* Renvoie [] si le Studio est ouvert dans un navigateur sans
           historique de génération (cas normal, pas une erreur). */
        list() {
            let raw;
            try {
                raw = localStorage.getItem(ASSETS_KEY);
            } catch (e) {
                return [];   // stockage désactivé
            }
            if (!raw) return [];
            let arr;
            try {
                arr = JSON.parse(raw);
            } catch (e) {
                return [];   // données corrompues côté site : on n'interfère pas
            }
            if (!Array.isArray(arr)) return [];
            return arr
                .filter(a => a && typeof a === 'object' && typeof a.url === 'string' && a.url)
                .filter(a => a.type === 'image' || a.type === 'video')
                .map(a => ({
                    id: String(a.id || ''),
                    type: a.type,
                    url: a.url,
                    name: String(a.name || (a.type === 'image' ? 'Image' : 'Vidéo')).slice(0, 200),
                    ratio: (a.metadata && a.metadata.ratio) || null,
                    size: (a.metadata && a.metadata.size) || null,
                    style: (a.metadata && a.metadata.style) || null,
                    duration: (a.metadata && a.metadata.duration) || null,
                    createdAt: a.createdAt || 0
                }))
                /* Les plus récents en tête (ordre d'insertion du site). */
                .sort((a, b) => b.createdAt - a.createdAt);
        },

        /* Quels assets de la bibliothèque sont déjà dans le projet ? */
        importedSet(project) {
            const set = new Set();
            for (const m of (project && project.media) || []) {
                if (m.sourceUrl) set.add(m.sourceUrl);
            }
            return set;
        },

        /* ── Récupération du média ──────────────────────────────────────── */
        /* Tente un fetch → Blob. Renvoie null si CORS/ réseau refuse. */
        async fetchBlob(url) {
            try {
                const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
                if (!res.ok) return null;
                const blob = await res.blob();
                /* Un blob vide ou d'un type inconnu ne sert à rien. */
                if (!blob || !blob.size || !blob.type) return null;
                return blob;
            } catch (e) {
                return null;
            }
        },

        /* ── Import dans le projet ──────────────────────────────────────── */
        /* Renvoie { ok, media?, reason? }. L'URL source est conservée dans
           `media.sourceUrl` pour dédupliquer et savoir d'où vient le média. */
        async import(project, asset) {
            if (!project || !asset || !asset.url) return { ok: false, reason: 'invalide' };
            if (project.media.length >= S.ProjectModel.LIMITS.MAX_MEDIA) {
                return { ok: false, reason: 'limite' };
            }
            /* Déjà dans le projet : on ne duplique pas. */
            if (project.media.some(m => m.sourceUrl === asset.url)) {
                return { ok: false, reason: 'déjà présent' };
            }

            const blob = await this.fetchBlob(asset.url);
            if (!blob) {
                /* CORS : le navigateur refuse de lire un média hébergé chez le
                   fournisseur. On le dit plutôt que de faire semblant. */
                return { ok: false, reason: 'cors' };
            }

            /* MediaStorage attend un Blob avec un nom de fichier. */
            const ext = (blob.type.split('/')[1] || 'bin').split(';')[0];
            let file = blob;
            try {
                file = new File([blob], (asset.name || 'lsv').replace(/[^\w.\-]+/g, '_') + '.' + ext, { type: blob.type });
            } catch (e) {
                /* File indisponible : on colle le nom sur le Blob. */
                try { blob.name = (asset.name || 'lsv') + '.' + ext; } catch (e2) {}
            }

            const res = await S.MediaStorage.import(file);
            if (!res.ok) return { ok: false, reason: res.reason || 'import' };

            res.media.sourceUrl = asset.url;
            /* On garde le nom tel que visible dans la Bibliothèque. */
            if (asset.name) res.media.name = asset.name;
            project.media.push(res.media);
            S.ProjectModel.touch(project);
            return { ok: true, media: res.media };
        },

        /* Import en série (bouton « Tout importer »). Séquentiel pour garder
           une progression lisible et ne pas paralléliser les écritures IDB. */
        async importMany(project, assets, onProgress) {
            const added = [], skipped = [], failed = [];
            for (let i = 0; i < assets.length; i++) {
                const a = assets[i];
                if (onProgress) onProgress(i / assets.length, a.name);
                const r = await this.import(project, a);
                if (r.ok) added.push(r.media);
                else if (r.reason === 'déjà présent') skipped.push(a);
                else failed.push({ asset: a, reason: r.reason });
            }
            if (onProgress) onProgress(1, '');
            return { added: added, skipped: skipped, failed: failed };
        },

        /* Message lisible pour un échec (utilisé par le panneau). */
        reasonLabel(reason) {
            return ({
                cors: 'impossible à récupérer (hébergé chez le fournisseur)',
                limite: 'limite de médias du projet atteinte',
                'déjà présent': 'déjà dans le projet',
                invalide: 'entrée de bibliothèque illisible',
                'not-a-file': 'fichier illisible',
                unsupported: 'format non supporté',
                'write-failed': 'stockage local plein ou bloqué',
                import: 'échec de l’import'
            })[reason] || reason;
        }
    };

    S.LibraryImport = LibraryImport;
})();
