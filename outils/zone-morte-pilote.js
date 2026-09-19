/* ============================================================
   LE PILOTE — enchaîne les douze états de départ tout seul
   ------------------------------------------------------------
   Ce fichier est INJECTÉ dans la copie de diagnostic par zone-morte.js.
   Il n'est jamais publié et ne sert qu'au diagnostic.

   Pourquoi pas un vrai pilote de navigateur (puppeteer, playwright) :
   Acolyte n'a aucune dépendance et aucune compilation, volontairement.
   En ajouter une lourde pour un outil de diagnostic serait payer très
   cher le confort d'une commande. Le navigateur sait déjà tout faire —
   poser un état, recharger, lire le résultat. Il suffit de tenir la file
   d'attente dans sessionStorage, qui survit aux rechargements.

   ⚠️ Une zone morte ne mord que PENDANT l'évaluation du script. Cliquer
   après le chargement ne peut rien révéler : seul l'état de DÉPART
   compte. D'où douze rechargements, et pas douze parcours d'interface.
============================================================ */
(function(){
  var CLE = 'zm_pilote';
  var J = function(n){ return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); };

  /* Un plan minimal mais complet : chaque onglet doit avoir de quoi rendre. */
  function plan(){
    return {
      transport:{ mode:'avion', pourquoi:'Vol direct.', details:'Orly → Lisbonne.', prix_estime:'90-160€' },
      logement:{ type:'hôtel', quartier:'Baixa', prix_nuit:'80-120€', pourquoi:'Central.' },
      programme:[{ jour:1, resume:'Alfama', lieux:['Castelo','Sé'] },
                 { jour:2, resume:'Belém', lieux:['Torre'] }],
      budget:{ total:640, repartition:'transport 130€' },
      sur_place:'Viva Viagem.', a_reserver:['Palácio da Pena — 1 semaine avant'],
      conseil_cle:'Tram 28 tôt.', formalites:{ visa:'Aucun visa', passeport:'CNI' },
      couts_sur_place:[{ quoi:'Café', prix:'1,20 €' }], _geo:{ 'Baixa':[38.71,-9.14] }
    };
  }
  function poseVoyage(departDans, onglet){
    var p = plan();
    localStorage.setItem('acolite_trip_v2', JSON.stringify({
      /* ⚠️ La version DOIT etre celle du contrat courant (ETAT_V). J'avais
         ecrit 99 : safeState y voyait des donnees venues du futur, neutralisait
         les champs interpretes et affichait un avertissement. Les quatorze
         etats tournaient donc tous en mode degrade — c'est-a-dire qu'aucun
         n'etait l'etat normal qu'on voulait tester. */
      v: 1, step:3, trip:{ nom:'Lisbonne', pays:'Portugal' },
      destinations:[{ nom:'Lisbonne', pays:'Portugal' }],
      cache:{ plan:p }, plan:p,
      prefs:{ depart:J(departDans), days:'5 jours', adults:2, from:'Paris' },
      notes:'', spends:[], checklist:{}, maison:{}, reserves:{}, resas:[],
      chatLog:[], planAnswers:[], propAnswers:[]
    }));
    localStorage.setItem('acolite_questions', '1');
    localStorage.setItem('acolite_onboarded', '1');
    if(onglet) localStorage.setItem('acolite_onglet', onglet);
  }

  var ETATS = [
    { n:'navigateur vierge',        f:function(){ localStorage.clear(); } },
    { n:'voyage avant le séjour',   f:function(){ localStorage.clear(); poseVoyage(10, 'programme'); } },
    { n:'voyage pendant le séjour', f:function(){ localStorage.clear(); poseVoyage(-1, 'programme'); } },
    { n:'voyage terminé',           f:function(){ localStorage.clear(); poseVoyage(-30, 'programme'); } },
    { n:'onglet logement',          f:function(){ localStorage.clear(); poseVoyage(10, 'logement'); } },
    { n:'onglet transport',         f:function(){ localStorage.clear(); poseVoyage(10, 'transport'); } },
    { n:'onglet budget',            f:function(){ localStorage.clear(); poseVoyage(10, 'budget'); } },
    { n:'onglet manger',            f:function(){ localStorage.clear(); poseVoyage(10, 'manger'); } },
    { n:'onglet événements',        f:function(){ localStorage.clear(); poseVoyage(10, 'events'); } },
    { n:'onglet papiers',           f:function(){ localStorage.clear(); poseVoyage(10, 'papiers'); } },
    { n:'onglet maison',            f:function(){ localStorage.clear(); poseVoyage(10, 'maison'); } },
    { n:'profil rempli',            f:function(){ localStorage.clear(); poseVoyage(10, 'programme');
        localStorage.setItem('acolite_gouts', JSON.stringify({ retraits:[{ t:'Azulejos', y:'visite', q:Date.now() }] }));
        localStorage.setItem('acolite_history', JSON.stringify([{ nom:'Porto', pays:'Portugal', quand:Date.now() - 4e8 }])); } },
    { n:'connecté, politique non acceptée', f:function(){ localStorage.clear(); poseVoyage(10, 'programme');
        localStorage.setItem('acolite_user', JSON.stringify({ email:'t@t.fr', pseudo:'t' }));
        localStorage.setItem('acolite_logged', '1');
        localStorage.setItem('acolite_token', 'jeton-de-test'); } },
    { n:'connecté, politique acceptée', f:function(){ localStorage.clear(); poseVoyage(10, 'programme');
        localStorage.setItem('acolite_user', JSON.stringify({ email:'t@t.fr', pseudo:'t' }));
        localStorage.setItem('acolite_logged', '1');
        localStorage.setItem('acolite_token', 'jeton-de-test');
        localStorage.setItem('acolite_privacy', '2026-07-31'); } }
  ];

  function lis(){ try{ return JSON.parse(sessionStorage.getItem(CLE)) || null; }catch(e){ return null; } }
  function ecris(o){ try{ sessionStorage.setItem(CLE, JSON.stringify(o)); }catch(e){} }

  window.__zmPiloteDemarre = function(){
    ecris({ i: 0, res: [] });
    ETATS[0].f();
    /* on neutralise les invites qui s'ouvrent d'elles-memes : elles
       recouvriraient le bilan, et elles ne changent rien a ce qu'on mesure */
    try{ localStorage.setItem('acolite_install_ask', String(Date.now())); }catch(e){}
    location.reload();
  };

  /* Appelé par le rapport, une fois la page stabilisée. Renvoie true si un
     parcours est en cours (le rapport se tait alors, le pilote parle). */
  window.__zmPiloteAvance = function(zones){
    var e = lis();
    if(!e) return false;
    var etat = ETATS[e.i];
    e.res.push({ etat: etat ? etat.n : '?', zones: zones.slice() });
    e.i++;
    if(e.i < ETATS.length){
      ecris(e);
      ETATS[e.i].f();
      try{ localStorage.setItem('acolite_install_ask', String(Date.now())); }catch(err){}
      location.reload();
      return true;
    }
    /* Fin du parcours. ⚠️ ON N'AFFICHE PAS LE BILAN DIRECTEMENT : la page
       peut encore recharger apres coup (un état pose une invite, un calque
       se ferme, le service worker se met a jour) et le bilan disparaitrait
       avec elle — c'est exactement ce qui est arrive au premier essai. On
       le DEPOSE, et le rapport l'affichera au chargement suivant, puis le
       consommera. */
    try{
      sessionStorage.removeItem(CLE);
      sessionStorage.setItem('zm_bilan', JSON.stringify(e.res));
    }catch(err){}
    window.__zmBilan(e.res);
    return true;
  };

  /* Un bilan depose attend d'etre montre : on le rend, une seule fois. */
  window.__zmBilanEnAttente = function(){
    try{
      var b = sessionStorage.getItem('zm_bilan');
      if(!b) return null;
      sessionStorage.removeItem('zm_bilan');
      return JSON.parse(b);
    }catch(e){ return null; }
  };

  window.__zmPiloteEnCours = function(){ var e = lis(); return e ? (e.i + 1) + '/' + ETATS.length : null; };
  window.__zmPiloteEtats = ETATS.length;
})();
