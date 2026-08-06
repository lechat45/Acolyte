// Learn more: https://docs.val.town/vals/cron/
// ===========================================================
// ACOLYTE — CRON DU BLOG
// À coller dans un val de type CRON, planifié « 0 * * * * » (toutes les heures).
//
// ⚠️ POURQUOI CE FICHIER EXISTE. La route /blog/tick sait décider s'il est
// l'heure d'écrire, mais elle ne se déclenche pas toute seule : seuls les
// VISITEURS l'appelaient, en ouvrant l'onglet Blog. Résultat, aucune visite
// pendant la nuit = aucun article, et le blog pouvait rester muet des jours
// sans que rien ne le signale. C'est ce Cron qui rend vraie la promesse
// « un article par heure ».
//
// Le double garde-fou de /blog/tick reste en place : même appelé trop souvent,
// il ne sortira jamais plus d'un article par intervalle. Ce fichier ne peut
// donc pas faire exploser la dépense.
//
// Aucun secret ici : /blog/tick est publique par conception, c'est son
// intervalle qui la protège, pas un mot de passe.
//
// ⚠️ Commentaires en « // » et non en bloc « /* */ » : au collage, perdre le
// premier caractère d'un bloc emporte tout le fichier — c'est arrivé une fois.
// Avec des « // », chaque ligne se protège elle-même.
// ===========================================================

const BASE = "https://lechat45--2ec0f9a6860b11f183cf1607ee4eb77e.web.val.run";

export default async function () {
  const debut = Date.now();
  // Un délai franc : écrire un article demande un appel à l'IA plus la
  // recherche d'image. Sans délai, on couperait la connexion en pleine
  // rédaction — et l'article serait perdu alors que le jalon, lui, aurait
  // déjà été posé côté serveur.
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), 110000);
  try {
    const r = await fetch(BASE + "/blog/tick", { signal: ctrl.signal });
    const corps: any = await r.json().catch(() => ({}));
    const ms = Date.now() - debut;

    if (!r.ok) {
      console.error(`[blog] HTTP ${r.status} en ${ms} ms`, corps);
      // On LÈVE : c'est ce qui fait apparaître l'échec dans l'historique du
      // Cron. Sans ça, une panne durable passerait inaperçue.
      throw new Error(`/blog/tick a répondu ${r.status}`);
    }

    if (corps.fait) {
      console.log(`[blog] écrit en ${ms} ms : « ${corps.titre} » (${corps.sujet})`);
      return;
    }

    // Cas NORMAUX : l'automatisme est en pause, ou ce n'est pas encore l'heure
    // (le Cron passe chaque heure, mais l'intervalle peut être réglé plus large
    // depuis le panneau admin). Ce ne sont pas des erreurs.
    console.log(
      `[blog] rien à faire (${corps.raison || "sans raison donnée"})`
        + (corps.dans_minutes ? ` — dans ${corps.dans_minutes} min` : ""),
    );
    // Une erreur de RÉDACTION, elle, doit remonter : le serveur a déjà reculé
    // son jalon pour retenter dans quelques minutes, mais on veut la voir.
    if (corps.erreur) throw new Error(`rédaction échouée : ${corps.erreur}`);
  } catch (e: any) {
    if (e && e.name === "AbortError") {
      console.error("[blog] délai dépassé (110 s) — l’IA est probablement lente");
      throw new Error("délai dépassé sur /blog/tick");
    }
    throw e;
  } finally {
    clearTimeout(minuteur);
  }
}
