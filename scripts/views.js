const Dashboard = {
    refresh() {
        const projects = ProjectService.all();
        const assets = AssetService.all();
        document.getElementById('dash-stat-projects').textContent = projects.length;
        document.getElementById('dash-stat-images').textContent = assets.filter(a => a.type === 'image').length;
        document.getElementById('dash-stat-videos').textContent = assets.filter(a => a.type === 'video').length;
        document.getElementById('dash-stat-convs').textContent = ConversationService.count();
        document.getElementById('nav-projects-count').textContent = projects.length;
        document.getElementById('nav-library-count').textContent = assets.length;
        const container = document.getElementById('dash-recent-projects');
        if (!projects.length) {
            container.innerHTML = '<div class="empty-state">' +
                '<span class="ms">folder_open</span>' +
                '<div class="empty-state-title">Aucun projet pour l\'instant</div>' +
                '<div class="empty-state-desc">Crée ton premier projet ou demande au Chat IA de structurer ton idée.</div>' +
            '</div>';
        } else {
            const recent = projects.slice(0, 4);
            container.innerHTML = '<div class="projects-grid">' + recent.map(p => this._card(p)).join('') + '</div>';
            container.querySelectorAll('[data-project-open]').forEach(el => {
                el.addEventListener('click', () => ProjectsView.openProject(el.dataset.projectOpen));
            });
        }
    },
    _card(p) {
        return '<div class="project-card" data-project-open="' + p.id + '">' +
            '<div class="project-card-thumb"><span class="ms">folder</span>' +
                '<span class="project-card-type">' + Utils.escapeHtml(p.type) + '</span></div>' +
            '<div class="project-card-name">' + Utils.escapeHtml(p.name) + '</div>' +
            '<div class="project-card-meta">' +
                '<span>' + (p.scenes || []).length + ' scènes</span>' +
                '<span class="meta-dot"></span>' +
                '<span>' + (p.assets || []).length + ' ressources</span>' +
            '</div>' +
        '</div>';
    }
};

const ProjectsView = {
    refresh() {
        const container = document.getElementById('projects-list');
        const projects = ProjectService.all();
        if (!projects.length) {
            container.innerHTML = '<div class="empty-state">' +
                '<span class="ms">folder_open</span>' +
                '<div class="empty-state-title">Aucun projet</div>' +
                '<div class="empty-state-desc">Les projets regroupent tes scènes, prompts, ressources et versions.</div>' +
            '</div>';
            return;
        }
        container.innerHTML = '<div class="projects-grid">' + projects.map(p => this._card(p)).join('') + '</div>';
        container.querySelectorAll('[data-project-open]').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.project-action-btn')) return;
                this.openProject(el.dataset.projectOpen);
            });
        });
        container.querySelectorAll('[data-project-delete]').forEach(el => {
            el.addEventListener('click', (e) => { e.stopPropagation(); this._confirmDelete(el.dataset.projectDelete); });
        });
        container.querySelectorAll('[data-project-duplicate]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                ProjectService.duplicate(el.dataset.projectDuplicate);
                this.refresh();
                Dashboard.refresh();
            });
        });
    },
    _card(p) {
        const isActive = p.id === Runtime.currentProjectId;
        return '<div class="project-card" data-project-open="' + p.id + '"' + (isActive ? ' style="border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-light);"' : '') + '>' +
            '<div class="project-card-thumb"><span class="ms">folder</span>' +
                '<span class="project-card-type">' + Utils.escapeHtml(p.type) + '</span></div>' +
            '<div class="project-card-actions">' +
                '<button class="project-action-btn" data-project-duplicate="' + p.id + '"><span class="ms">content_copy</span></button>' +
                '<button class="project-action-btn delete" data-project-delete="' + p.id + '"><span class="ms">delete</span></button>' +
            '</div>' +
            '<div class="project-card-name">' + Utils.escapeHtml(p.name) + (isActive ? ' · actif' : '') + '</div>' +
            '<div class="project-card-meta">' +
                '<span>' + (p.scenes || []).length + ' scènes</span>' +
                '<span class="meta-dot"></span>' +
                '<span>' + (p.assets || []).length + ' ressources</span>' +
            '</div>' +
        '</div>';
    },
    openProject(id) {
        const p = ProjectService.get(id);
        if (!p) return;
        Runtime.currentProjectId = id;
        UI.showToast('Projet ouvert : ' + p.name, 'success');
        this.refresh();
        RightPanel.refresh();
        ChatView.renderContextChip();
        Dashboard.refresh();
    },
    _confirmDelete(id) {
        const p = ProjectService.get(id);
        if (!p) return;
        UI.showModal({
            title: 'Supprimer ce projet ?',
            desc: '« ' + p.name + ' » sera définitivement supprimé.',
            confirmLabel: 'Supprimer',
            danger: true,
            onConfirm: () => {
                if (Runtime.currentProjectId === id) Runtime.currentProjectId = null;
                ProjectService.delete(id);
                this.refresh();
                Dashboard.refresh();
                RightPanel.refresh();
                ChatView.renderContextChip();
            }
        });
    }
};

const LibraryView = {
    refresh() {
        const list = AssetService.filter({ type: UIState.libraryFilter, search: UIState.librarySearch });
        const container = document.getElementById('library-content');
        if (!list.length) {
            container.innerHTML = '<div class="empty-state">' +
                '<span class="ms">collections</span>' +
                '<div class="empty-state-title">Bibliothèque vide</div>' +
                '<div class="empty-state-desc">Les images et vidéos générées apparaîtront ici automatiquement.</div>' +
            '</div>';
            return;
        }
        container.innerHTML = '<div class="library-grid">' + list.map(a => this._item(a)).join('') + '</div>';
        container.querySelectorAll('[data-asset-delete]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                AssetService.delete(el.dataset.assetDelete);
                this.refresh();
                Dashboard.refresh();
            });
        });
        container.querySelectorAll('[data-asset-download]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const a = AssetService.get(el.dataset.assetDownload);
                if (!a) return;
                Handlers.downloadAsset(a.url, 'lsv-' + a.id + (a.type === 'video' ? '.mp4' : '.png'));
            });
        });
    },
    _item(a) {
        const isVideo = a.type === 'video';
        /* La vignette est cliquable : elle ouvre l'aperçu sur cette page.
           Auparavant, seul un bouton de téléchargement existait — et il
           ouvrait l'URL distante dans un nouvel onglet. */
        const safe = Utils.escapeHtml(a.url);
        return '<div class="lib-item">' +
            '<div class="lib-item-media" data-preview="' + safe + '" data-preview-type="' + a.type + '" title="Aperçu">' +
                (isVideo ? '<video src="' + safe + '" muted playsinline preload="metadata"></video>' : '<img src="' + safe + '" alt="" loading="lazy">') +
                '<span class="lib-item-badge ' + (isVideo ? 'video' : '') + '">' + a.type + '</span>' +
                '<div class="lib-item-actions">' +
                    '<button type="button" class="project-action-btn" data-asset-download="' + a.id + '"><span class="ms">download</span></button>' +
                    '<button type="button" class="project-action-btn delete" data-asset-delete="' + a.id + '"><span class="ms">delete</span></button>' +
                '</div>' +
            '</div>' +
            '<div class="lib-item-meta">' +
                '<div class="lib-name">' + Utils.escapeHtml(Utils.truncate(a.name, 30)) + '</div>' +
                '<div class="lib-info">' + Utils.formatDate(a.createdAt) + '</div>' +
            '</div>' +
        '</div>';
    }
};

const HistoryView = {
    refresh() {
        const list = HistoryService.all();
        const container = document.getElementById('history-content');
        if (!list.length) {
            container.innerHTML = '<div class="empty-state">' +
                '<span class="ms">history</span>' +
                '<div class="empty-state-title">Aucune activité</div>' +
                '<div class="empty-state-desc">Tes générations et actions apparaîtront ici.</div>' +
            '</div>';
            return;
        }
        container.innerHTML = '<div class="history-list">' + list.map(h => this._item(h)).join('') + '</div>';
    },
    _item(h) {
        let icon = 'info';
        if (h.type.startsWith('image')) icon = 'image';
        else if (h.type.startsWith('video')) icon = 'movie';
        else if (h.type.startsWith('project.create')) icon = 'folder';
        else if (h.type.startsWith('project')) icon = 'edit';
        else if (h.type.startsWith('lock')) icon = 'lock';
        else if (h.type.startsWith('batch')) icon = 'burst_mode';
        else if (h.type.startsWith('chat')) icon = 'forum';
        return '<div class="history-item">' +
            '<div class="history-icon"><span class="ms">' + icon + '</span></div>' +
            '<div class="history-body">' +
                '<div class="history-title">' + Utils.escapeHtml(h.message) + '</div>' +
                '<div class="history-subtitle">' + Utils.escapeHtml(h.type) + '</div>' +
            '</div>' +
            '<div class="history-time">' + Utils.formatDate(h.at) + '</div>' +
        '</div>';
    }
};

const AdvancedView = {
    refresh() {
        document.getElementById('adv-storage-projects').textContent = ProjectService.count();
        document.getElementById('adv-storage-assets').textContent = AssetService.count();
        document.getElementById('adv-storage-convs').textContent = ConversationService.count();
        document.getElementById('adv-storage-locks').textContent = LockService.count();
        document.getElementById('adv-storage-size').textContent = Utils.formatBytes(StorageService.estimateStorageSize());
        UI.applyAutoDownload(StorageService.getAutoDownload());
    }
};

const RightPanel = {
    refresh() {
        const container = document.getElementById('rp-project-content');
        if (!Runtime.currentProjectId) {
            container.innerHTML = '<div style="font-size:0.75rem;color:var(--ink-3);text-align:center;padding:0.8rem 0;">Aucun projet ouvert</div>';
            return;
        }
        const p = ProjectService.get(Runtime.currentProjectId);
        if (!p) { container.innerHTML = ''; return; }
        container.innerHTML =
            '<div class="rp-project-card">' +
                '<span class="ms">folder</span>' +
                '<div class="rp-project-info">' +
                    '<div class="rp-project-name">' + Utils.escapeHtml(p.name) + '</div>' +
                    '<div class="rp-project-meta">' + p.type + ' · ' + (p.scenes || []).length + ' scènes</div>' +
                '</div>' +
            '</div>' +
            '<button type="button" class="rp-btn" id="rp-open-chat" style="margin-bottom:0.4rem;">Discuter dans ce contexte</button>' +
            '<button type="button" class="rp-btn" id="rp-open-storyboard" style="margin-bottom:0.4rem;background:var(--blue);">Éditer le storyboard</button>' +
            '<button type="button" class="rp-btn" id="rp-close-project" style="background:var(--bg-3);color:var(--ink-2);">Fermer le projet</button>';
        document.getElementById('rp-open-chat').addEventListener('click', () => UI.switchTab('chat'));
        document.getElementById('rp-open-storyboard').addEventListener('click', () => UI.switchTab('storyboard'));
        document.getElementById('rp-close-project').addEventListener('click', () => {
            Runtime.currentProjectId = null;
            this.refresh();
            ChatView.renderContextChip();
            ProjectsView.refresh();
            UI.showToast('Projet fermé', 'warn');
        });
    }
};

const EnhancerView = {
    _lastResult: null,
    bind() {
        document.getElementById('enhancer-input').addEventListener('input', () => UI.updateButtons());
        document.getElementById('enhancer-generate').addEventListener('click', () => this.generate());
        document.getElementById('enhancer-copy').addEventListener('click', () => {
            if (!this._lastResult) return;
            const text = this._lastResult.full_prompt || '';
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => UI.showToast('Copié ✓', 'success'));
            } else {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                UI.showToast('Copié ✓', 'success');
            }
        });
        document.getElementById('enhancer-use-image').addEventListener('click', () => {
            if (!this._lastResult) return;
            const p = this._lastResult.full_prompt || '';
            UIState.imagePrompt = p;
            document.getElementById('image-prompt').value = p;
            UI.switchTab('image');
            UI.updateButtons();
            UI.showToast('Utilisé pour image', 'success');
        });
        document.getElementById('enhancer-use-video').addEventListener('click', () => {
            if (!this._lastResult) return;
            const p = this._lastResult.full_prompt || '';
            UIState.videoPrompt = p;
            document.getElementById('video-prompt').value = p;
            UI.switchTab('video');
            UI.updateButtons();
            UI.showToast('Utilisé pour vidéo', 'success');
        });
    },
    async generate() {
        const idea = document.getElementById('enhancer-input').value.trim();
        if (!idea) return;
        const type = document.getElementById('enhancer-type').value;
        const style = document.getElementById('enhancer-style').value;
        const btn = document.getElementById('enhancer-generate');
        btn.disabled = true;
        btn.innerHTML = '<span class="ms">hourglass_top</span> Analyse en cours…';
        UI.setStatus('Enhancer en cours…');
        try {
            const result = await EnhancerService.enhance(idea, type, style);
            if (!result) throw new Error('Parsing échoué');
            this._lastResult = result;
            this._render(result);
            UI.showToast('Prompt structuré ✓', 'success');
            HistoryService.add('enhancer.generate', 'Prompt amélioré');
            LSVAnalytics.track('enhancer_used', { status: 'success', type: type, style: style });
        } catch (e) {
            DebugService.log('error', 'ENHANCER', e.message);
            LSVAnalytics.track('enhancer_used', { status: 'error', type: type, style: style });
            UI.showToast(Utils.friendlyError(e), 'error', 4000);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span class="ms">auto_fix_high</span> Améliorer le prompt';
            UI.setStatus(null);
        }
    },
    _render(r) {
        const out = document.getElementById('enhancer-output');
        const sections = document.getElementById('enhancer-sections');
        const full = document.getElementById('enhancer-full');
        const labels = {
            subject: 'Sujet', environment: 'Environnement', lighting: 'Lumière',
            camera: 'Caméra', composition: 'Composition', motion: 'Mouvement',
            style: 'Style', constraints: 'Contraintes'
        };
        let html = '';
        for (const key in labels) {
            if (r[key]) {
                html += '<div class="enhancer-section">' +
                    '<div class="enhancer-section-label">' + labels[key] + '</div>' +
                    '<div class="enhancer-section-value">' + Utils.escapeHtml(r[key]) + '</div>' +
                '</div>';
            }
        }
        sections.innerHTML = html;
        full.textContent = r.full_prompt || '';
        out.classList.add('visible');
    }
};

/* STUDIO DE SCÉNARIOS IA : un mode → une consigne, un JSON → des scènes
   éditables dans le Storyboard. Aucun texte n'est interprété à la volée :
   tout ce qui s'affiche vient des champs normalisés par ScenarioService. */
const ScenarioView = {
    mode: 'court',
    _last: null,
    bind() {
        document.getElementById('scenario-input').addEventListener('input', () => UI.updateButtons());
        document.querySelectorAll('#scenario-mode-grid .mode-tile').forEach(t => {
            t.addEventListener('click', () => {
                document.querySelectorAll('#scenario-mode-grid .mode-tile').forEach(x => x.classList.remove('selected'));
                t.classList.add('selected');
                this.mode = t.dataset.mode;
                const mode = SCENARIO_MODES.find(m => m.id === this.mode);
                if (mode) document.getElementById('scenario-mode-label').textContent = mode.name;
            });
        });
        document.getElementById('scenario-generate').addEventListener('click', () => this.generate());
        document.getElementById('scenario-copy').addEventListener('click', () => this._copy());
        document.getElementById('scenario-to-storyboard').addEventListener('click', () => this.toStoryboard());
    },
    async generate() {
        const idea = document.getElementById('scenario-input').value.trim();
        if (!idea) return;
        const btn = document.getElementById('scenario-generate');
        btn.disabled = true;
        btn.innerHTML = '<span class="ms">hourglass_top</span> Écriture en cours…';
        UI.setStatus('Scénario en cours…');
        try {
            const scenario = await ScenarioService.generate(idea, this.mode);
            this._last = scenario;
            this._render(scenario);
            UI.showToast('Scénario prêt ✓', 'success');
            HistoryService.add('scenario.generate', scenario.title + ' · ' + scenario.scenes.length + ' scènes');
            LSVAnalytics.track('scenario_generated', { status: 'success', mode: this.mode, scenes: scenario.scenes.length });
        } catch (e) {
            DebugService.log('error', 'SCENARIO', e.message);
            LSVAnalytics.track('scenario_generated', { status: 'error', mode: this.mode });
            UI.showToast(Utils.friendlyError(e), 'error', 4000);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span class="ms">auto_awesome</span> Générer le scénario';
            UI.setStatus(null);
            UI.updateButtons();
        }
    },
    _render(s) {
        const mode = SCENARIO_MODES.find(m => m.id === s.format) || SCENARIO_MODES[0];
        document.getElementById('scenario-out-title').textContent = s.title;
        document.getElementById('scenario-mode-label').textContent = mode.name;
        document.getElementById('scenario-logline').textContent = s.logline || '';
        document.getElementById('scenario-scenes').innerHTML = s.scenes.map(sc =>
            '<div class="scenario-scene">' +
                '<div class="scenario-scene-head">' +
                    '<div class="scenario-scene-num">' + sc.number + '</div>' +
                    '<div class="scenario-scene-title">' + Utils.escapeHtml(sc.title) + '</div>' +
                    (sc.act ? '<span class="scenario-act">' + Utils.escapeHtml(sc.act) + '</span>' : '') +
                '</div>' +
                (sc.description ? '<div class="scenario-scene-desc">' + Utils.escapeHtml(sc.description) + '</div>' : '') +
                (sc.prompt ? '<div class="scenario-scene-prompt">' + Utils.escapeHtml(sc.prompt) + '</div>' : '') +
            '</div>'
        ).join('');
        document.getElementById('scenario-output').classList.remove('hidden');
    },
    _text(s) {
        const lines = [s.title];
        if (s.logline) lines.push('', s.logline);
        s.scenes.forEach(sc => {
            lines.push('', sc.number + '. ' + sc.title + (sc.act ? ' (' + sc.act + ')' : ''));
            if (sc.description) lines.push(sc.description);
            if (sc.prompt) lines.push('Prompt : ' + sc.prompt);
        });
        return lines.join('\n');
    },
    _copy() {
        if (!this._last) return;
        const text = this._text(this._last);
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => UI.showToast('Copié ✓', 'success'));
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            UI.showToast('Copié ✓', 'success');
        }
    },
    /* Chaque scénario devient une scène du projet courant : titre,
       description et prompt repartent tels quels dans les champs éditables
       du Storyboard. Sans projet actif, rien n'est écrit — on ouvre
       l'onglet Storyboard pour que l'utilisateur en crée un. */
    toStoryboard() {
        if (!this._last) return;
        if (!Runtime.currentProjectId) {
            UI.showToast('Choisis d\'abord un projet dans Storyboard', 'warn');
            UI.switchTab('storyboard');
            return;
        }
        const p = ProjectService.get(Runtime.currentProjectId);
        if (!p) {
            UI.showToast('Projet introuvable', 'error');
            return;
        }
        p.scenes = p.scenes || [];
        this._last.scenes.forEach(sc => {
            p.scenes.push({
                id: Utils.uid('scene'),
                number: p.scenes.length + 1,
                title: sc.title,
                description: sc.description,
                prompt: sc.prompt,
                status: 'pending'
            });
        });
        ProjectService.update(p.id, { scenes: p.scenes });
        const added = this._last.scenes.length;
        UI.switchTab('storyboard');
        UI.showToast(added + ' scènes ajoutées ✓', 'success');
        LSVAnalytics.track('scenario_used', { target: 'storyboard', scenes: added, mode: this._last.format });
    }
};

/* AMÉLIORATION DE PROMPT : on affiche le prompt d'origine intact à côté de
   sa version améliorée. Rien n'est remplacé tout seul — le bouton
   « Copier » porte le résultat, l'utilisateur décide ensuite. */
const ImproveView = {
    _last: null,
    bind() {
        document.getElementById('improve-input').addEventListener('input', () => UI.updateButtons());
        document.getElementById('improve-generate').addEventListener('click', () => this.generate());
        document.getElementById('improve-copy').addEventListener('click', () => {
            if (!this._last) return;
            const text = this._last.after;
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => UI.showToast('Copié ✓', 'success'));
            } else {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                UI.showToast('Copié ✓', 'success');
            }
        });
        document.getElementById('improve-use-image').addEventListener('click', () => this._use('image'));
        document.getElementById('improve-use-video').addEventListener('click', () => this._use('video'));
    },
    _use(target) {
        if (!this._last) return;
        const p = this._last.after;
        if (target === 'image') {
            UIState.imagePrompt = p;
            document.getElementById('image-prompt').value = p;
            UI.switchTab('image');
        } else {
            UIState.videoPrompt = p;
            document.getElementById('video-prompt').value = p;
            UI.switchTab('video');
        }
        UI.updateButtons();
        UI.showToast(target === 'image' ? 'Utilisé pour image' : 'Utilisé pour vidéo', 'success');
    },
    async generate() {
        const prompt = document.getElementById('improve-input').value.trim();
        if (!prompt) return;
        const btn = document.getElementById('improve-generate');
        btn.disabled = true;
        btn.innerHTML = '<span class="ms">hourglass_top</span> Analyse en cours…';
        UI.setStatus('Amélioration en cours…');
        try {
            const after = await PromptImproveService.improve(prompt);
            this._last = { before: prompt, after: after };
            document.getElementById('improve-before').textContent = prompt;
            document.getElementById('improve-after').textContent = after;
            document.getElementById('improve-output').classList.add('visible');
            UI.showToast('Prompt amélioré ✓', 'success');
            HistoryService.add('prompt.improve', 'Prompt amélioré (avant / après)');
            LSVAnalytics.track('prompt_improved', { status: 'success' });
        } catch (e) {
            DebugService.log('error', 'IMPROVE', e.message);
            LSVAnalytics.track('prompt_improved', { status: 'error' });
            UI.showToast(Utils.friendlyError(e), 'error', 4000);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span class="ms">auto_fix_high</span> Améliorer ce prompt';
            UI.setStatus(null);
            UI.updateButtons();
        }
    }
};

const StoryboardView = {
    refresh() {
        const info = document.getElementById('storyboard-project-info');
        const editor = document.getElementById('storyboard-editor');
        if (!Runtime.currentProjectId) {
            info.innerHTML = '<div class="info-block">Sélectionne un projet pour éditer ses scènes.</div>';
            editor.classList.add('hidden');
            return;
        }
        const p = ProjectService.get(Runtime.currentProjectId);
        if (!p) {
            info.innerHTML = '<div class="info-block warn">Projet introuvable.</div>';
            editor.classList.add('hidden');
            return;
        }
        info.innerHTML = '<div class="rp-project-card">' +
            '<span class="ms">folder</span>' +
            '<div class="rp-project-info">' +
                '<div class="rp-project-name">' + Utils.escapeHtml(p.name) + '</div>' +
                '<div class="rp-project-meta">' + (p.scenes || []).length + ' scènes · ' + p.type + '</div>' +
            '</div>' +
        '</div>';
        editor.classList.remove('hidden');
        this._renderScenes(p);
    },
    _renderScenes(p) {
        const list = document.getElementById('storyboard-list');
        if (!p.scenes || !p.scenes.length) {
            list.innerHTML = '<div class="empty-state" style="padding:1.5rem;">' +
                '<span class="ms">view_timeline</span>' +
                '<div class="empty-state-title">Aucune scène</div>' +
                '<div class="empty-state-desc">Ajoute des scènes pour structurer ton projet.</div>' +
            '</div>';
            return;
        }
        list.innerHTML = p.scenes.map((s, i) => this._sceneCard(s, i)).join('');
        this._bindSceneEvents(p);
    },
    _sceneCard(s, i) {
        return '<div class="scene-card" data-scene-idx="' + i + '">' +
            '<div class="scene-card-header">' +
                '<div class="scene-card-title">' +
                    '<div class="scene-number">' + (i + 1) + '</div>' +
                    '<div class="scene-name">' + Utils.escapeHtml(s.title || 'Sans titre') + '</div>' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:0.5rem;">' +
                    '<span class="scene-status ' + (s.status || 'pending') + '">' + (s.status || 'pending') + '</span>' +
                    '<div class="scene-actions">' +
                        '<button data-scene-generate="' + i + '" title="Générer"><span class="ms">auto_awesome</span></button>' +
                        '<button class="danger" data-scene-delete="' + i + '" title="Supprimer"><span class="ms">delete</span></button>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="scene-fields">' +
                '<div class="field field-full" style="margin-bottom:0;">' +
                    '<label>Titre</label>' +
                    '<input type="text" data-scene-field="title" data-idx="' + i + '" value="' + Utils.escapeHtml(s.title || '') + '">' +
                '</div>' +
                '<div class="field field-full" style="margin-bottom:0;">' +
                    '<label>Description</label>' +
                    '<textarea data-scene-field="description" data-idx="' + i + '" rows="2">' + Utils.escapeHtml(s.description || '') + '</textarea>' +
                '</div>' +
                '<div class="field field-full" style="margin-bottom:0;">' +
                    '<label>Prompt image / vidéo</label>' +
                    '<textarea data-scene-field="prompt" data-idx="' + i + '" rows="2">' + Utils.escapeHtml(s.prompt || '') + '</textarea>' +
                '</div>' +
            '</div>' +
        '</div>';
    },
    _bindSceneEvents(p) {
        document.querySelectorAll('[data-scene-field]').forEach(el => {
            el.addEventListener('input', () => {
                const idx = parseInt(el.dataset.idx, 10);
                const field = el.dataset.sceneField;
                if (!p.scenes[idx]) return;
                p.scenes[idx][field] = el.value;
                p.updatedAt = Date.now();
                clearTimeout(this._saveTimer);
                this._saveTimer = setTimeout(() => {
                    ProjectService.update(p.id, { scenes: p.scenes });
                }, 600);
            });
        });
        document.querySelectorAll('[data-scene-delete]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.sceneDelete, 10);
                p.scenes.splice(idx, 1);
                ProjectService.update(p.id, { scenes: p.scenes });
                this._renderScenes(p);
                UI.showToast('Scène supprimée', 'warn');
            });
        });
        document.querySelectorAll('[data-scene-generate]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.sceneGenerate, 10);
                const scene = p.scenes[idx];
                if (!scene.prompt && !scene.description) {
                    UI.showToast('Remplis un prompt ou une description', 'warn');
                    return;
                }
                UIState.imagePrompt = scene.prompt || scene.description;
                document.getElementById('image-prompt').value = UIState.imagePrompt;
                UI.switchTab('image');
                UI.updateButtons();
                UI.showToast('Scène ' + (idx + 1) + ' → onglet Image', 'success');
            });
        });
    },
    addScene() {
        if (!Runtime.currentProjectId) return;
        const p = ProjectService.get(Runtime.currentProjectId);
        if (!p) return;
        p.scenes = p.scenes || [];
        p.scenes.push({
            id: Utils.uid('scene'),
            number: p.scenes.length + 1,
            title: 'Nouvelle scène',
            description: '',
            prompt: '',
            status: 'pending'
        });
        ProjectService.update(p.id, { scenes: p.scenes });
        this._renderScenes(p);
        UI.showToast('Scène ajoutée', 'success');
    }
};

const WorkflowsView = {
    refresh() {
        const grid = document.getElementById('workflow-grid');
        grid.innerHTML = WORKFLOWS.map(w =>
            '<div class="workflow-card" data-workflow="' + w.id + '">' +
                '<div class="workflow-icon"><span class="ms">' + w.icon + '</span></div>' +
                '<div class="workflow-name">' + Utils.escapeHtml(w.name) + '</div>' +
                '<div class="workflow-desc">' + Utils.escapeHtml(w.desc) + '</div>' +
                '<div class="workflow-steps">' +
                    w.steps.map((s, i) =>
                        '<span class="workflow-step-pill">' + Utils.escapeHtml(s) + '</span>' +
                        (i < w.steps.length - 1 ? '<span class="workflow-step-arrow">→</span>' : '')
                    ).join('') +
                '</div>' +
            '</div>'
        ).join('');
        grid.querySelectorAll('[data-workflow]').forEach(el => {
            el.addEventListener('click', () => this.launch(el.dataset.workflow));
        });
    },
    launch(id) {
        const w = WORKFLOWS.find(x => x.id === id);
        if (!w) return;
        UI.showToast('Workflow « ' + w.name + ' » lancé', 'success');
        DebugService.log('info', 'WORKFLOW', 'Lancement : ' + w.name);
        HistoryService.add('workflow.launch', 'Workflow lancé : ' + w.name);
        if (w.target === 'image') UI.switchTab('image');
        else if (w.target === 'storyboard') UI.switchTab('storyboard');
        else if (w.target === 'chat') UI.switchTab('chat');
        else if (w.target === 'locks') UI.switchTab('locks');
    }
};

const LocksView = {
    refresh() {
        const grid = document.getElementById('locks-grid');
        const locks = LockService.all();
        let html = '';
        LOCK_TYPES.forEach(type => {
            const typeLocks = locks.filter(l => l.type === type.id);
            const lastLock = typeLocks[0];
            html += '<div class="lock-card' + (lastLock && lastLock.imageDataUri ? ' has-image' : '') + '">' +
                '<div class="lock-preview">' +
                    (lastLock && lastLock.imageDataUri
                        ? '<img src="' + lastLock.imageDataUri + '" alt="">'
                        : '<span class="ms">' + type.icon + '</span>') +
                    '<input type="file" accept="image/*" data-lock-upload="' + type.id + '">' +
                '</div>' +
                '<div>' +
                    '<div class="lock-name">' + Utils.escapeHtml(type.name) + '</div>' +
                    '<div class="lock-desc">' + Utils.escapeHtml(type.desc) + '</div>' +
                '</div>' +
                (lastLock ? '<div style="font-size:0.72rem;color:var(--ink-3);">Dernier : « ' + Utils.escapeHtml(lastLock.name) + ' »</div>' : '') +
                '<button type="button" class="lock-btn primary" data-lock-add="' + type.id + '">' +
                    (lastLock ? 'Ajouter un autre' : 'Créer un ' + type.name.toLowerCase()) +
                '</button>' +
            '</div>';
        });
        grid.innerHTML = html;
        grid.querySelectorAll('[data-lock-upload]').forEach(input => {
            input.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const type = input.dataset.lockUpload;
                try {
                    const compressed = await FileService.compressImage(file, 1024);
                    this._openCreateModal(type, compressed);
                } catch (e2) { UI.showToast('Erreur image', 'error'); }
                e.target.value = '';
            });
        });
        grid.querySelectorAll('[data-lock-add]').forEach(btn => {
            btn.addEventListener('click', () => this._openCreateModal(btn.dataset.lockAdd, null));
        });
    },
    _openCreateModal(typeId, imageDataUri) {
        const type = LOCK_TYPES.find(t => t.id === typeId);
        if (!type) return;
        UI.showModal({
            title: 'Nouveau ' + type.name.toLowerCase(),
            desc: type.desc,
            fields: [
                { type: 'text', label: 'Nom', placeholder: 'Ex : Ferrari SF90 rouge', value: '' },
                { type: 'textarea', label: 'Description', placeholder: 'Décris les détails à conserver…', value: '' }
            ],
            confirmLabel: 'Verrouiller',
            onConfirm: (values) => {
                const name = (values[0] || '').trim();
                const description = (values[1] || '').trim();
                if (!name) { UI.showToast('Nom requis', 'warn'); return; }
                LockService.create({ type: typeId, name, description, imageDataUri });
                this.refresh();
                AdvancedView.refresh();
                UI.showToast('Lock créé ✓', 'success');
            }
        });
    }
};

const BatchView = {
    _queue: [],
    refresh() {
        const styleSelect = document.getElementById('batch-style');
        styleSelect.innerHTML = STYLES.map(s =>
            '<option value="' + s.id + '">' + Utils.escapeHtml(s.name) + '</option>'
        ).join('');
        styleSelect.value = 'cinematic';
        document.getElementById('batch-prompt').addEventListener('input', () => UI.updateButtons());
        document.getElementById('batch-generate').addEventListener('click', () => this.launch());
    },
    async launch() {
        if (Runtime.batchRunning) return;
        const type = document.getElementById('batch-type').value;
        const count = parseInt(document.getElementById('batch-count').value, 10);
        const style = document.getElementById('batch-style').value;
        const basePrompt = document.getElementById('batch-prompt').value.trim();
        if (!basePrompt) return;
        Runtime.batchRunning = true;
        UI.updateButtons();
        const queueCard = document.getElementById('batch-queue-card');
        const queueEl = document.getElementById('batch-queue');
        const progress = document.getElementById('batch-progress');
        queueCard.classList.remove('hidden');
        const variants = ['cinematic wide shot', 'dramatic close-up', 'elegant mid shot', 'epic angle', 'intimate framing'].slice(0, count);
        this._queue = variants.map((v, i) => ({ index: i, variant: v, status: 'queued', asset: null }));
        queueEl.innerHTML = this._queue.map(item =>
            '<div class="batch-item" id="batch-item-' + item.index + '">' +
                '<span>Variante ' + (item.index + 1) + ' · ' + item.variant + '</span>' +
                '<span class="batch-item-status queued" id="batch-status-' + item.index + '">En file</span>' +
            '</div>'
        ).join('');
        HistoryService.add('batch.start', 'Batch ' + type + ' (' + count + ' variantes)');
        let completed = 0, failed = 0;
        const runOne = async (item) => {
            item.status = 'running';
            document.getElementById('batch-status-' + item.index).className = 'batch-item-status running';
            document.getElementById('batch-status-' + item.index).textContent = 'En cours';
            progress.textContent = (completed + failed) + ' / ' + count;
            try {
                if (type === 'image') {
                    const styleObj = Utils.getStyleById(style);
                    const prompt = (styleObj ? styleObj.prompt + '. ' : '') + basePrompt + '. ' + item.variant;
                    const size = IMG_RES['2K']['9:16'];
                    const url = await ImageService.generate(prompt, size);
                    const asset = AssetService.add({
                        type: 'image', url,
                        name: 'Batch · ' + (styleObj ? styleObj.name : '') + ' · ' + item.variant,
                        metadata: { style, ratio: '9:16', size: Utils.clampSize(size) }
                    });
                    item.asset = asset;
                } else {
                    const prompt = basePrompt + '. ' + item.variant;
                    const videoId = await VideoService.createTask(null, null, prompt, 121);
                    const videoUrl = await VideoService.poll(videoId, 121, (prog) => {
                        document.getElementById('batch-status-' + item.index).textContent = prog;
                    });
                    const asset = AssetService.add({
                        type: 'video', url: videoUrl,
                        name: 'Batch vidéo · ' + item.variant,
                        metadata: { style }
                    });
                    item.asset = asset;
                }
                item.status = 'completed';
                completed++;
                LSVAnalytics.track(type === 'image' ? 'image_generated' : 'video_generated', {
                    source: 'batch', style: style,
                    model: type === 'image' ? CONFIG.MODEL_IMAGE : CONFIG.MODEL_VIDEO,
                    ratio: type === 'image' ? '9:16' : UIState.videoRatio,
                    duration: type === 'video' ? UIState.videoDuration : undefined
                });
                document.getElementById('batch-status-' + item.index).className = 'batch-item-status completed';
                document.getElementById('batch-status-' + item.index).textContent = 'Terminé ✓';
            } catch (e) {
                item.status = 'failed';
                failed++;
                document.getElementById('batch-status-' + item.index).className = 'batch-item-status failed';
                document.getElementById('batch-status-' + item.index).textContent = 'Échec';
                DebugService.log('error', 'BATCH', 'Variante ' + (item.index + 1) + ' : ' + e.message);
                LSVAnalytics.track('generation_error', { feature: type, detail: e.message, source: 'batch' });
            }
            progress.textContent = (completed + failed) + ' / ' + count;
        };
        const concurrent = [];
        for (const item of this._queue) {
            const p = runOne(item);
            concurrent.push(p);
            if (concurrent.length >= CONFIG.BATCH_MAX_CONCURRENT) {
                await Promise.race(concurrent);
                for (let i = concurrent.length - 1; i >= 0; i--) {
                    const idx = this._queue.indexOf(item);
                    if (idx >= 0 && this._queue[idx].status !== 'running') concurrent.splice(i, 1);
                }
            }
        }
        await Promise.all(concurrent);
        Runtime.batchRunning = false;
        UI.updateButtons();
        Dashboard.refresh();
        LibraryView.refresh();
        UI.showToast('Batch terminé · ' + completed + '/' + count, completed === count ? 'success' : 'warn');
        HistoryService.add('batch.done', 'Batch terminé : ' + completed + '/' + count);
    }
};

