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
       On la redéclare : le Studio ne charge PAS les modules de l'app.
       Depuis v3.17.3, la bibliothèque est suffixée par le compte
       (`lsv4_assets__u<uid>`) : on lit la clé du compte connecté, sinon
       la clé nue (avant toute connexion). */
    function assetsKey() {
        try {
            const a = JSON.parse(localStorage.getItem('lsv4_account') || 'null');
            const uid = a && a.id ? String(a.id) : '';
            if (uid) {
                const scoped = 'lsv4_assets__u' + uid;
                if (localStorage.getItem(scoped) !== null) return scoped;
            }
        } catch (e) {}
        return 'lsv4_assets';
    }

    const LibraryImport = {
        /* ── Lecture de la bibliothèque du site ─────────────────────────── */
        /* Renvoie [] si le Studio est ouvert dans un navigateur sans
           historique de génération (cas normal, pas une erreur). */
        list() {
            let raw;
            try {
                raw = localStorage.getItem(assetsKey());
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
                .filter(a => a.type === 'image' || a.type === 'video' || a.type === 'audio')
                .map(a => ({
                    id: String(a.id || ''),
                    type: a.type,
                    url: a.url,
                    name: String(a.name || ({ image: 'Image', video: 'Vidéo', audio: 'Audio' })[a.type] || 'Média').slice(0, 200),
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
        /* Le CDN du fournisseur ne renvoie AUCUN en-tête CORS (mesuré en
           conditions réelles, v3.16.12) : un `fetch` navigateur y échoue
           TOUJOURS. On repasse donc par le dépôt média de la passerelle
           (`/v1/media`), qui télécharge l'image côté serveur — là où aucun
           CORS ne s'applique — et la renvoie en octets. La configuration
           partagée (../shared/config.js) donne l'URL, et le jeton du compte
           est lu dans la MÊME clé localStorage que la bibliothèque
           (`lsv4_account`) : le Studio et LSV.ai sont de même origine. */
        gatewayBase() {
            const c = window.LSV_CONFIG || {};
            return String(c.LSV_GATEWAY_URL || '').replace(/\/+$/, '');
        },
        _sessionToken() {
            try {
                const a = JSON.parse(localStorage.getItem('lsv4_account') || 'null');
                return a && a.access_token ? String(a.access_token) : '';
            } catch (e) { return ''; }
        },
        async _viaGateway(url) {
            const c = window.LSV_CONFIG || {};
            const headers = {};
            const token = this._sessionToken();
            if (token) headers.Authorization = 'Bearer ' + token;
            if (c.SUPABASE_ANON_KEY) headers.apikey = c.SUPABASE_ANON_KEY;
            let res = null;
            try {
                res = await fetch(this.gatewayBase() + '/v1/media?u=' + encodeURIComponent(url),
                    { method: 'GET', headers: headers });
            } catch (e) { return { error: 'cors' }; }
            if (res && res.status === 401) return { error: 'session' };
            if (!res || !res.ok) return { error: 'cors' };
            try {
                const blob = await res.blob();
                if (!blob || !blob.size || !blob.type) return { error: 'cors' };
                return { blob: blob };
            } catch (e) { return { error: 'cors' }; }
        },
        /* Tente le direct (autres hébergeurs), puis le dépôt média.
           Renvoie { blob } ou { error } — `session` signale un jeton expiré,
           `cors` un média réellement inaccessible. */
        async fetchBlob(url) {
            try {
                const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
                if (res && res.ok) {
                    const blob = await res.blob();
                    if (blob && blob.size && blob.type) return { blob: blob };
                }
            } catch (e) { /* cas mesuré : ce CDN bloque tout appel cross-origin */ }
            const base = this.gatewayBase();
            if (base && /^https:\/\//i.test(url)) return this._viaGateway(url);
            return { error: 'cors' };
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

            const got = await this.fetchBlob(asset.url);
            if (!got || !got.blob) {
                /* Ni le CDN ni le dépôt média n'ont rendu les octets : on le
                   dit plutôt que de faire semblant (§20.14). */
                return { ok: false, reason: (got && got.error) || 'cors' };
            }
            const blob = got.blob;

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
            if (!res.ok) return { ok: false, reason: res.reason || 'import', error: res.error };

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
                else failed.push({ asset: a, reason: r.reason, error: r.error });
            }
            if (onProgress) onProgress(1, '');
            return { added: added, skipped: skipped, failed: failed };
        },

        /* Message lisible pour un échec (utilisé par le panneau). */
        reasonLabel(reason) {
            return ({
                cors: 'impossible à récupérer (hébergé chez le fournisseur)',
                session: 'session expirée — rouvre LSV.ai puis réessaie',
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
