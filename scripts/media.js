const AgnesProvider = {
    /* En-tête posé par la passerelle. Ils relient une erreur du back-office à
       la LIGNE DE JOURNAL de la fonction Edge, où figurent le vrai statut amont
       et un extrait de sa réponse. */
    header(res, name) {
        try {
            return (res && res.headers && res.headers.get && res.headers.get(name)) || '';
        } catch (e) { return ''; }
    },
    reqId(res) { return this.header(res, 'x-lsv-request-id'); },
    /* Erreur levée sur une réponse non-2xx. Le message est destiné au journal
       d'analyse (où l'admin le lit en entier), JAMAIS à l'utilisateur, qui
       reçoit un texte générique via Utils.friendlyError.
       Les cinq en-têtes `x-lsv-upstream-*` sont des champs STRUCTURÉS que la
       passerelle extrait du refus de validation : statut réel, code, paramètre,
       nature du refus et valeurs admises. On voit donc « le réglage X est
       interdit » ou « le réglage X attend l'une de ces valeurs » sans rien
       exposer du fournisseur ni rouvrir les journaux. Le statut réel n'est
       rappelé QUE s'il diffère de celui renvoyé au client : un 502 affiché
       masque en effet un 401, un 404 ou un 500. */
    async fail(res) {
        let body = '';
        try { body = await res.text(); } catch (e) {}
        const id = this.reqId(res);
        const up = this.header(res, 'x-lsv-upstream-status');
        const bits = [
            up && up !== String(res.status) ? 'amont ' + up : '',
            this.header(res, 'x-lsv-upstream-code'),
            this.header(res, 'x-lsv-upstream-param'),
            this.header(res, 'x-lsv-upstream-reason'),
            this.header(res, 'x-lsv-upstream-allowed')
        ];
        const allowed = bits[4];
        bits[4] = allowed ? 'valeurs ' + allowed : '';
        const why = bits.filter(Boolean).length ? ' (' + bits.filter(Boolean).join(' · ') + ')' : '';
        const err = new Error('HTTP ' + res.status + (id ? ' [' + id + ']' : '') + why + ' — ' + body.slice(0, 200));
        /* JETON technique : jamais affiché à l'utilisateur, seulement lu par
           Utils.friendlyError pour choisir un message honnête. La passerelle
           l'a déjà filtré (A-Za-z0-9_-), donc rien du texte amont ne suit. */
        err.code = this.header(res, 'x-lsv-upstream-code');
        return err;
    },
    async fetch(url, options = {}, label = 'API') {
        // Création réservée aux comptes connectés (image, vidéo, enhancer, batch…)
        if (!(await AccountView.ensure())) throw new Error('Connexion requise');
        options = Gateway.withHeaders(options);
        for (let attempt = 0; attempt < CONFIG.RETRY_MAX_ATTEMPTS; attempt++) {
            if (Runtime.stopRequested) throw new Error('Arrêt demandé');
            const method = options.method || 'GET';
            let preview = null;
            if (options.body) {
                try {
                    const p = JSON.parse(options.body);
                    const c = JSON.parse(JSON.stringify(p));
                    if (c.image && typeof c.image === 'string' && c.image.length > 80) c.image = c.image.slice(0, 80) + '…[b64]';
                    if (c.last_frame && typeof c.last_frame === 'string' && c.last_frame.length > 80) c.last_frame = c.last_frame.slice(0, 80) + '…[b64]';
                    preview = c;
                } catch (e) { preview = String(options.body).slice(0, 400); }
            }
            DebugService.log('api', 'REQ ' + label, method + ' ' + url + ' (essai ' + (attempt + 1) + ')', preview);
            try {
                const t0 = Date.now();
                const res = await fetch(url, options);
                const dt = Date.now() - t0;
                DebugService.log('response', 'REP ' + label, 'HTTP ' + res.status + ' en ' + dt + 'ms');
                /* Les en-têtes de quota sont lus à chaque vol : le compteur
                   « restant » reste exact sans appel supplémentaire. */
                if (window.QuotaService && QuotaService.applyHeaders) QuotaService.applyHeaders(res);
                if (res.status === 429) {
                    /* Quota journalier épuisé : inutile de réessayer, le
                       compteur ne repart qu'à minuit UTC. */
                    if (window.QuotaService && QuotaService.isExhausted(res)) {
                        DebugService.log('warn', 'QUOTA', 'quota du jour atteint');
                        UI.setStatus('');
                        throw new Error(QuotaService.message(res) || 'Quota du jour atteint.');
                    }
                    const wait = CONFIG.RETRY_429_WAITS[Math.min(attempt, 6)];
                    DebugService.log('warn', 'RATELIMIT', '429 — attente ' + wait + 's');
                    UI.setStatus('Génération en cours… (' + wait + 's)');
                    await Utils.sleep(wait * 1000);
                    continue;
                }
                if (res.status === 503 && window.QuotaService && QuotaService.message(res)) {
                    /* Générations suspendues par l'administrateur. */
                    DebugService.log('warn', 'SUSPENDU', 'générations suspendues');
                    UI.setStatus('');
                    throw new Error(QuotaService.message(res));
                }
                if (res.status === 503) {
                    const wait = CONFIG.RETRY_503_WAITS[Math.min(attempt, 5)];
                    const code = this.header(res, 'x-lsv-upstream-code');
                    DebugService.log('warn', 'SERVICE', '503 ' + (code || '—') + ' — attente ' + wait + 's');
                    /* Une file saturée n'est pas un incident : l'utilisateur a
                       besoin de savoir que c'est le service vidéo qui est pris,
                       pas que « quelque chose » ne va pas. Ce refus RÉEL met
                       aussi le bandeau d'état en « saturée » tout de suite. */
                    if (code === 'video_queue_full') VideoAvailabilityService.markSaturated(120);
                    UI.setStatus(code === 'video_queue_full'
                        ? 'File vidéo saturée — nouvel essai dans ' + wait + 's'
                        : 'Service indisponible… (' + wait + 's)');
                    await Utils.sleep(wait * 1000);
                    continue;
                }
                return res;
            } catch (e) {
                if (e.message === 'Arrêt demandé') throw e;
                const wait = CONFIG.RETRY_NETWORK_WAITS[Math.min(attempt, 5)];
                DebugService.log('warn', 'NETWORK', e.message + ' — retry ' + wait + 's');
                UI.setStatus('Connexion… (' + wait + 's)');
                await Utils.sleep(wait * 1000);
            }
        }
        return fetch(url, options);
    }
};

const PromptService = {
    buildImage(state) {
        const style = Utils.getStyleById(state.imageStyle);
        const parts = [];
        if (style) parts.push(style.prompt);
        parts.push(state.imagePrompt.trim());
        const locks = LockService.all();
        if (locks.length) {
            const lockHints = locks.map(l => l.name + ' : ' + l.description).join('. ');
            parts.push('Maintain consistency with: ' + lockHints);
        }
        parts.push('High quality, well-composed, professional.');
        return parts.join('. ');
    },
    buildVideo(state, segmentIndex, totalSegments) {
        const style = Utils.getStyleById(state.videoStyle);
        const parts = [];
        if (style) parts.push(style.prompt);
        parts.push(state.videoPrompt.trim());
        if (state.videoMotionCamera && state.videoMotionCamera !== 'static') {
            const labels = {
                'zoom-in': 'slow zoom in',
                'zoom-out': 'slow zoom out',
                'pan-left': 'camera panning left',
                'pan-right': 'camera panning right',
                'orbit': 'camera slowly orbiting the subject',
                'dolly': 'camera dollying forward',
                'tracking': 'camera tracking the subject'
            };
            parts.push(labels[state.videoMotionCamera] || '');
        }
        if (state.videoMotionIntensity) {
            const labels = {
                subtle: 'very subtle movement',
                moderate: 'moderate movement',
                strong: 'dynamic energetic movement'
            };
            parts.push(labels[state.videoMotionIntensity] || '');
        }
        if (totalSegments > 1) parts.push('Segment ' + (segmentIndex + 1) + '/' + totalSegments + '. Maintain continuity.');
        parts.push('Portrait orientation, 24fps, no text, no watermark.');
        return parts.filter(Boolean).join('. ');
    }
};

const ImageService = {
    async generate(prompt, size) {
        const safeSize = Utils.clampSize(size);
        const body = {
            model: CONFIG.MODEL_IMAGE,
            prompt, n: 1, size: safeSize,
            response_format: 'url'
        };
        const res = await AgnesProvider.fetch(
            CONFIG.API_BASE + '/images/generations',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            },
            'Image'
        );
        if (!res.ok) throw await AgnesProvider.fail(res);
        const data = await res.json();
        const item = data.data && data.data[0];
        if (!item) throw new Error('Pas de donnée image');
        if (item.url) return item.url;
        if (item.b64_json) return 'data:image/png;base64,' + item.b64_json;
        throw new Error('Format inconnu');
    }
};

const VideoService = {
    async createTask(firstFrame, lastFrame, prompt, frames) {
        /* Contrat de POST /v1/videos, établi par élimination (§2.16) :
           `mode` est obligatoire ; `text` refuse TOUT champ média ; `keyframe`
           exige `first_frame` (le champ `image` n'existe pas) et accepte
           `last_frame`. `num_frames`, `frame_rate` et `n` sont interdits — la
           durée ne se règle par aucun d'eux. `frames` ne sert donc plus qu'à
           estimer le temps d'attente du sondage. */
        const hasFirst = typeof firstFrame === 'string' && !!firstFrame.trim();
        const hasLast = typeof lastFrame === 'string' && !!lastFrame.trim();
        const body = {
            model: CONFIG.MODEL_VIDEO,
            mode: hasFirst ? CONFIG.VIDEO_MODE_KEYFRAME : CONFIG.VIDEO_MODE_TEXT,
            prompt
        };
        if (hasFirst) {
            body.first_frame = firstFrame;
            if (hasLast) body.last_frame = lastFrame;
        }
        const res = await AgnesProvider.fetch(
            CONFIG.API_BASE + '/videos',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            },
            'Video'
        );
        if (!res.ok) throw await AgnesProvider.fail(res);
        const data = await res.json();
        const id = data.video_id || data.id || data.task_id;
        if (!id) throw new Error('Pas de video_id');
        return id;
    },
    async poll(id, frames, onProgress) {
        const estimated = TimingService.estimate('video', 30000 + frames * 500);
        const minWait = Math.min(CONFIG.VIDEO_FIRST_POLL_DELAY_SEC, Math.max(60, Math.floor(estimated / 1000 * 0.75)));
        let remaining = minWait;
        while (remaining > 0) {
            if (Runtime.stopRequested) throw new Error('Arrêt demandé');
            onProgress('Préparation — ' + remaining + 's');
            await Utils.sleep(1000);
            remaining--;
        }
        for (let attempt = 0; attempt < CONFIG.VIDEO_MAX_POLL_ATTEMPTS; attempt++) {
            if (Runtime.stopRequested) throw new Error('Arrêt demandé');
            if (attempt > 0) {
                const idx = Math.min(attempt - 1, CONFIG.VIDEO_POLL_INTERVALS.length - 1);
                let r = CONFIG.VIDEO_POLL_INTERVALS[idx];
                while (r > 0) {
                    if (Runtime.stopRequested) throw new Error('Arrêt demandé');
                    onProgress('Génération — ' + r + 's');
                    await Utils.sleep(1000);
                    r--;
                }
            }
            const url = CONFIG.POLL_BASE + '?video_id=' + encodeURIComponent(id) + '&model_name=' + encodeURIComponent(CONFIG.MODEL_VIDEO);
            /* Un sondage qui échoue ne doit pas détruire une génération déjà
               acceptée par le fournisseur : on note la panne et on réessaie à
               la prochaine itération (la boucle est bornée). */
            let d = null;
            try {
                const res = await AgnesProvider.fetch(url, { method: 'GET' }, 'Polling');
                if (res.ok) d = await res.json();
                else DebugService.log('warn', 'POLL', 'HTTP ' + res.status + ' ' + AgnesProvider.reqId(res));
            } catch (e) {
                DebugService.log('warn', 'POLL', e.message);
            }
            if (!d) { onProgress('Connexion…'); continue; }
            const status = d.status || 'unknown';
            const progress = d.progress || 0;
            onProgress('Création — ' + progress + '%');
            if (status === 'completed' || status === 'succeeded' || status === 'done') {
                const videoUrl = (d.metadata && d.metadata.url) || d.url || (d.output && d.output.url);
                if (!videoUrl) throw new Error('Terminé mais pas d\'URL');
                return videoUrl;
            }
            if (status === 'failed' || status === 'error' || status === 'cancelled') {
                /* Le fournisseur donne souvent la vraie raison : on la garde
                   pour le journal d'analyse (l'utilisateur voit un texte
                   générique, cf. Utils.friendlyError). */
                const why = (d.error && (d.error.message || d.error)) ||
                    (d.metadata && (d.metadata.error || d.metadata.message)) || d.message || '';
                throw new Error('Échec (' + status + ')' + (why ? ' — ' + String(why).slice(0, 200) : ''));
            }
        }
        throw new Error('Timeout');
    },
    async extractLastFrame(videoUrl) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.crossOrigin = 'anonymous';
            video.muted = true;
            video.preload = 'auto';
            video.src = videoUrl;
            const timeout = setTimeout(() => reject(new Error('Timeout')), 20000);
            video.addEventListener('loadedmetadata', () => {
                video.currentTime = Math.max(0, video.duration - 0.1);
            });
            video.addEventListener('seeked', () => {
                clearTimeout(timeout);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = video.videoWidth || 720;
                    canvas.height = video.videoHeight || 1280;
                    canvas.getContext('2d').drawImage(video, 0, 0);
                    resolve(canvas.toDataURL('image/jpeg', 0.92));
                } catch (e) { reject(e); }
            });
            video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Erreur')); });
        });
    }
};

/* ── Disponibilité du service vidéo ───────────────────────────────────────
   Ni le front ni la passerelle ne savent si une génération VA aboutir :
   Agnes n'expose aucun état de file. Ce service affiche donc ce qui est
   MESURABLE, et rien de plus :
     - la passerelle sonde GET /v1/models (0 unité de quota) : le
       fournisseur répond-il, la clé du serveur est-elle acceptée ;
     - elle garde 2 min la dernière saturation observée (503
       `video_queue_full`) sur un vrai POST /v1/videos.
   Trois règles de vérité :
     1. « opérationnel » signifie joignable et non saturée au moment de la
        mesure — JAMAIS « ta vidéo va passer » ;
     2. l'état est caché 60 s côté serveur et localement : re-sonder en
        boucle est précisément ce qui vide une file déjà limitée ;
     3. un échec de sonde affiche « inconnu », pas « indisponible » : on ne
        présente pas une erreur de mesure comme un incident constaté.
   Une saturation vue sur une vraie tentative (`markSaturated`) prime : elle
   vient d'un refus réel du fournisseur, pas d'une sonde. */
const VideoAvailabilityService = {
    TTL: 60000,
    _state: null,
    _at: 0,
    _recvAt: 0,
    _pending: null,
    _bound: false,

    get status() { return (this._state && this._state.status) || 'unknown'; },
    get probe() { return (this._state && this._state.probe) || ''; },

    _save() {
        try {
            localStorage.setItem(STORAGE_KEYS.VIDEO_AVAIL, JSON.stringify({
                at: this._at, recv: this._recvAt, s: this._state
            }));
        } catch (e) {}
    },
    _load() {
        if (this._state) return;
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.VIDEO_AVAIL);
            if (!raw) return;
            const o = JSON.parse(raw);
            if (o && o.s && typeof o.s === 'object') {
                this._state = o.s;
                this._at = o.at || 0;
                this._recvAt = o.recv || 0;
            }
        } catch (e) {}
    },
    /** Sonde la passerelle. `force` ignore le cache local (bouton Re-vérifier). */
    async refresh(force) {
        this._load();
        if (!force && this._state && (Date.now() - this._at) < this.TTL) {
            this.render();
            return this._state;
        }
        if (!CONFIG.GATEWAY_READY) { this.render(); return this._state; }
        if (this._pending) return this._pending;
        this._pending = (async () => {
            try {
                const res = await fetch(CONFIG.API_BASE + '/video-availability', {
                    method: 'GET',
                    headers: Gateway.withHeaders({ 'Accept': 'application/json' })
                });
                if (res && res.ok) {
                    const s = await res.json();
                    if (s && s.status) {
                        this._state = s;
                        this._at = Date.now();
                        this._recvAt = Date.now();
                        this._save();
                    }
                } else if (res && res.status === 429) {
                    /* Sondé trop souvent : on garde l'état connu plutôt que
                       de le remplacer par une erreur de débit. */
                    DebugService.log('warn', 'DISPO', '429 — état conservé');
                } else {
                    DebugService.log('warn', 'DISPO', 'HTTP ' + (res ? res.status : 0));
                }
            } catch (e) {
                /* Sonde impossible : deux écueils à éviter — afficher « en
                   panne » alors que seul le RÉSEAU a échoué, ou afficher
                   « opérationnel » avec une mesure qui n'a pas eu lieu. On
                   passe donc en « non vérifié », en rappelant la dernière
                   mesure réussie si elle existe. Exception : un refus RÉEL
                   de la file (vu sur une tentative) prime sur la sonde
                   ratée — il vient du fournisseur, pas d'un réseau. */
                DebugService.log('warn', 'DISPO', e.message);
                const prev = this._state;
                this._at = Date.now();
                if (!(prev && prev.status === 'queue_full' && this.remaining() > 0)) {
                    this._state = {
                        available: false, status: 'unknown', probe: 'sonde_echouee',
                        provider: 'agnes', checked_at: prev ? prev.checked_at : 0,
                        ttl: this.TTL / 1000, retry_after: 0
                    };
                }
                this._save();
            }
            this._pending = null;
            this.render();
            return this._state;
        })();
        return this._pending;
    },
    /** Saturation vue sur une vraie tentative de génération (503 refusé). */
    markSaturated(retryAfterSec) {
        const secs = Math.max(15, Math.min(300, retryAfterSec || 120));
        this._state = {
            available: false, status: 'queue_full', probe: 'refus_reel',
            provider: 'agnes', checked_at: Date.now(), ttl: this.TTL / 1000,
            retry_after: secs, source: 'tentative'
        };
        this._at = Date.now();
        this._recvAt = Date.now();
        this._save();
        this.render();
    },
    /** Secondes restantes avant la fin de la saturation mesurée (0 si hors). */
    remaining() {
        if (!this._state || this._state.status !== 'queue_full') return 0;
        const total = this._state.retry_after || 0;
        const gone = Math.floor((Date.now() - (this._recvAt || this._at)) / 1000);
        return Math.max(0, total - gone);
    },
    _copy() {
        const s = this._state;
        const st = (s && s.status) || 'unknown';
        const when = s && s.checked_at
            ? new Date(s.checked_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
            : '';
        if (st === 'ok') return {
            tone: 'ok', badge: 'Opérationnel',
            title: 'Service vidéo opérationnel',
            hint: 'Vérifié à ' + when + ' — fournisseur joignable et file non saturée à cet instant. ' +
                'Une génération reste soumise à la file du fournisseur.'
        };
        if (st === 'queue_full') return {
            tone: 'warn', badge: 'File saturée',
            title: 'File vidéo saturée — nouvelles demandes refusées',
            hint: 'Le fournisseur refuse les nouvelles générations. Réessaie dans ' +
                this.remaining() + ' s (ou Re-vérifier). Ton prompt et tes images sont conservés.'
        };
        if (st === 'amont_injoignable') return {
            tone: 'warn', badge: 'Hors ligne',
            title: 'Fournisseur injoignable',
            hint: 'La connexion vers le fournisseur a échoué (réseau ou incident chez lui). Réessaie dans un instant.'
        };
        if (st === 'auth_error') return {
            tone: 'err', badge: 'Clé refusée',
            title: 'Clé de génération refusée par le fournisseur',
            hint: 'Le service répond mais refuse la clé configurée. Seule la personne responsable du site peut la corriger.'
        };
        if (st === 'amont_erreur') return {
            tone: 'err', badge: 'Erreur amont',
            title: 'Le fournisseur répond en erreur',
            hint: 'Le service est accessible mais signale un incident. Réessaie plus tard.'
        };
        if (s && s.probe === 'sonde_echouee') return {
            tone: 'idle', badge: 'Non vérifié',
            title: 'Vérification impossible pour l\'instant',
            hint: 'La sonde n\'a pas abouti (réseau ou passerelle). Rien n\'est confirmé : l\'état réel du service reste à vérifier.' +
                (when ? ' Dernière mesure : ' + when + '.' : '')
        };
        if ((s && s.probe) === 'no_key') return {
            tone: 'err', badge: 'Non configuré',
            title: 'Aucune clé de génération configurée',
            hint: 'La génération est désactivée tant qu\'aucune clé n\'a été enregistrée côté serveur.'
        };
        return {
            tone: 'idle', badge: 'Inconnu',
            title: 'État du service vidéo non vérifié',
            hint: 'Aucune mesure disponible pour le moment. Utilise Re-vérifier pour lancer une sonde.'
        };
    },
    render() {
        this._load();
        const box = document.getElementById('video-availability');
        if (!box) return;
        if (!this._bound) {
            const btn = document.getElementById('video-avail-recheck');
            if (btn) {
                btn.addEventListener('click', () => {
                    UI.showToast('Vérification du service vidéo…', 'info', 2000);
                    this.refresh(true);
                });
                this._bound = true;
            }
        }
        const c = this._copy();
        box.classList.remove('avail-ok', 'avail-warn', 'avail-err', 'avail-idle');
        box.classList.add('avail-' + c.tone);
        const dot = document.getElementById('video-avail-dot');
        const title = document.getElementById('video-avail-title');
        const hint = document.getElementById('video-avail-hint');
        const badge = document.getElementById('video-avail-badge');
        if (dot) dot.textContent = c.tone === 'ok' ? 'check_circle' : (c.tone === 'idle' ? 'help' : 'warning');
        if (title) title.textContent = c.title;
        if (hint) hint.textContent = c.hint;
        if (badge) badge.textContent = c.badge;
        /* Un problème CONSTATÉ ouvre le centre d'alternatives : l'utilisateur
           a une piste concrète au lieu d'une impasse. Un simple échec de
           mesure (« non vérifié ») n'y suffit pas — on ne panique pas pour
           un réseau qui a manqué. Le panneau ne se referme jamais tout seul. */
        const st = (this._state && this._state.status) || 'unknown';
        const problem = st === 'queue_full' || st === 'amont_injoignable' ||
            st === 'auth_error' || st === 'amont_erreur' || this.probe === 'no_key';
        if (problem && typeof VideoAlternatives !== 'undefined') VideoAlternatives.open();
    }
};

/* ── Centre « Alternatives vidéo » ────────────────────────────────────────
   Quand le service intégré est saturé, l'utilisateur a besoin d'une PISTE
   concrète, pas d'un cul-de-sac. Ce centre liste des sites web gratuits
   dont le quota a été relevé sur leur page officielle (VIDEO_ALTERNATIVES)
   : chacun s'ouvre dans un nouvel onglet, aucun appel API n'est fait et
   aucune donnée LSV.ai ne quitte la page. Le service ne promet rien au nom
   d'un tiers : il affiche ce qui est écrit chez lui, avec la date. */
const VideoAlternatives = {
    _bound: false,
    _open: false,
    _host(u) {
        return String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    },
    render() {
        const intro = document.getElementById('video-alt-intro');
        const list = document.getElementById('video-alt-list');
        if (!list || !intro) return;
        intro.textContent = 'Le service intégré est saturé ? Ces sites gratuits fonctionnent dans leur propre ' +
            'interface : ouvre un onglet, colle ton prompt, récupère ta vidéo. Aucune donnée LSV.ai n\'est envoyée ' +
            'et aucun compte n\'est créé ici. Quotas gratuits relevés sur les pages officielles le ' + ALT_CHECKED +
            ' — le format vertical 9:16 se règle dans chaque service.';
        list.innerHTML = VIDEO_ALTERNATIVES.map(a => (
            '<a class="alt-item" href="' + a.url + '" target="_blank" rel="noopener noreferrer" data-alt="' + a.id + '">' +
                '<span class="alt-head">' +
                    '<span class="alt-name">' + Utils.escapeHtml(a.name) + '</span>' +
                    '<span class="alt-free">' + Utils.escapeHtml(a.free) + '</span>' +
                '</span>' +
                '<span class="alt-meta">Image → vidéo : ' + a.i2v + '</span>' +
                '<span class="alt-meta">Filigrane : ' + a.watermark +
                    (a.watermarkNote ? ' — ' + Utils.escapeHtml(a.watermarkNote) : '') + '</span>' +
                '<span class="alt-meta">Usage commercial : ' + a.license +
                    (a.licenseNote ? ' — ' + Utils.escapeHtml(a.licenseNote) : '') + '</span>' +
                '<span class="alt-note">' + Utils.escapeHtml(a.note) + '</span>' +
                '<span class="alt-src">Vérifié le ' + ALT_CHECKED + ' sur ' + this._host(a.source) + '</span>' +
            '</a>'
        )).join('');
        if (!this._bound) {
            const btn = document.getElementById('video-alt-toggle');
            if (btn) {
                btn.addEventListener('click', () => this.toggle());
                this._bound = true;
            }
        }
    },
    _set(open) {
        this._open = !!open;
        const panel = document.getElementById('video-alt-panel');
        const btn = document.getElementById('video-alt-toggle');
        if (panel) panel.hidden = !this._open;
        if (btn) {
            btn.setAttribute('aria-expanded', this._open ? 'true' : 'false');
            btn.innerHTML = (this._open ? 'Masquer ' : 'Afficher ') +
                '<span class="ms">' + (this._open ? 'expand_less' : 'expand_more') + '</span>';
        }
    },
    open() { if (!this._open) this._set(true); },
    toggle() { this._set(!this._open); },
    get isOpen() { return this._open; }
};

const FileService = {
    toDataUri(file) {
        return new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = e => res(e.target.result);
            r.onerror = () => rej(new Error('Erreur lecture'));
            r.readAsDataURL(file);
        });
    },
    async compressImage(file, maxSide = 1600) {
        const uri = await this.toDataUri(file);
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                const scale = Math.min(1, maxSide / Math.max(width, height));
                width = Math.round(width * scale);
                height = Math.round(height * scale);
                const c = document.createElement('canvas');
                c.width = width; c.height = height;
                c.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(c.toDataURL('image/jpeg', 0.88));
            };
            img.onerror = () => resolve(uri);
            img.src = uri;
        });
    }
};

const Runtime = {
    isRunning: false,
    stopRequested: false,
    imageCount: 0,
    videoCount: 0,
    currentProjectId: null,
    currentConversationId: null,
    chatStreaming: false,
    batchRunning: false
};

const UIState = {
    imageMode: 'prompt-only',
    imageStyle: 'cinematic',
    imageSize: '2K',
    imageRatio: '9:16',
    imagePrompt: '',
    imageRefs: [],
    videoMode: 'text-to-video',
    videoStyle: 'cinematic',
    videoSize: '1080P',
    videoRatio: '9:16',
    videoPrompt: '',
    videoRefs: [],
    videoFrames: 361,
    videoDuration: 15,
    videoSegments: 1,
    videoMotionCamera: 'static',
    videoMotionIntensity: 'moderate',
    libraryFilter: 'all',
    librarySearch: ''
};

/* ENHANCER */
const EnhancerService = {
    async enhance(idea, type, styleId) {
        const style = ENHANCER_STYLE_PROMPTS[styleId] || ENHANCER_STYLE_PROMPTS.cinematic;
        const prompt = [
            'Tu es un expert en direction artistique et en ingénierie de prompts pour IA génératives.',
            '',
            'Transforme cette idée brute en un prompt structuré professionnel :',
            '« ' + idea + ' »',
            '',
            'Type cible : ' + (type === 'video' ? 'VIDÉO' : 'IMAGE'),
            'Style visuel souhaité : ' + styleId,
            '',
            'Réponds en JSON valide, sans markdown, avec cette structure exacte :',
            '{',
            '  "subject": "description précise du sujet principal",',
            '  "environment": "décor, lieu, arrière-plan",',
            '  "lighting": "lumière, ambiance lumineuse",',
            '  "camera": "caméra, angle, cadrage",',
            '  "composition": "règles de composition, mise en scène",',
            '  "motion": "mouvement, action (si vidéo, sinon vide)",',
            '  "style": "style artistique précis",',
            '  "constraints": "contraintes techniques",',
            '  "full_prompt": "assemblage final en anglais, prêt à copier-coller"',
            '}'
        ].join('\n');

        const res = await AgnesProvider.fetch(
            CONFIG.API_BASE + '/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: CONFIG.MODEL_CHAT,
                    messages: [
                        { role: 'system', content: 'Tu réponds toujours en JSON valide sans markdown.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 2000,
                    response_format: { type: 'json_object' }
                })
            },
            'Enhancer'
        );
        if (!res.ok) throw await AgnesProvider.fail(res);
        const data = await res.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        return this._extractJson(content);
    },
    _extractJson(text) {
        if (!text) return null;
        let c = text.trim();
        const fm = c.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fm) c = fm[1].trim();
        const fb = c.indexOf('{');
        if (fb < 0) return null;
        c = c.slice(fb);
        try { return JSON.parse(c); } catch (e) {}
        try { return JSON.parse(c.slice(0, c.lastIndexOf('}') + 1)); } catch (e) {}
        return null;
    }
};

/* STUDIO DE SCÉNARIOS IA
   Trois modes (SCENARIO_MODES), un seul contrat de sortie : JSON
   { title, logline, scenes[] }. Le JSON rend le résultat affichable et
   transmissible au Storyboard sans interprétation de texte libre — c'est la
   même raison pour laquelle l'Enhancer y a recours. Le modèle choisi est
   celui de l'onglet Chat (intégré ou Mistral) : la requête passe par la
   passerelle, donc par le même quota que le chat. */
const ScenarioService = {
    async generate(idea, modeId) {
        const mode = SCENARIO_MODES.find(m => m.id === modeId) || SCENARIO_MODES[0];
        const prompt = [
            'Tu es scénariste et chef de plateau pour des vidéos courtes générées par IA.',
            '',
            'Idée de départ : « ' + idea + ' »',
            '',
            'Format demandé : ' + mode.name,
            mode.brief,
            '',
            'Règles :',
            '- français, concret, tournable, sans jargon ni référence à un outil ;',
            '- chaque scène décrit ce qui se VOIT et ce qui s\'ENTEND ;',
            '- le champ "prompt" d\'une scène est un prompt image/vidéo autonome (sujet, décor, lumière, caméra).',
            '',
            'Réponds en JSON valide, sans markdown, avec cette structure exacte :',
            '{',
            '  "title": "titre du scénario",',
            '  "logline": "une phrase d\'accroche",',
            '  "scenes": [',
            '    { "act": "Acte I", "title": "titre de scène", "description": "ce qui s\'y passe", "prompt": "prompt image ou vidéo autonome" }',
            '  ]',
            '}'
        ].join('\n');

        const res = await AgnesProvider.fetch(
            CONFIG.API_BASE + '/chat/completions',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: ChatService.model(),
                    messages: [
                        { role: 'system', content: 'Tu réponds toujours en JSON valide sans markdown.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.8,
                    max_tokens: 3000,
                    response_format: { type: 'json_object' }
                })
            },
            'Scénarios'
        );
        if (!res.ok) throw await AgnesProvider.fail(res);
        const data = await res.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        return this._normalize(content, mode.id);
    },
    _normalize(text, modeId) {
        const raw = EnhancerService._extractJson(text);
        if (!raw || !Array.isArray(raw.scenes)) throw new Error('Réponse illisible');
        const scenes = raw.scenes
            .filter(s => s && (s.title || s.description || s.prompt))
            .map((s, i) => ({
                number: i + 1,
                act: String(s.act || '').slice(0, 60),
                title: String(s.title || 'Scène ' + (i + 1)).slice(0, 120),
                description: String(s.description || '').slice(0, 1200),
                prompt: String(s.prompt || '').slice(0, 2000)
            }));
        if (!scenes.length) throw new Error('Aucune scène');
        return {
            title: String(raw.title || 'Scénario').slice(0, 120),
            logline: String(raw.logline || '').slice(0, 300),
            format: modeId,
            scenes: scenes
        };
    }
};

/* AMÉLIORATION DE PROMPT (AVANT / APRÈS)
   Distinct de l'Enhancer, qui part d'une idée BRUTE pour produire un prompt
   structuré : ici on part d'un prompt EXISTANT, qu'on montre intact à côté
   de sa version améliorée. La consigne impose de renvoyer le seul prompt —
   sinon le modèle ajouterait des commentaires que rien ne pourrait
   distinguer du prompt lui-même. */
const PromptImproveService = {
    async improve(prompt) {
        const sys = [
            'Tu es expert en ingénierie de prompts pour IA génératives.',
            'Réécris le prompt fourni pour le rendre plus précis et plus efficace :',
            'détaille le sujet, la lumière, la caméra et le style SANS changer son intention.',
            'Réponds UNIQUEMENT par le prompt amélioré, sans explication, sans titre,',
            'sans guillemets et sans bloc markdown.'
        ].join(' ');

        const res = await AgnesProvider.fetch(
            CONFIG.API_BASE + '/chat/completions',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: ChatService.model(),
                    messages: [
                        { role: 'system', content: sys },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 1500
                })
            },
            'Prompt'
        );
        if (!res.ok) throw await AgnesProvider.fail(res);
        const data = await res.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        const out = String(content || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
        if (!out) throw new Error('Réponse vide');
        return out;
    }
};

/* UI CONTROLLER */
