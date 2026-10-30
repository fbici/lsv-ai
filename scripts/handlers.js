const Handlers = {
    async runImageGeneration() {
        if (Runtime.isRunning) return;
        Runtime.isRunning = true;
        Runtime.stopRequested = false;
        UI.updateButtons();
        await WakeLockService.ensure();
        const section = document.getElementById('image-results');
        const grid = document.getElementById('image-results-grid');
        section.classList.add('visible');
        UI.setStatus('Génération image…');
        const t0 = Date.now();
        try {
            const size = IMG_RES[UIState.imageSize][UIState.imageRatio];
            const prompt = PromptService.buildImage(UIState);
            const url = await ImageService.generate(prompt, size);
            const dt = (Date.now() - t0) / 1000;
            const asset = AssetService.add({
                type: 'image', url,
                name: 'Image · ' + (Utils.getStyleById(UIState.imageStyle) || {}).name,
                metadata: { size: Utils.clampSize(size), ratio: UIState.imageRatio, style: UIState.imageStyle, projectId: Runtime.currentProjectId }
            });
            if (Runtime.currentProjectId) ProjectService.addAsset(Runtime.currentProjectId, asset.id);
            const card = UI.createImageCard(url, size);
            grid.insertBefore(card, grid.firstChild);
            Runtime.imageCount++;
            this._saveCounters();
            document.getElementById('image-results-count').textContent = Runtime.imageCount;
            document.getElementById('sidebar-image-count').textContent = Runtime.imageCount;
            HistoryService.add('image.generate', 'Image générée');
            LSVAnalytics.track('image_generated', {
                model: CONFIG.MODEL_IMAGE, size: Utils.clampSize(size),
                ratio: UIState.imageRatio, style: UIState.imageStyle,
                mode: UIState.imageMode, source: 'main', duration_s: Math.round(dt)
            });
            /* Auto-téléchargement optionnel — IMAGES. Jusqu'ici ce réglage
               n'agissait que sur les vidéos, donc il ne se passait rien du
               tout pour une image. */
            if (StorageService.getAutoDownload()) {
                const fn = 'lsv-image-' + Date.now() + '.png';
                Utils.triggerDownload(url, fn).then(ok => {
                    DebugService.log(ok ? 'info' : 'warn', 'IMAGE',
                        ok ? 'Auto-téléchargement : ' + fn : 'Auto-téléchargement impossible (octets inaccessibles)');
                });
            }
            Dashboard.refresh();
            UI.showToast('Image générée', 'success');
            UI.setStatus(null);
        } catch (e) {
            DebugService.log('error', 'IMAGE', e.message);
            LSVAnalytics.track('generation_error', { feature: 'image', detail: e.message });
            UI.showToast(Utils.friendlyError(e), 'error', 4000);
            UI.setStatus('Erreur');
            await Utils.sleep(2500);
            UI.setStatus(null);
        }
        Runtime.isRunning = false;
        UI.updateButtons();
    },
    async runVideoGeneration() {
        if (Runtime.isRunning) return;
        Runtime.isRunning = true;
        Runtime.stopRequested = false;
        UI.updateButtons();
        await WakeLockService.ensure();
        const section = document.getElementById('video-results');
        const grid = document.getElementById('video-results-grid');
        const queue = document.getElementById('video-queue');
        const stopBtn = document.getElementById('video-stop');
        section.classList.add('visible');
        queue.classList.add('visible');
        stopBtn.classList.add('visible');
        const segments = UIState.videoSegments;
        const frames = UIState.videoFrames;
        UI.renderQueue('video-queue', segments);
        const startTime = Date.now();
        const videoUrls = [];
        let lastFrame = null;
        if (UIState.videoMode === 'image-to-video' && UIState.videoRefs[0]) lastFrame = UIState.videoRefs[0].dataUri;
        else if (UIState.videoMode === 'keyframes' && UIState.videoRefs.length >= 2) lastFrame = UIState.videoRefs[0].dataUri;
        try {
            for (let i = 0; i < segments; i++) {
                if (Runtime.stopRequested) throw new Error('Arrêt demandé');
                UI.updateQueueItem(i, 'processing', 'Préparation…');
                UI.setStatus('Segment ' + (i + 1) + '/' + segments);
                let endFrame = null;
                if (UIState.videoMode === 'keyframes' && i === 0 && UIState.videoRefs.length >= 2) endFrame = UIState.videoRefs[1].dataUri;
                const prompt = PromptService.buildVideo(UIState, i, segments);
                const videoId = await VideoService.createTask(lastFrame, endFrame, prompt, frames);
                const videoUrl = await VideoService.poll(videoId, frames, (prog) => {
                    UI.updateQueueItem(i, 'processing', prog);
                });
                videoUrls.push(videoUrl);
                UI.updateQueueItem(i, 'done', 'Terminé ✓');
                if (i < segments - 1) {
                    UI.updateQueueItem(i, 'processing', 'Extraction frame…');
                    try { lastFrame = await VideoService.extractLastFrame(videoUrl); } catch (e) { lastFrame = null; }
                    if (i > 0) {
                        const wait = CONFIG.VIDEO_INTERVAL_MIN;
                        for (let r = Math.ceil(wait / 1000); r > 0; r--) {
                            if (Runtime.stopRequested) break;
                            UI.setStatus('Pause — ' + r + 's');
                            await Utils.sleep(1000);
                        }
                    }
                }
            }
            const totalTime = (Date.now() - startTime) / 1000;
            TimingService.record('video', (totalTime / segments) * 1000);
            const asset = AssetService.add({
                type: 'video', url: videoUrls[0],
                name: 'Vidéo · ' + UIState.videoDuration + 's',
                metadata: { size: UIState.videoSize, ratio: UIState.videoRatio, style: UIState.videoStyle, duration: UIState.videoDuration, projectId: Runtime.currentProjectId }
            });
            if (Runtime.currentProjectId) ProjectService.addAsset(Runtime.currentProjectId, asset.id);
            const card = UI.createVideoCard(videoUrls);
            grid.insertBefore(card, grid.firstChild);
            Runtime.videoCount++;
            this._saveCounters();
            document.getElementById('video-results-count').textContent = Runtime.videoCount;
            document.getElementById('sidebar-video-count').textContent = Runtime.videoCount;
            HistoryService.add('video.generate', 'Vidéo générée (' + UIState.videoDuration + 's)');
            LSVAnalytics.track('video_generated', {
                model: CONFIG.MODEL_VIDEO, duration: UIState.videoDuration,
                mode: UIState.videoMode, segments: segments, frames: frames,
                ratio: UIState.videoRatio, size: UIState.videoSize,
                source: 'main', duration_s: Math.round(totalTime)
            });
            // Auto-téléchargement optionnel (vidéos)
            if (StorageService.getAutoDownload()) {
                videoUrls.forEach((url, idx) => {
                    const fn = 'lsv-video-' + Date.now() + '-seg' + (idx + 1) + '.mp4';
                    setTimeout(() => Utils.triggerDownload(url, fn).then(ok => {
                        DebugService.log(ok ? 'info' : 'warn', 'VIDÉO',
                            ok ? 'Auto-téléchargement : ' + fn : 'Auto-téléchargement impossible (octets inaccessibles)');
                    }), idx * 500);
                });
            }
            Dashboard.refresh();
            UI.showToast('Vidéo générée', 'success', 3500);
            UI.setStatus(null);
        } catch (e) {
            DebugService.log('error', 'VIDÉO', e.message);
            LSVAnalytics.track('generation_error', { feature: 'video', detail: e.message });
            /* Refus réel du fournisseur (503 file pleine) : le bandeau passe
               en « saturée » immédiatement, sans attendre une sonde. Le
               prompt et les images de référence ne sont PAS touchés — c'est
               ce qui permet de réessayer sans tout ressaisir. */
            if (e.code === 'video_queue_full') VideoAvailabilityService.markSaturated(120);
            UI.showToast(Utils.friendlyError(e), 'error', 4000);
            UI.setStatus('Erreur');
            await Utils.sleep(2500);
            UI.setStatus(null);
        }
        Runtime.isRunning = false;
        Runtime.stopRequested = false;
        stopBtn.classList.remove('visible');
        UI.updateButtons();
    },
    async handleImageUpload(files, arr, previewId, max = 6) {
        const list = Array.from(files).filter(f => f.type.startsWith('image/'));
        for (const file of list) {
            if (arr.length >= max) break;
            if (file.size > CONFIG.MAX_IMAGE_SIZE) { UI.showToast('Image trop lourde', 'warn'); continue; }
            try {
                const compressed = await FileService.compressImage(file);
                arr.push({ id: Date.now() + Math.random(), name: file.name, dataUri: compressed, preview: compressed });
            } catch (e) {}
        }
        UI.renderUploadPreview(arr, previewId);
        UI.updateButtons();
        this.renderRefLibrary();
    },
    /* Nombre d'images de référence autorisées pour le mode courant :
       1 pour Image→Vidéo, 2 pour Keyframes. */
    refLimit() { return UIState.videoMode === 'keyframes' ? 2 : 1; },
    /* Ajoute une création de la bibliothèque comme image de référence.
       On stocke l'URL telle quelle : c'est la passerelle qui la télécharge
       et l'encode, le navigateur ne pouvant pas (CORS). */
    addRefFromLibrary(assetId) {
        const asset = AssetService.get(assetId);
        if (!asset || asset.type !== 'image') return;
        const max = this.refLimit();
        if (UIState.videoRefs.some(r => r.assetId === asset.id)) {
            UI.showToast('Image déjà ajoutée', 'warn');
            return;
        }
        if (UIState.videoRefs.length >= max) {
            UI.showToast(max === 2 ? 'Deux images maximum (Keyframes)' : 'Une seule image pour Image→Vidéo', 'warn');
            return;
        }
        UIState.videoRefs.push({
            id: Date.now() + Math.random(),
            assetId: asset.id,
            source: 'library',
            name: asset.name,
            dataUri: asset.url,
            preview: asset.url
        });
        UI.renderUploadPreview(UIState.videoRefs, 'video-ref-preview');
        UI.updateButtons();
        this.renderRefLibrary();
    },
    renderRefLibrary() {
        const grid = document.getElementById('ref-library-grid');
        if (!grid) return;
        const items = AssetService.filter({ type: 'image' });
        if (!items.length) {
            grid.innerHTML = '<div class="ref-empty"><span class="ms">image_search</span>' +
                '<p>Aucune image dans ta bibliothèque.</p>' +
                '<p class="ref-empty-hint">Génère d\'abord une image sur l\'onglet Image : elle apparaîtra ici.</p></div>';
            return;
        }
        const chosen = UIState.videoRefs.map(r => r.assetId);
        grid.innerHTML = items.map(a => {
            const on = chosen.indexOf(a.id) >= 0;
            return '<button type="button" class="ref-lib-item' + (on ? ' is-selected' : '') + '"' +
                ' data-ref-pick="' + a.id + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
                '<img src="' + a.url + '" alt="" loading="lazy">' +
                '<span class="ref-lib-mark"><span class="ms">' + (on ? 'check_circle' : 'add_circle') + '</span></span>' +
                '<span class="ref-lib-name">' + Utils.escapeHtml(Utils.truncate(a.name, 28)) + '</span>' +
                '</button>';
        }).join('') +
        '<p class="ref-limit">' + UIState.videoRefs.length + ' / ' + this.refLimit() + ' image(s) utilisée(s)</p>';
        grid.querySelectorAll('[data-ref-pick]').forEach(btn => {
            btn.addEventListener('click', () => Handlers.addRefFromLibrary(btn.dataset.refPick));
        });
    },
    _saveCounters() {
        StorageService.setCounters({ image: Runtime.imageCount, video: Runtime.videoCount });
    },
    _loadCounters() {
        const c = StorageService.getCounters();
        Runtime.imageCount = c.image || 0;
        Runtime.videoCount = c.video || 0;
    },
    createNewProject() {
        UI.showModal({
            title: 'Nouveau projet',
            fields: [
                { type: 'text', label: 'Nom du projet', placeholder: 'Ex : Pub Lamborghini futuriste' },
                { type: 'select', label: 'Type', value: 'general', options: [
                    { value: 'general', label: 'Général' },
                    { value: 'pub', label: 'Publicité' },
                    { value: 'social', label: 'TikTok / Reel' },
                    { value: 'product', label: 'Produit' },
                    { value: 'storyboard', label: 'Storyboard' },
                    { value: 'character', label: 'Personnage' }
                ] }
            ],
            confirmLabel: 'Créer',
            onConfirm: (values) => {
                const name = (values[0] || '').trim();
                if (!name) { UI.showToast('Nom requis', 'warn'); return; }
                const p = ProjectService.create({ name, type: values[1] || 'general' });
                UI.switchTab('projects');
                ProjectsView.refresh();
                Dashboard.refresh();
                UI.showToast('Projet créé', 'success');
            }
        });
    },
    handleDashCreate() {
        const input = document.getElementById('dash-prompt');
        const idea = input.value.trim();
        if (!idea) { UI.showToast('Décris ton idée', 'warn'); return; }
        const p = ProjectService.create({
            name: Utils.truncate(idea, 50),
            description: idea,
            type: 'general'
        });
        Runtime.currentProjectId = p.id;
        input.value = '';
        UI.switchTab('chat');
        const chatInput = document.getElementById('chat-input');
        if (chatInput) chatInput.value = 'Voici mon idée : ' + idea + '\n\nPeux-tu la structurer en concept créatif complet ?';
        ChatView.renderContextChip();
        Dashboard.refresh();
        ProjectsView.refresh();
        RightPanel.refresh();
        UI.showToast('Projet créé · continue dans le chat', 'success');
    },
    resetAll() {
        UI.showModal({
            title: 'Réinitialiser tout le stockage ?',
            desc: 'Projets, ressources, conversations et locks seront supprimés.',
            confirmLabel: 'Tout supprimer',
            danger: true,
            onConfirm: () => {
                StorageService.resetAll();
                ProjectService._cache = null;
                AssetService._cache = null;
                HistoryService._cache = null;
                ConversationService._cache = null;
                LockService._cache = null;
                Runtime.imageCount = 0;
                Runtime.videoCount = 0;
                Runtime.currentProjectId = null;
                Runtime.currentConversationId = null;
                document.getElementById('sidebar-image-count').textContent = '0';
                document.getElementById('sidebar-video-count').textContent = '0';
                AdvancedView.refresh();
                Dashboard.refresh();
                ProjectsView.refresh();
                LibraryView.refresh();
                HistoryView.refresh();
                ChatView.refresh();
                RightPanel.refresh();
                LocksView.refresh();
                UI.showToast('Stockage réinitialisé', 'warn');
            }
        });
    },
    toggleTheme() {
        const current = StorageService.getTheme();
        const next = current === 'dark' ? 'light' : 'dark';
        StorageService.setTheme(next);
        UI.applyTheme(next);
        UI.showToast(next === 'dark' ? 'Mode sombre activé' : 'Mode clair activé', 'success', 1500);
    },
    toggleAutoDownload() {
        const current = StorageService.getAutoDownload();
        const next = !current;
        StorageService.setAutoDownload(next);
        UI.applyAutoDownload(next);
        UI.showToast(next ? 'Auto-téléchargement activé' : 'Auto-téléchargement désactivé', next ? 'success' : 'warn', 2000);
    },
    /* Téléchargement demandé par un bouton (carte de résultat ou
       bibliothèque). Si les octets sont inaccessibles (CORS côté CDN du
       fournisseur), on n'ouvre JAMAIS un onglet : on montre l'aperçu et on
       explique, au lieu de perdre l'application sur une page distante. */
    downloadAsset(url, name) {
        if (!url) return;
        const isVideo = /\.mp4(\?|$)/i.test(url);
        Utils.triggerDownload(url, name || 'lsv-fichier').then(ok => {
            if (ok) { UI.showToast('Téléchargement démarré', 'success', 2500); return; }
            UI.openPreview(url, '', isVideo ? 'video' : 'image');
            UI.showToast('Téléchargement direct impossible : clic droit sur l\'aperçu puis « Enregistrer sous… ».', 'error', 6000);
        });
    },
    toggleSidebar() {
        const current = StorageService.getSidebarCollapsed();
        const next = !current;
        StorageService.setSidebarCollapsed(next);
        UI.applySidebarState(next);
    }
};

/* ═══ RESTAURATION DES RÉSULTATS AU DÉMARRAGE ═══ */
function restoreResultsFromLibrary() {
    const assets = AssetService.all();

    const imageAssets = assets.filter(a => a.type === 'image');
    if (imageAssets.length > 0) {
        const section = document.getElementById('image-results');
        const grid = document.getElementById('image-results-grid');
        if (section && grid) {
            section.classList.add('visible');
            grid.innerHTML = '';
            imageAssets.forEach(asset => {
                const card = document.createElement('div');
                card.className = 'result-card';
                const style = Utils.getStyleById(asset.metadata.style) || { name: 'Image' };
                const safe = Utils.escapeHtml(asset.url);
                card.innerHTML =
                    '<div class="result-media" data-preview="' + safe + '" data-preview-type="image" title="Aperçu"><img src="' + safe + '" alt="" loading="lazy"></div>' +
                    '<div class="result-meta">' +
                        '<div class="res-name">' + Utils.escapeHtml(style.name) + '</div>' +
                        '<div class="res-details">' + Utils.escapeHtml(asset.metadata.size || '') + '</div>' +
                    '</div>' +
                    '<div class="result-actions">' +
                        '<button type="button" class="res-action" data-preview="' + safe + '" data-preview-type="image"><span class="ms">zoom_in</span> Ouvrir</button>' +
                        '<button type="button" class="res-action" data-download="' + safe + '" data-download-name="lsv-' + asset.id + '.png"><span class="ms">download</span> Télécharger</button>' +
                    '</div>';
                grid.appendChild(card);
            });
            const countEl = document.getElementById('image-results-count');
            if (countEl) countEl.textContent = imageAssets.length;
        }
    }

    const videoAssets = assets.filter(a => a.type === 'video');
    if (videoAssets.length > 0) {
        const section = document.getElementById('video-results');
        const grid = document.getElementById('video-results-grid');
        if (section && grid) {
            section.classList.add('visible');
            grid.innerHTML = '';
            videoAssets.forEach(asset => {
                const card = document.createElement('div');
                card.className = 'result-card';
                const style = Utils.getStyleById(asset.metadata.style) || { name: 'Vidéo' };
                const safe = Utils.escapeHtml(asset.url);
                card.innerHTML =
                    '<div class="result-media"><video src="' + safe + '" controls playsinline preload="metadata"></video></div>' +
                    '<div class="result-meta">' +
                        '<div class="res-name">' + Utils.escapeHtml(style.name) + '</div>' +
                        '<div class="res-details">' + Utils.escapeHtml((asset.metadata.duration || '') + 's') + '</div>' +
                    '</div>' +
                    '<div class="result-actions">' +
                        '<button type="button" class="res-action" data-preview="' + safe + '" data-preview-type="video"><span class="ms">zoom_in</span> Ouvrir</button>' +
                        '<button type="button" class="res-action" data-download="' + safe + '" data-download-name="lsv-' + asset.id + '.mp4"><span class="ms">download</span> Télécharger</button>' +
                    '</div>';
                grid.appendChild(card);
            });
            const countEl = document.getElementById('video-results-count');
            if (countEl) countEl.textContent = videoAssets.length;
        }
    }
}

/* INIT */
function init() {
    DebugService.init();
    /* Compte connecté (éventuel) : les clés de données créatives doivent
       être résolues AVANT toute lecture (compteurs, projets, bibliothèque). */
    StorageService.setOwner(AccountService.userId());
    Handlers._loadCounters();
    UI.applyTheme(StorageService.getTheme());
    UI.applySidebarState(StorageService.getSidebarCollapsed());
    UI.applyAutoDownload(StorageService.getAutoDownload());
    /* Affiche DÉJÀ le dernier état connu du service vidéo (sans sonde) :
       l'onglet Vidéo n'affiche donc jamais un écran vide en ouvrant. */
    VideoAvailabilityService.render();
    VideoAlternatives.render();
    /* Sélecteur de modèle du chat + état des fournisseurs configurés
       (grise une option sans clé, sans jamais parler de « panne »). */
    ChatService.init();

    /* Délégation UNIQUE : les cartes de résultat sont reconstruites à chaque
       rafraîchissement, un écouteur posé élément par élément serait donc
       perdu. Un seul écouteur sur le document suffit, pour l'aperçu comme
       pour le téléchargement. */
    document.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('#preview-close')) { e.preventDefault(); UI.closePreview(); return; }
        if (t.closest('#preview-save')) { e.preventDefault(); UI.savePreview(); return; }
        if (t.id === 'preview-backdrop') { UI.closePreview(); return; }
        const dl = t.closest('[data-download]');
        if (dl) {
            e.preventDefault();
            Handlers.downloadAsset(dl.getAttribute('data-download'), dl.getAttribute('data-download-name'));
            return;
        }
        const pv = t.closest('[data-preview]');
        if (pv) {
            e.preventDefault();
            UI.openPreview(pv.getAttribute('data-preview'), '', pv.getAttribute('data-preview-type'));
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e && e.key === 'Escape') UI.closePreview();
    });

    document.querySelectorAll('.nav-item').forEach(t => {
        t.addEventListener('click', () => UI.switchTab(t.dataset.tab));
    });
    document.querySelectorAll('.nav-mob').forEach(t => {
        t.addEventListener('click', () => UI.switchTab(t.dataset.tab));
    });
    document.getElementById('mobile-settings').addEventListener('click', () => UI.toggleSettingsPanel());

    document.getElementById('sidebar-toggle').addEventListener('click', () => Handlers.toggleSidebar());

    // Toggles thème et autodownload (panneau + avancé)
    document.getElementById('theme-toggle-panel').addEventListener('click', () => Handlers.toggleTheme());
    document.getElementById('autodownload-toggle-panel').addEventListener('click', () => Handlers.toggleAutoDownload());
    document.getElementById('autodownload-toggle-advanced').addEventListener('click', () => Handlers.toggleAutoDownload());

    // CHAT
    document.getElementById('chat-new-btn').addEventListener('click', () => ChatView.newConversation());
    const chatInput = document.getElementById('chat-input');
    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px';
        UI.updateButtons();
    });
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ChatView.sendMessage(); }
    });
    document.getElementById('chat-send').addEventListener('click', () => ChatView.sendMessage());

    // DASHBOARD
    document.getElementById('dash-create').addEventListener('click', () => Handlers.handleDashCreate());
    document.getElementById('dash-prompt').addEventListener('keydown', e => { if (e.key === 'Enter') Handlers.handleDashCreate(); });
    document.getElementById('dash-view-all-projects').addEventListener('click', () => UI.switchTab('projects'));
    document.querySelectorAll('[data-quick]').forEach(el => {
        el.addEventListener('click', () => {
            const q = el.dataset.quick;
            if (q === 'chat') UI.switchTab('chat');
            else if (q === 'image' || q === 'video') UI.switchTab(q);
            else if (q === 'enhancer') UI.switchTab('enhancer');
            else if (q === 'storyboard') UI.switchTab('storyboard');
            else if (q === 'workflow') UI.switchTab('workflows');
        });
    });

    // IMAGE
    document.querySelectorAll('#image-mode-grid .mode-tile').forEach(t => {
        t.addEventListener('click', () => {
            document.querySelectorAll('#image-mode-grid .mode-tile').forEach(x => x.classList.remove('selected'));
            t.classList.add('selected');
            UIState.imageMode = t.dataset.mode;
            const refCard = document.getElementById('image-ref-card');
            if (UIState.imageMode === 'prompt-only') refCard.classList.add('hidden');
            else refCard.classList.remove('hidden');
            UI.updateButtons();
        });
    });
    document.getElementById('image-prompt').addEventListener('input', e => {
        UIState.imagePrompt = e.target.value;
        UI.updateButtons();
    });
    document.getElementById('image-ref-input').addEventListener('change', e => {
        Handlers.handleImageUpload(e.target.files, UIState.imageRefs, 'image-ref-preview', 4);
        e.target.value = '';
    });
    UI.renderStyleGrid('image-style-grid', UIState.imageStyle, id => { UIState.imageStyle = id; });
    document.getElementById('image-size').addEventListener('change', e => { UIState.imageSize = e.target.value; });
    UI.renderRatioGrid('image-ratio', UIState.imageRatio, id => { UIState.imageRatio = id; });
    document.getElementById('image-generate').addEventListener('click', () => Handlers.runImageGeneration());

    // VIDEO
    document.querySelectorAll('#video-mode-grid .mode-tile').forEach(t => {
        t.addEventListener('click', () => {
            document.querySelectorAll('#video-mode-grid .mode-tile').forEach(x => x.classList.remove('selected'));
            t.classList.add('selected');
            UIState.videoMode = t.dataset.mode;
            const refCard = document.getElementById('video-ref-card');
            const motionCard = document.getElementById('video-motion-card');
            if (UIState.videoMode === 'text-to-video') { refCard.classList.add('hidden'); motionCard.classList.add('hidden'); }
            else if (UIState.videoMode === 'image-to-video') { refCard.classList.remove('hidden'); motionCard.classList.remove('hidden'); }
            else { refCard.classList.remove('hidden'); motionCard.classList.add('hidden'); }
            /* Le maximum d'images dépend du mode : le sélecteur de la
               bibliothèque doit s'y conformer tout de suite. */
            if (UIState.videoRefs.length > Handlers.refLimit()) {
                UIState.videoRefs.splice(Handlers.refLimit());
                UI.renderUploadPreview(UIState.videoRefs, 'video-ref-preview');
            }
            Handlers.renderRefLibrary();
            UI.updateButtons();
        });
    });
    document.getElementById('video-prompt').addEventListener('input', e => {
        UIState.videoPrompt = e.target.value;
        UI.updateButtons();
    });
    document.getElementById('video-ref-input').addEventListener('change', e => {
        Handlers.handleImageUpload(e.target.files, UIState.videoRefs, 'video-ref-preview', Handlers.refLimit());
        e.target.value = '';
    });
    /* Bascule entre le fichier local et la bibliothèque de créations. */
    document.querySelectorAll('#ref-tabs .ref-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#ref-tabs .ref-tab').forEach(x => {
                x.classList.remove('is-selected');
                x.setAttribute('aria-selected', 'false');
            });
            tab.classList.add('is-selected');
            tab.setAttribute('aria-selected', 'true');
            const device = document.getElementById('ref-zone-device');
            const library = document.getElementById('ref-zone-library');
            if (tab.dataset.refSource === 'library') {
                device.classList.add('hidden');
                library.classList.remove('hidden');
                Handlers.renderRefLibrary();
            } else {
                library.classList.add('hidden');
                device.classList.remove('hidden');
            }
        });
    });
    document.querySelectorAll('#motion-camera-grid .motion-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#motion-camera-grid .motion-chip').forEach(c => c.classList.remove('selected'));
            chip.classList.add('selected');
            UIState.videoMotionCamera = chip.dataset.motion;
        });
    });
    document.querySelectorAll('#motion-intensity-grid .motion-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#motion-intensity-grid .motion-chip').forEach(c => c.classList.remove('selected'));
            chip.classList.add('selected');
            UIState.videoMotionIntensity = chip.dataset.intensity;
        });
    });
    UI.renderStyleGrid('video-style-grid', UIState.videoStyle, id => { UIState.videoStyle = id; });
    document.getElementById('video-size').addEventListener('change', e => { UIState.videoSize = e.target.value; });
    UI.renderRatioGrid('video-ratio', UIState.videoRatio, id => { UIState.videoRatio = id; },
        ['9:16', '16:9', '1:1']);   // la vidéo ne propose que ces trois formats
    document.querySelectorAll('#video-duration-grid .mode-tile').forEach(t => {
        t.addEventListener('click', () => {
            document.querySelectorAll('#video-duration-grid .mode-tile').forEach(x => x.classList.remove('selected'));
            t.classList.add('selected');
            UIState.videoFrames = parseInt(t.dataset.frames, 10);
            UIState.videoDuration = parseInt(t.dataset.duration, 10);
            UIState.videoSegments = parseInt(t.dataset.segments || '1', 10);
            UI.updateDurationInfo();
        });
    });
    document.getElementById('video-generate').addEventListener('click', () => Handlers.runVideoGeneration());
    document.getElementById('video-stop').addEventListener('click', () => {
        Runtime.stopRequested = true;
        UI.setStatus('Arrêt en cours…');
    });

    // ENHANCER
    EnhancerView.bind();

    // STUDIO DE SCÉNARIOS + AMÉLIORATION DE PROMPT
    ScenarioView.bind();
    ImproveView.bind();

    // PROJECTS
    document.getElementById('new-project-btn').addEventListener('click', () => Handlers.createNewProject());

    // LIBRARY
    document.getElementById('lib-search').addEventListener('input', e => {
        UIState.librarySearch = e.target.value;
        LibraryView.refresh();
    });
    document.querySelectorAll('.lib-filter').forEach(f => {
        f.addEventListener('click', () => {
            document.querySelectorAll('.lib-filter').forEach(x => x.classList.remove('active'));
            f.classList.add('active');
            UIState.libraryFilter = f.dataset.filter;
            LibraryView.refresh();
        });
    });

    // STORYBOARD
    document.getElementById('storyboard-new').addEventListener('click', () => Handlers.createNewProject());
    document.getElementById('storyboard-add-scene').addEventListener('click', () => StoryboardView.addScene());

    // WORKFLOWS, LOCKS, BATCH
    WorkflowsView.refresh();
    LocksView.refresh();
    BatchView.refresh();

    // ADVANCED
    document.getElementById('reset-all-btn').addEventListener('click', () => Handlers.resetAll());

    WakeLockService.enableFromStorage();

    UI.updateDurationInfo();
    UI.updateButtons();
    Dashboard.refresh();
    ChatView.refresh();
    ProjectsView.refresh();
    LibraryView.refresh();
    HistoryView.refresh();
    AdvancedView.refresh();
    RightPanel.refresh();
    AccountView.init();
    WelcomeView.init();

    // Restaurer les résultats depuis la bibliothèque
    restoreResultsFromLibrary();

    document.getElementById('sidebar-image-count').textContent = Runtime.imageCount;
    document.getElementById('sidebar-video-count').textContent = Runtime.videoCount;

    DebugService.log('success', 'INIT', '◈ LSV.ai — Le Studio Viral prêt');
    DebugService.log('info', 'INIT', 'Thème : ' + StorageService.getTheme());
    if (!CONFIG.GATEWAY_READY) DebugService.log('warn', 'GATEWAY', 'LSV_GATEWAY_URL non configurée : génération désactivée');
    DebugService.log('info', 'INIT', 'Sidebar : ' + (StorageService.getSidebarCollapsed() ? 'réduite' : 'déployée'));
    DebugService.log('info', 'INIT', 'Auto-download : ' + (StorageService.getAutoDownload() ? 'activé' : 'désactivé'));
    DebugService.log('info', 'INIT', 'Résultats restaurés depuis la bibliothèque');
}

window.LSV = {
    config: CONFIG,
    runtime: Runtime,
    uiState: UIState,
    ui: UI,
    /* Centres de ressources affichés dans l'onglet Vidéo (liens externes). */
    alternatives: VIDEO_ALTERNATIVES,
    altChecked: ALT_CHECKED,
    services: {
        storage: StorageService,
        projects: ProjectService,
        assets: AssetService,
        history: HistoryService,
        conversations: ConversationService,
        chat: ChatService,
        locks: LockService,
        enhancer: EnhancerService,
        scenarios: ScenarioService,
        promptImprove: PromptImproveService,
        debug: DebugService,
        timing: TimingService,
        wakelock: WakeLockService,
        account: AccountService,
        quota: QuotaService,
        gateway: Gateway,
        agnes: AgnesProvider,
        image: ImageService,
        video: VideoService,
        availability: VideoAvailabilityService,
        file: FileService,
        prompt: PromptService
    },
    handlers: Handlers,
    views: {
        dashboard: Dashboard,
        chat: ChatView,
        projects: ProjectsView,
        library: LibraryView,
        history: HistoryView,
        advanced: AdvancedView,
        rightPanel: RightPanel,
        enhancer: EnhancerView,
        scenarios: ScenarioView,
        improve: ImproveView,
        storyboard: StoryboardView,
        workflows: WorkflowsView,
        locks: LocksView,
        batch: BatchView
    },
    actions: ChatActions,
    utils: Utils
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
