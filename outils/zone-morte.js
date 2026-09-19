#!/usr/bin/env node
/* ============================================================
   ZONE MORTE — le piège qui a coûté trois fonctionnalités
   ------------------------------------------------------------
   app.js s'exécute d'un bout à l'autre au chargement. Ce qui est écrit
   `function` ou `var` existe dès la première ligne ; ce qui est écrit
   `const` ou `let` n'existe qu'à partir de SA ligne. Avant elle, le nom
   est connu mais le lire lève une ReferenceError : « zone morte ».

   Ça ne se voit pas, et c'est tout le problème :

     function qzFait(){ try{ return !!localStorage.getItem(QZ_KEY); }
                        catch(e){ return true; } }
     ...
     requireAuth();                       // s'exécute ICI, pendant le script
     ...
     const QZ_KEY = 'acolite_questions';  // déclaré 2 000 lignes plus bas

   L'erreur tombe dans le `catch`, qui répond « déjà fait ». Les trois
   questions d'arrivée n'ont jamais été posées à personne, sans une ligne
   d'erreur en console. Même piège pour _blogIdx et passPlie.

   ⚠️ POURQUOI CE SCRIPT NE FAIT PAS D'ANALYSE STATIQUE.
   J'ai essayé : suivre les appels depuis le haut du fichier et comparer
   les numéros de ligne. Ça donne des centaines de faux positifs, parce
   qu'il faudrait un vrai analyseur JavaScript pour savoir qu'un gabarit
   `...` sur quarante lignes n'est pas du code, qu'une flèche affectée à
   `onclick` ne s'exécute pas maintenant, ou qu'une branche n'est jamais
   prise au démarrage. Deviner mal est pire que ne pas deviner.

   Donc on MESURE. Ce script fabrique une copie d'Acolyte où chaque `catch`
   dit tout haut quand il vient d'avaler une erreur de zone morte — le
   message de V8 est reconnaissable entre mille : « Cannot access 'X'
   before initialization ». Zéro faux positif par construction : on ne
   signale que ce qui s'est réellement produit, sur le chemin réellement
   parcouru.

   Usage :
     node outils/zone-morte.js
     puis ouvrir  index.zone-morte.html  dans le navigateur.
     Le verdict s'affiche dans la console ET en haut de la page.
     node outils/zone-morte.js --tout      toute erreur avalée, pas que celles-ci
     node outils/zone-morte.js --nettoie   pour effacer les copies.

   ⚠️ CE QU'IL FAUT TESTER, ET POURQUOI CLIQUER NE SERT À RIEN.
   Une zone morte ne mord que PENDANT l'évaluation du script. Une fois la
   page chargée, toutes les déclarations sont faites : cliquer partout ne
   peut plus rien révéler. Seul l'ÉTAT DE DÉPART compte, parce qu'il change
   ce qui s'exécute pendant l'évaluation. Recharge donc une fois par état :

     • navigateur vierge (première visite)
     • un voyage enregistré, avant le séjour, puis PENDANT le séjour
     • acolite_onglet posé sur chacun des 8 onglets — l'onglet mémorisé est
       redessiné pendant l'évaluation, et chacun fait tourner un autre code.
       C'est le cas le plus productif, et le moins évident.
     • connecté (acolite_user + acolite_logged + acolite_token), avec et
       sans acolite_privacy : la barrière et la synchro ne tournent que là
     • ?kiosque=1 · un lien de partage #v=… · hors connexion

   C'est ce parcours qui a trouvé LS_GOUTS, lu par goutsLire() depuis
   renderProfile() pendant l'évaluation : la mémoire du profil affichait
   « Acolyte n'a encore rien retenu » alors qu'il avait retenu.
============================================================ */

const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const SRC = path.join(racine, 'app.js');
const HTML = path.join(racine, 'index.html');
const SORTIE_JS = path.join(racine, 'app.zone-morte.js');
const SORTIE_HTML = path.join(racine, 'index.zone-morte.html');

/* --nettoie : effacer les copies · --tout : signaler TOUTE erreur avalée,
   pas seulement les zones mortes. Un catch qui rend une valeur par défaut
   cache le même genre de silence, quelle que soit l'erreur. */
const TOUT = process.argv.includes('--tout');

if(process.argv.includes('--nettoie')){
  let n = 0;
  for(const f of [SORTIE_JS, SORTIE_HTML]) if(fs.existsSync(f)){ fs.unlinkSync(f); n++; }
  console.log(n ? `✓ ${n} copie(s) effacée(s).` : '✓ Rien à effacer.');
  process.exit(0);
}

/* --- Masquer chaînes et commentaires en gardant les positions.
   Indispensable : le texte « }catch(e){ » apparaît aussi dans les chaînes
   et dans les commentaires de ce fichier-ci. On balaie caractère par
   caractère, en suivant les `${ }` imbriqués des gabarits. --- */
function masque(src){
  const out = new Array(src.length);
  const pile = [];
  let i = 0, mode = 'code';
  while(i < src.length){
    const c = src[i], d = src[i + 1];
    const vide = () => { out[i] = c === '\n' ? '\n' : ' '; i++; };
    if(mode === 'code'){
      if(c === '/' && d === '/'){ mode = 'ligne'; vide(); continue; }
      if(c === '/' && d === '*'){ mode = 'bloc'; vide(); continue; }
      if(c === "'"){ mode = 'apos'; vide(); continue; }
      if(c === '"'){ mode = 'guil'; vide(); continue; }
      if(c === '`'){ mode = 'gabarit'; vide(); continue; }
      if(c === '}' && pile.length){ pile.pop(); mode = 'gabarit'; vide(); continue; }
      out[i] = c; i++; continue;
    }
    if(mode === 'ligne'){ if(c === '\n') mode = 'code'; vide(); continue; }
    if(mode === 'bloc'){
      if(c === '*' && d === '/'){ vide(); vide(); mode = 'code'; continue; }
      vide(); continue;
    }
    if(c === '\\'){ vide(); if(i < src.length) vide(); continue; }
    if(mode === 'apos' && c === "'"){ mode = 'code'; vide(); continue; }
    if(mode === 'guil' && c === '"'){ mode = 'code'; vide(); continue; }
    if(mode === 'gabarit'){
      if(c === '`'){ mode = 'code'; vide(); continue; }
      if(c === '$' && d === '{'){ pile.push(1); mode = 'code'; vide(); vide(); continue; }
    }
    vide();
  }
  return out.join('');
}

const brut = fs.readFileSync(SRC, 'utf8');
const vu = masque(brut);

/* --- Les `catch (x) {` réels, repérés sur la source masquée --- */
const RE_CATCH = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
const points = [];
let m;
while((m = RE_CATCH.exec(vu)) !== null){
  points.push({ fin: m.index + m[0].length, nom: m[1],
                ligne: brut.slice(0, m.index).split('\n').length });
}

/* --- On insère la sonde juste après l'accolade ouvrante --- */
let out = '', prec = 0;
for(const p of points){
  out += brut.slice(prec, p.fin);
  out += `if(window.__zm)window.__zm(${p.nom},${p.ligne});`;
  prec = p.fin;
}
out += brut.slice(prec);

const SONDE = `var TOUT = ${TOUT};
/* ---- sonde zone morte (copie de diagnostic, ne pas publier) ---- */
window.__ZM = [];
window.__zm = function(e, ligne){
  try{
    if(TOUT){
      /* un throw de chaîne est un signal voulu, pas un défaut */
      if(!(e instanceof Error)) return;
    }else{
      if(!(e instanceof ReferenceError)) return;
      if(!/before initialization|is not defined/.test(e.message || '')) return;
    }
    window.__ZM.push({ ligne: ligne, type: (e.constructor && e.constructor.name) || 'Error',
                       message: e.message, pile: (e.stack || '').split('\\n')[1] || '' });
  }catch(_){}
};
window.addEventListener('error', function(ev){
  if(ev.error instanceof ReferenceError) window.__zm(ev.error, 0);
});
`;

const RAPPORT = `
/* ---- verdict, une fois la page prête ---- */
setTimeout(function(){
  var z = window.__ZM || [];
  var banc = document.createElement('div');
  banc.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:99999;padding:14px 18px;'
    + 'font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;max-height:46vh;overflow:auto;'
    + (z.length ? 'background:#B33023;color:#fff' : 'background:#1F7A4A;color:#fff');
  if(!z.length){
    banc.textContent = TOUT
      ? '\\u2713 Aucune erreur avalée sur ce chemin.'
      : '\\u2713 ZONE MORTE \\u2014 aucune lecture avalée. '
        + 'Tous les chemins parcourus lisent des noms déjà déclarés.';
  }else{
    var vus = {}, lignes = [];
    z.forEach(function(x){
      var k = x.ligne + '|' + x.message;
      if(vus[k]) return; vus[k] = 1;
      lignes.push('  app.js ligne ' + x.ligne + ' \\u2014 ' + (x.type || 'Error') + ' : ' + x.message
                  + (x.pile ? '\\n     ' + x.pile.trim() : ''));
    });
    banc.textContent = '\\u2717 ' + (TOUT ? 'ERREURS AVALÉES' : 'ZONE MORTE') + ' \\u2014 '
      + lignes.length + ' erreur(s) avalée(s) par un catch :\\n' + lignes.join('\\n')
      + (TOUT ? '' : '\\n\\nRemonte la déclaration au-dessus du premier appel, ou passe-la en var.');
  }
  document.body.appendChild(banc);
  console[z.length ? 'error' : 'log']('[zone-morte]', banc.textContent);
}, 2500);
`;

fs.writeFileSync(SORTIE_JS, SONDE + out + RAPPORT, 'utf8');

const html = fs.readFileSync(HTML, 'utf8');
if(!/src="app\.js"/.test(html)){
  console.error('✗ index.html ne charge pas app.js par <script src="app.js"> — script à adapter.');
  process.exit(2);
}
fs.writeFileSync(SORTIE_HTML, html.replace('src="app.js"', 'src="app.zone-morte.js"'), 'utf8');

console.log(`✓ Copie de diagnostic écrite.`);
console.log(`  ${points.length} bloc(s) catch sondé(s) dans app.js.`);
console.log('');
console.log('  Ouvre  index.zone-morte.html  dans le navigateur : le verdict');
console.log('  s\'affiche en bas de la page au bout de 2,5 s.');
console.log('  Refais-le avec un voyage en cours, un lien de partage (#v=…),');
console.log('  ?kiosque=1 — chaque état parcourt un chemin différent.');
console.log('');
console.log('  Puis :  node outils/zone-morte.js --nettoie');
