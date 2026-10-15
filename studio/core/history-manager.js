/* ═══════════════════════════════════════════════════════════════════════════
   LSV Studio — historique annuler / rétablir
   Pile d'états de projet. Une « entrée » est un instantané JSON (profond) du
   projet AVANT une opération. Simple et infaillible : pas de delta à
   calculer, donc pas de désynchronisation possible entre l'historique et
   l'état réel.

   Protocole :
     begin(project)  → empile l'état courant (toujours).
     … mutation …
     commit(project) → si l'état final est IDENTIQUE à l'état empilé,
                       l'entrée est retirée (une opération sans effet ne
                       doit pas consommer un niveau d'annulation).

   Budget : 60 entrées max (§13.4).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    const S = (window.LSVStudio = window.LSVStudio || {});

    const MAX = 60;

    const HistoryManager = {
        _undo: [],
        _redo: [],
        _pending: false,

        /* Réinitialise (changement de projet). */
        reset() {
            this._undo = [];
            this._redo = [];
            this._pending = false;
        },

        _snap(project) {
            return JSON.stringify(project);
        },

        /* Empile l'état AVANT une opération. À appeler avant de muter. */
        begin(project) {
            this._undo.push(this._snap(project));
            if (this._undo.length > MAX) this._undo.shift();
            /* Une nouvelle opération invalide la branche « rétablir ». */
            this._redo = [];
            this._pending = true;
        },

        /* Signale la fin de l'opération. Retire l'entrée si rien n'a changé. */
        commit(project) {
            const snap = this._snap(project);
            if (this._pending && this._undo.length &&
                this._undo[this._undo.length - 1] === snap) {
                this._undo.pop();
            }
            this._pending = false;
        },

        /* Variante pratique : capture, exécute, commit. Renvoie le résultat
           de `fn`. */
        run(project, fn) {
            this.begin(project);
            const r = fn();
            this.commit(project);
            return r;
        },

        /* ── Annuler ────────────────────────────────────────────────────── */
        /* Renvoie le projet restauré, ou null si la pile est vide. */
        undo(current) {
            if (!this._undo.length) return null;
            const prev = this._undo.pop();
            this._redo.push(this._snap(current));
            return JSON.parse(prev);
        },

        redo(current) {
            if (!this._redo.length) return null;
            const next = this._redo.pop();
            this._undo.push(this._snap(current));
            return JSON.parse(next);
        },

        canUndo() { return this._undo.length > 0; },
        canRedo() { return this._redo.length > 0; },

        /* Met à jour l'état des boutons de la barre supérieure. */
        syncButtons() {
            const u = document.getElementById('sv-undo');
            const r = document.getElementById('sv-redo');
            if (u) u.disabled = !this.canUndo();
            if (r) r.disabled = !this.canRedo();
        }
    };

    S.HistoryManager = HistoryManager;
})();
