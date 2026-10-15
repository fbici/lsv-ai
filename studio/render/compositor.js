/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — compositeur (aperçu & export)
   Dessine une frame de la séquence sur un canvas. Fonctionne en DIRECT pour
   l'aperçu et en IMAGES SÉQUENTIELLES pour l'export (§12).

   M1 : rendu de base (cadrage contain/cover, opacité, volume audio ignoré).
   M2 : filtres, transitions, texte stylé, AudioContext. M3 : export MediaRecorder.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    /* Cache des éléments média (images / vidéos) créés une seule fois. */
    const elementCache = new Map();

    /* Fonctions d'accélération des transitions. */
    const easeOut = p => 1 - Math.pow(1 - p, 3);
    const easeIn = p => p * p * p;

    const Compositor = {
        /* Retourne (ou crée) l'élément DOM utilisé pour lire un média. */
        async elementFor(media, project) {
            if (elementCache.has(media.id)) return elementCache.get(media.id);
            const url = await S.MediaStorage.getURL(media.blobKey);
            if (!url) return null;
            let el;
            if (media.kind === 'image') {
                el = new Image();
                el.src = url;
                await new Promise(res => { el.onload = res; el.onerror = res; });
            } else if (media.kind === 'video') {
                el = document.createElement('video');
                el.src = url;
                el.muted = false;
                el.playsInline = true;
                el.preload = 'auto';
                await new Promise(res => { el.onloadeddata = res; el.onerror = res; });
            } else {
                return null;   // l'audio n'est pas dessiné
            }
            elementCache.set(media.id, el);
            return el;
        },

        /* Cache les éléments pour un projet (appelé au changement de projet). */
        clearCache() {
            for (const el of elementCache.values()) {
                try {
                    if (el.tagName === 'VIDEO') { el.pause(); el.removeAttribute('src'); el.load(); }
                } catch (e) { /* rien */ }
            }
            elementCache.clear();
        },

        /* Accès contrôlé depuis le moniteur (lecture des vidéos). */
        _elementById(mediaId) { return elementCache.get(mediaId) || null; },
        _elementsForPlayback() {
            return Array.from(elementCache.values()).filter(el => el.tagName === 'VIDEO');
        },

        /* ── Rendu d'une frame ──────────────────────────────────────────── */
        /* `time` = position en secondes sur la séquence. Renvoie le nombre de
           clips dessinés (utile pour l'écran vide). */
        async drawFrame(ctx, project, time) {
            const seq = project.sequence;
            const w = ctx.canvas.width, h = ctx.canvas.height;

            ctx.save();
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, w, h);

            const layers = S.TimelineModel.clipsAt(project, time);
            let drawn = 0;

            for (const layer of layers) {
                const track = layer.track;
                if (track.muted && track.kind === 'audio') continue;
                for (const item of layer.items) {
                    const clip = item.clip;
                    if (clip.muted) continue;
                    if (clip.kind === 'text') { this._drawText(ctx, clip, w, h, seq); drawn++; continue; }
                    const media = S.TimelineModel.media(project, clip.mediaId);
                    if (!media || media.missing) { this._drawMissing(ctx, w, h, item); continue; }
                    const el = await this.elementFor(media, project);
                    if (!el) { this._drawMissing(ctx, w, h, item); continue; }

                    if (media.kind === 'video') {
                        try {
                            if (Math.abs(el.currentTime - item.sourceTime) > 0.05) el.currentTime = item.sourceTime;
                        } catch (e) { /* seek non prêt */ }
                    }
                    this._drawElement(ctx, el, clip, media, w, h, seq, time);
                    drawn++;
                }
            }
            ctx.restore();
            return drawn;
        },

        /* ── Effets (filtres CSS, §9) ───────────────────────────────────── */
        /* Construit la chaîne `ctx.filter` à partir des effets du clip.
           Retourne null si aucun effet (ctx.filter=null = pas de filtre). */
        filterFor(clip) {
            if (!clip.effects || !clip.effects.length) return null;
            const parts = [];
            for (const e of clip.effects) {
                if (!e || !e.type) continue;
                if (e.type === 'brightness' && e.brightness != null) parts.push('brightness(' + (e.brightness / 100) + ')');
                else if (e.type === 'contrast' && e.contrast != null) parts.push('contrast(' + (e.contrast / 100) + ')');
                else if (e.type === 'saturate' && e.saturate != null) parts.push('saturate(' + (e.saturate / 100) + ')');
                else if (e.type === 'blur' && e.blur != null && e.blur > 0) parts.push('blur(' + e.blur + 'px)');
            }
            return parts.length ? parts.join(' ') : null;
        },

        /* Progression 0→1 d'une transition d'entrée/sortie à l'instant `t`.
           Renvoie un facteur d'opacité/décalage appliqué au clip. */
        transitionFactor(clip, time) {
            const t = time - clip.start;
            const remaining = clip.duration - t;
            let alpha = 1, dx = 0, dy = 0, scale = 1;

            const tin = clip.transitionIn;
            if (tin && tin.type && tin.duration > 0 && t < tin.duration) {
                const p = Math.max(0, Math.min(1, t / tin.duration));
                const e = easeOut(p);
                if (tin.type === 'fade') alpha *= e;
                else if (tin.type === 'slide-left') dx = (1 - e) * -0.4;
                else if (tin.type === 'slide-right') dx = (1 - e) * 0.4;
                else if (tin.type === 'zoom') { scale = 0.85 + 0.15 * e; alpha *= e; }
            }
            const tout = clip.transitionOut;
            if (tout && tout.type && tout.duration > 0 && remaining < tout.duration) {
                const p = Math.max(0, Math.min(1, 1 - remaining / tout.duration));
                const e = easeIn(p);
                if (tout.type === 'fade') alpha *= 1 - e;
                else if (tout.type === 'slide-left') dx = e * 0.4;
                else if (tout.type === 'slide-right') dx = e * -0.4;
                else if (tout.type === 'zoom') { scale = 1 - 0.15 * e; alpha *= 1 - e; }
            }
            return { alpha: Math.max(0, Math.min(1, alpha)), dx: dx, dy: dy, scale: scale };
        },

        /* Ajuste un média au format de séquence (contain ou cover). */
        _drawElement(ctx, el, clip, media, w, h, seq, time) {
            const sw = media.kind === 'image' ? el.naturalWidth : el.videoWidth;
            const sh = media.kind === 'image' ? el.naturalHeight : el.videoHeight;
            if (!sw || !sh) return;

            const fit = (clip.style && clip.style.fit) || 'cover';
            const scale = fit === 'contain'
                ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh);
            let dw = sw * scale, dh = sh * scale;
            let dx = (w - dw) / 2 + (clip.offsetX || 0) * w;
            let dy = (h - dh) / 2 + (clip.offsetY || 0) * h;

            /* Transitions : décalage, mise à l'échelle, fondu. */
            const tr = this.transitionFactor(clip, time);
            if (tr.scale !== 1) {
                const cx = dx + dw / 2, cy = dy + dh / 2;
                dw *= tr.scale; dh *= tr.scale;
                dx = cx - dw / 2; dy = cy - dh / 2;
            }
            dx += tr.dx * w; dy += tr.dy * h;

            ctx.save();
            ctx.globalAlpha = (clip.opacity == null ? 1 : clip.opacity) * tr.alpha;
            /* `ctx.filter` n'existe pas sur tous les navigateurs (certains
               Safari) : Capability l'a signalé, on l'applique quand présent. */
            const filter = this.filterFor(clip);
            if (filter) {
                try { ctx.filter = filter; } catch (e) { /* ignoré */ }
            }
            try { ctx.drawImage(el, dx, dy, dw, dh); } catch (e) { /* frame non prête */ }
            ctx.restore();
        },

        _drawText(ctx, clip, w, h, seq) {
            const style = clip.style || {};
            const size = Number(style.fontSize) || Math.round(h * 0.07);
            ctx.save();
            ctx.globalAlpha = clip.opacity == null ? 1 : clip.opacity;
            ctx.font = (style.weight || '700') + ' ' + size + 'px ' + (style.font || 'system-ui, sans-serif');
            ctx.textAlign = style.align || 'center';
            ctx.textBaseline = 'middle';
            const x = style.align === 'left' ? w * 0.06 : style.align === 'right' ? w * 0.94 : w / 2;
            const y = h / 2 + (clip.offsetY || 0) * h;
            if (style.stroke) {
                ctx.lineWidth = Math.max(2, size / 12);
                ctx.strokeStyle = style.stroke;
                ctx.strokeText(clip.text || '', x, y);
            }
            ctx.fillStyle = style.color || '#fff';
            ctx.fillText(clip.text || '', x, y);
            ctx.restore();
        },

        _drawMissing(ctx, w, h, item) {
            ctx.save();
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.font = '600 ' + Math.round(h * 0.04) + 'px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Média manquant', w / 2, h / 2);
            ctx.restore();
        },

        /* Met à jour le volume des vidéos actives (M1 : simple volume natif). */
        applyVolumes(project, time) {
            const layers = S.TimelineModel.clipsAt(project, time);
            const active = new Set();
            for (const layer of layers) {
                for (const item of layer.items) {
                    const media = S.TimelineModel.media(project, item.clip.mediaId);
                    if (!media || media.kind !== 'video') continue;
                    active.add(media.id);
                    const el = elementCache.get(media.id);
                    if (el) el.volume = Math.max(0, Math.min(1,
                        (item.clip.muted || layer.track.muted) ? 0 : (item.clip.volume == null ? 1 : item.clip.volume)));
                }
            }
            /* Coupe les vidéos qui ne sont plus à l'écran. */
            for (const [id, el] of elementCache) {
                if (el.tagName === 'VIDEO' && !active.has(id) && !el.paused) el.pause();
            }
        }
    };

    S.Compositor = Compositor;
})();
