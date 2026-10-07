/* ═══════════════════════════════════════════════════════════════════════════
   LSV.ai — Configuration partagée (frontend + back-office)
   ───────────────────────────────────────────────────────────────────────────
   Ce fichier contient UNIQUEMENT des identifiants publics :
   - SUPABASE_URL      : URL du projet Supabase (public)
   - SUPABASE_ANON_KEY : clé "anon" publique (conçue pour être embarquée dans
                         le navigateur). Ce n'est PAS un secret serveur.

   La sécurité réelle repose sur :
   - les politiques Row Level Security (insert anonyme UNIQUEMENT, lecture
     réservée aux comptes authentifiés) -> voir supabase/schema.sql ;
   - Supabase Auth (mots de passe hachés côté serveur, JWT) pour /admin.

   Le "service_role" key et le mot de passe base de données ne doivent JAMAIS
   apparaître ici ni dans aucun fichier du dépôt.

   - LSV_GATEWAY_URL    : URL de la LSV API Gateway (Edge Function Supabase).
                          C'est la SEULE porte de sortie vers le fournisseur de
                          génération : la clé du fournisseur est injectée côté
                          serveur et n'apparaît JAMAIS ici.

   Valeurs par défaut = non configuré. Tant qu'elles ne sont pas remplacées :
   - les Analytics deviennent silencieusement inactifs (LSV.ai fonctionne) ;
   - le back-office affiche la page de connexion sans données ;
   - la génération est désactivée (boutons inactifs).
   ═══════════════════════════════════════════════════════════════════════════ */
window.LSV_CONFIG = {
    SUPABASE_URL: 'https://umhsxebemspyyqrecsuq.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtaHN4ZWJlbXNweXlxcmVjc3VxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMzQ4NjUsImV4cCI6MjEwNjgxMDg2NX0.uw6qJpProtm2iNEUB0-f9SkDh_9qZKkyYTb4hDziQBg',
    LSV_GATEWAY_URL: 'https://umhsxebemspyyqrecsuq.supabase.co/functions/v1/lsv-gateway'
};
