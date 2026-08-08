#!/usr/bin/env node
/* ============================================================
   BANC D'ESSAI DE safeState() — le contrat de l'état du voyage
   ------------------------------------------------------------
   POURQUOI CE FICHIER EXISTE. Un lecteur du post Reddit a signalé qu'un
   validateur de FORME ne voit pas la dérive de SENS : si une version change ce
   que signifie « mode », l'ancien code accepte en silence et la carte devient
   faussement juste. Puis il a ajouté le cas que je n'avais pas vu — la
   RÉTROGRADATION : la v2 écrit, la v1 relit hors ligne.

   J'ai vérifié les quatre directions à la main. Ces vérifications auraient
   disparu avec la conversation. Elles sont ici, et elles tournent à chaque
   envoi : c'est ce qui empêche de perdre le raisonnement de quelqu'un qui a
   pris le temps de le formuler.

   ⚠️ COMMENT ÇA MARCHE, ET POURQUOI PAS AUTREMENT. app.js est un script de
   NAVIGATEUR : le charger tel quel dans Node échoue (window, document,
   localStorage). On extrait donc seulement le bloc des fonctions de
   validation — elles sont pures, elles ne touchent à rien — et on l'évalue.
   Recopier ces fonctions ici serait pire : deux versions divergeraient, et le
   test finirait par valider un code qui n'est plus celui qui tourne.
============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');

/* Du premier assainisseur à la fin de safeState. Les bornes sont des ancres de
   TEXTE et non des numéros de ligne : un numéro se périme au premier ajout. */
const debut = src.indexOf('const _sTxt =');
const ancre = src.indexOf('function safeState(raw){');
if (debut < 0 || ancre < 0) {
  console.log('✗ ERREUR  impossible de localiser safeState dans app.js — le banc ne peut pas tourner');
  process.exit(1);
}
/* Fin de safeState : on suit la profondeur d'accolades depuis sa signature. */
let i = src.indexOf('{', ancre), prof = 0, fin = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === '{') prof++;
  else if (src[j] === '}') { prof--; if (prof === 0) { fin = j + 1; break; } }
}
if (fin < 0) { console.log('✗ ERREUR  safeState mal fermée ?'); process.exit(1); }

let safeState;
try {
  /* eslint-disable no-new-func */
  safeState = new Function(src.slice(debut, fin) + '\n; return safeState;')();
} catch (e) {
  console.log('✗ ERREUR  le bloc extrait ne s\'évalue pas : ' + e.message);
  process.exit(1);
}

let ko = 0;
const essai = (nom, obtenu, attendu) => {
  const bon = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!bon) ko++;
  console.log('  ' + (bon ? '✓' : '✗ ÉCHEC') + ' ' + nom
    + (bon ? '' : '\n      attendu ' + JSON.stringify(attendu) + '\n      obtenu  ' + JSON.stringify(obtenu)));
};

const VOYAGE = { nom: 'Lisbonne' };
const JOURS = { 1: { etapes: [{ heure: '09:00', titre: 'Café', description: '', lieu: null, type: 'visite' }] } };

console.log('\nsafeState — les quatre directions');

/* 1. Données écrites AVANT le tampon : rien ne doit être perdu. */
{
  const r = safeState({ mode: 'train', notes: 'mes notes', trip: VOYAGE, cache: { days: JOURS } });
  essai('sans tampon — la version est posée', r.v, 1);
  essai('sans tampon — le mode est respecté', r.mode, 'train');
  essai('sans tampon — les notes survivent', r.notes, 'mes notes');
  essai('sans tampon — le voyage survit', !!r.trip, true);
}

/* 2. Données à jour : rien ne bouge. */
{
  const r = safeState({ v: 1, mode: 'car', notes: 'ok', trip: VOYAGE });
  essai('à jour — le mode est intact', r.mode, 'car');
}

/* 3. LA RÉTROGRADATION — le cas signalé sur Reddit.
   Des données écrites par une version PLUS RÉCENTE. On ne peut pas migrer vers
   le passé : les champs interprétés reviennent à leur valeur sûre, tout ce qui
   est structurel survit. Et surtout : on ne REFUSE PAS de charger — le voyage
   disparaîtrait pendant que l'utilisateur est hors ligne. */
{
  const r = safeState({ v: 9, mode: 'car', notes: 'texte intact', trip: VOYAGE, cache: { days: JOURS } });
  essai('du futur — le mode interprété est neutralisé', r.mode, 'plane');
  essai('du futur — les notes NE sont PAS touchées', r.notes, 'texte intact');
  essai('du futur — le voyage est conservé', !!r.trip, true);
  essai('du futur — les étapes sont conservées', r.cache.days[1].etapes[0].titre, 'Café');
}

/* 4. Données illisibles : on repart d'un état propre sans lever d'exception. */
{
  const r = safeState('nawak');
  essai('illisible — version posée', r.v, 1);
  essai('illisible — mode par défaut', r.mode, 'plane');
  essai('illisible — étape ramenée à 1', r.step, 1);
}

if (ko) { console.log('\n✗ ' + ko + ' échec(s) sur le contrat de l\'état.'); process.exit(1); }
console.log('\n✓ Le contrat de l\'état tient dans les quatre directions.');
