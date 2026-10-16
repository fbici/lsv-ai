/* ═══════════════════════════════════════════════════════════════════════════
   LSV Contact — modèles d'e-mails (HTML + texte brut)
   ───────────────────────────────────────────────────────────────────────────
   Deux messages :
     • notification  → à LeStudioViral / Salaou Souleyman quand quelqu'un écrit ;
     • accusé        → à l'expéditeur, automatique.
   Même identité visuelle que les modèles Supabase Auth du dépôt
   (supabase/email-confirm-signup.html) : fond #f4f4f2, carte blanche,
   bandeau #18181b, accent #0d9488, Inter + Space Grotesk.
   Styles en ligne uniquement : c'est un e-mail.
   ═══════════════════════════════════════════════════════════════════════════ */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
}

const BRAND = 'LSV<span style="color:#0d9488;">.ai</span>';

function shell(o) {
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f2;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;margin:0;padding:24px 12px;width:100%;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;background:#ffffff;border:1px solid #e8e8e4;border-radius:16px;overflow:hidden;">
<tr><td style="background:#18181b;padding:20px 26px;">
<span style="font-family:'Space Grotesk','Inter',sans-serif;font-size:22px;font-weight:800;letter-spacing:-.5px;color:#ffffff;">${BRAND}</span>
<span style="float:right;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#0d9488;background:#0f2e2b;border:1px solid #14524c;border-radius:999px;padding:4px 10px;">${esc(o.badge)}</span>
</td></tr>
<tr><td style="padding:26px 26px 8px 26px;">
<h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:700;color:#18181b;">${o.heading}</h1>
${o.body}
</td></tr>
<tr><td style="background:#f4f4f2;border-top:1px solid #e8e8e4;padding:16px 26px;">
<p style="margin:0;font-size:12px;line-height:1.6;color:#8a8a94;">${o.footer}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function kv(label, value) {
    return `<tr>
<td style="padding:10px 14px;border-bottom:1px solid #f0f0ed;vertical-align:top;width:118px;font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#8a8a94;">${esc(label)}</td>
<td style="padding:10px 14px;border-bottom:1px solid #f0f0ed;vertical-align:top;font-size:14px;line-height:1.6;color:#18181b;word-break:break-word;">${value}</td></tr>`;
}

const FOOT = `<strong style="color:#52525b;">LeStudioViral</strong> — Studio de création de contenu IA.<br>
Ce message est envoyé automatiquement via LSV.ai · <a href="https://fbici.github.io/lsv-ai/" style="color:#0d9488;">fbici.github.io/lsv-ai</a>`;

/* ── 1. Notification à LeStudioViral ────────────────────────────────────── */
export function notificationHtml(c) {
    const who = `${esc(c.name)} &lt;<a href="mailto:${esc(c.email)}" style="color:#0d9488;">${esc(c.email)}</a>&gt;`;
    return shell({
        title: 'Nouveau message de contact',
        badge: 'Contact',
        heading: 'Nouveau message reçu',
        body: `
<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#52525b;">Quelqu'un vient d'écrire via le formulaire de contact de LSV.ai.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#fafaf9;border:1px solid #e8e8e4;border-radius:12px;border-collapse:collapse;">
${kv('Source', esc(c.channelLabel))}
${kv('Expéditeur', who)}
${kv('Objet', esc(c.subject))}
${kv('Reçu le', esc(new Date(c.receivedAt).toLocaleString('fr-FR', { timeZone: 'UTC' })) + ' UTC')}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-top:16px;background:#f0fdfa;border:1px solid #ccfbf1;border-radius:12px;">
<tr><td style="padding:16px;font-size:14px;line-height:1.7;color:#18181b;white-space:pre-wrap;">${esc(c.body)}</td></tr>
</table>
<p style="margin:18px 0 8px 0;">
<a href="mailto:${esc(c.email)}?subject=${encodeURIComponent('Re : ' + c.subject)}" style="display:inline-block;background:#0d9488;border-radius:10px;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Répondre à ${esc(c.name)}</a>
</p>`,
        footer: FOOT
    });
}

export function notificationText(c) {
    return [
        'Nouveau message reçu via LSV.ai',
        '',
        'Source    : ' + c.channelLabel,
        'Expéditeur: ' + c.name + ' <' + c.email + '>',
        'Objet     : ' + c.subject,
        'Reçu le   : ' + new Date(c.receivedAt).toISOString(),
        '',
        '---- Message ----',
        c.body,
        '',
        '----',
        'Répondre : mailto:' + c.email
    ].join('\n');
}

/* ── 2. Accusé de réception à l'expéditeur ──────────────────────────────── */
export function autoReplyHtml(c) {
    const founder = c.channel === 'founder'
        ? `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#52525b;">
             Ton message est bien arrivé chez <strong style="color:#18181b;">Salaou Souleyman</strong>,
             fondateur de <strong style="color:#18181b;">LeStudioViral</strong>. Il revient vers toi
             personnellement, généralement sous 48 heures.</p>`
        : `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#52525b;">
             Ton message est bien arrivé chez l'équipe <strong style="color:#18181b;">LeStudioViral</strong>.
             Nous revenons vers toi sous 48 heures ouvrées.</p>`;
    return shell({
        title: 'Message bien reçu',
        badge: 'Reçu',
        heading: 'Merci, on a bien reçu ton message.',
        body: `
${founder}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#fafaf9;border:1px solid #e8e8e4;border-radius:12px;border-collapse:collapse;">
${kv('Objet', esc(c.subject))}
${kv('Reçu le', esc(new Date(c.receivedAt).toLocaleString('fr-FR', { timeZone: 'UTC' })) + ' UTC')}
</table>
<p style="margin:18px 0 8px 0;font-size:14px;line-height:1.6;color:#8a8a94;">
En attendant, découvre le studio : <a href="https://fbici.github.io/lsv-ai/" style="color:#0d9488;">ouvrir LSV.ai</a>
· <a href="https://fbici.github.io/lsv-ai/a-propos/" style="color:#0d9488;">À propos de LeStudioViral</a></p>`,
        footer: FOOT
    });
}

export function autoReplyText(c) {
    return [
        'Merci, on a bien reçu ton message.',
        '',
        'Objet    : ' + c.subject,
        'Reçu le  : ' + new Date(c.receivedAt).toISOString(),
        '',
        'Nous revenons vers toi sous 48 heures.',
        '',
        'LSV.ai — https://fbici.github.io/lsv-ai/'
    ].join('\n');
}
