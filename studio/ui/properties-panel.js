/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — panneau Propriétés
   Édite le clip sélectionné : vitesse, volume, opacité, texte, effets,
   transitions. Chaque modification passe par le TimelineModel (jamais de
   mutation directe depuis l'UI) et est enregistrée dans l'historique.

   Le panneau se ré-ancre à la sélection via un rappel posé par main.js :
   il ne connaît pas la TimelineView en interne.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    /* Catalogue d'effets (§9). `prop` = propriété CSS appliquée par le
       compositeur ; `min`/`max` bornent le curseur. */
    const EFFECTS = [
        { id: 'brightness', label: 'Luminosité', min: 0, max: 200, unit: '%', dflt: 100 },
        { id: 'contrast', label: 'Contraste', min: 0, max: 200, unit: '%', dflt: 100 },
        { id: 'saturate', label: 'Saturation', min: 0, max: 300, unit: '%', dflt: 100 },
        { id: 'blur', label: 'Flou', min: 0, max: 20, unit: 'px', dflt: 0 }
    ];

    const TRANSITIONS = [
        { id: '', label: 'Aucune' },
        { id: 'fade', label: 'Fondu' },
        { id: 'slide-left', label: 'Glissement ←' },
        { id: 'slide-right', label: 'Glissement →' },
        { id: 'zoom', label: 'Zoom' }
    ];

    const PropertiesPanel = {
        els: {},

        init() {
            this.els.body = document.getElementById('sv-props-body');
            if (!this.els.body) return;
            this.render(null);
        },

        /* Appelé par TimelineView à chaque changement de sélection. */
        onSelection(clipId) {
            const project = S.App.project;
            const found = clipId && project ? S.TimelineModel.clip(project, clipId) : null;
            this.render(found ? found.clip : null, found ? found.track : null);
        },

        /* ── Rendu ──────────────────────────────────────────────────────── */
        render(clip, track) {
            const body = this.els.body;
            if (!body) return;
            if (!clip) { this._renderProject(body); return; }
            const project = S.App.project;
            const media = S.TimelineModel.media(project, clip.mediaId);
            const isText = clip.kind === 'text';
            const isAudio = clip.kind === 'audio';
            const style = clip.style || (clip.style = {});
            const effects = clip.effects || (clip.effects = []);

            let html = '';

            /* ── En-tête ── */
            html += '<div class="sv-prop-group">' +
                '<div class="sv-prop-title">' + esc(isText ? 'Texte' : (media ? media.name : 'Clip')) + '</div>' +
                '<div class="sv-prop-row"><span class="sv-prop-label">Piste</span>' +
                '<span class="sv-prop-value">' + esc(track ? track.name : '—') + '</span></div>' +
                '<div class="sv-prop-row"><span class="sv-prop-label">Position</span>' +
                '<span class="sv-prop-value">' + fmt(clip.start) + ' → ' + fmt(clip.start + clip.duration) + ' s</span></div>' +
                '<div class="sv-prop-row"><span class="sv-prop-label">Durée</span>' +
                '<span class="sv-prop-value">' + clip.duration.toFixed(2) + ' s</span></div>' +
                '</div>';

            /* ── Temps / niveau ── */
            html += '<div class="sv-prop-group">';
            if (!isAudio) {
                html += slider('speed', 'Vitesse', clip.speed, 0.25, 4, 0.05, '×');
            }
            html += slider('volume', 'Volume', clip.volume, 0, 2, 0.05, '');
            html += checkbox('muted', 'Muet', clip.muted);
            if (!isAudio) {
                html += slider('opacity', 'Opacité', clip.opacity, 0, 1, 0.05, '');
            }
            html += '</div>';

            /* ── Texte ── */
            if (isText) {
                html += '<div class="sv-prop-group">' +
                    '<div class="sv-prop-title">Texte</div>' +
                    '<textarea id="svp-text" class="svp-input" rows="2" maxlength="2000">' + esc(clip.text || '') + '</textarea>' +
                    slider('fontSize', 'Taille', Number(style.fontSize) || 64, 12, 300, 1, 'px', 'style') +
                    '<div class="sv-prop-row"><span class="sv-prop-label">Couleur</span>' +
                    '<input type="color" id="svp-color" value="' + esc(style.color || '#ffffff') + '"></div>' +
                    '<div class="sv-prop-row"><span class="sv-prop-label">Contour</span>' +
                    '<input type="color" id="svp-stroke" value="' + esc(style.stroke || '#000000') + '"></div>' +
                    select('align', 'Alignement', style.align || 'center',
                        [{ id: 'left', label: 'Gauche' }, { id: 'center', label: 'Centré' }, { id: 'right', label: 'Droite' }], 'style') +
                    '</div>';
            }

            /* ── Effets ── */
            if (!isAudio) {
                html += '<div class="sv-prop-group"><div class="sv-prop-title">Effets</div>';
                for (const eff of EFFECTS) {
                    const cur = currentEffect(effects, eff.id);
                    html += slider('eff:' + eff.id, eff.label, cur, eff.min, eff.max, eff.unit === 'px' ? 0.5 : 1, eff.unit, 'effect');
                }
                html += '</div>';
            }

            /* ── Transitions ── */
            html += '<div class="sv-prop-group"><div class="sv-prop-title">Transitions</div>' +
                select('transitionIn', 'Entrée', (clip.transitionIn && clip.transitionIn.type) || '', TRANSITIONS) +
                slider('tInDur', 'Durée d’entrée', (clip.transitionIn && clip.transitionIn.duration) || 0.5, 0.05, 3, 0.05, ' s') +
                select('transitionOut', 'Sortie', (clip.transitionOut && clip.transitionOut.type) || '', TRANSITIONS) +
                slider('tOutDur', 'Durée de sortie', (clip.transitionOut && clip.transitionOut.duration) || 0.5, 0.05, 3, 0.05, ' s') +
                '</div>';

            body.innerHTML = html;
            this._bind(clip);
        },

        /* ── Réglages du projet (aucun clip sélectionné) ─────────────────── */
        _renderProject(body) {
            const project = S.App.project;
            if (!project) {
                body.innerHTML = '<p class="sv-muted">Sélectionne un clip pour régler ses propriétés.</p>';
                return;
            }
            const es = project.exportSettings || (project.exportSettings = {});
            const caps = S.Capability ? S.Capability.summary() : { format: '—', exportable: false };
            body.innerHTML =
                '<div class="sv-prop-group">' +
                '  <div class="sv-prop-title">Séquence</div>' +
                '  <div class="sv-prop-row"><span class="sv-prop-label">Format</span>' +
                '    <span class="sv-prop-value">' + project.sequence.width + '×' + project.sequence.height + '</span></div>' +
                '  <div class="sv-prop-row"><span class="sv-prop-label">Images/s</span>' +
                '    <span class="sv-prop-value">' + Math.round(project.sequence.fps) + '</span></div>' +
                '  <div class="sv-prop-row"><span class="sv-prop-label">Durée</span>' +
                '    <span class="sv-prop-value">' + S.TimelineModel.duration(project).toFixed(1) + ' s</span></div>' +
                '</div>' +
                '<div class="sv-prop-group">' +
                '  <div class="sv-prop-title">Export</div>' +
                '  <div class="sv-prop-row"><span class="sv-prop-label">Conteneur</span>' +
                '    <span class="sv-prop-value">' + esc(caps.format) + '</span></div>' +
                (caps.exportable ? '' :
                    '  <p class="sv-muted">Export indisponible sur ce navigateur (voir l’écran d’accueil).</p>') +
                select('quality', 'Qualité', es.quality || 'high',
                    [{ id: 'low', label: 'Basse (plus rapide)' }, { id: 'high', label: 'Haute' }]) +
                '</div>' +
                '<div class="sv-prop-group">' +
                '  <div class="sv-prop-title">Aide</div>' +
                '  <p class="sv-muted">L’export se fait <strong>en temps réel</strong> : une vidéo de ' +
                Math.round(S.TimelineModel.duration(project)) + ' s prend environ ' +
                Math.round(S.TimelineModel.duration(project)) + ' s à produire. ' +
                'Ne ferme pas cet onglet pendant l’export.</p>' +
                '</div>';

            const sel = body.querySelector('select[data-svp="quality"]');
            if (sel) {
                sel.addEventListener('change', () => {
                    S.HistoryManager.begin(project);
                    project.exportSettings.quality = sel.value;
                    S.HistoryManager.commit(project);
                    S.App.setSaveState('dirty');
                });
            }
        },

        _bind(clip) {
            const body = this.els.body;
            const apply = (mutate, useHistory) => {
                const project = S.App.project;
                if (useHistory !== false) S.HistoryManager.begin(project);
                mutate();
                S.ProjectModel.touch(project);
                if (useHistory !== false) S.HistoryManager.commit(project);
                S.HistoryManager.syncButtons();
                S.App.setSaveState('dirty');
                if (S.Preview) S.Preview.refresh();
            };

            /* Curseurs et listes duales (clip / style / effet). */
            body.querySelectorAll('[data-svp]').forEach(input => {
                const kind = input.dataset.svpKind;
                const key = input.dataset.svp;
                input.addEventListener('input', () => {
                    const v = Number(input.value);
                    apply(() => {
                        if (kind === 'style') clip.style = Object.assign(clip.style || {}, { [key]: v });
                        else if (kind === 'effect') setEffect(clip, key, v);
                        else if (key === 'tInDur') clip.transitionIn = Object.assign(clip.transitionIn || { type: 'fade', duration: 0.5 }, { duration: v });
                        else if (key === 'tOutDur') clip.transitionOut = Object.assign(clip.transitionOut || { type: 'fade', duration: 0.5 }, { duration: v });
                        else clip[key] = v;
                    });
                    const out = body.querySelector('[data-svp-out="' + key + '"]');
                    if (out) out.textContent = formatVal(v, input.dataset.svpUnit);
                });
                /* Un seul historique par glisser-curseur, pas par pixel. */
                input.addEventListener('change', () => S.HistoryManager.commit(S.App.project));
                input.addEventListener('pointerdown', () => S.HistoryManager.begin(S.App.project));
            });

            body.querySelectorAll('select[data-svp]').forEach(sel => {
                sel.addEventListener('change', () => {
                    const kind = sel.dataset.svpKind, key = sel.dataset.svp;
                    apply(() => {
                        if (kind === 'style') { clip.style = clip.style || {}; clip.style[key] = sel.value; }
                        else if (key === 'transitionIn') clip.transitionIn = sel.value ? { type: sel.value, duration: (clip.transitionIn && clip.transitionIn.duration) || 0.5 } : null;
                        else if (key === 'transitionOut') clip.transitionOut = sel.value ? { type: sel.value, duration: (clip.transitionOut && clip.transitionOut.duration) || 0.5 } : null;
                        else clip[key] = sel.value;
                    });
                });
            });

            body.querySelectorAll('input[type=checkbox][data-svp]').forEach(cb => {
                cb.addEventListener('change', () => {
                    const key = cb.dataset.svp;
                    apply(() => { clip[key] = cb.checked; });
                });
            });

            const text = body.querySelector('#svp-text');
            if (text) {
                let timer = null;
                text.addEventListener('input', () => {
                    clearTimeout(timer);
                    timer = setTimeout(() => apply(() => { clip.text = text.value; }), 250);
                });
            }
            const color = body.querySelector('#svp-color');
            if (color) color.addEventListener('input', () => apply(() => { clip.style = Object.assign(clip.style || {}, { color: color.value }); }));
            const stroke = body.querySelector('#svp-stroke');
            if (stroke) stroke.addEventListener('input', () => apply(() => { clip.style = Object.assign(clip.style || {}, { stroke: stroke.value }); }));
        }
    };

    /* ── Helpers de rendu ──────────────────────────────────────────────── */
    function slider(key, label, value, min, max, step, unit, kind) {
        return '<div class="sv-prop-row svp-slider">' +
            '<span class="sv-prop-label">' + label + '</span>' +
            '<input type="range" data-svp="' + key + '" data-svp-kind="' + (kind || 'clip') + '" ' +
            'data-svp-unit="' + (unit || '') + '" min="' + min + '" max="' + max + '" step="' + step + '" ' +
            'value="' + value + '">' +
            '<span class="sv-prop-value" data-svp-out="' + key + '">' + formatVal(value, unit) + '</span>' +
            '</div>';
    }
    function checkbox(key, label, checked) {
        return '<label class="sv-prop-row"><input type="checkbox" data-svp="' + key + '" data-svp-kind="clip"' +
            (checked ? ' checked' : '') + '> <span class="sv-prop-label">' + label + '</span></label>';
    }
    function select(key, label, value, options, kind) {
        let html = '<div class="sv-prop-row"><span class="sv-prop-label">' + label + '</span>' +
            '<select data-svp="' + key + '" data-svp-kind="' + (kind || 'clip') + '">';
        for (const o of options) {
            html += '<option value="' + o.id + '"' + (o.id === value ? ' selected' : '') + '>' + o.label + '</option>';
        }
        return html + '</select></div>';
    }
    function formatVal(v, unit) {
        if (unit === ' s') return Number(v).toFixed(2) + ' s';
        if (unit === '%') return Math.round(v) + '%';
        if (unit === 'px') return Math.round(v) + 'px';
        if (unit === '×') return Number(v).toFixed(2) + '×';
        return Number(v).toFixed(2);
    }
    function currentEffect(effects, id) {
        const e = effects.find(e => e && e.type === id);
        if (!e) return (EFFECTS.find(x => x.id === id) || {}).dflt || 0;
        /* Repli sur la valeur par défaut de l'effet. */
        const def = (EFFECTS.find(x => x.id === id) || {}).dflt || 0;
        return e[id] != null ? e[id] : def;
    }
    function setEffect(clip, id, value) {
        const def = (EFFECTS.find(x => x.id === id) || {}).dflt || 0;
        let e = clip.effects.find(e => e && e.type === id);
        if (!e) {
            /* On retire l'effet s'il est redevenu neutre : pas d'entrée inutile. */
            if (Math.abs(value - def) < 1e-6) return;
            e = { type: id };
            clip.effects.push(e);
        }
        e[id] = value;
        if (Math.abs(value - def) < 1e-6) {
            clip.effects = clip.effects.filter(x => x !== e);
        }
    }
    function fmt(t) { const m = Math.floor(t / 60), s = t % 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    S.PropertiesPanel = PropertiesPanel;
    S.PROPERTY_EFFECTS = EFFECTS;
})();
