#!/usr/bin/env node
/* ============================================================
   ACOLYTE — CONTRÔLE AVANT PUBLICATION
   ------------------------------------------------------------
   À lancer avant chaque envoi :   node outils/verifie.js

   POURQUOI CE FICHIER EXISTE. Le projet n'a aucune compilation et aucun test :
   une erreur ne se voit qu'en ouvrant le site, et certaines ne se voient pas du
   tout. Trois pannes réelles, toutes silencieuses :

     · un `const` déclaré deux fois dans le même bloc → tout app.js meurt, et la
       page est blanche. Arrivé avec `const me` dans switchCat().
     · une accolade manquante dans style.css → toutes les règles qui suivent
       sont ignorées, sans le moindre message.
     · deux déclarations du même sélecteur → la moitié des propriétés est
       annulée sans que rien ne le signale. C'est l'avatar en ovale.

   AUCUNE DÉPENDANCE, volontairement : ce script doit tourner sur une machine
   nue et dans une action GitHub sans rien installer. Il ne remplace pas un
   passage dans le navigateur — il attrape ce qu'un humain ne voit pas.

   Sortie : code 0 si tout passe, 1 s'il y a une ERREUR. Les AVERTISSEMENTS ne
   font pas échouer : ils signalent une dette, pas une panne.
============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RACINE = path.resolve(__dirname, '..');
const lire = f => fs.readFileSync(path.join(RACINE, f), 'utf8');
const existe = f => fs.existsSync(path.join(RACINE, f));

let erreurs = 0, avert = 0;
const ok    = m => console.log('  ✓ ' + m);
const err   = m => { console.log('  ✗ ERREUR   ' + m); erreurs++; };
const warn  = m => { console.log('  ! avertis. ' + m); avert++; };
const titre = t => console.log('\n' + t);

/* ---------- 1. Syntaxe de chaque fichier JavaScript ----------
   C'est le contrôle qui attrape le `const` en double, et donc la page blanche.
   On passe par `node --check`, qui lit sans exécuter. */
titre('1. Syntaxe JavaScript');
const JS = ['app.js', 'admin.js', 'sw.js', 'boot-check.js', 'config.js',
            'valtown-backend.js', 'valtown-cron-blog.js', 'outils/valtown-build.js'];
for (const f of JS) {
  if (!existe(f)) { warn(f + ' est absent'); continue; }
  try {
    execFileSync(process.execPath, ['--check', path.join(RACINE, f)], { stdio: 'pipe' });
    ok(f);
  } catch (e) {
    err(f + ' — ' + String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 2).join(' / '));
  }
}

/* ---------- 2. Équilibre des accolades de la feuille de style ----------
   Une seule accolade manquante rend muettes TOUTES les règles suivantes. */
titre('2. Feuille de style');
{
  const css = lire('style.css');
  let o = 0, c = 0;
  for (const ch of css) { if (ch === '{') o++; else if (ch === '}') c++; }
  if (o === c) ok('accolades équilibrées (' + o + ' paires)');
  else err('accolades déséquilibrées : ' + o + ' ouvrantes, ' + c + ' fermantes');
}

/* ---------- 3. Identifiants HTML uniques ----------
   Deux éléments avec le même id : $('#x') n'en trouve qu'un, et le second est
   inerte — un bouton qui ne fait rien, sans erreur. */
titre('3. Identifiants HTML');
for (const f of ['index.html', 'admin.html']) {
  if (!existe(f)) continue;
  const ids = [...lire(f).matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const vus = new Set(), dbl = new Set();
  for (const i of ids) { if (vus.has(i)) dbl.add(i); vus.add(i); }
  if (dbl.size) err(f + ' — id en double : ' + [...dbl].join(', '));
  else ok(f + ' — ' + ids.length + ' id, tous uniques');
}

/* ---------- 4. La version du cache a-t-elle bougé ? ----------
   LE défaut le plus coûteux du projet : sans incrémenter CACHE, les visiteurs
   gardent l'ancienne version et AUCUN changement n'est visible. On ne peut pas
   le vérifier tout seul — on affiche la valeur pour qu'elle soit relue. */
titre('4. Service worker');
{
  const m = lire('sw.js').match(/const CACHE\s*=\s*'([^']+)'/);
  if (!m) err("sw.js : impossible de lire la version du cache");
  else ok('cache = ' + m[1] + "   ← vérifie qu'elle a changé depuis la dernière publication");
}

/* ---------- 5. Aucune clé d'API dans les fichiers publiés ----------
   Le dépôt est PUBLIC (c'est la condition de la gratuité de GitHub Pages).
   Une clé oubliée dans config.js serait lisible par tout le monde. */
titre('5. Secrets');
{
  const motifs = [
    [/AIza[0-9A-Za-z_\-]{30,}/, 'clé Google/Gemini'],
    [/gsk_[0-9A-Za-z]{40,}/,    'clé Groq'],
    [/sk-[0-9A-Za-z]{32,}/,     'clé OpenAI'],
    [/xox[baprs]-[0-9A-Za-z-]{20,}/, 'jeton Slack'],
    [/ghp_[0-9A-Za-z]{36}/,     'jeton GitHub']
  ];
  let trouve = 0;
  for (const f of ['config.js', 'app.js', 'admin.js', 'index.html', 'sw.js', 'worker.js']) {
    if (!existe(f)) continue;
    const t = lire(f);
    for (const [re, nom] of motifs) if (re.test(t)) { err(f + ' contient ce qui ressemble à une ' + nom); trouve++; }
  }
  if (!trouve) ok('aucune clé détectée dans les fichiers publiés');
}

/* ---------- 6. Sélecteurs CSS déclarés deux fois (AVERTISSEMENT) ----------
   Ce n'est pas une panne, c'est une dette : la moitié des propriétés d'une
   règle peut être annulée sans que rien ne le dise. On compte, on n'échoue pas.
   ⚠️ On retire les commentaires AVANT de découper, sinon le sélecteur capturé
   les emporte — c'est le défaut qu'avait mon premier outil de purge. */
titre('6. Conflits de sélecteurs CSS (dette, pas panne)');
{
  const css = lire('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const regles = [];
  let i = 0, sel = '', pile = [];
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const tete = sel.trim();
      if (/^@/.test(tete)) { pile.push(tete); sel = ''; i++; continue; }
      let j = i + 1, p = 1;
      while (j < css.length && p > 0) { if (css[j] === '{') p++; else if (css[j] === '}') p--; j++; }
      const props = new Set();
      css.slice(i + 1, j - 1).replace(/\{[\s\S]*?\}/g, '').split(';')
        .forEach(d => { const m = d.match(/^\s*([a-z-]+)\s*:/i); if (m) props.add(m[1].toLowerCase()); });
      for (const s of tete.split(',')) {
        const t = s.trim().replace(/\s+/g, ' ');
        if (t) regles.push({ sel: t, props, media: pile.join(' ') || '-' });
      }
      sel = ''; i = j; continue;
    }
    if (ch === '}') { pile.pop(); sel = ''; i++; continue; }
    sel += ch; i++;
  }
  const par = new Map();
  for (const r of regles) {
    const k = r.sel + '|' + r.media;
    if (!par.has(k)) par.set(k, []);
    par.get(k).push(r);
  }
  const conflits = [];
  for (const arr of par.values()) {
    if (arr.length < 2) continue;
    for (let a = 0; a < arr.length; a++) for (let b = a + 1; b < arr.length; b++) {
      const com = [...arr[a].props].filter(p => arr[b].props.has(p));
      if (com.length) conflits.push({ sel: arr[a].sel, n: com.length });
    }
  }
  conflits.sort((x, y) => y.n - x.n);
  if (!conflits.length) ok('aucun sélecteur en conflit');
  else {
    warn(conflits.length + ' sélecteur(s) déclaré(s) deux fois avec des propriétés communes');
    conflits.slice(0, 5).forEach(c => console.log('      ' + c.sel + '  (' + c.n + ' propriétés)'));
  }
}

/* ---------- 7. Identifiants câblés en JS mais absents du DOM (AVERTISSEMENT) ----------
   Un $('#x') sur un id qui n'existe pas = du code injoignable, et parfois une
   panne latente si la fonction est un jour rebranchée. */
titre('7. Identifiants câblés dans le vide (dette)');
{
  const html = lire('index.html'), js = lire('app.js');
  const dans = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  for (const m of js.matchAll(/id=["'`]([A-Za-z][\w-]*)["'`]/g)) dans.add(m[1]);
  for (const m of js.matchAll(/\.id\s*=\s*['"`]([A-Za-z][\w-]*)['"`]/g)) dans.add(m[1]);
  const morts = new Set();
  for (const m of js.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)) if (!dans.has(m[1])) morts.add(m[1]);
  if (!morts.size) ok('tous les identifiants référencés existent');
  else warn(morts.size + ' identifiant(s) référencé(s) mais absent(s) : ' + [...morts].slice(0, 8).join(', ')
       + (morts.size > 8 ? '…' : ''));
}

/* ---------- Verdict ---------- */
console.log('\n' + '─'.repeat(56));
if (erreurs) {
  console.log('✗ ' + erreurs + ' erreur(s) — NE PUBLIE PAS avant correction.'
    + (avert ? '  (' + avert + ' avertissement)' : ''));
  process.exit(1);
}
console.log('✓ Rien de bloquant.' + (avert ? '  ' + avert + ' avertissement(s) — dette à résorber, pas urgent.' : ''));
console.log('  ⚠ Ce script ne remplace PAS un passage dans le navigateur :');
console.log('    il ne voit ni un contraste trop faible, ni un texte qui déborde.');
process.exit(0);
