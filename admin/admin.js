/* ═══════════════════════════════════════════════════════════════════════════
   LSV.ai — Back-office Admin
   ───────────────────────────────────────────────────────────────────────────
   • Authentification réelle via Supabase Auth (vérification côté serveur,
     mots de passe hachés, JWT) — aucun identifiant dans ce fichier.
   • Connexion ET création de compte (signUp) depuis cet écran.
   • Liste blanche : la lecture des stats est conditionnée à is_admin()
     (table public.admin_emails) — un compte non autorisé reste sur l'écran
     de connexion avec un message explicite, sans aucune donnée affichée.
   • Lecture des statistiques soumise aux politiques RLS Supabase :
     sans session valide, la base ne renvoie STRICTEMENT RIENT.
   • Tolérance aux pannes : si Supabase/le réseau est indisponible, l'admin
     affiche un message d'erreur, sans casser quoi que ce soit.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var MAX_ROWS = 20000;
    var MAX_PRIOR = 8000;

    var State = {
        client: null,
        user: null,
        session: null,
        mode: 'login', // 'login' | 'signup'
        isAdmin: false,
        checking: false,
        rows: [],
        priorVisitors: [],
        range: 'today',
        page: 'overview',
        syncedAt: null,
        refreshTimer: null,
        refreshSec: 60,
        activityFilter: 'all',
        activityLimit: 50,
        loading: false
    };

    var PAGE_META = {
        overview: { title: "Vue d'ensemble", sub: "Vue globale de l'usage de LSV.ai" },
        activity: { title: 'Activité', sub: 'Flux des derniers événements (sans données privées)' },
        errors: { title: 'Erreurs', sub: 'Erreurs de génération et incidents remontés par le front' },
        images: { title: 'Images', sub: 'Statistiques de génération d’images' },
        videos: { title: 'Vidéos', sub: 'Statistiques de génération de vidéos' },
        chat: { title: 'Chat IA', sub: 'Usage du chat intégré' },
        motion: { title: 'Motion', sub: 'Module Motion Control' },
        settings: { title: 'Paramètres', sub: 'Connexion, session et actualisation' }
    };

    var TAB_NAMES = {
        dashboard: 'Tableau de bord', chat: 'Chat IA', image: 'Images', video: 'Vidéos',
        enhancer: 'Enhancer', motion: 'Motion', storyboard: 'Storyboard', workflows: 'Workflows',
        locks: 'Cohérence', batch: 'Batch', projects: 'Projets', library: 'Bibliothèque',
        history: 'Historique', advanced: 'Avancé'
    };

    var COLORS = {
        image: '#0d9488', video: '#7c3aed', chat: '#2563eb',
        motion: '#ea580c', error: '#dc2626', project: '#d97706', tab: '#8a8a94'
    };

    /* ── Utilitaires ────────────────────────────────────────────────────── */
    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function num(n) {
        n = Number(n) || 0;
        return n.toLocaleString('fr-FR');
    }
    function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }
    function toast(msg, type) {
        var el = $('toast'), icon = $('toast-icon'), txt = $('toast-text');
        if (!el) return;
        el.className = 'toast';
        icon.textContent = type === 'error' ? 'error' : (type === 'success' ? 'check_circle' : 'info');
        txt.textContent = msg;
        void el.offsetWidth;
        el.classList.add('visible');
        if (type) el.classList.add(type);
        clearTimeout(toast._t);
        toast._t = setTimeout(function () { el.classList.remove('visible'); }, 3200);
    }
    function fmtTime(iso) {
        var d = new Date(iso);
        return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    }
    function fmtDateTime(iso) {
        var d = new Date(iso);
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + ' ' +
            d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    }
    function dayStart(d) {
        var x = new Date(d); x.setHours(0, 0, 0, 0); return x;
    }
    function rangeStart(range) {
        var now = new Date();
        if (range === 'today') return dayStart(now);
        if (range === '7d') { var a = dayStart(now); a.setDate(a.getDate() - 6); return a; }
        if (range === '30d') { var b = dayStart(now); b.setDate(b.getDate() - 29); return b; }
        return null; // "tout"
    }
    function isSuccess(row) {
        var p = row.props || {};
        return p.status !== 'error';
    }
    function isErrorRow(row) {
        var p = row.props || {};
        return row.event === 'generation_error' ||
            (row.event === 'chat_used' && p.status === 'error') ||
            (row.event === 'enhancer_used' && p.status === 'error');
    }

    /* ── Authentification ───────────────────────────────────────────────── */
    function isConfigured() {
        var c = window.LSV_CONFIG || {};
        var url = String(c.SUPABASE_URL || '');
        var key = String(c.SUPABASE_ANON_KEY || '');
        return !!(url && key &&
            url.indexOf('YOUR_PROJECT_REF') === -1 &&
            url.indexOf('supabase.co') !== -1 &&
            key.indexOf('YOUR_SUPABASE_ANON_KEY') === -1 &&
            key.length > 30);
    }

    function showLogin(msg, kind) {
        $('admin-app').classList.add('hidden');
        $('auth-screen').classList.remove('hidden');
        var st = $('auth-status');
        st.className = 'auth-status' + (kind ? ' ' + kind : '');
        st.textContent = msg || 'Connecte-toi pour afficher les statistiques.';
        var err = $('login-error');
        if (msg && kind === 'error') { err.textContent = msg; err.classList.remove('hidden'); }
        else { err.classList.add('hidden'); }
    }

    function showApp() {
        $('auth-screen').classList.add('hidden');
        $('admin-app').classList.remove('hidden');
        $('admin-email').textContent = (State.user && State.user.email) || 'admin';
        renderSettings();
    }

    function friendlyAuthError(message) {
        var m = String(message || '').toLowerCase();
        if (m.indexOf('invalid login') !== -1) return 'Identifiants incorrects.';
        if (m.indexOf('already registered') !== -1 || m.indexOf('user already') !== -1) return 'Compte déjà existant : connecte-toi.';
        if (m.indexOf('password should be at least') !== -1 || m.indexOf('password is too short') !== -1) return 'Mot de passe : 6 caractères minimum.';
        if (m.indexOf('signup') !== -1 && m.indexOf('disabled') !== -1) return 'Inscriptions désactivées sur ce projet Supabase.';
        if (m.indexOf('email not confirmed') !== -1) return 'E-mail non confirmé : clique sur le lien reçu puis reconnecte-toi.';
        if (m.indexOf('rate limit') !== -1 || m.indexOf('too many') !== -1) return 'Trop de tentatives, réessaie plus tard.';
        if (m.indexOf('fetch') !== -1 || m.indexOf('network') !== -1) return 'Impossible de joindre Supabase (réseau).';
        return message || 'Échec de la connexion.';
    }

    /* Mode connexion / création de compte ─────────────────────────────── */
    function buttonLabel() {
        return State.mode === 'signup'
            ? '<span class="ms">person_add</span> Créer le compte'
            : '<span class="ms">lock</span> Se connecter';
    }
    function setBusy(btn, busy) {
        btn.disabled = busy;
        btn.innerHTML = busy
            ? '<span class="ms">progress_activity</span> Vérification…'
            : buttonLabel();
    }
    function setMode(mode) {
        State.mode = mode === 'signup' ? 'signup' : 'login';
        var signup = State.mode === 'signup';
        $('login-btn').innerHTML = buttonLabel();
        $('signup-toggle').textContent = signup
            ? 'J’ai déjà un compte — Se connecter'
            : 'Créer un compte';
        $('signup-hint').classList.toggle('hidden', !signup);
        $('auth-title').textContent = signup ? 'Créer un compte' : 'Back-office';
        if ($('login-name-field')) $('login-name-field').classList.toggle('hidden', !signup);
        if (!signup && $('login-name')) $('login-name').value = '';
        $('login-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
        $('login-password').setAttribute('placeholder', signup ? '6 caractères minimum' : '••••••••');
    }

    function initAuth() {
        var form = $('login-form');
        $('signup-toggle').addEventListener('click', function () {
            setMode(State.mode === 'signup' ? 'login' : 'signup');
            $('login-error').classList.add('hidden');
            $('login-email').focus();
        });
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var email = $('login-email').value.trim();
            var password = $('login-password').value;
            var btn = $('login-btn');
            if (!State.client) { showLogin('Service d\'authentification indisponible.', 'error'); return; }
            var call;
            if (State.mode === 'signup') {
                var nameEl = $('login-name');
                var name = nameEl ? nameEl.value.trim() : '';
                if (!name) {
                    showLogin('Nom complet requis.', 'error');
                    if (nameEl) nameEl.focus();
                    return;
                }
                call = State.client.auth.signUp({
                    email: email,
                    password: password,
                    options: { data: { full_name: name } }
                });
            } else {
                call = State.client.auth.signInWithPassword({ email: email, password: password });
            }
            setBusy(btn, true);
            call
                .then(function (res) {
                    setBusy(btn, false);
                    if (res.error) { showLogin(friendlyAuthError(res.error.message), 'error'); return; }
                    if (State.mode === 'signup') {
                        var session = res.data && res.data.session;
                        if (!session) {
                            setMode('login');
                            showLogin('Compte créé : confirme ton e-mail (lien reçu), puis connecte-toi.', '');
                            return;
                        }
                    }
                    State.user = res.data.user;
                    onSignedIn();
                })
                .catch(function (err) {
                    setBusy(btn, false);
                    showLogin(friendlyAuthError(err && err.message), 'error');
                });
        });

        $('logout-btn').addEventListener('click', doLogout);
        $('settings-logout').addEventListener('click', doLogout);
        initKeyCard();
    }

    function doLogout() {
        if (State.client) State.client.auth.signOut().catch(function () {});
        State.user = null;
        State.isAdmin = false;
        State.rows = [];
        State.priorVisitors = [];
        stopAutoRefresh();
        showLogin('Déconnecté.');
        toast('Déconnecté', 'success');
    }

    /* Liste blanche : la RLS renvoie zéro ligne aux non-admins, donc on
       interroge explicitement is_admin() avant d'ouvrir le tableau de bord. */
    function checkAdminAccess() {
        if (!State.client || typeof State.client.rpc !== 'function') {
            return Promise.resolve({
                ok: false,
                msg: 'Script SQL à exécuter : supabase/upgrade-admin-whitelist.sql (fonction is_admin introuvable).'
            });
        }
        return State.client.rpc('is_admin')
            .then(function (res) {
                if (res && res.error) {
                    return {
                        ok: false,
                        msg: 'Script SQL à exécuter : supabase/upgrade-admin-whitelist.sql (' +
                            friendlyAuthError(res.error.message) + ')'
                    };
                }
                if (!res || res.data !== true) {
                    return { ok: false, msg: 'Compte non autorisé : cet accès est réservé aux e-mails de la liste blanche.' };
                }
                return { ok: true };
            })
            .catch(function () {
                return {
                    ok: false,
                    msg: 'Script SQL à exécuter : supabase/upgrade-admin-whitelist.sql (fonction is_admin introuvable).'
                };
            });
    }

    function onSignedIn() {
        if (!State.user || State.checking) return;
        if (!$('admin-app').classList.contains('hidden')) return;
        State.checking = true;
        checkAdminAccess().then(function (res) {
            State.checking = false;
            if (!State.user) return;
            if (!res.ok) {
                State.isAdmin = false;
                stopAutoRefresh();
                showLogin(res.msg, 'error');
                return;
            }
            State.isAdmin = true;
            showApp();
            toast('Connexion réussie', 'success');
            load(true);
            startAutoRefresh();
        });
    }

    /* ── Chargement des données (RLS : refusé sans session) ─────────────── */
    function load(showToast) {
        if (!State.client || !State.user) return Promise.resolve();
        if (State.loading) return Promise.resolve();
        State.loading = true;
        $('refresh-btn').disabled = true;

        var start = rangeStart(State.range);
        var q = State.client.from('analytics_events')
            .select('created_at, visitor_id, session_id, event, props')
            .order('created_at', { ascending: false })
            .limit(MAX_ROWS);
        if (start) q = q.gte('created_at', start.toISOString());

        var priorQ = null;
        if (start) {
            priorQ = State.client.from('analytics_events')
                .select('visitor_id')
                .lt('created_at', start.toISOString())
                .limit(MAX_PRIOR);
        }

        return Promise.all([
            q,
            priorQ ? priorQ : Promise.resolve({ data: [], error: null })
        ]).then(function (results) {
            State.loading = false;
            $('refresh-btn').disabled = false;
            var res = results[0], prior = results[1];

            if (res.error) {
                if (/JWT|401|permission/i.test(res.error.message || '')) {
                    doLogout();
                    showLogin('Session expirée, reconnecte-toi.', 'error');
                } else {
                    toast('Lecture impossible : ' + res.error.message, 'error');
                }
                return;
            }
            State.rows = res.data || [];
            State.priorVisitors = (prior && prior.data ? prior.data : []).map(function (r) { return r.visitor_id; });
            State.syncedAt = new Date();
            $('last-sync').textContent = 'MAJ ' + State.syncedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            renderAll();
            if (showToast) toast(num(State.rows.length) + ' événements chargés', 'success');
        }).catch(function (err) {
            State.loading = false;
            $('refresh-btn').disabled = false;
            toast('Erreur réseau : ' + (err && err.message), 'error');
        });
    }

    /* ── Agrégats ───────────────────────────────────────────────────────── */
    function metrics(rows) {
        var visitors = {}, sessions = {};
        var m = {
            visitors: 0, sessions: 0, newVisitors: 0, returning: 0,
            pageviews: 0, images: 0, videos: 0, chats: 0, chatErrors: 0,
            errors: 0, projects: 0, motionOpens: 0, enhancers: 0, last: null
        };
        var prior = {};
        State.priorVisitors.forEach(function (v) { prior[v] = true; });
        var seen = {};

        rows.forEach(function (r) {
            visitors[r.visitor_id] = true;
            sessions[r.session_id] = true;
            if (!m.last || r.created_at > m.last) m.last = r.created_at;
            switch (r.event) {
                case 'page_view': m.pageviews++; break;
                case 'image_generated': m.images++; break;
                case 'video_generated': m.videos++; break;
                case 'chat_used':
                    m.chats++;
                    if (!isSuccess(r)) { m.chatErrors++; m.errors++; }
                    break;
                case 'project_created': m.projects++; break;
                case 'enhancer_used':
                    m.enhancers++;
                    if (!isSuccess(r)) m.errors++;
                    break;
                case 'tab_view':
                    if ((r.props || {}).tab === 'motion') m.motionOpens++;
                    break;
                case 'generation_error': m.errors++; break;
                default: break;
            }
        });

        m.visitors = Object.keys(visitors).length;
        m.sessions = Object.keys(sessions).length;
        Object.keys(visitors).forEach(function (v) {
            if (prior[v]) m.returning++; else m.newVisitors++;
        });
        return m;
    }

    function dayKeyOf(iso) {
        var d = new Date(iso);
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }
    function hourKeyOf(iso) {
        var d = new Date(iso);
        return dayKeyOf(iso) + 'T' + ('0' + d.getHours()).slice(-2) + ':00';
    }

    function bucketize(rows, hourly) {
        var out = [];
        var index = {};
        var now = new Date();

        function push(key, label) {
            var item = { key: key, label: label, total: 0, images: 0, videos: 0, chat: 0, errors: 0, visitors: {} };
            index[key] = item;
            out.push(item);
            return item;
        }

        if (hourly) {
            var h0 = dayStart(now);
            for (var h = 0; h <= now.getHours(); h++) {
                var d = new Date(h0.getTime() + h * 3600000);
                push(hourKeyOf(d.toISOString()), ('0' + h).slice(-2) + 'h');
            }
        } else {
            var start = rangeStart(State.range) || (State.rows.length ? new Date(State.rows[State.rows.length - 1].created_at) : dayStart(now));
            start = dayStart(start);
            var cur = dayStart(now);
            var count = Math.round((cur - start) / 86400000);
            count = Math.min(Math.max(count, 0), 60);
            for (var i = count; i >= 0; i--) {
                var dd = new Date(cur.getTime() - i * 86400000);
                var k = dayKeyOf(dd.toISOString());
                push(k, ('0' + dd.getDate()).slice(-2) + '/' + ('0' + (dd.getMonth() + 1)).slice(-2));
            }
        }

        rows.forEach(function (r) {
            var key = hourly ? hourKeyOf(r.created_at) : dayKeyOf(r.created_at);
            var item = index[key] || push(key, key.slice(5));
            item.total++;
            item.visitors[r.visitor_id] = true;
            if (r.event === 'image_generated') item.images++;
            else if (r.event === 'video_generated') item.videos++;
            else if (r.event === 'chat_used' && isSuccess(r)) item.chat++;
            if (isErrorRow(r)) item.errors++;
        });

        out.forEach(function (o) { o.visitorCount = Object.keys(o.visitors).length; });
        return out;
    }

    function countBy(rows, fn) {
        var map = {};
        rows.forEach(function (r) {
            var k = fn(r);
            if (k === undefined || k === null || k === '') k = '—';
            map[k] = (map[k] || 0) + 1;
        });
        return Object.keys(map).map(function (k) { return { label: k, value: map[k] }; })
            .sort(function (a, b) { return b.value - a.value; });
    }

    function usageRows(rows) {
        var total = 0;
        var items = [
            { name: 'Images', value: rows.filter(function (r) { return r.event === 'image_generated'; }).length, color: COLORS.image },
            { name: 'Vidéos', value: rows.filter(function (r) { return r.event === 'video_generated'; }).length, color: COLORS.video },
            { name: 'Chat IA', value: rows.filter(function (r) { return r.event === 'chat_used'; }).length, color: COLORS.chat },
            { name: 'Motion', value: rows.filter(function (r) { return r.event === 'motion_generated'; }).length, color: COLORS.motion },
            { name: 'Enhancer', value: rows.filter(function (r) { return r.event === 'enhancer_used'; }).length, color: COLORS.project }
        ];
        items.forEach(function (i) { total += i.value; });
        items.forEach(function (i) { i.pct = total > 0 ? Math.round((i.value / total) * 100) : 0; });
        return { items: items, total: total };
    }

    /* ── Graphique (SVG maison, sans dépendance) ────────────────────────── */
    function chartHTML(points, opts) {
        opts = opts || {};
        if (!points.length || points.every(function (p) { return !p.bar && !p.line; })) {
            return '<div class="chart-empty">Aucune donnée sur la période</div>';
        }
        var W = 620, H = 200, PL = 34, PR = 10, PT = 12, PB = 26;
        var iw = W - PL - PR, ih = H - PT - PB;
        var maxBar = Math.max.apply(null, points.map(function (p) { return p.bar || 0; }));
        var maxLine = Math.max.apply(null, points.map(function (p) { return p.line || 0; }));
        var max = Math.max(maxBar, maxLine, 1);
        var step = iw / points.length;
        var barW = Math.max(2, Math.min(26, step * 0.6));
        var parts = [];

        // grille + axe Y
        for (var g = 0; g <= 3; g++) {
            var y = PT + ih - (ih * g / 3);
            var val = Math.round(max * g / 3);
            parts.push('<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y + '" stroke="#e8e8e4" stroke-width="1"/>');
            parts.push('<text x="' + (PL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end" font-size="9" fill="#b8b8c0" font-family="JetBrains Mono, monospace">' + val + '</text>');
        }

        // barres
        var linePts = [];
        points.forEach(function (p, i) {
            var cx = PL + step * i + step / 2;
            if (p.bar) {
                var bh = (p.bar / max) * ih;
                parts.push('<rect x="' + (cx - barW / 2).toFixed(1) + '" y="' + (PT + ih - bh).toFixed(1) +
                    '" width="' + barW.toFixed(1) + '" height="' + Math.max(bh, 1).toFixed(1) +
                    '" rx="3" fill="' + (opts.barColor || COLORS.image) + '" opacity="0.9"><title>' + esc(p.label) + ' : ' + p.bar + '</title></rect>');
            }
            if (typeof p.line === 'number') {
                var ly = PT + ih - (p.line / max) * ih;
                linePts.push(cx.toFixed(1) + ',' + ly.toFixed(1));
            }
        });

        if (linePts.length) {
            parts.push('<polyline points="' + linePts.join(' ') + '" fill="none" stroke="' + (opts.lineColor || COLORS.chat) +
                '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
            linePts.forEach(function (pt, i) {
                var xy = pt.split(',');
                parts.push('<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="2.6" fill="#fff" stroke="' + (opts.lineColor || COLORS.chat) + '" stroke-width="1.6"><title>' + esc(points[i].label) + ' : ' + points[i].line + ' visiteurs</title></circle>');
            });
        }

        // labels X (sous-échantillonnés)
        var every = Math.ceil(points.length / 8);
        points.forEach(function (p, i) {
            if (i % every !== 0 && i !== points.length - 1) return;
            var cx = PL + step * i + step / 2;
            parts.push('<text x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="9" fill="#8a8a94" font-family="Inter, sans-serif">' + esc(p.label) + '</text>');
        });

        return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">' + parts.join('') + '</svg>';
    }

    function activityChartPoints(rows, hourly) {
        var buckets = bucketize(rows, hourly);
        return buckets.map(function (b) {
            return { label: b.label, bar: b.total, line: b.visitorCount };
        });
    }

    /* ── Rendu : composants ─────────────────────────────────────────────── */
    function kpi(label, value, foot, icon, color, footClass) {
        return '<div class="kpi" style="--kpi-color:' + (color || COLORS.image) + '">' +
            '<div class="kpi-label"><span class="ms">' + (icon || 'analytics') + '</span>' + esc(label) + '</div>' +
            '<div class="kpi-value">' + value + '</div>' +
            (foot ? '<div class="kpi-foot ' + (footClass || '') + '">' + foot + '</div>' : '') +
            '</div>';
    }

    function breakdownHTML(items, color) {
        if (!items.length) return '<div class="empty">Aucune donnée</div>';
        var max = items[0].value || 1;
        return items.slice(0, 8).map(function (i) {
            return '<div class="breakdown-row">' +
                '<span class="breakdown-label" title="' + esc(i.label) + '">' + esc(i.label) + '</span>' +
                '<span class="breakdown-bar"><i style="width:' + Math.round((i.value / max) * 100) + '%;background:' + (color || COLORS.image) + '"></i></span>' +
                '<span class="breakdown-val">' + num(i.value) + '</span>' +
            '</div>';
        }).join('');
    }

    function usageHTML(usage) {
        if (!usage.total) return '<div class="empty">Aucune génération sur la période</div>';
        return usage.items.map(function (i) {
            return '<div class="usage-row">' +
                '<span class="usage-name">' + esc(i.name) + '</span>' +
                '<span class="usage-track"><span class="usage-fill" style="width:' + Math.max(i.pct, 1) + '%;background:' + i.color + '">' +
                    (i.pct >= 8 ? '<span>' + i.pct + '%</span>' : '') + '</span></span>' +
                '<span class="usage-pct">' + (i.pct < 8 ? i.pct + '%' : num(i.value)) + '</span>' +
            '</div>';
        }).join('');
    }

    function tableHTML(headers, rows) {
        if (!rows.length) return '<div class="empty">Aucune donnée</div>';
        return '<table><thead><tr>' +
            headers.map(function (h) { return '<th' + (h.num ? ' class="num"' : '') + '>' + esc(h.label) + '</th>'; }).join('') +
            '</tr></thead><tbody>' +
            rows.map(function (r) {
                return '<tr>' + r.map(function (c, i) {
                    return '<td' + (headers[i].num ? ' class="num"' : '') + '>' + c + '</td>';
                }).join('') + '</tr>';
            }).join('') +
            '</tbody></table>';
    }

    function feedItem(row) {
        var p = row.props || {};
        var icon = 'circle', cls = 'tab', title = row.event, meta = '';
        switch (row.event) {
            case 'page_view': icon = 'visibility'; cls = 'tab'; title = 'Page ouverte'; meta = p.path || '/'; break;
            case 'tab_view': icon = 'tab'; cls = 'tab'; title = 'Onglet · ' + (TAB_NAMES[p.tab] || p.tab || '—'); break;
            case 'image_generated':
                icon = 'image'; cls = 'image'; title = p.source === 'batch' ? 'Image générée (batch)' : 'Image générée';
                meta = [p.model, p.size, p.ratio, p.style ? 'style ' + p.style : null].filter(Boolean).join(' · ');
                break;
            case 'video_generated':
                icon = 'movie'; cls = 'video'; title = p.source === 'batch' ? 'Vidéo générée (batch)' : 'Vidéo générée';
                meta = [p.model, p.mode, p.duration ? p.duration + 's' : null, p.segments > 1 ? p.segments + ' segments' : null].filter(Boolean).join(' · ');
                break;
            case 'chat_used':
                icon = p.status === 'error' ? 'error' : 'forum';
                cls = p.status === 'error' ? 'error' : 'chat';
                title = p.status === 'error' ? 'Erreur Chat IA' : 'Chat IA utilisé';
                meta = p.detail ? String(p.detail).slice(0, 90) : '';
                break;
            case 'project_created': icon = 'folder'; cls = 'project'; title = 'Projet créé'; meta = 'type ' + (p.type || 'general'); break;
            case 'generation_error':
                icon = 'error'; cls = 'error'; title = 'Erreur · ' + (p.feature || 'inconnu');
                meta = String(p.detail || '').slice(0, 110);
                break;
            case 'enhancer_used':
                icon = p.status === 'error' ? 'error' : 'auto_fix_high';
                cls = p.status === 'error' ? 'error' : 'project';
                title = p.status === 'error' ? 'Erreur Enhancer' : 'Prompt amélioré';
                meta = [p.type, p.style].filter(Boolean).join(' · ');
                break;
            case 'motion_generated': icon = 'animation'; cls = 'project'; title = 'Motion générée'; break;
            case 'account_created': icon = 'person_add'; cls = 'project'; title = 'Compte créé'; break;
            case 'account_signed_in': icon = 'verified_user'; cls = 'tab'; title = 'Connexion compte'; break;
            default: icon = 'bolt'; title = row.event;
        }
        return '<div class="feed-item">' +
            '<div class="feed-icon ' + cls + '"><span class="ms">' + icon + '</span></div>' +
            '<div class="feed-body">' +
                '<div class="feed-title">' + esc(title) + '</div>' +
                (meta ? '<div class="feed-meta">' + esc(meta) + '</div>' : '') +
            '</div>' +
            '<div class="feed-time">' + fmtTime(row.created_at) + '</div>' +
        '</div>';
    }

    function feedHTML(rows, limit) {
        if (!rows.length) return '<div class="empty">Aucune activité sur la période</div>';
        return rows.slice(0, limit || 12).map(feedItem).join('');
    }

    function kvHTML(pairs) {
        return pairs.map(function (p) {
            return '<div class="kv-row"><span class="kv-key">' + esc(p[0]) + '</span><span class="kv-val' + (p[2] ? ' mono' : '') + '">' + p[1] + '</span></div>';
        }).join('');
    }

    /* ── Pages ──────────────────────────────────────────────────────────── */
    function renderOverview() {
        var rows = State.rows;
        var m = metrics(rows);
        var hourly = State.range === 'today';
        var usage = usageRows(rows);

        $('kpi-grid').innerHTML =
            kpi('Visiteurs', num(m.visitors), State.range === 'all' ? 'période complète' : (num(m.newVisitors) + ' nouveaux · ' + num(m.returning) + ' récurrents'), 'group', COLORS.image) +
            kpi('Sessions', num(m.sessions), num(m.pageviews) + ' ouvertures de page', 'sensors', COLORS.chat) +
            kpi('Images générées', num(m.images), num(countErrors(rows, 'image')) + ' erreur(s)', 'image', COLORS.image) +
            kpi('Vidéos générées', num(m.videos), 'erreurs : ' + num(countErrors(rows, 'video')), 'movie', COLORS.video) +
            kpi('Chat utilisé', num(m.chats), num(m.chatErrors) + ' erreur(s)', 'forum', COLORS.chat) +
            kpi('Erreurs', num(m.errors), m.last ? 'dernière : ' + fmtTime(m.last) : '—', 'error', COLORS.error, m.errors ? 'down' : 'up');

        $('chart-activity').innerHTML = chartHTML(activityChartPoints(rows, hourly), { barColor: COLORS.image, lineColor: COLORS.chat });
        $('chart-activity-legend').innerHTML =
            '<span class="legend-item"><span class="legend-dot" style="background:' + COLORS.image + '"></span> Événements</span>' +
            '<span class="legend-item"><span class="legend-dot" style="background:' + COLORS.chat + '"></span> Visiteurs uniques</span>';

        $('usage-bars').innerHTML = usageHTML(usage);
        $('overview-feed').innerHTML = feedHTML(rows.slice().sort(sortDesc), 10);

        $('visitor-stats').innerHTML =
            kvHTML([
                ['Visiteurs (appareils)', num(m.visitors)],
                ['Sessions', num(m.sessions)],
                ['Nouveaux visiteurs', num(m.newVisitors)],
                ['Visiteurs récurrents', num(m.returning)],
                ['Dernière activité', m.last ? fmtDateTime(m.last) : '—'],
                ['Événements totaux', num(rows.length)]
            ]) +
            '<div class="info-block" style="margin-top:1rem">Les identifiants sont anonymes et non liés à une personne : ils servent uniquement à distinguer un appareil/session.</div>';
    }

    function countErrors(rows, feature) {
        return rows.filter(function (r) {
            return isErrorRow(r) && (r.props || {}).feature === feature;
        }).length;
    }

    function sortDesc(a, b) {
        if (a.created_at === b.created_at) return 0;
        return a.created_at < b.created_at ? 1 : -1;
    }

    function renderFeaturePage(kind) {
        var rows = State.rows.filter(function (r) {
            if (kind === 'image') return r.event === 'image_generated';
            if (kind === 'video') return r.event === 'video_generated';
            if (kind === 'chat') return r.event === 'chat_used';
            if (kind === 'motion') return r.event === 'motion_generated' || (r.event === 'tab_view' && (r.props || {}).tab === 'motion');
            return false;
        });
        var errs = State.rows.filter(function (r) {
            return isErrorRow(r) && (r.props || {}).feature === kind;
        });
        var hourly = State.range === 'today';
        var total = rows.length + errs.length;

        if (kind === 'image') {
            $('kpi-images').innerHTML =
                kpi('Images générées', num(rows.length), 'modèles : ' + countBy(rows, function (r) { return (r.props || {}).model; }).length, 'image', COLORS.image) +
                kpi('Succès', num(rows.length), pct(rows.length, total) + '% de réussite', 'check_circle', COLORS.image, 'up') +
                kpi('Échecs', num(errs.length), errs.length ? 'à investiguer' : 'aucun incident', 'error', COLORS.error, errs.length ? 'down' : 'up') +
                kpi('Résolutions', num(countBy(rows, function (r) { return (r.props || {}).size; }).length), 'configurations distinctes', 'aspect_ratio', COLORS.chat);
            $('chart-images').innerHTML = chartHTML(eventPoints(rows, 'image', hourly), { barColor: COLORS.image });
            $('images-breakdown').innerHTML =
                '<div class="section-title">Par ratio</div>' + breakdownHTML(countBy(rows, function (r) { return (r.props || {}).ratio; })) +
                '<div class="section-title">Par style</div>' + breakdownHTML(countBy(rows, function (r) { return (r.props || {}).style; }), COLORS.video) +
                '<div class="section-title">Par source</div>' + breakdownHTML(countBy(rows, function (r) { return (r.props || {}).source || 'main'; }), COLORS.chat);
            $('images-table').innerHTML = tableHTML(
                [{ label: 'Modèle' }, { label: 'Résolution' }, { label: 'Ratio' }, { label: 'Style' }, { label: 'Occurrences', num: true }],
                aggregate(rows, function (r) {
                    var p = r.props || {};
                    return [p.model || '—', p.size || '—', p.ratio || '—', p.style || '—'];
                })
            );
        }

        if (kind === 'video') {
            $('kpi-videos').innerHTML =
                kpi('Vidéos générées', num(rows.length), 'segments inclus', 'movie', COLORS.video) +
                kpi('Succès', num(rows.length), pct(rows.length, total) + '% de réussite', 'check_circle', COLORS.video, 'up') +
                kpi('Échecs', num(errs.length), errs.length ? 'à investiguer' : 'aucun incident', 'error', COLORS.error, errs.length ? 'down' : 'up') +
                kpi('Modes utilisés', num(countBy(rows, function (r) { return (r.props || {}).mode; }).length), 'text/image/keyframes', 'tune', COLORS.chat);
            $('chart-videos').innerHTML = chartHTML(eventPoints(rows, 'video', hourly), { barColor: COLORS.video });
            $('videos-breakdown').innerHTML =
                '<div class="section-title">Par mode</div>' + breakdownHTML(countBy(rows, function (r) { return (r.props || {}).mode; }), COLORS.video) +
                '<div class="section-title">Par durée</div>' + breakdownHTML(countBy(rows, function (r) { var p = r.props || {}; return p.duration ? p.duration + 's' : '—'; }), COLORS.chat) +
                '<div class="section-title">Par segments</div>' + breakdownHTML(countBy(rows, function (r) { var p = r.props || {}; return p.segments ? p.segments + ' seg.' : '1'; }), COLORS.project);
            $('videos-table').innerHTML = tableHTML(
                [{ label: 'Modèle' }, { label: 'Mode' }, { label: 'Durée' }, { label: 'Segments' }, { label: 'Ratio' }, { label: 'Occurrences', num: true }],
                aggregate(rows, function (r) {
                    var p = r.props || {};
                    return [p.model || '—', p.mode || '—', p.duration ? p.duration + 's' : '—', p.segments || '1', p.ratio || '—'];
                })
            );
        }

        if (kind === 'chat') {
            var okRows = rows.filter(isSuccess);
            $('kpi-chat').innerHTML =
                kpi('Messages envoyés', num(rows.length), 'événements chat_used', 'forum', COLORS.chat) +
                kpi('Réussites', num(okRows.length), pct(okRows.length, rows.length) + '%', 'check_circle', COLORS.chat, 'up') +
                kpi('Erreurs', num(rows.length - okRows.length), 'côté API chat', 'error', COLORS.error, rows.length - okRows.length ? 'down' : 'up') +
                kpi('Sessions concernées', num(countKeys(rows, 'session_id')), 'sessions distinctes', 'sensors', COLORS.image);
            $('chart-chat').innerHTML = chartHTML(eventPoints(okRows, 'chat', hourly), { barColor: COLORS.chat });
            $('chat-summary').innerHTML = kvHTML([
                ['Messages', num(rows.length)],
                ['Succès', num(okRows.length)],
                ['Erreurs', num(rows.length - okRows.length)],
                ['Taux de réussite', pct(okRows.length, rows.length) + '%'],
                ['Visiteurs ayant utilisé le chat', num(countKeys(rows, 'visitor_id'))]
            ]);
            $('chat-feed').innerHTML = feedHTML(rows.slice().sort(sortDesc), 12);
        }

        if (kind === 'motion') {
            var opens = State.rows.filter(function (r) { return r.event === 'tab_view' && (r.props || {}).tab === 'motion'; });
            var gens = State.rows.filter(function (r) { return r.event === 'motion_generated'; });
            $('kpi-motion').innerHTML =
                kpi('Ouvertures onglet', num(opens.length), 'Motion Control consulté', 'open_in_new', COLORS.motion) +
                kpi('Générations', num(gens.length), gens.length ? '' : 'fonctionnalité à venir', 'animation', COLORS.video) +
                kpi('Visiteurs', num(countKeys(opens, 'visitor_id')), 'appareils distincts', 'group', COLORS.image) +
                kpi('Erreurs', num(State.rows.filter(function (r) { return isErrorRow(r) && (r.props || {}).feature === 'motion'; }).length), '—', 'error', COLORS.error);
            $('chart-motion').innerHTML = chartHTML(activityChartPoints(opens, hourly), { barColor: COLORS.motion });
        }
    }

    function countKeys(rows, key) {
        var m = {};
        rows.forEach(function (r) { m[r[key]] = true; });
        return Object.keys(m).length;
    }

    function aggregate(rows, keyFn) {
        var map = {};
        rows.forEach(function (r) {
            var key = keyFn(r).join('|');
            if (!map[key]) map[key] = { cells: keyFn(r), n: 0 };
            map[key].n++;
        });
        return Object.keys(map).map(function (k) { return map[k]; })
            .sort(function (a, b) { return b.n - a.n; })
            .map(function (o) { return o.cells.concat([num(o.n)]); });
    }

    function eventPoints(rows, event, hourly) {
        var buckets = bucketize(rows, hourly);
        var idx = {};
        rows.forEach(function (r) {
            var key = hourly ? hourKeyOf(r.created_at) : dayKeyOf(r.created_at);
            idx[key] = (idx[key] || 0) + 1;
        });
        return buckets.map(function (b) { return { label: b.label, bar: idx[b.key] || 0 }; });
    }

    function renderActivity() {
        var rows = State.rows.slice().sort(sortDesc);
        var f = State.activityFilter;
        if (f === 'image') rows = rows.filter(function (r) { return r.event === 'image_generated'; });
        else if (f === 'video') rows = rows.filter(function (r) { return r.event === 'video_generated'; });
        else if (f === 'chat') rows = rows.filter(function (r) { return r.event === 'chat_used'; });
        else if (f === 'error') rows = rows.filter(isErrorRow);
        else if (f === 'all') rows = rows.filter(function (r) { return r.event !== 'tab_view' && r.event !== 'page_view'; });

        $('activity-feed').innerHTML = feedHTML(rows, State.activityLimit);
        $('activity-more').style.display = rows.length > State.activityLimit ? '' : 'none';
    }

    function renderErrors() {
        var errs = State.rows.filter(isErrorRow);
        var grouped = {};
        errs.forEach(function (r) {
            var p = r.props || {};
            var feature = p.feature || (r.event === 'chat_used' ? 'chat' : (r.event === 'enhancer_used' ? 'enhancer' : 'autre'));
            var raw = String(p.detail || r.event || '').trim();
            var type = r.event === 'generation_error' ? 'GENERATION_ERROR'
                : (r.event === 'chat_used' ? 'CHAT_API_ERROR' : 'ENHANCER_API_ERROR');
            var norm = raw.replace(/\d{2,}/g, '#').slice(0, 70) || 'erreur sans détail';
            var key = feature + '|' + type + '|' + norm;
            if (!grouped[key]) grouped[key] = { feature: feature, type: type, sample: raw, count: 0, last: null };
            grouped[key].count++;
            if (!grouped[key].last || r.created_at > grouped[key].last) grouped[key].last = r.created_at;
        });
        var list = Object.keys(grouped).map(function (k) { return grouped[k]; })
            .sort(function (a, b) { return b.count - a.count; });

        var byFeature = {};
        list.forEach(function (g) { byFeature[g.feature] = (byFeature[g.feature] || 0) + g.count; });
        var featList = Object.keys(byFeature).sort(function (a, b) { return byFeature[b] - byFeature[a]; });

        $('kpi-errors').innerHTML =
            kpi('Erreurs totales', num(errs.length), State.range === 'today' ? "aujourd'hui" : 'sur la période', 'error', COLORS.error) +
            kpi('Types distincts', num(list.length), 'signatures regroupées', 'bug_report', COLORS.project) +
            kpi('Fonctionnalités touchées', num(featList.length), featList.slice(0, 2).join(', ') || '—', 'interests', COLORS.chat) +
            kpi('Dernière erreur', errs.length ? fmtTime(errs[0].created_at) : '—', errs.length ? fmtDateTime(errs[0].created_at) : 'aucune', 'schedule', COLORS.motion);

        $('errors-table').innerHTML = tableHTML(
            [{ label: 'Fonctionnalité' }, { label: 'Type' }, { label: 'Signature' }, { label: 'Occurrences', num: true }, { label: 'Dernière' }],
            list.slice(0, 50).map(function (g) {
                return [
                    '<span class="badge info">' + esc(g.feature) + '</span>',
                    '<span class="mono">' + esc(g.type) + '</span>',
                    '<span class="mono" title="' + esc(g.sample) + '">' + esc(g.sample.slice(0, 70) || '—') + '</span>',
                    num(g.count),
                    g.last ? fmtDateTime(g.last) : '—'
                ];
            })
        );

        $('chart-errors').innerHTML = chartHTML(State.rows.filter(isErrorRow).length
            ? bucketize(State.rows.filter(isErrorRow), State.range === 'today').map(function (b) { return { label: b.label, bar: b.total }; })
            : [], { barColor: COLORS.error });
    }

    /* ── Clé du fournisseur (passerelle) ──────────────────────────────────
       Écrite par l'admin ici, lue par la passerelle côté serveur (RLS :
       lecture/écriture réservées à la liste blanche, aucun droit pour anon). */
    function renderKeyCard() {
        var el = $('settings-key-status');
        if (!el) return;
        if (!State.client || !State.isAdmin) {
            el.innerHTML = kvHTML([['Statut', '<span class="badge err">réservé à l\'administrateur</span>']]);
            return;
        }
        el.innerHTML = kvHTML([['Statut', '<span class="badge">lecture…</span>']]);
        State.client.from('app_settings')
            .select('value, updated_at')
            .eq('key', 'provider_api_key')
            .then(function (res) {
                if (res && res.error) {
                    el.innerHTML = kvHTML([
                        ['Statut', '<span class="badge err">base non prête</span>'],
                        ['Détail', esc(friendlyAuthError(res.error.message)), true]
                    ]);
                    return;
                }
                var row = res && res.data && res.data[0];
                if (!row || !row.value) {
                    el.innerHTML = kvHTML([
                        ['Statut', '<span class="badge err">aucune clé enregistrée</span>'],
                        ['Source utilisée', 'secret serveur de la fonction (si présent)']
                    ]);
                    return;
                }
                el.innerHTML = kvHTML([
                    ['Statut', '<span class="badge ok">configurée</span>'],
                    ['Clé', '••••••••' + esc(String(row.value).slice(-4)), true],
                    ['Modifiée', row.updated_at ? fmtDateTime(row.updated_at) : '—']
                ]);
            })
            .catch(function (e) {
                el.innerHTML = kvHTML([
                    ['Statut', '<span class="badge err">lecture impossible</span>'],
                    ['Détail', esc((e && e.message) || 'réseau'), true]
                ]);
            });
    }

    function initKeyCard() {
        var save = $('provider-key-save');
        var clear = $('provider-key-clear');
        if (!save || !clear) return;
        save.addEventListener('click', function () {
            var input = $('provider-key-input');
            var v = (input.value || '').trim();
            if (v.length < 8) { toast('Clé trop courte : 8 caractères minimum.', 'error'); input.focus(); return; }
            if (!State.client || !State.isAdmin) { toast('Réservé à l\'administrateur.', 'error'); return; }
            save.disabled = true;
            State.client.from('app_settings')
                .upsert({ key: 'provider_api_key', value: v, updated_at: new Date().toISOString() }, { onConflict: 'key' })
                .then(function (res) {
                    save.disabled = false;
                    if (res && res.error) { toast('Enregistrement impossible : ' + friendlyAuthError(res.error.message), 'error'); return; }
                    input.value = '';
                    toast('Clé enregistrée — prise en compte sous une minute.', 'success');
                    renderKeyCard();
                })
                .catch(function (e) {
                    save.disabled = false;
                    toast('Enregistrement impossible : ' + ((e && e.message) || 'réseau'), 'error');
                });
        });
        clear.addEventListener('click', function () {
            if (!State.client || !State.isAdmin) { toast('Réservé à l\'administrateur.', 'error'); return; }
            State.client.from('app_settings')
                .delete()
                .eq('key', 'provider_api_key')
                .then(function (res) {
                    if (res && res.error) { toast('Retrait impossible : ' + friendlyAuthError(res.error.message), 'error'); return; }
                    toast('Clé retirée : la passerelle utilise le secret serveur.', 'success');
                    renderKeyCard();
                })
                .catch(function (e) {
                    toast('Retrait impossible : ' + ((e && e.message) || 'réseau'), 'error');
                });
        });
    }

    function renderSettings() {
        var c = window.LSV_CONFIG || {};
        var url = String(c.SUPABASE_URL || '');
        var meta = (State.user && State.user.user_metadata) || {};
        var fullName = meta.full_name || meta.name || '';
        $('settings-connection').innerHTML = kvHTML([
            ['Supabase configuré', isConfigured() ? '<span class="badge ok">oui</span>' : '<span class="badge err">non</span>'],
            ['URL', esc(url.replace(/^https?:\/\//, '')) || '—', true],
            ['Clé publique (anon)', isConfigured() ? esc(String(c.SUPABASE_ANON_KEY).slice(0, 10)) + '…' + esc(String(c.SUPABASE_ANON_KEY).slice(-4)) : '—', true],
            ['Bibliothèque Supabase', window.supabase ? '<span class="badge ok">chargée</span>' : '<span class="badge err">absente</span>'],
            ['Table', 'analytics_events', true]
        ]);
        $('settings-session').innerHTML = kvHTML([
            ['Compte', esc(fullName ? fullName + ' · ' + ((State.user && State.user.email) || '') : ((State.user && State.user.email) || '—'))],
            ['Liste blanche', State.isAdmin ? '<span class="badge ok">autorisé</span>' : '<span class="badge err">non</span>'],
            ['Identifiant', esc((State.user && State.user.id) || '—'), true],
            ['Session expire', State.session && State.session.expires_at
                ? fmtDateTime(new Date(State.session.expires_at * 1000).toISOString())
                : '—'],
            ['Événements chargés', num(State.rows.length)],
            ['Dernière synchro', State.syncedAt ? State.syncedAt.toLocaleTimeString('fr-FR') : '—']
        ]);
        renderKeyCard();
    }

    function renderAll() {
        try {
        if (State.page === 'overview') renderOverview();
        else if (State.page === 'images' || State.page === 'videos' || State.page === 'chat' || State.page === 'motion') {
            renderFeaturePage(State.page === 'images' ? 'image' : State.page === 'videos' ? 'video' : State.page);
        }
        else if (State.page === 'activity') renderActivity();
        else if (State.page === 'errors') renderErrors();
        else if (State.page === 'settings') renderSettings();
        } catch (e) { if (window.console) console.error(e); toast('Erreur de rendu : ' + e.message, 'error'); }
    }

    /* ── Navigation ─────────────────────────────────────────────────────── */
    function switchPage(page) {
        State.page = page;
        document.querySelectorAll('.nav-item').forEach(function (n) {
            n.classList.toggle('active', n.dataset.page === page);
        });
        document.querySelectorAll('.page').forEach(function (p) {
            p.classList.toggle('active', p.id === 'page-' + page);
        });
        var meta = PAGE_META[page] || { title: page, sub: '' };
        $('page-title').textContent = meta.title;
        $('page-sub').textContent = meta.sub;
        if (window.innerWidth <= 860) $('sidebar').classList.remove('open');
        renderAll();
    }

    function setRange(range) {
        State.range = range;
        document.querySelectorAll('.range-btn').forEach(function (b) {
            b.classList.toggle('active', b.dataset.range === range);
        });
        State.activityLimit = 50;
        load(false);
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        if (State.refreshSec > 0) {
            State.refreshTimer = setInterval(function () { load(false); }, State.refreshSec * 1000);
        }
    }
    function stopAutoRefresh() {
        if (State.refreshTimer) { clearInterval(State.refreshTimer); State.refreshTimer = null; }
    }

    /* ── Écouteurs ──────────────────────────────────────────────────────── */
    function bindUI() {
        document.querySelectorAll('.nav-item').forEach(function (n) {
            n.addEventListener('click', function () { switchPage(n.dataset.page); });
        });
        document.querySelectorAll('[data-goto]').forEach(function (b) {
            b.addEventListener('click', function () { switchPage(b.dataset.goto); });
        });
        document.querySelectorAll('.range-btn').forEach(function (b) {
            b.addEventListener('click', function () { setRange(b.dataset.range); });
        });
        $('refresh-btn').addEventListener('click', function () { load(true); });
        $('sidebar-toggle').addEventListener('click', function () { $('sidebar').classList.toggle('open'); });

        document.querySelectorAll('#activity-filters .chip').forEach(function (c) {
            c.addEventListener('click', function () {
                document.querySelectorAll('#activity-filters .chip').forEach(function (x) { x.classList.remove('active'); });
                c.classList.add('active');
                State.activityFilter = c.dataset.filter;
                State.activityLimit = 50;
                renderActivity();
            });
        });
        $('activity-more').addEventListener('click', function () {
            State.activityLimit += 50;
            renderActivity();
        });
        $('autorefresh-select').addEventListener('change', function (e) {
            State.refreshSec = parseInt(e.target.value, 10) || 0;
            startAutoRefresh();
            toast(State.refreshSec ? 'Actualisation automatique activée' : 'Actualisation automatique désactivée', 'success');
        });
    }

    /* ── Démarrage ──────────────────────────────────────────────────────── */
    function bootstrap() {
        initAuth();
        bindUI();

        if (!window.supabase) {
            showLogin('Bibliothèque Supabase introuvable (CDN inaccessible). Réessaie plus tard.', 'error');
            return;
        }
        if (!isConfigured()) {
            showLogin('Configuration Supabase absente : renseigne shared/config.js (URL + clé anon).', 'error');
            return;
        }
        try {
            State.client = window.supabase.createClient(
                window.LSV_CONFIG.SUPABASE_URL,
                window.LSV_CONFIG.SUPABASE_ANON_KEY,
                { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
            );
        } catch (e) {
            showLogin('Initialisation impossible : ' + e.message, 'error');
            return;
        }

        showLogin();
        State.client.auth.getSession().then(function (res) {
            var session = res && res.data ? res.data.session : null;
            if (session) {
                State.session = session;
                State.user = session.user;
                onSignedIn();
            }
        }).catch(function (e) {
            showLogin('Session illisible : ' + e.message, 'error');
        });

        State.client.auth.onAuthStateChange(function (event, session) {
            State.session = session || null;
            if (event === 'SIGNED_IN' && session) {
                State.user = session.user;
                if ($('admin-app').classList.contains('hidden')) onSignedIn();
            } else if (event === 'SIGNED_OUT') {
                State.user = null;
                showLogin('Session terminée.');
            } else if (event === 'TOKEN_REFRESHED') {
                if (session) State.user = session.user;
            }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
    else bootstrap();
})();
