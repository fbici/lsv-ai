/* ═══════════════════════════════════════════════════════════════════════════
   LSV.ai — Formulaire de contact (partagé par /contact/ et /a-propos/)
   ───────────────────────────────────────────────────────────────────────────
   Dépend UNIQUEMENT de shared/config.js (SUPABASE_URL, SUPABASE_ANON_KEY).
   Aucun framework, aucun appel vers un autre domaine que la Edge Function.

   Usage dans une page :
     <form data-contact="site|founder" ...>  ... </form>
     Scripts dans cet ordre : shared/config.js, puis shared/contact.js.
   L'auto-initialisation se fait au chargement : rien d'autre à faire.

   Sécurité / anti-abus :
   - champ piège (honeypot) rempli → la page affiche un succès, la fonction
     ignore silencieusement (les robots ne peuvent pas faire la différence) ;
   - horodatage d'ouverture du formulaire : envoi < 3 s = robot ;
   - le message n'est jamais envoyé « en clair » : il transite par la Edge
     Function, seule à connaître la clé de service et l'adresse du destinataire.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    var MSG = {
        sending: 'Envoi en cours…',
        success: 'Message bien reçu. Je te réponds sous 48 h.',
        rate: 'Trop de messages en peu de temps — réessaie dans quelques minutes.',
        invalid: 'Vérifie les champs : nom, e-mail, objet et message sont requis.',
        channel: 'Ce formulaire n’est pas disponible.',
        storage: 'Réception momentanément indisponible — réessaie dans un instant.',
        'not-configured': 'L’envoi n’est pas encore activé sur ce site.',
        network: 'Connexion impossible — réessaie dans un instant.'
    };

    var FALLBACK = {
        founder: 'salaousouleyman@gmail.com',
        site: 'lestudioviral@gmail.com'
    };

    function endpoint() {
        var cfg = window.LSV_CONFIG || {};
        var base = String(cfg.SUPABASE_URL || '').replace(/\/+$/, '');
        return base ? base + '/functions/v1/lsv-contact' : '';
    }

    function headers() {
        var cfg = window.LSV_CONFIG || {};
        return {
            'content-type': 'application/json',
            apikey: cfg.SUPABASE_ANON_KEY || '',
            Authorization: 'Bearer ' + (cfg.SUPABASE_ANON_KEY || '')
        };
    }

    function track(event, props) {
        try {
            if (window.LSVAnalytics && typeof window.LSVAnalytics.track === 'function') {
                window.LSVAnalytics.track(event, props);
            }
        } catch (e) { /* analytics : jamais bloquant */ }
    }

    function setStatus(form, kind, text) {
        var el = form.querySelector('[data-contact-status]');
        if (!el) return;
        el.className = 'ct-status' + (kind ? ' is-' + kind : '');
        el.innerHTML = text || '';
        el.hidden = !text;
    }

    function val(form, name) {
        var el = form.querySelector('[name="' + name + '"]');
        return el ? String(el.value || '').trim() : '';
    }

    function fillInvalid(form, message) {
        setStatus(form, 'error', message);
        var first = null;
        var fields = form.querySelectorAll('[name]');
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            if (f.getAttribute('type') === 'hidden' || f.classList.contains('ct-hp')) continue;
            var empty = f.hasAttribute('required') && !String(f.value || '').trim();
            f.classList.toggle('ct-invalid', !!empty);
            if (empty && !first) first = f;
        }
        if (first) { try { first.focus(); } catch (e) {} }
    }

    /* ── Envoi ─────────────────────────────────────────────────────────── */
    function submit(form, opts) {
        opts = opts || {};
        var channel = form.getAttribute('data-contact') || opts.channel || 'site';
        var payload = {
            channel: channel,
            name: val(form, 'name'),
            email: val(form, 'email'),
            subject: val(form, 'subject'),
            message: val(form, 'message'),
            website: val(form, 'website'),
            t0: form.__lsvT0 || 0
        };

        var btn = form.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
        setStatus(form, 'busy', MSG.sending);

        var url = endpoint();
        if (!url) {
            if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
            return Promise.resolve(done(form, { ok: false, reason: 'not-configured' }, channel, btn));
        }

        return fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(payload) })
            .then(function (res) {
                return res.json().then(
                    function (body) { return { status: res.status, body: body || {} }; },
                    function () { return { status: res.status, body: {} }; }
                );
            })
            .then(function (r) {
                if (r.body && r.body.ok === true) return done(form, { ok: true }, channel, btn);
                return done(form, { ok: false, reason: (r.body && r.body.reason) || 'network' }, channel, btn);
            })
            .catch(function () {
                return done(form, { ok: false, reason: 'network' }, channel, btn);
            });
    }

    function done(form, result, channel, btn) {
        if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }

        if (result.ok) {
            setStatus(form, 'ok', MSG.success);
            track('contact_submitted', { source: channel, status: 'success' });
            form.reset();
            form.__lsvT0 = Date.now();
            form.classList.add('ct-sent');
            return result;
        }

        track('contact_submitted', { source: channel, status: 'failed', reason: String(result.reason || '') });
        var text = MSG[result.reason] || MSG.network;
        if (result.reason === 'invalid' || result.reason === 'channel') {
            fillInvalid(form, text);
            return result;
        }
        setStatus(form, 'error', text);
        if (result.reason === 'not-configured') {
            var to = FALLBACK[channel] || FALLBACK.site;
            setStatus(form, 'error',
                text + ' Écris-nous directement à <a href="mailto:' + to + '">' + to + '</a>.');
        }
        return result;
    }

    /* ── Initialisation ────────────────────────────────────────────────── */
    function init(form) {
        if (!form || form.__lsvContact) return form;
        form.__lsvContact = true;
        form.__lsvT0 = Date.now();

        form.setAttribute('novalidate', 'novalidate');
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            submit(form);
        });

        /* Efface l'erreur d'un champ dès qu'on le retouche. */
        var fields = form.querySelectorAll('[name]');
        for (var i = 0; i < fields.length; i++) {
            (function (f) {
                f.addEventListener('input', function () { f.classList.remove('ct-invalid'); });
            })(fields[i]);
        }
        return form;
    }

    function initAll(root) {
        var scope = root || document;
        if (!scope.querySelectorAll) return;
        var forms = scope.querySelectorAll('form[data-contact]');
        for (var i = 0; i < forms.length; i++) init(forms[i]);
    }

    window.LSVContact = { init: init, submit: submit, endpoint: endpoint, messages: MSG };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { initAll(document); });
    } else {
        initAll(document);
    }
})();
