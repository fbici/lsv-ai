/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — détection des capacités du navigateur
   Le montage et l'export sont 100 % locaux : tout dépend de ce que le
   navigateur expose réellement. Ce module répond UNE fois, sans jamais lancer
   d'exception (il tourne aussi sous jsdom, où MediaRecorder, AudioContext et
   indexedDB sont absents).

   Règle du projet : on signale ce qui est impossible plutôt que de simuler.
   ═══════════════════════════════════════════════════════════════════════════ */

const LSVStudio = (window.LSVStudio = window.LSVStudio || {});

LSVStudio.Capability = {
    _cache: null,

    /* Candidats, du meilleur au plus large. Le premier accepté est retenu.
       MP4/H.264+AAC d'abord (publiable tel quel sur les réseaux sociaux),
       puis WebM VP9, puis VP8 qui reste le plus universel. */
    MIME_CANDIDATES: [
        { mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', ext: 'mp4', label: 'MP4 (H.264 + AAC)' },
        { mime: 'video/mp4;codecs="avc1.640028,mp4a.40.2"', ext: 'mp4', label: 'MP4 (H.264 Haute profil + AAC)' },
        { mime: 'video/webm;codecs="vp9,opus"', ext: 'webm', label: 'WebM (VP9 + Opus)' },
        { mime: 'video/webm;codecs="vp8,opus"', ext: 'webm', label: 'WebM (VP8 + Opus)' },
        { mime: 'video/webm', ext: 'webm', label: 'WebM' }
    ],

    /* Recalcule (ou renvoie le cache). force = ignore le cache. */
    detect(force) {
        if (this._cache && !force) return this._cache;

        const g = (typeof window !== 'undefined') ? window : {};
        const n = (typeof navigator !== 'undefined') ? navigator : {};

        const caps = {
            indexedDB: !!g.indexedDB,
            mediaRecorder: typeof g.MediaRecorder === 'function',
            canvasCapture: false,
            webAudio: !!(g.AudioContext || g.webkitAudioContext),
            filters: false,
            objectURL: !!(g.URL && typeof g.URL.createObjectURL === 'function'),
            storagePersist: !!(n.storage && typeof n.storage.estimate === 'function'),
            crossOriginIsolated: !!g.crossOriginIsolated,
            sharedArrayBuffer: typeof g.SharedArrayBuffer === 'function',
            recordingMimes: [],
            bestMime: null,
            bestExt: null,
            bestLabel: null,
            supported: false,
            blockers: [],
            warnings: []
        };

        /* captureStream sur un canvas : requis pour l'export. */
        try {
            const c = document.createElement('canvas');
            c.width = 2; c.height = 2;
            caps.canvasCapture = typeof c.captureStream === 'function';
        } catch (e) { caps.canvasCapture = false; }

        /* ctx.filter (luminosité / contraste / saturation). Non implémenté sur
           certains Safari : les effets correspondants seront désactivés. */
        try {
            const probe = document.createElement('canvas').getContext('2d');
            caps.filters = !!(probe && 'filter' in CanvasRenderingContext2D.prototype);
        } catch (e) { caps.filters = false; }

        /* Quels conteneurs/codecs MediaRecorder accepte-t-il réellement ? */
        if (caps.mediaRecorder && typeof g.MediaRecorder.isTypeSupported === 'function') {
            for (const cand of this.MIME_CANDIDATES) {
                let ok = false;
                try { ok = g.MediaRecorder.isTypeSupported(cand.mime); } catch (e) { ok = false; }
                if (ok) {
                    caps.recordingMimes.push(cand);
                    if (!caps.bestMime) {
                        caps.bestMime = cand.mime;
                        caps.bestExt = cand.ext;
                        caps.bestLabel = cand.label;
                    }
                }
            }
        }

        /* Bloquants : sans quoi l'éditeur ne peut pas fonctionner du tout. */
        if (!caps.indexedDB) {
            caps.blockers.push(
                'Ce navigateur ne fournit pas IndexedDB : les montages ne peuvent pas être ' +
                'sauvegardés localement. Essaie avec une version récente de Chrome, Edge, Firefox ou Safari.'
            );
        }
        if (!caps.canvasCapture) {
            caps.blockers.push(
                'Ce navigateur ne sait pas capturer un dessin de canvas : l’export vidéo est ' +
                'impossible ici. L’aperçu reste utilisable.'
            );
        }

        /* Avertissements : on peut monter, mais pas (ou moins bien) exporter. */
        if (!caps.mediaRecorder || !caps.bestMime) {
            caps.warnings.push(
                'Aucun format d’enregistrement vidéo n’est disponible ici : tu peux monter et ' +
                'prévisualiser, mais l’export est désactivé.'
            );
        }
        if (!caps.webAudio) {
            caps.warnings.push(
                'Web Audio indisponible : le mixage audio et les fondus seront ignorés à l’export.'
            );
        }
        if (!caps.filters) {
            caps.warnings.push(
                'Les effets luminosité / contraste / saturation ne sont pas pris en charge sur ce ' +
                'navigateur et seront ignorés.'
            );
        }
        if (caps.bestExt === 'webm') {
            caps.warnings.push(
                'Ce navigateur produit du WebM, pas du MP4. Le WebM est lisible partout sur ordinateur ' +
                'et accepté par la plupart des plateformes, mais vérifie le rendu final.'
            );
        }

        caps.supported = caps.indexedDB && !!caps.bestMime;
        this._cache = caps;
        return caps;
    },

    /* Raccourci : le meilleur mime d'enregistrement, ou null. */
    bestMime() { return this.detect().bestMime; },

    /* Raccourci : l'extension réellement produite ('mp4' | 'webm' | null).
       On ne renomme JAMAIS un fichier : l'extension suit le conteneur. */
    bestExt() { return this.detect().bestExt; },

    /* Résumé compact pour l'affichage. */
    summary() {
        const c = this.detect();
        return {
            format: c.bestLabel || 'export indisponible',
            editable: c.indexedDB && c.canvasCapture,
            exportable: !!c.bestMime
        };
    },

    /* Remet à zéro le cache (utile dans les tests). */
    reset() { this._cache = null; }
};
