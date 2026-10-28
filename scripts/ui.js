const UI = {
    setStatus(text) {
        const bar = document.getElementById('status-bar');
        const txt = document.getElementById('status-text');
        if (!bar || !txt) return;
        if (text) { bar.classList.add('visible'); txt.textContent = text; }
        else bar.classList.remove('visible');
    },
    _toastTimer: null,
    showToast(msg, type = 'success', dur = 2800) {
        const toast = document.getElementById('toast');
        const icon = document.getElementById('toast-icon');
        const text = document.getElementById('toast-text');
        if (!toast || !icon || !text) return;
        toast.classList.remove('visible', 'success', 'error', 'warn');
        void toast.offsetWidth;
        const icons = { success: 'check_circle', error: 'error', warning: 'warning', warn: 'warning' };
        icon.textContent = icons[type] || 'info';
        text.textContent = msg;
        toast.classList.add(type);
        requestAnimationFrame(() => toast.classList.add('visible'));
        if (this._toastTimer) clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.remove('visible'), dur);
    },
    switchTab(id) {
        /* Garde-fou : les entrées de la sidebar qui sont des liens externes
           (ex. Studio vidéo → ./studio/) n'ont pas de data-tab. Sans ce test,
           switchTab(undefined) désactiverait tous les .tab-content. */
        if (!id) return;
        document.querySelectorAll('.nav-item').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
        document.querySelectorAll('.nav-mob').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
        document.querySelectorAll('.tab-content').forEach(p => p.classList.toggle('active', p.id === 'tab-' + id));
        DebugService.log('info', 'TAB', 'Onglet : ' + id);
        LSVAnalytics.track('tab_view', { tab: id });
        if (id === 'dashboard') Dashboard.refresh();
        if (id === 'chat') ChatView.refresh();
        if (id === 'projects') ProjectsView.refresh();
        if (id === 'library') LibraryView.refresh();
        if (id === 'history') HistoryView.refresh();
        if (id === 'advanced') AdvancedView.refresh();
        if (id === 'storyboard') StoryboardView.refresh();
        if (id === 'locks') LocksView.refresh();
        /* Onglet Vidéo : sonde de disponibilité (cache 60 s côté serveur,
           donc un aller-retour inoffensif à chaque visite). Le service est
           une constante de portée globale, PAS une propriété de window. */
        if (id === 'video' && typeof VideoAvailabilityService !== 'undefined') VideoAvailabilityService.refresh();
    },
    updateButtons() {
        const hasKey = CONFIG.GATEWAY_READY;
        const imgBtn = document.getElementById('image-generate');
        if (imgBtn) {
            const ok = UIState.imagePrompt.trim().length > 5 && (!(UIState.imageMode !== 'prompt-only') || UIState.imageRefs.length > 0);
            imgBtn.disabled = !hasKey || !ok || Runtime.isRunning;
        }
        const vidBtn = document.getElementById('video-generate');
        if (vidBtn) {
            const ok = UIState.videoPrompt.trim().length > 5 && (!(UIState.videoMode !== 'text-to-video') || UIState.videoRefs.length > 0);
            vidBtn.disabled = !hasKey || !ok || Runtime.isRunning;
        }
        const chatSend = document.getElementById('chat-send');
        const chatInput = document.getElementById('chat-input');
        if (chatSend && chatInput) chatSend.disabled = !hasKey || !chatInput.value.trim() || Runtime.chatStreaming;
        const enhBtn = document.getElementById('enhancer-generate');
        if (enhBtn) {
            const hasPrompt = document.getElementById('enhancer-input').value.trim().length > 3;
            enhBtn.disabled = !hasKey || !hasPrompt;
        }
        const scenBtn = document.getElementById('scenario-generate');
        if (scenBtn) {
            const hasIdea = document.getElementById('scenario-input').value.trim().length > 3;
            scenBtn.disabled = !hasKey || !hasIdea || Runtime.isRunning;
        }
        const impBtn = document.getElementById('improve-generate');
        if (impBtn) {
            const hasPrompt = document.getElementById('improve-input').value.trim().length > 3;
            impBtn.disabled = !hasKey || !hasPrompt;
        }
        const batchBtn = document.getElementById('batch-generate');
        if (batchBtn) {
            const hasPrompt = document.getElementById('batch-prompt').value.trim().length > 5;
            batchBtn.disabled = !hasKey || !hasPrompt || Runtime.batchRunning;
        }
    },
    updateDurationInfo() {
        const info = document.getElementById('video-duration-info');
        if (!info) return;
        if (UIState.videoSegments === 1) {
            info.textContent = UIState.videoDuration + 's · 1 segment de ' + UIState.videoFrames + ' frames (24 fps)';
        } else {
            info.textContent = UIState.videoDuration + 's · ' + UIState.videoSegments + ' segments de ' + (UIState.videoDuration / UIState.videoSegments) + 's · continuité par keyframe';
        }
    },
    renderStyleGrid(containerId, current, onChange) {
        const grid = document.getElementById(containerId);
        if (!grid) return;
        grid.innerHTML = STYLES.map(s =>
            '<div class="style-tile ' + (s.id === current ? 'selected' : '') + '" data-style="' + s.id + '">' +
                '<span class="ms">' + s.icon + '</span>' +
                '<div>' +
                    '<div class="style-name">' + Utils.escapeHtml(s.name) + '</div>' +
                    '<div class="style-desc">' + Utils.escapeHtml(s.desc) + '</div>' +
                '</div>' +
            '</div>'
        ).join('');
        grid.querySelectorAll('[data-style]').forEach(el => {
            el.addEventListener('click', () => {
                onChange(el.dataset.style);
                this.renderStyleGrid(containerId, el.dataset.style, onChange);
            });
        });
    },
    /* Sélecteur de ratio visuel : chaque option montre un rectangle aux
       proportions réelles (comme les plateformes d'IA grand public), plus
       lisible qu'un menu déroulant de ratios. `allowed` filtre la liste
       (la vidéo n'accepte que 16:9 / 9:16 / 1:1). */
    renderRatioGrid(containerId, current, onChange, allowed) {
        const grid = document.getElementById(containerId);
        if (!grid) return;
        const list = allowed ? RATIOS.filter(r => allowed.indexOf(r.id) !== -1) : RATIOS;
        grid.innerHTML = list.map(r => {
            const on = r.id === current;
            return '<button type="button" class="ratio-opt ' + (on ? 'selected' : '') + '" ' +
                'data-ratio="' + r.id + '" role="radio" aria-checked="' + on + '" ' +
                'title="' + Utils.escapeHtml(r.use) + '">' +
                '<span class="ratio-shape" style="aspect-ratio:' + r.w + '/' + r.h + '"></span>' +
                '<span class="ratio-label">' + r.id + '</span>' +
                '<span class="ratio-use">' + Utils.escapeHtml(r.use) + '</span>' +
                '</button>';
        }).join('');
        grid.setAttribute('role', 'radiogroup');
        grid.querySelectorAll('[data-ratio]').forEach(el => {
            el.addEventListener('click', () => {
                onChange(el.dataset.ratio);
                this.renderRatioGrid(containerId, el.dataset.ratio, onChange, allowed);
            });
        });
    },
    renderUploadPreview(arr, previewId) {
        const c = document.getElementById(previewId);
        if (!c) return;
        c.innerHTML = arr.map(item =>
            '<div class="preview-item">' +
                '<img src="' + item.preview + '" alt="">' +
                '<button class="remove" data-id="' + item.id + '"><span class="ms">close</span></button>' +
            '</div>'
        ).join('');
        c.querySelectorAll('[data-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseFloat(btn.dataset.id);
                const idx = arr.findIndex(x => x.id === id);
                if (idx >= 0) arr.splice(idx, 1);
                this.renderUploadPreview(arr, previewId);
                this.updateButtons();
            });
        });
    },
    /* APERÇU — image ou vidéo affichée dans un surcouché de CETTE page.
       Le bouton « Ouvrir » partait en target="_blank" vers l'URL du
       fournisseur : l'utilisateur quittait LSV et atterrissait sur la page de
       l'hébergeur. L'aperçu ne fait que poser l'URL dans un <img>/<video>,
       donc l'affichage n'exige aucun droit CORS. */
    openPreview(url, name, type) {
        const backdrop = document.getElementById('preview-backdrop');
        const media = document.getElementById('preview-media');
        const label = document.getElementById('preview-name');
        if (!backdrop || !media || !url) return false;
        const safe = Utils.escapeHtml(url);
        const isVideo = type === 'video';
        media.innerHTML = isVideo
            ? '<video src="' + safe + '" controls autoplay playsinline></video>'
            : '<img src="' + safe + '" alt="' + Utils.escapeHtml(name || 'Image générée') + '">';
        if (label) label.textContent = name || (isVideo ? 'Vidéo générée' : 'Image générée');
        this._preview = {
            url: url,
            name: name || (isVideo ? 'lsv-video' : 'lsv-image'),
            type: isVideo ? 'video' : 'image'
        };
        backdrop.classList.add('visible');
        backdrop.setAttribute('aria-hidden', 'false');
        return true;
    },
    closePreview() {
        const backdrop = document.getElementById('preview-backdrop');
        if (!backdrop || !backdrop.classList.contains('visible')) return false;
        backdrop.classList.remove('visible');
        backdrop.setAttribute('aria-hidden', 'true');
        const media = document.getElementById('preview-media');
        if (media) media.innerHTML = ''; /* coupe la lecture vidéo */
        this._preview = null;
        return true;
    },
    /* Téléchargement depuis l'aperçu : même chemin que le bouton des cartes. */
    savePreview() {
        const p = this._preview;
        if (!p) return;
        const base = (p.name || 'lsv').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'lsv';
        const file = base + (p.type === 'video' ? '.mp4' : '.png');
        Utils.triggerDownload(p.url, file).then(ok => {
            if (ok) UI.showToast('Téléchargement démarré', 'success', 2500);
            else UI.showToast('Téléchargement direct impossible : fais un clic droit sur l\'aperçu puis « Enregistrer sous… ».', 'error', 6000);
        });
    },
    createImageCard(url, size) {
        const card = document.createElement('div');
        card.className = 'result-card';
        const style = Utils.getStyleById(UIState.imageStyle);
        const safe = Utils.escapeHtml(url);
        card.innerHTML =
            '<div class="result-media" data-preview="' + safe + '" data-preview-type="image" title="Aperçu"><img src="' + safe + '" alt="" loading="lazy"></div>' +
            '<div class="result-meta">' +
                '<div class="res-name">' + Utils.escapeHtml(style.name) + '</div>' +
                '<div class="res-details">' + Utils.escapeHtml(Utils.clampSize(size)) + '</div>' +
            '</div>' +
            '<div class="result-actions">' +
                '<button type="button" class="res-action" data-preview="' + safe + '" data-preview-type="image"><span class="ms">zoom_in</span> Ouvrir</button>' +
                '<button type="button" class="res-action" data-download="' + safe + '" data-download-name="lsv-image.png"><span class="ms">download</span> Télécharger</button>' +
            '</div>';
        return card;
    },
    createVideoCard(videoUrls) {
        const card = document.createElement('div');
        card.className = 'result-card';
        const style = Utils.getStyleById(UIState.videoStyle);
        const safe0 = Utils.escapeHtml(videoUrls[0]);
        if (videoUrls.length === 1) {
            card.innerHTML =
                '<div class="result-media"><video src="' + safe0 + '" controls playsinline preload="metadata"></video></div>' +
                '<div class="result-meta"><div class="res-name">' + Utils.escapeHtml(style.name) + '</div><div class="res-details">' + UIState.videoDuration + 's</div></div>' +
                '<div class="result-actions">' +
                    '<button type="button" class="res-action" data-preview="' + safe0 + '" data-preview-type="video"><span class="ms">zoom_in</span> Ouvrir</button>' +
                    '<button type="button" class="res-action" data-download="' + safe0 + '" data-download-name="lsv-video.mp4"><span class="ms">download</span> Télécharger</button>' +
                '</div>';
        } else {
            const pid = 'playlist-' + Date.now();
            card.innerHTML =
                '<div class="result-media"><video id="' + pid + '" controls playsinline preload="metadata" src="' + safe0 + '"></video></div>' +
                '<div class="result-meta"><div class="res-name">' + Utils.escapeHtml(style.name) + '</div><div class="res-details">' + videoUrls.length + ' segments</div></div>' +
                '<div class="result-actions">' +
                    '<button type="button" class="res-action" data-preview="' + safe0 + '" data-preview-type="video"><span class="ms">zoom_in</span> Segment 1</button>' +
                    '<button type="button" class="res-action" data-download="' + safe0 + '" data-download-name="lsv-seg1.mp4"><span class="ms">download</span> Seg 1</button>' +
                '</div>';
            setTimeout(() => {
                const v = document.getElementById(pid);
                if (!v) return;
                let idx = 0;
                v.addEventListener('ended', () => {
                    idx++;
                    if (idx < videoUrls.length) { v.src = videoUrls[idx]; v.play(); }
                });
            }, 100);
        }
        return card;
    },
    renderQueue(containerId, segments) {
        const queue = document.getElementById(containerId);
        if (!queue) return;
        queue.innerHTML = '';
        for (let i = 0; i < segments; i++) {
            const item = document.createElement('div');
            item.className = 'queue-item';
            item.id = 'queue-seg-' + i;
            item.innerHTML = '<div class="q-index">' + (i + 1) + '</div>' +
                '<div class="q-body"><div class="q-name">Segment ' + (i + 1) + ' / ' + segments + '</div>' +
                '<div class="q-status" id="queue-seg-status-' + i + '">En attente</div></div>';
            queue.appendChild(item);
        }
    },
    updateQueueItem(index, status, text) {
        const item = document.getElementById('queue-seg-' + index);
        const statusEl = document.getElementById('queue-seg-status-' + index);
        if (!item || !statusEl) return;
        if (status === 'processing') item.className = 'queue-item processing';
        else if (status === 'done') item.className = 'queue-item done';
        else if (status === 'failed') item.className = 'queue-item failed';
        if (text) statusEl.textContent = text;
    },
    showModal({ title, desc, fields = [], confirmLabel = 'Confirmer', onConfirm, danger = false }) {
        const backdrop = document.getElementById('modal-backdrop');
        const modal = document.getElementById('modal');
        let fieldsHtml = '';
        fields.forEach((f, i) => {
            if (f.type === 'text' || f.type === 'textarea') {
                fieldsHtml += '<div class="field">' +
                    '<label class="field-label">' + Utils.escapeHtml(f.label) + '</label>' +
                    (f.type === 'textarea'
                        ? '<textarea id="modal-field-' + i + '" placeholder="' + Utils.escapeHtml(f.placeholder || '') + '">' + Utils.escapeHtml(f.value || '') + '</textarea>'
                        : '<input type="text" id="modal-field-' + i + '" value="' + Utils.escapeHtml(f.value || '') + '" placeholder="' + Utils.escapeHtml(f.placeholder || '') + '">'
                    ) + '</div>';
            } else if (f.type === 'select') {
                fieldsHtml += '<div class="field"><label class="field-label">' + Utils.escapeHtml(f.label) + '</label>' +
                    '<select id="modal-field-' + i + '">' +
                    (f.options || []).map(o => '<option value="' + Utils.escapeHtml(o.value) + '"' + (o.value === f.value ? ' selected' : '') + '>' + Utils.escapeHtml(o.label) + '</option>').join('') +
                    '</select></div>';
            }
        });
        modal.innerHTML =
            '<div class="modal-title">' + Utils.escapeHtml(title) + '</div>' +
            (desc ? '<div class="modal-desc">' + Utils.escapeHtml(desc) + '</div>' : '') +
            fieldsHtml +
            '<div class="modal-actions">' +
                '<button type="button" class="modal-btn" id="modal-cancel">Annuler</button>' +
                '<button type="button" class="modal-btn ' + (danger ? 'danger' : 'primary') + '" id="modal-confirm">' + Utils.escapeHtml(confirmLabel) + '</button>' +
            '</div>';
        backdrop.classList.add('visible');
        const close = () => backdrop.classList.remove('visible');
        document.getElementById('modal-cancel').addEventListener('click', close);
        document.getElementById('modal-confirm').addEventListener('click', () => {
            const values = fields.map((f, i) => {
                const el = document.getElementById('modal-field-' + i);
                return el ? el.value : null;
            });
            close();
            onConfirm(values);
        });
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    },
    applyTheme(theme) {
        document.body.classList.toggle('dark', theme === 'dark');
        document.querySelectorAll('[id^="theme-toggle"]').forEach(el => {
            el.classList.toggle('active', theme === 'dark');
        });
    },
    applySidebarState(collapsed) {
        const app = document.getElementById('app');
        if (!app) return;
        app.classList.toggle('sidebar-collapsed', collapsed);
        document.body.classList.toggle('sidebar-collapsed', collapsed);
    },
    applyAutoDownload(enabled) {
        document.querySelectorAll('[id^="autodownload-toggle"]').forEach(el => {
            el.classList.toggle('active', enabled);
        });
    }
};

/* CHAT SERVICE */
