const ChatService = {
    buildSystemPrompt(context = {}) {
        let base = [
            'Tu es LSV Director, l\'assistant créatif de LSV.ai.',
            '',
            'Rôle : transformer une idée en projet créatif concret (images, vidéos, scénarios, storyboards).',
            'Style : créatif, professionnel, direct, orienté résultat. Réponds en français.',
            '',
            'Structure ta réponse :',
            '**Concept** : phrase de résumé',
            '**Format** : ratio, durée, style',
            '**Scènes** : liste numérotée si pertinent',
            '**Prochaine étape** : action concrète'
        ].join('\n');

        if (context.projectId) {
            const p = ProjectService.get(context.projectId);
            if (p) {
                base += '\n\n**CONTEXTE PROJET : « ' + p.name + ' »**';
                base += '\nType : ' + p.type;
                if (p.description) base += '\nDescription : ' + p.description;
                if (p.scenes && p.scenes.length) {
                    base += '\nScènes (' + p.scenes.length + ') :';
                    p.scenes.slice(0, 10).forEach((s, i) => {
                        base += '\n  ' + (i + 1) + '. ' + Utils.truncate(s.title || s.description || '(sans titre)', 80);
                    });
                }
            }
        }

        const locks = LockService.all();
        if (locks.length) {
            base += '\n\n**ÉLÉMENTS VERROUILLÉS** :';
            locks.forEach(l => {
                base += '\n- ' + l.name + ' (' + l.type + ') : ' + l.description;
            });
        }

        return base;
    },
    buildMessages(conversation, context) {
        const msgs = [{ role: 'system', content: this.buildSystemPrompt(context) }];
        const recent = conversation.messages.slice(-CONFIG.CHAT_CONTEXT_MESSAGES);
        for (const m of recent) {
            if (m.role === 'user' || m.role === 'assistant') {
                msgs.push({ role: m.role, content: m.content });
            }
        }
        return msgs;
    },
    async send(conversation, userMessage, context) {
        // Création réservée aux comptes connectés
        if (!(await AccountView.ensure())) throw new Error('Connexion requise');
        ConversationService.addMessage(conversation.id, 'user', userMessage);
        const conv = ConversationService.get(conversation.id);
        const messages = this.buildMessages(conv, context);
        const response = await fetch(CONFIG.API_BASE + '/chat/completions', Gateway.withHeaders({
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({
                model: CONFIG.MODEL_CHAT,
                messages,
                temperature: CONFIG.CHAT_TEMPERATURE,
                max_tokens: CONFIG.CHAT_MAX_TOKENS,
                stream: true
            })
        }));
        if (!response.ok) return this._fallbackSend(conv, context);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', fullContent = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                        const content = delta && delta.content;
                        if (content) {
                            fullContent += content;
                            ChatView.onStreamChunk(fullContent);
                        }
                    } catch (e) {}
                }
            }
        } finally { try { reader.releaseLock(); } catch (e) {} }
        if (!fullContent) return this._fallbackSend(conv, context);
        ConversationService.addMessage(conv.id, 'assistant', fullContent);
        return fullContent;
    },
    async _fallbackSend(conv, context) {
        const messages = this.buildMessages(conv, context);
        const res = await AgnesProvider.fetch(
            CONFIG.API_BASE + '/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: CONFIG.MODEL_CHAT,
                    messages,
                    temperature: CONFIG.CHAT_TEMPERATURE,
                    max_tokens: CONFIG.CHAT_MAX_TOKENS
                })
            },
            'Chat'
        );
        if (!res.ok) throw await AgnesProvider.fail(res);
        const data = await res.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!content) throw new Error('Réponse vide');
        ConversationService.addMessage(conv.id, 'assistant', content);
        return content;
    },
    detectActions(text) {
        const actions = [];
        const lower = text.toLowerCase();
        if (lower.includes('image') && (lower.includes('générer') || lower.includes('créer') || lower.includes('prompt'))) {
            actions.push({ id: 'create-image', label: 'Préparer une image', icon: 'image', handler: 'chatActionCreateImage' });
        }
        if (lower.includes('vidéo') || lower.includes('video')) {
            actions.push({ id: 'create-video', label: 'Préparer une vidéo', icon: 'movie', handler: 'chatActionCreateVideo' });
        }
        if (lower.includes('projet') && (lower.includes('créer') || lower.includes('nouveau'))) {
            actions.push({ id: 'create-project', label: 'Créer le projet', icon: 'folder', handler: 'chatActionCreateProject' });
        }
        if (lower.includes('scène') || lower.includes('storyboard')) {
            actions.push({ id: 'create-storyboard', label: 'Structurer en scènes', icon: 'view_timeline', handler: 'chatActionStoryboard' });
        }
        if (lower.includes('enhancer') || lower.includes('améliorer') || lower.includes('optimiser')) {
            actions.push({ id: 'enhance', label: 'Améliorer le prompt', icon: 'auto_fix_high', handler: 'chatActionEnhance' });
        }
        return actions.slice(0, 5);
    }
};

const ChatActions = {
    execute(handler, sourceText) {
        const fn = this[handler];
        if (typeof fn === 'function') fn.call(this, sourceText);
        else UI.showToast('Action non disponible', 'warn');
    },
    chatActionCreateImage(sourceText) {
        const prompt = this._extractPrompt(sourceText);
        UIState.imagePrompt = prompt;
        document.getElementById('image-prompt').value = prompt;
        UI.switchTab('image');
        UI.updateButtons();
        UI.showToast('Prompt image pré-rempli', 'success');
    },
    chatActionCreateVideo(sourceText) {
        const prompt = this._extractPrompt(sourceText);
        UIState.videoPrompt = prompt;
        document.getElementById('video-prompt').value = prompt;
        UI.switchTab('video');
        UI.updateButtons();
        UI.showToast('Prompt vidéo pré-rempli', 'success');
    },
    chatActionCreateProject(sourceText) {
        const firstLine = sourceText.split('\n').find(l => l.trim()) || 'Nouveau projet';
        const title = Utils.truncate(firstLine.replace(/[*#]/g, '').trim(), 50);
        const p = ProjectService.create({
            name: title,
            description: sourceText.slice(0, 300),
            type: 'general'
        });
        Runtime.currentProjectId = p.id;
        ProjectsView.refresh();
        Dashboard.refresh();
        RightPanel.refresh();
        ChatView.renderContextChip();
        UI.showToast('Projet créé et activé', 'success');
    },
    chatActionStoryboard(sourceText) {
        const projectName = Utils.truncate(sourceText.split('\n')[0].replace(/[*#]/g, '').trim(), 50);
        const p = ProjectService.create({
            name: projectName || 'Storyboard',
            description: sourceText.slice(0, 300),
            type: 'storyboard'
        });
        const sceneMatches = sourceText.match(/(?:^|\n)\s*(?:\d+[.)]|Scène\s+\d+|Scene\s+\d+)[^\n]*/g) || [];
        if (sceneMatches.length) {
            p.scenes = sceneMatches.slice(0, 12).map((s, i) => ({
                id: Utils.uid('scene'),
                number: i + 1,
                title: s.replace(/^\s*(?:\d+[.)]|Scène\s+\d+|Scene\s+\d+)\s*[:\-]?\s*/i, '').slice(0, 100),
                description: '', prompt: '', status: 'pending'
            }));
            ProjectService.update(p.id, { scenes: p.scenes });
        }
        Runtime.currentProjectId = p.id;
        UI.switchTab('storyboard');
        StoryboardView.refresh();
        Dashboard.refresh();
        RightPanel.refresh();
        ChatView.renderContextChip();
        UI.showToast('Storyboard créé (' + p.scenes.length + ' scènes)', 'success');
    },
    chatActionEnhance(sourceText) {
        const idea = this._extractPrompt(sourceText);
        document.getElementById('enhancer-input').value = idea;
        UI.switchTab('enhancer');
        UI.updateButtons();
        UI.showToast('Prompt pré-rempli dans l\'Enhancer', 'success');
    },
    _extractPrompt(text) {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        const promptIdx = lines.findIndex(l => /prompt/i.test(l));
        if (promptIdx >= 0) {
            return lines.slice(promptIdx, promptIdx + 5).join(' ').replace(/^\**prompt\**\s*:?\s*/i, '');
        }
        return lines.slice(0, 6).join(' ');
    }
};

const ChatView = {
    refresh() {
        this.renderConversationList();
        this.renderMessages();
        this.renderContextChip();
    },
    renderConversationList() {
        const list = document.getElementById('chat-conv-list');
        const convs = ConversationService.all();
        if (!convs.length) {
            list.innerHTML = '<div style="text-align:center;padding:1rem 0.5rem;font-size:0.72rem;color:var(--ink-4);">Aucune conversation</div>';
            return;
        }
        list.innerHTML = convs.map(c =>
            '<div class="chat-conv-item ' + (c.id === Runtime.currentConversationId ? 'active' : '') + '" data-conv="' + c.id + '">' +
                '<div class="chat-conv-icon"><span class="ms">forum</span></div>' +
                '<div class="chat-conv-body">' +
                    '<div class="chat-conv-title">' + Utils.escapeHtml(c.title) + '</div>' +
                    '<div class="chat-conv-date">' + Utils.formatDate(c.updatedAt) + '</div>' +
                '</div>' +
                '<div class="chat-conv-actions">' +
                    '<button class="chat-conv-action" data-conv-rename="' + c.id + '"><span class="ms">edit</span></button>' +
                    '<button class="chat-conv-action danger" data-conv-delete="' + c.id + '"><span class="ms">delete</span></button>' +
                '</div>' +
            '</div>'
        ).join('');
        list.querySelectorAll('[data-conv]').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.chat-conv-action')) return;
                this.openConversation(el.dataset.conv);
            });
        });
        list.querySelectorAll('[data-conv-delete]').forEach(el => {
            el.addEventListener('click', (e) => { e.stopPropagation(); this.deleteConversation(el.dataset.convDelete); });
        });
        list.querySelectorAll('[data-conv-rename]').forEach(el => {
            el.addEventListener('click', (e) => { e.stopPropagation(); this.renameConversation(el.dataset.convRename); });
        });
    },
    renderContextChip() {
        const wrap = document.getElementById('chat-context-chip-wrap');
        if (!Runtime.currentProjectId) { wrap.innerHTML = ''; return; }
        const p = ProjectService.get(Runtime.currentProjectId);
        if (!p) { wrap.innerHTML = ''; return; }
        wrap.innerHTML = '<span class="chat-context-chip" id="chat-context-chip">' +
            '<span class="ms">folder</span>' + Utils.escapeHtml(Utils.truncate(p.name, 28)) + '</span>';
        const chip = document.getElementById('chat-context-chip');
        if (chip) chip.addEventListener('click', () => {
            Runtime.currentProjectId = null;
            this.renderContextChip();
            RightPanel.refresh();
            UI.showToast('Contexte retiré', 'warn');
        });
    },
    renderMessages() {
        const container = document.getElementById('chat-messages');
        if (!Runtime.currentConversationId) { container.innerHTML = this._emptyState(); this._bindSuggestions(); return; }
        const conv = ConversationService.get(Runtime.currentConversationId);
        if (!conv || !conv.messages.length) { container.innerHTML = this._emptyState(); this._bindSuggestions(); return; }
        const lastAssistantIdx = [...conv.messages].map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i >= 0).pop();
        container.innerHTML = conv.messages.map((m, i) => this._messageHtml(m, i === lastAssistantIdx)).join('');
        this._bindMessageActions(conv, container);
        container.scrollTop = container.scrollHeight;
    },
    _emptyState() {
        return '<div class="chat-empty">' +
            '<div class="chat-empty-icon"><span class="ms">auto_awesome</span></div>' +
            '<div class="chat-empty-title">Bonjour, je suis LSV Director</div>' +
            '<div class="chat-empty-desc">Décris-moi une idée, un projet ou une question créative. Je peux proposer des concepts, écrire des prompts et structurer des scénarios.</div>' +
            '<div class="chat-suggestions">' +
                '<button class="chat-suggestion" data-suggest="Je veux créer une pub de 15 secondes pour une montre de luxe dans un désert doré."><span class="ms">lightbulb</span><span>Une pub de 15 secondes pour une montre de luxe</span></button>' +
                '<button class="chat-suggestion" data-suggest="Propose-moi 3 concepts de vidéo virale pour TikTok avec un produit tech."><span class="ms">trending_up</span><span>3 concepts TikTok pour un produit tech</span></button>' +
                '<button class="chat-suggestion" data-suggest="Écris un prompt image détaillé pour une scène de rue cyberpunk sous la pluie."><span class="ms">image</span><span>Un prompt image cyberpunk sous la pluie</span></button>' +
                '<button class="chat-suggestion" data-suggest="Structure en 5 scènes une mini-histoire sur un libraire qui découvre un livre magique."><span class="ms">view_timeline</span><span>Structurer une histoire en 5 scènes</span></button>' +
            '</div>' +
        '</div>';
    },
    _bindSuggestions() {
        document.querySelectorAll('[data-suggest]').forEach(el => {
            el.addEventListener('click', () => {
                const text = el.dataset.suggest;
                document.getElementById('chat-input').value = text;
                UI.updateButtons();
                this.sendMessage();
            });
        });
    },
    _messageHtml(m, showActions) {
        const isUser = m.role === 'user';
        const avatar = isUser ? '<span class="ms">person</span>' : '<span class="ms">auto_awesome</span>';
        const contentHtml = isUser ? Utils.escapeHtml(m.content).replace(/\n/g, '<br>') : Utils.renderMarkdown(m.content);
        let actionsHtml = '';
        if (!isUser && showActions) {
            const actions = ChatService.detectActions(m.content);
            if (actions.length) {
                actionsHtml = '<div class="chat-msg-actions">' +
                    actions.map(a => '<button class="chat-action-btn" data-chat-action="' + a.handler + '"><span class="ms">' + a.icon + '</span> ' + a.label + '</button>').join('') +
                '</div>';
            }
        }
        return '<div class="chat-msg ' + (isUser ? 'user' : 'assistant') + '">' +
            '<div class="chat-msg-avatar">' + avatar + '</div>' +
            '<div class="chat-msg-bubble">' + contentHtml + actionsHtml + '</div>' +
        '</div>';
    },
    _bindMessageActions(conv, container) {
        container.querySelectorAll('[data-chat-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const lastAssistant = [...conv.messages].reverse().find(m => m.role === 'assistant');
                ChatActions.execute(btn.dataset.chatAction, lastAssistant ? lastAssistant.content : '');
            });
        });
    },
    openConversation(id) {
        Runtime.currentConversationId = id;
        this.renderConversationList();
        this.renderMessages();
    },
    newConversation() {
        const existingEmpty = ConversationService.all().find(c => c.messages.length === 0);
        if (existingEmpty) Runtime.currentConversationId = existingEmpty.id;
        else {
            const conv = ConversationService.create({ projectId: Runtime.currentProjectId });
            Runtime.currentConversationId = conv.id;
        }
        this.refresh();
    },
    renameConversation(id) {
        const c = ConversationService.get(id);
        if (!c) return;
        UI.showModal({
            title: 'Renommer la conversation',
            fields: [{ type: 'text', label: 'Titre', value: c.title }],
            confirmLabel: 'Renommer',
            onConfirm: (values) => {
                const title = (values[0] || '').trim();
                if (!title) return;
                ConversationService.update(id, { title });
                this.refresh();
            }
        });
    },
    deleteConversation(id) {
        const c = ConversationService.get(id);
        if (!c) return;
        UI.showModal({
            title: 'Supprimer cette conversation ?',
            desc: '« ' + c.title + ' » sera définitivement supprimée.',
            confirmLabel: 'Supprimer',
            danger: true,
            onConfirm: () => {
                ConversationService.delete(id);
                if (Runtime.currentConversationId === id) {
                    Runtime.currentConversationId = null;
                    const remaining = ConversationService.all();
                    if (remaining.length) Runtime.currentConversationId = remaining[0].id;
                }
                this.refresh();
                Dashboard.refresh();
            }
        });
    },
    async sendMessage() {
        if (Runtime.chatStreaming) return;
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        // Création réservée aux comptes connectés (message conservé dans le champ)
        if (!(await AccountView.ensure())) return;
        if (!Runtime.currentConversationId) {
            const conv = ConversationService.create({ projectId: Runtime.currentProjectId });
            Runtime.currentConversationId = conv.id;
        }
        input.value = '';
        input.style.height = 'auto';
        UI.updateButtons();
        const convBefore = ConversationService.get(Runtime.currentConversationId);
        const optimisticHtml = convBefore.messages.map((m, i) => this._messageHtml(m, false)).join('') +
            this._messageHtml({ role: 'user', content: text }, false) +
            '<div class="chat-msg assistant" id="chat-typing-msg">' +
                '<div class="chat-msg-avatar"><span class="ms">auto_awesome</span></div>' +
                '<div class="chat-msg-bubble"><div class="chat-typing"><span></span><span></span><span></span></div></div>' +
            '</div>';
        const container = document.getElementById('chat-messages');
        container.innerHTML = optimisticHtml;
        container.scrollTop = container.scrollHeight;
        Runtime.chatStreaming = true;
        UI.updateButtons();
        try {
            const conv = ConversationService.get(Runtime.currentConversationId);
            await ChatService.send(conv, text, { projectId: Runtime.currentProjectId });
            this.refresh();
            Dashboard.refresh();
            LSVAnalytics.track('chat_used', { status: 'success' });
        } catch (e) {
            DebugService.log('error', 'CHAT', e.message);
            LSVAnalytics.track('chat_used', { status: 'error', detail: e.message });
            UI.showToast(Utils.friendlyError(e), 'error', 4000);
            const ph = document.getElementById('chat-typing-msg');
            if (ph) ph.remove();
            this.refresh();
        } finally {
            Runtime.chatStreaming = false;
            UI.updateButtons();
        }
    },
    onStreamChunk(fullContent) {
        const typing = document.getElementById('chat-typing-msg');
        if (!typing) return;
        const bubble = typing.querySelector('.chat-msg-bubble');
        if (!bubble) return;
        bubble.innerHTML = Utils.renderMarkdown(fullContent);
        const container = document.getElementById('chat-messages');
        container.scrollTop = container.scrollHeight;
    }
};

