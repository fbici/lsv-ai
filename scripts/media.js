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
        return new Error('HTTP ' + res.status + (id ? ' [' + id + ']' : '') + why + ' — ' + body.slice(0, 200));
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
                    DebugService.log('warn', 'SERVICE', '503 — attente ' + wait + 's');
                    UI.setStatus('Service indisponible… (' + wait + 's)');
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

/* UI CONTROLLER */
