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

/* ---------- 8. Fichiers locaux référencés mais absents ----------
   Le cas grave est la liste SHELL de sw.js : cache.addAll() est ATOMIQUE. Un
   seul fichier manquant fait rejeter la promesse, le service worker ne
   s'installe jamais, et le mode hors-ligne cesse de marcher — sans aucune
   erreur visible pour le visiteur.

   ⚠️ PORTÉE VOLONTAIREMENT ÉTROITE : uniquement sw.js, le manifeste, et les
   `<link href>` de l'en-tête. J'avais écrit un détecteur large qui balayait tous
   les src/href : il sortait 4 faux positifs sur 5 (des `href="` à l'intérieur de
   gabarits JavaScript, et `url(#id)` en CSS qui désigne un fragment du document,
   pas un fichier). Un contrôle qui crie au loup finit ignoré, donc désactivé —
   mieux vaut couvrir moins et être cru. */
titre('8. Fichiers référencés');
{
  const absents = [];
  const test = (source, brut) => {
    let p = String(brut).trim().replace(/^\.\//, '').split(/[?#]/)[0];
    if (!p || /^(https?:|data:|mailto:|tel:|\/\/|#)/i.test(p)) return;
    if (p.startsWith('/')) p = p.slice(1);
    if (!existe(p)) absents.push(source + ' → ' + brut);
  };
  const shell = lire('sw.js').match(/const SHELL\s*=\s*\[([\s\S]*?)\]/);
  if (shell) for (const q of shell[1].matchAll(/'([^']+)'/g)) test('sw.js SHELL', q[1]);
  try {
    const j = JSON.parse(lire('manifest.json'));
    (j.icons || []).forEach(i => test('manifest icons', i.src));
    if (j.start_url) test('manifest start_url', j.start_url);
  } catch (e) { err('manifest.json illisible : ' + e.message); }
  /* Les <link> de l'en-tête : icône, flux RSS, canonique. Le flux manquait, et
     tout lecteur RSS qui suivait le lien recevait un 404. */
  for (const m of lire('index.html').matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) test('index.html <link>', m[1]);
  if (!absents.length) ok('tous les fichiers critiques référencés existent');
  else absents.forEach(a => err('fichier absent : ' + a));
}


/* ---------- 9. Deux routes pour le même chemin ----------
   ⚠️ CE CONTRÔLE EXISTE À CAUSE D'UN VRAI BUG. En ajoutant les compteurs
   d'audience, j'ai créé une SECONDE route « /admin/stats » déclarée plus haut
   dans le fichier que celle qui existait déjà. Le routage est un enchaînement
   de `if` : la première qui correspond répond, les suivantes ne sont jamais
   atteintes. Le panneau a perdu d'un coup les comptes créés, les voyages et la
   courbe d'inscriptions — sans erreur, sans 404, juste des sections vides.
   Rien ne signale une route en double : ni node --check, ni un test du panneau
   qui simule les réponses du serveur. */
titre('9. Routes du backend');
{
  const src = lire('valtown-backend.js');
  const vus = new Map();
  for (const m of src.matchAll(/path\s*===\s*'([^']+)'/g)) {
    const ligne = src.slice(0, m.index).split('\n').length;
    if (!vus.has(m[1])) vus.set(m[1], []);
    vus.get(m[1]).push(ligne);
  }
  const dbl = [...vus.entries()].filter(([, l]) => l.length > 1);
  if (!dbl.length) ok(vus.size + ' chemins, tous uniques');
  else for (const [chemin, lignes] of dbl)
    err('chemin déclaré ' + lignes.length + ' fois : ' + chemin + ' (lignes ' + lignes.join(', ') + ')');
}

/* ---------- 10. Le sitemap pointe-t-il bien vers CE site ? ----------
   ⚠️ AUTRE BUG RÉEL. Après un changement d'adresse, le sitemap servi contenait
   encore l'ancien chemin (« /Acolyte.github.io/ »). Google le téléchargeait
   sans problème, n'y trouvait aucune adresse dans le périmètre de la propriété,
   et répondait « Impossible de récupérer » avec Type: Inconnu. Un fichier
   parfaitement valide dont tout le contenu était hors sujet — la pire forme
   d'erreur, parce qu'elle ressemble à une panne réseau. */
titre('10. Sitemap');
{
  if (!existe('sitemap.xml')) warn('sitemap.xml absent (il est généré par le workflow)');
  else {
    const xml = lire('sitemap.xml');
    /* L'adresse du site est celle déclarée par le workflow : une seule source. */
    const m = lire('.github/workflows/sitemap-blog.yml').match(/SITE:\s*(\S+)/);
    const site = m ? m[1].trim() : null;
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(x => x[1].trim());
    if (!site) warn('adresse du site introuvable dans le workflow — contrôle impossible');
    else if (!locs.length) err('sitemap.xml ne contient aucune balise <loc>');
    else {
      const dehors = locs.filter(u => !u.startsWith(site));
      if (dehors.length) {
        err(dehors.length + ' adresse(s) hors du site déclaré (' + site + ')');
        dehors.slice(0, 3).forEach(u => console.log('      ' + u));
      } else ok(locs.length + ' adresse(s), toutes sous ' + site);
    }
    /* Une déclaration XML doit être au tout début, sans rien devant : un espace
       ou un BOM suffit à faire échouer un parseur strict. */
    if (!xml.startsWith('<?xml')) err('sitemap.xml ne commence pas par <?xml (espace, BOM ou commentaire devant ?)');
  }
}



/* ---------- 12. Le contrat de l'état du voyage ----------
   Délégué à outils/test-etat.js, qui rejoue les quatre directions : données
   d'avant le tampon, à jour, venues d'une version PLUS RÉCENTE, illisibles.
   Le cas de la rétrogradation vient d'un lecteur du post Reddit — c'est le seul
   que je n'aurais pas trouvé seul, et c'est celui qui compte le plus. */
titre('12. Contrat de l’état du voyage');
{
  try {
    execFileSync(process.execPath, [path.join(RACINE, 'outils', 'test-etat.js')], { stdio: 'pipe' });
    ok('les quatre directions tiennent (12 assertions)');
  } catch (e) {
    const sortie = String(e.stdout || '') + String(e.stderr || '');
    err('le contrat de l’état est rompu :');
    sortie.split('\n').filter(l => /ÉCHEC|ERREUR|attendu|obtenu/.test(l))
      .slice(0, 8).forEach(l => console.log('      ' + l.trim()));
  }
}

/* ============================================================
   11. LE CONTRAT DU SERVEUR — on l'INTERROGE, on ne l'imagine pas
   ------------------------------------------------------------
   ⚠️ CE CONTRÔLE EXISTE À CAUSE DE LA PANNE LA PLUS COÛTEUSE DE CE PROJET.
   Une route « /admin/stats » en double masquait l'originale, et le panneau
   perdait les comptes créés, les voyages et la courbe d'inscriptions. J'avais
   pourtant testé le panneau — mais avec des réponses que je FABRIQUAIS
   moi-même, contenant évidemment les bonnes clés. Un test qui remplace le
   serveur ne peut pas découvrir que le serveur répond mal.

   Ici on appelle le VRAI backend et on vérifie que les clés attendues sont
   présentes. C'est le seul contrôle du fichier qui touche le réseau.

   ⚠️ INJOIGNABLE = AVERTISSEMENT, PAS ERREUR. Une coupure réseau, un backend
   éteint ou une machine hors ligne ne sont pas des défauts du code : faire
   échouer la publication pour ça rendrait le script inutilisable dans le train.
   En revanche, un serveur qui RÉPOND mais sans les bonnes clés est un vrai
   défaut, et là on échoue.

   ⚠️ Le corps est dans une fonction asynchrone, pas en `await` racine. Ce
   fichier utilise require() : mélanger les deux donne exactement l'erreur
   ERR_AMBIGUOUS_MODULE_SYNTAX qui a cassé le workflow du sitemap sur Node 24.
============================================================ */
async function controleServeur(){
  titre('11. Contrat du serveur (réseau)');
  /* L'adresse vient de config.js : une seule source de vérité, jamais recopiée. */
  const m = lire('config.js').match(/proxy:\s*'([^']*)'/);
  const base = (m && m[1] || '').replace(/\/+$/, '');
  if(!base){ warn('aucun proxy dans config.js — contrôle ignoré'); return; }

  const appel = async (chemin) => {
    try{
      const r = await fetch(base + chemin, { signal: AbortSignal.timeout(15000) });
      const txt = await r.text();
      let data = null;
      try{ data = JSON.parse(txt); }catch(e){}
      return { statut: r.status, data, brut: txt.slice(0, 120) };
    }catch(e){ return { erreur: e.message }; }
  };

  /* /ping : le backend tourne-t-il, et est-il à jour ? */
  const ping = await appel('/ping');
  if(ping.erreur){ warn('backend injoignable (' + ping.erreur + ') — contrôle ignoré'); return; }
  if(ping.statut !== 200 || !ping.data?.ok){
    err('/ping a répondu ' + ping.statut + ' : ' + ping.brut);
    return;
  }
  ok('/ping — le backend répond');

  /* /blog : la route dont dépendent le sitemap ET le flux RSS. */
  const blog = await appel('/blog');
  if(blog.erreur) warn('/blog injoignable : ' + blog.erreur);
  else if(blog.statut !== 200) err('/blog a répondu ' + blog.statut + ' — le sitemap ne pourra pas se remplir');
  else if(!Array.isArray(blog.data?.articles)) err('/blog ne renvoie pas de tableau « articles » : ' + blog.brut);
  else ok('/blog — ' + blog.data.articles.length + ' article(s)');

  /* /admin/stats : on ne peut pas l'appeler sans être administrateur, et c'est
     voulu. Mais 403 prouve que la route EXISTE ; 404 prouve que le backend
     déployé est plus vieux que le code d'ici. C'est ce que je n'avais pas su
     voir, et c'est exactement ce qui rendait les comptes invisibles. */
  const st = await appel('/admin/stats');
  if(st.erreur) warn('/admin/stats injoignable');
  else if(st.statut === 403) ok('/admin/stats — la route existe (403 = accès refusé, normal sans session)');
  else if(st.statut === 404) err('/admin/stats absente du backend DÉPLOYÉ : recolle valtown-backend.deploy.js dans Val Town');
  else warn('/admin/stats a répondu ' + st.statut + ' (inattendu, mais pas bloquant)');
}

/* Le verdict attend le contrôle réseau : sans ça le script sortirait avant que
   la réponse du serveur n'arrive, et le résultat serait faux. */
controleServeur().catch(e => warn('contrôle réseau interrompu : ' + e.message)).then(() => {
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
});
