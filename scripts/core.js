const Utils = {
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    /* Message affiché à l'utilisateur : jamais de détail technique
       (code HTTP, endpoint, modèle, jeton) — voir mission §11. */
    friendlyError: (e) => {
        const m = (e && e.message) || String(e || '');
        if (/limite temporaire|quota|rate.?limit/i.test(m)) {
            return 'Vous avez atteint la limite temporaire de génération. Veuillez patienter avant de réessayer.';
        }
        if (m === 'Arrêt demandé') return 'Génération arrêtée.';
        if (/connexion requise/i.test(m)) return 'Connecte-toi à ton compte pour créer.';
        /* Le service vidéo du fournisseur refuse faute de capacité. C'est la
           seule erreur qui mérite un mot à elle seule : le message générique
           ci-dessous disait « réessayez dans quelques instants » à quelqu'un
           dont la file était saturée pendant des heures. Aucun détail
           technique (code, modèle, fournisseur) n'y figure pour autant. */
        if (e && e.code === 'video_queue_full') {
            return 'Le service vidéo est saturé pour l\'instant. Veuillez réessayer dans quelques minutes.';
        }
        return 'Impossible de générer le contenu pour le moment. Veuillez réessayer dans quelques instants.';
    },
    getStyleById: (id) => STYLES.find(s => s.id === id),
    clampSize: (size) => {
        const parts = size.split('x');
        const w = parseInt(parts[0], 10);
        const h = parseInt(parts[1], 10);
        if (w <= CONFIG.MAX_IMAGE_DIMENSION && h <= CONFIG.MAX_IMAGE_DIMENSION) return size;
        const scale = CONFIG.MAX_IMAGE_DIMENSION / Math.max(w, h);
        const newW = Math.floor(w * scale / 32) * 32;
        const newH = Math.floor(h * scale / 32) * 32;
        return newW + 'x' + newH;
    },
    uid: (prefix) => (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    formatDate: (ts) => {
        const d = new Date(ts);
        const now = new Date();
        const diffMs = now - d;
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'à l\'instant';
        if (diffMin < 60) return 'il y a ' + diffMin + ' min';
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return 'il y a ' + diffH + ' h';
        const diffJ = Math.floor(diffH / 24);
        if (diffJ < 7) return 'il y a ' + diffJ + ' j';
        return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    },
    truncate: (str, n) => (str && str.length > n) ? str.slice(0, n) + '…' : (str || ''),
    formatBytes: (bytes) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    },
    renderMarkdown: (text) => {
        let html = Utils.escapeHtml(text);
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        const lines = html.split('\n');
        const out = [];
        let buffer = [];
        for (const line of lines) {
            if (line.trim() === '') {
                if (buffer.length) { out.push('<p>' + buffer.join('<br>') + '</p>'); buffer = []; }
            } else {
                buffer.push(line);
            }
        }
        if (buffer.length) out.push('<p>' + buffer.join('<br>') + '</p>');
        return out.join('');
    },
    /* Téléchargement AUTOMATIQUE vers l'appareil.
       L'attribut `download` d'une ancre n'est respecté que sur une même
       origine ou sur un blob. Posé sur l'URL distante du fournisseur, le
       navigateur l'IGNORAIT et ouvrait le fichier dans un onglet sans rien
       enregistrer — d'où « ça s'ouvre mais ça ne télécharge pas ». On
       récupère donc les octets (CORS) puis on repasse par un blob, toujours
       traité en téléchargement. L'ancre ne porte plus target="_blank" : sans
       cela, un échec ouvre un onglet et perd l'application.
       Renvoie false quand le direct est impossible (le bouton ouvre alors
       l'aperçu pour que l'image reste consultable). */
    triggerDownload: async (url, filename) => {
        const name = filename || 'lsv-file';
        const save = (href) => {
            const a = document.createElement('a');
            a.href = href;
            a.download = name;
            a.rel = 'noopener';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a); }, 100);
        };
        const fromBytes = async (res) => {
            const blob = await res.blob();
            if (!blob || !blob.size) throw new Error('réponse vide');
            const href = URL.createObjectURL(blob);
            save(href);
            setTimeout(() => { try { URL.revokeObjectURL(href); } catch (e) {} }, 60000);
            return true;
        };
        try {
            if (/^(data:|blob:)/i.test(url)) { save(url); return true; }

            /* 1. Direct : le CDN accepte ou non le CORS. */
            try {
                const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
                if (res && res.ok) return await fromBytes(res);
            } catch (e) { /* cas réel vérifié : ce CDN n'a aucun en-tête CORS */ }

            /* 2. Repli sur le dépôt média de la passerelle : l'image est
                  récupérée côté serveur, où aucun CORS ne s'applique, et
                  revient avec Content-Disposition: attachment. Requête
                  authentifiée — la passerelle refuse sans compte connecté. */
            if (typeof GATEWAY_URL === 'string' && GATEWAY_URL && /^https:\/\//i.test(url)) {
                try {
                    if (typeof Gateway !== 'undefined' && typeof AccountService !== 'undefined' && !Gateway._token) {
                        const t = await AccountService.token();
                        if (t) Gateway.setToken(t);
                    }
                    const hdr = (typeof Gateway !== 'undefined' && Gateway.withHeaders)
                        ? Gateway.withHeaders({}).headers : {};
                    const res = await fetch(GATEWAY_URL + '/v1/media?u=' + encodeURIComponent(url),
                        Object.assign({ method: 'GET' }, { headers: hdr }));
                    const ct = String((res && res.headers && res.headers.get('content-type')) || '');
                    if (res && res.ok && ct.indexOf('image/') === 0) return await fromBytes(res);
                } catch (e) { /* route absente ou refusée : on retombe sur l'aperçu */ }
            }
            throw new Error('octets inaccessibles');
        } catch (e) {
            try { DebugService.log('warn', 'DOWNLOAD', 'téléchargement impossible : ' + ((e && e.message) || e)); } catch (e2) {}
            return false;
        }
    }
};

/* STORAGE */
const StorageService = {
    /* ── Clés par compte (isolement des données créatives) ──────────────
       Projets, bibliothèque, historique, conversations, verrous, compteurs
       et cache de timings sont suffixés par l'identifiant du compte
       (`lsv4_projects__u<uid>`) : deux comptes sur le MÊME navigateur ne
       partagent plus rien (aucune fuite de chats ni d'images entre comptes).
       Les préférences d'appareil (thème, wakelock, auto-download, sidebar,
       modèle de chat, disponibilité vidéo, page d'accueil vues) restent
       globales — ce sont des réglages, pas des créations. */
    _owner: '',
    OWNER_KEY: 'lsv4_owner',
    _SCOPED: ['lsv4_projects', 'lsv4_assets', 'lsv4_history',
        'lsv4_conversations', 'lsv4_locks', 'lsv4_counters', 'lsv4_timing'],
    _k(base) {
        if (!this._owner) return base;
        return base + '__u' + this._owner;
    },
    /* Appelé au démarrage et à chaque connexion/déconnexion. Migration :
       les données créées AVANT tout compte (clés nues) sont adoptées par le
       PREMIER compte connecté sur l'appareil, jamais par le suivant. */
    setOwner(uid) {
        const next = String(uid || '');
        if (next === this._owner) return;
        this._owner = next;
        try {
            if (next) localStorage.setItem(this.OWNER_KEY, next);
            else localStorage.removeItem(this.OWNER_KEY);
        } catch (e) {}
        if (next) {
            this._SCOPED.forEach(base => {
                try {
                    const scoped = base + '__u' + next;
                    const legacy = localStorage.getItem(base);
                    if (legacy !== null && localStorage.getItem(scoped) === null) {
                        localStorage.setItem(scoped, legacy);
                    }
                    if (legacy !== null) localStorage.removeItem(base);
                } catch (e) {}
            });
        }
        this._invalidate();
    },
    /* Les services gardent leurs listes en mémoire : après un changement de
       compte, on vide les caches et les compteurs pour que rien de l'ancien
       utilisateur ne reste affiché. */
    _invalidate() {
        try {
            [ProjectService, AssetService, HistoryService, ConversationService, LockService]
                .forEach(s => { s._cache = null; });
        } catch (e) {}
        try {
            if (typeof Runtime !== 'undefined') {
                Runtime.currentProjectId = null;
                Runtime.currentConversationId = null;
            }
            if (typeof Handlers !== 'undefined' && Handlers._loadCounters) Handlers._loadCounters();
        } catch (e) {}
        try {
            const i = document.getElementById('sidebar-image-count');
            const v = document.getElementById('sidebar-video-count');
            if (i && typeof Runtime !== 'undefined') i.textContent = Runtime.imageCount;
            if (v && typeof Runtime !== 'undefined') v.textContent = Runtime.videoCount;
        } catch (e) {}
    },
    owner() { return this._owner; },
    _get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    _set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    _remove(k) { try { localStorage.removeItem(k); return true; } catch (e) { return false; } },
    getTimingCache() { try { return JSON.parse(this._get(this._k(STORAGE_KEYS.TIMING)) || '{}'); } catch (e) { return {}; } },
    setTimingCache(c) { return this._set(this._k(STORAGE_KEYS.TIMING), JSON.stringify(c)); },
    getWakeLockPref() { return this._get(STORAGE_KEYS.WAKELOCK) === '1'; },
    setWakeLockPref(v) { return this._set(STORAGE_KEYS.WAKELOCK, v ? '1' : '0'); },
    getCounters() { try { return JSON.parse(this._get(this._k(STORAGE_KEYS.COUNTERS)) || '{}'); } catch (e) { return {}; } },
    setCounters(c) { return this._set(this._k(STORAGE_KEYS.COUNTERS), JSON.stringify(c)); },
    getProjects() { try { return JSON.parse(this._get(this._k(STORAGE_KEYS.PROJECTS)) || '[]'); } catch (e) { return []; } },
    setProjects(l) { return this._set(this._k(STORAGE_KEYS.PROJECTS), JSON.stringify(l)); },
    getAssets() { try { return JSON.parse(this._get(this._k(STORAGE_KEYS.ASSETS)) || '[]'); } catch (e) { return []; } },
    setAssets(l) { return this._set(this._k(STORAGE_KEYS.ASSETS), JSON.stringify(l)); },
    getHistory() { try { return JSON.parse(this._get(this._k(STORAGE_KEYS.HISTORY)) || '[]'); } catch (e) { return []; } },
    setHistory(l) { return this._set(this._k(STORAGE_KEYS.HISTORY), JSON.stringify(l)); },
    getConversations() { try { return JSON.parse(this._get(this._k(STORAGE_KEYS.CONVERSATIONS)) || '[]'); } catch (e) { return []; } },
    setConversations(l) { return this._set(this._k(STORAGE_KEYS.CONVERSATIONS), JSON.stringify(l)); },
    getTheme() { return this._get(STORAGE_KEYS.THEME) || 'light'; },
    setTheme(v) { return this._set(STORAGE_KEYS.THEME, v); },
    getLocks() { try { return JSON.parse(this._get(this._k(STORAGE_KEYS.LOCKS)) || '[]'); } catch (e) { return []; } },
    setLocks(l) { return this._set(this._k(STORAGE_KEYS.LOCKS), JSON.stringify(l)); },
    getAutoDownload() { return this._get(STORAGE_KEYS.AUTODOWNLOAD) === '1'; },
    setAutoDownload(v) { return this._set(STORAGE_KEYS.AUTODOWNLOAD, v ? '1' : '0'); },
    getSidebarCollapsed() { return this._get(STORAGE_KEYS.SIDEBAR_COLLAPSED) === '1'; },
    setSidebarCollapsed(v) { return this._set(STORAGE_KEYS.SIDEBAR_COLLAPSED, v ? '1' : '0'); },
    resetAll() {
        this._SCOPED.forEach(base => this._remove(this._k(base)));
        /* Les clés nues (avant toute connexion) suivent aussi le reset. */
        this._SCOPED.forEach(base => this._remove(base));
    },
    estimateStorageSize() {
        let total = 0;
        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key) && key.startsWith('lsv4_')) {
                total += (localStorage[key] || '').length;
            }
        }
        return total;
    }
};

/* SERVICES (Project, Asset, History, Conversation, Lock) */
const ProjectService = {
    _cache: null,
    all() { if (!this._cache) this._cache = StorageService.getProjects(); return this._cache; },
    _save() { StorageService.setProjects(this._cache || []); },
    get(id) { return this.all().find(p => p.id === id) || null; },
    create({ name, description = '', type = 'general' }) {
        const now = Date.now();
        const project = {
            id: Utils.uid('proj'), name: name || 'Nouveau projet', description, type,
            createdAt: now, updatedAt: now,
            scenes: [], prompts: [], assets: [],
            characters: [], products: [], environments: [],
            workflows: [], generations: [],
            versions: [{ id: Utils.uid('ver'), number: 1, label: 'Version initiale', createdAt: now }]
        };
        this._cache = this.all();
        this._cache.unshift(project);
        this._save();
        HistoryService.add('project.create', 'Projet créé : ' + project.name, { projectId: project.id });
        LSVAnalytics.track('project_created', { type: type || 'general' });
        return project;
    },
    update(id, patch) {
        const p = this.get(id);
        if (!p) return null;
        Object.assign(p, patch, { updatedAt: Date.now() });
        this._save();
        return p;
    },
    duplicate(id) {
        const p = this.get(id);
        if (!p) return null;
        const copy = JSON.parse(JSON.stringify(p));
        copy.id = Utils.uid('proj');
        copy.name = p.name + ' (copie)';
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        this._cache = this.all();
        this._cache.unshift(copy);
        this._save();
        HistoryService.add('project.duplicate', 'Projet dupliqué : ' + p.name);
        return copy;
    },
    delete(id) {
        const p = this.get(id);
        if (!p) return false;
        this._cache = this.all().filter(x => x.id !== id);
        this._save();
        HistoryService.add('project.delete', 'Projet supprimé : ' + p.name);
        return true;
    },
    addAsset(projectId, assetId) {
        const p = this.get(projectId);
        if (!p) return;
        if (!p.assets.includes(assetId)) {
            p.assets.push(assetId);
            p.updatedAt = Date.now();
            this._save();
        }
    },
    count() { return this.all().length; }
};

const AssetService = {
    _cache: null,
    all() { if (!this._cache) this._cache = StorageService.getAssets(); return this._cache; },
    _save() { StorageService.setAssets(this._cache || []); },
    add({ type, url, name = '', metadata = {} }) {
        const asset = {
            id: Utils.uid('asset'), type, url,
            name: name || (type === 'image' ? 'Image' : 'Vidéo'),
            metadata: {
                size: metadata.size || null,
                ratio: metadata.ratio || null,
                style: metadata.style || null,
                duration: metadata.duration || null,
                projectId: metadata.projectId || null
            },
            createdAt: Date.now()
        };
        this._cache = this.all();
        this._cache.unshift(asset);
        this._save();
        return asset;
    },
    get(id) { return this.all().find(a => a.id === id) || null; },
    delete(id) {
        this._cache = this.all().filter(a => a.id !== id);
        this._save();
    },
    filter({ type = 'all', search = '' }) {
        let list = this.all();
        if (type !== 'all') list = list.filter(a => a.type === type);
        if (search) {
            const q = search.toLowerCase();
            list = list.filter(a => a.name.toLowerCase().includes(q));
        }
        return list;
    },
    count() { return this.all().length; }
};

const HistoryService = {
    _cache: null,
    all() { if (!this._cache) this._cache = StorageService.getHistory(); return this._cache; },
    _save() { StorageService.setHistory(this._cache || []); },
    add(type, message, data = {}) {
        const entry = { id: Utils.uid('hist'), type, message, data, at: Date.now() };
        this._cache = this.all();
        this._cache.unshift(entry);
        if (this._cache.length > CONFIG.HISTORY_MAX_ENTRIES) this._cache = this._cache.slice(0, CONFIG.HISTORY_MAX_ENTRIES);
        this._save();
    },
    clear() { this._cache = []; this._save(); },
    count() { return this.all().length; }
};

const ConversationService = {
    _cache: null,
    all() { if (!this._cache) this._cache = StorageService.getConversations(); return this._cache; },
    _save() { StorageService.setConversations(this._cache || []); },
    get(id) { return this.all().find(c => c.id === id) || null; },
    create({ title = 'Nouvelle conversation', projectId = null } = {}) {
        const conv = {
            id: Utils.uid('conv'), title, projectId,
            messages: [],
            createdAt: Date.now(), updatedAt: Date.now()
        };
        this._cache = this.all();
        this._cache.unshift(conv);
        this._save();
        return conv;
    },
    update(id, patch) {
        const c = this.get(id);
        if (!c) return null;
        Object.assign(c, patch, { updatedAt: Date.now() });
        this._save();
        return c;
    },
    addMessage(id, role, content) {
        const c = this.get(id);
        if (!c) return null;
        c.messages.push({ role, content, at: Date.now() });
        c.updatedAt = Date.now();
        if (c.messages.length === 1 && role === 'user' && c.title === 'Nouvelle conversation') {
            c.title = Utils.truncate(content.replace(/\n/g, ' '), 45);
        }
        this._save();
        return c;
    },
    delete(id) {
        this._cache = this.all().filter(c => c.id !== id);
        this._save();
    },
    count() { return this.all().length; }
};

const LockService = {
    _cache: null,
    all() { if (!this._cache) this._cache = StorageService.getLocks(); return this._cache; },
    _save() { StorageService.setLocks(this._cache || []); },
    get(id) { return this.all().find(l => l.id === id) || null; },
    getByType(type) { return this.all().filter(l => l.type === type); },
    create({ type, name, description = '', imageDataUri = null }) {
        const lock = { id: Utils.uid('lock'), type, name, description, imageDataUri, createdAt: Date.now() };
        this._cache = this.all();
        this._cache.unshift(lock);
        this._save();
        HistoryService.add('lock.create', 'Lock créé : ' + name);
        return lock;
    },
    update(id, patch) {
        const l = this.get(id);
        if (!l) return null;
        Object.assign(l, patch);
        this._save();
        return l;
    },
    delete(id) {
        this._cache = this.all().filter(l => l.id !== id);
        this._save();
    },
    count() { return this.all().length; }
};

const DebugService = {
    _count: 0, _entries: [], _body: null,
    /* La console n'apparaît plus dans l'interface publique. Les entrées
       restent en mémoire (bornée à DEBUG_MAX_ENTRIES) pour le diagnostic
       développeur : window.LSV.debug.entries */
    init() { this._body = document.getElementById('debug-body'); },
    log(level, category, message, data) {
        const time = new Date().toLocaleTimeString('fr-FR', { hour12: false });
        this._entries.push({ time, level, category, message, data });
        if (this._entries.length > CONFIG.DEBUG_MAX_ENTRIES) this._entries.shift();
        this._count++;
        if (!this._body) return;
        const el = document.createElement('div');
        el.className = 'debug-entry ' + level;
        let html = '<span class="debug-time">' + time + '</span>' +
            '<span class="debug-cat">[' + Utils.escapeHtml(category) + ']</span>' +
            '<span class="debug-msg">' + Utils.escapeHtml(message) + '</span>';
        if (data !== undefined && data !== null) {
            let ds;
            if (typeof data === 'string') ds = data;
            else { try { ds = JSON.stringify(data, null, 2); } catch (e) { ds = String(data); } }
            if (ds.length > 3000) ds = ds.slice(0, 3000) + '\n…[tronqué]';
            html += '<pre class="debug-data">' + Utils.escapeHtml(ds) + '</pre>';
        }
        el.innerHTML = html;
        this._body.appendChild(el);
        while (this._body.children.length > CONFIG.DEBUG_MAX_ENTRIES) this._body.removeChild(this._body.firstChild);
        this._body.scrollTop = this._body.scrollHeight;
        const c = document.getElementById('debug-count');
        if (c) c.textContent = this._count;
    },
    clear() {
        if (this._body) this._body.innerHTML = '';
        this._entries = []; this._count = 0;
        const c = document.getElementById('debug-count');
        if (c) c.textContent = '0';
        this.log('info', 'SYSTEM', 'Console effacée');
    },
    copy() {
        const lines = this._entries.map(e => e.time + ' [' + e.category + '] ' + e.message).join('\n');
        const done = (ok) => UI.showToast(ok ? 'Console copiée' : 'Copie impossible', ok ? 'success' : 'error');
        try {
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(lines).then(() => done(true)).catch(() => this._legacyCopy(lines, done));
                return;
            }
        } catch (e) {}
        this._legacyCopy(lines, done);
    },
    _legacyCopy(text, cb) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        cb(ok);
    }
};

const TimingService = {
    record(key, ms) {
        const c = StorageService.getTimingCache();
        if (!c[key]) c[key] = [];
        c[key].push(ms);
        if (c[key].length > 10) c[key] = c[key].slice(-10);
        StorageService.setTimingCache(c);
    },
    estimate(key, fallback) {
        const c = StorageService.getTimingCache();
        const s = c[key];
        if (s && s.length > 0) {
            const sorted = [...s].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        }
        return fallback;
    }
};

const WakeLockService = {
    _sentinel: null, _canvasStream: null, _canvasInterval: null, _enabled: false,
    async activate() {
        let ok = false;
        if ('wakeLock' in navigator) {
            try { this._sentinel = await navigator.wakeLock.request('screen'); ok = true; } catch (e) {}
        }
        if (!ok) {
            try {
                const canvas = document.getElementById('noSleepCanvas');
                const video = document.getElementById('noSleepVideo');
                if (canvas && video && canvas.captureStream) {
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 2, 2);
                    this._canvasStream = canvas.captureStream(1);
                    this._canvasInterval = setInterval(() => {
                        ctx.fillStyle = ctx.fillStyle === '#000000' ? '#010101' : '#000000';
                        ctx.fillRect(0, 0, 2, 2);
                    }, 1000);
                    video.srcObject = this._canvasStream;
                    video.muted = true;
                    video.play().catch(() => {});
                    ok = true;
                }
            } catch (e) {}
        }
        return ok;
    },
    async ensure() {
        if (!this._enabled) return;
        if (this._sentinel || this._canvasStream) return;
        await this.activate();
    },
    enableFromStorage() {
        this._enabled = StorageService.getWakeLockPref();
        if (this._enabled) this.activate();
    }
};

/* LSV API Gateway — en-têtes envoyés à NOTRE passerelle (JWT anon Supabase +
   identifiant visiteur anonyme pour les quotas). Aucune clé de fournisseur. */
