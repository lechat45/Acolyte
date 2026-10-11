#!/usr/bin/env node
/* ============================================================
   CSS MORT — les regles que plus aucune page ne peut declencher
   ------------------------------------------------------------
   style.css n'est charge QUE par index.html (verifie : admin.html,
   promo.html et merveilles/index.html ont leurs propres styles). Le
   balisage vient donc de index.html et de app.js, et rien d'autre.
   Une classe citee par la feuille mais produite par aucun des deux est
   du poids mort : elle ne peut plus jamais s'appliquer.

   ⚠️ CE SCRIPT N'EST PAS UNE BARRIERE, ET IL N'EST PAS BRANCHE SUR
   verifie.js. A son premier essai il a declare morte « .ap-moi », qui
   est bien vivante : elle est fabriquee a l'execution par
   `ap-${m.r === 'u' ? 'moi' : 'aco'}`. J'allais supprimer une regle
   utilisee. Il propose, on relit, on supprime a la main.

   Deux pieges qu'il connait maintenant :

   1. LES NOMS ASSEMBLES. Un nom coupe sur un tiret peut etre recolle a
      l'execution — `ap-${...}`, `breel-${ton}`, `am-${esc(m.kind)}`,
      ou 'plan-' + onglet. On cherche donc, pour chaque coupe sur
      tiret, si le morceau ecrit touche un ${ ou un +. Le fragment doit
      faire au moins 3 caracteres : une seule lettre colle partout et
      le controle ne dit plus rien.

   2. LES SELECTEURS A VIRGULES. « #catBlog > .blog-tete h2,
      #catBlog h2:first-of-type » a une seconde partie SANS classe,
      donc vivante. Juger la regle sur ses classes seules l'aurait
      emportee — avec elle le titre du journal. Chaque partie separee
      par une virgule est donc examinee pour elle-meme, et il suffit
      qu'une partie vive pour que la regle reste.

   Usage :  node outils/css-mort.js
============================================================ */
const fs = require('fs');
const path = require('path');
const RACINE = path.join(__dirname, '..');
const L = f => fs.readFileSync(path.join(RACINE, f), 'utf8');

const css = L('style.css');
const src = L('app.js') + L('index.html');

/* un caractere qui peut faire partie d'un nom de classe */
const MOT = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
              || (c >= '0' && c <= '9') || c === '-' || c === '_';

/* Le nom apparait-il ENTIER, entoure de caracteres qui ne peuvent pas
   appartenir a un nom de classe ? Zero expression reguliere construite
   depuis une chaine : les antislashs se perdent en route. */
function produite(nom){
  let i = 0;
  for(;;){
    i = src.indexOf(nom, i);
    if(i < 0) return false;
    const av = i > 0 ? src[i - 1] : ' ';
    const ap = i + nom.length < src.length ? src[i + nom.length] : ' ';
    if(!MOT(av) && !MOT(ap)) return true;
    i++;
  }
}

/* Le nom est-il recolle a l'execution ? (piege 1) */
function assemblee(nom){
  for(let k = 1; k < nom.length; k++){
    const tete = nom.slice(0, k), queue = nom.slice(k);
    if(tete.endsWith('-') && tete.length >= 3){
      let i = 0;
      while((i = src.indexOf(tete, i)) >= 0){
        const av = i > 0 ? src[i - 1] : ' ';
        const ap = src.slice(i + tete.length, i + tete.length + 2);
        if(!MOT(av) && (ap.startsWith('${') || ap[0] === '+'
           || ap.startsWith("'+") || ap.startsWith('"+'))) return 'tete « ' + tete + ' » suivie d\'un calcul';
        i++;
      }
    }
    if(queue.startsWith('-') && queue.length >= 3){
      let i = 0;
      while((i = src.indexOf(queue, i)) >= 0){
        const av = src.slice(Math.max(0, i - 2), i);
        const ap = i + queue.length < src.length ? src[i + queue.length] : ' ';
        if(!MOT(ap) && (av.endsWith('}') || av.endsWith('+'))) return 'queue « ' + queue + ' » precedee d\'un calcul';
        i++;
      }
    }
  }
  return null;
}

const classes = new Set();
for(const m of css.matchAll(/\.([a-zA-Z][\w-]{2,})/g)) classes.add(m[1]);

/* temoins : sans eux, un detecteur casse repond « rien a signaler » et
   on le croit. Un fantome doit etre mort, une classe de la refonte doit
   vivre, et une classe assemblee ne doit PAS tomber dans les mortes. */
const temoins = [
  ['zzz-fantome introuvable', produite('zzz-fantome') === false],
  ['av-carte bien produite',  produite('av-carte') === true],
  ['ap-moi vue comme assemblee', assemblee('ap-moi') !== null],
];
const rate = temoins.filter(t => !t[1]);
if(rate.length){
  console.log('\n  ✗ TEMOIN EN ECHEC — ce script ne sait plus lire, ne suis pas ses conclusions :');
  for(const [q] of rate) console.log('      ' + q);
  process.exit(1);
}

const mortes = [], suspectes = [];
for(const c of classes){
  if(produite(c)) continue;
  const a = assemblee(c);
  if(a) suspectes.push([c, a]); else mortes.push(c);
}
const setMortes = new Set(mortes);

/* les regles dont TOUTES les parties sont mortes (piege 2) */
let poids = 0;
const retirables = [], gardees = [];
for(const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  const sel = m[1].trim();
  if(!sel || sel.startsWith('@') || sel.includes('%')) continue;
  const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
  if(!parts.length) continue;
  const classesDe = p => [...p.matchAll(/\.([a-zA-Z][\w-]{2,})/g)].map(x => x[1]);
  const toutMort = parts.every(p => {
    const cl = classesDe(p);
    return cl.length && cl.every(c => setMortes.has(c));
  });
  const propre = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
  if(toutMort){ poids += m[0].length; retirables.push(propre(sel)); }
  else if(parts.some(p => classesDe(p).some(c => setMortes.has(c)))) gardees.push(propre(sel));
}

const ligne = '─'.repeat(56);
console.log('\n' + ligne);
console.log('  CSS MORT — proposition, pas verdict');
console.log(ligne);
console.log('  classes citees par la feuille : ' + classes.size);
console.log('  jamais produites              : ' + mortes.length);
console.log('  assemblees a l\'execution      : ' + suspectes.length + '  (a NE PAS toucher)');
for(const [c, a] of suspectes.sort()) console.log('      ' + c.padEnd(16) + a);
console.log('\n  regles entierement mortes     : ' + retirables.length
            + '   ->   ' + (poids / 1024).toFixed(1) + ' Ko');
for(const s of retirables) console.log('      - ' + s);
console.log('\n  regles gardees (une partie vit) : ' + gardees.length);
for(const s of gardees.slice(0, 12)) console.log('      = ' + s);
if(gardees.length > 12) console.log('      … et ' + (gardees.length - 12) + ' autres');
console.log('\n  ⚠ Relis chaque ligne avant de supprimer. Apres suppression,');
console.log('    compare la geometrie dans le navigateur : meme nombre');
console.log('    d\'elements, memes rectangles, memes couleurs calculees.');
console.log(ligne + '\n');
