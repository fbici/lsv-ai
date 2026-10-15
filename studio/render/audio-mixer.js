/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — mixage audio (Web Audio)
   Un seul `AudioContext` pour l'application. Chaque élément <video> du
   compositeur est branché une fois pour toutes sur un `GainNode`, ce qui
   permet :
     • de piloter le volume par clip (muted / volume / fondu) ;
     • de capturer le mix pour l'export (MediaStreamDestination) ;
     • de garder le retour haut-parleur pour l'aperçu.

   En cas d'absence de Web Audio (jsdom, navigateur très ancien), le module
   se met en mode « pass-through » : aucun son à l'export, mais rien ne
   plante (§20.14).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    const AudioMixer = {
        ctx: null,
        /* Par mediaId : { src, gain } */
        _nodes: new Map(),
        _dest: null,          // MediaStreamDestination (export)
        _supported: null,

        supported() {
            if (this._supported !== null) return this._supported;
            const AC = window.AudioContext || window.webkitAudioContext;
            this._supported = !!AC;
            return this._supported;
        },

        /* Crée (ou réutilise) le contexte. `resume()` est obligatoire après
           une interaction utilisateur, sinon le contexte reste « suspendu ». */
        context() {
            if (!this.supported()) return null;
            if (!this.ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                try { this.ctx = new AC(); } catch (e) { return null; }
            }
            if (this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} }
            return this.ctx;
        },

        /* Destination d'export : un flux audio à combiner au flux vidéo. */
        streamDestination() {
            const ctx = this.context();
            if (!ctx) return null;
            if (!this._dest) {
                try { this._dest = ctx.createMediaStreamDestination(); } catch (e) { return null; }
            }
            return this._dest;
        },

        /* ── Branchement d'un élément média ─────────────────────────────── */
        /* Idempotent : le même élément n'est branché qu'une fois. Renvoie le
           GainNode pilotable, ou null si Web Audio est indisponible. */
        attach(el, mediaId) {
            if (!el || el.tagName !== 'VIDEO') return null;
            if (this._nodes.has(mediaId)) return this._nodes.get(mediaId).gain;
            const ctx = this.context();
            if (!ctx) return null;
            let src, gain;
            try {
                src = ctx.createMediaElementSource(el);
                gain = ctx.createGain();
            } catch (e) { return null; }
            src.connect(gain);
            /* Toujours au haut-parleur : l'aperçu doit rester audible même
               hors export. Le mix d'export est une copie du même signal. */
            try { gain.connect(ctx.destination); } catch (e) {}
            this._nodes.set(mediaId, { src: src, gain: gain });
            return gain;
        },

        /* Connecte le gain d'un média à la destination d'export. */
        connectToExport(mediaId) {
            const node = this._nodes.get(mediaId);
            const dest = this.streamDestination();
            if (!node || !dest) return false;
            try { node.gain.connect(dest); return true; } catch (e) { return false; }
        },

        /* Déconnecte tous les gains de la destination d'export (fin d'export). */
        disconnectExport() {
            const dest = this._dest;
            if (!dest) return;
            for (const { gain } of this._nodes.values()) {
                try { gain.disconnect(dest); } catch (e) { /* déjà déconnecté */ }
            }
        },

        /* ── Niveau instantané ──────────────────────────────────────────── */
        /* Applique volume + fondu d'entrée/sortie du clip. `fade` vaut
           'in' | 'out' | null selon la position dans le clip. */
        setLevel(mediaId, volume, muted) {
            const node = this._nodes.get(mediaId);
            if (!node) return;
            const v = muted ? 0 : Math.max(0, Math.min(2, volume == null ? 1 : volume));
            try {
                node.gain.gain.setTargetAtTime(v, node.gain.context.currentTime, 0.02);
            } catch (e) {
                try { node.gain.gain.value = v; } catch (e2) {}
            }
        },

        /* Met à jour tous les niveaux depuis l'état de la timeline.
           Les fondues d'entrée/sortie du clip atténuent aussi le son (§9). */
        applyProject(project, time) {
            const layers = S.TimelineModel.clipsAt(project, time);
            const seen = new Set();
            for (const layer of layers) {
                for (const item of layer.items) {
                    const clip = item.clip;
                    const media = S.TimelineModel.media(project, clip.mediaId);
                    if (!media || (media.kind !== 'video' && media.kind !== 'audio')) continue;
                    seen.add(media.id);
                    /* Le même facteur que le compositeur : image et son
                       fondent ensemble, sinon le décalage se voit. */
                    const tr = S.Compositor.transitionFactor(clip, time);
                    const base = (clip.muted || layer.track.muted) ? 0 : (clip.volume == null ? 1 : clip.volume);
                    this.setLevel(media.id, base * tr.alpha, false);
                }
            }
            /* Coupe les médias absents de la frame courante. */
            for (const [id] of this._nodes) {
                if (!seen.has(id)) this.setLevel(id, 0, true);
            }
        },

        /* Libère les nœuds (changement de projet). Les <video> correspondants
           sont détruits par le compositeur : on ne garde pas de référence. */
        detachAll() {
            for (const { src, gain } of this._nodes.values()) {
                try { src.disconnect(); } catch (e) {}
                try { gain.disconnect(); } catch (e) {}
            }
            this._nodes.clear();
        },

        suspend() { if (this.ctx && this.ctx.state === 'running') { try { this.ctx.suspend(); } catch (e) {} } },
        resume() { if (this.ctx && this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} } }
    };

    S.AudioMixer = AudioMixer;
})();
