/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — mini-couche IndexedDB
   Aucune dépendance externe (§19). Une seule base, deux object stores :
     • `projects` — métadonnées (objet JSON, sans les binaires)
     • `media`    — blobs bruts + vignettes

   Tout est promisifié. En cas d'absence d'IndexedDB (navigateur privé
   antique, jsdom), `supported()` est faux et le reste de l'application doit
   proposer une alternative (export manuel) plutôt que de planter (§17).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    const DB_NAME = 'lsv-studio';
    const DB_VERSION = 1;
    let dbPromise = null;

    function req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB'));
        });
    }

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (!S.Storage || !S.Storage.supported()) {
                reject(new Error('IndexedDB indisponible'));
                return;
            }
            const r = indexedDB.open(DB_NAME, DB_VERSION);
            r.onupgradeneeded = () => {
                const db = r.result;
                if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
            };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error || new Error('IndexedDB'));
            r.onblocked = () => reject(new Error('Base de données bloquée'));
        }).catch(e => { dbPromise = null; throw e; });
        return dbPromise;
    }

    /* Exécute une opération transactionnelle sur un store. */
    async function withStore(storeName, mode, fn) {
        const db = await open();
        return new Promise((resolve, reject) => {
            let tx;
            try {
                tx = db.transaction(storeName, mode);
            } catch (e) { reject(e); return; }
            const store = tx.objectStore(storeName);
            let result;
            try {
                result = fn(store);
            } catch (e) { reject(e); return; }
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error('transaction'));
            tx.onabort = () => reject(tx.error || new Error('aborted'));
        });
    }

    const IDB = {
        supported() {
            try {
                return typeof indexedDB !== 'undefined' && indexedDB !== null;
            } catch (e) {
                return false;
            }
        },

        /* ── Projets ────────────────────────────────────────────────────── */
        async putProject(project) {
            /* Ne jamais persister les données de session volatiles. */
            const clean = JSON.parse(JSON.stringify(project));
            await withStore('projects', 'readwrite', s => s.put(clean));
            return project.id;
        },

        async getProject(id) {
            const db = await open();
            const tx = db.transaction('projects', 'readonly');
            const store = tx.objectStore('projects');
            const value = await req(store.get(id));
            return value || null;
        },

        async listProjects() {
            const db = await open();
            const tx = db.transaction('projects', 'readonly');
            const store = tx.objectStore('projects');
            const all = await req(store.getAll());
            /* Tri : le plus récemment modifié en premier (sans `updatedAt` = derrière). */
            return (all || []).sort((a, b) =>
                String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        },

        async deleteProject(id) {
            await withStore('projects', 'readwrite', s => s.delete(id));
        },

        /* ── Médias (blobs) ─────────────────────────────────────────────── */
        /* Un média est stocké sous une clé dédiée. On garde aussi la vignette
           comme Blob séparé pour éviter de re-générer le thumbnail à chaque
           ouverture de projet. */
        async putMedia(key, blob, thumb) {
            const db = await open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('media', 'readwrite');
                const store = tx.objectStore('media');
                store.put({ blob: blob, thumb: thumb || null, at: Date.now() }, key);
                tx.oncomplete = () => resolve(key);
                tx.onerror = () => reject(tx.error || new Error('media store'));
            });
        },

        async getMedia(key) {
            const db = await open();
            const tx = db.transaction('media', 'readonly');
            return await req(tx.objectStore('media').get(key));
        },

        async deleteMedia(key) {
            await withStore('media', 'readwrite', s => s.delete(key));
        },

        /* ── Maintenance ────────────────────────────────────────────────── */
        /* Libère les blobs orphelins (médias référencés nulle part). À
           appeler quand on supprime un projet. */
        async pruneOrphans(usedKeys) {
            const db = await open();
            const tx = db.transaction('media', 'readwrite');
            const store = tx.objectStore('media');
            const all = await req(store.getAllKeys());
            for (const key of all || []) {
                if (!usedKeys.has(key)) store.delete(key);
            }
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        },

        async estimateUsage() {
            if (!navigator.storage || !navigator.storage.estimate) return null;
            try {
                const e = await navigator.storage.estimate();
                return { usage: e.usage || 0, quota: e.quota || 0 };
            } catch (e) { return null; }
        }
    };

    S.IDB = IDB;
})();
