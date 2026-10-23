/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — persistance des médias
   Stocke les fichiers bruts (Blob) et leur vignette dans IndexedDB, sous une
   clé opaque. Le projet ne référence QUE cette clé : rien de binaire ne
   transite par le JSON.

   Les vignettes sont générées au moment de l'import (une seule fois), en
   dehors du thread de rendu. Si le navigateur ne sait pas (jsdom, codecs
   absents), l'import RÉUSSIT quand même : la vignette est simplement absente
   (§20.14 — on ne simule pas, on signale).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    function uidKey() {
        return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    /* Dessine une image/cadre vidéo dans un canvas de `size` px de large. */
    function canvasThumb(source, size) {
        const w = size || 320;
        const h = Math.max(1, Math.round(w * (source.videoHeight || source.naturalHeight || 1) /
            (source.videoWidth || source.naturalWidth || 1)));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(source, 0, 0, w, h);
        return c;
    }

    /* Attends la première frame réelle d'un <video> (ou échoue proprement). */
    function grabVideoFrame(video) {
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = ok => {
                if (done) return;
                done = true;
                cleanup();
                ok ? resolve() : reject(new Error('frame'));
            };
            const cleanup = () => {
                video.removeEventListener('loadeddata', onReady);
                video.removeEventListener('seeked', onSeeked);
                video.removeEventListener('error', onError);
                clearTimeout(timer);
            };
            const onReady = () => {
                try { video.currentTime = Math.min(0.1, (video.duration || 1) / 10); } catch (e) { finish(false); }
            };
            const onSeeked = () => finish(true);
            const onError = () => finish(false);
            const timer = setTimeout(() => finish(false), 4000);
            video.addEventListener('loadeddata', onReady);
            video.addEventListener('seeked', onSeeked);
            video.addEventListener('error', onError);
            if (video.readyState >= 2) onReady();
        });
    }

    /* Mesure la durée réelle d'un média par le lecteur natif. Timeout : 6 s. */
    function probeMedia(file) {
        return new Promise(resolve => {
            const url = URL.createObjectURL(file);
            let el, timer, settled = false;
            const finish = info => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { URL.revokeObjectURL(url); } catch (e) {}
                if (el) { el.src = ''; }
                resolve(info);
            };
            timer = setTimeout(() => finish({}), 6000);
            if (file.type.startsWith('image/')) {
                el = new Image();
                el.onload = () => finish({ width: el.naturalWidth, height: el.naturalHeight });
                el.onerror = () => finish({});
                el.src = url;
            } else {
                el = document.createElement('video');
                el.preload = 'metadata';
                el.muted = true;
                el.onloadedmetadata = () => finish({
                    duration: el.duration,
                    width: el.videoWidth,
                    height: el.videoHeight
                });
                el.onerror = () => finish({});
                el.src = url;
            }
        });
    }

    const MediaStorage = {
        supported() { return S.IDB && S.IDB.supported(); },

        /* ── Diagnostic d'un échec d'écriture ──────────────────────────────
           « stockage local plein ou bloqué » ne dit pas lequel des deux, ni
           pourquoi : le navigateur connaît la cause (`error.name`) et, pour
           un quota dépassé, l'occupation réelle. On affiche ce qu'on sait
           plutôt qu'une alternative floue. */
        async explainWriteFailure(err) {
            const name = String((err && err.name) || '').slice(0, 40);
            /* Nos propres rejets portent le diagnostic dans `message`
               (« IndexedDB indisponible », « Base de données bloquée ») :
               sans le message, on n'affiche que « (Error) », inutile.
               Sanitizé (pas de HTML, taille bornée) car `message` peut
               aussi venir du navigateur. */
            const msg = String((err && err.message) || '')
                .replace(/[^\w\s().,:\/+\-\u00C0-\u024F\u2010-\u203A]/g, ' ')
                .replace(/\s+/g, ' ').trim().slice(0, 60);
            const mo = n => Math.max(0, Math.round(n / (1024 * 1024))) + ' Mo';
            if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
                let est = null;
                if (this.supported()) { try { est = await S.IDB.estimateUsage(); } catch (e) { est = null; } }
                return est && est.quota
                    ? 'stockage local plein (' + mo(est.usage) + ' utilisés sur ' + mo(est.quota) + ')'
                    : 'stockage local plein';
            }
            if (name && name !== 'Error') return 'écriture refusée (' + name + ')';
            if (msg) return 'écriture refusée (' + msg + ')';
            if (!this.supported()) return 'stockage local indisponible (navigation privée ?)';
            return 'écriture refusée';
        },

        /* ── Import ─────────────────────────────────────────────────────── */
        /* Renvoie une fiche média (sans le Blob, qui reste dans IDB). */
        async import(file, opts) {
            opts = opts || {};
            if (!file || !(file instanceof Blob)) {
                return { ok: false, reason: 'not-a-file' };
            }
            const kind = file.type.startsWith('video/') ? 'video'
                : file.type.startsWith('audio/') ? 'audio'
                : file.type.startsWith('image/') ? 'image' : null;
            if (!kind) return { ok: false, reason: 'unsupported', mime: file.type };

            const meta = await probeMedia(file);
            const key = uidKey();

            /* Vignette : images directement, vidéo après une frame, audio : rien. */
            let thumbBlob = null, thumbURL = null, thumbData = null;
            try {
                if (kind === 'image') {
                    const img = new Image();
                    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = URL.createObjectURL(file); });
                    const c = canvasThumb(img, 320);
                    if (c) thumbData = c.toDataURL('image/webp', 0.7);
                    URL.revokeObjectURL(img.src);
                } else if (kind === 'video') {
                    const v = document.createElement('video');
                    v.muted = true; v.playsInline = true; v.preload = 'auto';
                    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; v.src = URL.createObjectURL(file); });
                    await grabVideoFrame(v);
                    const c = canvasThumb(v, 320);
                    if (c) thumbData = c.toDataURL('image/webp', 0.7);
                    URL.revokeObjectURL(v.src);
                }
            } catch (e) {
                /* Vignette échouée : ce n'est pas bloquant (§20.14). */
                thumbData = null;
            }

            if (this.supported()) {
                try {
                    await S.IDB.putMedia(key, file, thumbBlob);
                } catch (e) {
                    return { ok: false, reason: 'write-failed', error: e };
                }
            }

            return {
                ok: true,
                media: {
                    id: 'med-' + key,
                    name: (file.name || 'médiasansnom').slice(0, 200),
                    kind: kind,
                    mime: file.type,
                    duration: meta.duration || 0,
                    width: meta.width || 0,
                    height: meta.height || 0,
                    size: file.size,
                    fps: 0,
                    thumb: thumbData || '',
                    blobKey: key,
                    missing: false
                }
            };
        },

        /* ── Lecture ────────────────────────────────────────────────────── */
        /* Renvoie un `objectURL` ; L'APPELANT doit le révoquer (voir
           `revoke`). L'URL est mise en cache pour éviter de re-créer des
           objets à chaque frame. */
        _cache: new Map(),

        async getURL(blobKey) {
            if (this._cache.has(blobKey)) return this._cache.get(blobKey);
            if (!this.supported()) return null;
            try {
                const rec = await S.IDB.getMedia(blobKey);
                if (!rec || !rec.blob) return null;
                const url = URL.createObjectURL(rec.blob);
                this._cache.set(blobKey, url);
                return url;
            } catch (e) {
                return null;
            }
        },

        async getThumb(blobKey) {
            if (!this.supported()) return null;
            try {
                const rec = await S.IDB.getMedia(blobKey);
                return rec && rec.thumb ? rec.thumb : null;
            } catch (e) { return null; }
        },

        /* Retire l'URL du cache sans attendre (appelé au nettoyage). */
        revoke(blobKey) {
            const url = this._cache.get(blobKey);
            if (url) {
                try { URL.revokeObjectURL(url); } catch (e) {}
                this._cache.delete(blobKey);
            }
        },

        revokeAll() {
            for (const key of Array.from(this._cache.keys())) this.revoke(key);
        },

        /* ── Marquage « média manquant » ────────────────────────────────── */
        /* À l'ouverture d'un projet importé : les blobs ne sont pas présents.
           On le signale sans supprimer le clip (§5.2). */
        async markMissing(project) {
            if (!this.supported()) return 0;
            let n = 0;
            for (const m of project.media || []) {
                if (!m.blobKey) { m.missing = true; n++; continue; }
                try {
                    const rec = await S.IDB.getMedia(m.blobKey);
                    if (!rec || !rec.blob) { m.missing = true; n++; }
                    else { m.missing = false; }
                } catch (e) { m.missing = true; n++; }
            }
            return n;
        }
    };

    S.MediaStorage = MediaStorage;
})();
