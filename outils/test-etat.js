#!/usr/bin/env node
/* ============================================================
   BANC D'ESSAI DE safeState() — le contrat de l'état du voyage
   ------------------------------------------------------------
   POURQUOI CE FICHIER EXISTE. Un lecteur du post Reddit a signalé qu'un
   validateur de FORME ne voit pas la dérive de SENS : si une version change ce
   que signifie « mode », l'ancien code accepte en silence et la carte devient
   faussement juste. Puis il a ajouté le cas que je n'avais pas vu — la
   RÉTROGRADATION : la v2 écrit, la v1 relit hors ligne.

   Puis, une réponse plus tard, il a trouvé le trou dans MA correction :
   « la v9 écrit la sauvegarde neutre, l'application se reconnecte et la v2 la
   lit. Sait-elle que le mode original a été perdu, ou peut-elle écraser la
   source avec la sauvegarde ? » — elle pouvait. Neutraliser suffisait pour
   AFFICHER, pas pour ÉCRIRE : un seul save() et l'original disparaissait, sans
   qu'aucune version ne puisse plus savoir qu'il avait existé.

   D'où les deux familles d'essais ci-dessous. Les quatre directions vérifient
   la LECTURE ; l'aller-retour vérifie ce qui se passe quand on RÉÉCRIT. C'est
   le second qui manquait, et c'est là qu'était le défaut.

   ⚠️ COMMENT ÇA MARCHE, ET POURQUOI PAS AUTREMENT. app.js est un script de
   NAVIGATEUR : le charger tel quel dans Node échoue (window, document,
   localStorage). On extrait donc seulement le bloc des fonctions de
   validation — elles sont pures, elles ne touchent à rien — et on l'évalue.
   Recopier ces fonctions ici serait pire : deux versions divergeraient, et le
   test finirait par valider un code qui n'est plus celui qui tourne.

   ⚠️ ET ON CONSTRUIT PLUSIEURS VERSIONS DU MÊME CODE. Pour rejouer un
   aller-retour il faut une v1 ET une v9 : on réévalue donc le même bloc en
   remplaçant la seule ligne `const ETAT_V = …`. C'est bien le code d'app.js qui
   tourne des deux côtés, pas une imitation — sinon on testerait sa propre idée
   du contrat au lieu du contrat.
============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');

/* Bornes du bloc à extraire. Ce sont des ancres de TEXTE et non des numéros de
   ligne : un numéro se périme au premier ajout. */
const finDeBloc = (depuis) => {
  let prof = 0;
  for (let j = src.indexOf('{', depuis); j < src.length; j++) {
    if (src[j] === '{') prof++;
    else if (src[j] === '}') { prof--; if (prof === 0) return j + 1; }
  }
  return -1;
};

const debut = src.indexOf('const _sTxt =');
const ancre = src.indexOf('function safeState(raw){');
const ancreChoix = src.indexOf('function etatChoixExplicite(champ){');
if (debut < 0 || ancre < 0 || ancreChoix < 0) {
  console.log('✗ ERREUR  impossible de localiser safeState / etatChoixExplicite dans app.js');
  process.exit(1);
}
const fin = finDeBloc(ancre);
const finChoix = finDeBloc(ancreChoix);
if (fin < 0 || finChoix < 0) { console.log('✗ ERREUR  bloc mal fermé ?'); process.exit(1); }

const BLOC = src.slice(debut, fin);
const BLOC_CHOIX = src.slice(ancreChoix, finChoix);
if (!/const ETAT_V = \d+;/.test(BLOC)) {
  console.log('✗ ERREUR  ETAT_V introuvable dans le bloc extrait — le banc ne peut pas simuler deux versions');
  process.exit(1);
}

/* Construit « l'app en version N » à partir du code réel. */
function construire(version) {
  const bloc = BLOC.replace(/const ETAT_V = \d+;/, 'const ETAT_V = ' + version + ';');
  try {
    /* eslint-disable no-new-func */
    return new Function(`
      let state = {};
      function futurBarMaj(){}
      ${bloc}
      ${BLOC_CHOIX}
      return {
        safeState, etatChoixExplicite, ETAT_V,
        get futur(){ return _etatDuFutur; },
        get state(){ return state; },
        set state(v){ state = v; }
      };
    `)();
  } catch (e) {
    console.log('✗ ERREUR  le bloc extrait ne s\'évalue pas en v' + version + ' : ' + e.message);
    process.exit(1);
  }
}

const V1 = construire(1);
const V5 = construire(5);
const V9 = construire(9);

let ko = 0;
const essai = (nom, obtenu, attendu) => {
  const bon = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!bon) ko++;
  console.log('  ' + (bon ? '✓' : '✗ ÉCHEC') + ' ' + nom
    + (bon ? '' : '\n      attendu ' + JSON.stringify(attendu) + '\n      obtenu  ' + JSON.stringify(obtenu)));
};

const VOYAGE = { nom: 'Lisbonne' };
const JOURS = { 1: { etapes: [{ heure: '09:00', titre: 'Café', description: '', lieu: null, type: 'visite' }] } };
/* Ce qui part sur le disque, c'est du JSON : on passe par là pour que les
   essais voient exactement ce qu'un vrai save() aurait écrit. */
const disque = o => JSON.parse(JSON.stringify(o));

console.log('\nsafeState — les quatre directions (LECTURE)');

/* 1. Données écrites AVANT le tampon : rien ne doit être perdu. */
{
  const r = V1.safeState({ mode: 'train', notes: 'mes notes', trip: VOYAGE, cache: { days: JOURS } });
  essai('sans tampon — la version est posée', r.v, 1);
  essai('sans tampon — le mode est respecté', r.mode, 'train');
  essai('sans tampon — les notes survivent', r.notes, 'mes notes');
  essai('sans tampon — le voyage survit', !!r.trip, true);
}

/* 2. Données à jour : rien ne bouge. */
{
  const r = V1.safeState({ v: 1, mode: 'car', notes: 'ok', trip: VOYAGE });
  essai('à jour — le mode est intact', r.mode, 'car');
  essai('à jour — aucune quarantaine créée', r._futur, undefined);
}

/* 3. LA RÉTROGRADATION — le premier cas signalé sur Reddit. */
{
  const r = V1.safeState({ v: 9, mode: 'car', notes: 'texte intact', trip: VOYAGE, cache: { days: JOURS } });
  essai('du futur — le mode interprété est neutralisé', r.mode, 'plane');
  essai('du futur — les notes NE sont PAS touchées', r.notes, 'texte intact');
  essai('du futur — le voyage est conservé', !!r.trip, true);
  essai('du futur — les étapes sont conservées', r.cache.days[1].etapes[0].titre, 'Café');
  essai('du futur — le drapeau est levé', V1.futur, true);
}

/* 4. Données illisibles : on repart d'un état propre sans lever d'exception. */
{
  const r = V1.safeState('nawak');
  essai('illisible — version posée', r.v, 1);
  essai('illisible — mode par défaut', r.mode, 'plane');
  essai('illisible — étape ramenée à 1', r.step, 1);
}

console.log('\nL\'ALLER-RETOUR — écrire, relire, revenir (le trou trouvé sur Reddit)');

/* 5. LE SCÉNARIO EXACT DE LA QUESTION.
   La v9 écrit · la v1 lit et neutralise · la v1 SAUVEGARDE · la v9 revient.
   Avant le correctif, l'original était détruit à l'étape 3 et la v9 ne pouvait
   plus le savoir : le tampon disait v1, donc « vieilles données normales ». */
{
  const ecritParV9 = { v: 9, mode: 'car', notes: 'mes notes', trip: VOYAGE, cache: { days: JOURS } };

  const enV1 = V1.safeState(ecritParV9);
  essai('aller-retour — la v1 affiche une valeur sûre', enV1.mode, 'plane');
  essai('aller-retour — l\'original est mis de côté, pas jeté', enV1._futur.mode, 'car');
  essai('aller-retour — la boîte retient sa version d\'origine', enV1._futur.v, 9);

  /* le save() qui détruisait tout */
  const surDisque = disque(enV1);
  essai('aller-retour — la boîte SURVIT à la liste blanche', surDisque._futur.mode, 'car');

  /* la v1 relit ce qu'elle vient d'écrire : elle ne doit pas se croire à jour */
  const relueParV1 = V1.safeState(surDisque);
  essai('aller-retour — la v1 relit et retient toujours', relueParV1._futur.mode, 'car');
  essai('aller-retour — le drapeau reste levé', V1.futur, true);

  /* LE RETOUR DE LA V9 — la question posée, mot pour mot */
  const deRetourEnV9 = V9.safeState(surDisque);
  essai('LE RETOUR — la v9 RESTAURE le mode original', deRetourEnV9.mode, 'car');
  essai('LE RETOUR — la boîte est jetée une fois comprise', deRetourEnV9._futur, undefined);
  essai('LE RETOUR — plus rien n\'est retenu', V9.futur, false);
  essai('LE RETOUR — les notes ont traversé intactes', deRetourEnV9.notes, 'mes notes');
}

/* 6. LE RELAIS — une version INTERMÉDIAIRE ne doit ni lire ni casser la boîte.
   La v5 lit un disque estampillé v1 qui transporte une boîte v9 : elle ne
   comprend pas plus la v9 que la v1, donc elle transmet sans toucher. */
{
  const surDisque = disque(V1.safeState({ v: 9, mode: 'car', trip: VOYAGE }));
  const enV5 = V5.safeState(surDisque);
  essai('relais — la v5 ne restaure PAS ce qu\'elle ne comprend pas', enV5.mode, 'plane');
  essai('relais — elle transmet la boîte telle quelle', enV5._futur.mode, 'car');
  essai('relais — le drapeau est levé alors que le tampon dit v1', V5.futur, true);
  /* et la v9, après ce détour par la v5, retrouve quand même son bien */
  essai('relais — la v9 restaure après le détour', V9.safeState(disque(enV5)).mode, 'car');
}

/* 7. DEUX PASSAGES DU FUTUR — on garde la mise de côté la PLUS ANCIENNE.
   Si une v9 puis une v5 écrivent, c'est la valeur v9 qui est la plus proche de
   ce que l'utilisateur avait choisi : une boîte déjà pleine ne s'écrase pas. */
{
  const boiteV9 = disque(V1.safeState({ v: 9, mode: 'car', trip: VOYAGE }));
  const puisV5 = V1.safeState({ ...boiteV9, v: 5, mode: 'train' });
  essai('deux futurs — la boîte d\'origine n\'est pas écrasée', puisV5._futur.mode, 'car');
  essai('deux futurs — sa version reste la plus haute', puisV5._futur.v, 9);
}

/* 8. LE CHOIX EXPLICITE PRIME. Si l'utilisateur sélectionne lui-même un mode
   pendant qu'une quarantaine est retenue, restaurer l'ancienne valeur plus tard
   défferait son travail. setMode() appelle etatChoixExplicite(). */
{
  const app = construire(1);
  app.state = app.safeState({ v: 9, mode: 'car', trip: VOYAGE });
  essai('choix explicite — la boîte est bien là avant', app.state._futur.mode, 'car');
  app.etatChoixExplicite('mode');
  app.state.mode = 'train';
  essai('choix explicite — la boîte est libérée', app.state._futur, undefined);
  essai('choix explicite — le drapeau retombe', app.futur, false);
  /* la v9 revient : elle doit respecter le choix récent, pas ressusciter 'car' */
  essai('choix explicite — la v9 ne ressuscite rien', V9.safeState(disque(app.state)).mode, 'train');
}

/* 9. UNE BOÎTE ABÎMÉE NE DOIT RIEN CASSER. Elle vient du disque, donc de
   l'extérieur : au pire on la jette, jamais on ne lève d'exception. */
{
  const abimees = [
    ['boîte à null',        { v: 1, mode: 'car', _futur: null }],
    ['boîte en tableau',    { v: 1, mode: 'car', _futur: [1, 2] }],
    ['boîte en texte',      { v: 1, mode: 'car', _futur: 'nawak' }],
    ['boîte sans version',  { v: 1, mode: 'car', _futur: { mode: 'train' } }],
    ['version aberrante',   { v: 1, mode: 'car', _futur: { v: -3, mode: 'train' } }],
    ['version démesurée',   { v: 1, mode: 'car', _futur: { v: 1e9, mode: 'train' } }]
  ];
  for (const [nom, entree] of abimees) {
    let r;
    try { r = V1.safeState(entree); } catch (e) { r = { mode: 'EXCEPTION : ' + e.message }; }
    essai(nom + ' — ignorée, le mode du disque tient', r.mode, 'car');
  }
}

if (ko) { console.log('\n✗ ' + ko + ' échec(s) sur le contrat de l\'état.'); process.exit(1); }
console.log('\n✓ Le contrat de l\'état tient : les quatre directions ET l\'aller-retour.');
