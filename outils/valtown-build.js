/* ============================================================
   ACOLYTE — FABRIQUE LA VERSION À COLLER DANS VAL TOWN
   ------------------------------------------------------------
   Val Town plafonne un val à 80 000 caractères. valtown-backend.js dépasse ce
   plafond, et ce n'est pas le code qui pèse : ce sont les commentaires. Ils
   expliquent chaque piège rencontré, ils valent d'être gardés — mais Val Town
   n'en a aucun besoin pour exécuter.

   Ce script produit donc valtown-backend.deploy.js, sans commentaires. Le
   fichier documenté reste LA référence : c'est lui qu'on modifie, jamais la
   version déployée.

   ⚠️ POURQUOI PAS UNE EXPRESSION RÉGULIÈRE. Retirer les commentaires « à la
   regex » casse ce code : il contient des adresses (« https:// » — deux barres
   obliques), des expressions régulières littérales, et de longs gabarits de
   texte (les consignes de rédaction) où « // » et « * » apparaissent en début
   de ligne. Une regex ne distingue pas un commentaire d'une chaîne. On parcourt
   donc le fichier caractère par caractère en suivant l'état réel : code,
   chaîne, gabarit, expression régulière, commentaire.

   USAGE : node outils/valtown-build.js
============================================================ */
const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const SOURCE = path.join(RACINE, 'valtown-backend.js');
const SORTIE = path.join(RACINE, 'valtown-backend.deploy.js');
const LIMITE = 80000;

/* Un « / » ouvre une expression régulière quand le dernier caractère utile ne
   peut pas terminer une valeur. Après « ) », « ] », un nom ou un chiffre, c'est
   une division ; après « ( », « = », « , », « return »… c'est une regex. */
function ouvreRegex(avant) {
  const c = avant.trimEnd().slice(-1);
  if (!c) return true;
  if (/[)\]}\w$'"`]/.test(c)) {
    /* exception : les mots-clés qui attendent une valeur derrière eux */
    return /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/
      .test(avant.trimEnd());
  }
  return true;
}

function retireCommentaires(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];

    /* ---- commentaire de ligne ---- */
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;                                  /* on garde le retour à la ligne */
    }
    /* ---- commentaire de bloc ---- */
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    /* ---- chaîne simple ou double ---- */
    if (c === '"' || c === "'") {
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    /* ---- gabarit : il peut contenir ${ … } avec du code dedans ---- */
    if (c === '`') {
      out += c; i++;
      let prof = 0;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { prof++; out += '${'; i += 2; continue; }
        if (prof > 0 && src[i] === '}') { prof--; out += '}'; i++; continue; }
        out += src[i];
        if (prof === 0 && src[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }
    /* ---- expression régulière littérale ---- */
    if (c === '/' && ouvreRegex(out)) {
      out += c; i++;
      let crochet = false;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === '[') crochet = true;
        else if (src[i] === ']') crochet = false;
        out += src[i];
        if (src[i] === '/' && !crochet) { i++; break; }
        if (src[i] === '\n') { i++; break; }      /* sécurité : pas de regex multi-lignes */
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) { out += src[i]; i++; }   /* drapeaux */
      continue;
    }
    out += c; i++;
  }
  return out;
}

/* Les lignes devenues vides après retrait des commentaires : on les tasse,
   sans jamais toucher à l'intérieur d'un gabarit — les retours à la ligne y
   sont du CONTENU (les consignes de rédaction en dépendent). */
function tasse(src) {
  return src
    .split('\n')
    .filter((l, k, t) => {
      if (l.trim() !== '') return true;
      return t[k - 1] && t[k - 1].trim() !== '';   /* une vide à la suite, pas deux */
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const src = fs.readFileSync(SOURCE, 'utf8');
let out = retireCommentaires(src);
out = tasse(out);

/* Les variables d'environnement, RELEVÉES DANS LE CODE plutôt que recopiées :
   la liste ne peut donc pas devenir fausse quand on en ajoute une. Elles sont
   remises dans l'en-tête parce que sans elles, personne ne sait quoi
   configurer en ouvrant le val — c'est la seule partie des commentaires qui
   soit OPÉRATIONNELLE et non explicative. */
const vars = [...new Set([...src.matchAll(/env\('([A-Z0-9_]+)'\)/g)].map(m => m[1]))].sort();

/* ⚠️ L'EN-TÊTE EST EN COMMENTAIRES DE LIGNE, ET EN ASCII PUR. Ce n'est pas un
   caprice de style, c'est le résultat d'une panne réelle : au collage dans Val
   Town, le « / » initial d'un bloc « slash-étoile » s'est perdu. Deno a alors lu
   la ligne comme « * ⚠️ … », pris l'étoile pour un opérateur, et refusé tout le
   fichier avec « Expression expected at main.ts:1:3 » — l'emoji étant en
   colonne 3.
   Avec des « // », chaque ligne se protège elle-même : perdre un caractère
   n'entraîne plus le fichier entier. Et sans accent ni emoji dans l'en-tête,
   plus rien ne dépend de l'encodage du presse-papier. Le CODE, lui, garde ses
   accents : ils sont dans des chaînes, à leur place. */
const entete = `// ===========================================================
// FICHIER GENERE - NE PAS MODIFIER ICI.
// Produit par : node outils/valtown-build.js
// Source (commentee, a corriger la-bas) : valtown-backend.js
// Les commentaires sont retires pour tenir sous les 80000 caracteres
// que Val Town autorise par val. Relance le script apres chaque
// correction : ce fichier est ecrase a chaque passage.
//
// --- Variables d'environnement (Val Town > onglet Secrets) ---
${vars.map(v => '//   - ' + v).join('\n')}
//
// GEMINI_KEY et les quatre EMAILJS_* sont indispensables : sans elles,
// la redaction d'articles et l'envoi de courriels ne marchent pas.
// ALLOWED_ORIGIN = l'adresse du site, sans barre oblique finale.
// ADMIN_EMAIL = l'adresse qui ouvre le panneau de statistiques.
// ===========================================================
`;
out = entete + out;


/* ---- Contrôles avant écriture ----
   Ils visent la panne qui s'est réellement produite : un fichier refusé par
   Deno à la ligne 1. Mieux vaut échouer ici, sur le poste, que là-bas. */
const lignes = out.split('\n');
const alertes = [];
if (!lignes[0].startsWith('//'))
  alertes.push('la première ligne devrait commencer par « // » : ' + JSON.stringify(lignes[0].slice(0, 40)));
/* Une ligne commençant par « * » est la SIGNATURE d'un bloc de commentaire
   estropié : c'est exactement ce que Deno a refusé. */
lignes.forEach((l, k) => {
  if (/^\s*\*/.test(l) && !/^\s*\*\//.test(l)) alertes.push('ligne ' + (k + 1) + ' commence par « * » : ' + l.trim().slice(0, 50));
});
/* Non-ASCII dans les cinq premières lignes : c'est là que le presse-papier
   fait le plus de dégâts, et l'erreur y devient illisible. */
lignes.slice(0, 5).forEach((l, k) => {
  const m = l.match(/[^\x00-\x7F]/);
  if (m) alertes.push('ligne ' + (k + 1) + ' contient du non-ASCII (' + JSON.stringify(m[0]) + ')');
});
if (alertes.length) {
  console.error('❌ Contrôles en échec, fichier NON écrit :');
  alertes.slice(0, 8).forEach(a => console.error('   · ' + a));
  process.exit(1);
}

/* Les contrôles sont passés : on peut écrire. */
fs.writeFileSync(SORTIE, out);

const av = src.length, ap = out.length;
console.log(`source   : ${av.toLocaleString('fr-FR')} caractères`);
console.log(`déployé  : ${ap.toLocaleString('fr-FR')} caractères  (${Math.round((1 - ap / av) * 100)} % de moins)`);
console.log(`limite   : ${LIMITE.toLocaleString('fr-FR')}`);
console.log(ap <= LIMITE
  ? `✅ tient, avec ${(LIMITE - ap).toLocaleString('fr-FR')} caractères de marge`
  : `❌ DÉPASSE ENCORE de ${(ap - LIMITE).toLocaleString('fr-FR')} caractères`);
