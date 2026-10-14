const Gateway = {
    /* Le jeton du COMPTE est envoyé quand l'utilisateur est connecté : la
       passerelle le vérifie côté serveur et applique son quota journalier.
       Sans compte, seule la clé anonyme publique part (aucun droit). */
    _token: null,
    setToken(t) { Gateway._token = t || null; },
    headers() {
        const h = {};
        try {
            if (window.LSVAnalytics && typeof window.LSVAnalytics.visitorId === 'function') {
                const v = window.LSVAnalytics.visitorId();
                if (v) h['x-lsv-visitor'] = v;
            }
        } catch (e) {}
        const anon = (window.LSV_CONFIG && window.LSV_CONFIG.SUPABASE_ANON_KEY) || '';
        const user = Gateway._token;
        if (user) {
            h['Authorization'] = 'Bearer ' + user;
            h['apikey'] = anon;
        } else if (anon) {
            h['Authorization'] = 'Bearer ' + anon;
            h['apikey'] = anon;
        }
        return h;
    },
    withHeaders(options) {
        return Object.assign({}, options, {
            headers: Object.assign({}, Gateway.headers(), options.headers || {})
        });
    }
};

/* ── Comptes LSV.ai (Supabase Auth) ───────────────────────────────────────
   Inscription / connexion / déconnexion via les endpoints REST publics du
   projet Supabase : le mot de passe ne va nulle part ailleurs. Seule une
   session courte (jeton d'accès + rafraîchissement) est gardée sur
   l'appareil. Aucun mot de passe ni clé secrète en dur dans ce fichier. */
const AccountService = {
    KEY: 'lsv4_account',
    _s: null,

    _configured() {
        const c = window.LSV_CONFIG || {};
        const url = String(c.SUPABASE_URL || '');
        const key = String(c.SUPABASE_ANON_KEY || '');
        return !!(url && key &&
            url.indexOf('supabase.co') !== -1 &&
            url.indexOf('YOUR_PROJECT_REF') === -1 &&
            key.indexOf('YOUR_SUPABASE_ANON_KEY') === -1);
    },
    _base() {
        return String((window.LSV_CONFIG && window.LSV_CONFIG.SUPABASE_URL) || '').replace(/\/+$/, '');
    },
    _headers(token) {
        const h = { 'Content-Type': 'application/json' };
        const anon = (window.LSV_CONFIG && window.LSV_CONFIG.SUPABASE_ANON_KEY) || '';
        if (anon) h.apikey = anon;
        if (token) h.Authorization = 'Bearer ' + token;
        return h;
    },

    session() {
        if (this._s !== null) return this._s;
        try {
            const raw = localStorage.getItem(this.KEY);
            this._s = raw ? JSON.parse(raw) : null;
        } catch (e) { this._s = null; }
        return this._s;
    },
    _save(s) {
        this._s = s;
        try {
            if (s) localStorage.setItem(this.KEY, JSON.stringify(s));
            else localStorage.removeItem(this.KEY);
        } catch (e) {}
    },
    email() {
        const s = this.session();
        return (s && s.email) || '';
    },
    /* Identifiant Supabase du compte connecté (uuid). Vide pour un visiteur.
       Sert aux statistiques d'usage par compte côté back-office. */
    userId() {
        const s = this.session();
        return (s && s.id) || '';
    },
    name() {
        const s = this.session();
        return (s && s.name) || '';
    },
    signedIn() {
        const s = this.session();
        return !!(s && s.access_token);
    },

    async _post(path, body, token) {
        const res = await fetch(this._base() + '/auth/v1' + path, {
            method: 'POST',
            headers: this._headers(token),
            body: JSON.stringify(body || {})
        });
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res.ok) {
            const msg = (data && (data.error_description || data.msg || data.error_code || data.message)) ||
                (data && data.error && data.error_description) || ('HTTP ' + res.status);
            throw new Error(String(msg));
        }
        return data || {};
    },
    _keep(data, fallbackEmail) {
        const u = data.user || {};
        const meta = u.user_metadata || {};
        this._save({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600),
            email: u.email || fallbackEmail || '',
            name: meta.full_name || meta.name || '',
            id: u.id || ''
        });
    },

    async signUp(email, password, name) {
        if (!this._configured()) throw new Error('configuration absente');
        const body = { email: email, password: password };
        if (name) body.data = { full_name: name };
        const data = await this._post('/signup', body);
        if (data.access_token && data.refresh_token) {
            this._keep(data, email);
            return { confirmed: true };
        }
        return { confirmed: false };
    },
    async signIn(email, password) {
        if (!this._configured()) throw new Error('configuration absente');
        const data = await this._post('/token?grant_type=password', { email: email, password: password });
        this._keep(data, email);
        return true;
    },
    async signOut() {
        const s = this.session();
        this._save(null);
        if (s && s.access_token) {
            try {
                await fetch(this._base() + '/auth/v1/logout', {
                    method: 'POST',
                    headers: this._headers(s.access_token)
                });
            } catch (e) {}
        }
        return true;
    },
    /* Mot de passe oublié : Supabase envoie un e-mail de réinitialisation.
       Réponse identique que le compte existe ou non (pas d'énumération). */
    async recover(email) {
        if (!this._configured()) throw new Error('configuration absente');
        await this._post('/recover', { email: email });
        return true;
    },
    async token() {
        const s = this.session();
        if (!s || !s.access_token) return null;
        const now = Math.floor(Date.now() / 1000);
        if (!s.expires_at || s.expires_at - now > 60) return s.access_token;
        if (!s.refresh_token) { this._save(null); return null; }
        try {
            const data = await this._post('/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
            this._keep(data, s.email);
            return this._s && this._s.access_token;
        } catch (e) {
            this._save(null);
            return null;
        }
    },
    /* Liste blanche : vrai si l'e-mail est admis dans le back-office. */
    async isAdmin() {
        const t = await this.token();
        if (!t) return false;
        try {
            const res = await fetch(this._base() + '/rest/v1/rpc/is_admin', {
                method: 'POST',
                headers: this._headers(t),
                body: '{}'
            });
            if (!res.ok) return false;
            return (await res.json()) === true;
        } catch (e) { return false; }
    },

    friendly(message) {
        const m = String(message || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
        if (m.indexOf('configuration') !== -1) return 'Compte indisponible : configuration absente.';
        if (m.indexOf('invalid login') !== -1 || m.indexOf('invalid credentials') !== -1 ||
            m.indexOf('user not found') !== -1 || m.indexOf('no user found') !== -1) return 'Identifiants incorrects.';
        if (m.indexOf('already registered') !== -1 || m.indexOf('user already') !== -1 || m.indexOf('already exists') !== -1) return 'Compte déjà existant : connecte-toi.';
        if (m.indexOf('password should be at least') !== -1 || m.indexOf('password is too short') !== -1 ||
            m.indexOf('weak password') !== -1) return 'Mot de passe : 6 caractères minimum.';
        if (m.indexOf('email not confirmed') !== -1 || m.indexOf('email not verified') !== -1) return 'E-mail non confirmé : clique sur le lien reçu (ou réinitialise ton mot de passe).';
        if (m.indexOf('signup') !== -1 && (m.indexOf('disabled') !== -1 || m.indexOf('not allowed') !== -1)) return 'Inscriptions fermées pour le moment.';
        if (m.indexOf('sending') !== -1 || m.indexOf('send email') !== -1 || m.indexOf('send confirmation') !== -1 ||
            m.indexOf('error sending') !== -1 || m.indexOf('failed to send') !== -1 || m.indexOf('confirmation email') !== -1 ||
            m.indexOf('email address not authorized') !== -1) return 'Inscription momentanément indisponible : réessaie dans quelques instants.';
        if (m.indexOf('over email') !== -1 || m.indexOf('email rate') !== -1 || m.indexOf('mailer rate') !== -1) return 'Trop d\'inscriptions récemment : réessaie dans une heure.';
        if (m.indexOf('rate limit') !== -1 || m.indexOf('too many') !== -1 || m.indexOf('rate limit exceeded') !== -1) return 'Trop de tentatives, réessaie plus tard.';
        if (m.indexOf('fetch') !== -1 || m.indexOf('network') !== -1 || m.indexOf('http') !== -1) return 'Connexion réseau impossible.';
        return 'Opération impossible pour le moment.';
    }
};

/* ── Quotas journaliers du compte ──────────────────────────────────────────
   La passerelle renvoie les restants dans les en-têtes de CHAQUE réponse —
   on les lit au vol. Le point de départ (/v1/quota) est chargé une fois à la
   connexion. Affichage : « Images restantes aujourd'hui : 4/20 ». */
const QuotaService = {
    state: null,
    _lastToast: 0,

    /* Poids d'une image selon sa résolution — doit rester identique à
       imageUnits() côté passerelle (supabase/functions/lsv-gateway/core.mjs). */
    units(size) {
        const m = /^(\d{2,5})\s*x\s*(\d{2,5})$/.exec(String(size || '').trim());
        if (!m) return 1;
        const max = Math.max(parseInt(m[1], 10), parseInt(m[2], 10));
        if (!Number.isFinite(max) || max <= 0) return 1;
        if (max <= 1500) return 1;
        if (max <= 2800) return 2;
        return 3;
    },

    async refresh() {
        if (!AccountService.signedIn()) { this.clear(); return null; }
        const token = await AccountService.token();
        Gateway.setToken(token);
        if (!GATEWAY_URL) return null;
        try {
            const res = await fetch(GATEWAY_URL + '/v1/quota', {
                headers: Gateway.withHeaders({}).headers
            });
            if (!res || !res.ok) return null;
            const data = await res.json();
            if (data && data.anonymous) { this.clear(); return null; }
            this.state = data || null;
            this.render();
            return this.state;
        } catch (e) { return null; }
    },

    clear() {
        this.state = null;
        this.render();
    },

    /* Appelé par AgnesProvider sur chaque réponse : en-têtes toujours à jour. */
    applyHeaders(res) {
        try {
            if (!res || !res.headers || !res.headers.get) return;
            const g = n => { const v = res.headers.get(n); return v === null || v === undefined || v === '' ? null : Number(v); };
            const next = this.state ? Object.assign({}, this.state) : {};
            const img = g('x-lsv-quota-image');
            const vid = g('x-lsv-quota-video');
            const cht = g('x-lsv-quota-chat');
            const mot = g('x-lsv-quota-motion');
            const glb = g('x-lsv-quota-global');
            const has = img !== null || vid !== null || cht !== null || mot !== null || glb !== null;
            if (!has) return;
            next.remaining = Object.assign({}, next.remaining || {});
            next.limits = Object.assign({}, next.limits || {});
            if (img !== null) next.remaining.image = img;
            if (vid !== null) next.remaining.video = vid;
            if (cht !== null) next.remaining.chat = cht;
            if (mot !== null) next.remaining.motion = mot;
            if (glb !== null) next.global = Object.assign({}, next.global || {}, { remaining: glb });
            ['image', 'video', 'chat'].forEach(k => {
                const r = next.remaining[k];
                const l = next.limits[k];
                if (typeof l === 'number' && l > 0 && typeof r === 'number') {
                    next.used = Object.assign({}, next.used || {});
                    next.used[k] = Math.max(0, l - r);
                }
            });
            this.state = next;
            this.render();
        } catch (e) {}
    },

    /* Vrai si la requête vient d'être refusée pour quota épuisé. */
    isExhausted(res) {
        try { return !!(res && res.status === 429 && res.headers && res.headers.get && res.headers.get('x-lsv-quota')); }
        catch (e) { return false; }
    },

    message(res) {
        try {
            if (res && res.status === 429) {
                const scope = res.headers && res.headers.get && res.headers.get('x-lsv-quota-scope');
                return scope === 'global'
                    ? 'Limite globale du jour atteinte : réessaie plus tard.'
                    : 'Quota du jour atteint : réessaie demain (compteur réinitialisé à minuit).';
            }
            if (res && res.status === 503 && res.headers && res.headers.get && res.headers.get('x-lsv-quota') === 'suspended') {
                return 'Générations momentanément suspendues : réessaie dans quelques instants.';
            }
        } catch (e) {}
        return null;
    },

    remaining(kind) {
        const s = this.state;
        if (!s || !s.remaining) return null;
        const r = s.remaining[kind];
        return typeof r === 'number' ? r : null;
    },

    limit(kind) {
        const s = this.state;
        if (!s || !s.limits) return null;
        const l = s.limits[kind];
        return typeof l === 'number' && l > 0 ? l : null;
    },

    /* « 4/20 » ou « illimité ». */
    ratio(kind) {
        const r = this.remaining(kind);
        const l = this.limit(kind);
        if (l === null) return '∞';
        return (r === null ? l : r) + '/' + l;
    },

    render() {
        const box = document.getElementById('sidebar-quota');
        if (!box) return;
        const signedIn = AccountService.signedIn();
        box.classList.toggle('hidden', !signedIn || !this.state);
        if (!signedIn || !this.state) return;
        if (this.state.enabled === false) { box.classList.add('hidden'); return; }
        const set = (id, kind) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = this.ratio(kind);
            const r = this.remaining(kind);
            el.classList.toggle('quota-zero', r === 0);
            el.classList.toggle('quota-low', typeof r === 'number' && r > 0 && r <= 2);
        };
        set('quota-image', 'image');
        set('quota-video', 'video');
        set('quota-chat', 'chat');
        const reset = document.getElementById('quota-reset');
        if (reset) reset.textContent = this.state.suspended
            ? 'Générations suspendues'
            : 'Remise à zéro à minuit UTC';
        box.classList.toggle('quota-suspended', !!this.state.suspended);
        this._warnIfLow();
    },

    _warnIfLow() {
        const now = Date.now();
        if (now - this._lastToast < 120000) return;
        ['image', 'video', 'chat'].some(kind => {
            const r = this.remaining(kind);
            if (r !== 0) return false;
            this._lastToast = now;
            const labels = { image: 'images', video: 'vidéos', chat: 'messages de chat' };
            if (window.UI && UI.showToast) {
                UI.showToast('Quota du jour épuisé : ' + labels[kind] + ' — réessaie demain.', 'error', 5000);
            }
            return true;
        });
    }
};

const AccountView = {
    mode: 'login',
    busy: false,

    $(id) { return document.getElementById(id); },

    init() {
        if (!this.$('account-section')) return;
        this.$('account-open').addEventListener('click', () => this.open());
        this.$('account-cancel').addEventListener('click', () => this.close());
        this.$('account-mode').addEventListener('click', () => this.setMode(this.mode === 'login' ? 'signup' : 'login'));
        this.$('account-submit').addEventListener('click', () => this.submit());
        ['account-name', 'account-email', 'account-password'].forEach(id => {
            const el = this.$(id);
            if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') this.submit(); });
        });
        this.$('account-logout').addEventListener('click', () => this.logout());
        this.$('account-admin').addEventListener('click', () => { window.location.href = 'admin/'; });
        this.setMode(this.mode);
        const modal = this.$('auth-modal');
        if (modal) {
            const closeBtn = this.$('account-close');
            if (closeBtn) closeBtn.addEventListener('click', () => this.close());
            modal.addEventListener('mousedown', e => { if (e.target === modal) this.close(); });
            const eye = this.$('account-eye');
            if (eye) eye.addEventListener('click', () => this.toggleEye());
            const forgot = this.$('account-forgot');
            if (forgot) forgot.addEventListener('click', () => this.forgot());
            document.addEventListener('keydown', e => {
                if ((e.key === 'Escape' || e.key === 'Esc') && !modal.classList.contains('hidden') && !this.busy) this.close();
            });
        }
        this.refresh();
        this.noticeAuthRedirect();
    },

    /* Retour d'un lien Supabase (confirmation d'e-mail, réinitialisation) :
       l'utilisateur atterrit ici avec un code dans l'URL — on le prévient
       et on nettoie l'adresse sans recharger la page. */
    noticeAuthRedirect() {
        try {
            const q = new URLSearchParams(window.location.search || '');
            const hash = window.location.hash || '';
            const raw = q.get('error_description') || q.get('error') || ((/#(?:.*&)?error_description=([^&]*)/.exec(hash) || [])[1] || '');
            const err = decodeURIComponent(String(raw).replace(/\+/g, ' '));
            const code = q.get('code') || q.get('access_token') || (hash.indexOf('access_token=') !== -1);
            if (err) {
                UI.showToast('Lien invalide ou expiré : demande un nouveau lien (e-mail oublié ou inscription).', 'error', 6000);
            } else if (code) {
                UI.showToast('E-mail confirmé : connecte-toi pour continuer.', 'success', 6000);
            }
            if (err || code) {
                try { window.history.replaceState(null, '', window.location.pathname); } catch (e) {}
            }
        } catch (e) {}
    },

    status(msg, kind) {
        const el = this.$('account-status');
        if (!el) return;
        if (!msg) {
            el.className = 'rp-status hidden';
            this.$('account-status-text').textContent = '';
            return;
        }
        el.className = 'rp-status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
        this.$('account-status-text').textContent = msg;
    },
    open() {
        this.status('');
        const modal = this.$('auth-modal');
        if (modal) modal.classList.remove('hidden');
        this.$('account-form').classList.remove('hidden');
        try { document.documentElement.style.overflow = 'hidden'; } catch (e) {}
        const target = this.mode === 'signup' ? this.$('account-name') : this.$('account-email');
        if (target && typeof target.focus === 'function') target.focus();
    },
    close() {
        const modal = this.$('auth-modal');
        if (modal) modal.classList.add('hidden');
        this.$('account-form').classList.add('hidden');
        try { document.documentElement.style.overflow = ''; } catch (e) {}
        this.status('');
    },
    toggleEye() {
        const input = this.$('account-password');
        const eye = this.$('account-eye');
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        const icon = eye ? eye.querySelector('.ms') : null;
        if (icon) icon.textContent = show ? 'visibility' : 'visibility_off';
        if (eye) eye.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    },
    async forgot() {
        if (this.busy) return;
        const email = this.$('account-email');
        const value = email ? email.value.trim() : '';
        if (!value) {
            this.status('Entre ton e-mail pour recevoir le lien de réinitialisation.', 'err');
            if (email && typeof email.focus === 'function') email.focus();
            return;
        }
        this.busy = true;
        const btn = this.$('account-forgot');
        if (btn) btn.disabled = true;
        try {
            await AccountService.recover(value);
            this.status('E-mail envoyé : vérifie ta boîte de réception.', 'ok');
        } catch (e) {
            this.status(AccountService.friendly(e && e.message), 'err');
        } finally {
            this.busy = false;
            if (btn) btn.disabled = false;
        }
    },
    setMode(mode) {
        this.mode = mode === 'signup' ? 'signup' : 'login';
        const signup = this.mode === 'signup';
        this.$('account-submit').textContent = signup ? 'Créer le compte' : 'Se connecter';
        this.$('account-mode').textContent = signup ? 'J\u2019ai déjà un compte' : 'Créer un compte';
        const nameEl = this.$('account-name');
        if (nameEl) nameEl.classList.toggle('hidden', !signup);
        const nameField = this.$('account-name-field');
        if (nameField) nameField.classList.toggle('hidden', !signup);
        const forgot = this.$('account-forgot');
        if (forgot) forgot.classList.toggle('hidden', signup);
        this.$('account-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
        this.$('account-password').setAttribute('placeholder', signup ? '6 caractères minimum' : 'mot de passe');
        const set = (id, txt) => { const el = this.$(id); if (el) el.textContent = txt; };
        set('auth-heading', signup ? 'Créer un compte' : 'Se connecter');
        set('account-badge', signup ? 'Inscription' : 'Connexion');
        set('account-sub', signup
            ? 'Ton nom complet, ton e-mail et un mot de passe : ton compte gratuit est créé en une seconde.'
            : 'Connecte-toi pour créer des images, vidéos et chat. Ton compte retrouve tes projets sur tous tes appareils.');
    },
    renderGuest() {
        try { Gateway.setToken(null); } catch (e) {}
        if (window.QuotaService && QuotaService.clear) QuotaService.clear();
        this.$('account-user').classList.add('hidden');
        this.$('account-guest').classList.remove('hidden');
        const modal = this.$('auth-modal');
        if (modal) modal.classList.add('hidden');
        this.$('account-form').classList.add('hidden');
        try { document.documentElement.style.overflow = ''; } catch (e) {}
        this.status('');
    },
    /* ── Création réservée aux comptes connectés ─────────────────────────
       Toute génération (image, vidéo, chat, enhancer, batch) passe par
       ensure() : sans compte, la page de connexion s'ouvre et rien n'est
       envoyé. */
    requireLogin() {
        this.open();
        this.status('Connecte-toi pour créer (images, vidéos, chat).', 'err');
        UI.showToast('Connecte-toi à ton compte pour créer.', 'error', 4000);
        return false;
    },
    async ensure() {
        const t = await AccountService.token();
        if (t) {
            Gateway.setToken(t);
            return true;
        }
        return this.requireLogin();
    },
    async refresh() {
        try {
            if (!AccountService.signedIn()) { this.renderGuest(); return; }
            const t = await AccountService.token();
            if (!t) { this.renderGuest(); return; }
            Gateway.setToken(t);
            this.$('account-guest').classList.add('hidden');
            this.$('account-user').classList.remove('hidden');
            const nm = AccountService.name();
            this.$('account-mail').textContent = nm
                ? nm + ' · ' + (AccountService.email() || '')
                : (AccountService.email() || 'Compte LSV.ai');
            const admin = await AccountService.isAdmin();
            this.$('account-admin').classList.toggle('hidden', !admin);
            if (window.QuotaService && QuotaService.refresh) QuotaService.refresh();
        } catch (e) {
            this.renderGuest();
        }
    },
    async submit() {
        if (this.busy) return;
        const email = this.$('account-email').value.trim();
        const password = this.$('account-password').value;
        const nameEl = this.$('account-name');
        const name = nameEl ? nameEl.value.trim() : '';
        if (this.mode === 'signup' && !name) {
            this.status('Nom complet requis.', 'err');
            if (nameEl) nameEl.focus();
            return;
        }
        if (!email || !password) { this.status('E-mail et mot de passe requis.', 'err'); return; }
        this.busy = true;
        const btn = this.$('account-submit');
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Vérification…';
        try {
            if (this.mode === 'signup') {
                const r = await AccountService.signUp(email, password, name);
                if (r.confirmed) {
                    LSVAnalytics.track('account_created', {});
                    this.status('Compte créé : tu es connecté·e.', 'ok');
                    this.$('account-password').value = '';
                    await this.refresh();
                    this.close();
                    WelcomeView.finish();
                    UI.showToast('Compte créé : bienvenue sur LSV.ai.', 'success', 3500);
                } else {
                    this.setMode('login');
                    this.status('Compte créé : confirme ton e-mail puis connecte-toi.', 'ok');
                }
            } else {
                await AccountService.signIn(email, password);
                LSVAnalytics.track('account_signed_in', {});
                this.$('account-password').value = '';
                this.status('Connexion réussie.', 'ok');
                await this.refresh();
                this.close();
                WelcomeView.finish();
                UI.showToast('Connexion réussie.', 'success', 2600);
            }
        } catch (e) {
            this.status(AccountService.friendly(e && e.message), 'err');
        } finally {
            this.busy = false;
            btn.disabled = false;
            btn.textContent = label;
        }
    },
    async logout() {
        try { await AccountService.signOut(); } catch (e) {}
        this.renderGuest();
        this.status('Déconnecté.', 'ok');
        UI.showToast('Déconnecté de ton compte.', 'success', 2400);
        if (typeof WelcomeView !== 'undefined') WelcomeView.open();
    }
};

/* ── Page d'accueil (première visite) ──────────────────────────────
   Belle page de présentation du studio + gallerie d'exemples.
   Première visite : le visiteur crée un compte (ou se connecte)
   avant d'entrer dans le dashboard de création. */
const WelcomeView = {
    $(id) { return document.getElementById(id); },
    done() { try { return localStorage.getItem('lsv4_welcome') === 'done'; } catch (e) { return false; } },
    markDone() { try { localStorage.setItem('lsv4_welcome', 'done'); } catch (e) {} },
    isOpen() { const el = this.$('welcome'); return !!el && !el.classList.contains('hidden'); },
    finish() { this.markDone(); this.hide(); },
    hide() { const el = this.$('welcome'); if (el) el.classList.add('hidden'); },
    open() { const el = this.$('welcome'); if (el) el.classList.remove('hidden'); this.loadGallery(); },
    init() {
        const logo = this.$('welcome-logo');
        if (logo) logo.addEventListener('error', () => logo.classList.add('hidden'));
        const yr = this.$('welcome-year');
        if (yr) yr.textContent = new Date().getFullYear();
        ['welcome-continue', 'welcome-continue-2'].forEach(id => {
            const b = this.$(id);
            if (b) b.addEventListener('click', () => this.continue());
        });
        const login = this.$('welcome-login');
        if (login) login.addEventListener('click', () => {
            AccountView.setMode('login');
            AccountView.open();
        });
        if (AccountService.signedIn()) this.hide();
        else this.open();
    },
    loadGallery() {
        document.querySelectorAll('#welcome-gallery img[data-src]').forEach(img => {
            if (img.dataset.loaded) return;
            img.dataset.loaded = '1';
            img.addEventListener('load', () => {
                const shot = img.closest('.w-shot');
                if (shot) shot.classList.add('has-img');
            });
            img.addEventListener('error', () => {
                if (img.dataset.fallback && !img.dataset.fallbackTried) {
                    img.dataset.fallbackTried = '1';
                    img.src = img.dataset.fallback;
                }
            });
            img.src = img.dataset.src;
        });
    },
    async continue() {
        const t = await AccountService.token();
        if (t) { this.finish(); return; }
        AccountView.setMode('signup');
        AccountView.open();
        AccountView.status('Crée ton compte pour accéder au studio.', 'err');
    }
};

