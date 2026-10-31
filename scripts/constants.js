/* ═══════════════════════════════════════════════════════════════════════════
   LSV.AI — Version finale
   ═══════════════════════════════════════════════════════════════════════════ */

/* Toutes les requêtes de génération passent par la LSV API Gateway.
   Le fournisseur final et sa clé restent côté serveur (jamais ici). */
const GATEWAY_URL = String((window.LSV_CONFIG && window.LSV_CONFIG.LSV_GATEWAY_URL) || '').replace(/\/+$/, '');

const CONFIG = Object.freeze({
    GATEWAY_READY: /^https?:\/\//.test(GATEWAY_URL),
    API_BASE: GATEWAY_URL ? GATEWAY_URL + '/v1' : '',
    POLL_BASE: GATEWAY_URL ? GATEWAY_URL + '/agnesapi' : '',
    MODEL_IMAGE: 'agnes-image-2.1-flash',
    /* Le fournisseur renvoie un 503 générique pour tout modèle inconnu — ce
       qui se traduisait par « Impossible de générer le contenu » sur TOUTES
       les vidéos. La liste réelle se lit via GET /v1/models ; ne jamais
       renommer sans la vérifier. */
    MODEL_VIDEO: 'agnes-video-2.5-flash',
    /* `mode` est OBLIGATOIRE côté fournisseur (« invalid mode » sinon) et le
       fournisseur ne liste jamais les valeurs admises — établies par
       élimination (§2.16). Deux seules valeurs connues, incompatibles :
         - `text`     : génération depuis le prompt SEUL. Tout champ média est
                        alors refusé (« text mode cannot include media
                        fields ») — ce qui interdit d'y accoler une image.
         - `keyframe` : génération guidée par une image de départ, portée par
                        le champ `first_frame` (et non `image`), avec une
                        image d'arrivée facultative en `last_frame`.
       Les champs `num_frames`, `frame_rate` et `n` sont INTERDITS. Aucun de
       ces champs ne règle donc la durée. */
    VIDEO_MODE_TEXT: 'text',
    VIDEO_MODE_KEYFRAME: 'keyframe',
    MODEL_CHAT: 'agnes-2.5-flash',
    /* Modèles proposés dans le sélecteur du chat.
       `id` = modèle DÉCLARÉ dans le corps de la requête ; c'est lui qui
       décide de la destination côté passerelle (« mistral-* » → api.mistral.ai,
       sinon Agnes). `provider` n'est qu'un libellé affiché.
       Aucune clé ni URL de fournisseur n'apparaît ici : tout se règle côté
       serveur (back-office), jamais dans le navigateur. */
    CHAT_MODELS: Object.freeze([
        { id: 'agnes-2.5-flash', label: 'Standard (intégré)', provider: 'agnes' },
        { id: 'mistral-small-2603', label: 'Mistral Small 4', provider: 'mistral' }
    ]),
    MAX_IMAGE_DIMENSION: 4096,
    MAX_IMAGE_SIZE: 12 * 1024 * 1024,
    VIDEO_INTERVAL_MIN: 62000,
    VIDEO_FIRST_POLL_DELAY_SEC: 80,
    VIDEO_POLL_INTERVALS: [8, 8, 12, 12, 20, 20, 25],
    VIDEO_MAX_POLL_ATTEMPTS: 100,
    RETRY_MAX_ATTEMPTS: 7,
    RETRY_429_WAITS: [10, 20, 35, 50, 75, 100, 150],
    RETRY_503_WAITS: [5, 10, 15, 20, 30, 45],
    RETRY_NETWORK_WAITS: [3, 5, 8, 12, 20, 30],
    CHAT_MAX_TOKENS: 3000,
    CHAT_TEMPERATURE: 0.7,
    CHAT_CONTEXT_MESSAGES: 20,
    DEBUG_MAX_ENTRIES: 500,
    HISTORY_MAX_ENTRIES: 500,
    BATCH_MAX_CONCURRENT: 2
});

const STORAGE_KEYS = Object.freeze({
    TIMING: 'lsv4_timing',
    WAKELOCK: 'lsv4_wakelock',
    COUNTERS: 'lsv4_counters',
    PROJECTS: 'lsv4_projects',
    ASSETS: 'lsv4_assets',
    HISTORY: 'lsv4_history',
    CONVERSATIONS: 'lsv4_conversations',
    THEME: 'lsv4_theme',
    LOCKS: 'lsv4_locks',
    AUTODOWNLOAD: 'lsv4_autodownload',
    SIDEBAR_COLLAPSED: 'lsv4_sidebar_collapsed',
    /* Dernier état du service vidéo (bandeau de l'onglet Vidéo) : conservé
       pour afficher un état juste immédiatement au chargement, avant la
       première sonde. */
    VIDEO_AVAIL: 'lsv4_video_avail'
});

const STYLES = Object.freeze([
    { id: 'photoreal', name: 'Photoréaliste', icon: 'photo_camera', desc: 'Ultra détaillé', prompt: 'photorealistic, ultra-detailed, natural lighting, 8K quality, hyperrealistic textures' },
    { id: 'cinematic', name: 'Cinématique', icon: 'movie', desc: 'Look film', prompt: 'cinematic film look, dramatic lighting, shallow depth of field, anamorphic lens, film grain, professional color grading' },
    { id: 'luxury', name: 'Luxe', icon: 'diamond', desc: 'Premium, raffiné', prompt: 'luxurious aesthetic, premium quality, elegant lighting, sophisticated composition, high-end commercial style' },
    { id: 'product', name: 'Pub produit', icon: 'shopping_bag', desc: 'Commercial', prompt: 'professional product photography, commercial advertising style, clean composition, dramatic product lighting, premium studio setup' },
    { id: 'fashion', name: 'Mode', icon: 'checkroom', desc: 'Editorial', prompt: 'fashion editorial, high-fashion photography, striking poses, dramatic lighting, magazine cover quality, elegant styling' },
    { id: 'architecture', name: 'Architecture', icon: 'apartment', desc: 'Espace, forme', prompt: 'architectural photography, clean lines, natural light, wide angle, professional real estate style, minimalist composition' },
    { id: 'documentary', name: 'Documentaire', icon: 'videocam', desc: 'Réaliste, brut', prompt: 'documentary style, authentic, natural lighting, candid moment, realistic textures, film grain' },
    { id: '3d', name: 'Rendu 3D', icon: 'view_in_ar', desc: 'Octane / UE5', prompt: '3D render, octane render, volumetric lighting, subsurface scattering, Unreal Engine 5 quality' },
    { id: 'pixar', name: 'Animation 3D', icon: 'emoji_emotions', desc: 'Pixar / Disney', prompt: 'Pixar-style 3D animation, Disney animation style, stylized characters, soft global illumination, vibrant colors' },
    { id: 'anime', name: 'Anime Ghibli', icon: 'forest', desc: 'Style Miyazaki', prompt: 'Studio Ghibli anime style, hand-painted watercolor backgrounds, Hayao Miyazaki aesthetic, cel-shaded characters' },
    { id: 'manga', name: 'Manga N&B', icon: 'menu_book', desc: 'Ink, trames', prompt: 'black and white manga style, stark ink outlines, dramatic screentones, Japanese comic aesthetic' },
    { id: 'watercolor', name: 'Aquarelle', icon: 'brush', desc: 'Peinture douce', prompt: 'watercolor painting, soft bleeding edges, paper texture, translucent washes, artistic' },
    { id: 'oil', name: 'Peinture huile', icon: 'palette', desc: 'Maîtres anciens', prompt: 'classical oil painting, impasto brushstrokes, old master technique, canvas texture' },
    { id: 'noir', name: 'Film noir', icon: 'movie_filter', desc: 'N&B vintage', prompt: 'vintage film noir, black and white, high contrast, film grain, 1940s Hollywood lighting' },
    { id: 'cyberpunk', name: 'Cyberpunk', icon: 'nightlife', desc: 'Néon futuriste', prompt: 'cyberpunk aesthetic, neon pink and cyan lighting, rain-slicked streets, Blade Runner atmosphere' },
    { id: 'fantasy', name: 'Fantasy', icon: 'auto_awesome', desc: 'Épique magique', prompt: 'epic fantasy art, magical atmosphere, dramatic lighting, intricate details, concept art quality' },
    { id: 'minimal', name: 'Minimaliste', icon: 'crop_square', desc: 'Épuré', prompt: 'minimalist design, clean composition, negative space, muted palette, elegant simplicity' },
    { id: 'social', name: 'Réseaux sociaux', icon: 'smartphone', desc: 'Vertical viral', prompt: 'social media optimized, vertical composition, vibrant eye-catching colors, trendy aesthetic, high engagement style' }
]);

const IMG_RES = Object.freeze({
    '1K': { '16:9': '1312x736', '9:16': '736x1312', '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152' },
    '2K': { '16:9': '2624x1472', '9:16': '1472x2624', '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304' },
    '3K': { '16:9': '3936x2208', '9:16': '2208x3936', '1:1': '3072x3072', '4:3': '3456x2592', '3:4': '2592x3456' }
});

const VID_RES = Object.freeze({
    '720P': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '960x960' },
    '1080P': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1440x1440' },
    '2K': { '16:9': '2560x1440', '9:16': '1440x2560', '1:1': '1920x1920' }
});

/* Ratios proposés à l'utilisateur, avec les proportions réelles (`w`/`h`)
   pour dessiner un rectangle-aperçu, et l'usage courant pour le libellé.
   L'ordre est celui de l'interface (le vertical d'abord, cible principale). */
const RATIOS = Object.freeze([
    { id: '9:16', w: 9, h: 16, use: 'TikTok · Reels · Shorts' },
    { id: '16:9', w: 16, h: 9, use: 'YouTube · Paysage' },
    { id: '1:1', w: 1, h: 1, use: 'Publication carrée' },
    { id: '4:3', w: 4, h: 3, use: 'Classique paysage' },
    { id: '3:4', w: 3, h: 4, use: 'Classique portrait' }
]);

const ENHANCER_STYLE_PROMPTS = {
    cinematic: 'cinematic film look, dramatic lighting, shallow depth of field, anamorphic lens, film grain, professional color grading',
    photoreal: 'photorealistic, ultra-detailed, natural lighting, 8K quality, hyperrealistic textures',
    luxury: 'luxurious aesthetic, premium quality, elegant lighting, sophisticated composition',
    product: 'professional product photography, commercial advertising style, dramatic product lighting, premium studio setup',
    fashion: 'fashion editorial, high-fashion photography, magazine cover quality, elegant styling',
    architecture: 'architectural photography, clean lines, natural light, professional composition',
    anime: 'Studio Ghibli anime style, hand-painted watercolor backgrounds, cel-shaded characters',
    '3d': '3D render, octane render, volumetric lighting, subsurface scattering, Unreal Engine 5 quality',
    fantasy: 'epic fantasy art, magical atmosphere, dramatic lighting, intricate details, concept art',
    cyberpunk: 'cyberpunk aesthetic, neon pink and cyan lighting, rain-slicked streets, Blade Runner atmosphere',
    documentary: 'documentary style, authentic, natural lighting, candid moment, realistic textures',
    social: 'social media optimized, vertical composition, vibrant colors, trendy aesthetic'
};

const WORKFLOWS = Object.freeze([
    { id: 'image-quick', name: 'Image rapide', icon: 'bolt', desc: 'Idée → Prompt → Style → Image → Bibliothèque', steps: ['Idée', 'Prompt', 'Style', 'Image', 'Sauvegarde'], target: 'image' },
    { id: 'video-story', name: 'Vidéo narrative', icon: 'movie', desc: 'Idée → Concept → Storyboard → Prompts → Génération → Projet', steps: ['Idée', 'Concept', 'Storyboard', 'Prompts', 'Vidéo', 'Projet'], target: 'storyboard' },
    { id: 'product-ad', name: 'Publicité produit', icon: 'shopping_bag', desc: 'Produit → Concept → Scènes → Images → Vidéo', steps: ['Produit', 'Concept', 'Scènes', 'Images', 'Vidéo'], target: 'chat' },
    { id: 'social-tiktok', name: 'TikTok viral', icon: 'smartphone', desc: 'Idée → Hook → Scènes → Visuels → Vidéo', steps: ['Idée', 'Hook', 'Scènes', 'Visuels', 'Vidéo'], target: 'chat' },
    { id: 'thumb-youtube', name: 'Miniature YouTube', icon: 'play_circle', desc: 'Sujet → Concept → Génération → Bibliothèque', steps: ['Sujet', 'Concept', 'Image', 'Sauvegarde'], target: 'image' },
    { id: 'character', name: 'Personnage', icon: 'person', desc: 'Concept → Character Lock → Plusieurs scènes', steps: ['Concept', 'Lock', 'Scènes', 'Images'], target: 'locks' }
]);

const LOCK_TYPES = Object.freeze([
    { id: 'character', name: 'Personnage', icon: 'person', desc: 'Nom, visage, coiffure, vêtements — cohérents entre toutes les scènes' },
    { id: 'product', name: 'Produit', icon: 'shopping_bag', desc: 'Forme, couleur, matériaux — identiques sur toutes les images' },
    { id: 'environment', name: 'Environnement', icon: 'landscape', desc: 'Architecture, lumière, ambiance — même lieu à chaque plan' }
]);

/* ── Studio de scénarios IA : les trois formats proposés ────────────────────
   Le mode change la CONSIGNE envoyée au modèle (longueur, structure), jamais
   le contrat de sortie : dans les trois cas le modèle répond en JSON
   { title, logline, scenes[] }, sinon rien ne serait affichable ni
   transmissible au Storyboard. Les valeurs de `id` servent d'identifiants
   de test et de journal, pas de texte affiché. */
const SCENARIO_MODES = Object.freeze([
    {
        id: 'court', name: 'Format court', icon: 'bolt',
        desc: 'Synopsis + 3 à 5 scènes',
        brief: 'Format court : un synopsis percutant, puis 3 à 5 scènes maximum, chacune tournable en une seule prise.'
    },
    {
        id: 'long', name: 'Format long', icon: 'history_edu',
        desc: 'Actes, arc narratif, scènes détaillées',
        brief: 'Format long : découpe en trois actes, un arc narratif clair (déclencheur, montée, résolution), 8 à 12 scènes détaillées, chaque scène portant son numéro d\'acte.'
    },
    {
        id: 'storyboard', name: 'Storyboard', icon: 'splitscreen',
        desc: 'Plans : image, mouvement, dialogue',
        brief: 'Storyboard : chaque scène devient une série de plans précis — champ, mouvement de caméra, son ou dialogue — pour être dessinée image par image.'
    }
]);

/* ── Alternatives vidéo externes (centre de l'onglet Vidéo) ────────────────
   Affiché quand le service vidéo intégré est saturé ou injoignable. Ce sont
   des SITES WEB gratuits : LSV.ai n'appelle jamais leur API, n'envoie aucun
   de leurs comptes, et l'utilisateur ouvre un nouvel onglet de son côté.

   RÈGLES DE VÉRITÉ, appliquées à chaque champ :
     - `free`   : quota gratuit tel qu'annoncé sur LA PAGE OFFICIELLE
                  indiquée dans `source` — jamais une estimation ;
     - `i2v` / `watermark` / `license` : « oui », « non » ou
                  « non vérifié » — on n'invente jamais une valeur ;
     - `source` : URL exacte où le quota a été lu (la carte l'affiche) ;
     - `checked`: date de la vérification.
   Le quota GRATUIT DU SITE n'a rien à voir avec le quota de l'API : c'est
   toujours le premier qui est annoncé ici. Aucun service n'est présenté
   comme gratuit s'il ne l'est pas vérifié — Pika et Luma ont été écartés
   (offre gratuite inexistante ou payante), de même que Sora (service
   arrêté en 2026). Google Flow (Veo) fait exception : ses « 50 crédits par
   jour, avec ou sans abonnement » sont écrits sur la page officielle des
   crédits, ce qui le remet au catalogue en tête — meilleure qualité
   gratuite actuellement disponible. */

const ALT_CHECKED = '25 octobre 2026';
const VIDEO_ALTERNATIVES = Object.freeze([
    {
        id: 'flow', name: 'Google Flow',
        url: 'https://flow.google.com/',
        source: 'https://support.google.com/flow/answer/16526234',
        free: '50 crédits par jour, avec ou sans abonnement (non reportés, recharge au 1er usage)',
        i2v: 'non vérifié',
        watermark: 'oui', watermarkNote: 'SynthID invisible ; filigrane visible paramétrable',
        license: 'non vérifié', licenseNote: 'selon les conditions du service',
        note: 'Meilleure qualité gratuite actuelle (Veo) ; vidéo sans abonnement indisponible aux heures de pointe (14h-17h UTC).'
    },
    {
        id: 'pixverse', name: 'PixVerse',
        url: 'https://app.pixverse.ai/',
        source: 'https://app.pixverse.ai/subscribe',
        free: '30 crédits par jour (reset 00:00 UTC), + 60 au départ',
        i2v: 'oui',
        watermark: 'oui', watermarkNote: 'sans filigrane dès le plan Standard',
        license: 'non vérifié', licenseNote: 'selon les conditions du service',
        note: 'Offre gratuite de base la plus régulière.'
    },
    {
        id: 'vidu', name: 'Vidu',
        url: 'https://www.vidu.com/',
        source: 'https://www.vidu.com/ai-video-generator',
        free: '40 crédits par mois pour tous les comptes',
        i2v: 'non vérifié',
        watermark: 'oui', watermarkNote: 'en 720p',
        license: 'non', licenseNote: 'usage non commercial',
        note: 'Crédits mensuels, vidéo limitée en qualité.'
    },
    {
        id: 'hailuo', name: 'Hailuo (MiniMax)',
        url: 'https://hailuoai.video/',
        source: 'https://hailuoai.video/doc/payment-policy.html',
        free: 'file standard gratuite + crédits d\'accueil',
        i2v: 'non vérifié',
        watermark: 'oui', watermarkNote: 'offre gratuite',
        license: 'non', licenseNote: 'usage non commercial',
        note: 'Crédits d\'accueil à durée de vie limitée.'
    },
    {
        id: 'kling', name: 'Kling',
        url: 'https://klingai.com/',
        source: 'https://kling.ai/docs/point-policy',
        free: 'plan Basic gratuit à vie (crédits mensuels de connexion)',
        i2v: 'non vérifié',
        watermark: 'oui', watermarkNote: '',
        license: 'non', licenseNote: 'plan Basic : usage non commercial',
        note: 'Crédits régénérés chaque mois.'
    },
    {
        id: 'runway', name: 'Runway',
        url: 'https://runwayml.com/',
        source: 'https://runwayml.com/pricing',
        free: '125 crédits, une seule fois',
        i2v: 'non vérifié',
        watermark: 'non vérifié', watermarkNote: '',
        license: 'non vérifié', licenseNote: '',
        note: 'Crédits de bienvenue, pas de renouvellement.'
    }
]);

