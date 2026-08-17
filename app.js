/* ============================================================
   ACOLYTE v2 — copilote de voyage dual-AI
   ✦ Gemini = tâches lourdes (destinations, itinéraires, budget…)
   ⚡ Groq   = tâches simples déléguées (valise, phrases, infos, concierge)
   Fichier unique · zéro backend · localStorage
============================================================ */

/* ============================================================
   ÉCRAN DE DÉMARRAGE — placé TOUT EN HAUT, sans aucune dépendance.
   Il se retire quoi qu'il arrive : si le reste du fichier plante,
   l'erreur s'affiche à l'écran au lieu de bloquer sur le splash.
============================================================ */
(function(){
  var boot = document.getElementById('boot');
  if(!boot) return;
  var bar = boot.querySelector('.boot-bar i');
  var lbl = document.getElementById('bootStep');
  var steps = [[18,'Chargement des styles'],[42,'Réveil du copilote'],[68,'Connexion aux moteurs de prix'],[88,'Préparation de ton voyage'],[100,'Prêt au décollage ✈️']];
  var i = 0, dead = false;

  function hide(){
    if(dead) return;
    dead = true;
    boot.classList.add('gone');
    setTimeout(function(){ if(boot.parentNode) boot.parentNode.removeChild(boot); }, 500);
  }
  function tick(){
    if(dead) return;
    if(i >= steps.length){ setTimeout(hide, 250); return; }
    var s = steps[i++];
    if(bar) bar.style.width = s[0] + '%';
    if(lbl) lbl.textContent = s[1];
    setTimeout(tick, 190);
  }
  tick();

  /* sécurité : jamais bloqué plus de 5 s */
  setTimeout(hide, 5000);

  /* si le script plante pendant le démarrage, on le DIT au lieu de rester figé */
  window.addEventListener('error', function(e){
    if(dead) return;
    if(lbl){
      lbl.style.color = '#FF6B00';
      lbl.style.fontSize = '.62rem';
      lbl.textContent = '⚠️ ' + (e.message || 'erreur au démarrage');
    }
    setTimeout(hide, 2500);
  });
  window.__acolyteBoot = { hide: hide };
})();

const LS_GEM   = 'acolite_gemini_key';
const LS_GEMM  = 'acolite_gem_model_v2';   // modèle Gemini auto-détecté (v2 : re-détection après passage à la génération 3.x)
const LS_GROQ  = 'acolite_groq_key';
const LS_GROQM = 'acolite_groq_model';
const LS_TP    = 'acolite_tp_token';
const LS_TRIP  = 'acolite_trip_v2';
/* Ordre de préférence — le premier dispo sur la clé sera utilisé */
/* Du meilleur au plus prudent — la bascule automatique descend cette liste
   quand un modèle est saturé (503) ou hors quota (429). */
const GEM_PREFERRED = ['gemini-3.5-flash','gemini-3-flash-preview','gemini-2.5-flash','gemini-flash-latest','gemini-2.0-flash','gemini-2.5-flash-lite','gemini-2.5-pro','gemini-pro-latest'];

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ============================================================
   LANGUE — français d'origine, anglais en option
   ------------------------------------------------------------
   Au premier passage on suit la langue du navigateur : un visiteur
   anglophone tombe directement sur un site en anglais, sans rien chercher.
   Son choix explicite, lui, prime pour toujours.
   Déclaré ICI, tout en haut : les dates et les prompts en dépendent.
============================================================ */
const LS_LANG = 'acolite_lang';
function langInit(){
  try{
    const choisi = localStorage.getItem(LS_LANG);
    if(choisi === 'en' || choisi === 'fr') return choisi;
  }catch(e){}
  const n = (navigator.language || 'fr').toLowerCase();
  return n.startsWith('fr') ? 'fr' : 'en';
}
let LANG = langInit();
const isEN = () => LANG === 'en';
/* locale des dates et des heures : suit la langue */
const LOC = () => LANG === 'en' ? 'en-GB' : 'fr-FR';

let state = {
  step: 1,
  prefs: null,
  destinations: [],
  trip: null,
  mode: 'plane',
  cache: {},          // réponses IA
  checklist: {},      // valise cochée
  maison: {},         // « avant de partir » cochée
  spends: [],         // dépenses réelles
  chatLog: [],        // concierge
  notes: '',          // carnet
  resas: [],          // réservations
  planAnswers: [],    // réponses aux questions du plan
  propAnswers: []     // réponses d'affinage des propositions
};

/* ============================================================
   ASSAINISSEMENT DES DONNÉES IMPORTÉES
   ------------------------------------------------------------
   Un fichier de sauvegarde, un QR ou un lien #v= viennent de l'EXTÉRIEUR.
   Avant, restoreTrip() fusionnait le JSON tel quel dans l'état global :
   n'importe quelle clé, n'importe quel type, n'importe quelle taille.
   On ne fait plus confiance : liste blanche de clés, type vérifié,
   profondeur et longueur bornées. Ce qui n'est pas reconnu est jeté.
============================================================ */
/* Une carte hors-ligne est une image encodée dans l'URL elle-même. On
   n'accepte QUE ça : sans ce filtre, une sauvegarde piégée peut écrire ce
   qu'elle veut dans l'attribut src d'une balise <img>. */
function safeDataImg(v){
  const s = String(v ?? '');
  return /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]{16,}$/.test(s) && s.length < 4e6 ? s : '';
}
const _sTxt = (v, max = 400) => typeof v === 'string' ? v.slice(0, max) : '';
const _sNum = (v, min, max) => { const n = +v; return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min; };
const _sBool = v => v === true;
/* Recopie récursive et bornée d'une valeur venue de l'IA ou d'un import.
   On garde la forme (objets, tableaux, textes, nombres) mais on refuse la
   profondeur infinie, les clés dangereuses et les tailles absurdes. */
function safeJSON(v, prof = 0){
  if(prof > 6) return null;
  if(v === null || typeof v === 'boolean') return v;
  if(typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if(typeof v === 'string') return v.slice(0, 4000);
  if(Array.isArray(v)) return v.slice(0, 200).map(x => safeJSON(x, prof + 1));
  if(typeof v !== 'object') return null;
  const out = {};
  let n = 0;
  for(const k of Object.keys(v)){
    /* __proto__ et compagnie n'ont rien à faire dans des données */
    if(k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if(++n > 120) break;
    out[k.slice(0, 80)] = safeJSON(v[k], prof + 1);
  }
  return out;
}
/* Le cache IA, en ne laissant passer les cartes que si ce sont de vraies images */
function safeCache(c){
  const o = safeJSON(c) || {};
  if(o.maps && typeof o.maps === 'object'){
    const m = {};
    for(const k of Object.keys(o.maps).slice(0, 40)){
      const img = safeDataImg(o.maps[k]);
      if(img) m[String(k).slice(0, 8)] = img;
    }
    o.maps = m;
  } else delete o.maps;
  return o;
}
/* ============================================================
   VERSION DE CONTRAT DE L'ÉTAT
   ------------------------------------------------------------
   safeState() protège contre la dérive de FORME : un champ manquant prend sa
   valeur par défaut, un mauvais type est corrigé, une clé inconnue est ignorée.
   Mais il ne voit RIEN de la dérive de SENS. Si une version change ce que
   signifie une valeur — l'unité d'un nombre, le sens de « mode » — le
   validateur laisse passer et la carte devient FAUSSEMENT JUSTE, ce qui est
   pire que cassée.

   ⚠️ ET LE DANGER VA DANS LES DEUX SENS. On pense d'abord au code neuf lisant
   des données vieilles. Mais l'inverse arrive aussi, et c'est plus vicieux :
   la v2 écrit un nouveau sens de « mode », puis la v1 le relit HORS LIGNE
   (service worker, autre appareil, onglet resté ouvert). La v1 ne peut pas
   savoir ce qui a changé — elle accepterait en silence.

   D'où trois comportements, pas un :
     · données à jour        → rien à faire
     · données PLUS VIEILLES → on migre, champ par champ
     · données PLUS RÉCENTES → on ne peut pas migrer vers le passé. On garde
       tout ce qui est STRUCTUREL (dates, titres, heures : leur sens ne change
       pas) et on remet à leur valeur sûre les seuls champs INTERPRÉTÉS. Refuser
       de charger serait hostile : le voyage disparaîtrait précisément quand
       l'utilisateur est hors ligne et en a besoin.

   ⚠️ Incrémenter ETAT_V est OBLIGATOIRE dès qu'un champ change de SENS — pas
   quand on en ajoute un, safeState s'en charge déjà.
============================================================ */
const ETAT_V = 1;
/* Les champs dont la valeur s'INTERPRÈTE, donc ceux qui peuvent mentir après un
   changement de contrat. Les autres (titres, heures, notes) sont du texte : leur
   sens ne dérive pas. */
const ETAT_INTERPRETE = { mode: 'plane' };
/* Migrations vers l'avant, appliquées dans l'ordre. Vide aujourd'hui : le
   tampon vient d'être posé. Chaque entrée reçoit l'objet brut et le rend
   corrigé — c'est ici qu'on écrira « en v2, mode:'car' signifiait autre chose ».
   ⚠️ Une migration ne doit JAMAIS supposer que les champs existent. */
const ETAT_MIGRATIONS = {
  /* exemple, à décommenter le jour où ce sera vrai :
  2: o => { if(o.mode === 'car') o.mode = 'voiture'; return o; }
  */
};
/* Vrai quand on RETIENT des valeurs qu'on ne sait pas lire — soit qu'on vienne
   de lire des données d'une version plus récente, soit qu'on transporte une
   quarantaine posée par une autre version. Lu par futurBarMaj(). */
var _etatDuFutur = false;

/* ------------------------------------------------------------
   LA QUARANTAINE — pourquoi neutraliser ne suffisait PAS.
   ------------------------------------------------------------
   ⚠️ CE BLOC EXISTE À CAUSE D'UN TROU RÉEL, signalé par le même lecteur du post
   Reddit que la rétrogradation elle-même. La première version remettait les
   champs interprétés à leur valeur sûre, levait le drapeau, et s'arrêtait là.
   C'était correct pour AFFICHER. C'était destructeur pour ÉCRIRE :

     la v9 écrit {v:9, mode:'car'}
     la v1 lit    → drapeau levé, mode ramené à 'plane'   ← correct
     un seul save() → le disque contient {v:1, mode:'plane'}
     la v9 revient → tampon v1, aucun drapeau : pour elle ce sont de VIEILLES
                     données parfaitement normales. Le 'car' n'existe plus
                     nulle part, et rien ne dit qu'il a existé.

   La perte devenait indiscernable d'un choix de l'utilisateur — exactement le
   « faussement juste » que tout ce mécanisme devait empêcher. Et comme save()
   déclenche la synchro, l'état appauvri partait sur le serveur et redescendait
   sur l'appareil resté en v9 : le rayon d'action n'était pas un navigateur,
   c'était le compte.

   La règle est donc : on ne DÉTRUIT pas ce qu'on ne comprend pas, on le MET DE
   CÔTÉ. La version courante affiche une valeur sûre ; l'originale voyage dans
   `_futur`, jamais lue, jamais interprétée, seulement transportée — jusqu'à une
   version qui sait enfin la relire, qui la restaure et jette la boîte.
------------------------------------------------------------ */
/* La boîte vient du disque, donc de l'EXTÉRIEUR : même méfiance que le reste.
   Numéro de version entier plausible, et uniquement les clés interprétées. */
function safeFutur(q){
  if(!q || typeof q !== 'object' || Array.isArray(q)) return null;
  const v = Number(q.v);
  if(!Number.isInteger(v) || v <= 0 || v > 9999) return null;
  const boite = { v };
  for(const k of Object.keys(ETAT_INTERPRETE)){
    if(q[k] !== undefined) boite[k] = safeJSON(q[k], 4);
  }
  return boite;
}

/* Reconstruit un état propre à partir de données non fiables.
   On part TOUJOURS de la forme attendue : une clé inconnue est ignorée. */
function safeState(raw){
  let s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  s = { ...s };
  /* Version du contrat qui a ÉCRIT ces données. Absente = antérieure au tampon. */
  const vu = Number(s.v) || 0;
  _etatDuFutur = false;
  let futur = safeFutur(s._futur);
  /* Version DEPUIS laquelle la chaîne de migration doit repartir. C'est `vu`
     en temps normal, mais la version de la BOÎTE quand on restaure : les
     valeurs qui en sortent sont dans la sémantique de celle-là, pas dans celle
     du disque. */
  let depuis = vu;

  if(vu > ETAT_V){
    /* Données du futur : on ne peut pas migrer vers le passé. On met de côté
       AVANT de neutraliser — c'est tout l'objet du correctif.
       On n'écrase une boîte existante que si celle-ci vient de plus loin :
       la plus ancienne mise de côté est la plus proche de l'original. */
    if(!futur || futur.v < vu){
      futur = { v: vu };
      for(const k of Object.keys(ETAT_INTERPRETE)){
        if(s[k] !== undefined) futur[k] = safeJSON(s[k], 4);
      }
    }
    for(const [k, def] of Object.entries(ETAT_INTERPRETE)) s[k] = def;
  }else if(futur && futur.v <= ETAT_V){
    /* On comprend enfin le contrat qui a rempli la boîte : on restaure, et on
       la jette. C'est le retour de la v9 dans le scénario ci-dessus. */
    for(const k of Object.keys(ETAT_INTERPRETE)){
      if(futur[k] !== undefined) s[k] = futur[k];
    }
    depuis = futur.v;
    futur = null;
  }

  /* Le drapeau ne dit plus « je viens de lire du futur » mais « je retiens des
     valeurs que je ne sais pas lire ». C'est ce qui compte pour l'utilisateur,
     et ça reste vrai tant que la boîte voyage — y compris pour une v5 qui lit
     un disque v1 portant une boîte v9. */
  _etatDuFutur = !!futur;

  if(depuis < ETAT_V){
    /* Migrations vers l'avant, dans l'ordre des versions.
       ⚠️ Départ à `depuis` et non à `vu` : après une restauration, rejouer les
       migrations depuis le tampon du disque les appliquerait DEUX FOIS aux
       valeurs sorties de la boîte. Ceci suppose qu'une migration ne touche que
       des champs INTERPRÉTÉS — c'est la promesse de ETAT_INTERPRETE. Le jour où
       une migration devra corriger un autre champ, ce champ doit d'abord être
       déclaré interprété. */
    for(let n = depuis + 1; n <= ETAT_V; n++){
      const m = ETAT_MIGRATIONS[n];
      if(typeof m === 'function'){ try{ s = m(s) || s; }catch(e){} }
    }
  }
  const st = {
    v: ETAT_V,
    step:         _sNum(s.step, 1, 3),
    prefs:        s.prefs && typeof s.prefs === 'object' ? safeJSON(s.prefs) : null,
    destinations: Array.isArray(s.destinations) ? s.destinations.slice(0, 12).map(x => safeJSON(x)) : [],
    trip:         s.trip && typeof s.trip === 'object' ? safeJSON(s.trip) : null,
    mode:         ['plane', 'train', 'car'].includes(s.mode) ? s.mode : 'plane',
    cache:        safeCache(s.cache),
    checklist:    s.checklist && typeof s.checklist === 'object' ? safeJSON(s.checklist) : {},
    /* ⚠️ Sans cette ligne, la liste « avant de partir » serait effacée à chaque
       rechargement : safeState est une LISTE BLANCHE, ce qui n'y figure pas
       n'existe pas. C'est exactement le piège que le contrat d'état est là
       pour rendre visible. */
    maison:       s.maison && typeof s.maison === 'object' ? safeJSON(s.maison) : {},
    spends:       Array.isArray(s.spends) ? s.spends.slice(0, 300).map(x => safeJSON(x)) : [],
    chatLog:      Array.isArray(s.chatLog) ? s.chatLog.slice(0, 100).map(x => safeJSON(x)) : [],
    notes:        _sTxt(s.notes, 20000),
    resas:        Array.isArray(s.resas) ? s.resas.slice(0, 100).map(x => safeJSON(x)) : [],
    planAnswers:  Array.isArray(s.planAnswers) ? s.planAnswers.slice(0, 30).map(x => _sTxt(x, 300)) : [],
    propAnswers:  Array.isArray(s.propAnswers) ? s.propAnswers.slice(0, 30).map(x => _sTxt(x, 300)) : [],
    board:        s.board && typeof s.board === 'object' ? safeJSON(s.board) : { votes:{}, comments:{} },
    planOk:       _sBool(s.planOk),
    modeManual:   _sBool(s.modeManual),
    _qsDone:      _sBool(s._qsDone)
  };
  if(!st.trip) st.step = 1;      /* pas de voyage → on ne peut pas être à l'étape 3 */
  /* ⚠️ LA BOÎTE DOIT ÊTRE DANS LA LISTE BLANCHE, sinon elle meurt ici.
     Ironie utile : le filtre qui protège l'état est exactement ce qui
     supprimerait la quarantaine. On ne l'écrit que si elle contient quelque
     chose — un `_futur:null` dans chaque sauvegarde ne servirait personne. */
  if(futur) st._futur = futur;
  return st;
}

/* L'utilisateur vient de CHOISIR lui-même un champ interprété. Sa décision
   d'aujourd'hui prime sur la valeur mise de côté hier : restaurer plus tard un
   'car' venu de la v9 par-dessus le 'train' qu'il vient de sélectionner serait
   défaire son travail sous prétexte de le protéger. On retire donc ce champ de
   la boîte, et la boîte elle-même quand elle est vide. */
function etatChoixExplicite(champ){
  const q = state && state._futur;
  if(!q || q[champ] === undefined) return;
  delete q[champ];
  if(!Object.keys(ETAT_INTERPRETE).some(k => q[k] !== undefined)){
    delete state._futur;
    _etatDuFutur = false;
    if(typeof futurBarMaj === 'function') futurBarMaj();
  }
}

/* Écriture localStorage tolérante : en navigation privée ou stockage plein,
   setItem lève une exception — ici on ne casse jamais le flux appelant. */
function lsSet(k, v){ try{ localStorage.setItem(k, v); return true; }catch(e){ return false; } }

/* save() ne doit JAMAIS lever d'exception : il est appelé partout (choix du voyage,
   navigation, dépenses…) et un quota dépassé bloquerait l'action en cours. */
function save(){
  try{
    localStorage.setItem(LS_TRIP, JSON.stringify(state));
  }catch(e){
    /* stockage plein → on ne garde que l'essentiel et on réessaie */
    try{
      const slim = {
        ...state,
        cache: { plan: state.cache?.plan, _real: state.cache?._real },
        chatLog: (state.chatLog || []).slice(-10)
      };
      localStorage.setItem(LS_TRIP, JSON.stringify(slim));
      state.cache = slim.cache;
      toast('💾 Stockage plein — cache allégé');
    }catch(e2){
      toast('⚠️ Sauvegarde impossible (stockage plein ou désactivé)');
    }
  }
  /* Envoi vers le compte, groupé et silencieux. Placé APRÈS le try/catch
     local : la sauvegarde dans le navigateur doit réussir même sans réseau,
     et une panne de synchronisation ne doit jamais bloquer l'utilisateur. */
  try{ if(typeof pushSync === 'function') pushSync(); }catch(e3){}
}
function load(){
  /* ⚠️ ON PASSE PAR safeState, et c'est le point important. Avant, cette ligne
     faisait un simple {...state, ...s} : les données du stockage écrasaient
     l'état sans aucun contrôle. Toute la protection de contrat — migration vers
     l'avant, neutralisation des champs interprétés venus d'une version plus
     récente — n'était donc appelée QUE sur l'import d'un fichier d'ami, jamais
     au démarrage normal. J'avais construit un garde-fou hors du chemin.
     Vérifié en écrivant un état estampillé v9 dans le stockage : sans cette
     ligne, mode restait 'car' et le drapeau ne se levait pas. */
  try{
    const s = JSON.parse(localStorage.getItem(LS_TRIP));
    if(s) state = safeState({ ...state, ...s });
  }catch(e){}
}

let toastT;
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(()=>t.classList.remove('show'), 3200);
}

/* ============================================================
   ROUTEUR IA — heavy → Gemini · light → Groq (si clé) sinon Gemini
============================================================ */
const CFG = window.ACOLITE_KEYS || {};
/* Backend Cloudflare : si configuré, les clés restent CÔTÉ SERVEUR.
   Le navigateur n'en envoie aucune — c'est le mode recommandé en public. */
const API = () => (CFG.proxy || '').replace(/\/+$/, '');
const useBackend = () => !!API();
/* En-têtes des appels au proxy IA. On joint le jeton de session : le serveur
   n'accepte plus les requêtes anonymes, sinon n'importe qui connaissant
   l'adresse du proxy (elle est dans config.js, donc publique) pourrait
   consommer le quota des clés API. */
const aiHeaders = () => {
  const h = { 'Content-Type': 'application/json' };
  const t = authToken();
  if(t) h.Authorization = 'Bearer ' + t;
  return h;
};
const gemKey  = () => CFG.gemini || localStorage.getItem(LS_GEM)  || '';
const groqKey = () => CFG.groq || localStorage.getItem(LS_GROQ) || '';
/* Du meilleur au plus prudent — bascule automatique si Groq retire un modèle */
const GROQ_PREFERRED = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
const groqModel = () => localStorage.getItem(LS_GROQM) || GROQ_PREFERRED[0];
const tpKey   = () => CFG.travelpayouts || localStorage.getItem(LS_TP) || '';
/* hasGroq() dit si Groq est CONFIGURÉ. groqDispo() dit s'il est joignable
   MAINTENANT — la nuance compte : après un 429, Groq reste configuré mais
   l'appeler ne fait que perdre du temps et du quota. */
const hasGroq = () => useBackend() || !!groqKey();
/* Fin de la mise au frais de Groq (horodatage). Volontairement en mémoire et
   non dans localStorage : une limitation dure une poignée de secondes, la
   garder d'une session à l'autre priverait l'app de Groq sans raison. */
let _groqFroidJusqu = 0;
function groqRefroidit(ms){
  /* borné : ni un délai ridicule qui ne sert à rien, ni une mise à l'écart
     interminable sur un message mal lu */
  const d = Math.min(Math.max(Number(ms) || 60000, 5000), 600000);
  _groqFroidJusqu = Math.max(_groqFroidJusqu, Date.now() + d);
  console.warn('[acolyte] Groq mis au frais ' + Math.round(d / 1000) + ' s — Gemini prend le relais');
}
const groqDispo = () => hasGroq() && Date.now() >= _groqFroidJusqu;

/* ============================================================
   RÉSEAU FAIBLE — le site doit rester utilisable en 2G/EDGE,
   en tunnel, ou avec une connexion qui saute. Trois leviers :
   1) détection (API Network Information + mesure des échecs)
   2) délais et charges allégés quand ça rame
   3) file de reprise : ce qui a échoué repart dès le retour du réseau
============================================================ */
let _netFails = 0;                       /* échecs réseau consécutifs */
const _netQueue = [];                    /* actions à rejouer au retour du réseau */
function netInfo(){ return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null; }
/* connexion lente : hors-ligne, 2g/slow-2g, économiseur de données, ou 3 échecs d'affilée */
function netSlow(){
  if(!navigator.onLine) return true;
  const c = netInfo();
  if(c){
    if(c.saveData) return true;
    if(/^(slow-2g|2g)$/.test(c.effectiveType || '')) return true;
  }
  return _netFails >= 3;
}
/* délai adapté : on laisse plus de temps quand le réseau est mauvais */
const netTimeout = base => netSlow() ? Math.round(base * 1.8) : base;
function netRetry(label, fn){                       /* rejoue `fn` au retour du réseau */
  if(_netQueue.some(x => x.label === label)) return;
  _netQueue.push({ label, fn });
  updateNetBadge();
}
function flushNetQueue(){
  if(!navigator.onLine || !_netQueue.length) return;
  const jobs = _netQueue.splice(0, _netQueue.length);
  updateNetBadge();
  toast(`📶 Connexion revenue — reprise de ${jobs.length} élément(s)`);
  jobs.forEach(j => { try{ j.fn(); }catch(e){} });
}
function updateNetBadge(){
  const b = $('#netBadge'); if(!b) return;
  const off = !navigator.onLine, slow = netSlow();
  b.hidden = !off && !slow;
  b.className = 'net-badge' + (off ? ' off' : '');
  b.textContent = off
    ? `📴 Hors connexion${_netQueue.length ? ` · ${_netQueue.length} en attente` : ''} — ton voyage reste consultable`
    : `🐢 Réseau lent — Acolyte allège les chargements`;
}
addEventListener('online',  () => { _netFails = 0; updateNetBadge(); flushNetQueue(); });
addEventListener('offline', () => { updateNetBadge(); });
netInfo()?.addEventListener?.('change', updateNetBadge);

/* fetch avec délai maximal : sans ça, un appel IA qui reste bloqué fait tourner
   le loader à l'infini. Au-delà de `ms`, on annule et l'appelant affiche l'erreur.
   Compte aussi les échecs pour détecter une connexion qui rame. */
function fetchT(url, opts = {}, ms = 45000){
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), netTimeout(ms));
  return fetch(url, { ...opts, signal: ac.signal })
    .then(r => { _netFails = 0; if(!navigator.onLine) updateNetBadge(); return r; })
    .catch(err => { _netFails++; if(_netFails === 3) updateNetBadge(); throw err; })
    .finally(() => clearTimeout(id));
}

/* --- Découverte automatique du modèle Gemini disponible sur la clé --- */
async function resolveGemModel(key, force = false){
  if(GEM_OVERRIDE) return GEM_OVERRIDE; /* bascule anti-saturation en cours */
  /* Réglage "Modèle" du panneau Préférences */
  if(SET?.model && SET.model !== 'auto') return SET.model;
  if(!force){
    const cached = localStorage.getItem(LS_GEMM);
    if(cached) return cached;
  }
  const r = await fetchT(useBackend()
    ? `${API()}/gemini/models`
    : `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=100`,
    useBackend() ? { headers: aiHeaders() } : {}, 10000);
  if(!r.ok){
    const msg = await gemErrMsg(r);
    throw new Error('LIST:' + msg);
  }
  const d = await r.json();
  const names = (d.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => (m.name || '').replace('models/',''));
  const pick = GEM_PREFERRED.find(p => names.includes(p))
    || names.find(n => n.includes('flash') && !n.includes('image') && !n.includes('tts'))
    || names[0];
  if(!pick) throw new Error('LIST:Aucun modèle compatible sur cette clé.');
  lsSet(LS_GEMM, pick);
  lsSet('acolite_gem_names', JSON.stringify(names)); /* pour la bascule auto */
  return pick;
}

/* Bascule automatique : quand un modèle est saturé (503) ou hors quota (429),
   on prend le suivant de GEM_PREFERRED disponible sur la clé. */
let GEM_OVERRIDE = ''; /* prioritaire le temps de la session, remis à zéro au rechargement */
function nextGemModel(current){
  let names = [];
  try{ names = JSON.parse(localStorage.getItem('acolite_gem_names')) || []; }catch(e){}
  const chain = GEM_PREFERRED.filter(m => !names.length || names.includes(m));
  const i = chain.indexOf(current);
  return chain[i + 1] || (i === -1 ? chain[0] : null);
}

/* --- Message d'erreur : GÉNÉRIQUE pour l'utilisateur, détail en console.
   L'utilisateur ne doit jamais voir de jargon technique ni de nom de service. --- */
async function gemErrMsg(r){
  let apiMsg = '';
  try{ const j = await r.json(); apiMsg = j.error?.message || ''; }catch(e){}
  console.warn('[acolyte] moteur IA', r.status, apiMsg);   /* pour le débogage, pas pour l'utilisateur */
  if(r.status === 429) return 'Beaucoup de monde en ce moment — réessaie dans une minute';
  if(r.status === 503) return 'Service momentanément surchargé — réessaie dans quelques secondes';
  return 'Un souci technique est survenu';
}

async function gemini(prompt, expectJson = true, maxTok = 4096, _retry = false, temp = 0.85, _hops = 0){
  const key = gemKey();
  if(!key && !useBackend()){ toast('😕 Service momentanément indisponible'); throw new Error('NO_KEY'); }
  let model;
  try{
    model = await resolveGemModel(key);
  }catch(e){
    const m = String(e.message||'').replace(/^LIST:/,'') || 'Connexion à Gemini impossible';
    toast('⚠️ ' + m);
    throw new Error('BAD_KEY');
  }
  const body = {
    contents: [{ role:'user', parts:[{ text: prompt }] }],
    generationConfig: { temperature: temp, maxOutputTokens: maxTok }
  };
  /* Réflexion des modèles récents : leurs tokens de "pensée" comptent dans
     maxOutputTokens (réponse vide sinon → EMPTY).
     - appels courts : réflexion coupée → réponse immédiate, jamais vide
     - appels lourds (propositions, plan…) : réflexion ACTIVÉE pour la qualité,
       avec de la place réservée EN PLUS du budget de réponse */
  const gc = body.generationConfig, isPro = /pro/.test(model);
  if(/2\.5-flash/.test(model)){
    gc.thinkingConfig = { thinkingBudget: maxTok < 2048 ? 0 : 2048 };
    if(maxTok >= 2048) gc.maxOutputTokens = maxTok + 2048;
  }else if(/gemini-3|flash-latest/.test(model) && !isPro){
    if(maxTok < 2048) gc.thinkingConfig = { thinkingBudget: 0 };
    else gc.maxOutputTokens = maxTok + 4096;          /* réflexion dynamique */
  }else if(isPro && /2\.5|gemini-3|latest/.test(model)){
    gc.maxOutputTokens = maxTok + 4096;               /* Pro : réflexion non désactivable */
  }
  /* plafond de sortie du modèle : 8192 pour la génération 2.0, 32768 au-delà */
  gc.maxOutputTokens = Math.min(gc.maxOutputTokens, /2\.0/.test(model) ? 8192 : 32768);
  if(expectJson) gc.responseMimeType = 'application/json';
  /* ⚠️ LE DÉLAI SUIT LA TAILLE DE LA DEMANDE. Il était fixé à 45 s pour tout —
     or une génération de propositions demande 8192 jetons de sortie PLUS un
     budget de réflexion : elle dépasse régulièrement 45 s, et l'abandon
     tombait en « La recherche a mis trop de temps » alors que le modèle
     travaillait encore. Une réponse courte garde 45 s, une génération lourde
     en obtient 90, une très lourde 120. On ne rallonge pas au hasard : on
     rallonge proportionnellement à ce qu'on a demandé. */
  const delai = maxTok >= 6000 ? 120000 : maxTok >= 3000 ? 90000 : 45000;
  const r = useBackend()
    ? await fetchT(`${API()}/gemini`, {
        method:'POST',
        headers: aiHeaders(),
        body: JSON.stringify({ model, body })      /* aucune clé ne quitte le navigateur */
      }, delai)
    : await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,{
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  }, delai);
  if(r.status === 404 && !_retry){
    /* modèle mis en cache devenu obsolète → re-détection puis retry */
    localStorage.removeItem(LS_GEMM);
    GEM_OVERRIDE = '';
    await resolveGemModel(key, true);
    return gemini(prompt, expectJson, maxTok, true, temp, _hops);
  }
  if((r.status === 429 || r.status === 503) && !_retry){
    /* surcharge passagère → une seule nouvelle tentative après 1,6 s */
    await new Promise(res => setTimeout(res, 1600));
    return gemini(prompt, expectJson, maxTok, true, temp, _hops);
  }
  if((r.status === 429 || r.status === 503) && _hops < 3){
    /* toujours saturé (503) ou hors quota (429) → modèle suivant de la liste */
    const next = nextGemModel(model);
    if(next && next !== model){
      GEM_OVERRIDE = next;
      lsSet(LS_GEMM, next);
      return gemini(prompt, expectJson, maxTok, false, temp, _hops + 1);
    }
  }
  if(!r.ok){
    const msg = await gemErrMsg(r);
    toast('⚠️ ' + msg);
    if(r.status === 429) throw new Error('RATE');
    throw new Error('BAD_KEY');
  }
  const d = await r.json();
  let txt = (d.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('');
  if(!txt){
    /* réponse vide (réflexion trop longue ?) → une relance avec le double de place */
    if(!_retry) return gemini(prompt, expectJson, maxTok * 2, true, temp, _hops);
    toast('😕 Petit accroc — je réessaie'); throw new Error('EMPTY');
  }
  if(!expectJson) return txt;
  txt = txt.replace(/```json|```/g,'').trim();
  return parseAI(txt);
}

async function groq(prompt, expectJson = true, maxTok = 2048, _retryModel = false){
  const body = {
    model: groqModel(),
    messages: [{ role:'user', content: prompt + (expectJson ? '\nRéponds UNIQUEMENT avec un objet JSON valide, rien d\'autre.' : '') }],
    temperature: 0.7,
    max_tokens: maxTok
  };
  /* gpt-oss "réfléchit" avant de répondre : effort bas = réponse rapide qui ne
     mange pas le budget de tokens. (llama refuse ce paramètre → conditionnel) */
  if(/gpt-oss/.test(body.model)) body.reasoning_effort = 'low';
  if(expectJson) body.response_format = { type:'json_object' };
  const r = useBackend()
    ? await fetchT(`${API()}/groq`, {
        method:'POST',
        headers: aiHeaders(),
        body: JSON.stringify({ body })             /* la clé Groq reste sur le serveur */
      })
    : await fetchT('https://api.groq.com/openai/v1/chat/completions',{
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + groqKey() },
        body: JSON.stringify(body)
      });
  if(r.status === 401){ throw new Error('BAD_GROQ'); }   /* silencieux : bascule interne, l'utilisateur n'a rien à savoir */
  if(r.status === 429){
    /* ⚠️ DEUX 429 TRÈS DIFFÉRENTS ARRIVENT PAR CE MÊME TUYAU, et les confondre
       coûte cher :
         · celui de GROQ (trop d'appels chez eux) → Gemini peut prendre le
           relais, il n'y a rien de perdu ;
         · celui de NOTRE aiGuard (plafond de 120 appels/heure par compte) →
           /gemini passe par la MÊME garde et répondra 429 aussi. Basculer est
           alors inutile : on brûle un second appel pour rien et l'utilisateur
           attend deux fois plus longtemps avant de voir l'échec.
       On les distingue sur la forme du corps : aiGuard renvoie {"error":"…"}
       (une chaîne), Groq renvoie {"error":{"message":…,"code":…}} (un objet). */
    let corps = null;
    try{ corps = await r.json(); }catch(e){}
    if(corps && typeof corps.error === 'string'){
      throw new Error('QUOTA_COMPTE:' + corps.error.slice(0, 160));
    }
    /* Limitation de Groq. On la MÉMORISE : sans ça, chaque appel « light »
       suivant refait le même aller-retour perdant — un 429 de plus dans la
       console, une unité de plus consommée sur notre propre quota (aiGuard
       compte AVANT de relayer), et une attente inutile avant la bascule.
       Groq indique souvent le délai dans son message ; à défaut, une minute. */
    const msg = String(corps && corps.error && corps.error.message || '');
    const s = parseFloat((msg.match(/try again in ([\d.]+)\s*s/i) || [])[1]);
    groqRefroidit(Number.isFinite(s) ? s * 1000 : 60000);
    throw new Error('GROQ_RATE');
  }
  if(r.status === 404 && !_retryModel){
    /* modèle retiré par Groq → on passe au suivant de la liste et on mémorise */
    const cur = groqModel();
    const next = GROQ_PREFERRED[GROQ_PREFERRED.indexOf(cur) + 1] || GROQ_PREFERRED.find(m => m !== cur);
    if(next && next !== cur){ lsSet(LS_GROQM, next); return groq(prompt, expectJson, maxTok, true); }
  }
  if(!r.ok) throw new Error('GROQ_HTTP ' + r.status);
  const d = await r.json();
  let txt = d.choices?.[0]?.message?.content || '';
  if(!txt) throw new Error('GROQ_EMPTY'); /* contenu vide → ai() bascule sur Gemini */
  if(!expectJson) return txt;
  txt = txt.replace(/```json|```/g,'').trim();
  return parseAI(txt, false);
}

/* --- Auto-réparation JSON : récupère les réponses IA mal formées --- */
async function parseAI(txt, allowRepair = true){
  const tryP = s => { try{ return JSON.parse(s); }catch(e){ return undefined; } };
  /* nettoie ce qui casse le plus souvent le JSON des LLM : fences + virgules traînantes */
  const clean = s => s.replace(/```json|```/gi, '').replace(/,\s*([}\]])/g, '$1').trim();
  let v = tryP(txt);            if(v !== undefined) return v;
  v = tryP(clean(txt));         if(v !== undefined) return v;
  /* isole le plus grand objet {...} OU tableau [...] présent dans la réponse */
  const slice = (open, close) => {
    const a = txt.indexOf(open), b = txt.lastIndexOf(close);
    return (a > -1 && b > a) ? clean(txt.slice(a, b + 1)) : null;
  };
  for(const cand of [slice('{', '}'), slice('[', ']')]){
    if(cand){ v = tryP(cand); if(v !== undefined) return v; }
  }
  /* Réparation de JSON : c'est du confort, jamais un passage obligé. Pendant
     une mise au frais on n'insiste pas — mieux vaut échouer tout de suite que
     dépenser un appel condamné pour rattraper une réponse déjà ratée. */
  if(allowRepair && groqDispo()){
    try{
      const fixed = await groq('Ce JSON est invalide. Corrige-le sans changer son contenu. Réponds UNIQUEMENT avec le JSON corrigé, rien d\'autre :\n' + txt.slice(0, 6000), false, 4096);
      v = tryP(clean(fixed)); if(v !== undefined) return v;
    }catch(e){}
  }
  throw new Error('BAD_JSON');
}

/* ai('heavy'|'light', prompt) — retourne {data, via} */
async function ai(kind, prompt, expectJson = true, maxTok = 4096){
  /* groqDispo() et non hasGroq() : pendant une mise au frais on va DIRECTEMENT
     sur Gemini, sans l'aller-retour perdant. */
  if(kind === 'light' && groqDispo()){
    try{
      const data = await groq(prompt, expectJson, Math.min(maxTok, 4096));
      return { data, via:'groq' };
    }catch(e){
      const m = String(e.message || '');
      if(m === 'BAD_GROQ') throw e;
      /* ⚠️ Plafond de NOTRE compte : /gemini passe par la même garde et
         répondra 429 lui aussi. Basculer serait un second appel perdu et une
         attente doublée avant le même échec. On s'arrête et on le DIT — c'est
         la seule erreur de ce lot où l'utilisateur peut agir (attendre). */
      if(m.startsWith('QUOTA_COMPTE')){
        toast('⏳ ' + (m.split(':')[1] || 'Beaucoup de demandes d’un coup — réessaie dans un moment'));
        throw new Error('QUOTA_COMPTE');
      }
    }
  }
  const data = await gemini(prompt, expectJson, maxTok);
  return { data, via:'gemini' };
}

/* ============================================================
   LE JEU D'ICÔNES — des tracés, plus des émojis
   ------------------------------------------------------------
   ⚠️ POURQUOI REMPLACER LES ÉMOJIS. Trois raisons, et la troisième est la plus
   coûteuse :
   1. Ils ne se dessinent pas pareil d'un système à l'autre — on l'a payé cher
      avec les drapeaux, que Windows ne sait tout simplement pas afficher.
   2. Ils sont en COULEUR, au milieu d'une interface entièrement au trait : ils
      attirent l'œil bien plus que leur importance ne le justifie.
   3. Ils datent une interface. Un écran couvert d'émojis se lit comme un
      brouillon, et c'est exactement la signature qu'on cherche à éviter ici.

   Chaque tracé est écrit à la main sur une grille de 24, avec le MÊME
   stroke-width 1.75 que la barre de navigation — c'est ce qui fait qu'ils
   appartiennent tous au même alphabet. `currentColor` partout : une icône suit
   la couleur de son texte, dans les deux thèmes, sans une ligne de CSS.
   ⚠️ « var » et fonction déclarée : ICO() est appelé depuis des rendus situés
   bien plus haut dans le fichier.
============================================================ */
var ICO_D = {
  /* — navigation & lieux — */
  monde:    '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4a13 13 0 0 1 0 17.2 13 13 0 0 1 0-17.2Z"/>',
  boussole: '<circle cx="12" cy="12" r="8.6"/><path d="m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5 4.5-1.9Z"/>',
  epingle:  '<path d="M12 21.2s6.4-5.6 6.4-10.4a6.4 6.4 0 1 0-12.8 0C5.6 15.6 12 21.2 12 21.2Z"/><circle cx="12" cy="10.6" r="2.4"/>',
  carte:    '<path d="M9 3.5 2.8 6v14.5L9 18l6 2.5 6.2-2.5V3.5L15 6 9 3.5Z"/><path d="M9 3.5V18M15 6v14.5"/>',
  /* — transports — */
  avion:    '<path d="M12 2.4c.85 0 1.5.65 1.5 1.5v4.9l7.1 4.1v2l-7.1-2.2v4.2l2.5 1.8v1.5L12 19.6l-4 .6v-1.5l2.5-1.8v-4.2L3.4 15v-2l7.1-4.1v-5c0-.84.65-1.5 1.5-1.5Z"/>',
  train:    '<rect x="5.4" y="3.6" width="13.2" height="12.6" rx="3"/><path d="M5.4 10.2h13.2"/><path d="M8.4 19.6 6.2 22M15.6 19.6 17.8 22M7.6 16.2h8.8"/><circle cx="8.8" cy="13.2" r=".9"/><circle cx="15.2" cy="13.2" r=".9"/>',
  voiture:  '<path d="M4.2 16.4v2.2a1 1 0 0 0 1 1h1.6a1 1 0 0 0 1-1v-1.2M19.8 16.4v2.2a1 1 0 0 1-1 1h-1.6a1 1 0 0 1-1-1v-1.2"/><path d="M3.6 17.4h16.8v-4.2l-2-4.6a2 2 0 0 0-1.8-1.2H7.4a2 2 0 0 0-1.8 1.2l-2 4.6v4.2Z"/><path d="M3.8 13.2h16.4"/><circle cx="7.4" cy="15.2" r=".9"/><circle cx="16.6" cy="15.2" r=".9"/>',
  /* — déplacements sur place — */
  pied:     '<path d="M13.8 3.4a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Z"/><path d="M11.2 20.6l1.4-4.6-2.4-2.2.8-4.4 2.4-1.4 2.6 1.6 2.4.6"/><path d="m10.2 13.8-2.6 1.6-1.4 3.4"/><path d="m14 16 2.2 4.6"/>',
  velo:     '<circle cx="5.8" cy="16.6" r="3.6"/><circle cx="18.2" cy="16.6" r="3.6"/><path d="m8.6 16.6 3.4-7.4h4"/><path d="m12 9.2 3.6 7.4"/><path d="M14.6 5.4h2.6"/><circle cx="12" cy="9.2" r=".9"/>',
  metro:    '<rect x="4.6" y="3.6" width="14.8" height="12.4" rx="3.4"/><path d="M4.6 10.4h14.8"/><circle cx="8.6" cy="13.2" r=".9"/><circle cx="15.4" cy="13.2" r=".9"/><path d="m8 20.4 2-3M16 20.4l-2-3M7.6 20.4h8.8"/>',
  /* — voyage — */
  valise:   '<rect x="3.4" y="7.4" width="17.2" height="12.8" rx="2.4"/><path d="M8.6 7.4V5.6a2 2 0 0 1 2-2h2.8a2 2 0 0 1 2 2v1.8"/><path d="M3.4 12.4h17.2"/>',
  hotel:    '<path d="M3.6 20.4V5.2a1.6 1.6 0 0 1 1.6-1.6h9.6a1.6 1.6 0 0 1 1.6 1.6v15.2"/><path d="M16.4 10.4h2.8a1.6 1.6 0 0 1 1.6 1.6v8.4"/><path d="M2.6 20.4h18.8"/><path d="M7 7.6h1.6M11 7.6h1.6M7 11.4h1.6M11 11.4h1.6M7 15.2h5.6v5.2H7Z"/>',
  billet:   '<path d="M4 8.5A2 2 0 0 1 6 6.5h12a2 2 0 0 1 2 2v1a2.5 2.5 0 0 0 0 5v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1a2.5 2.5 0 0 0 0-5v-1Z"/><path d="M14 6.5v11" stroke-dasharray="2 2.5"/>',
  passeport:'<rect x="4.6" y="2.8" width="14.8" height="18.4" rx="2.2"/><circle cx="12" cy="10" r="3.2"/><path d="M8.8 17.2h6.4"/>',
  /* — actions — */
  poubelle: '<path d="M4.4 6.6h15.2"/><path d="M9.4 6.6V4.8a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.8"/><path d="M6.4 6.6v13a1.8 1.8 0 0 0 1.8 1.8h7.6a1.8 1.8 0 0 0 1.8-1.8v-13"/><path d="M10.2 10.8v6.4M13.8 10.8v6.4"/>',
  crayon:   '<path d="M15.4 4.6a2.1 2.1 0 0 1 3 3L8.6 17.4l-4 1 1-4 9.8-9.8Z"/><path d="m14 6 3 3"/>',
  plus:     '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
  envoyer:  '<path d="M4.2 11.8 20.4 4.2l-7.6 16.2-2.2-6.4-6.4-2.2Z"/><path d="m10.6 13.4 4.6-4.6"/>',
  telecharger:'<path d="M12 3.6v11.2"/><path d="m7.4 10.4 4.6 4.6 4.6-4.6"/><path d="M4.4 19.8h15.2"/>',
  partager: '<circle cx="18" cy="6" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="m8.3 10.8 7.4-3.6M8.3 13.2l7.4 3.6"/>',
  scanner:  '<path d="M3.6 8.4V5.6a2 2 0 0 1 2-2h2.8M15.6 3.6h2.8a2 2 0 0 1 2 2v2.8M20.4 15.6v2.8a2 2 0 0 1-2 2h-2.8M8.4 20.4H5.6a2 2 0 0 1-2-2v-2.8"/><path d="M3.6 12h16.8"/>',
  calendrier:'<rect x="3.4" y="5.4" width="17.2" height="15.2" rx="2"/><path d="M3.4 10.2h17.2M8.4 3.4v4M15.6 3.4v4"/><path d="M8 14h3v3H8z"/>',
  lien:     '<path d="M10.4 13.6a3.4 3.4 0 0 0 5 .3l2.6-2.6a3.4 3.4 0 0 0-4.8-4.8l-1.5 1.5"/><path d="M13.6 10.4a3.4 3.4 0 0 0-5-.3L6 12.7a3.4 3.4 0 0 0 4.8 4.8l1.5-1.5"/>',
  image:    '<rect x="3.2" y="5.2" width="17.6" height="13.6" rx="2"/><path d="m3.6 15.5 4.2-4a1.6 1.6 0 0 1 2.2 0l3.4 3.3"/><path d="m14.2 13.4 1.6-1.5a1.6 1.6 0 0 1 2.2 0l2.4 2.3"/><circle cx="9" cy="9.6" r="1.3"/>',
  /* — état & sens — */
  etincelle:'<path d="M12 3.2 13.6 8l4.8 1.6-4.8 1.6L12 16l-1.6-4.8L5.6 9.6 10.4 8 12 3.2Z"/><path d="m18.4 14.8.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/>',
  ampoule:  '<path d="M9.4 18.4h5.2"/><path d="M10 21h4"/><path d="M8 13.4a5.4 5.4 0 1 1 8 0c-.8.9-1.3 1.7-1.4 2.6H9.4c-.1-.9-.6-1.7-1.4-2.6Z"/>',
  bouclier: '<path d="M12 3 19.4 6v6c0 4.2-3 7.4-7.4 9-4.4-1.6-7.4-4.8-7.4-9V6L12 3Z"/><path d="m9 12 2.2 2.2L15.4 10"/>',
  aide:     '<circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.4"/><path d="M12 17.2h.01"/>',
  cle:      '<circle cx="8.4" cy="15.6" r="3.6"/><path d="m11 13 8-8"/><path d="m16.4 7.6 2 2M19 5l2 2"/>',
  porte:    '<path d="M14.4 3.6H6.2a1.6 1.6 0 0 0-1.6 1.6v13.6a1.6 1.6 0 0 0 1.6 1.6h8.2"/><path d="m14.4 12 6 0M17.6 8.8 20.8 12l-3.2 3.2"/>',
  balai:    '<path d="M14.4 3.6 20.4 9.6"/><path d="m10.6 7.4 6 6-6.6 6.6a2 2 0 0 1-2.8 0l-3.2-3.2a2 2 0 0 1 0-2.8l6.6-6.6Z"/><path d="m8 10 6 6"/>',
  document: '<path d="M14 3.4H7.4a2 2 0 0 0-2 2v13.2a2 2 0 0 0 2 2h9.2a2 2 0 0 0 2-2V8L14 3.4Z"/><path d="M13.8 3.6V8h4.4"/><path d="M9 13h6M9 16.4h6"/>',
  discussion:'<path d="M20.4 12.4a7.6 7.6 0 0 1-8.2 7.6l-5.4 1.4 1.4-4.2a7.6 7.6 0 1 1 12.2-4.8Z"/><path d="M9 11.6h.01M12 11.6h.01M15 11.6h.01"/>',
  telephone:'<rect x="6.6" y="2.6" width="10.8" height="18.8" rx="2.4"/><path d="M10.6 18.6h2.8"/>',
  fermer:   '<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>',
  retour:   '<path d="M9.6 5.4 3.6 11.4l6 6"/><path d="M3.6 11.4h11a5.8 5.8 0 0 1 0 11.6h-1"/>',
  /* — attente jouable & kiosque — */
  manette:  '<path d="M7.4 7.6h9.2a5 5 0 0 1 4.9 4l.8 4.3a2.7 2.7 0 0 1-5 1.9l-1.2-1.9H7.9l-1.2 1.9a2.7 2.7 0 0 1-5-1.9l.8-4.3a5 5 0 0 1 4.9-4Z"/><path d="M7.2 11.2v2.6M5.9 12.5h2.6"/><path d="M15.9 11.9h.01M17.8 13.6h.01"/>',
  coche:    '<path d="m4.8 12.4 4.7 4.7L19.2 7.4"/>',
  /* — ajoutées pour remplacer les emoji des cartes de destination — */
  money:    '<circle cx="12" cy="12" r="8.6"/><path d="M15 9.2a3.6 3.6 0 0 0-3-1.6c-2 0-3.4 1.9-3.4 4.4s1.4 4.4 3.4 4.4a3.6 3.6 0 0 0 3-1.6"/><path d="M7.6 11.2h4.6M7.6 13.4h4.6"/>',
  soleil:   '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/>',
  langue:   '<path d="M3.4 6.2h8.4M7.6 4.2v2M9.6 6.2c0 3.4-2.4 6.2-5.4 7.4M6.2 9.4c.9 2 2.6 3.4 4.8 4.2"/><path d="m12.6 19.8 3.4-8 3.4 8M13.9 17h4.2"/>',
  trophee:  '<path d="M7.4 4.2h9.2v4.2a4.6 4.6 0 0 1-9.2 0Z"/><path d="M7.4 5.6H5a2 2 0 0 0 2.4 3.6M16.6 5.6H19a2 2 0 0 1-2.4 3.6"/><path d="M12 13v3.4M8.8 19.8h6.4l-.8-3.4H9.6Z"/>',
  alerte:   '<path d="M12 4.2 21 19.4H3Z"/><path d="M12 10v3.6M12 16.4h.01"/>',
  loupe:    '<circle cx="10.8" cy="10.8" r="6.6"/><path d="m15.6 15.6 4.6 4.6"/>',
  graphique:'<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 17V11M12.4 17V7M16.8 17v-4"/>',
  sac:      '<path d="M6 8.6h12l1 11.2H5Z"/><path d="M9 8.6V6.4a3 3 0 0 1 6 0v2.2"/>',
  horloge:  '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2V12l3.2 2"/>',
  refaire:  '<path d="M20.4 12a8.4 8.4 0 1 1-2.5-6"/><path d="M20.4 4.2V10h-5.8"/>',
  personnes:'<circle cx="9" cy="8.2" r="3.4"/><path d="M2.8 19.4a6.2 6.2 0 0 1 12.4 0"/><path d="M16.2 5.2a3.4 3.4 0 0 1 0 6"/><path d="M17.6 13.6a6.2 6.2 0 0 1 3.6 5.8"/>',
  nuit:     '<path d="M20.4 14.4A8.6 8.6 0 0 1 9.6 3.6a8.6 8.6 0 1 0 10.8 10.8Z"/>',
  /* — simulateur de transport — */
  decollage:'<path d="M3.4 20.6h17.2"/><path d="M5.2 15.8 3.8 11.4l2-.5 2.1 2.3 4-1.1-3.4-6 2.4-.7 5.2 5.6 3.6-1a1.8 1.8 0 0 1 .9 3.5Z"/>',
  atterrissage:'<path d="M3.4 20.6h17.2"/><path d="M20.2 16.2 4.4 12.4l.3-6.4 2 .5 1.4 4.4 4.2 1-.4-7 2.4.6 2.5 7.2 3.6 1a1.8 1.8 0 0 1-.2 2.5Z"/>',
  route:    '<path d="M8.2 3.4 5.4 20.6M15.8 3.4l2.8 17.2"/><path d="M12 4.6v2.6M12 10.6v2.8M12 16.8v2.6"/>',
  feu:      '<rect x="8" y="2.8" width="8" height="18.4" rx="3.2"/><circle cx="12" cy="7.4" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="16.6" r="1.5"/>',
  regle:    '<path d="M3.2 8.4h17.6v7.2H3.2Z"/><path d="M7 8.4v2.6M10.4 8.4v3.6M13.8 8.4v2.6M17.2 8.4v3.6"/>',
  /* — panneaux Manger, Logement, Budget — */
  cible:    '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1"/>',
  quartier: '<path d="M3.4 20.6V10l5-3.4 5 3.4v10.6"/><path d="M13.4 20.6V13l3.6-2.4 3.6 2.4v7.6"/><path d="M6.6 13h3.2M6.6 16.6h3.2M16.4 16.6h1.4"/>',
  assiette: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.4"/>',
  panier:   '<path d="M3.2 8.4h17.6l-2 10.4H5.2Z"/><path d="m8.4 8.4 2.2-4.8M15.6 8.4l-2.2-4.8"/><path d="M9.6 12v3M14.4 12v3"/>',
  poignee:  '<path d="m3.4 12.6 3.4-3.4 3.2 2.6 3-2.4 3.2 2.4 4.4-4"/><path d="M10 11.8 7.6 14.2a1.7 1.7 0 0 0 2.4 2.4l.8-.8.9.9a1.7 1.7 0 0 0 2.4-2.4"/>',
  cb:       '<rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2.6"/><path d="M2.8 10h18.4"/><path d="M6.4 14.6h3.2"/>',
  /* — moments d'une journee, evenements, avis — */
  monument: '<path d="M3.4 20.6h17.2M4.8 20.6V9.4M9.6 20.6V9.4M14.4 20.6V9.4M19.2 20.6V9.4"/><path d="M3 9.4h18L12 3.4Z"/>',
  cafe:     '<path d="M4.2 7.4h12v6a6 6 0 0 1-12 0Z"/><path d="M16.2 8.6h2a2.6 2.6 0 0 1 0 5.2h-2"/><path d="M4.2 20.6h12"/>',
  fete:     '<path d="m3.4 20.6 4.4-11 7.2 6.6Z"/><path d="M13.4 8.6a3 3 0 0 1 3-3M17.6 11a2.4 2.4 0 0 1 2.4-2.4M15.4 4.2v.01M20.4 5.4v.01M19.6 15v.01"/>',
  sport:    '<circle cx="12" cy="12" r="8.6"/><path d="m12 3.4 3 5.4-3 5-3-5Z"/><path d="m4.4 8.6 4.6.2M19.6 8.6 15 8.8M7.6 19.4 9 13.8M16.4 19.4 15 13.8"/>',
  cadre:    '<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2"/><circle cx="8.8" cy="9.6" r="1.6"/><path d="m3.4 16.6 4.8-4.4 4 3.4 3.4-2.8 4 3.6"/>',
  maison:   '<path d="M3.6 10.4 12 3.6l8.4 6.8v9a1.4 1.4 0 0 1-1.4 1.4H5a1.4 1.4 0 0 1-1.4-1.4Z"/><path d="M9.4 20.8v-6.6h5.2v6.6"/>',
  pouce:    '<path d="M7.4 20.6V10.2l4.2-6.8a2.2 2.2 0 0 1 2 3.2l-1 3.4h5.2a2.2 2.2 0 0 1 2.1 2.8l-1.6 6a2.2 2.2 0 0 1-2.1 1.8Z"/><path d="M7.4 10.2H3.6v10.4h3.8"/>',
  poucebas: '<path d="M7.4 3.4v10.4l4.2 6.8a2.2 2.2 0 0 0 2-3.2l-1-3.4h5.2a2.2 2.2 0 0 0 2.1-2.8l-1.6-6a2.2 2.2 0 0 0-2.1-1.8Z"/><path d="M7.4 13.8H3.6V3.4h3.8"/>',
  feuille:  '<path d="M4.4 19.6C3 15 5 8.4 10 5.8c3.4-1.8 7.2-1.4 9.6-1.4.4 3 .4 7.4-1.6 10.6-2.4 3.8-8 5.4-13.6 4.6Z"/><path d="M4.4 19.6C6.6 15 10 11.6 14.4 9.4"/>',
  baisse:   '<path d="M3.4 6.6 10 13.2l3.6-3.6 7 7"/><path d="M20.6 11.4v5.2h-5.2"/>',
  hausse:   '<path d="M3.4 17.4 10 10.8l3.6 3.6 7-7"/><path d="M20.6 12.6V7.4h-5.2"/>',
  son:      '<path d="M4.4 9.4h3.2L12 5.6v12.8L7.6 14.6H4.4Z"/><path d="M15.4 9.6a3.4 3.4 0 0 1 0 4.8M18 7a7 7 0 0 1 0 10"/>',
  cadenas:  '<rect x="4.4" y="10.4" width="15.2" height="10.2" rx="2.4"/><path d="M7.8 10.4V7.6a4.2 4.2 0 0 1 8.4 0v2.8"/>',
  reseau:   '<path d="M4.4 20.6v-4.8M9.6 20.6v-8.4M14.8 20.6V7.4M20 20.6V3.4"/>'
};
/* Rend une icône. `taille` en px, `cls` pour les cas où il faut la viser en CSS. */
function ICO(nom, taille, cls){
  const d = ICO_D[nom];
  if(!d) return '';
  const t = taille || 18;
  return `<svg class="ico-t${cls ? ' ' + cls : ''}" width="${t}" height="${t}" viewBox="0 0 24 24"`
    + ' fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"'
    + ` stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/* ---- Mascotte Acolyte : la Terre aux grands yeux, qui regarde autour d'elle
   pendant que l'IA réfléchit. SVG inline → net partout, zéro fichier, hors-ligne. ---- */
let _mascotN = 0;
function mascotSVG(cls = ''){
  /* ⚠️ Un identifiant UNIQUE par mascotte. Il était fixe, donc dupliqué autant
     de fois qu'il y a de globes : HTML invalide, et « url(#…) » pointait
     toujours sur la première définition — tous les globes partageaient un seul
     masque. Ça ne se voyait pas, les masques étant identiques ; ça se verrait au
     premier masque différent. */
  const clip = 'mGlobeClip' + (++_mascotN);
  return `<svg class="mascot ${cls}" viewBox="0 0 100 100" role="img" aria-label="Acolyte réfléchit">
    <defs><clipPath id="${clip}"><circle cx="50" cy="50" r="45"/></clipPath></defs>
    <circle class="m-ocean" cx="50" cy="50" r="45"/>
    <g clip-path="url(#${clip})" class="m-land">
      <ellipse cx="24" cy="29" rx="14" ry="10" transform="rotate(-20 24 29)"/>
      <ellipse cx="29" cy="67" rx="9"  ry="14" transform="rotate(14 29 67)"/>
      <ellipse cx="71" cy="24" rx="17" ry="9"  transform="rotate(8 71 24)"/>
      <ellipse cx="68" cy="66" rx="11" ry="14" transform="rotate(-10 68 66)"/>
      <ellipse cx="50" cy="12" rx="20" ry="6"/>
    </g>
    <circle class="m-rim" cx="50" cy="50" r="45"/>
    <g class="m-eyes">
      <ellipse class="m-white" cx="36" cy="46" rx="15" ry="19"/>
      <ellipse class="m-white" cx="66" cy="46" rx="14" ry="18"/>
      <g class="m-pupils">
        <circle class="m-pupil" cx="38" cy="48" r="8"/>
        <circle class="m-pupil" cx="68" cy="48" r="7.5"/>
        <circle class="m-shine" cx="41.5" cy="43.5" r="2.4"/>
        <circle class="m-shine" cx="71"   cy="43.5" r="2.1"/>
      </g>
    </g>
  </svg>`;
}
/* ---- Ligne d'horizon des grands monuments du monde, en silhouettes.
   Dessinée en SVG → nette partout, hors-ligne, sans image à héberger.
   Tour Eiffel · Pyramides · Colisée · Big Ben · Taj Mahal · Statue de la Liberté ---- */
function monumentsSVG(){
  return `<svg class="mon-svg" viewBox="0 0 240 44" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
    <g class="mon">
      <!-- Tour Eiffel -->
      <path d="M17 4 L21 18 L26 44 L21 44 L19 33 L15 33 L13 44 L8 44 L13 18 Z"/>
      <rect x="12" y="21" width="10" height="2.4"/>
      <!-- Pyramides -->
      <path d="M36 44 L49 19 L62 44 Z"/>
      <path d="M57 44 L66 27 L75 44 Z"/>
      <!-- Colisée -->
      <path d="M80 44 L80 30 Q80 25 84 25 L108 25 Q112 25 112 30 L112 44 Z"/>
      <rect x="84" y="33" width="3.2" height="11"/>
      <rect x="92" y="33" width="3.2" height="11"/>
      <rect x="100" y="33" width="3.2" height="11"/>
      <rect x="108" y="33" width="3.2" height="11"/>
      <!-- Big Ben -->
      <path d="M120 44 L120 17 L124 17 L124 12 L127 6 L130 12 L130 17 L134 17 L134 44 Z"/>
      <circle class="mon-hole" cx="127" cy="24" r="2.3"/>
      <!-- Taj Mahal -->
      <rect x="146" y="26" width="2.6" height="18"/>
      <rect x="171" y="26" width="2.6" height="18"/>
      <path d="M151 44 L151 30 Q151 22 160 20 Q169 22 169 30 L169 44 Z"/>
      <path d="M155 21 Q160 9 165 21 Z"/>
      <rect x="159" y="13" width="2" height="6"/>
      <!-- Statue de la Liberté -->
      <path d="M196 44 L196 35 L214 35 L214 44 Z"/>
      <path d="M202 35 L202 20 Q205 13 208 20 L208 35 Z"/>
      <circle cx="205" cy="15" r="2.6"/>
      <path class="mon-line" d="M207 17 L213 7"/>
      <circle cx="213" cy="6" r="1.9"/>
    </g>
  </svg>`;
}
/* Scène de chargement : la mascotte survole les monuments du monde qui défilent. */
function travelSceneHTML(){
  return `<div class="travel-scene" aria-hidden="true">
    <span class="cloud c1"></span>
    <span class="cloud c2"></span>
    <div class="mon-strip">${monumentsSVG()}${monumentsSVG()}</div>
    <div class="ground"></div>
    ${mascotSVG('traveler')}
  </div>`;
}
/* Chargement standard : la mascotte SEULE (pas de fond qui défile) + une
   bulle de BD. Le décor « monuments qui défilent » est réservé à la recherche
   de destinations après le questionnaire (voir la barre searchBar). */
function loaderHTML(msg){ return `<div class="loader">${mascotSVG('loader-solo')}<div class="speech loader-msg">${esc(msg)}</div></div>`; }
/* La mascotte tient lieu de logo. On masque le SVG aux lecteurs d'écran :
   le mot « Acolyte » juste à côté dit déjà de quoi il s'agit, et l'étiquette
   par défaut du SVG (« Acolyte réfléchit ») serait fausse ici. */
document.querySelectorAll('.logo-mark').forEach(el => {
  el.innerHTML = mascotSVG();
  el.setAttribute('aria-hidden', 'true');
});

/* ---- La mascotte prend vie ----
   Clic → elle saute. Et de temps en temps, à intervalle ALÉATOIRE, une
   mascotte visible réagit toute seule (pirouette, saut, sursaut) : c'est ce
   qui la rend imprévisible plutôt que mécanique. Tout est coupé si
   l'utilisateur a demandé de réduire les animations. */
const MASCOT_REACTIONS = ['m-hop', 'm-spin', 'm-wiggle'];
function motionOff(){
  return document.documentElement.classList.contains('no-motion')
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
function mascotReact(m, cls){
  if(!m || motionOff()) return;
  MASCOT_REACTIONS.forEach(c => m.classList.remove(c));
  void m.offsetWidth;                     /* redémarre l'animation même si déjà jouée */
  m.classList.add(cls);
  m.addEventListener('animationend', () => m.classList.remove(cls), { once:true });
}
/* clic : saut, où que soit la mascotte (logo, chargements…) */
document.addEventListener('click', e => {
  const m = e.target.closest?.('.mascot');
  if(m) mascotReact(m, 'm-hop');
});
/* vie spontanée : une réaction au hasard, à un moment au hasard */
(function mascotLife(){
  const wait = 4000 + Math.random() * 6000;        /* entre 4 et 10 s */
  setTimeout(() => {
    if(!motionOff()){
      const vis = [...document.querySelectorAll('.mascot')].filter(m => m.getClientRects().length);
      if(vis.length){
        const m = vis[Math.floor(Math.random() * vis.length)];
        mascotReact(m, MASCOT_REACTIONS[Math.floor(Math.random() * MASCOT_REACTIONS.length)]);
      }
    }
    mascotLife();                                   /* on relance avec un nouveau délai */
  }, wait);
})();

/* ---- Easter egg : 2 clics d'affilée sur la mascotte du logo (PC) → la salle
   de jeux, où l'on choisit parmi quatre mini-jeux. ---- */
(function gameEgg(){
  /* ⚠️ Il y avait ici « if(!matchMedia('(pointer:fine)').matches) return », qui
     réservait TOUTE la salle de jeux aux appareils à souris : sur téléphone,
     les quatre mini-jeux étaient purement inaccessibles. Deux tapes valent deux
     clics, il n'y avait aucune raison de fermer la porte.
     (Le CSS pose « touch-action:manipulation » sur le logo, sinon la seconde
     tape déclencherait le zoom du navigateur au lieu d'ouvrir la salle.) */
  /* TOUTES les mascottes du logo, pas seulement la première : selon la
     largeur de l'écran, c'est celle de la colonne de gauche OU celle de
     l'en-tête qui est visible. N'en écouter qu'une rendait l'easter egg
     introuvable dans l'autre cas. */
  const logos = document.querySelectorAll('.logo-mark');
  if(!logos.length) return;
  let clicks = 0, resetT = 0;
  logos.forEach(logo => logo.addEventListener('click', () => {
    clearTimeout(resetT);
    resetT = setTimeout(() => { clicks = 0; }, 700);           /* pas « de suite » → on repart de zéro */
    if(++clicks >= 2){ clicks = 0; openArcade(); }
  }));
})();

/* ============================================================
   MINI-JEU « Défends la Terre » — tir sur les astéroïdes + classement.
   Auto-contenu (canvas), aucune dépendance. Le classement passe par le
   backend (routes /game/top et /game/score).
============================================================ */
/* Skins PUREMENT cosmétiques : ils changent les couleurs, jamais les tailles
   ni les vitesses → la difficulté reste identique. */
const AST_SKINS = {
  roche: { nom:'Roche',  body:'#9a978d', crater:'#6f6b60', stroke:'#17202e' },
  glace: { nom:'Glace',  body:'#bcd8e6', crater:'#8fb8cc', stroke:'#2a5566' },
  lave:  { nom:'Lave',   body:'#d4622a', crater:'#8f3a12', stroke:'#3a1405' },
  metal: { nom:'Métal',  body:'#9aa3b2', crater:'#6b7280', stroke:'#232a38' },
};
const PLANET_SKINS = {
  terre:    { nom:'Terre',    ocean:'#3E93C9', land:'#6FBE5C', stroke:'#1C5A78', hit:'#8fc3ea' },
  mars:     { nom:'Mars',     ocean:'#c1440e', land:'#8a2c08', stroke:'#5c1d05', hit:'#e07a4a' },
  lune:     { nom:'Lune',     ocean:'#c9c9c9', land:'#9a9a9a', stroke:'#5a5a5a', hit:'#eaeaea' },
  pasteque: { nom:'Pastèque', ocean:'#4fae4a', land:'#e0566f', stroke:'#2c5e2a', hit:'#8fd08a' },
};
const LS_GAMESKIN = 'acolite_game_skin';
let _gameSkin = (() => { try{ return { ast:'roche', planet:'terre', ...JSON.parse(localStorage.getItem(LS_GAMESKIN) || '{}') }; }catch(e){ return { ast:'roche', planet:'terre' }; } })();
function saveGameSkin(){ lsSet(LS_GAMESKIN, JSON.stringify(_gameSkin)); }
const astSkin = () => AST_SKINS[_gameSkin.ast] || AST_SKINS.roche;
const planetSkin = () => PLANET_SKINS[_gameSkin.planet] || PLANET_SKINS.terre;

let _game = null;
function openGame(){
  const ov = $('#ovGame'); if(!ov) return;
  ov.classList.add('show');
  $('#gameOver').hidden = true;
  $('#gameCustom').hidden = true;
  $('#gameStart').hidden = false;
  /* rappel du record personnel, s'il y en a un */
  const b = $('#gameBest');
  if(b){
    let rec = 0; try{ rec = parseInt(localStorage.getItem('acolite_game_best'), 10) || 0; }catch(e){}
    b.hidden = !rec;
    b.textContent = rec ? '🏅 Ton record : ' + rec : '';
  }
}
(function gameEngine(){
  const cv = $('#gameCanvas'); if(!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const EARTH = { x: W / 2, y: H - 4, r: 34 };
  const LS_GAMEBEST = 'acolite_game_best';
  const bestScore = () => { try{ return parseInt(localStorage.getItem(LS_GAMEBEST), 10) || 0; }catch(e){ return 0; } };
  let asts, parts, texts, score, lives, spawnAcc, running, last, raf, combo, level, shake;

  /* Multiplicateur : monte en enchaînant les tirs, retombe si la Terre est touchée. */
  const mult = () => Math.min(5, 1 + Math.floor(combo / 4));

  function reset(){
    asts = []; parts = []; texts = []; score = 0; lives = 3; spawnAcc = 0;
    combo = 0; level = 1; shake = 0;
    running = true; last = performance.now();
    hud();
  }
  function hud(){
    $('#gameScore').textContent = 'Score : ' + score;
    $('#gameLevel').textContent = 'Niveau ' + level;
    $('#gameLives').textContent = '❤️'.repeat(Math.max(0, lives)) || '💀';
    const c = $('#gameCombo');
    if(c){
      const m = mult();
      c.hidden = m <= 1;
      c.textContent = '×' + m;
    }
  }
  function spawn(){
    const r = 12 + Math.random() * 12;
    const x = r + Math.random() * (W - 2 * r);
    const speed = 34 + Math.min(90, score * 0.7) + Math.random() * 24;   /* accélère avec le score */
    const ang = Math.atan2(EARTH.y - 0, EARTH.x - x) + (Math.random() - 0.5) * 0.5;
    /* astéroïde doré : même taille et même vitesse (donc même difficulté),
       il rapporte simplement plus de points */
    const bonus = Math.random() < 0.09;
    asts.push({ x, y: -r, r, bonus, vx: Math.cos(ang) * speed, vy: Math.abs(Math.sin(ang) * speed) + 20, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 3 });
  }
  function popText(x, y, txt, col){ texts.push({ x, y, txt, col, life: .9 }); }
  function burst(x, y, col){
    for(let i = 0; i < 10; i++){
      const a = Math.random() * 6.28, s = 40 + Math.random() * 90;
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: .5, col });
    }
  }
  function loop(now){
    if(!running) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    /* apparition */
    spawnAcc += dt;
    const every = Math.max(0.45, 1.3 - score * 0.02);
    if(spawnAcc > every){ spawnAcc = 0; spawn(); }
    /* maj astéroïdes */
    for(let i = asts.length - 1; i >= 0; i--){
      const a = asts[i]; a.x += a.vx * dt; a.y += a.vy * dt; a.rot += a.vr * dt;
      const dx = a.x - EARTH.x, dy = a.y - EARTH.y;
      if(Math.hypot(dx, dy) < a.r + EARTH.r){        /* touche la Terre */
        asts.splice(i, 1); lives--; combo = 0; shake = 0.35; hud();
        burst(a.x, a.y, '#FF6B6B');
        EARTH.hit = 0.25;
        if(lives <= 0){ gameOver(); return; }
      } else if(a.y - a.r > H){ asts.splice(i, 1); }   /* sortie bas */
    }
    /* particules */
    for(let i = parts.length - 1; i >= 0; i--){
      const p = parts[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if(p.life <= 0) parts.splice(i, 1);
    }
    /* points flottants */
    for(let i = texts.length - 1; i >= 0; i--){
      const t = texts[i]; t.y -= 34 * dt; t.life -= dt;
      if(t.life <= 0) texts.splice(i, 1);
    }
    /* niveau : repère de progression, calé sur le score */
    const lv = 1 + Math.floor(score / 120);
    if(lv !== level){ level = lv; hud(); }
    if(EARTH.hit) EARTH.hit = Math.max(0, EARTH.hit - dt);
    if(shake > 0) shake = Math.max(0, shake - dt);
    draw();
    raf = requestAnimationFrame(loop);
  }
  function draw(){
    /* fond spatial (dessiné avant la secousse pour ne pas laisser de bord noir) */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1026'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    for(let i = 0; i < 40; i++){ const sx = (i * 71) % W, sy = (i * 43) % H; ctx.fillRect(sx, sy, 1.5, 1.5); }
    /* secousse d'impact : tout le reste de la scène tremble un instant */
    if(shake > 0){
      const s = shake * 16;
      ctx.setTransform(1, 0, 0, 1, (Math.random() - .5) * s, (Math.random() - .5) * s);
    }
    /* Terre (skin cosmétique) */
    const P = planetSkin();
    ctx.save();
    ctx.beginPath(); ctx.arc(EARTH.x, EARTH.y, EARTH.r, 0, 6.29); ctx.closePath();
    ctx.fillStyle = EARTH.hit ? P.hit : P.ocean; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = P.stroke; ctx.stroke();
    ctx.clip();
    ctx.fillStyle = P.land;
    ctx.beginPath(); ctx.ellipse(EARTH.x - 12, EARTH.y - 10, 15, 10, .3, 0, 6.29); ctx.fill();
    ctx.beginPath(); ctx.ellipse(EARTH.x + 15, EARTH.y + 3, 11, 15, -.2, 0, 6.29); ctx.fill();
    ctx.restore();
    /* astéroïdes (skin cosmétique) */
    const S = astSkin();
    asts.forEach(a => {
      const body = a.bonus ? '#FFD34D' : S.body;
      const crater = a.bonus ? '#c8992a' : S.crater;
      const stroke = a.bonus ? '#6b4c00' : S.stroke;
      ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(a.rot);
      if(a.bonus){ ctx.shadowColor = '#FFD34D'; ctx.shadowBlur = 14; }   /* le doré se repère au premier coup d'œil */
      ctx.beginPath(); ctx.arc(0, 0, a.r, 0, 6.29);
      ctx.fillStyle = body; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2.5; ctx.strokeStyle = stroke; ctx.stroke();
      ctx.fillStyle = crater;
      ctx.beginPath(); ctx.arc(-a.r * .3, -a.r * .2, a.r * .3, 0, 6.29); ctx.fill();
      ctx.beginPath(); ctx.arc(a.r * .35, a.r * .25, a.r * .22, 0, 6.29); ctx.fill();
      ctx.restore();
    });
    /* particules */
    parts.forEach(p => { ctx.globalAlpha = Math.max(0, p.life * 2); ctx.fillStyle = p.col; ctx.fillRect(p.x, p.y, 3, 3); });
    ctx.globalAlpha = 1;
    /* points gagnés, qui s'élèvent et s'effacent */
    ctx.textAlign = 'center';
    ctx.font = '900 17px Fraunces, Georgia, serif';
    texts.forEach(t => {
      ctx.globalAlpha = Math.max(0, Math.min(1, t.life * 1.4));
      ctx.fillStyle = t.col;
      ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 3;
      ctx.strokeText(t.txt, t.x, t.y); ctx.fillText(t.txt, t.x, t.y);
    });
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  function hit(e){
    if(!running) return;
    const rect = cv.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top) * (H / rect.height);
    for(let i = asts.length - 1; i >= 0; i--){
      const a = asts[i];
      if(Math.hypot(a.x - mx, a.y - my) < a.r + 6){
        const m = mult();
        const pts = (a.bonus ? 30 : 10) * m;
        asts.splice(i, 1);
        score += pts; combo++;
        popText(a.x, a.y, '+' + pts + (m > 1 ? ' ×' + m : ''), a.bonus ? '#FFD34D' : '#FFE600');
        hud(); burst(a.x, a.y, a.bonus ? '#FFD34D' : '#FFE600');
        return;
      }
    }
    combo = 0; hud();   /* tir dans le vide : le multiplicateur retombe */
  }
  cv.addEventListener('pointerdown', hit);   /* et non mousedown : le doigt aussi */
  async function gameOver(){
    running = false; cancelAnimationFrame(raf);
    const avant = bestScore();
    const record = score > avant;
    if(record) lsSet(LS_GAMEBEST, String(score));
    $('#gameOverScore').textContent = record
      ? '🎉 Nouveau record : ' + score + ' !'
      : 'Score : ' + score + '  ·  ton record : ' + avant;
    $('#gameOverTitle').textContent = score >= 150 ? '🏆 Belle défense !' : '💥 Terre touchée !';
    $('#gameOver').hidden = false;
    submitAndShowLeaderboard(score);
  }
  function start(){
    $('#gameStart').hidden = true; $('#gameOver').hidden = true; $('#gameCustom').hidden = true;
    reset(); raf = requestAnimationFrame(loop);
  }
  /* Échap ferme le jeu et arrête la boucle (sinon elle tournerait dans le vide) */
  document.addEventListener('keydown', e => {
    if(e.key !== 'Escape') return;
    if(!$('#ovGame')?.classList.contains('show')) return;
    running = false; cancelAnimationFrame(raf);
    $('#ovGame').classList.remove('show');
  });
  /* --- Personnalisation : aperçus cliquables, purement cosmétiques --- */
  function astPreview(k){
    const s = AST_SKINS[k];
    return `<svg viewBox="0 0 40 40" width="34" height="34"><circle cx="20" cy="20" r="16" fill="${s.body}" stroke="${s.stroke}" stroke-width="3"/><circle cx="15" cy="16" r="4.5" fill="${s.crater}"/><circle cx="26" cy="24" r="3.5" fill="${s.crater}"/></svg>`;
  }
  function planetPreview(k){
    const s = PLANET_SKINS[k];
    return `<svg viewBox="0 0 40 40" width="34" height="34"><circle cx="20" cy="20" r="16" fill="${s.ocean}" stroke="${s.stroke}" stroke-width="3"/><ellipse cx="14" cy="15" rx="7" ry="5" fill="${s.land}"/><ellipse cx="26" cy="25" rx="5" ry="7" fill="${s.land}"/></svg>`;
  }
  function renderSwatches(){
    const a = $('#gcAsteroids'), p = $('#gcPlanets');
    if(a) a.innerHTML = Object.keys(AST_SKINS).map(k => `<button class="gc-swatch${_gameSkin.ast === k ? ' on' : ''}" data-ast="${k}" title="${esc(AST_SKINS[k].nom)}">${astPreview(k)}<span>${esc(AST_SKINS[k].nom)}</span></button>`).join('');
    if(p) p.innerHTML = Object.keys(PLANET_SKINS).map(k => `<button class="gc-swatch${_gameSkin.planet === k ? ' on' : ''}" data-planet="${k}" title="${esc(PLANET_SKINS[k].nom)}">${planetPreview(k)}<span>${esc(PLANET_SKINS[k].nom)}</span></button>`).join('');
  }
  _game = { start };
  const go = $('#gameGo'); if(go) go.onclick = start;
  const rp = $('#gameReplay'); if(rp) rp.onclick = start;
  const cb = $('#gameCustomBtn'); if(cb) cb.onclick = () => { renderSwatches(); $('#gameStart').hidden = true; $('#gameCustom').hidden = false; };
  const cd = $('#gameCustomDone'); if(cd) cd.onclick = () => { $('#gameCustom').hidden = true; $('#gameStart').hidden = false; };
  $('#gameCustom')?.addEventListener('click', e => {
    const b = e.target.closest('[data-ast],[data-planet]');
    if(!b) return;
    if(b.dataset.ast) _gameSkin.ast = b.dataset.ast;
    if(b.dataset.planet) _gameSkin.planet = b.dataset.planet;
    saveGameSkin(); renderSwatches();
  });
})();

/* Classement : envoie le score (si connecté) puis affiche le top 10. */
async function submitAndShowLeaderboard(score){
  const lb = $('#gameLeaderboard'); if(!lb) return;
  lb.innerHTML = `<p class="hint" style="margin:0">Chargement du classement…</p>`;
  const me = getUser()?.pseudo || '';
  if(authToken() && me){
    await srvFetch('/game/score', { method:'POST', body:{ name: me, score }, auth:true });
  }
  const r = await srvFetch('/game/top');
  if(!r.ok || !Array.isArray(r.data?.top)){
    lb.innerHTML = `<p class="hint" style="margin:0">${authToken() ? 'Classement indisponible pour le moment.' : ICO('cadenas',13) + ' Connecte-toi pour enregistrer ton score et voir le classement.'}</p>`;
    return;
  }
  const top = r.data.top;
  if(!top.length){ lb.innerHTML = `<p class="hint" style="margin:0">Sois le premier au classement !</p>`; return; }
  lb.innerHTML = `<h4 class="game-lb-title">${ICO('trophee', 17)} Meilleurs défenseurs</h4>`
    + top.map((s, i) => `<div class="game-lb-row${s.name === me ? ' me' : ''}">
        <span class="game-lb-rank">${i + 1}</span>
        <span class="game-lb-name">${esc(s.name)}</span>
        <span class="game-lb-score">${esc(String(s.score))}</span>
      </div>`).join('');
}

/* ---- Les yeux suivent la souris ----
   Sur un appareil à souris, les pupilles regardent le curseur au lieu de
   balayer toutes seules. Sur écran tactile (pas de souris fine), on garde
   le balayage automatique — la signature du personnage. */
if(window.matchMedia?.('(pointer:fine)').matches && !motionOff()){
  document.documentElement.classList.add('eye-follow');
  let _mx = innerWidth / 2, _my = innerHeight / 2, _eyeRaf = 0;
  const updateEyes = () => {
    _eyeRaf = 0;
    document.querySelectorAll('.mascot').forEach(m => {
      const p = m.querySelector('.m-pupils'); if(!p) return;
      const r = m.getBoundingClientRect(); if(!r.width) return;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      /* décalage borné, dans l'échelle du balayage d'origine (~±4.5) */
      const dx = Math.max(-1, Math.min(1, (_mx - cx) / 170)) * 4.5;
      const dy = Math.max(-1, Math.min(1, (_my - cy) / 170)) * 3.6;
      p.style.transform = `translate(${dx}px, ${dy}px)`;
    });
  };
  addEventListener('mousemove', e => {
    _mx = e.clientX; _my = e.clientY;
    if(!_eyeRaf) _eyeRaf = requestAnimationFrame(updateEyes);
  }, { passive:true });
}
/* errHTML(msg, retryId?) : si un retryId est fourni ET enregistré dans _retryFns,
   un bouton « Réessayer » relance l'action fautive. */
const _retryFns = {};
const SUPPORT_MAIL = 'sacha.pellerin.45@icloud.com';
/* Lien « Signaler » : l'utilisateur n'a aucun détail technique à comprendre,
   il envoie simplement un mail au créateur d'Acolyte. */
function reportMailLink(what){
  const subject = 'Acolyte — un souci technique';
  const body = `Bonjour,\n\nJ'ai rencontré un problème dans Acolyte${what ? ' (' + what + ')' : ''}.\n\nCe que je faisais : \n\n`;
  return `mailto:${SUPPORT_MAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
function errHTML(msg, retryId){
  return `<div class="err">
    <p class="err-msg">${ICO('alerte',16)} ${esc(msg || 'Un petit souci technique. Réessaie dans un instant.')}</p>
    <div class="err-acts">
      ${retryId ? `<button class="btn sm ghost err-retry" data-retry="${esc(retryId)}">↻ Réessayer</button>` : ''}
      <a class="btn sm ghost" href="${reportMailLink(retryId || '')}">${ICO('envoyer',14)} Signaler le problème</a>
    </div>
  </div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-retry]');
  if(b && typeof _retryFns[b.dataset.retry] === 'function') _retryFns[b.dataset.retry]();
});
/* Plus aucune mention du moteur : pour l'utilisateur, c'est Acolyte (la
   mascotte) qui travaille. Le détail vit uniquement dans la politique de
   confidentialité. On garde la fonction pour ne pas toucher les appels. */
function badge(){ return ''; }

/* --- Skeletons : silhouettes de chargement (perçu plus rapide qu'un spinner) --- */
function skelCards(n = 3){
  const one = `<div class="skel-card"><div class="skel skel-line lg"></div><div class="skel skel-line"></div><div class="skel skel-line sm"></div><div class="skel-row"><span class="skel skel-pill"></span><span class="skel skel-pill"></span><span class="skel skel-pill"></span></div></div>`;
  return `<div class="dest-grid">${one.repeat(n)}</div>`;
}
function skelPlan(){
  return `<div class="skel-plan">
    <div class="skel-row" style="gap:10px">${'<span class="skel skel-stat"></span>'.repeat(3)}</div>
    <div class="skel skel-line lg" style="margin-top:16px"></div>
    <div class="skel skel-line"></div><div class="skel skel-line sm"></div>
    <div class="skel skel-line" style="margin-top:14px"></div><div class="skel skel-line sm"></div>
  </div>`;
}
/* --- Progression « vivante » : fait défiler des messages pendant une génération longue.
   Retourne une fonction stop() à appeler quand c'est fini. --- */
function progress(el, msgs){
  if(!el) return () => {};
  let i = 0;
  el.innerHTML = `<div class="card">${loaderHTML(msgs[0])}</div>`;
  const set = () => { const m = el.querySelector('.loader-msg'); if(m) m.textContent = msgs[i % msgs.length]; };
  const id = setInterval(() => { i++; set(); }, 2600);
  return () => clearInterval(id);
}

/* ---------- Contexte voyage ---------- */
/* ---- Forme de l'itinéraire : une ville, plusieurs villes, plusieurs pays ----
   Le moteur savait déjà découper un voyage en villes-étapes, mais il décidait
   seul. Ici le voyageur tranche, et sa consigne est IMPÉRATIVE : c'est ce qui
   fait la différence entre « une semaine à Rome » et « Rome, Florence, Venise ».
   Le nombre d'étapes reste borné : au-delà de 4 bases sur une semaine, on passe
   son voyage dans les trains. */
function itinCtx(p){
  const nuits = /week|2-3/i.test(String(p.days || '')) ? 'court' : 'normal';
  if(p.itin === 'mono')
    return `\n- FORME IMPOSÉE : UNE SEULE VILLE. Le voyageur veut poser ses valises une seule fois. N'utilise PAS "logement.etapes", ne propose aucune ville-étape : un seul logement pour tout le séjour, et des excursions à la journée si besoin.`;
  if(p.itin === 'multi')
    return `\n- FORME IMPOSÉE : PLUSIEURS VILLES dans un même pays (ou une même région). Découpe le séjour en ${nuits === 'court' ? '2' : '2 à 3'} villes-étapes, remplis OBLIGATOIREMENT "logement.etapes", et donne à chaque journée du programme son champ "base". Ordre géographique logique, jamais de retour en arrière, minimum 2 nuits par étape. Compte les trajets entre étapes dans le budget et décris-les dans "transport.details".`;
  if(p.itin === 'pays'){
    const liste = (p.pays || []).filter(Boolean);
    /* Pays désignés par le voyageur : ils sont IMPOSÉS. On laisse quand même
       l'IA fixer l'ordre — c'est elle qui évite les zigzags — et on lui
       demande de le dire franchement si le compte ne tient pas dans la durée,
       plutôt que de bâcler un itinéraire intenable. */
    const impose = liste.length
      ? ` PAYS IMPOSÉS PAR LE VOYAGEUR, à visiter TOUS et UNIQUEMENT ceux-ci : ${liste.join(', ')}. Tu choisis l'ORDRE le plus logique géographiquement (pas de retour en arrière) et la ville-étape de chaque pays. Si ce nombre de pays ne tient honnêtement pas dans la durée du séjour, construis quand même le meilleur itinéraire possible ET dis-le clairement dans "conseil_cle".`
      : ` Tu choisis toi-même ${nuits === 'court' ? '2 pays voisins' : '2 à 3 pays'} réellement enchaînables dans le temps imparti (frontières proches, liaisons directes) — mieux vaut 2 pays bien vus que 4 traversés en courant.`;
    return `\n- FORME IMPOSÉE : PLUSIEURS PAYS.${impose} Une ville-étape par pays au minimum. Remplis OBLIGATOIREMENT "logement.etapes" et le champ "base" de chaque journée. Minimum 2 nuits par étape. Les trajets entre pays (mode, durée, prix réels) vont dans "transport.details" et comptent dans le budget.`;
  }
  return '';
}

function ctx(){
  const p = state.prefs || {}, t = state.trip || {};
  let saison = '';
  if(p.depart){
    const mo = new Date(p.depart + 'T12:00:00');
    if(!isNaN(mo)) saison = mo.toLocaleDateString(LOC(), { month:'long', year:'numeric' });
  }
  /* La consigne de langue passe EN PREMIER : c'est la plus facile à perdre en
     fin de prompt, et tout le contenu du voyage en dépend. Les valeurs des
     champs JSON changent de langue, jamais leurs NOMS — le code les lit. */
  const langue = isEN()
    ? `ANSWER ENTIRELY IN ENGLISH. Every text value you produce is read by an English-speaking traveller: titles, summaries, advice, day programmes, everything. Address them as "you", in a warm and direct tone. Keep the JSON field NAMES exactly as specified (they are in French — never translate the keys), and keep proper nouns in their local form.\n`
    : '';
  return `${langue}Date d'aujourd'hui : ${new Date().toLocaleDateString(LOC())}.
CONTEXTE VOYAGEUR :
- Départ : ${p.from || 'non précisé'}${saison ? `\n- Mois du voyage (calculé) : ${saison} — raisonne selon cette saison précise` : ''}
- Destination choisie : ${t.nom || '?'}, ${t.pays || ''}
- Durée : ${p.days || '?'} · Période : ${p.when || 'flexible'}
- Budget/pers : ${p.budget || '?'} · Voyageurs : ${p.adults||2} adulte(s)${p.kids ? ' + ' + p.kids + ' enfant(s)' : ''}
- Destination souhaitée : ${p.dest || 'libre, à proposer'}${p.vibe ? `\n- Ambiance recherchée : ${p.vibe}` : ''}${p.withWho ? `\n- Voyage ${p.withWho}` : ''}${p.stay ? `\n- Style d'hébergement préféré : ${p.stay}` : ''}${p.transport ? `\n- MOYEN DE TRANSPORT IMPOSÉ par le voyageur : ${p.transport}. Construis le trajet avec ce mode, même s'il n'est pas le plus rapide. S'il est réellement impossible (mer à traverser, distance absurde), dis-le franchement et explique pourquoi avant de proposer autre chose.` : ''}
- Limites & conditions : ${p.free || 'aucune'}${alimCtx(p)}${localCtx(p)}${goutsCtx()}${itinCtx(p)}
${prefsBlock()}
RÈGLES DE QUALITÉ (toujours valables) :
- Uniquement des lieux, quartiers, établissements et transports RÉELS et vérifiables — au moindre doute, préfère l'option la plus connue plutôt que d'inventer.
- Prix en euros, réalistes pour la saison et l'année indiquées ; donne des fourchettes plutôt que des chiffres trop précis.
- Respecte STRICTEMENT le budget et les limites du voyageur.
- ${isEN() ? 'Write every text value in ENGLISH, warm and natural, addressing the traveller as "you".' : 'TUTOIE toujours le voyageur (jamais de vouvoiement), ton chaleureux et naturel.'}${p.kids ? (isEN() ? '\n- CHILDREN are travelling: adapt every piece of advice (pace, distances, activities, restaurants) to their presence.' : '\n- Des ENFANTS voyagent : adapte chaque conseil (rythme, distances, activités, restaurants) à leur présence.') : ''}${agesEnfantsTexte(p.kidsAges) ? '\n- ' + agesEnfantsTexte(p.kidsAges) : ''}`;
}

/* ============================================================
   ÉTAPE 1 — ENVIES → PROPOSITIONS  (Gemini · heavy)
============================================================ */
function readPrefs(extra){
  return {
    from:  $('#fFrom').value.trim() || 'Paris',
    dest:  $('#fDest').value.trim(),
    days:  $('#fDays').value,
    when:  $('#fWhen').value.trim(),
    budget:$('#fBudget').value,
    adults:+$('#fAdults').value || 2,
    kids:  +$('#fKids').value || 0,
    /* Les âges tels que saisis, nettoyés : on garde les nombres de 0 à 17
       et rien d'autre. Un champ libre part dans un prompt — on ne laisse
       pas passer du texte arbitraire. */
    kidsAges: ($('#fKidsAges')?.value || '').match(/\d{1,2}/g)?.map(Number)
                .filter(n => n >= 0 && n <= 17).slice(0, 6) || [],
    depart:$('#fDepart').value,
    vibe:  $('#fVibe')?.value || '',
    withWho:$('#fWith')?.value || '',
    stay:  $('#fStay')?.value || '',
    transport: $('#fTransport')?.value || '',
    /* case cochée → itinéraire multi-pays ; décochée → Acolyte décide seul */
    itin:  $('#fMulti')?.checked ? 'pays' : '',
    /* pays imposés — n'a de sens que si la case est cochée */
    pays:  $('#fMulti')?.checked ? _paysChoisis.slice(0, PAYS_MAX) : [],
    /* À table. `evite` est bridé à 160 caractères et part tel quel dans le
       prompt : c'est du texte libre du voyageur, comme `free` juste dessous. */
    regime: $('#fRegime')?.value || '',
    evite:  ($('#fEvite')?.value || '').trim().slice(0, 160),
    local:  !!$('#fLocal')?.checked,
    /* ⚠️ Le budget inversé s'ajoute ICI, dans « free », et pas ailleurs : c'est
       le champ que ctx() transmet mot pour mot au modèle sous « Limites &
       conditions ». Il profite donc de tout ce qui existe déjà — données
       réelles, relecture croisée, garde-fous — sans un seul appel de plus. */
    free:  ($('#fFree').value.trim().slice(0,600)
            + (typeof budgetInverseTexte === 'function' ? budgetInverseTexte() : '')
            + (typeof pondTexte === 'function' ? pondTexte() : '')
            + (extra ? ' | Affinage : ' + String(extra).slice(0,600) : '')).slice(0, 1600)
  };
}

let _genBusy = false;   /* garde anti double-appel des générations IA */
/* Où le résultat de la recherche doit atterrir : 'page' (le parcours en trois
   étapes) ou 'chat' (la discussion de l'assistant). Déclaré en `var` — il est
   lu dans proposeTrips, bien avant sa position dans le fichier. */
var _propVers = 'page';
async function proposeTrips(extra = '', lucky = false, country = '', vers){
  /* ⚠️ LA PORTE EST ICI, pas à l'entrée du site. C'est le premier geste qui
     consomme réellement l'IA — donc le premier qui exige un compte. */
  if(!exigeCompte('Crée ton compte pour lancer une recherche de destinations')) return;
  if(_genBusy) return;
  _propVers = vers === 'chat' ? 'chat' : 'page';
  _genBusy = true;
  _retryFns.propose = () => proposeTrips(extra, lucky, country, vers);
  const prefs = readPrefs(extra);
  state.prefs = prefs; save();
  const zone = $('#zoneResults');
  const msgs = country
    ? [`Acolyte cherche LE bon coin en/au ${country}… 🎯`, 'Il compare les villes et les ambiances…', 'Vérification budget, saison & accès…', 'Presque prêt…']
    : lucky
    ? ['Roulette mondiale en cours… 🎲', 'Tirage de destinations inattendues…', 'Vérification budget & saison…', 'Presque prêt…']
    : ['Acolyte explore le monde pour toi… 🌍', 'Analyse de tes envies & ton budget…', 'Sélection de destinations réelles…', 'Transport & quartier pour chacune…', 'Presque prêt…'];
  /* ⚠️ Le squelette de chargement ne se pose QUE sur la page. Depuis la
     discussion, il peindrait dans un onglet qu'on ne regarde pas — et comme
     renderDestinations n'y sera jamais appelé, il y resterait indéfiniment. */
  if(_propVers === 'page'){
    zone.innerHTML = `<div class="card">${loaderHTML(msgs[0])}</div>` + skelCards(3);
  }
  let mi = 0;
  const msgTimer = setInterval(() => { mi++; const m = zone.querySelector('.loader-msg'); if(m) m.textContent = msgs[mi % msgs.length]; }, 2600);
  searchBar(true, lucky ? 'Roulette mondiale en cours… 🎲' : 'Acolyte explore le monde…');
  $('#btnGo').disabled = true; $('#btnLucky').disabled = true; if($('#btnCountry')) $('#btnCountry').disabled = true;

  const prompt = `Tu es Acolyte, un expert voyage français, chaleureux et concret.
${ctx()}
${lucky ? 'MODE SURPRISE : propose des destinations inattendues, originales, auxquelles le voyageur ne penserait jamais, mais qui collent quand même au budget et à la période.' : ''}
${country ? `MODE « SURPRISE DANS UN PAYS » : le voyageur veut absolument voyager en/au ${country}, mais il te laisse CHOISIR l'endroit précis. Propose UNE SEULE destination : une ville, une région ou un lieu PRÉCIS et RÉEL de ${country} — de préférence pas le plus évident/touristique — parfaitement adapté à son budget, sa période et ses envies. Dans "resume", explique clairement POURQUOI c'est LE bon choix surprise dans ce pays. Ignore la règle du nombre de propositions ci-dessous : ici, exactement UNE.` : ''}
TOUT DOIT ÊTRE TROUVÉ DÈS MAINTENANT : pour CHAQUE proposition, tu donnes déjà le transport (mode, prix A/R, durée) ET le logement (type, quartier réel, prix/nuit). Le voyageur doit pouvoir comparer sans rien avoir à deviner. Uniquement des quartiers qui EXISTENT VRAIMENT.

QUESTIONS DE PRÉCISION : si des infos te manquent pour viser juste (rythme, ambiance, priorités, contraintes), pose 2 ou 3 questions courtes dans "questions", chacune avec un nombre PAIR d'options cliquables (exactement 2 ou 4, jamais 3). Si le voyageur a déjà tout précisé, renvoie "questions":[].

${(state.seen||[]).length && !prefs.dest ? 'DÉJÀ PROPOSÉ à ce voyageur (ne PAS reproposer sauf s\'il le demande) : ' + state.seen.join(', ') + '.' : ''}
${(getHistory()||[]).length ? 'VOYAGES DÉJÀ CHOISIS par ce voyageur par le passé : ' + getHistory().map(h=>h.nom).join(', ') + ' — ne les repropose pas, mais inspire-toi de ses goûts.' : ''}
${prefs.itin === 'multi' || prefs.itin === 'pays' ? `FORME D'ITINÉRAIRE IMPOSÉE (voir contexte) : chaque proposition doit être un ITINÉRAIRE, pas une ville unique. Dans "nom", écris le parcours (ex : « Rome → Florence → Venise »${prefs.itin === 'pays' ? ', et pour plusieurs pays : « Vienne → Bratislava → Budapest »' : ''}), et dans "pays" ${prefs.itin === 'pays' ? 'liste les pays traversés (ex : « Autriche, Slovaquie, Hongrie »)' : 'le pays concerné'}. Le "budget_estime" doit inclure les trajets entre étapes. Dans "resume", dis en une phrase pourquoi CET enchaînement se tient dans le temps imparti.
${(prefs.pays || []).length ? `Les pays sont IMPOSÉS : ${prefs.pays.join(', ')}. Chaque proposition doit couvrir TOUS ces pays et AUCUN autre — ce qui change d'une proposition à l'autre, c'est l'ordre, les villes-étapes choisies et la répartition des nuits. Ne propose donc qu'UNE à DEUX variantes, vraiment différentes.` : ''}
` : ''}${prefs.itin === 'mono' ? 'FORME IMPOSÉE : le voyageur veut UNE SEULE ville par proposition — pas d’itinéraire, pas d’enchaînement.\n' : ''}DÉCIDE toi-même du NOMBRE de propositions (1 à 3) selon la demande :
- La demande désigne UNE VILLE précise → UNE SEULE proposition : la meilleure formule pour cette ville, très travaillée.
- Un PAYS ou une région → 2 ou 3 villes/zones DIFFÉRENTES de ce pays.
- Demande ouverte → 3 destinations VRAIMENT différentes.
INTERDICTION ABSOLUE de proposer des voyages qui se ressemblent : chaque proposition doit différer clairement des autres (ville différente, OU ambiance/gamme de budget/rythme radicalement différents). Ne remplis jamais avec des variantes cosmétiques.
Respecte STRICTEMENT le budget, les limites, la durée et la période — attention à la météo saisonnière.
RÈGLE ABSOLUE : uniquement des villes et lieux RÉELS. Budgets réalistes pour la saison. En cas de doute, prudence plutôt qu'invention.
${prefs.free && prefs.free.includes('Affinage') ? "Le voyageur a déjà répondu à des questions d'affinage (voir contexte) : intègre ces réponses et ne repose JAMAIS une question déjà répondue." : ''}

Réponds UNIQUEMENT en JSON valide, structure exacte. Commence OBLIGATOIREMENT par le champ "analyse" (ton raisonnement interne, jamais montré au voyageur) AVANT les destinations :
{
 "analyse":"3-4 phrases : profil du voyageur, contraintes clés (budget/saison/distance), pièges à éviter, angle distinct choisi pour chaque proposition",
 "destinations":[
   {
     "nom":"...", "pays":"...", "drapeau":"emoji drapeau",
     "resume":"2 phrases vendeuses et concrètes",
     "budget_estime":"ex: ~850€/pers tout compris",
     "duree_ideale":"ex: 5-7 jours",
     "meteo_periode":"ex: 26°C, ensoleillé",
     "points_forts":["3 à 4 atouts courts"],
     "acces":"avion" ou "voiture" ou "train" ou "avion ou voiture",
     "iata":"code IATA aéroport principal, ex CDG, sinon null",
     "ville_aeroport":"nom ville aéroport le plus proche",
     "langue":"langue principale parlée",
     "monnaie":"monnaie locale",
     "transport_conseille":"avion" ou "train" ou "voiture",
     "transport_pourquoi":"6-10 mots : pourquoi ce transport vu le budget/conditions",
     "transport_prix":"fourchette A/R par personne, ex 90-140€",
     "transport_duree":"durée porte-à-porte, ex 2h15 de vol + 1h de transferts",
     "logement_type":"1 ou 2 mots MAX : hôtel, appartement, auberge, villa…",
     "logement_quartier":"LE quartier précis conseillé (nom réel), ex Trastevere",
     "logement_prix":"fourchette par nuit, ex 80-120€",
     "logement_pourquoi":"6-10 mots : pourquoi ce quartier"
   }
 ],
 "questions":[
   {"texte":"question courte et UTILE pour préciser le voyage","options":["2 ou 4 réponses courtes — toujours un nombre PAIR"]}
 ]
}
"questions" : 1 à 3 questions qui aideraient VRAIMENT à préciser le voyage (dates exactes ? quartier ambiance ? priorité visites/repos ? contrainte transport ?). Jamais de question dont la réponse est déjà dans le contexte.`;

  try{
    let d = await gemini(prompt, true, 8192);
    if(SET?.verif !== false && !lucky) d = await reviewProps(d, prompt);
    state.destinations = d.destinations || [];
    state.seen = [...new Set([...(state.seen||[]), ...state.destinations.map(x=>x.nom)])].slice(-15);
    state.lastProps = d; save();
    /* ⚠️ MÊME MOTEUR, DEUX SORTIES. Quand la demande vient de l'assistant, le
       résultat s'affiche DANS la discussion : on ne bascule plus d'onglet, on
       ne perd plus le fil de la conversation, et la phrase qui a produit ces
       propositions reste juste au-dessus d'elles.
       C'est la SORTIE qui change, pas la recherche : même prompt, mêmes
       données réelles, même relecture croisée, mêmes garde-fous. Dupliquer
       tout ça pour l'assistant aurait fait deux moteurs à tenir d'accord. */
    if(_propVers === 'chat'){
      iaAjouteCartes(d);
      return;                       /* pas de changement d'étape, pas de pop-up */
    }
    renderDestinations(d);
    gotoStep(2);
    /* → Questions de précision AVANT que tu ne choisisses : la pop-up s'ouvre ici */
    const qs = (d.questions || []).filter(q => q && q.texte);
    if(qs.length && !state._qsDone) openQsPopup(qs);
    else { $('#ovQs').classList.remove('show'); $('#zoneQs').innerHTML = ''; }
  }catch(e){
    const msg = e.message === 'RATE' ? 'Beaucoup de monde en ce moment — réessaie dans une minute.'
      : (e.name === 'AbortError' ? 'La recherche a mis trop de temps — réessaie.' : 'Un souci technique. Vérifie ta connexion et réessaie.');
    /* L'échec doit revenir là où la demande a été faite : dans la discussion si
       elle en vient, sinon sur la page. Une erreur affichée dans un onglet
       qu'on ne regarde pas équivaut à un silence. */
    if(_propVers === 'chat'){ if(e.message !== 'NO_KEY') iaAjoute('aco', msg, true); }
    else if(e.message !== 'NO_KEY') zone.innerHTML = `<div class="card">${errHTML(msg, 'propose')}</div>`;
    else zone.innerHTML = '';
  }finally{
    /* ⚠️ TOUT LE NETTOYAGE EST ICI, ET NULLE PART AILLEURS. Ces trois lignes
       étaient posées APRÈS le try/catch/finally, ce qui marchait tant que la
       fonction n'avait qu'une seule sortie. Le jour où la recherche depuis la
       discussion a gagné son `return` anticipé (« pas de changement d'étape »),
       elles ont cessé d'être atteintes sur ce chemin : la barre de recherche
       restait affichée, son intervalle continuait de faire défiler les messages
       en boucle, et surtout searchBar(true) avait posé `display:none` sur la
       barre d'onglets — qui ne revenait donc jamais.
       Un `return` dans le try saute ce qui suit le bloc, pas le finally. */
    clearInterval(msgTimer);
    _genBusy = false;
    searchBar(false);
    $('#btnGo').disabled = false; $('#btnLucky').disabled = false; if($('#btnCountry')) $('#btnCountry').disabled = false;
  }
}

/* "Hôtel familial ou appart-hôtel" → "Hôtel familial" ; "180-250€ par nuit" → "180-250€" */
const shortType = s => String(s || 'logement').split(/\s*(?:\(|\bou\b|\/)/i)[0].trim().slice(0, 18) || 'logement';
const cleanPrix = s => String(s || '').replace(/\s*(par|\/)\s*nuit/gi, '').trim();

function renderDestinations(d){
  const zone = $('#zoneResults');
  const n = (d.destinations||[]).length;
  let html = `<div class="card"><h2>${n > 1 ? 'Compare tes voyages' : 'Ton voyage sur mesure'} ${ICO('sac', 20)}</h2>
  <p class="sub">${n > 1 ? 'Des propositions volontairement différentes. Compare-les point par point et clique sur celle qui te fait vibrer.' : 'Acolyte a concentré ses efforts sur la formule idéale pour ta destination. Clique dessus pour lancer l\'organisation.'}</p>
  <div class="dest-grid">`;
  (d.destinations||[]).forEach((x,i)=>{
    const tIco = ICO(({avion:'avion',train:'train',voiture:'voiture'})[x.transport_conseille] || 'avion', 15);
    html += `<div class="dest" data-i="${i}">
      <div class="dest-main">
        <div class="flag">${esc(drapeauOuPoint(x.drapeau))}</div>
        <h3>${esc(x.nom)}</h3><div class="country">${esc(x.pays)}</div>
        <p>${esc(x.resume)}</p>
      </div>
      <div class="dest-facts">
        <div class="fact"><span class="fk">${ICO('money', 15)} Budget</span><span class="fv">${esc(x.budget_estime)}</span></div>
        <div class="fact"><span class="fk">${tIco} ${esc(x.transport_conseille||'avion')}</span><span class="fv">${esc(x.transport_prix||'—')}${x.transport_duree ? ` · ${esc(x.transport_duree)}` : ''}</span></div>
        <div class="fact"><span class="fk">${ICO('hotel', 15)} ${esc(shortType(x.logement_type))}</span><span class="fv">${esc(x.logement_quartier||'—')}${x.logement_prix ? ` · ${esc(cleanPrix(x.logement_prix))}/nuit` : ''}</span></div>
        <div class="fact"><span class="fk">${ICO('soleil', 15)} Météo</span><span class="fv">${esc(x.meteo_periode)}</span></div>
        <div class="fact"><span class="fk">${ICO('horloge', 15)} Durée</span><span class="fv">${esc(x.duree_ideale)}</span></div>
        <div class="fact"><span class="fk">${ICO('langue', 15)} Langue</span><span class="fv">${esc(x.langue||'—')}</span></div>
      </div>
      ${(x.transport_pourquoi || x.logement_pourquoi) ? `<p class="hint" style="margin-top:8px">${x.transport_pourquoi ? ICO('avion', 14) + ' ' + esc(x.transport_pourquoi) : ''}${x.transport_pourquoi && x.logement_pourquoi ? ' · ' : ''}${x.logement_pourquoi ? ICO('hotel', 14) + ' ' + esc(x.logement_pourquoi) : ''}</p>` : ''}
      <div class="tags" style="margin-top:10px">${(x.points_forts||[]).map(p=>`<span class="tag">${esc(p)}</span>`).join('')}</div>
      <button class="btn sm" style="width:100%;justify-content:center;margin-top:6px">Choisir ce voyage →</button>
    </div>`;
  });
  html += `</div>`;
  /* Les questions ne s'affichent QUE dans la pop-up — jamais dans la page. */
  html += `</div>`;

  /* Comparatif côte à côte — tout aligné, point par point (uniquement si plusieurs propositions) */
  if(n > 1){
    const D = d.destinations;
    const rows = [
      ['💶 Budget',    D.map(x => esc(x.budget_estime || '—'))],
      ['✈️ Transport', D.map(x => `${esc(x.transport_conseille || 'avion')} · ${esc(x.transport_prix || '—')}`)],
      ['🏨 Logement',  D.map(x => `${esc(shortType(x.logement_type))}${x.logement_quartier ? ' · ' + esc(x.logement_quartier) : ''}`)],
      ['☀️ Météo',     D.map(x => esc(x.meteo_periode || '—'))],
      ['⏱ Durée',      D.map(x => esc(x.duree_ideale || '—'))],
      ['🗣️ Langue',    D.map(x => esc(x.langue || '—'))]
    ];
    html += `<div class="card"><h3 style="margin:0 0 4px">${ICO('graphique', 17)} Comparatif</h3>
      <p class="sub" style="margin:0 0 10px">Tout est aligné — compare point par point, puis choisis ta colonne.</p>
      <div class="cmp-wrap"><table class="cmp">
        <thead><tr><th></th>${D.map((x, i) => `<th data-i="${i}"><span class="cmp-flag">${esc(drapeauOuPoint(x.drapeau))}</span><br>${esc(x.nom)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(r => `<tr><th scope="row">${r[0]}</th>${r[1].map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}
          <tr class="cmp-actions"><td></td>${D.map((x, i) => `<td><button class="btn sm cmp-choose" data-i="${i}">Choisir →</button></td>`).join('')}</tr>
        </tbody>
      </table></div></div>`;
  }
  /* Affinage en langage libre : « pas tout à fait ça… » → relance en tenant compte du feedback */
  html += `<div class="card">
    <h3 style="margin:0 0 4px">${ICO('crayon', 17)} Pas tout à fait ça ?</h3>
    <p class="sub" style="margin:0 0 10px">Dis à Acolyte ce qui cloche, il repropose en en tenant compte.</p>
    <div class="refine-bar">
      <input id="refineInp" class="refine-inp" type="text" placeholder="ex : plus près de la mer, moins cher, plus animé…" aria-label="Ce qui ne va pas dans les propositions">
      <button class="btn sm" id="refineGo">Reproposer →</button>
    </div>
  </div>`;
  zone.innerHTML = html;

  $$('.dest').forEach(el => el.onclick = () => chooseTrip(+el.dataset.i));
  $$('.cmp-choose, .cmp th[data-i]').forEach(el => el.onclick = () => chooseTrip(+el.dataset.i));
  const doRefine = () => {
    const inp = $('#refineInp'); const v = (inp?.value || '').trim();
    if(!v) return;
    state.propAnswers = [...(state.propAnswers || []), 'Précision : ' + v].slice(-12);
    save();
    toast('🎯 Acolyte réajuste ses propositions…');
    proposeTrips(state.propAnswers.join(' · '));
  };
  const rgo = $('#refineGo'); if(rgo) rgo.onclick = doRefine;
  const rinp = $('#refineInp'); if(rinp) rinp.addEventListener('keydown', e => { if(e.key === 'Enter') doRefine(); });
  $$('.chip.refine').forEach(el => el.onclick = () => {
    state.propAnswers = state.propAnswers || [];
    state.propAnswers.push(`${el.dataset.q || 'Affinage'} → ${el.dataset.r}`.slice(0,200));
    state.propAnswers = state.propAnswers.slice(-12);
    save();
    toast('✔ ' + el.dataset.r);
    proposeTrips(state.propAnswers.join(' · '));
  });
}

const LS_HIST = 'acolite_history';
function getHistory(){ try{ return JSON.parse(localStorage.getItem(LS_HIST)) || []; }catch(e){ return []; } }
function pushHistory(t){
  const h = getHistory().filter(x => x.nom !== t.nom);
  /* on garde le voyage COMPLET + un instantané des préférences → permet de le rouvrir */
  h.push({ nom: t.nom, pays: t.pays, drapeau: t.drapeau, budget_estime: t.budget_estime,
           quand: Date.now(), trip: t, prefs: state.prefs || null });
  try{ localStorage.setItem(LS_HIST, JSON.stringify(h.slice(-10))); }
  catch(e){ /* quota → on retombe sur une version légère */
    try{ localStorage.setItem(LS_HIST, JSON.stringify(h.slice(-10).map(x => ({ nom:x.nom, pays:x.pays, drapeau:x.drapeau, budget_estime:x.budget_estime, quand:x.quand, trip:x.trip })))); }catch(_){}
  }
  renderGallery();
}

/* --- Galerie « Mes voyages » : reprendre un voyage déjà exploré --- */
let _galExpanded = false;   /* affiche-t-on TOUS les voyages, ou les 3 premiers ? */
function renderGallery(){
  const box = $('#galleryList'), card = $('#tripGallery');
  if(!box || !card) return;
  const h = getHistory().slice().reverse();
  if(!h.length){ card.hidden = true; box.innerHTML = ''; return; }
  card.hidden = false;
  /* au-delà de 3 voyages, on n'en montre que 3 — un bouton déplie le reste */
  const LIMITE = 3;
  const trop = h.length > LIMITE;
  const visibles = (trop && !_galExpanded) ? h.slice(0, LIMITE) : h;
  box.innerHTML = visibles.map((x, i) => `
    <div class="gal">
      <div class="gal-flag">${esc(x.drapeau || '📍')}</div>
      <div class="gal-info">
        <b>${esc(x.nom)}</b>
        <span>${esc(x.pays || '')}${x.budget_estime ? ' · ' + esc(x.budget_estime) : ''}</span>
      </div>
      <button class="btn sm ghost gal-open" data-gi="${i}">${x.trip ? 'Rouvrir →' : 'Reproposer'}</button>
      <button class="gal-del" data-galdel="${i}" title="${isEN() ? 'Remove from my trips' : 'Retirer de mes voyages'}"
        aria-label="${isEN() ? 'Remove' : 'Retirer'} ${esc(x.nom)}">🗑️</button>
    </div>`).join('')
    + (trop ? `<button class="btn ghost sm gal-toggle" id="galToggle">${
        _galExpanded ? '▲ Afficher moins' : `▼ Voir tous mes voyages (${h.length})`}</button>` : '');
}
document.addEventListener('click', e => {
  if(e.target.id === 'galToggle'){ _galExpanded = !_galExpanded; renderGallery(); }
});
/* Retirer un voyage de la galerie. Confirmation demandée : c'est irréversible,
   et le souvenir d'un voyage passé a de la valeur. On ne touche PAS au voyage
   en cours — seulement à la liste des voyages déjà explorés. */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-galdel]');
  if(!b) return;
  /* l'index est celui de la liste AFFICHÉE (la plus récente d'abord) */
  const liste = getHistory();
  const idxAffiche = +b.dataset.galdel;
  const cible = liste.slice().reverse()[idxAffiche];
  if(!cible) return;
  const q = isEN()
    ? `Remove “${cible.nom}” from your trips?\nThis only clears the memory of it — your current trip is untouched.`
    : `Retirer « ${cible.nom} » de tes voyages ?\nÇa n'efface que ce souvenir — ton voyage en cours n'est pas touché.`;
  if(!confirm(q)) return;
  /* on retire par NOM : c'est la clé qu'utilise déjà pushHistory pour dédoublonner */
  const reste = liste.filter(x => x.nom !== cible.nom);
  try{ localStorage.setItem(LS_HIST, JSON.stringify(reste)); }catch(err){}
  /* la liste dépliée n'a plus lieu d'être si tout tient désormais */
  if(reste.length <= 3) _galExpanded = false;
  renderGallery();
  pushSync();                 /* la galerie fait partie de ce qui se synchronise */
  toast(isEN() ? '🗑️ Trip removed' : '🗑️ Voyage retiré');
});
function reopenTrip(i){
  const x = getHistory().slice().reverse()[i];
  if(!x) return;
  if(!x.trip){ const f = $('#fDest'); if(f) f.value = x.nom; gotoStep(1); toast('Destination pré-remplie 👍'); return; }
  state.trip = x.trip;
  if(x.prefs) state.prefs = x.prefs;
  state.cache = {}; state.checklist = {}; state.maison = {}; state.spends = []; state.chatLog = []; state.notes = ''; state.resas = [];
  state._geo = null; state.planAnswers = []; state._qsDone = false; _onSiteDone = false;
  _pcPhotos = null;   /* sinon la carte postale garderait les photos du voyage précédent */
  state.board = { votes:{}, comments:{} };
  save();
  unlockSteps();
  toast(`On repart pour ${x.trip.nom} ! ✈️`);
  gotoStep(3);
}
document.addEventListener('click', e => {
  const g = e.target.closest('.gal-open');
  if(g){ reopenTrip(+g.dataset.gi); }
});

function chooseTrip(i){
  state.trip = state.destinations[i];
  pushHistory(state.trip);
  state.cache = {}; state.checklist = {}; state.maison = {}; state.spends = []; state.chatLog = []; state.notes = ''; state.resas = [];
  state._geo = null; state.planAnswers = []; state._qsDone = false; _onSiteDone = false;
  _pcPhotos = null;   /* photos de carte postale liées au voyage précédent */
  state.board = { votes:{}, comments:{} };   /* votes/commentaires liés à l'ancien voyage */
  save();
  unlockSteps();
  toast(`Cap sur ${state.trip.nom} ! ✈️`);
  gotoStep(3);
}

/* ============================================================
   BOARDING PASS
============================================================ */
/* ============================================================
   LES DRAPEAUX NE SE DESSINENT PAS PARTOUT
   ------------------------------------------------------------
   ⚠️ Windows n'embarque AUCUNE police pour les indicateurs régionaux : un
   « 🇮🇹 » parfaitement valide y sort en glyphes de repli — c'est le « Venise π »
   qu'on voyait sur le billet. La donnée est bonne, c'est le RENDU qui n'existe
   pas, donc aucun filtre sur la valeur ne peut y remédier.
   On mesure donc une fois si le système sait le faire : un vrai drapeau est
   dessiné comme UN seul glyphe, un système sans support en dessine DEUX, donc
   plus large. Le repli est un marqueur neutre, qui lui s'affiche partout.
   ⚠️ Mesuré une seule fois et mémorisé : c'est un test qui force un calcul de
   rendu, on ne le refait pas à chaque carte de destination.
============================================================ */
/* ⚠️ « var », pas « let » — même piège que _blogIdx, et il est réel ici :
   renderDestinations() vit ligne ~1439, soit 200 lignes AVANT cette
   déclaration, et appelle drapeauOuPoint(). Avec « let », un affichage des
   propositions déclenché pendant l'évaluation du fichier lirait la variable en
   zone morte → ReferenceError, et plus aucune destination à l'écran. */
var _drapeauxOK = null;
function drapeauxDessinables(){
  if(_drapeauxOK !== null) return _drapeauxOK;
  try{
    const c = document.createElement('canvas').getContext('2d');
    c.font = '32px sans-serif';
    /* 🇮🇹 rendu en drapeau = un glyphe ; sans support = deux lettres côte à
       côte, donc nettement plus large qu'un caractère seul. */
    _drapeauxOK = c.measureText('\u{1F1EE}\u{1F1F9}').width < c.measureText('\u{1F1EE}').width * 1.6;
  }catch(e){ _drapeauxOK = false; }
  return _drapeauxOK;
}
/* Le drapeau s'il est dessinable, sinon un marqueur qui l'est partout. */
function drapeauOuPoint(d){
  const s = String(d || '').trim();
  if(!s) return '📍';
  if(/^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(s)) return drapeauxDessinables() ? s : '📍';
  return s;   /* le modèle a renvoyé autre chose qu'un drapeau : on le laisse */
}

function passHTML(){
  const t = state.trip, p = state.prefs || {};
  if(!t) return '';
  const from = (p.from || 'PAR').slice(0,3).toUpperCase();
  const to   = (t.iata || t.nom.slice(0,3)).toUpperCase();
  const plan = state.cache.plan;
  const d    = stayDates();
  const jj   = s => s.split('-').reverse().slice(0,2).join('/');
  const dates = d ? `${jj(d.in)} → ${jj(d.out)}` : (p.when || 'dates flexibles');
  const nuits = d ? Math.max(1, Math.round((new Date(d.out) - new Date(d.in)) / 86400000)) : null;
  const pax   = `${p.adults || 1} ad.${p.kids ? ` + ${p.kids} enf.` : ''}`;
  /* on garde un type de logement COURT : "Appartement ou Hôtel familial" → "Appartement" */
  const logt = plan?.logement
    ? String(plan.logement.type || '').split(/\s*(?:\(|ou |\/)/)[0].trim().slice(0, 16)
    : '';
  const budget = plan?.budget?.total ? `${plan.budget.total} €` : (t.budget_estime || '—').replace(/\/pers.*$/i, '');

  /* ⚠️ PLUS DE DRAPEAU DU TOUT, ET LA RAISON N'EST PAS UNE DONNÉE FAUSSE.
     L'écran montrait « Venise π ». J'ai d'abord cru à une valeur abîmée venue
     du modèle et posé un filtre sur la paire d'indicateurs régionaux. Vérifié
     ensuite : la donnée est PARFAITE (U+1F1EE U+1F1F9 = 🇮🇹). C'est WINDOWS qui
     ne sait pas dessiner les drapeaux — il n'embarque aucune police pour les
     indicateurs régionaux, et les remplace par des glyphes de repli.
     Aucun filtre ne peut donc corriger ça : la donnée est bonne, c'est le
     rendu qui n'existe pas. Tout visiteur sous Windows — la majorité sur
     ordinateur — voyait ce symbole à côté du nom de sa ville.
     Un ornement qui casse sur une plateforme entière n'est pas un ornement,
     c'est un défaut. Le pays est déjà écrit ailleurs dans le voyage ; on ne
     perd aucune information. */

  /* ⚠️ CE BLOC AVAIT SON PROPRE JEU D'ICÔNES, écrit avant que ICO_D n'existe —
     et il s'appelait `ICO`, donc il MASQUAIT la fonction globale du même nom
     dans toute cette portée. Deux défauts en un : quatre tracés en double à
     tenir d'accord, et un piège pour quiconque appellerait ICO() ici.
     Les quatre (billet, image, lien, calendrier) sont déjà dans ICO_D. */
  const svg = (nom) => ICO(nom, 22, 'pact-i');

  return `<div class="pass">
    <div class="pass-top">
      <div class="pass-route">
        <span class="iata">${esc(from)}</span>
        <span class="dash"></span>
        <span class="plane" aria-hidden="true">✈</span>
        <span class="dash"></span>
        <span class="iata">${esc(to)}</span>
      </div>
      <button class="pass-change" data-changedest title="Changer de destination" aria-label="Changer de destination">↩</button>
    </div>

    <div class="pass-info">
      <div class="pi"><span class="pk">Destination</span><span class="pv">${esc(t.nom)}</span></div>
      <div class="pi"><span class="pk">Dates</span><span class="pv">${esc(dates)}${nuits ? ` · ${nuits} n.` : ''}</span></div>
      <div class="pi"><span class="pk">Passagers</span><span class="pv">${esc(pax)}</span></div>
      <div class="pi"><span class="pk">Budget</span><span class="pv">${esc(budget)}${logt ? ` · ${esc(logt)}` : ''}</span></div>
    </div>

    <div class="pass-tear">
      <div class="pass-acts">
        <button class="pact" data-passpng title="Télécharger le ticket avec son QR code">${svg('billet')}<span>Ticket</span></button>
        <button class="pact" data-postcard title="Créer une carte postale à partager">${svg('image')}<span>Postale</span></button>
        <button class="pact" data-sharelink title="Partager un lien qui importe ce voyage">${svg('lien')}<span>Lien</span></button>
        <button class="pact" data-ics title="Ajouter le programme à ton agenda">${svg('calendrier')}<span>Agenda</span></button>
      </div>
    </div>
    <p class="pass-note">Ticket souvenir — ne permet pas d'embarquer. Le QR sert uniquement à importer ce voyage dans Acolyte.</p>
  </div>`;
}
function changeDest(){ gotoStep(1); }
window.changeDest = changeDest;
function refreshPasses(){
  const h = passHTML();
  ['#passSlot2','#passSlot3','#passSlot4','#passSlot5'].forEach(s=>{ const el=$(s); if(el) el.innerHTML=h; });
}

/* ============================================================
   NAVIGATION
============================================================ */
function unlockSteps(){
  $$('.step').forEach(s => {
    const n = +s.dataset.step;
    if(n === 2) s.classList.toggle('locked', !(state.destinations||[]).length);
    if(n === 3) s.classList.toggle('locked', !state.trip);
  });
}
let _onSiteDone = false;
function openSub(t){
  $$('.subtab').forEach(x => x.classList.toggle('on', x.dataset.t === t));
  Object.entries(TAB_PANELS).forEach(([k, sel]) => $(sel)?.classList.toggle('hidden', k !== t));
}

function gotoStep(n, sub){
  n = Math.min(n, 3);
  if(n === 2 && !(state.destinations||[]).length){ toast('Remplis d’abord le questionnaire 😉'); return; }
  if(n === 3 && !state.trip){ toast('Choisis d’abord un des 3 voyages 😉'); return; }
  state.step = n; save();
  $$('.step').forEach(s => s.classList.toggle('active', +s.dataset.step === n));
  /* La barre de progression : une seule variable CSS, écrite ici — donc elle
     ne peut pas se désynchroniser de l'étape réelle. 0 / 50 / 100 %, parce que
     le rail relie trois points : à l'étape 1 rien n'est parcouru, à l'étape 3
     tout l'est. */
  { const b = $('#steps'); if(b) b.style.setProperty('--avance', ((n - 1) / 2 * 100) + '%'); }
  /* la colonne de gauche porte le même parcours : elle doit rester d'accord
     avec le fil horizontal, sinon on lit deux états contradictoires */
  renderRail();
  [1,2,3].forEach(i => $('#view'+i).classList.toggle('hidden', i !== n));
  refreshPasses();
  window.scrollTo({top:0, behavior:'smooth'});
  if(n === 3) loadPlan();
}
$$('.step').forEach(s => s.onclick = () => { if(!s.classList.contains('locked')) gotoStep(+s.dataset.step); });

/* ============================================================
   ÉTAPE 2 — PLAN CLÉ EN MAIN (Gemini · heavy)
   L'IA choisit le transport, le logement, organise le séjour,
   pose ses questions — le voyageur n'a plus qu'à valider.
============================================================ */
function syncModeFromPlan(d){
  const map = {avion:'plane', train:'train', voiture:'car'};
  const m = map[d?.transport?.mode];
  if(m && !state.modeManual) state.mode = m;
  save();
  $('#tgPlane').classList.toggle('on', state.mode==='plane');
  $('#tgCar').classList.toggle('on', state.mode==='car');
  $('#tgTrain').classList.toggle('on', state.mode==='train');
}

/* ============================================================
   DONNÉES RÉELLES GRATUITES — ancrent l'IA dans le concret
   (Open-Meteo géocodage+météo, Wikipédia, prix de vols captés)
============================================================ */
async function geoPlace(name, cc){
  try{
    const r = await fetchT(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=fr&format=json`, {}, 7000);
    const d = await r.json();
    const res = d.results || [];
    if(!res.length) return null;
    /* si on connaît le pays attendu, on privilégie le résultat qui y correspond
       (évite p.ex. « Shenandoah » qui tombe au Kansas au lieu de la Virginie) */
    if(cc){ const m = res.find(x => (x.country_code || '').toUpperCase() === cc); if(m) return m; }
    return res[0];
  }catch(e){ return null; }
}
/* ---- Hébergements RÉELS via OpenStreetMap (Overpass) ----
   Gratuit, sans clé, sans conditions restrictives — contrairement à Airbnb,
   dont l'API est fermée aux partenaires. On n'a pas les prix, mais on a des
   établissements qui existent vraiment et leur position exacte. L'IA choisit
   alors DANS cette liste au lieu de puiser dans sa mémoire. */
/* Deux serveurs : l'instance publique limite le débit (429) dès qu'on
   enchaîne les requêtes. On bascule sur le miroir avant d'abandonner. */
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter',
                       'https://overpass.kumi.systems/api/interpreter'];
const OSM_STAY_KINDS = 'hotel|guest_house|hostel|apartment|chalet|motel';
const OSM_STAY_FR = { hotel:'hôtel', guest_house:'chambre d’hôtes', hostel:'auberge',
                      apartment:'appartement', chalet:'chalet', motel:'motel' };
async function osmStays(lat, lon, radiusM = 3500){
  /* v2 : les relevés d'avant ne portaient pas de coordonnées, donc la carte ne
     pouvait pas placer l'hôtel. Changer la clé force un relevé neuf. */
  const ck = `osm_stay2_${lat.toFixed(3)}_${lon.toFixed(3)}_${radiusM}`;
  if(state.cache[ck]) return state.cache[ck];
  /* ce chemin touche RÉELLEMENT le réseau : c'est ici, et seulement ici,
     qu'on renonce en connexion dégradée. Le reste de loadHotels continue. */
  if(netSlow()) return [];
  const q = `[out:json][timeout:20];nwr(around:${radiusM},${lat},${lon})`
    + `[tourism~"^(${OSM_STAY_KINDS})$"][name];out center 60;`;
  let d = null;
  for(const url of OVERPASS_URLS){
    try{
      const r = await fetchT(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
      }, netTimeout(12000));
      /* 429 = quota, pas panne réseau : on essaie le miroir SANS compter
         d'échec réseau, sinon netSlow() basculerait et couperait le prix
         des vols alors que la connexion va très bien. */
      if(r.status === 429 || r.status >= 500) continue;
      if(!r.ok) return [];
      d = await r.json();
      break;
    }catch(e){ _netFails++; }
  }
  if(!d) return [];
  try{
    const ref = { latitude: lat, longitude: lon };
    const rows = (d.elements || []).map(e => {
      const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon;
      if(la == null || lo == null || !e.tags?.name) return null;
      return {
        nom: String(e.tags.name).slice(0, 80),
        type: OSM_STAY_FR[e.tags.tourism] || e.tags.tourism,
        etoiles: e.tags.stars ? +e.tags.stars : null,
        /* on GARDE la position : c'est elle qui permet de poser l'hôtel sur la carte.
           Sans ça on refaisait un géocodage approximatif alors qu'Overpass l'a déjà donnée. */
        lat: +la.toFixed(5), lon: +lo.toFixed(5),
        km: +havKm(ref, { latitude: la, longitude: lo }).toFixed(2)
      };
    }).filter(Boolean)
      .sort((a, b) => a.km - b.km)
      .slice(0, 22);
    state.cache[ck] = rows; save();
    return rows;
  }catch(e){ return []; }
}
/* met la liste OSM en forme pour le prompt (vide = on n'ajoute rien) */
function osmStayCtx(rows){
  if(!rows || !rows.length) return '';
  const l = rows.map(h => `- ${h.nom} (${h.type}${h.etoiles ? `, ${h.etoiles}★` : ''}, à ${h.km} km du centre du quartier)`).join('\n');
  return `\nHÉBERGEMENTS RÉELS relevés sur OpenStreetMap autour du quartier visé (données vérifiées, pas d'invention) :\n${l}\n`
    + `Choisis EN PRIORITÉ dans cette liste. Tu ne peux proposer un établissement absent de la liste que si aucun ne convient au budget ou au type demandé — dans ce cas il doit être tout aussi réel et vérifiable.\n`;
}

/* ---- Restaurants RÉELS via OpenStreetMap ----
   Même principe que les hébergements : l'IA choisira DANS cette liste au lieu
   d'inventer des adresses qui n'existent pas (ou plus). */
const OSM_FOOD_FR = { restaurant:'restaurant', cafe:'café', fast_food:'sur le pouce',
                      bistro:'bistrot', pub:'pub', bar:'bar' };
/* gamme de prix quand OSM la connaît (rarement renseignée, mais précieuse) */
function osmPriceLabel(t){
  const p = t.price_range || t['price:range'] || t.price || '';
  if(/^\$+$|^€+$/.test(p)) return p.length <= 1 ? 'économique' : (p.length === 2 ? 'moyen' : 'élevé');
  if(/cheap|budget|low/i.test(p)) return 'économique';
  if(/moderate|mid/i.test(p)) return 'moyen';
  if(/expensive|high/i.test(p)) return 'élevé';
  return '';
}
async function osmFood(lat, lon, radiusM = 1800){
  const ck = `osm_food2_${lat.toFixed(3)}_${lon.toFixed(3)}_${radiusM}`;   /* v2 : avec coordonnées */
  if(state.cache[ck]) return state.cache[ck];
  if(netSlow()) return [];      /* seul chemin réseau : on renonce si ça rame */
  const q = `[out:json][timeout:20];nwr(around:${radiusM},${lat},${lon})`
    + `[amenity~"^(restaurant|cafe|bistro)$"][name];out center 80;`;
  let d = null;
  for(const url of OVERPASS_URLS){
    try{
      const r = await fetchT(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
      }, netTimeout(12000));
      if(r.status === 429 || r.status >= 500) continue;   /* quota : miroir, sans compter d'échec réseau */
      if(!r.ok) return [];
      d = await r.json();
      break;
    }catch(e){ _netFails++; }
  }
  if(!d) return [];
  try{
    const ref = { latitude: lat, longitude: lon };
    const rows = (d.elements || []).map(e => {
      const t = e.tags || {};
      const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon;
      if(la == null || lo == null || !t.name) return null;
      return {
        nom: String(t.name).slice(0, 80),
        type: OSM_FOOD_FR[t.amenity] || t.amenity,
        cuisine: t.cuisine ? String(t.cuisine).split(/[;,]/)[0].replace(/_/g, ' ').slice(0, 30) : '',
        gamme: osmPriceLabel(t),
        vege: t['diet:vegetarian'] === 'yes' || t['diet:vegan'] === 'yes',
        lat: +la.toFixed(5), lon: +lo.toFixed(5),      /* gardées pour la carte */
        km: +havKm(ref, { latitude: la, longitude: lo }).toFixed(2)
      };
    }).filter(Boolean)
      .sort((a, b) => a.km - b.km)
      .slice(0, 40);
    state.cache[ck] = rows; save();
    return rows;
  }catch(e){ return []; }
}
/* Liste réelle mise en forme pour le prompt (vide = on n'ajoute rien) */
function osmFoodCtx(rows){
  if(!rows || !rows.length) return '';
  const l = rows.map(r => `- ${r.nom} (${r.type}${r.cuisine ? ', ' + r.cuisine : ''}${r.gamme ? ', gamme ' + r.gamme : ''}${r.vege ? ', option végé' : ''}, à ${r.km} km)`).join('\n');
  return `\nRESTAURANTS RÉELS relevés sur OpenStreetMap autour du quartier (données vérifiées) :\n${l}\n`
    + `Tu dois choisir EXCLUSIVEMENT dans cette liste : n'invente AUCUN nom. Recopie le nom exactement.\n`;
}

/* --- Du nom d'un lieu à sa position ---------------------------------------
   Les noms viennent de l'IA : accents, articles et casse varient. On compare
   sur une forme réduite plutôt que caractère par caractère. */
function normPlace(s){
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^(le |la |les |l'|the |il |la |el )/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
/* Retrouve un lieu dans le relevé OSM : égalité d'abord, puis inclusion —
   « Colisée » doit matcher « Colisée (Amphithéâtre Flavien) ». */
function matchSight(nom, rows){
  const n = normPlace(nom);
  if(n.length < 3) return null;
  let m = rows.find(r => normPlace(r.nom) === n);
  if(m) return m;
  m = rows.find(r => { const x = normPlace(r.nom); return x.length >= 4 && (x.includes(n) || n.includes(x)); });
  return m || null;
}

/* Repli quand le relevé OSM ne reconnaît pas un nom — typiquement un voyage
   d'avant l'ancrage, où l'IA avait écrit « Colisée » là où OpenStreetMap dit
   « Colosseo ». Wikipédia connaît les deux et donne les coordonnées.
   Gratuit, sans clé, et fr.wikipedia.org est déjà autorisé par la CSP. */
/* Résout une liste de lieux d'un coup : « Colisée » → 41.8905, 12.4926.
   UNE seule requête pour toute la liste — l'API accepte 50 titres à la fois.
   La version en série faisait une requête par lieu et mettait 20 secondes ;
   celle-ci répond en une. */
async function wikiPlaces(noms, ville, ici){
  const res = new Map();
  /* deux pistes par lieu : le nom brut, et le nom précisé par la ville.
     Sans la seconde, « Panthéon » tombe sur une page d'homonymie et
     « Place d'Espagne » ne mène nulle part. */
  const parTitre = new Map();
  const titres = [];
  for(const n of noms){
    const b = cleanPlace(n);
    if(!b) continue;
    for(const t of [b, `${b} (${ville})`]){
      const k = normPlace(t);
      if(parTitre.has(k)) continue;
      parTitre.set(k, n);
      titres.push(t);
    }
  }
  if(!titres.length) return res;
  /* par paquets de 40 : la limite de l'API est 50 */
  for(let i = 0; i < titres.length && i < 120; i += 40){
    const lot = titres.slice(i, i + 40);
    const cs = await wikiCoords(lot);
    if(!cs) continue;
    for(const [titre, ll] of cs){
      const nom = parTitre.get(normPlace(titre));
      if(!nom) continue;
      const km = havKm(ici, { latitude: ll[0], longitude: ll[1] });
      /* garde-fou indispensable : sans lui, « Panthéon » pour un voyage à Rome
         renverrait tranquillement celui de Paris. */
      if(km > 80) continue;
      const dejaKm = res.has(nom)
        ? havKm(ici, { latitude: res.get(nom)[0], longitude: res.get(nom)[1] })
        : Infinity;
      if(km < dejaKm) res.set(nom, ll);
    }
  }
  return res;
}

async function wikiCoords(titres){
  /* Wikipédia accepte jusqu'à 50 titres d'un coup : une seule requête suffit
     pour tester « Panthéon » ET « Panthéon (Rome) ». Sans le second, les lieux
     dont le nom est ambigu tombent sur une page d'homonymie, sans coordonnées
     — ou pire, sur l'homonyme parisien. */
  const l = [...new Set((titres || []).filter(Boolean))];
  if(!l.length) return null;
  try{
    const u = `https://fr.wikipedia.org/w/api.php?action=query&prop=coordinates`
      + `&titles=${encodeURIComponent(l.join('|'))}&format=json&origin=*&redirects=1`;
    const r = await fetchT(u, {}, 9000);
    if(!r.ok) return null;
    const d = await r.json();
    /* Wikipédia renomme et redirige : « Place d'Espagne (Rome) » revient sous
       « Piazza di Spagna ». On refait le chemin à l'envers pour retrouver le
       titre qu'on avait demandé, sinon on ne sait plus à quel lieu rattacher
       les coordonnées. */
    const origine = new Map();
    for(const x of (d?.query?.normalized || [])) origine.set(x.to, x.from);
    for(const x of (d?.query?.redirects || [])) origine.set(x.to, origine.get(x.from) ?? x.from);
    const out = new Map();
    for(const k in (d?.query?.pages || {})){
      const p = d.query.pages[k];
      const c = p?.coordinates?.[0];
      if(!c || !isFinite(c.lat) || !isFinite(c.lon)) continue;
      out.set(origine.get(p.title) ?? p.title, [+c.lat, +c.lon]);
    }
    return out.size ? out : null;
  }catch(e){}
  return null;
}

/* Remplit plan._geo : { "nom du lieu": [lat, lon] }.
   Stocké SUR le plan (et non dans le cache OSM) pour trois raisons : ça survit
   à la synchro (slimTrip garde le plan), ça survit hors-ligne, et ça reste
   minuscule — deux nombres par lieu, pas d'image. */
async function ensurePlanGeo(force = false){
  const d = state.cache.plan, t = state.trip;
  if(!d || !t) return null;
  const attendus = (d.programme || []).flatMap(j => (j.lieux || []).filter(Boolean));
  d._geo = d._geo || {};
  const manquants = attendus.filter(l => !d._geo[l]);
  if(!manquants.length && !force) return d._geo;
  const g = await geocode();
  if(!g) return d._geo;
  const ici = { latitude: +g.latitude, longitude: +g.longitude };
  const trouve = await wikiPlaces(manquants, t.nom, ici);
  for(const [nom, ll] of trouve) d._geo[nom] = ll;
  /* l'hôtel : sa position vient du relevé des hébergements, déjà en cache */
  const hn = d.logement?.nom || state.cache.hotels?.hotels?.[0]?.nom;
  if(hn && !d._geoHotel){
    const stays = Object.keys(state.cache).filter(k => k.startsWith('osm_stay2_'))
      .flatMap(k => state.cache[k] || []);
    const m = stays.length ? matchSight(hn, stays) : null;
    if(m) d._geoHotel = { nom: m.nom, lat: m.lat, lon: m.lon };
  }
  save();
  return d._geo;
}

/* Code pays ISO à partir du nom FR du pays (pour biaiser le géocodage).

   ⚠️ La recherche est VOLONTAIREMENT tolérante, et pas par confort : le nom
   exact d'un pays n'est pas une constante. La bibliothèque du système (ICU) ne
   donne pas tout à fait les mêmes libellés d'un navigateur à l'autre ni d'une
   version à l'autre — « Hong Kong » ici, « Hong Kong (R.A.S. chinoise) » là.
   Une comparaison stricte échouait donc sur certains pays selon l'appareil.
   Et de toute façon un voyageur tape à la main : accents oubliés, apostrophe
   droite, majuscules, espaces en trop.

   Quatre tentatives, de la plus fidèle à la plus permissive. */
function ccFor(pays){
  const brut = String(pays || '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  if(!brut) return '';
  if(COUNTRY_CC[brut]) return COUNTRY_CC[brut];
  /* 1. sans la précision entre parenthèses : « hong kong (r.a.s. chinoise) » */
  const sansParen = brut.replace(/\s*\([^)]*\)/g, '').trim();
  if(sansParen && COUNTRY_CC[sansParen]) return COUNTRY_CC[sansParen];
  /* 2. apostrophes et traits d'union unifiés */
  const plat = s => s.replace(/[’‘`]/g, "'").replace(/[‑–—]/g, '-');
  if(COUNTRY_CC[plat(brut)]) return COUNTRY_CC[plat(brut)];
  if(COUNTRY_CC[plat(sansParen)]) return COUNTRY_CC[plat(sansParen)];
  /* 3. LETTRES SEULES : ni accent, ni espace, ni tiret, ni apostrophe.
     « cote d ivoire », « nouvelle zelande », « Côte-d'Ivoire » tombent alors
     tous sur la même clé. C'est la tentative de dernier recours, et c'est elle
     qui rattrape la majorité des saisies réelles.
     L'index est construit UNE fois, à la première demande — pas au chargement :
     inutile de payer 278 normalisations si personne ne cherche de pays. */
  const nu = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '')  /* accents */
                   .replace(/['\-\s.]/g, '');                          /* liaisons */
  if(!ccFor._nu){
    ccFor._nu = {};
    for(const k in COUNTRY_CC){
      const c = nu(plat(k));
      if(!(c in ccFor._nu)) ccFor._nu[c] = COUNTRY_CC[k];
    }
  }
  return ccFor._nu[nu(plat(brut))] || ccFor._nu[nu(plat(sansParen))] || '';
}
/* nettoie un libellé de lieu pour le géocodeur : « Washington D.C. (Dulles) » → « Washington » */
function cleanPlace(s){
  return String(s || '').split(/[(,/]/)[0].replace(/\b[A-Z]\.?[A-Z]\.?\b/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}
function havKm(a, b){
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLa = rad(b.latitude - a.latitude), dLo = rad(b.longitude - a.longitude);
  const h = Math.sin(dLa/2)**2 + Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dLo/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const _avg = arr => Math.round(arr.reduce((x,y)=>x+y,0) / arr.length);

/* ⚠️ LISTE COMPLÈTE — tous les pays et territoires d'ISO 3166-1, plus les alias.
   Elle n'en contenait que 65, presque tous européens : quelqu'un qui tapait
   « Pérou », « Kenya » ou « Ouzbékistan » n'obtenait ni drapeau ni code pays,
   donc aucun vol trouvé pour cette étape.

   GÉNÉRÉE depuis Intl.DisplayNames('fr') — noms et codes viennent de la
   bibliothèque du système, pas d'une saisie à la main.

   ⚠️ Trois pièges rencontrés en la construisant, à ne pas réintroduire :
   · Intl connaît les codes RETIRÉS d'ISO. Sans le filtre, « Viêt Nam »
     tombait sur VD (Nord-Vietnam), « Vanuatu » sur NH (Nouvelles-Hébrides) et
     « Zimbabwe » sur RH (Rhodésie) — des codes qu'aucune API ne reconnaît.
   · le filtrage doit porter sur le CODE, jamais sur le nom : un filtre par
     sous-chaîne faisait disparaître la Papouasie-Nouvelle-Guinée, parce que
     « Papouasie » contient « asie ».
   · les libellés d'ICU VARIENT d'un navigateur à l'autre (« Hong Kong » ici,
     « Hong Kong (R.A.S. chinoise) » là). D'où les alias courts ci-dessous ET
     la recherche tolérante de ccFor().

   Clés en guillemets doubles : plusieurs noms contiennent une apostrophe. */
const COUNTRY_CC = {
  "afghanistan":"AF","afrique du sud":"ZA","albanie":"AL","algérie":"DZ","allemagne":"DE",
  "andorre":"AD","angleterre":"GB","angola":"AO","anguilla":"AI","antarctique":"AQ",
  "antigua-et-barbuda":"AG","arabie saoudite":"SA","argentine":"AR","arménie":"AM","aruba":"AW",
  "australie":"AU","autriche":"AT","azerbaïdjan":"AZ","bahamas":"BS","bahreïn":"BH",
  "bangladesh":"BD","barbade":"BB","belgique":"BE","belize":"BZ","bermudes":"BM",
  "bhoutan":"BT","birmanie":"MM","biélorussie":"BY","bolivie":"BO","bosnie":"BA",
  "bosnie-herzégovine":"BA","botswana":"BW","brunei":"BN","brésil":"BR","bulgarie":"BG",
  "burkina faso":"BF","burundi":"BI","bénin":"BJ","cambodge":"KH","cameroun":"CM",
  "canada":"CA","cap-vert":"CV","chili":"CL","chine":"CN","chypre":"CY",
  "colombie":"CO","comores":"KM","congo-brazzaville":"CG","congo-kinshasa":"CD","coree du sud":"KR",
  "corée du nord":"KP","corée du sud":"KR","costa rica":"CR","croatie":"HR","cuba":"CU",
  "curaçao":"CW","côte d'ivoire":"CI","côte d’ivoire":"CI","danemark":"DK","djibouti":"DJ",
  "dominique":"DM","ecosse":"GB","emirats arabes unis":"AE","espagne":"ES","estonie":"EE",
  "eswatini":"SZ","etats-unis":"US","fidji":"FJ","finlande":"FI","france":"FR",
  "gabon":"GA","gambie":"GM","ghana":"GH","gibraltar":"GI","grenade":"GD",
  "groenland":"GL","grèce":"GR","guadeloupe":"GP","guam":"GU","guatemala":"GT",
  "guernesey":"GG","guinée":"GN","guinée équatoriale":"GQ","guinée-bissau":"GW","guyana":"GY",
  "guyane française":"GF","géorgie":"GE","géorgie du sud-et-les îles sandwich du sud":"GS","haïti":"HT","hollande":"NL",
  "honduras":"HN","hong kong":"HK","hongrie":"HU","ile maurice":"MU","inde":"IN",
  "indonésie":"ID","irak":"IQ","iran":"IR","irlande":"IE","islande":"IS",
  "israël":"IL","italie":"IT","jamaïque":"JM","japon":"JP","jersey":"JE",
  "jordanie":"JO","kazakhstan":"KZ","kenya":"KE","kirghizstan":"KG","kiribati":"KI",
  "kosovo":"XK","koweït":"KW","la réunion":"RE","laos":"LA","lesotho":"LS",
  "lettonie":"LV","liban":"LB","liberia":"LR","libye":"LY","liechtenstein":"LI",
  "lituanie":"LT","luxembourg":"LU","macao":"MO","macau":"MO","macedoine du nord":"MK",
  "macédoine du nord":"MK","madagascar":"MG","malaisie":"MY","malawi":"MW","maldives":"MV",
  "mali":"ML","malte":"MT","maroc":"MA","martinique":"MQ","maurice":"MU",
  "mauritanie":"MR","mayotte":"YT","mexique":"MX","micronésie":"FM","moldavie":"MD",
  "monaco":"MC","mongolie":"MN","montserrat":"MS","monténégro":"ME","mozambique":"MZ",
  "myanmar (birmanie)":"MM","namibie":"NA","nauru":"NR","nicaragua":"NI","niger":"NE",
  "nigeria":"NG","niue":"NU","norvège":"NO","nouvelle-calédonie":"NC","nouvelle-zélande":"NZ",
  "népal":"NP","oman":"OM","ouganda":"UG","ouzbékistan":"UZ","pakistan":"PK",
  "palaos":"PW","palestine":"PS","panama":"PA","papouasie":"PG","papouasie-nouvelle-guinée":"PG",
  "paraguay":"PY","pays de galles":"GB","pays-bas":"NL","pays-bas caribéens":"BQ","philippines":"PH",
  "pologne":"PL","polynésie française":"PF","porto rico":"PR","portugal":"PT","pérou":"PE",
  "qatar":"QA","r.a.s. chinoise de hong kong":"HK","r.a.s. chinoise de macao":"MO","republique tcheque":"CZ","roumanie":"RO",
  "royaume-uni":"GB","russie":"RU","rwanda":"RW","république centrafricaine":"CF","république dominicaine":"DO",
  "république tchèque":"CZ","sahara occidental":"EH","saint-barthélemy":"BL","saint-christophe-et-niévès":"KN","saint-marin":"SM",
  "saint-martin":"MF","saint-martin (partie néerlandaise)":"SX","saint-pierre-et-miquelon":"PM","saint-vincent-et-les grenadines":"VC","sainte-hélène":"SH",
  "sainte-lucie":"LC","salvador":"SV","samoa":"WS","samoa américaines":"AS","sao tomé-et-principe":"ST",
  "serbie":"RS","sercq":"CQ","seychelles":"SC","sierra leone":"SL","singapour":"SG",
  "slovaquie":"SK","slovénie":"SI","somalie":"SO","soudan":"SD","soudan du sud":"SS",
  "sri lanka":"LK","suisse":"CH","suriname":"SR","suède":"SE","svalbard et jan mayen":"SJ",
  "syrie":"SY","sénégal":"SN","tadjikistan":"TJ","tahiti":"PF","taiwan":"TW",
  "tanzanie":"TZ","taïwan":"TW","tchad":"TD","tchequie":"CZ","tchéquie":"CZ",
  "terres australes françaises":"TF","territoire britannique de l'océan indien":"IO","territoire britannique de l’océan indien":"IO","territoires palestiniens":"PS","thaïlande":"TH",
  "timor oriental":"TL","togo":"TG","tokelau":"TK","tonga":"TO","trinité-et-tobago":"TT",
  "tunisie":"TN","turkménistan":"TM","turquie":"TR","tuvalu":"TV","ukraine":"UA",
  "uruguay":"UY","usa":"US","vanuatu":"VU","venezuela":"VE","viet nam":"VN",
  "vietnam":"VN","viêt nam":"VN","wallis-et-futuna":"WF","yémen":"YE","zambie":"ZM",
  "zimbabwe":"ZW","écosse":"GB","égypte":"EG","émirats arabes unis":"AE","équateur":"EC",
  "érythrée":"ER","état de la cité du vatican":"VA","états-unis":"US","éthiopie":"ET","île bouvet":"BV",
  "île christmas":"CX","île de man":"IM","île norfolk":"NF","îles caïmans":"KY","îles cocos":"CC",
  "îles cook":"CK","îles féroé":"FO","îles heard-et-macdonald":"HM","îles malouines":"FK","îles mariannes du nord":"MP",
  "îles marshall":"MH","îles mineures éloignées des états-unis":"UM","îles pitcairn":"PN","îles salomon":"SB","îles turques-et-caïques":"TC",
  "îles vierges britanniques":"VG","îles vierges des états-unis":"VI","îles åland":"AX"
};

/* ============================================================
   CHOIX DES PAYS DE L'ITINÉRAIRE
   ------------------------------------------------------------
   Quand le voyageur coche « traverser plusieurs pays », il doit pouvoir dire
   LESQUELS. La liste d'autocomplétion est construite depuis COUNTRY_CC, qui
   existait déjà pour biaiser le géocodage — pas de deuxième liste à tenir à
   jour. Le champ reste libre : un pays absent du dictionnaire est accepté.
   L'ORDRE est laissé à l'IA : c'est elle qui sait enchaîner sans zigzag.
============================================================ */
const PAYS_MAX = 6;              /* au-delà, on passe son voyage en transport */
/* joli nom : « pays-bas » → « Pays-Bas », « corée du sud » → « Corée du Sud » */
const paysJoli = s => String(s || '').trim().toLowerCase()
  .replace(/(^|[\s-])([a-zà-ÿ])/g, (m, sep, c) => sep + c.toUpperCase())
  .replace(/\bDu\b/g, 'du').replace(/\bDe\b/g, 'de').replace(/\bLa\b/g, 'la');
/* Une entrée par PAYS et non par alias : COUNTRY_CC contient « angleterre »
   et « royaume-uni » pour le même code, inutile de proposer les deux. */
const PAYS_LISTE = (() => {
  const vus = new Set(), out = [];
  for(const nom of Object.keys(COUNTRY_CC)){
    const cc = COUNTRY_CC[nom];
    if(vus.has(cc)) continue;
    vus.add(cc);
    out.push(paysJoli(nom));
  }
  return out.sort((a, b) => a.localeCompare(b, 'fr'));
})();

let _paysChoisis = [];
function paysRender(){
  const box = $('#paysTags');
  if(box){
    box.innerHTML = _paysChoisis.map((p, i) =>
      `<span class="pays-tag"><span class="num">${i + 1}</span>${esc(p)}` +
      `<button type="button" data-paysdel="${i}" aria-label="${isEN() ? 'Remove' : 'Retirer'} ${esc(p)}" title="${isEN() ? 'Remove' : 'Retirer'}">✕</button></span>`
    ).join('');
  }
  const h = $('#paysHint');
  if(h){
    h.textContent = !_paysChoisis.length
      ? (isEN() ? 'Leave empty and Acolyte picks the countries for you.' : 'Laisse vide et Acolyte choisit les pays pour toi.')
      : _paysChoisis.length === 1
        ? (isEN() ? 'Add at least a second country, or Acolyte will pick the next ones.' : 'Ajoute au moins un deuxième pays, sinon Acolyte choisira les suivants.')
        : (isEN() ? `${_paysChoisis.length} countries — Acolyte works out the best order.` : `${_paysChoisis.length} pays — Acolyte trouve le meilleur ordre.`);
  }
}
function paysAdd(brut){
  const nom = paysJoli(brut);
  if(!nom || nom.length < 3) return;
  if(_paysChoisis.length >= PAYS_MAX){ toast(isEN() ? `${PAYS_MAX} countries maximum` : `${PAYS_MAX} pays au maximum`); return; }
  /* doublon : on compare sans accents ni casse, « Grece » = « Grèce » */
  if(_paysChoisis.some(p => normPlace(p) === normPlace(nom))){ toast(isEN() ? 'Already in the list' : 'Déjà dans la liste'); return; }
  _paysChoisis.push(nom);
  paysRender();
  const inp = $('#fPaysAdd');
  if(inp){ inp.value = ''; inp.focus(); }
}
function paysBoxSync(){
  const on = !!$('#fMulti')?.checked;
  $('#paysBox')?.classList.toggle('hidden', !on);
  if(on) paysRender();
}
{
  const dl = $('#paysList');
  if(dl) dl.innerHTML = PAYS_LISTE.map(p => `<option value="${esc(p)}"></option>`).join('');
  const cb = $('#fMulti');
  if(cb) cb.addEventListener('change', paysBoxSync);
  const btn = $('#btnPaysAdd');
  if(btn) btn.onclick = () => paysAdd($('#fPaysAdd')?.value);
  const inp = $('#fPaysAdd');
  if(inp){
    /* Entrée ajoute le pays — et ne valide SURTOUT pas le formulaire */
    inp.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); paysAdd(inp.value); }
    });
    /* choisir dans la liste d'autocomplétion ajoute directement */
    inp.addEventListener('change', () => {
      if(PAYS_LISTE.some(p => normPlace(p) === normPlace(inp.value))) paysAdd(inp.value);
    });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-paysdel]');
    if(!b) return;
    _paysChoisis.splice(+b.dataset.paysdel, 1);
    paysRender();
  });
}

async function realData(){
  if(SET?.reels === false) return '';   /* le voyageur a désactivé les données réelles */
  const t = state.trip; if(!t) return '';
  const key = t.nom + ',' + t.pays;
  let R = state.cache._real;
  if(!R || R.key !== key){
    R = { key };
    try{
      const [g1, g2] = await Promise.all([ geoPlace(cleanPlace(state.prefs?.from || 'Paris')), geocode() ]);
      if(g1 && g2) R.dist = Math.round(havKm(g1, g2));
      if(g2){
        const depDate = state.prefs?.depart ? new Date(state.prefs.depart) : null;
        const farAway = depDate && (depDate - Date.now()) > 16 * 86400000;
        if(farAway){
          /* départ lointain → climat réel du même mois l'an dernier (archive Open-Meteo) */
          const y = depDate.getFullYear() - 1, m = String(depDate.getMonth() + 1).padStart(2, '0');
          const last = new Date(y, depDate.getMonth() + 1, 0).getDate();
          const wa = await fetchT(`https://archive-api.open-meteo.com/v1/archive?latitude=${g2.latitude}&longitude=${g2.longitude}&start_date=${y}-${m}-01&end_date=${y}-${m}-${last}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`, {}, 7000).then(r=>r.json()).catch(()=>null);
          if(wa?.daily?.temperature_2m_max?.length){
            const rain = Math.round((wa.daily.precipitation_sum||[]).reduce((a,b)=>a+(b||0),0));
            R.meteo = `climat typique du mois du voyage (relevés réels ${m}/${y}) : ${_avg(wa.daily.temperature_2m_min)}°C à ${_avg(wa.daily.temperature_2m_max)}°C, ${rain} mm de pluie sur le mois`;
            R.mNums = { min:_avg(wa.daily.temperature_2m_min), max:_avg(wa.daily.temperature_2m_max), rain: Math.min(90, Math.round(rain/3)) };
          }
        }
        if(!R.meteo){
          const w = await fetchT(`https://api.open-meteo.com/v1/forecast?latitude=${g2.latitude}&longitude=${g2.longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_mean&forecast_days=7&timezone=auto`, {}, 7000).then(r=>r.json());
          if(w.daily?.temperature_2m_max?.length){
            R.meteo = `${_avg(w.daily.temperature_2m_min)}°C à ${_avg(w.daily.temperature_2m_max)}°C, probabilité de pluie ${_avg(w.daily.precipitation_probability_mean||[0])}% (relevé réel, 7 prochains jours)`;
            R.mNums = { min:_avg(w.daily.temperature_2m_min), max:_avg(w.daily.temperature_2m_max), rain:_avg(w.daily.precipitation_probability_mean||[0]) };
          }
        }
      }
    }catch(e){}
    const _wikiP = fetch(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.nom)}`)
      .then(r => r.ok ? r.json() : null).then(wk => { if(wk?.extract) R.wiki = wk.extract.slice(0, 400); }).catch(()=>{});
    /* Wikivoyage : conseils orientés voyageur (quartiers, transports, arnaques) */
    const _wvP = fetch(`https://fr.wikivoyage.org/api/rest_v1/page/summary/${encodeURIComponent(t.nom)}`)
      .then(r => r.ok ? r.json() : null).then(wv => { if(wv?.extract) R.wv = wv.extract.slice(0, 350); }).catch(()=>{});
    /* Jours fériés officiels du pays pendant le séjour (Nager.Date, sans clé) */
    const _holP = (async () => { try{
      const dts = stayDates();
      if(!dts) return;
      const cc = COUNTRY_CC[String(t.pays||'').toLowerCase()];
      if(!cc) return;
      const yr = dts.in.slice(0, 4);
      const hs = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${yr}/${cc}`).then(r => r.ok ? r.json() : null);
      if(!Array.isArray(hs)) return;
      const inRange = hs.filter(h => h.date >= dts.in && h.date <= dts.out)
        .map(h => `${h.date} (${h.localName})`);
      if(inRange.length) R.feries = inRange.join(', ');
    }catch(e){} })();
    /* horaires de train réels (Deutsche Bahn) — seulement si le rail est plausible */
    const _trainP = (async () => { try{
      if(!R.dist || R.dist < 1600){
        const tOut = new Promise(res => setTimeout(() => res(null), 8000));
        const sPair = Promise.all([ dbStation(state.prefs?.from || 'Paris'), dbStation(t.nom) ]).catch(() => null);
        const st = await Promise.race([sPair, tOut]);
        if(st && st[0] && st[1]){
          const rj = await Promise.race([
            fetch(`${DB_API}/journeys?from=${st[0].id}&to=${st[1].id}&results=3&tickets=true&language=fr`),
            tOut
          ]);
          if(rj && rj.ok){
            const dj = await rj.json();
            const js = (dj.journeys||[]).filter(j => j.legs?.length);
            if(js.length){
              const best = js[0];
              const dep = new Date(best.legs[0].departure), arr = new Date(best.legs[best.legs.length-1].arrival);
              const mins = Math.round((arr - dep) / 60000);
              const chg = Math.max(0, best.legs.filter(l => !l.walking).length - 1);
              const prices = js.map(j => j.price?.amount).filter(Boolean);
              if(mins > 0) R.train = `${Math.floor(mins/60)}h${String(mins%60).padStart(2,'0')} de trajet, ${chg} correspondance(s)${prices.length ? ', à partir de ' + Math.min(...prices).toFixed(0) + ' €' : ''} (horaires réels Deutsche Bahn)`;
            }
          }
        }
      }
    }catch(e){} })();
    /* taux de change réel (Frankfurter, BCE) */
    const _fxP = (async () => { try{
      /* La monnaie DU VOYAGEUR sert de base, plus l'euro par défaut. Le champ
         existait dans le passeport et n'était relu que pour re-remplir son
         propre formulaire : quelqu'un qui compte en francs suisses voyait tout
         converti depuis une monnaie qui n'est pas la sienne.
         ⚠️ La base est passée dans une URL : on n'accepte que trois lettres,
         sinon une saisie inattendue partirait telle quelle dans la requête. */
      const pp = (typeof ppLire === 'function' ? ppLire() : {}) || {};
      const base = /^[A-Z]{3}$/.test(String(pp.devise || '').toUpperCase())
                 ? String(pp.devise).toUpperCase() : 'EUR';
      const sym = base === 'EUR' ? '€' : base;
      const code = ((t.monnaie||'').toUpperCase().match(/\b[A-Z]{3}\b/)||[])[0];
      if(code && code !== base){
        const rf = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${code}`);
        if(rf.ok){
          const df = await rf.json();
          if(df.rates?.[code]) R.fx = `1 ${sym} = ${df.rates[code].toFixed(2)} ${code} (taux réel du jour, BCE)`;
        }
      }
    }catch(e){} })();
    await Promise.allSettled([_wikiP, _wvP, _holP, _trainP, _fxP]);
    state.cache._real = R; save();
  }
  const L = [];
  if(R.dist) L.push(`Distance ${state.prefs?.from || 'départ'} → ${t.nom} : environ ${R.dist} km à vol d'oiseau (calcul réel)`);
  if(R.meteo) L.push(`Météo réelle à ${t.nom} en ce moment : ${R.meteo}`);
  if(state.cache.realPrice) L.push(`Prix de vol réel constaté par nos moteurs : ${state.cache.realPrice}`);
  if(R.train) L.push(`Trajet en TRAIN réel ${state.prefs?.from || 'départ'} → ${t.nom} : ${R.train}`);
  if(R.fx) L.push(`Taux de change réel : ${R.fx} — utilise CE taux pour toute conversion de budget`);
  if(R.wiki) L.push(`Contexte factuel (Wikipédia) : ${R.wiki}`);
  if(R.wv) L.push(`Infos voyageur (Wikivoyage) : ${R.wv}`);
  if(R.feries) L.push(`JOURS FÉRIÉS OFFICIELS pendant le séjour : ${R.feries} — beaucoup de commerces/musées ferment ou sont bondés ces jours-là : adapte le programme et préviens dans "conseil_cle"`);
  return L.length ? `\nDONNÉES RÉELLES VÉRIFIÉES — appuie-toi dessus, ne les contredis JAMAIS :\n- ${L.join('\n- ')}\n` : '';
}

/* --- Relecture croisée : Groq vérifie le plan de Gemini, Gemini corrige si besoin --- */
async function reviewPlan(d, basePrompt){
  /* La relecture croisée est un BONUS : sans elle le plan reste valable. On la
     saute pendant une mise au frais plutôt que de retarder le voyage. */
  if(!groqDispo()) return d;
  try{
    const v = await groq(`Tu es un vérificateur impitoyable de plans de voyage. ${ctx()}
PLAN À VÉRIFIER (JSON) : ${JSON.stringify(d).slice(0, 5500)}
Contrôle STRICTEMENT et uniquement ces 10 points :
1. "budget.total" respecte-t-il le budget demandé par personne ?
2. Le nombre d'entrées de "programme" correspond-il à la durée demandée ?
3. Le transport choisi est-il cohérent avec la distance, la POLLUTION (si un mode nettement moins polluant est comparable en temps/prix, le plan doit le justifier) et les limites du voyageur ?
4. COHÉRENCE GÉOGRAPHIQUE : chaque journée regroupe-t-elle des lieux PROCHES les uns des autres ? Signale toute journée qui fait traverser la ville en zigzag (ex : un lieu au nord, puis au sud, puis de nouveau au nord).
5. Les lieux cités existent-ils VRAIMENT dans cette ville, et sont-ils ouverts à la période du voyage (attention aux jours fériés signalés) ?
6. Le programme est-il réaliste en temps (pas 6 musées dans une seule journée), avec un premier et un dernier jour ALLÉGÉS (arrivée/départ) ?
7. Le QUARTIER du logement est-il cohérent avec le point d'arrivée (aéroport/gare) ET les lieux du programme ?
8. Si le voyage est MULTI-BASES ("logement.etapes") : l'ordre des bases est-il géographiquement logique (pas de retour en arrière), chaque base a-t-elle ≥ 2 nuits, la somme des nuits colle-t-elle à la durée, et les trajets entre bases sont-ils comptés dans le budget ?
9. "formalites" — LE POINT LE PLUS GRAVE, une erreur ici fait rater un avion. Le régime de visa annoncé est-il celui d'un voyageur FRANÇAIS pour CE pays ? Une exigence inventée ou un « aucun visa » accordé à tort est une faute rédhibitoire : dans le doute, il faut « à vérifier ». Signale-le.
10. "couts_sur_place" — les prix sont-ils ceux de CETTE ville et dans SA monnaie ? Des prix français recopiés pour Tokyo ou Marrakech sont une faute.
Réponds en JSON : {"ok":true} si tout est cohérent, sinon {"ok":false,"problemes":["max 4 incohérences, courtes et factuelles"]}`, true, 700);
    if(v?.ok !== false || !(v.problemes||[]).length){ d._checked = 'ok'; return d; }
    const d2 = await gemini(basePrompt + `\n\nATTENTION — une relecture indépendante a détecté ces incohérences dans une première version. Corrige-les IMPÉRATIVEMENT :\n- ${v.problemes.join('\n- ')}`, true, 8192, false, 0.4);
    d2._checked = 'fixed';
    return d2;
  }catch(e){ return d; }
}

/* Relecture croisée des PROPOSITIONS (étape 1) : Groq vérifie, Gemini corrige si besoin.
   Réglable via SET.verif ; jamais en mode surprise (on y veut de la liberté). */
async function reviewProps(d, basePrompt){
  if(!groqDispo() || !(d.destinations||[]).length) return d;
  try{
    const v = await groq(`Tu es un vérificateur voyage strict. ${ctx()}
PROPOSITIONS À VÉRIFIER (JSON) : ${JSON.stringify(d.destinations).slice(0, 4500)}
Contrôle UNIQUEMENT :
1. "budget_estime" respecte-t-il le budget/personne demandé ?
2. "meteo_periode" est-elle cohérente avec la saison RÉELLE du voyage (mois indiqué) ?
3. Les villes et quartiers sont-ils RÉELS et vraiment DIFFÉRENTS entre les propositions (pas de doublons déguisés) ?
4. "transport_prix" est-il réaliste depuis le point de départ ?
Réponds en JSON : {"ok":true} si tout est bon, sinon {"ok":false,"problemes":["max 3 incohérences, courtes et factuelles"]}`, true, 650);
    if(v?.ok !== false || !(v.problemes||[]).length) return d;
    const d2 = await gemini(basePrompt + `\n\nATTENTION — une relecture indépendante a détecté ces problèmes dans une première version. Corrige-les IMPÉRATIVEMENT en gardant EXACTEMENT la même structure JSON :\n- ${v.problemes.join('\n- ')}`, true, 8192);
    return d2;
  }catch(e){ return d; }
}

async function loadPlan(force = false){
  const zone = $('#zonePlan');
  /* ⚠️ Le raccourci « plan déjà en cache » passe AVANT la porte, et c'est
     voulu : un voyage déjà généré (ou importé par un lien d'ami) se consulte
     sans compte. On ne demande un compte que pour en FABRIQUER un nouveau. */
  if(state.cache.plan && !force){ renderPlan(state.cache.plan); syncModeFromPlan(state.cache.plan); return; }
  if(!exigeCompte('Crée ton compte pour générer ton programme')) return;
  const t = state.trip;
  if(!t){ zone.innerHTML = errHTML('Choisis d’abord un voyage.'); return; }
  if(_genBusy) return;
  _genBusy = true;
  _retryFns.plan = () => loadPlan(true);
  const p = state.prefs || {};   /* prefs peut être null (voyage rouvert sans préférences) */
  const msgs = ['Acolyte organise ton voyage de A à Z… 🧭', 'Comparaison des transports (prix / durée)…', 'Choix du quartier idéal…', 'Programme jour par jour…',
    ...(SET?.verif !== false ? ['Relecture par une 2ᵉ IA…'] : []), 'Presque prêt…'];
  zone.innerHTML = `<div class="card">${loaderHTML(msgs[0])}</div>` + skelPlan();
  let mi = 0;
  const msgTimer = setInterval(() => { mi++; const m = zone.querySelector('.loader-msg'); if(m) m.textContent = msgs[mi % msgs.length]; }, 2600);
  const answers = (state.planAnswers||[]).join(' · ');
  /* budget de temps : les données réelles ne doivent JAMAIS bloquer le plan
     (réseau lent/coupé → on continue sans elles au bout de 12 s) */
  const realCtx = await Promise.race([ realData(), new Promise(r => setTimeout(() => r(''), 12000)) ]);
  /* Pas d'ancrage Overpass pour les monuments : mesuré à 30-60 s sur les
     instances publiques (elles mettent en file d'attente), c'est trop lent
     pour s'intercaler ici. Un monument ne ferme pas comme un restaurant, le
     risque d'invention est faible — une consigne de NOMMAGE suffit, et c'est
     elle qui permet ensuite de retrouver chaque lieu sur la carte. */
  /* ⚠️ La consigne de nommage n'est pas cosmétique : c'est elle qui rend les
     lieux VÉRIFIABLES. verifiePlanAffiche() cherche ensuite chaque nom dans le
     géocodeur — une description à la place d'un nom (« un joli café près du
     port ») est introuvable par construction, et un lieu introuvable ne peut
     être ni contrôlé, ni placé sur la carte, ni cherché par le voyageur. */
  const sightCtx = `\nNOMMAGE DES LIEUX — important : écris chaque lieu du programme sous son nom d'usage en français, celui qui sert de titre à son article Wikipédia (ex : « Colisée », « Fontaine de Trevi », « Musées du Vatican »). Pas de description à la place du nom, pas de nom inventé.
Respire un grand coup et résous ce problème étape par étape.
AVANT d'inscrire un lieu au programme, vérifie-le en trois temps : (1) situe-le — sais-tu dire dans quel quartier ou à quelle adresse il se trouve, et ses coordonnées approximatives ? (2) confronte — ces coordonnées tombent-elles bien dans ${t.nom} ou sa périphérie immédiate, et non dans une autre ville qui porte un nom voisin ? (3) tranche — si tu ne peux pas faire les deux premiers points avec certitude, N'INSCRIS PAS CE LIEU et prends-en un autre dont tu es sûr. Une journée avec quatre lieux réels vaut infiniment mieux qu'une journée avec six lieux dont un inventé.\n`;
  /* Le transport et le logement ont DÉJÀ été trouvés à l'étape 2 : on les garde et on approfondit */
  const dejaTrouve = (t.transport_conseille || t.logement_quartier)
    ? `\nCHOIX DÉJÀ VALIDÉS À L'ÉTAPE 2 (le voyageur les a acceptés en choisissant ce voyage — GARDE-LES, sauf si les données réelles les contredisent) :
- Transport : ${t.transport_conseille || '?'}${t.transport_prix ? ` (${t.transport_prix})` : ''}${t.transport_duree ? `, ${t.transport_duree}` : ''}
- Logement : ${t.logement_type || '?'} dans le quartier ${t.logement_quartier || '?'}${t.logement_prix ? ` (${t.logement_prix}/nuit)` : ''}
TON TRAVAIL : approfondir (détails pratiques, programme jour par jour, budget précis), PAS tout recommencer.\n`
    : '';
  /* chiffres CO₂ réels injectés dans l'étape transport (aller-retour, par personne) */
  const _dist = state.cache._real?.dist;
  const _A = (p.adults || 1) + (p.kids || 0);
  const co2Ctx = _dist
    ? `CO₂ ESTIMÉ pour ${Math.round(_dist)} km (aller-retour, par personne, calcul réel) : avion ~${Math.round(_dist*2*CO2_G_KM.avion/1000)} kg · train ~${Math.round(_dist*2*CO2_G_KM.train/1000)} kg · voiture ~${Math.round(_dist*2*CO2_G_KM.voiture/Math.max(1,_A)/1000)} kg (partagée entre ${_A} voyageur(s)).`
    : '';
  const prompt = `Tu es Acolyte, organisateur de voyage expert. ${ctx()}
${realCtx}${sightCtx}${co2Ctx ? co2Ctx + '\n' : ''}${dejaTrouve}
Destination validée : ${t.nom} (${t.pays})${t.ville_aeroport ? ` · point d'arrivée probable : ${t.ville_aeroport}${t.iata ? ' (' + t.iata + ')' : ''}` : ''}.
RÈGLE ABSOLUE : ne cite que des quartiers, lieux et établissements RÉELS et vérifiables. En cas de doute, omets plutôt qu'inventer.
Si les données réelles incluent un trajet en train ou un taux de change, appuie ton choix de transport et tes conversions de budget DESSUS.
${answers ? 'RÉPONSES du voyageur à tes questions précédentes (à intégrer au plan) : ' + answers : ''}

MISSION : organise TOUT le voyage en suivant STRICTEMENT cet ordre d'analyse, chaque étape s'appuyant sur la précédente :
ÉTAPE 1 — LE LIEU EXACT : si la destination est un pays ou une zone large, choisis LA ville/zone précise où aller (et dis pourquoi). Sinon, confirme la ville et identifie le point d'arrivée concret (aéroport, gare).
CAS MULTI-PAYS / ITINÉRANT : si le voyageur a imposé une forme d'itinéraire (voir CONTEXTE VOYAGEUR ci-dessus), RESPECTE-LA — elle prime sur ton jugement. Sinon, si le voyage couvre PLUSIEURS pays ou villes (ex : « Italie puis Slovénie », roadtrip), découpe-le en 2-3 BASES maximum (villes-étapes dans un ordre géographique logique, JAMAIS de retour en arrière, minimum 2 nuits par base). Remplis alors "logement.etapes" (une entrée par base) et donne à chaque jour du programme son champ "base". Les trajets ENTRE bases (mode, durée, prix réels) vont dans "transport.details" et comptent dans le budget.
ÉTAPE 2 — LE TRANSPORT : compare avion / train / voiture sur QUATRE critères : pollution (utilise les chiffres CO₂ ci-dessus), temps de trajet porte-à-porte, prix, et conditions du voyageur (budget, enfants, transports à éviter, météo/saison). Tranche et justifie.
ÉTAPE 3 — LES LIEUX PRINCIPAUX : liste les 5 à 8 endroits incontournables de la ville/zone (monuments, quartiers, sites naturels), avec leur position relative (nord/sud/centre…).
ÉTAPE 4 — LE LOGEMENT : choisis le quartier en croisant DEUX critères : la proximité/liaison avec le point d'arrivée de l'étape 1-2 (aéroport/gare) ET l'accès facile aux lieux principaux de l'étape 3. Explique ce compromis.
ÉTAPE 5 — LE PROGRAMME : organise les jours en regroupant les lieux de l'étape 3 par PROXIMITÉ GÉOGRAPHIQUE et facilité d'accès depuis le logement (pas de zigzag). MÉTÉO : si la météo réelle annonce de la pluie, place les lieux INTÉRIEURS (musées, marchés couverts) sur les jours à risque et le plein air sur les meilleurs jours. JOUR 1 : l'heure d'arrivée est inconnue sauf indication du voyageur → ne planifie que l'après-midi/soirée (installation + 1 activité douce près du logement) ; dernier jour = départ (allégé).
ÉTAPE 6 — SUR PLACE & RÉSERVATIONS : indique comment se déplacer ENTRE les lieux (pass/carte de transport local avec prix réel, ou à pied), et liste ce qui doit se réserver À L'AVANCE (monuments avec quota, restaurants courus) avec le délai conseillé.
Reste STRICTEMENT dans le budget à chaque étape.
QUESTIONS : si un VRAI doute subsiste (notamment : un événement/festival a lieu pendant le séjour — le voyageur veut-il y assister ? ou un choix qui change le programme), pose 1-2 questions courtes dans "questions" avec un nombre PAIR d'options (2 ou 4). Sinon renvoie "questions":[].

Réponds UNIQUEMENT en JSON. Commence OBLIGATOIREMENT par le champ "analyse" (raisonnement interne, jamais montré) qui suit les 5 étapes DANS L'ORDRE :
{
 "analyse":{
   "etape1_lieu":"ville/zone choisie + point d'arrivée (aéroport/gare) et pourquoi",
   "etape2_transport":"comparaison chiffrée CO₂/durée/prix/conditions des 3 modes + le gagnant",
   "etape3_lieux":["5-8 lieux principaux avec position (ex : Alfama — centre-est)"],
   "etape4_logement":"quartier choisi = compromis arrivée ↔ lieux principaux, en 1-2 phrases",
   "etape5_programme":"logique de regroupement géographique des jours + gestion météo/jour 1, en 1-2 phrases",
   "etape6_surplace":"déplacements sur place + ce qui se réserve tôt, en 1 phrase"
 },
 "transport":{
   "mode":"avion" ou "train" ou "voiture",
   "pourquoi":"2 phrases : pourquoi CE transport vu le budget et les conditions",
   "details":"trajet concret : aéroports/gares/axes, durée, ce qu'il faut réserver",
   "prix_estime":"fourchette réaliste A/R par personne"
 },
 "logement":{
   "type":"1 ou 2 mots MAXIMUM : hôtel, appartement, auberge, villa…",
   "quartier":"quartier précis recommandé (voyage à 1 base) OU la base principale",
   "prix_nuit":"fourchette en € uniquement, ex 80-120€ (sans le mot nuit)",
   "pourquoi":"1 phrase",
   "etapes":[{"ville":"base","quartier":"quartier réel","nuits":nombre,"prix_nuit":"80-120€"}] — UNIQUEMENT si multi-bases, sinon omets ce champ
 },
 "programme":[{"jour":1,"resume":"le thème du jour en 1 ligne","lieux":["2-4 lieux RÉELS visités ce jour (monuments, quartiers, sites précis)"],"base":"ville-étape du jour — UNIQUEMENT si multi-bases"}],
 "budget":{"total":nombre entier en euros par personne,"repartition":"1 phrase : transport X€ + logement Y€ + vie sur place Z€"},
 "sur_place":"1-2 phrases : comment se déplacer entre les lieux (pass/carte de transport local avec prix, marche…)",
 "a_reserver":["2 à 4 réservations à faire À L'AVANCE, chacune avec le délai (ex : Tour de Belém — 1 semaine avant)"],
 "conseil_cle":"LE conseil le plus important pour ce voyage",
 "formalites":{
   "visa":"pour un voyageur FRANÇAIS : visa nécessaire ou non, et si oui lequel (ex : « aucun visa, séjour touristique jusqu'à 90 jours » ou « e-visa à demander en ligne avant le départ »). Si tu n'es pas sûr, écris « à vérifier » plutôt que d'inventer.",
   "passeport":"validité exigée du passeport (ex : « valable 6 mois après la date de retour »)",
   "sante":"vaccins exigés ou recommandés, et précautions sanitaires notables. « Rien de particulier » si c'est le cas.",
   "autre":"une seule autre formalité si elle existe vraiment (assurance obligatoire, taxe de séjour à l'arrivée, autorisation électronique). Chaîne vide sinon."
 },
 "couts_sur_place":[
   {"quoi":"Café","prix":"1,50 €"},
   {"quoi":"Repas simple","prix":"12-18 €"},
   {"quoi":"Ticket de métro/bus","prix":"1,80 €"},
   {"quoi":"Bière (bar)","prix":"5 €"},
   {"quoi":"Entrée de musée","prix":"10-15 €"},
   {"quoi":"Taxi 5 km","prix":"12 €"}
 ] — SIX lignes, les prix RÉELS de CETTE ville (pas des moyennes nationales). Donne le prix dans la MONNAIE LOCALE suivi de l'équivalent en euros entre parenthèses si la monnaie n'est pas l'euro, ex : « 12 000 ₩ (8 €) ». Ce sont les dépenses du quotidien, celles que le budget total ne montre pas.
 "questions":[{"texte":"question courte","options":["2 ou 4 réponses courtes — nombre PAIR"]}]
}
Le programme couvre toute la durée (${p.days || 'du séjour'}), 1 ligne par jour.`;
  try{
    const tok = { court: 4096, normal: 8192, long: 12288 }[SET?.detail || 'normal'];
    let d = await gemini(prompt, true, tok, false, 0.45);
    if(SET?.verif !== false) d = await reviewPlan(d, prompt);   /* relecture croisée : réglable */
    state.cache.plan = d; save();
    renderPlan(d);
    syncModeFromPlan(d);
    /* on résout la position des lieux tout de suite : la carte doit être prête
       quand le voyageur l'ouvre, sans bouton à presser ni attente */
    ensurePlanGeo().catch(() => {});
  }catch(e){
    const msg = e.name === 'AbortError' ? 'Délai dépassé — le serveur IA n’a pas répondu.' : 'Organisation impossible pour le moment.';
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML(msg, 'plan');
  }finally{
    clearInterval(msgTimer);
    _genBusy = false;
  }
}

/* --- Événements & festivals aux dates du voyage (light → Groq) --- */
let _evBusy = false;   /* évite deux recherches simultanées (prefetch + onglet) */
async function loadEvents(){
  const t = state.trip;
  if(!t) return;
  const zone = $('#zoneEvents');            /* peut être absent : on précharge quand même */
  const d = stayDates();
  const ck = `events_${t.nom}_${d ? d.in : 'flex'}`;
  if(state.cache[ck]){ renderEvents(state.cache[ck]); return; }
  if(_evBusy) return;
  _evBusy = true;
  _retryFns.events = loadEvents;
  if(zone) zone.innerHTML = loaderHTML('Recherche des événements…');
  const when = d ? `entre le ${d.in} et le ${d.out}` : (state.prefs?.when || 'à la période prévue');
  const prompt = `Tu es Acolyte, connaisseur de ${t.nom} (${t.pays}). ${ctx()}
Liste les ÉVÉNEMENTS marquants à ${t.nom} pendant le séjour (${when}) : festivals, fêtes locales, grands marchés, matchs importants, expositions, ET jours fériés (musées/commerces fermés).
N'indique QUE des événements plausibles et récurrents à cette période. Si tu n'es pas certain d'une date, reste vague sur la date plutôt que d'inventer. Maximum 6.
Réponds UNIQUEMENT en JSON : {"events":[{"nom":"...","quand":"date ou période","type":"festival|fête|marché|sport|expo|férié","note":"1 phrase : intérêt ou impact pratique"}]}`;
  try{
    const { data } = await ai('light', prompt);
    state.cache[ck] = data; save();
    renderEvents(data);
  }catch(e){ if(e.message !== 'NO_KEY' && zone) zone.innerHTML = errHTML('Événements indisponibles pour le moment.', 'events'); }
  finally{ _evBusy = false; }
}
function renderEvents(data){
  const zone = $('#zoneEvents'); if(!zone) return;
  const ev = (data?.events || []).filter(e => e && e.nom);
  const ico = { festival:'fete', 'fête':'fete', fete:'fete', marché:'panier', marche:'panier',
                sport:'sport', expo:'cadre', 'férié':'calendrier', ferie:'calendrier' };
  if(!ev.length){ zone.innerHTML = `<p class="hint" style="margin:0">Rien de notable repéré à ces dates — tu auras la ville pour toi 😉</p>`; return; }
  const prog = state.cache.plan?.programme || [];
  zone.innerHTML = ev.map((e, i) => {
    const deja = prog.some(j => (j.lieux || []).some(l => String(l).toLowerCase() === String(e.nom).toLowerCase()));
    return `<div class="item" style="align-items:flex-start">
      <div class="emo">${ICO(ico[String(e.type||'').toLowerCase()] || 'calendrier', 20)}</div>
      <!-- ⚠️ LE BADGE DE DATE N'EST PLUS DANS LE <h4>. Il y était en flux
           inline : dès que le nom était un peu long (« Festa del Redentore »),
           la pastille se cassait EN PLEIN MILIEU sur deux lignes, moitié au
           bout du titre, moitié en dessous — illisible, et ça n'avait plus
           l'air d'une pastille du tout.
           Un badge est un bloc indivisible : titre et badge deviennent deux
           enfants d'un conteneur qui se replie proprement, le badge passant
           entier à la ligne quand il n'y a plus la place. -->
      <div style="flex:1;min-width:0">
        <div class="ev-tete">
          <h4>${esc(e.nom)}</h4>
          ${e.quand ? `<span class="tag cyan ev-quand">${esc(e.quand)}</span>` : ''}
        </div>
        <p class="hint" style="margin:2px 0 0">${esc(e.note || '')}</p>
      </div>
      <div class="side">${deja
        ? `<span class="tag ok" style="font-size:.62rem">${ICO('coche',12)} au programme</span>`
        : `<button class="btn sm ghost" data-addev="${i}" title="Ajouter cette visite au programme">${ICO('plus',13)} Ajouter</button>`}</div>
    </div>`;
  }).join('');
  state.cache._evList = ev; save();
}

/* Ajoute un événement à une journée du programme (celle qui correspond à sa date
   si on la reconnaît, sinon la 1ʳᵉ journée libre) */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-addev]');
  if(!b) return;
  const ev = (state.cache._evList || [])[+b.dataset.addev];
  const plan = state.cache.plan;
  if(!ev || !plan?.programme?.length){ toast('Génère d’abord le programme'); return; }
  const dts = stayDates();
  let cible = null;
  /* si l'événement porte une date du séjour → on vise CE jour-là */
  const m = String(ev.quand || '').match(/(\d{4})-(\d{2})-(\d{2})/) || String(ev.quand || '').match(/(\d{1,2})[\/\s]/);
  if(dts && m){
    const jourIso = m[0].length === 10 ? m[0] : null;
    if(jourIso){
      const idx = Math.round((new Date(jourIso) - new Date(dts.in)) / 86400000) + 1;
      cible = plan.programme.find(j => +j.jour === idx) || null;
    }
  }
  if(!cible) cible = plan.programme.reduce((a, j) => (j.lieux||[]).length < (a.lieux||[]).length ? j : a, plan.programme[0]);
  cible.lieux = [...(cible.lieux || []), ev.nom];
  delete state.cache.days?.[cible.jour];      /* le détail horaire doit être refait */
  save();
  renderPlan(plan);
  toast(`✔ « ${String(ev.nom).slice(0, 28)} » ajouté au jour ${cible.jour}`);
  setTimeout(() => document.querySelector(`[data-daybox="${CSS.escape(String(cible.jour))}"]`)?.closest('.day-block')?.scrollIntoView({ block:'center' }), 120);
});

/* ============================================================
   HOTELLOOK (Travelpayouts) — vrais prix d'hôtels dans l'app
   Endpoint cache.json : prix agrégés Booking/Expedia/Agoda.
   Repli automatique sur les liens comparateurs si indisponible.
============================================================ */
/* Hotellook (Travelpayouts) a été ARRÊTÉ par son éditeur : son API renvoie 404
   et aucun relais n'y change quoi que ce soit. On s'appuie donc sur l'IA, qui
   connaît de vrais établissements, + des liens de réservation pré-remplis. */
async function loadHotels(force = false){
  const zone = $('#zoneHotels');
  if(!zone) return;
  const t = state.trip;
  if(!t){ zone.innerHTML = `<p class="hint">Choisis d'abord une destination.</p>`; return; }
  const d = stayDates();
  const lg = state.cache.plan?.logement || {};
  const ville = lg.etapes?.[0]?.ville || cleanPlace(t.ville_aeroport) || t.nom;
  const quartier = lg.etapes?.[0]?.quartier || lg.quartier || '';
  const ck = `stay_${ville}_${quartier}_${d ? d.in : 'flex'}`;
  if(state.cache[ck] && !force){ renderHotels(state.cache[ck]); return; }
  _retryFns.hotels = () => loadHotels(true);
  zone.innerHTML = loaderHTML('Sélection des meilleurs logements…');
  const A = state.prefs?.adults || 2, K = state.prefs?.kids || 0;
  const nuits = d ? Math.max(1, Math.round((new Date(d.out) - new Date(d.in)) / 86400000)) : null;
  /* on ancre l'IA sur des établissements réels avant de lui demander de choisir.
     Si le géocodage ou Overpass échoue, osmCtx reste vide et rien ne change. */
  let osmCtx = '';
  try{
    const g = await geoPlace(quartier ? `${quartier} ${ville}` : ville, ccFor(t.pays)) || await geoPlace(ville, ccFor(t.pays));
    if(g) osmCtx = osmStayCtx(await osmStays(+g.latitude, +g.longitude));
  }catch(e){}
  const prompt = `Tu es Acolyte, connaisseur de l'hébergement à ${ville}${quartier ? ` (quartier ${quartier})` : ''}. ${ctx()}${osmCtx}
Propose les 4 MEILLEURS hébergements RÉELS et vérifiables pour ce séjour${nuits ? ` de ${nuits} nuit(s)` : ''}, ${A} adulte(s)${K ? ` et ${K} enfant(s)` : ''}.
Uniquement des établissements qui EXISTENT vraiment (nom exact tel qu'il apparaît sur Booking). Priorité au quartier conseillé${quartier ? ` (${quartier})` : ''}, puis à la proximité des lieux du programme.
Varie les gammes en restant dans le budget. Classe-les du meilleur rapport qualité/prix au plus haut de gamme.
Réponds UNIQUEMENT en JSON :
{"hotels":[{"nom":"nom exact","type":"hôtel|appartement|auberge","quartier":"quartier réel","prix_nuit":"fourchette en € ex 90-130€","note":"ex 8,6/10 si connue sinon null","pourquoi":"1 phrase concrète : ce qui le rend adapté"}]}`;
  try{
    const { data } = await ai('light', prompt);
    const rows = (data?.hotels || []).filter(h => h && h.nom).slice(0, 4);
    if(!rows.length) throw new Error('vide');
    state.cache[ck] = rows; save();
    renderHotels(rows);
  }catch(e){
    if(e.message !== 'NO_KEY') zone.innerHTML = errHTML('Sélection indisponible — les comparateurs ci-dessous restent pré-remplis.', 'hotels');
  }
}

/* Note « 8,6/10 » ou « 4,2 » → une rangée d'étoiles + la valeur brute. */
function hotelStars(note){
  if(note == null || note === '') return '';
  const m = String(note).replace(',', '.').match(/([\d.]+)/);
  if(!m) return `<span class="hc-note">⭐ ${esc(String(note))}</span>`;
  let v = parseFloat(m[1]);
  const sur5 = v > 5 ? v / 2 : v;                 /* /10 → /5 */
  const pleines = Math.round(sur5);
  const etoiles = '★'.repeat(Math.max(0, Math.min(5, pleines))) + '☆'.repeat(Math.max(0, 5 - pleines));
  return `<span class="hc-note"><span class="hc-stars">${etoiles}</span> ${esc(String(note))}</span>`;
}
function renderHotels(rows){
  const zone = $('#zoneHotels'); if(!zone) return;
  const t = state.trip || {}, d = stayDates();
  const A = state.prefs?.adults || 2, K = state.prefs?.kids || 0;
  /* ⚠️ RENOMMÉ : s'appelait ICO et MASQUAIT la fonction globale ICO() dans
     toute cette portée — un appel d'icône ici aurait levé « ICO is not a
     function ». Les émojis deviennent des clés du jeu commun. */
  const ICO_LOG = { hôtel:'hotel', hotel:'hotel', appartement:'hotel', appart:'hotel', auberge:'valise', villa:'hotel', motel:'hotel', 'chambre d’hôtes':'hotel' };
  const enc = encodeURIComponent;
  zone.innerHTML = rows.map((h, i) => {
    const type = String(h.type || '').toLowerCase();
    const estAppart = /appart|villa|chambre|studio|loft/.test(type);
    const q = `${h.nom} ${h.quartier || ''} ${t.nom || ''}`.trim();
    /* liens pré-remplis avec le NOM exact + tes dates → le vrai prix du jour */
    const book = `https://www.booking.com/searchresults.fr.html?ss=${enc(q)}`
      + (d ? `&checkin=${d.in}&checkout=${d.out}` : '') + `&group_adults=${A}${K ? `&group_children=${K}` : ''}`;
    const airbnb = `https://www.airbnb.fr/s/${enc(q)}/homes?adults=${A}${K ? `&children=${K}` : ''}`
      + (d ? `&checkin=${d.in}&checkout=${d.out}` : '');
    return `<div class="hotel-card${i === 0 ? ' best' : ''}">
      ${i === 0 ? `<span class="hc-badge">⭐ Meilleur choix</span>` : ''}
      <div class="hc-top">
        <span class="hc-ico">${ICO(ICO_LOG[type] || 'hotel', 20)}</span>
        <div class="hc-id">
          <h4>${esc(h.nom)}</h4>
          <div class="hc-meta">${ICO('epingle',13)} ${esc(h.quartier || t.nom || '—')}${h.note ? ' · ' + hotelStars(h.note) : ''}</div>
        </div>
        <span class="hc-price">${esc(h.prix_nuit || '?')}<small>/nuit</small></span>
      </div>
      ${h.pourquoi ? `<p class="hc-why">${esc(h.pourquoi)}</p>` : ''}
      <div class="hc-acts">
        <a class="btn sm" href="${esc(book)}" target="_blank" rel="noopener">${ICO('billet',14)} Voir &amp; réserver</a>
        ${estAppart ? `<a class="btn sm ghost" href="${esc(airbnb)}" target="_blank" rel="noopener">${ICO('maison',14)} Airbnb</a>` : ''}
      </div>
    </div>`;
  }).join('') + `<p class="hint" style="margin-top:12px">Établissements réels, choisis pour ton quartier et ton budget. <strong>Le prix exact du jour s'affiche à la réservation</strong> (dates déjà pré-remplies).</p>`;
}

/* --- Liens logement pré-remplis (comparateurs + sites directs) --- */
function stayDates(){
  const p = state.prefs || {};
  if(!p.depart) return null;
  let days = 7;
  const m = String(p.days||'').match(/\d+/g);
  if(/semaine/i.test(p.days||'')) days = (m ? +m[m.length-1] : 1) * 7;
  else if(m) days = +m[m.length-1];
  days = Math.min(30, Math.max(2, days));
  return { in: p.depart, out: addDays(p.depart, days) };
}
function stayLinks(place){
  const p = state.prefs || {}, t = state.trip || {};
  const q = `${place ? place + ', ' : ''}${t.nom || ''}`;
  const d = stayDates();
  const A = p.adults || 2, K = p.kids || 0;
  const enc = encodeURIComponent;
  return {
    cozy:    `https://www.cozycozy.com/fr/s/${enc(((t.nom||'') + (t.pays ? '--' + t.pays : '')).toLowerCase())}`,
    hometogo:`https://www.hometogo.fr/search/?q=${enc(q)}${d ? `&arrival=${d.in}&departure=${d.out}` : ''}&adults=${A + K}`,
    booking: `https://www.booking.com/searchresults.fr.html?ss=${enc(q)}${d ? `&checkin=${d.in}&checkout=${d.out}` : ''}&group_adults=${A}${K ? `&group_children=${K}` : ''}`,
    airbnb:  `https://www.airbnb.fr/s/${enc(q)}/homes?adults=${A}${K ? `&children=${K}` : ''}${d ? `&checkin=${d.in}&checkout=${d.out}` : ''}`,
    abritel: `https://www.abritel.fr/search?destination=${enc(q)}${d ? `&startDate=${d.in}&endDate=${d.out}` : ''}&adults=${A}`
  };
}

/* ============================================================
   EMPREINTE CARBONE — estimation A/R par personne + alternative plus sobre
============================================================ */
const CO2_G_KM = { avion: 250, voiture: 190, train: 30, bus: 60 };   /* g CO₂ par km */
function carbonHTML(mode){
  const dist = state.cache._real?.dist;        /* km, aller simple (données réelles) */
  if(!dist || dist < 5) return '';
  const A = (state.prefs?.adults || 1) + (state.prefs?.kids || 0);
  const kg = m => {
    let f = CO2_G_KM[m] ?? CO2_G_KM.avion;
    if(m === 'voiture') f = f / Math.max(1, A);   /* la voiture se partage entre passagers */
    return Math.round(dist * 2 * f / 1000);
  };
  const m = ['avion','train','voiture'].includes(mode) ? mode : 'avion';
  const mine = kg(m);
  const best = ['train','voiture','avion'].filter(x => x !== m).map(x => ({ x, v: kg(x) })).sort((a,b) => a.v - b.v)[0];
  const gain = best && best.v < mine ? Math.round((1 - best.v / mine) * 100) : 0;
  /* ⚠️ Renommé pour la même raison : il masquait ICO(). */
  const ICO_MODE = { avion:'avion', train:'train', voiture:'voiture' };
  return `<div class="divider"></div>
    <div class="info-card carbon-card">
      <div class="ic-head"><span>${ICO('monde',18)}</span><h4>Impact sur le climat</h4></div>
      <p class="carbon-big">${ICO(ICO_MODE[m] || 'monde', 18)} <strong>${mine} kg de CO₂</strong> <span>aller-retour, par personne</span></p>
      <p class="ic-note">Calculé sur le trajet réel d'environ ${Math.round(dist)} km.</p>
      <p style="margin:8px 0 0">${gain
        ? `${ICO('feuille',14)} En ${esc(best.x)}, ce serait environ <strong>${best.v} kg</strong>, soit <strong>${gain} % de moins</strong>.`
        : `🌱 C'est déjà l'option la plus sobre pour ce trajet — bravo !`}</p>
    </div>`;
}

/* ============================================================
   MODE « JOUR J » — pendant le voyage, la journée du jour en avant
============================================================ */
/* ============================================================
   MODE JOUR J — CE QUI COMPTE MAINTENANT, ET RIEN D'AUTRE
   ------------------------------------------------------------
   Pendant le séjour, on ne consulte pas son voyage comme on l'a préparé. On
   sort le téléphone dans la rue, souvent d'une main, pour UNE question : où
   est-ce que je vais maintenant, et c'est loin ?

   L'ancienne carte se contentait de rappeler le thème du jour et la liste des
   lieux — la même information que dans le programme, en plus petit. Elle ne
   répondait pas à la question.

   Ce qu'elle dit maintenant, dans cet ordre :
   · la PROCHAINE étape (l'heure à venir la plus proche du programme horaire) ;
   · à quelle distance elle est, si on connaît sa position ;
   · le budget du jour restant, si des dépenses sont suivies ;
   · et seulement ensuite, le reste de la journée.

   ⚠️ Tout est facultatif et se dégrade proprement : sans programme horaire, on
   retombe sur les lieux ; sans position, on n'affiche pas de distance. Une
   carte Jour J qui exige des données pour s'afficher ne sert à rien le jour où
   il en manque une.
============================================================ */
/* Position du voyageur, gardée quelques minutes : le Jour J la redemande à
   chaque rendu, et rappeler le GPS toutes les dix secondes viderait la
   batterie sans rien apporter. */
let _jjPos = null;
function jjDemandePos(){
  if(!navigator.geolocation) return;
  if(_jjPos && Date.now() - _jjPos.t < 180000) return;      /* moins de 3 min */
  navigator.geolocation.getCurrentPosition(
    p => { _jjPos = { lat:p.coords.latitude, lon:p.coords.longitude, t:Date.now() };
           const z = $('#zonePlan'); if(z) z.innerHTML = todayHTML(); },
    () => {},                                               /* refus : on n'insiste pas */
    { timeout:8000, maximumAge:120000 });
}
/* Distance à pied : la distance à vol d'oiseau × 1,35 approche le trajet réel
   en ville (les rues ne sont pas droites), et 4,8 km/h est une marche normale.
   ⚠️ On annonce « environ » : ce n'est pas un itinéraire, c'est un ordre de
   grandeur — et c'est justement ce qu'on veut savoir dans la rue. */
function jjMarche(km){
  const M = surPlaceActuel();
  const reel = km * M.detour;
  const min = Math.round(reel / M.kmh * 60);
  const EN = isEN();
  if(min <= 1) return EN ? 'right here' : 'à deux pas';
  const kmTxt = reel.toLocaleString(LOC(), { minimumFractionDigits:1, maximumFractionDigits:1 });
  /* Retour en TEXTE BRUT (il est inséré via textContent ailleurs) : pas
     d'icône ici, et surtout plus d'espace en tête. */
  return `≈ ${min} min · ${reel < 1 ? Math.round(reel * 1000) + ' m' : kmTxt + ' km'}`;
}
/* La prochaine étape du programme horaire, si le voyageur en a un pour ce
   jour-là. On compare des minutes depuis minuit : les heures arrivent sous des
   formes variées (« 9h », « 09:30 », « 14 h 15 »). */
function jjProchaine(idx){
  /* ⚠️ La source est state.cache.days[jour].etapes — via tlEtapes(), pour ne
     pas dupliquer le chemin. Je l'avais d'abord cherchée dans un state.timeline
     qui n'existe pas : la carte serait restée muette sans jamais rien signaler,
     puisque l'absence de programme horaire est un cas NORMAL. */
  const tl = tlEtapes(idx);
  if(!Array.isArray(tl) || !tl.length) return null;
  const now = new Date();
  const maintenant = now.getHours() * 60 + now.getMinutes();
  const enMin = (h) => {
    const m = String(h || '').match(/(\d{1,2})\s*[h:]\s*(\d{2})?/);
    if(!m) return null;
    return (+m[1]) * 60 + (+(m[2] || 0));
  };
  let suivant = null;
  for(const it of tl){
    const t = enMin(it.heure);
    if(t == null) continue;
    if(t >= maintenant && (!suivant || t < suivant._t)){ suivant = { ...it, _t:t }; }
  }
  return suivant;
}
/* Budget du jour : ce qui reste, divisé par les jours restants. Toutes les
   données existent déjà — il manquait la soustraction. */
function jjBudget(idx, total){
  const bt = parseInt((String(state.cache.plan?.budget?.total || '').replace(/\s/g,'').match(/\d+/) || [])[0], 10) || 0;
  if(!bt) return null;
  const depense = (state.spends || []).reduce((a, s) => a + (+s.amount || 0), 0);
  const reste = bt - depense;
  const joursRestants = Math.max(1, (total || idx) - idx + 1);
  return { bt, depense, reste, parJour: Math.round(reste / joursRestants), joursRestants };
}

function todayHTML(){
  const d = stayDates(); if(!d) return '';
  const now = new Date(), start = new Date(d.in + 'T00:00:00'), end = new Date(d.out + 'T23:59:59');
  if(isNaN(start) || now < start || now > end) return '';
  const idx = Math.floor((now - start) / 86400000) + 1;
  const prog = state.cache.plan?.programme || [];
  const jr = prog.find(x => +x.jour === idx);
  const EN = isEN();

  /* on réclame la position UNE fois : le rendu suivant l'aura */
  jjDemandePos();

  const suiv = jjProchaine(idx);
  const geo = state.cache.plan?._geo || {};
  let distance = '';
  if(suiv && _jjPos){
    const ll = geo[suiv.titre] || geo[suiv.lieu];
    if(ll) distance = jjMarche(havKm(
      { latitude:_jjPos.lat, longitude:_jjPos.lon },
      { latitude: ll[0], longitude: ll[1] }));
  }
  const bu = jjBudget(idx, prog.length);

  return `<div class="card today-card jj">
    <div class="jj-head">
      <span class="jj-jour">${EN ? 'Day' : 'Jour'} ${idx}${prog.length ? `<i>/${prog.length}</i>` : ''}</span>
      <span class="jj-heure">${now.toLocaleTimeString(LOC(), { hour:'2-digit', minute:'2-digit' })}</span>
    </div>

    ${suiv ? `
      <p class="jj-lbl">${EN ? 'Next up' : 'Prochaine étape'}</p>
      <div class="jj-suiv">
        <span class="jj-h">${esc(suiv.heure || '')}</span>
        <span class="jj-t">${esc(suiv.titre || '')}</span>
      </div>
      ${distance ? `<p class="jj-dist">${ICO('pied',13)} ${esc(distance)}</p>` : ''}
    ` : jr ? `
      <p class="jj-lbl">${EN ? 'Today' : 'Aujourd’hui'}</p>
      <h4 class="jj-suiv-t">${esc(jr.resume || '')}</h4>
      ${(jr.lieux || []).length ? `<p class="jj-lieux">${ICO('epingle',13)} ${jr.lieux.map(l => esc(l) + blogLienHTML(l)).join(' · ')}</p>` : ''}
    ` : `<p class="jj-libre">${EN ? 'Free day — enjoy!' : 'Journée libre — profite bien !'}</p>`}

    ${bu ? `<div class="jj-budget">
      <span>${EN ? 'Left to spend' : 'Il te reste'} <b>${bu.reste.toLocaleString(LOC())} €</b></span>
      <span class="jj-b2">${EN ? `≈ ${bu.parJour} €/day over ${bu.joursRestants} day(s)`
                               : `≈ ${bu.parJour} €/jour sur ${bu.joursRestants} jour${bu.joursRestants > 1 ? 's' : ''}`}</span>
    </div>` : ''}

    <div class="jj-acts">
      ${jr ? `<button class="btn sm" data-daydetail="${esc(String(idx))}">${ICO('horloge',14)} ${
        EN ? 'My day, hour by hour' : 'Ma journée heure par heure'}</button>` : ''}
      <button class="btn sm ghost" id="jjCarte">${ICO('carte',14)} ${EN ? 'Show on the map' : 'Voir sur la carte'}</button>
    </div>
  </div>`;
}
/* « Voir sur la carte » ouvre la carte SUR LA JOURNÉE EN COURS, pas sur l'aller :
   dans la rue, personne ne veut revoir son vol. */
document.addEventListener('click', e => {
  if(!e.target.closest('#jjCarte')) return;
  const d = stayDates();
  if(d){
    const start = new Date(d.in + 'T00:00:00');
    const idx = Math.floor((new Date() - start) / 86400000) + 1;
    /* les trajets sont [aller, J1, J2…] : la journée N est à l'indice N */
    const routes = window._projRoutes || [];
    if(routes[idx]) { switchCat('map'); setTimeout(() => { showRoute(idx); renderRail(); }, 60); return; }
  }
  switchCat('map');
});

/* ============================================================
   VUE « TON VOYAGE » — une barre d'onglets, un panneau à la fois.
   Fini le mur qui défile : chaque écran tient et se lit d'un coup.
============================================================ */
let _planTab = 'programme';                     /* onglet actif, mémorisé entre les rendus */
const _openDays = new Set();                    /* journées dépliées : survivent au changement d'onglet */
const _comDrafts = {};                          /* commentaires en cours de frappe, par journée */
/* Tout le contenu du voyage vit dans ces onglets, sous la carte « Ton
   voyage » qui ne garde que le résumé (trajet + conseil). */
/* ⚠️ L'ORDRE SUIT LE VOYAGE, PAS L'HISTORIQUE DU CODE. Les quatre premiers
   sont ceux qu'on ouvre une fois parti — le programme du jour, où l'on dort,
   comment on circule, ce qu'on dépense. Les trois derniers servent AVANT :
   les événements qu'on repère, les formalités, la maison qu'on ferme.
   ⚠️ Et « Avant de partir » est devenu « Maison » : le libellé long à lui seul
   poussait deux onglets hors de l'écran. Le nom complet reste en title. */
const PLAN_TABS = [
  { id:'programme', ico:'calendrier', nom:'Programme' },
  { id:'logement',  ico:'hotel',      nom:'Logement'  },
  { id:'transport', ico:'train',      nom:'Transport' },
  { id:'budget',    ico:'document',   nom:'Budget'    },
  { id:'events',    ico:'etincelle',  nom:'Événements'},
  { id:'papiers',   ico:'passeport',  nom:'Papiers'   },
  /* « Manger » rebranché : loadFood() est ancré sur les tables RÉELLES relevées
     dans OpenStreetMap et porte les contraintes alimentaires. Son écran avait
     disparu lors d'une refonte, la fonction est restée. */
  { id:'manger',    ico:'valise',     nom:'Manger', titre:'Où manger, ancré sur les adresses réelles du quartier' },
  { id:'maison',    ico:'cle',        nom:'Maison', titre:'Avant de partir — la maison que tu laisses' }
];

/* ============================================================
   PAPIERS, FORMALITÉS ET PRIX SUR PLACE
   ------------------------------------------------------------
   ⚠️ CE PANNEAU MÊLE DEUX SOURCES DE FIABILITÉ TRÈS DIFFÉRENTES, et il doit le
   DIRE au lecteur — c'est le seul endroit de l'app où une erreur peut coûter un
   avion raté ou un refus d'embarquement.

   · Ce qui est CERTAIN vient d'ici, en dur : la prise électrique, la tension,
     et le lien vers la fiche officielle du ministère. Ces données ne changent
     pas d'un jour à l'autre, et le lien renvoie à l'AUTORITÉ plutôt que de
     faire d'Acolyte une autorité qu'il n'est pas.
   · Ce qui est INDICATIF vient du modèle : visa, validité du passeport, santé.
     Ces règles changent, et un modèle se trompe. D'où l'avertissement, non
     négociable, et le lien officiel juste à côté.

   Ne remplace JAMAIS le lien officiel par du texte généré : c'est lui qui
   protège le voyageur, et toi.
============================================================ */
/* ============================================================
   NUMÉROS D'URGENCE — CONSULTABLES SANS RÉSEAU
   ------------------------------------------------------------
   C'est le genre d'information qu'on ne regarde jamais — sauf une fois, et ce
   jour-là on n'a ni réseau ni le temps de chercher. Elle est donc EN DUR dans
   le code, pas appelée à la demande : elle doit s'afficher dans un tunnel.

   ⚠️ ON N'INVENTE RIEN ICI. Cette table ne contient que des numéros dont je
   suis sûr. Pour tout pays absent, on affiche le 112 avec une mention claire
   qu'il faut vérifier — et le lien vers la fiche officielle du ministère reste
   à côté, c'est LUI qui fait autorité. Ajouter un numéro approximatif serait
   pire que ne rien afficher : quelqu'un pourrait composer un faux numéro en
   urgence. Ne complète cette table que si tu es certain.

   ⚠️ Le 112 fonctionne dans toute l'Union européenne et depuis n'importe quel
   téléphone, même sans carte SIM et même verrouillé. C'est pour ça qu'il sert
   de repli, et ça vaut d'être dit au voyageur.
============================================================ */
const URGENCE = {
  /* Union européenne et voisins : le 112 est le numéro unique */
  _112: 'FR BE LU NL DE AT IT ES PT IE GR SE FI DK PL CZ SK HU RO BG HR SI EE LV LT MT CY IN ID TR RU UA GE IS'.split(' '),
  /* Numéros propres, vérifiés un par un */
  US: { police:'911', ambulance:'911', pompiers:'911' },
  CA: { police:'911', ambulance:'911', pompiers:'911' },
  MX: { police:'911', ambulance:'911', pompiers:'911' },
  GB: { police:'999', ambulance:'999', pompiers:'999', note:'le 112 fonctionne aussi' },
  CH: { police:'117', ambulance:'144', pompiers:'118', note:'le 112 fonctionne aussi' },
  NO: { police:'112', ambulance:'113', pompiers:'110' },
  AU: { police:'000', ambulance:'000', pompiers:'000' },
  NZ: { police:'111', ambulance:'111', pompiers:'111' },
  JP: { police:'110', ambulance:'119', pompiers:'119' },
  CN: { police:'110', ambulance:'120', pompiers:'119' },
  KR: { police:'112', ambulance:'119', pompiers:'119' },
  TH: { police:'191', ambulance:'1669', pompiers:'199' },
  VN: { police:'113', ambulance:'115', pompiers:'114' },
  SG: { police:'999', ambulance:'995', pompiers:'995' },
  MY: { police:'999', ambulance:'999', pompiers:'999' },
  PH: { police:'911', ambulance:'911', pompiers:'911' },
  BR: { police:'190', ambulance:'192', pompiers:'193' },
  AR: { police:'911', ambulance:'107', pompiers:'100' },
  CL: { police:'133', ambulance:'131', pompiers:'132' },
  PE: { police:'105', ambulance:'106', pompiers:'116' },
  CO: { police:'123', ambulance:'123', pompiers:'123' },
  MA: { police:'19',  ambulance:'15',  pompiers:'15' },
  EG: { police:'122', ambulance:'123', pompiers:'180' },
  ZA: { police:'10111', ambulance:'10177', pompiers:'10177' },
  IL: { police:'100', ambulance:'101', pompiers:'102' },
  AE: { police:'999', ambulance:'998', pompiers:'997' },
  SA: { police:'911', ambulance:'911', pompiers:'911' },
};
function urgenceFor(cc){
  if(!cc) return null;
  const c = String(cc).toUpperCase();
  if(URGENCE[c]) return { ...URGENCE[c], sur:true };
  if(URGENCE._112.includes(c)) return { police:'112', ambulance:'112', pompiers:'112', sur:true,
    note:'numéro unique européen, gratuit et accessible même sans carte SIM' };
  /* Pays absent de la table : on ne devine pas. */
  return { police:'112', ambulance:'112', pompiers:'112', sur:false };
}

/* Prises et tension. Regroupées par TYPE plutôt que pays par pays : c'est la
   même information, dix fois plus courte, et on voit tout de suite les
   ensembles cohérents. Le défaut européen couvre le cas le plus fréquent. */
const PRISES = [
  { t:'A / B', v:'120 V', cc:'US CA MX GT SV HN NI CR PA CO VE EC PE BR BO CU DO HT JM BS TT PR JP PH TW VN TH'.split(' ') },
  { t:'G',     v:'230 V', cc:'GB IE MT CY HK SG MY BN AE QA BH OM SA KW YE JO IQ KE UG TZ GH NG ZW ZM BW MW MU MV LK BD PK'.split(' ') },
  { t:'I',     v:'230 V', cc:'AU NZ CN AR UY FJ PG WS TO CK NU'.split(' ') },
  { t:'D / M', v:'230 V', cc:'IN NP ZA NA LS SZ MZ'.split(' ') },
  { t:'J',     v:'230 V', cc:'CH LI'.split(' ') },
  { t:'K',     v:'230 V', cc:'DK GL FO'.split(' ') },
  { t:'L',     v:'230 V', cc:'IT SM VA'.split(' ') },
  { t:'C / F', v:'220 V', cc:'RU UA BY KZ UZ GE AM AZ MD TR EG MA TN DZ LY IL KR ID'.split(' ') },
];
/* ⚠️ MÊMES NOMS DE CHAMPS que la valeur renvoyée par priseFor : « type » et
   « tension ». Ce repli portait « t » et « v », si bien que l'Europe
   continentale — le cas le plus fréquent, France comprise — affichait
   « undefined ». Un défaut ne se teste jamais tout seul : c'est justement lui
   qui sort le plus souvent. */
const PRISE_DEFAUT = { type:'C / E / F', tension:'230 V' };
function priseFor(cc){
  if(!cc) return null;
  const c = String(cc).toUpperCase();
  for(const g of PRISES) if(g.cc.includes(c)) return { type:g.t, tension:g.v };
  return PRISE_DEFAUT;   /* Europe continentale et assimilés */
}
/* La fiche officielle du ministère des Affaires étrangères. On ne devine pas
   l'URL exacte du pays — elle est imprévisible : on ouvre la RECHERCHE du site
   officiel, qui mène toujours à la bonne fiche. Un lien qui marche vaut mieux
   qu'un lien deviné qui tombe en 404. */
function lienOfficiel(pays){
  return 'https://www.diplomatie.gouv.fr/fr/conseils-aux-voyageurs/conseils-par-pays-destinations/'
       + '#recherche=' + encodeURIComponent(String(pays || ''));
}
/* La fiche d'urgence. ⚠️ Les numéros sont des LIENS d'appel (tel:) : en
   situation d'urgence, retaper un numéro à l'écran est exactement ce qu'on n'a
   pas le temps de faire. Un appui, et ça sonne. */
function urgenceHTML(cc, t){
  const u = urgenceFor(cc);
  if(!u) return '';
  const EN = isEN();
  const nums = [];
  const ajoute = (ico, lbl, n) => { if(n) nums.push({ ico, lbl, n }); };
  ajoute('🚑', EN ? 'Ambulance' : 'Samu / ambulance', u.ambulance);
  ajoute('👮', EN ? 'Police' : 'Police', u.police);
  ajoute('🚒', EN ? 'Fire' : 'Pompiers', u.pompiers);
  /* si les trois numéros sont identiques, on n'affiche qu'une ligne : trois
     fois « 911 » n'informe pas, ça encombre */
  const unique = u.police === u.ambulance && u.ambulance === u.pompiers;

  return `
  <h3 class="pan-h3" style="margin-top:22px">${EN ? 'In an emergency' : 'En cas d’urgence'}</h3>
  <div class="urg">
    ${unique
      ? `<a class="urg-n urg-uni" href="tel:${esc(u.police)}">
           <span class="urg-ico">${ICO('aide',18)}</span>
           <span><b>${esc(u.police)}</b><i>${EN ? 'all emergencies' : 'toutes urgences'}</i></span></a>`
      : nums.map(x => `<a class="urg-n" href="tel:${esc(x.n)}">
           <span class="urg-ico">${x.ico}</span>
           <span><b>${esc(x.n)}</b><i>${esc(x.lbl)}</i></span></a>`).join('')}
  </div>
  ${u.note ? `<p class="hint" style="margin:8px 0 0">ℹ️ ${esc(u.note)}</p>` : ''}
  ${!u.sur ? `<p class="hint urg-doute" style="margin:8px 0 0">${ICO('alerte',14)} ${EN
      ? 'We do not have verified numbers for this country. 112 works in many places, but CHECK on the official page above before you leave — do not rely on this line.'
      : 'Nous n’avons pas de numéros vérifiés pour ce pays. Le 112 fonctionne dans beaucoup d’endroits, mais VÉRIFIE sur la fiche officielle ci-dessus avant de partir — ne te fie pas à cette ligne.'}</p>` : ''}
  <p class="hint" style="margin:8px 0 0">🇫🇷 ${EN
    ? 'French citizens: the nearest consulate is listed on the official page above. Save its number in your phone before leaving.'
    : 'Le consulat de France le plus proche figure sur la fiche officielle ci-dessus. Enregistre son numéro dans ton téléphone avant de partir.'}</p>
  ${typeof urgencePersoHTML === 'function' ? urgencePersoHTML() : ''}`;
}

function panPapiers(d){
  const t = state.trip || {};
  const f = d.formalites || {};
  const cc = ccFor(t.pays) || ccFor(t.nom);
  const pr = priseFor(cc);
  const couts = Array.isArray(d.couts_sur_place) ? d.couts_sur_place.filter(x => x && x.quoi) : [];
  const EN = isEN();

  const ligne = (k, v) => v && String(v).trim() && !/^n\/?a$/i.test(String(v).trim())
    ? `<div class="af"><span class="af-k">${esc(k)}</span><span class="af-v">${esc(v)}</span></div>` : '';

  return `
  <p class="pan-intro">${EN
    ? 'What you need to get in, and what daily life actually costs there.'
    : 'Ce qu’il faut pour entrer, et ce que la vie sur place coûte vraiment.'}</p>

  <div class="key-tip"><span class="kt-emo">${ICO('alerte',18)}</span><p>${EN
    ? 'Entry rules change, and this section is written automatically — it can be wrong or out of date. Before you book, check the official page below. It is the only source that commits anyone.'
    : 'Les règles d’entrée changent, et cette partie est rédigée automatiquement : elle peut être fausse ou périmée. Avant de réserver, vérifie sur la fiche officielle ci-dessous — c’est la seule source qui engage.'}</p></div>

  <a class="btn" href="${esc(lienOfficiel(t.pays || t.nom))}" target="_blank" rel="noopener noreferrer"
     style="width:100%;justify-content:center">🇫🇷 ${EN
       ? 'Official French government advice' : 'Fiche officielle — France Diplomatie'}</a>

  <h3 class="pan-h3" style="margin-top:20px">${EN ? 'Paperwork' : 'Les papiers'}</h3>
  <div class="art-faits">
    ${ligne(EN ? 'Visa' : 'Visa', f.visa)}
    ${ligne(EN ? 'Passport' : 'Passeport', f.passeport)}
    ${ligne(EN ? 'Health' : 'Santé', f.sante)}
    ${ligne(EN ? 'Also' : 'Autre', f.autre)}
    ${pr ? `<div class="af"><span class="af-k">${EN ? 'Power socket' : 'Prise électrique'}</span><span class="af-v">${esc(pr.type)} · ${esc(pr.tension)}</span></div>` : ''}
  </div>
  ${pr ? `<p class="hint" style="margin-top:8px">${EN
    ? 'Socket and voltage come from a fixed table, not from the AI — they are reliable.'
    : 'La prise et la tension viennent d’un tableau fixe, pas de l’IA : celles-là sont fiables.'}</p>` : ''}

  ${urgenceHTML(cc, t)}

  ${simHTML(cc)}
  ${securiteHTML(t && t.nom)}

  ${couts.length ? `
  <h3 class="pan-h3" style="margin-top:22px">${EN ? 'What things cost there' : 'Combien ça coûte sur place'}</h3>
  <div class="art-faits">
    ${couts.slice(0, 8).map(c => `<div class="af"><span class="af-k">${esc(c.quoi)}</span><span class="af-v">${esc(c.prix || '—')}</span></div>`).join('')}
  </div>
  <p class="hint" style="margin-top:8px">${EN
    ? 'Typical prices, to gauge a day on the ground — not a quote.'
    : 'Des prix courants, pour jauger une journée sur place — pas un devis.'}</p>` : ''}
  ${phrasesHTML()}`;
}

/* ---- Panneau 1 : le programme jour par jour ---- */
/* ---- Le programme jour par jour : cœur de la vue, toujours affiché ---- */
function panProgramme(d){
  const jours = d.programme || [];
  /* le conseil clé, remonté ici depuis l'ancienne carte « Ton voyage » */
  const tip = d.conseil_cle ? `<div class="key-tip"><span class="kt-emo">${ICO('ampoule',18)}</span><p>${esc(d.conseil_cle)}</p></div>` : '';
  if(!jours.length) return tip + `<p class="hint">Aucune journée planifiée pour l'instant.</p>`;
  return meteoHTML() + tip
    + `<p class="pan-intro">Ton programme jour par jour. Une journée ne te va pas ? <strong>Vois-la heure par heure</strong>, ou demande à Acolyte de la <strong>refaire</strong>.</p>`
    + jours.map(jr => `
      <div class="day-block">
        <div class="day-row">
          <span class="day-num">${isEN()?'D':'J'}${esc(String(jr.jour))}</span>
          <div class="day-txt">
            <h4>${esc(jr.resume || '')}</h4>
            ${jr.base ? `<span class="day-base">${ICO('epingle',13)} ${esc(jr.base)}</span>` : ''}
            ${(jr.lieux||[]).length ? `<p>${jr.lieux.map(l => esc(l) + blogLienHTML(l)).join(' · ')}</p>` : ''}
          </div>
        </div>
        <div class="day-acts">
          <button class="day-act" data-daydetail="${esc(String(jr.jour))}">${ICO('horloge',14)} Voir heure par heure</button>
          <button class="day-act" data-planb="${esc(String(jr.jour))}">${ICO('refaire',14)} Refaire ce jour</button>
        </div>
        ${safeDataImg(state.cache.maps?.[jr.jour]) ? `<img class="daymap" src="${safeDataImg(state.cache.maps[jr.jour])}" alt="Carte du jour ${esc(String(jr.jour))}">` : ''}
        ${collabBarHTML(jr.jour)}
        ${(() => {
          /* une journée dépliée le reste : on la ré-affiche depuis le cache */
          const ouvert = _openDays.has(String(jr.jour)) && state.cache.days?.[jr.jour];
          return `<div class="day-detail" data-daybox="${esc(String(jr.jour))}" data-open="${ouvert ? '1' : '0'}">${
            ouvert ? timelineHTML(state.cache.days[jr.jour], jr.jour) : ''}</div>`;
        })()}
      </div>`).join('')
    + sejourCompletHTML() + carnetHTML();
}

/* ---- Onglet Transport ---- */
function panTransport(d){
  const tr = d.transport || {};
  const icons = { avion:'avion', train:'train', voiture:'voiture' };
  const labels = { avion:'en avion', train:'en train', voiture:'en voiture' };
  const mode = ['avion','train','voiture'].includes(tr.mode) ? tr.mode : 'avion';
  const dts = stayDates();
  return `
    <p class="pan-intro">Comment tu rejoins ta destination, pourquoi ce choix, et ce que ça coûte pour la planète.</p>
    ${tripRouteHTML(d)}
    <!-- Le choix, dit clairement -->
    <div class="transport-choice">
      <span class="tc-ico">${icons[mode]}</span>
      <div class="tc-body">
        <h4>Tu voyages ${labels[mode]}</h4>
        <div class="tc-facts">
          ${tr.prix_estime ? `<span class="tc-fact">${ICO('money',13)} ${esc(tr.prix_estime)}</span>` : ''}
          ${tr.duree ? `<span class="tc-fact">⏱ ${esc(tr.duree)}</span>` : ''}
        </div>
        <p class="tc-why">${esc(tr.pourquoi || 'Le meilleur compromis prix / temps / confort pour ce trajet.')}</p>
      </div>
    </div>
    ${tr.details ? `<div class="info-card">
      <div class="ic-head"><span>ℹ️</span><h4>Bon à savoir</h4></div><p>${esc(tr.details)}</p></div>` : ''}
    ${d.sur_place ? `<div class="info-card">
      <div class="ic-head"><span>${ICO('metro',17)}</span><h4>Une fois sur place</h4></div><p>${esc(d.sur_place)}</p></div>` : ''}
    ${carbonHTML(mode)}` + `
    <div class="sim-appel">
      <div><b>Comparer pour de vrai</b><em>Vrais prix et vrais horaires, avion, train ou voiture.</em></div>
      <button type="button" class="btn sm" id="btnOpenSimPan">Ouvrir la simulation</button>
    </div>`;
}

/* ---- Onglet Logement ---- */
function panLogement(d){
  const lg = d.logement || {};
  return `
    <div class="pan-lead">
      <h4>${(lg.etapes||[]).length ? 'Voyage en étapes' : esc(String(lg.type||'Logement')) + (lg.quartier ? ' · ' + esc(lg.quartier) : '')}</h4>
      <p>${esc(lg.pourquoi || '—')}</p>
      ${(lg.etapes||[]).length
        ? `<div class="etapes">${lg.etapes.map(e=>`<div class="etape"><b>${esc(e.ville||'')}</b><span>${esc(e.quartier||'')} · ${esc(String(e.nuits??'?'))} nuit(s)${e.prix_nuit ? ' · ' + esc(e.prix_nuit) : ''}</span></div>`).join('')}</div>`
        : (lg.prix_nuit ? `<p class="pan-price">${ICO('money',13)} ${esc(lg.prix_nuit)} / nuit</p>` : '')}
    </div>
    <h5 class="pan-sub">Où dormir concrètement</h5>
    <div id="zoneHotels"></div>` + ouLogerHTML();
}

/* ---- Onglet Événements : plus de bouton, la recherche se fait toute seule
   pendant l'organisation du voyage (comme les prix réels) ---- */
function panEvents(){
  const t = state.trip, d = stayDates();
  const ck = t ? `events_${t.nom}_${d ? d.in : 'flex'}` : null;
  const contenu = (ck && state.cache[ck]) ? '' : loaderHTML('Recherche des événements…');
  return `
    <p class="pan-intro">Festivals, fêtes, marchés et jours fériés pendant ton séjour. Ajoute ceux qui te tentent à ton programme.</p>
    <div id="zoneEvents">${contenu}</div>`;
}

/* ---- Onglet Budget ---- */
/* Devine un poste de dépense (icône) à partir de son libellé. */
function budgetIcon(label){
  const l = label.toLowerCase();
  if(/transport|vol|avion|train|voiture|billet|trajet|bus/.test(l)) return '🚆';
  if(/h[ôo]tel|logement|h[ée]berg|airbnb|nuit|dormir/.test(l)) return '🏨';
  if(/resto|repas|nourri|manger|food|cuisine|boisson/.test(l)) return '🍽️';
  if(/activit|visite|entr[ée]e|mus[ée]e|excursion|billet|loisir/.test(l)) return '🎫';
  if(/extra|divers|impr[ée]vu|souvenir|shopping/.test(l)) return '✨';
  return '💶';
}
/* Découpe la répartition libre de l'IA en postes { label, montant }. */
function parseBudget(txt){
  if(!txt) return [];
  return String(txt).split(/[·|,;\n]+/).map(s => s.trim()).filter(Boolean).map(seg => {
    const m = seg.match(/(\d[\d\s]{0,7})\s*€?/);
    const amount = m ? parseInt(m[1].replace(/\s/g, ''), 10) : null;
    const label = seg.replace(/[:=–-]?\s*\d[\d\s]*\s*€?.*$/, '').trim() || seg.replace(/\d.*/, '').trim() || seg;
    return { label, amount };
  }).filter(x => x.label);
}
/* ============================================================
   BUDGET RÉEL CONTRE BUDGET PRÉVU
   ------------------------------------------------------------
   Les deux nombres existaient depuis toujours, à deux endroits différents : le
   budget estimé dans le plan, les dépenses saisies dans le suivi. Personne ne
   les avait jamais soustraits — c'est pourtant la seule question qu'on se pose
   sur place : « est-ce que je suis dans les clous ? »

   ⚠️ La barre se colore en fonction du dépassement, PAS de la beauté : verte
   tant qu'on suit, orange dès qu'on va plus vite que le séjour, rouge au-delà
   du budget. Une barre toujours jaune ne dirait rien.

   ⚠️ On n'affiche RIEN sans les deux données. Une comparaison avec un seul
   nombre est trompeuse, et un bloc vide n'est jamais informatif.
============================================================ */
function budgetReelHTML(btNum, nuits){
  const dep = (state.spends || []).reduce((a, s) => a + (+s.amount || 0), 0);
  if(!btNum || !dep) return '';
  const EN = isEN();
  const part = dep / btNum;
  const reste = btNum - dep;

  /* Où en est-on du séjour ? C'est ce qui distingue « j'ai dépensé la moitié
     au milieu du voyage » (normal) de « la moitié le premier jour » (alerte). */
  const dts = stayDates();
  let avance = null;
  if(dts && nuits){
    const start = new Date(dts.in + 'T00:00:00');
    const ecoule = Math.floor((Date.now() - start) / 86400000);
    if(ecoule >= 0 && ecoule <= nuits) avance = Math.min(1, Math.max(0, ecoule / nuits));
  }
  /* Le verdict : on compare le rythme de dépense au rythme du séjour. */
  let ton = 'ok', mot;
  if(part > 1){ ton = 'mal'; mot = EN ? 'Over budget' : 'Budget dépassé'; }
  else if(avance != null && part > avance + 0.15){ ton = 'moyen';
    mot = EN ? 'Spending faster than the trip' : 'Tu dépenses plus vite que le voyage'; }
  else mot = EN ? 'On track' : 'Dans les clous';

  return `
    <div class="breel breel-${ton}">
      <div class="breel-h">
        <span class="breel-mot">${esc(mot)}</span>
        <span class="breel-chiffres">${dep.toLocaleString(LOC())} € ${EN ? 'of' : 'sur'} ${btNum.toLocaleString(LOC())} €</span>
      </div>
      <div class="breel-jauge">
        <i style="width:${Math.min(100, part * 100).toFixed(1)}%"></i>
        ${avance != null ? `<u style="left:${(avance * 100).toFixed(1)}%" title="${
          EN ? 'where you are in the trip' : 'où tu en es du séjour'}"></u>` : ''}
      </div>
      <p class="breel-p">${reste >= 0
        ? (EN ? `${reste.toLocaleString(LOC())} € left` : `Il te reste ${reste.toLocaleString(LOC())} €`)
        : (EN ? `${Math.abs(reste).toLocaleString(LOC())} € over` : `Tu es à ${Math.abs(reste).toLocaleString(LOC())} € au-dessus`)}${
        avance != null ? ` · ${EN ? 'trip is' : 'séjour'} ${Math.round(avance * 100)} % ${EN ? 'done' : 'écoulé'}` : ''}</p>
    </div>`;
}

function panBudget(d){
  const bd = d.budget || {};
  const A = (state.prefs?.adults||1) + (state.prefs?.kids||0);
  const btNum = parseInt((String(bd.total).replace(/\s/g,'').match(/\d+/)||[])[0], 10) || 0;
  const dts = stayDates();
  const nuits = dts ? Math.max(1, Math.round((new Date(dts.out) - new Date(dts.in)) / 86400000)) : 0;
  const parPersJour = (btNum && nuits) ? Math.round(btNum / nuits) : 0;
  const postes = parseBudget(bd.repartition);
  const maxMontant = Math.max(1, ...postes.map(p => p.amount || 0));
  const avecMontants = postes.some(p => p.amount);
  return `
    <div class="budget-head">
      <div class="budget-total">
        <span class="bt-num">${esc(String(bd.total || '?'))} €</span>
        <span class="bt-lbl">par personne</span>
      </div>
      <div class="budget-chips">
        ${A > 1 && btNum ? `<span class="budget-chip">${ICO('personnes',13)} ${btNum * A} € au total (${A} pers.)</span>` : ''}
        ${parPersJour ? `<span class="budget-chip">${ICO('calendrier',13)} ≈ ${parPersJour} € / jour</span>` : ''}
      </div>
    </div>
    ${budgetReelHTML(btNum, nuits)}
    ${postes.length ? `<div class="budget-breakdown">
      <h5 class="pan-sub" style="margin-top:4px">Où part ton budget</h5>
      ${postes.map(p => `<div class="budget-row">
        <span class="br-ico">${budgetIcon(p.label)}</span>
        <span class="br-label">${esc(p.label)}</span>
        ${p.amount ? `<span class="br-amount">${p.amount} €</span>` : ''}
        ${avecMontants ? `<span class="br-bar"><i style="width:${p.amount ? Math.round(p.amount / maxMontant * 100) : 0}%"></i></span>` : ''}
      </div>`).join('')}
    </div>` : (bd.repartition ? `<div class="info-card"><p>${esc(bd.repartition)}</p></div>` : '')}
    <p class="hint" style="margin:12px 0 0">${ICO('ampoule',14)} Estimation indicative — les prix réels du transport s'affichent dans l'onglet Transport.</p>
    ${(d.a_reserver||[]).length ? `<div class="info-card" style="margin-top:14px">
      <div class="ic-head"><span>${ICO('billet',17)}</span><h4>À réserver tôt</h4></div>
      ${d.a_reserver.map(r=>`<p class="ic-todo">${esc(r)}</p>`).join('')}</div>` : ''}
    ${suiviDepensesHTML()}`;
}

/* ============================================================
   LE SUIVI DE DÉPENSES — rebranché
   ------------------------------------------------------------
   renderSpends() existait, complet : total, reste, comparaison au budget du
   plan, suppression ligne à ligne. Et state.spends était même sauvegardé par
   safeState. Mais #zoneSpends n'existait dans aucun fichier : la fonction
   sortait sur `if(!zone) return;` et personne ne pouvait saisir une dépense.
   L'estimation de l'IA était donc affichée sans jamais pouvoir être confrontée
   à la réalité — ce qui est précisément l'intérêt de la chose.
   ⚠️ Le formulaire est reconstruit à CHAQUE rendu du panneau. L'écouteur
   d'origine, posé une fois au chargement sur #btnSpend, ne s'accrochait donc à
   rien. Il est remplacé par un écouteur délégué, posé sur le document.
============================================================ */
function suiviDepensesHTML(){
  const n = Array.isArray(state.spends) ? state.spends.length : 0;
  return `
    <h3 style="margin:22px 0 6px">Ce que tu dépenses vraiment</h3>
    <p class="hint" style="margin:0 0 12px">Saisi sur place, gardé sur ton appareil. C'est ce qui permet de comparer l'estimation ci-dessus à la réalité.</p>
    <div class="sp-form">
      <input id="spLabel" maxlength="40" placeholder="Café, musée, taxi…" autocomplete="off">
      <input id="spAmount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0,00">
      <button type="button" class="btn sm" id="btnSpend">Ajouter</button>
    </div>
    <div id="zoneSpends">${n ? '' : '<p class="hint" style="margin:10px 0 0">Aucune dépense notée pour l’instant.</p>'}</div>`;
}
document.addEventListener('click', e => {
  if(!e.target.closest || !e.target.closest('#btnSpend')) return;
  const l = document.getElementById('spLabel'), a = document.getElementById('spAmount');
  const label = (l && l.value.trim()) || 'Dépense';
  const montant = parseFloat(a && a.value);
  if(!Number.isFinite(montant) || montant <= 0){ toast('Entre un montant valide 💶'); return; }
  state.spends = Array.isArray(state.spends) ? state.spends : [];
  state.spends.push({ label: label.slice(0, 40), amount: montant, ts: Date.now() });
  save();
  if(l) l.value = ''; if(a) a.value = '';
  renderSpends();
});
/* Entrée depuis le champ montant : on ne fait pas retaper au doigt. */
document.addEventListener('keydown', e => {
  if(e.key === 'Enter' && e.target && (e.target.id === 'spAmount' || e.target.id === 'spLabel')){
    e.preventDefault();
    document.getElementById('btnSpend')?.click();
  }
});

/* Le bandeau de trajet : il vit désormais en tête de l'onglet Transport
   (la carte « Ton voyage » a été retirée). #realPrice y est rempli par
   autoRealPrices dès que l'onglet Transport s'affiche. */
function tripRouteHTML(d){
  const icons = { avion:'avion', train:'train', voiture:'voiture' };
  const tr = d.transport || {}, bd = d.budget || {};
  const dts = stayDates();
  const nuits = dts ? Math.max(1, Math.round((new Date(dts.out) - new Date(dts.in)) / 86400000)) : null;
  const dep = cleanPlace(state.prefs?.from || '') || 'Départ';
  const arr = String(state.trip?.nom || '').split('→').pop().trim() || '—';
  return `
    <div class="trip-route">
      <div class="tr-top">
        <span class="tr-mode">${ICO(icons[tr.mode] || 'avion', 22)}</span>
        <div class="tr-journey">
          <span class="tr-pt">${esc(dep)}</span>
          <span class="tr-arrow" aria-hidden="true">→</span>
          <span class="tr-pt">${esc(arr)}</span>
        </div>
        ${d._checked ? `<span class="tr-check" title="Plan relu par une 2ᵉ IA">${ICO('coche',13)}</span>` : ''}
      </div>
      <div class="tr-facts">
        <span class="tr-fact">${ICO(icons[tr.mode] || 'avion', 13)} ${esc(String(tr.mode||'—').toUpperCase())}</span>
        ${tr.prix_estime ? `<span class="tr-fact">${ICO('money',13)} ${esc(tr.prix_estime)}</span>` : ''}
        ${nuits ? `<span class="tr-fact">${ICO('nuit',13)} ${nuits} nuit${nuits>1?'s':''}</span>` : ''}
        ${bd.total ? `<span class="tr-fact">${ICO('money',13)} ${esc(String(bd.total))} €/pers</span>` : ''}
      </div>
      <div class="tr-real" id="realPrice"></div>
    </div>`;
}

function renderPlan(d){
  /* #zonePlan ne porte plus que l'encart « aujourd'hui » (vide hors séjour) :
     le trajet est passé dans l'onglet Transport, le conseil dans Programme. */
  const zp = $('#zonePlan'); if(zp) zp.innerHTML = todayHTML();
  renderSections(d);
  refreshPasses();
  startWx();
  /* Le voyage est prêt : c'est LE moment où proposer l'installation a du sens.
     La fonction pose elle-même ses garde-fous (déjà installée, refus récent,
     délai) — on l'appelle sans condition. */
  proposerInstall();
  /* on cherche les événements dès l'organisation du voyage : ils sont prêts
     (en cache) quand l'utilisateur ouvre l'onglet, sans bouton à presser */
  loadEvents();
}

/* La barre d'onglets et son panneau, dans leur carte à part sous le voyage.
   Séparé de renderPlan pour qu'un changement d'onglet ne re-rende JAMAIS le
   programme (sinon on perdrait les journées dépliées et les commentaires
   en cours de frappe). */
function renderSections(d){
  const panels = { programme: panProgramme, transport: panTransport, logement: panLogement, papiers: panPapiers, events: panEvents, budget: panBudget, manger: panManger, maison: panMaison };
  const zone = $('#zoneSections');
  if(!zone) return;
  zone.innerHTML = `
    <div class="card sections-card">
      <h2 class="sections-title">Ton voyage</h2>
      <div class="plan-tabs-wrap">
        <div class="plan-tabs" role="tablist" aria-label="Détails du voyage">
          ${PLAN_TABS.map(t => `<button class="plan-tab${t.id === _planTab ? ' on' : ''}" data-plantab="${t.id}" role="tab" aria-selected="${t.id === _planTab}"${t.titre ? ` title="${esc(t.titre)}"` : ''}>
            ${ICO(t.ico,18)}${esc(t.nom)}</button>`).join('')}
        </div>
      </div>
      <div class="plan-panel">${(panels[_planTab] || panTransport)(d)}</div>
    </div>`;
  planTabsOmbre();
  if(_planTab === 'logement') loadHotels();
  if(_planTab === 'events') loadEvents();
  /* le bandeau trajet (avec #realPrice) est dans l'onglet Transport : on
     déclenche le prix réel quand cet onglet s'affiche. On passe le mode DU
     PLAN (avion/train/voiture), pas state.mode qui a un autre vocabulaire. */
  if(_planTab === 'transport') autoRealPrices(d.transport?.mode);
}

/* ------------------------------------------------------------
   L'INDICE DE DÉFILEMENT DE LA RANGÉE D'ONGLETS
   ------------------------------------------------------------
   La rangée déborde sur téléphone et son ascenseur est masqué : « Budget »
   restait hors champ, et rien ne disait qu'on pouvait glisser. Un contenu
   atteignable mais invisible équivaut à un contenu absent.
   ⚠️ LE VOILE NE DOIT JAMAIS MENTIR. Il n'apparaît que du côté où il reste
   RÉELLEMENT du contenu — sinon c'est une invitation à glisser vers du vide,
   ce qui est pire que pas d'indice du tout. D'où la marge de 2 px : sans elle,
   des largeurs fractionnaires (313,6 px) laissent le voile allumé en butée.
------------------------------------------------------------ */
function planTabsOmbre(){
  const box = $('.plan-tabs');
  const wrap = box && box.parentElement;
  if(!box || !wrap || !wrap.classList.contains('plan-tabs-wrap')) return;
  const reste = box.scrollWidth - box.clientWidth;
  const x = box.scrollLeft;
  wrap.classList.toggle('a-gauche', x > 2);
  wrap.classList.toggle('a-droite', reste > 2 && x < reste - 2);
}
/* Un seul écouteur, posé une fois : la rangée est reconstruite à chaque
   changement d'onglet, donc un écouteur posé SUR elle serait perdu. On écoute
   donc en capture, au niveau du document. */
document.addEventListener('scroll', e => {
  const t = e.target;
  if(t && t.classList && t.classList.contains('plan-tabs')) planTabsOmbre();
}, true);
window.addEventListener('resize', () => { try{ planTabsOmbre(); }catch(e){} });

/* changement d'onglet : on ne re-rend QUE la barre des détails */
function goPlanTab(id, focus){
  if(!state.cache.plan) return;
  _planTab = id;
  renderSections(state.cache.plan);
  if(focus) $(`[data-plantab="${id}"]`)?.focus();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-plantab]');
  if(!b) return;
  goPlanTab(b.dataset.plantab);
  $('.plan-tabs')?.scrollIntoView({ block:'nearest' });
});
/* navigation clavier ← → (promise par role="tablist", donc on la tient) */
document.addEventListener('keydown', e => {
  const b = e.target.closest?.('[data-plantab]');
  if(!b) return;
  const ids = PLAN_TABS.map(t => t.id);
  const i = ids.indexOf(b.dataset.plantab);
  let n = -1;
  if(e.key === 'ArrowRight') n = (i + 1) % ids.length;
  else if(e.key === 'ArrowLeft') n = (i - 1 + ids.length) % ids.length;
  else if(e.key === 'Home') n = 0;
  else if(e.key === 'End') n = ids.length - 1;
  if(n < 0) return;
  e.preventDefault();
  goPlanTab(ids[n], true);
});

addEventListener('resize', () => { if($('#zonePlan')?.querySelector('.plan-stat')) fitStats(); });



/* ============================================================
   ALERTE PRIX — mémorise le prix du vol et signale les baisses
============================================================ */
const LS_PRICES = 'acolite_prices';
function trackPrice(prix, source){
  if(!state.trip || !prix) return;
  let all;
  try{ all = JSON.parse(localStorage.getItem(LS_PRICES)) || {}; }catch(e){ all = {}; }
  const k = `${state.trip.nom}_${state.prefs?.depart || 'flex'}`;
  const hist = all[k] || [];
  const last = hist[hist.length - 1];
  /* on n'enregistre qu'un point par jour et par source */
  const today = new Date().toISOString().slice(0, 10);
  if(!last || last.d !== today || last.p !== prix){
    hist.push({ p: prix, d: today, s: source });
    all[k] = hist.slice(-30);
    try{ localStorage.setItem(LS_PRICES, JSON.stringify(all)); }catch(e){}
  }
  /* comparaison avec le meilleur prix connu (hors aujourd'hui) */
  const anciens = hist.filter(h => h.d !== today);
  if(!anciens.length) return;
  const ref = Math.min(...anciens.map(h => h.p));
  const diff = prix - ref;
  const bar = $('#priceAlert');
  if(!bar) return;
  if(diff <= -5){
    bar.style.display = 'block';
    bar.className = 'item';
    bar.innerHTML = `<div class="emo">${ICO('baisse',20)}</div><p style="flex:1;font-weight:800">Bonne nouvelle : le vol a <strong>baissé de ${Math.abs(Math.round(diff))} €</strong> depuis ta dernière recherche (${ref} € → ${prix} €). C'est peut-être le moment de réserver.</p>`;
  } else if(diff >= 15){
    bar.style.display = 'block';
    bar.className = 'item';
    bar.innerHTML = `<div class="emo">${ICO('hausse',20)}</div><p style="flex:1;font-weight:800">Le vol a <strong>augmenté de ${Math.round(diff)} €</strong> depuis ta dernière recherche (${ref} € → ${prix} €). Les prix montent à l'approche du départ — ne tarde pas trop.</p>`;
  } else {
    bar.style.display = 'none';
  }
}


/* --- PLAN B : régénère UNE seule journée (sans tout refaire) --- */
async function planB(jour){
  if(!exigeCompte('Crée ton compte pour refaire une journée')) return;
  const d = state.cache.plan;
  if(!d?.programme) return;
  const jr = d.programme.find(x => +x.jour === +jour);
  if(!jr) return;
  /* prompt() remplacé par une vraie boîte du site : voir pbDemande(). Le
     contrat est identique — une chaîne, ou null si le voyageur renonce. */
  const raison = await pbDemande(jour);
  if(raison === null) return;
  toast('🔄 Nouvelle version du jour ' + jour + '…');
  try{
    const autres = d.programme.filter(x => +x.jour !== +jour).map(x => `J${x.jour} : ${x.resume} (${(x.lieux||[]).join(', ')})`).join('\n');
    const R = state.cache._real || {};
    const nd = await gemini(`Tu réorganises UNE SEULE journée d'un voyage à ${state.trip.nom}, ${state.trip.pays}.

JOUR À REFAIRE : jour ${jour} — actuellement "${jr.resume}" (${(jr.lieux||[]).join(', ')}).
RAISON DU CHANGEMENT : "${String(raison).slice(0,160)}"
${R.meteo ? `MÉTÉO RÉELLE : ${R.meteo}` : ''}
${R.feries ? `JOURS FÉRIÉS : ${R.feries}` : ''}

AUTRES JOURNÉES (ne les répète PAS, ne propose PAS les mêmes lieux) :
${autres || 'aucune'}

Propose une nouvelle journée qui répond à la raison donnée (s'il pleut → activités d'intérieur ; fatigue → rythme doux ; trop cher → gratuit).
Uniquement des lieux qui EXISTENT VRAIMENT, regroupés dans le même quartier.
Réponds UNIQUEMENT en JSON : {"jour":${jour},"resume":"phrase courte","lieux":["Lieu 1","Lieu 2","Lieu 3"]}`, true, 900, false, 0.6);
    if(!nd?.resume) throw new Error('vide');
    d.programme = d.programme.map(x => +x.jour === +jour ? { jour:+jour, resume:nd.resume, lieux:nd.lieux || [] } : x);
    state.cache.plan = d; save();
    renderPlan(d);
    toast('✅ Jour ' + jour + ' réorganisé');
  }catch(e){ toast('❌ Impossible de refaire cette journée'); }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-planb]');
  if(b) planB(b.dataset.planb);
});

/* ============================================================
   TABLEAU PARTAGÉ — votes 👍/👎 et commentaires par journée.
   Pensé pour planifier À PLUSIEURS : l'état voyage avec la
   sauvegarde-fichier / l'import, chacun ajoute ses votes.
============================================================ */
function boardState(){
  state.board = state.board || { votes:{}, comments:{} };
  state.board.votes = state.board.votes || {};
  state.board.comments = state.board.comments || {};
  return state.board;
}
const voterName = () => (getUser()?.pseudo || 'Moi').slice(0, 20);
function collabBarHTML(jour){
  const b = boardState(), j = String(jour);
  const votes = b.votes[j] || {};
  const up = Object.values(votes).filter(v => v === 'up').length;
  const down = Object.values(votes).filter(v => v === 'down').length;
  const mine = votes[voterName()];
  const coms = b.comments[j] || [];
  return `<div class="day-collab">
    <button class="cvote ${mine === 'up' ? 'on' : ''}" data-vote="${esc(j)}:up" title="J'aime cette journée">${ICO('pouce',14)} <b>${up}</b></button>
    <button class="cvote ${mine === 'down' ? 'on' : ''}" data-vote="${esc(j)}:down" title="Pas fan de cette journée">${ICO('poucebas',14)} <b>${down}</b></button>
    <button class="cvote" data-comtoggle="${esc(j)}" title="Commentaires de l'équipe">${ICO('discussion',14)} <b>${coms.length}</b></button>
    <span class="collab-hint">planifiez à plusieurs</span>
  </div>
  <div class="day-comments" data-combox="${esc(j)}" hidden>
    <div class="com-list">${coms.map(c => `<p><b>${esc(c.who)}</b> ${esc(c.txt)}</p>`).join('') || '<p class="hint" style="margin:0">Aucun commentaire — lance la discussion !</p>'}</div>
    <div class="com-bar">
      <input class="com-inp" data-cominp="${esc(j)}" maxlength="180" value="${esc(_comDrafts[j] || '')}" placeholder="ex : plutôt le matin ? on ajoute un resto ?">
      <button class="btn sm" data-comsend="${esc(j)}">Envoyer</button>
    </div>
  </div>`;
}
function refreshCollabBar(jour){
  const j = String(jour);
  const block = document.querySelector(`[data-daybox="${CSS.escape(j)}"]`)?.closest('.day-block');
  if(!block) return;
  const bar = block.querySelector('.day-collab'), box = block.querySelector('.day-comments');
  if(!bar || !box) return;
  const wasOpen = !box.hidden;
  const draft = box.querySelector('.com-inp')?.value || '';   /* ne perd pas un commentaire en cours de frappe */
  const tmp = document.createElement('div'); tmp.innerHTML = collabBarHTML(j);
  bar.replaceWith(tmp.children[0]);
  box.replaceWith(tmp.children[0]);
  if(wasOpen){ const nb = block.querySelector('.day-comments'); if(nb) nb.hidden = false; }
  if(draft){ const ni = block.querySelector('.com-inp'); if(ni) ni.value = draft; }
}
document.addEventListener('click', e => {
  const v = e.target.closest('[data-vote]');
  if(v){
    const [j, dir] = v.dataset.vote.split(':');
    const b = boardState(); b.votes[j] = b.votes[j] || {};
    const me = voterName();
    b.votes[j][me] = b.votes[j][me] === dir ? undefined : dir;   /* re-clic = retire le vote */
    if(!b.votes[j][me]) delete b.votes[j][me];
    save(); refreshCollabBar(j);
    return;
  }
  const ct = e.target.closest('[data-comtoggle]');
  if(ct){
    const box = document.querySelector(`[data-combox="${CSS.escape(ct.dataset.comtoggle)}"]`);
    if(box) box.hidden = !box.hidden;
    return;
  }
  const cs = e.target.closest('[data-comsend]');
  if(cs){
    const j = cs.dataset.comsend;
    const inp = document.querySelector(`[data-cominp="${CSS.escape(j)}"]`);
    const txt = (inp?.value || '').trim();
    if(!txt) return;
    const b = boardState(); b.comments[j] = b.comments[j] || [];
    b.comments[j].push({ who: voterName(), txt: txt.slice(0, 180), ts: Date.now() });
    delete _comDrafts[j];          /* envoyé → le brouillon n'a plus lieu d'être */
    save(); refreshCollabBar(j);
    const box = document.querySelector(`[data-combox="${CSS.escape(j)}"]`); if(box) box.hidden = false;
    toast('💬 Commentaire ajouté — partage la sauvegarde à ton co-voyageur');
  }
});
document.addEventListener('keydown', e => {
  if(e.key === 'Enter' && e.target.matches?.('[data-cominp]')){
    document.querySelector(`[data-comsend="${CSS.escape(e.target.dataset.cominp)}"]`)?.click();
  }
});
/* garde le texte en cours de frappe même si on change d'onglet */
document.addEventListener('input', e => {
  if(e.target.matches?.('[data-cominp]')) _comDrafts[e.target.dataset.cominp] = e.target.value;
});

/* ============================================================
   PROGRAMME HEURE PAR HEURE — détaille une journée du plan
============================================================ */
async function loadDayDetail(jour){
  const t = state.trip; if(!t) return;
  const box = document.querySelector(`[data-daybox="${jour}"]`);
  if(!box) return;
  if(box.dataset.open === '1'){ box.innerHTML = ''; box.dataset.open = '0'; _openDays.delete(String(jour)); return; }  /* re-clic = replie */
  box.dataset.open = '1';
  _openDays.add(String(jour));   /* mémorisé : survit à un changement d'onglet */
  state.cache.days = state.cache.days || {};
  /* Une journée DÉJÀ détaillée se relit sans compte — c'est la construire qui
     coûte un appel. Le repli conserve donc l'état plié/déplié pour tout le
     monde, et la porte ne s'ouvre qu'au moment de fabriquer. */
  if(state.cache.days[jour]){ box.innerHTML = timelineHTML(state.cache.days[jour], jour); return; }
  if(!exigeCompte('Crée ton compte pour détailler cette journée')){
    box.dataset.open = '0'; _openDays.delete(String(jour)); box.innerHTML = '';
    return;
  }
  box.innerHTML = loaderHTML('Construction de la journée heure par heure…');
  try{
    const d = await construitJour(jour);
    box.innerHTML = timelineHTML(d, jour);
  }catch(e){
    if(e.message !== 'NO_KEY') box.innerHTML = errHTML('Journée indisponible pour le moment.', 'day' + jour);
    _retryFns['day' + jour] = () => { box.dataset.open = '0'; loadDayDetail(jour); };
  }
}

/* ⚠️ LE NOYAU, SANS AUCUN DOM. Ce bloc vivait à l'intérieur de loadDayDetail,
   qui commence par `if(!box) return;` — donc rien ne pouvait construire une
   journée tant que sa boîte n'était pas à l'écran. Or l'assistant travaille
   depuis l'onglet Discussion, où [data-daybox] n'existe pas : il ne pouvait
   que refuser les demandes du type « modifie l'après-midi du jour 3 ».
   Le prompt n'est PAS dupliqué — loadDayDetail appelle cette fonction. Deux
   copies auraient dérivé l'une de l'autre au premier ajustement. */
async function construitJour(jour){
  const t = state.trip;
  if(!t) throw new Error('SANS_VOYAGE');
  state.cache.days = state.cache.days || {};
  if(state.cache.days[jour]) return state.cache.days[jour];
  const jr = (state.cache.plan?.programme || []).find(x => String(x.jour) === String(jour)) || {};
  const pace = { doux:'doux (peu d\'activités, du temps libre)', equilibre:'équilibré (2-3 activités)', intense:'intense (programme dense)' }[SET?.rythme] || 'équilibré';
  const prompt = `Tu es Acolyte, guide local expert de ${t.nom} (${t.pays}). ${ctx()}
Détaille HEURE PAR HEURE le JOUR ${jour} du séjour.
Thème de la journée : ${jr.resume || 'à toi de le définir'}
Lieux déjà prévus ce jour (à intégrer, dans un ordre logique et géographiquement cohérent) : ${(jr.lieux || []).join(', ') || 'à toi de choisir'}
Rythme souhaité : ${pace}.
Programme RÉALISTE : horaires cohérents, temps de trajet inclus, pauses repas.
TARIFS : donne le prix d'entrée réel de chaque visite payante. Si tu n'es pas sûr, donne une FOURCHETTE. N'invente jamais un tarif précis — « environ 15 € » vaut mieux que « 14,50 € » faux. Uniquement des lieux RÉELS et vérifiables.
Réponds UNIQUEMENT en JSON :
{"titre_journee":"thème du jour","etapes":[{"heure":"09:00","titre":"...","description":"1-2 phrases concrètes avec un vrai conseil","lieu":"nom précis pour Google Maps ou null","type":"visite|repas|pause|trajet","prix":"tarif d'entrée RÉEL par adulte, ex : « 18 € » ou « 12-16 € ». Écris « gratuit » quand ça l'est vraiment, et une chaîne VIDE pour un repas, une pause ou un trajet — on ne devine pas l'addition d'un restaurant."}]}
Entre 6 et 9 étapes.`;
  const d = await gemini(prompt, true, 4096, false, 0.5);
  state.cache.days[jour] = d; save();
  return d;
}
document.addEventListener('click', e => {
  const d = e.target.closest('[data-daydetail]');
  if(d) loadDayDetail(d.dataset.daydetail);
});

/* --- Accordéons + boutons "changer de destination" (CSP stricte : aucun onclick inline) --- */
document.addEventListener('click', e => {
  const acc = e.target.closest('[data-acc]');
  if(acc){
    acc.parentElement.classList.toggle('open');
    /* Le suivi des réservations se peuple à l'ouverture : inutile de le rendre
       tant que l'accordéon est replié. */
    try{ if(acc.parentElement.id === 'accResa') renderResas(); }catch(err){}
    return;
  }
  if(e.target.closest('[data-changedest]')) changeDest();
});


/* --- Pop-up Questions : réponses obligatoires avant le voyage final --- */
let _qsList = [];
/* Garantit un nombre PAIR de choix par question (2 ou 4) : on retire le dernier si le compte est impair */
function evenOptions(opts){
  const o = (opts || []).filter(x => x != null && String(x).trim() !== '').slice(0, 4);
  if(o.length % 2 === 1) o.pop();          /* 3 → 2, 1 → 0 */
  return o;
}
function openQsPopup(qs){
  _qsList = qs.map(q => ({ ...q, options: evenOptions(q.options) }))
             .filter(q => q.options.length >= 2)   /* une question sans au moins 2 choix pairs n'a pas de sens */
             .slice(0, 3);
  if(!_qsList.length){ $('#ovQs').classList.remove('show'); $('#zoneQs').innerHTML = ''; return; }
  const pg = $('#qsProg');
  if(pg) pg.innerHTML = _qsList.map(() => '<i></i>').join('');
  $('#zoneQs').innerHTML = _qsList.map((q, i) => `
    <h4 style="margin:14px 0 6px;font-family:'Fraunces',Georgia,serif">${i+1}. ${esc(q.texte)}</h4>
    <div class="chips even" data-qi="${i}">${q.options.map(o=>`<div class="chip qsopt" data-qi="${i}" data-a="${esc(o)}">${esc(o)}</div>`).join('')}</div>`).join('');
  $('#btnQsGo').disabled = true;
  $('#ovQs').classList.add('show');
}
document.addEventListener('click', e => {
  const c = e.target.closest('.chip.qsopt');
  if(c){
    $$(`.chip.qsopt[data-qi="${c.dataset.qi}"]`).forEach(x => x.classList.remove('on'));
    c.classList.add('on');
    const reste = $$('#zoneQs .chips').filter(g => !g.querySelector('.on')).length;
    $('#btnQsGo').disabled = reste > 0;
    $$('#qsProg i').forEach((el, i) => el.classList.toggle('on', !!$$('#zoneQs .chips')[i]?.querySelector('.on')));
    const btn = $('#btnQsGo');
    if(btn) btn.textContent = reste ? `Encore ${reste} question${reste > 1 ? 's' : ''}…` : '✅ Affiner mes propositions';
    return;
  }
  if(e.target.id === 'btnQsGo'){
    $$('#zoneQs .chip.qsopt.on').forEach(c2 => {
      state.propAnswers = state.propAnswers || [];
      state.propAnswers.push(`${_qsList[+c2.dataset.qi]?.texte} → ${c2.dataset.a}`.slice(0, 200));
    });
    state.propAnswers = (state.propAnswers || []).slice(-12);
    state._qsDone = true; save();
    $('#ovQs').classList.remove('show');
    toast('🎯 Merci — Acolyte affine tes propositions…');
    proposeTrips(state.propAnswers.join(' · '));   /* on relance les PROPOSITIONS avec les réponses */
    return;
  }
  if(e.target.id === 'btnQsSkip'){
    state._qsDone = true; save();
    $('#ovQs').classList.remove('show');
    toast('Ok, Acolyte garde ses propositions actuelles 👍');
  }
});

/* --- Pop-up Réservation : tous les liens + prix réels d'hôtels --- */
function buildResa(){
  const t = state.trip || {}, p = state.prefs || {};
  const enc = encodeURIComponent;
  const L = stayLinks(state.cache.plan?.logement?.quartier || '');
  const d = stayDates();
  const q = `${p.from||'Paris'} ${t.nom||''}`;
  const gf = `https://www.google.com/travel/flights?q=${enc('vols ' + q + (d ? ' le ' + d.in : ''))}`;
  const sky = `https://www.skyscanner.fr/`;
  const rya = `https://www.ryanair.com/fr/fr`;
  const sncf = `https://www.sncf-connect.com/`;
  const trl = `https://www.thetrainline.com/fr`;
  const omio = `https://www.omio.fr/`;
  const car = `https://www.google.com/maps/dir/${enc(p.from||'Paris')}/${enc((t.nom||'')+', '+(t.pays||''))}`;
  const gyg = `https://www.getyourguide.fr/s/?q=${enc(t.nom||'')}`;
  const cvt = `https://www.civitatis.com/fr/recherche/?q=${enc(t.nom||'')}`;
  const ta  = `https://www.tripadvisor.fr/Search?q=${enc(t.nom||'')}`;
  const B = (href, label, solid) => `<a class="btn sm${solid ? '' : ' ghost'}" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;
  $('#zoneResa').innerHTML = `
    <h3 style="margin:6px 0 8px">${ICO('avion',17)} Billets de transport</h3>
    <div class="row">${B(gf,'Google Flights',1)}${B(sky,'Skyscanner')}${B(rya,'Ryanair')}</div>
    <div class="row" style="margin-top:8px">${B(sncf,'SNCF Connect',1)}${B(trl,'Trainline')}${B(omio,'Omio')}</div>
    <div class="row" style="margin-top:8px">${B(car,'Itinéraire voiture (Maps)')}</div>
    <div class="divider"></div>
    <h3 style="margin:0 0 8px">${ICO('hotel',17)} Logement — prix réels</h3>
    <div id="zoneHotels"></div>
    <h3 style="margin:14px 0 8px">${ICO('loupe',17)} Comparer tous les logements</h3>
    <div class="row">${B(L.cozy,'Cozycozy — comparateur',1)}${B(L.hometogo,'HomeToGo — comparateur',1)}</div>
    <div class="row" style="margin-top:8px">${B(L.booking,'Booking')}${B(L.airbnb,'Airbnb')}${B(L.abritel,'Abritel')}</div>
    <p class="hint">Recherches pré-remplies : ${esc(state.cache.plan?.logement?.quartier || t.nom || '')}${d ? ', du ' + esc(d.in) + ' au ' + esc(d.out) : ''}, ${p.adults||2} adulte(s)${p.kids ? ' + ' + p.kids + ' enfant(s)' : ''}.</p>
    <div class="divider"></div>
    <h3 style="margin:0 0 8px">${ICO('etincelle',17)} Activités & visites</h3>
    <div class="row">${B(gyg,'GetYourGuide',1)}${B(cvt,'Civitatis')}${B(ta,'Tripadvisor')}</div>`;
}

const _e1 = $('#btnOpenResa'); if(_e1) _e1.onclick = () => {
  if(!state.trip){ toast('Choisis d’abord un voyage 😉'); return; }
  buildResa();
  $('#ovResa').classList.add('show');
  loadHotels();
};
document.addEventListener('click', e => {
  /* la barrière de confidentialité obligatoire ne se ferme NI par la croix
     (absente) NI par un clic sur le fond : il faut accepter */
  if(_privacyGate && e.target.closest('#ovPrivacy')) return;
  const c = e.target.closest('[data-close]');
  if(c){ $('#' + c.dataset.close).classList.remove('show'); return; }
  if(e.target.classList?.contains('overlay')) e.target.classList.remove('show');
});

function planValidate(){
  const d = state.cache.plan;
  if(!d){ toast("Le plan n'est pas encore prêt"); return; }
  const map = {avion:'plane', train:'train', voiture:'car'};
  state.mode = map[d.transport?.mode] || 'plane';
  state.modeManual = false;
  state.planOk = true;
  delete state.cache['transport_' + state.mode];
  save();
  loadTransport();
  toast(`Plan validé — billets ${d.transport?.mode||''} juste en dessous 🎫`);
  $('#zoneTransport').scrollIntoView({behavior:'smooth', block:'start'});
}

/* Délégation : boutons du plan (la zone est re-rendue) */
document.addEventListener('click', e => {
  if(e.target.id === 'btnPlanOk'){ planValidate(); return; }
  if(e.target.id === 'btnPlanRedo' || e.target.id === 'btnPlanRedo2'){ loadPlan(true); return; }
  const q = e.target.closest('.chip.planq');
  if(q){
    state.planAnswers = state.planAnswers || [];
    state.planAnswers.push(`${q.dataset.q} → ${q.dataset.a}`.slice(0,200));
    state.planAnswers = state.planAnswers.slice(-12);
    save();
    toast('Réponse prise en compte ✔');
    loadPlan(true);
  }
});

/* ============================================================
   ÉTAPE 3 — Y ALLER  (Gemini · heavy)
============================================================ */
const _e3 = $('#tgPlane'); if(_e3) _e3.onclick = () => setMode('plane');
const _e4 = $('#tgCar'); if(_e4) _e4.onclick   = () => setMode('car');
const _e5 = $('#tgTrain'); if(_e5) _e5.onclick = () => setMode('train');
function setMode(m){
  /* Choix explicite : il libère « mode » de toute quarantaine en cours (voir
     etatChoixExplicite). À faire AVANT save(), sinon on réenregistre la boîte. */
  etatChoixExplicite('mode');
  state.mode = m; state.modeManual = true; save();
  $('#tgPlane').classList.toggle('on', m==='plane');
  $('#tgCar').classList.toggle('on', m==='car');
  $('#tgTrain').classList.toggle('on', m==='train');
  loadTransport();
}

async function loadTransport(){
  const zone = $('#zoneTransport');
  const t = state.trip, p = state.prefs;
  const key = 'transport_' + state.mode;
  $('#tgPlane').classList.toggle('on', state.mode==='plane');
  $('#tgCar').classList.toggle('on', state.mode==='car');
  $('#tgTrain').classList.toggle('on', state.mode==='train');
  if(state.cache[key]){ renderTransport(state.cache[key]); return; }
  const msgs = {plane:'Analyse des vols…', car:'Calcul de la route…', train:'Recherche des lignes ferroviaires…'};
  zone.innerHTML = loaderHTML(msgs[state.mode]);

  let prompt;
  if(state.mode === 'plane'){
    prompt = `Tu es Acolyte, expert voyage. ${ctx()}
Le voyageur part en AVION de ${p.from} vers ${t.nom} (${t.pays}).
Réponds UNIQUEMENT en JSON :
{
 "aeroport_depart":"nom + code IATA le plus pratique depuis ${p.from}",
 "iata_depart":"code IATA seul, ex CDG",
 "aeroport_arrivee":"nom + code IATA",
 "iata_arrivee":"code IATA seul",
 "duree_vol":"ex: 2h15 direct",
 "prix_estime":"fourchette A/R réaliste pour cette période",
 "compagnies":["3-4 compagnies pertinentes sur cette ligne"],
 "conseils":["4 conseils concrets : quand réserver, quel jour partir moins cher, bagages, transfert aéroport→centre-ville avec prix"]
}`;
  } else if(state.mode === 'car'){
    prompt = `Tu es Acolyte, expert voyage. ${ctx()}
Le voyageur part en VOITURE de ${p.from} vers ${t.nom} (${t.pays}).
Réponds UNIQUEMENT en JSON :
{
 "distance":"ex: 950 km",
 "duree":"ex: 8h30 sans pause",
 "cout_estime":"carburant + péages, fourchette réaliste",
 "itineraire_resume":"axes principaux, ex: A6 puis A7…",
 "pauses":["2-3 super étapes sur la route (ville + pourquoi s'y arrêter)"],
 "conseils":["4 conseils concrets : vignettes/péages du pays, meilleure heure de départ, stationnement sur place, points de vigilance"]
}`;
  } else {
    prompt = `Tu es Acolyte, expert voyage. ${ctx()}
Le voyageur part en TRAIN de ${p.from} vers ${t.nom} (${t.pays}).
Réponds UNIQUEMENT en JSON :
{
 "faisable":"oui" ou "non" ou "compliqué",
 "trajet":"description du trajet type : gares, correspondances, ex: Paris Gare de Lyon → Milan (Frecciarossa) → …",
 "duree":"durée totale estimée",
 "prix_estime":"fourchette réaliste A/R",
 "compagnies":["compagnies ferroviaires concernées"],
 "conseils":["4 conseils : quand réserver, pass éventuels (Interrail…), trains de nuit s'il y en a, alternative si le train est peu adapté"]
}`;
  }

  try{
    const d = await gemini(prompt);
    state.cache[key] = d; save();
    renderTransport(d);
  }catch(e){
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Analyse impossible pour le moment.');
  }
}

function renderTransport(d){
  const zone = $('#zoneTransport');
  const t = state.trip, p = state.prefs;
  if(state.mode === 'plane'){
    const from = d.iata_depart || 'PAR', to = d.iata_arrivee || (t.iata||'');
    const gf  = `https://www.google.com/travel/flights?q=${encodeURIComponent(`vols de ${p.from} à ${t.ville_aeroport || t.nom}`)}&hl=fr`;
    const ky  = `https://www.kayak.fr/flights/${encodeURIComponent(from)}-${encodeURIComponent(to)}`;
    const sky = `https://www.skyscanner.fr/transport/vols/${encodeURIComponent(from.toLowerCase())}/${encodeURIComponent(to.toLowerCase())}/`;
    zone.innerHTML = `
      <div class="grid" style="margin-bottom:14px">
        <div class="item"><div class="emo">${ICO('decollage',20)}</div><div><h4>Départ</h4><p>${esc(d.aeroport_depart)}</p></div></div>
        <div class="item"><div class="emo">${ICO('atterrissage',20)}</div><div><h4>Arrivée</h4><p>${esc(d.aeroport_arrivee)}</p></div></div>
        <div class="item"><div class="emo">⏱</div><div><h4>Durée</h4><p>${esc(d.duree_vol)}</p></div></div>
        <div class="item"><div class="emo">${ICO('money',20)}</div><div><h4>Prix estimé A/R</h4><p>${esc(d.prix_estime)}</p></div></div>
      </div>
      <div class="divider"></div>
      <h3 style="margin-bottom:10px">Chercher les billets ${ICO('billet',17)}</h3>
      <div class="row">
        <a class="btn" href="${esc(gf)}" target="_blank" rel="noopener">Google Flights</a>
        <a class="btn ghost" href="${esc(ky)}" target="_blank" rel="noopener">Kayak</a>
        <a class="btn ghost" href="${esc(sky)}" target="_blank" rel="noopener">Skyscanner</a>
      </div>
      <p class="hint">Les liens ouvrent la recherche pré-remplie — compare les prix sur les trois.</p>
      <div class="divider"></div>
      <h3 style="margin-bottom:6px">${ICO('money',17)} Prix réels en direct <span class="tag cyan" style="margin-left:6px">API Ryanair · sans clé</span> <span class="tag" style="margin-left:4px">${ICO('monde',12)} Aviasales · token gratuit</span></h3>
      <p class="hint" style="margin:0 0 12px">Deux moteurs : <strong>Ryanair</strong> (sans clé, low-cost only — Paris = BVA) et <strong>Toutes compagnies</strong> via Aviasales (Air France, easyJet, Transavia, Vueling… — token gratuit à coller dans ⚙). Codes ville acceptés côté Aviasales : PAR, LON, ROM…</p>
      <div class="grid tight" style="margin-bottom:12px">
        <div class="field"><label>Départ (IATA)</label><input id="ryFrom" maxlength="3" style="text-transform:uppercase" value="${esc(from)}"></div>
        <div class="field"><label>Arrivée (IATA)</label><input id="ryTo" maxlength="3" style="text-transform:uppercase" value="${esc(to)}"></div>
        <div class="field"><label>Date aller</label><input id="ryDate" type="date" value="${esc(ryDefaultDate())}"></div>
        <div class="field"><label>Flexibilité</label>
          <select id="ryFlex"><option value="3">± 3 jours</option><option value="7" selected>± 7 jours</option><option value="14">± 14 jours</option></select>
        </div>
        <div class="field"><label>Durée sur place</label>
          <select id="ryStay"><option value="3">2-3 nuits</option><option value="7" selected>5-8 nuits</option><option value="14">10-15 nuits</option></select>
        </div>
      </div>
      <div class="row">
        <button class="btn sm" id="btnRyRT">${ICO('loupe',14)} A/R Ryanair</button>
        <button class="btn sm ghost" id="btnRyCal">${ICO('calendrier',14)} Calendrier Ryanair</button>
        <button class="btn sm violet" id="btnTpAll">${ICO('monde',14)} Toutes compagnies</button>
      </div>
      <div id="zoneRy" style="margin-top:14px"></div>`;
  } else if(state.mode === 'car'){
    const saddr = encodeURIComponent(p.from);
    const daddr = encodeURIComponent(`${t.nom}, ${t.pays}`);
    const embed = `https://maps.google.com/maps?saddr=${saddr}&daddr=${daddr}&hl=fr&output=embed`;
    const open  = `https://www.google.com/maps/dir/${saddr}/${daddr}`;
    zone.innerHTML = `
      <div class="grid" style="margin-bottom:14px">
        <div class="item"><div class="emo">${ICO('regle',20)}</div><div><h4>Distance</h4><p>${esc(d.distance)}</p></div></div>
        <div class="item"><div class="emo">⏱</div><div><h4>Durée</h4><p>${esc(d.duree)}</p></div></div>
        <div class="item"><div class="emo">${ICO('money',20)}</div><div><h4>Coût estimé</h4><p>${esc(d.cout_estime)}</p></div></div>
        <div class="item"><div class="emo">${ICO('route',20)}</div><div><h4>Itinéraire</h4><p>${esc(d.itineraire_resume)}</p></div></div>
      </div>
      <div class="map-box" style="margin-bottom:16px"><iframe src="${esc(embed)}" loading="lazy"></iframe></div>
      <div class="row" style="margin-bottom:16px"><a class="btn" href="${esc(open)}" target="_blank" rel="noopener">${ICO('carte',15)} Ouvrir dans Google Maps</a></div>
`;
  } else {
    const trl = `https://www.thetrainline.com/fr`;
    const sncf = `https://www.sncf-connect.com/`;
    const omio = `https://www.omio.fr/`;
    /* Le verdict portait son sens dans un emoji. Il le porte maintenant dans
       une icone + une classe, donc lisible aussi pour un lecteur d'ecran. */
    const fais = { oui:  ICO('coche',14) + ' Faisable',
                   non:  ICO('fermer',14) + ' Peu adapté',
                   'compliqué': ICO('alerte',14) + ' Compliqué mais possible' };
    zone.innerHTML = `
      <div class="grid" style="margin-bottom:14px">
        <div class="item"><div class="emo">${ICO('feu',20)}</div><div><h4>Verdict</h4><p>${fais[d.faisable] || esc(d.faisable)}</p></div></div>
        <div class="item"><div class="emo">⏱</div><div><h4>Durée</h4><p>${esc(d.duree)}</p></div></div>
        <div class="item"><div class="emo">${ICO('money',20)}</div><div><h4>Prix estimé A/R</h4><p>${esc(d.prix_estime)}</p></div></div>
        <div class="item"><div class="emo">${ICO('train',20)}</div><div><h4>Trajet</h4><p>${esc(d.trajet)}</p></div></div>
      </div>
      <div class="divider"></div>
      <h3 style="margin-bottom:10px">Chercher les billets ${ICO('billet',17)}</h3>
      <div class="row">
        <a class="btn" href="${trl}" target="_blank" rel="noopener">Trainline</a>
        <a class="btn ghost" href="${sncf}" target="_blank" rel="noopener">SNCF Connect</a>
        <a class="btn ghost" href="${omio}" target="_blank" rel="noopener">Omio</a>
      </div>
      <div class="divider"></div>
      <h3 style="margin-bottom:6px">${ICO('train',17)} Horaires réels en direct <span class="tag cyan" style="margin-left:6px">API Deutsche Bahn · gratuite sans clé</span></h3>
      <p class="hint" style="margin:0 0 12px">Vrais horaires (et parfois prix) interrogés en live via le réseau DB : Allemagne + liaisons internationales (France, Benelux, Suisse, Autriche, Italie du nord, Danemark…). Si rien ne sort, la liaison n'est pas dans le réseau DB — utilise Trainline.</p>
      <div class="grid tight" style="margin-bottom:12px">
        <div class="field"><label>Gare / ville de départ</label><input id="dbFrom" value="${esc(p.from||'')}"></div>
        <div class="field"><label>Gare / ville d'arrivée</label><input id="dbTo" value="${esc(t.nom)}"></div>
        <div class="field"><label>Départ le</label><input id="dbWhen" type="datetime-local" value="${esc(ryDefaultDate())}T09:00"></div>
      </div>
      <button class="btn sm" id="btnDb">${ICO('loupe',14)} Chercher les trains</button>
      <div id="zoneDb" style="margin-top:14px"></div>`;
  }
}

/* ============================================================
   PRIX RÉELS AUTOMATIQUES — se lancent seuls au rendu du plan,
   sans que le voyageur ait à cliquer sur quoi que ce soit.
   ✈️ Ryanair farfnd · 🚄 Deutsche Bahn · 🚗 calcul carburant+péage
============================================================ */
const FUEL_L100 = 6.5, FUEL_EUR_L = 1.85, TOLL_EUR_KM = 0.09;   /* moyennes Europe 2026 */

/* prix voiture : carburant + péages, aller-retour, divisé par les passagers */
function carPriceAuto(){
  const dist = state.cache._real?.dist;
  if(!dist) return null;
  const route = dist * 1.25;                       /* vol d'oiseau → route réelle */
  const A = Math.max(1, (state.prefs?.adults || 1) + (state.prefs?.kids || 0));
  const total = route * 2 * (FUEL_L100 / 100 * FUEL_EUR_L + TOLL_EUR_KM);
  return { total: Math.round(total), perPax: Math.round(total / A), km: Math.round(route) };
}

/* vol le moins cher (Ryanair, API publique sans clé) */
async function planePriceAuto(){
  const t = state.trip, p = state.prefs || {};
  const to = (t?.iata || '').toUpperCase().replace(/[^A-Z]/g, '');
  if(to.length !== 3 || !p.depart) return null;
  const AIRPORTS = { paris:'BVA', lyon:'LYS', marseille:'MRS', bordeaux:'BOD', nantes:'NTE', toulouse:'TLS',
                     lille:'LIL', nice:'NCE', bruxelles:'CRL', 'genève':'GVA', geneve:'GVA' };
  const from = AIRPORTS[cleanPlace(p.from || 'Paris').toLowerCase()] || 'BVA';
  const stay = Math.max(2, Math.min(21, daysFromPrefs ? daysFromPrefs() : 7));
  const url = `https://services-api.ryanair.com/farfnd/v4/roundTripFares?departureAirportIataCode=${from}&arrivalAirportIataCode=${to}`
    + `&outboundDepartureDateFrom=${p.depart}&outboundDepartureDateTo=${addDays(p.depart, 3)}`
    + `&inboundDepartureDateFrom=${addDays(p.depart, Math.max(1, stay - 1))}&inboundDepartureDateTo=${addDays(p.depart, stay + 3)}`
    + `&market=fr-fr&adultPaxCount=${p.adults || 1}&currency=EUR&limit=6&durationFrom=1&durationTo=${stay + 3}`;
  try{
    const r = await fetchT(url, {}, 9000);
    if(!r.ok) return null;
    const d = await r.json();
    const f = (d.fares || []).filter(x => x?.summary?.price?.value).sort((a, b) => a.summary.price.value - b.summary.price.value)[0];
    if(!f) return null;
    return { prix: Math.round(f.summary.price.value), from, to,
             aller: f.outbound?.departureDate?.slice(0, 10), retour: f.inbound?.departureDate?.slice(0, 10) };
  }catch(e){ return null; }
}

/* Charge en tâche de fond le prix réel du mode choisi, puis met à jour la tuile
   « Y aller » sans re-rendre tout le plan. Silencieux si indisponible. */
async function autoRealPrices(mode){
  const slot = $('#realPrice');
  if(!slot) return;
  const ck = `rp_${mode}_${state.trip?.nom}_${state.prefs?.depart || 'flex'}`;
  if(state.cache[ck]){ slot.innerHTML = state.cache[ck]; return; }
  let html = '';
  /* voiture et train ne demandent AUCUN réseau (calcul local / données déjà en cache) :
     ils s'affichent même en connexion dégradée. */
  if(mode === 'voiture'){
    const c = carPriceAuto();
    if(c) html = `<span class="rp-ok">${ICO('voiture',13)} <strong>≈ ${c.perPax} €/pers</strong> A/R · ${c.km} km · carburant + péages</span>`;
  }else if(mode === 'train'){
    const tr = state.cache._real?.train;
    if(tr) html = `<span class="rp-ok">${ICO('train',13)} <strong>${esc(tr)}</strong></span>`;
  }else{
    /* l'avion exige un appel réseau → on s'abstient si la connexion rame, et on rejoue plus tard */
    if(netSlow()){
      slot.innerHTML = `<span class="rp-idle">réseau limité — prix chargé au retour du réseau</span>`;
      netRetry('prix-avion', () => autoRealPrices(mode));
      return;
    }
    slot.innerHTML = `<span class="rp-load">recherche du prix réel…</span>`;
    const f = await planePriceAuto();
    if(f) html = `<span class="rp-ok">${ICO('avion',13)} <strong>dès ${f.prix} € A/R</strong> · ${esc(f.from)}→${esc(f.to)}${f.aller ? ` · ${esc(f.aller)}` : ''} <em>(Ryanair, aujourd'hui)</em></span>`;
  }
  if(!html){ slot.innerHTML = `<span class="rp-idle">prix du jour à vérifier sur les liens de réservation</span>`; return; }
  state.cache[ck] = html; save();
  slot.innerHTML = html;
}

/* ============================================================
   BILLETS EN DIRECT — APIs publiques gratuites sans clé
   ✈️ Ryanair farfnd (prix réels) · 🚄 v6.db.transport.rest (horaires DB)
============================================================ */
function ryDefaultDate(){
  const base = state.prefs?.depart ? new Date(state.prefs.depart) : new Date(Date.now() + 14*864e5);
  return base.toISOString().slice(0,10);
}
const addDays = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); };
const frDate = iso => new Date(iso).toLocaleDateString(LOC(),{weekday:'short',day:'numeric',month:'short'});
const frTime = iso => new Date(iso).toLocaleTimeString(LOC(),{hour:'2-digit',minute:'2-digit'});

/* --- ✈️ Ryanair : meilleurs A/R sur une fenêtre de dates --- */
async function ryRoundTrip(){
  const zone = $('#zoneRy');
  const from = $('#ryFrom').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const to   = $('#ryTo').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const date = $('#ryDate').value;
  const flex = +$('#ryFlex').value, stay = +$('#ryStay').value;
  if(from.length!==3 || to.length!==3 || !date){ toast('Renseigne 2 codes IATA + une date'); return; }
  zone.innerHTML = loaderHTML('Interrogation des tarifs Ryanair…');
  const outFrom = addDays(date, -Math.min(flex, Math.floor((new Date(date)-Date.now())/864e5)));
  const outTo   = addDays(date, flex);
  const inFrom  = addDays(date, Math.max(1, stay - 2));
  const inTo    = addDays(date, stay + flex);
  const url = `https://services-api.ryanair.com/farfnd/v4/roundTripFares?departureAirportIataCode=${from}&arrivalAirportIataCode=${to}`
    + `&outboundDepartureDateFrom=${outFrom}&outboundDepartureDateTo=${outTo}`
    + `&inboundDepartureDateFrom=${inFrom}&inboundDepartureDateTo=${inTo}`
    + `&market=fr-fr&adultPaxCount=${state.prefs?.adults||1}&currency=EUR&limit=16&durationFrom=1&durationTo=${stay+flex}`;
  try{
    const r = await fetch(url);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const fares = (d.fares||[]).filter(f=>f.outbound && f.inbound)
      .sort((a,b)=>(a.summary?.price?.value??9e9)-(b.summary?.price?.value??9e9)).slice(0,6);
    if(!fares.length){
      zone.innerHTML = errHTML(`Aucun vol Ryanair ${from} → ${to} sur cette période. Ligne non desservie ou dates complètes — essaie le calendrier du mois, ou change d'aéroport (Paris = BVA).`);
      return;
    }
    zone.innerHTML = `<h3 style="margin-bottom:10px">Meilleurs allers-retours trouvés</h3>` + fares.map((f,i)=>{
      const o = f.outbound, b = f.inbound;
      const dOut = o.departureDate.slice(0,10), dIn = b.departureDate.slice(0,10);
      const book = `https://www.ryanair.com/fr/fr/trip/flights/select?adults=${state.prefs?.adults||1}&teens=0&children=0&infants=0&isReturn=true&dateOut=${dOut}&dateIn=${dIn}&originIata=${from}&destinationIata=${to}&tpAdults=${state.prefs?.adults||1}&tpStartDate=${dOut}&tpEndDate=${dIn}&tpOriginIata=${from}&tpDestinationIata=${to}`;
      return `<div class="item">
        <div class="emo">${ICO(i===0?'trophee':'avion',20)}</div>
        <div style="flex:1">
          <h4>${esc(frDate(o.departureDate))} → ${esc(frDate(b.departureDate))}</h4>
          <p>Aller ${esc(frTime(o.departureDate))} (${esc(o.price?.value?.toFixed(2))} €) · Retour ${esc(frTime(b.departureDate))} (${esc(b.price?.value?.toFixed(2))} €)<br>
          ${esc(o.departureAirport?.name||from)} ⇄ ${esc(o.arrivalAirport?.name||to)}</p>
          <a class="tl-loc" href="${esc(book)}" target="_blank" rel="noopener" style="margin-top:8px">${ICO('billet',13)} Réserver sur Ryanair</a>
        </div>
        <div class="side"><span class="tag money" style="font-size:.85rem">${ICO('money',12)} ${esc(f.summary?.price?.value?.toFixed(2))} € A/R</span></div>
      </div>`;
    }).join('') + `<p class="hint">Prix réels au moment de la recherche, hors bagages/options. ${fares[0].summary?.price?.value ? 'Le moins cher : <strong>'+fares[0].summary.price.value.toFixed(2)+' € A/R</strong>.' : ''}</p>`;
    if(fares[0]?.summary?.price?.value){
      const v = +fares[0].summary.price.value.toFixed(0);
      state.cache.realPrice = `à partir de ${v} € A/R par personne (Ryanair, ${new Date().toLocaleDateString(LOC())})`;
      trackPrice(v, 'Ryanair');
      save();
    }
  }catch(e){
    zone.innerHTML = errHTML('API Ryanair injoignable (adblocker ? réseau ?). Réessaie ou passe par les liens Google Flights/Kayak au-dessus.');
  }
}

/* --- ✈️ Ryanair : calendrier des prix du mois (aller simple / jour) --- */
async function ryCalendar(){
  const zone = $('#zoneRy');
  const from = $('#ryFrom').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const to   = $('#ryTo').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const date = $('#ryDate').value || ryDefaultDate();
  if(from.length!==3 || to.length!==3){ toast('Renseigne 2 codes IATA'); return; }
  zone.innerHTML = loaderHTML('Chargement du calendrier des prix…');
  const month = date.slice(0,7) + '-01';
  try{
    const r = await fetch(`https://services-api.ryanair.com/farfnd/v4/oneWayFares/${from}/${to}/cheapestPerDay?outboundMonthOfDate=${month}&currency=EUR`);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const days = (d.outbound?.fares||[]).filter(f=>!f.unavailable && f.price);
    if(!days.length){ zone.innerHTML = errHTML(`Aucun vol ${from} → ${to} ce mois-ci (ligne non desservie ?).`); return; }
    const min = Math.min(...days.map(f=>f.price.value));
    zone.innerHTML = `<h3 style="margin-bottom:10px">${ICO('calendrier',17)} Aller simple ${esc(from)} → ${esc(to)} — ${new Date(month).toLocaleDateString(LOC(),{month:'long',year:'numeric'})}</h3>
      <div style="display:flex;flex-wrap:wrap;gap:7px">` +
      days.map(f=>{
        const best = f.price.value === min;
        return `<div style="min-width:74px;text-align:center;padding:9px 6px;border-radius:var(--r-md);border:2px solid ${best?'var(--ok)':'var(--stroke)'};background:${best?'rgba(34,197,94,.15)':'var(--secondary)'}">
          <div style="font-size:.68rem;color:var(--txt-2)">${esc(frDate(f.day))}</div>
          <div style="font-family:'Fraunces',Georgia,serif;font-weight:900;font-size:.9rem;color:${best?'var(--ok)':'var(--txt)'}">${f.price.value.toFixed(0)}€</div>
          ${f.soldOut?'<div style="font-size:.6rem;color:var(--danger)">complet</div>':''}
        </div>`;
      }).join('') +
      `</div><p class="hint">${ICO('coche',13)} = jour le moins cher du mois (${min.toFixed(2)} €, aller simple). Astuce : décale ton départ de 1-2 jours et économise gros.</p>`;
  }catch(e){
    zone.innerHTML = errHTML('Calendrier indisponible — API Ryanair injoignable.');
  }
}

/* --- 🌍 Aviasales (Travelpayouts) : prix réels TOUTES compagnies --- */
const AIRLINES = {
  AF:'Air France', U2:'easyJet', FR:'Ryanair', TO:'Transavia France', HV:'Transavia',
  VY:'Vueling', W6:'Wizz Air', W4:'Wizz Air Malta', LH:'Lufthansa', KL:'KLM', BA:'British Airways',
  IB:'Iberia', AZ:'ITA Airways', TP:'TAP Portugal', LX:'Swiss', OS:'Austrian', SN:'Brussels Airlines',
  EW:'Eurowings', SK:'SAS', AY:'Finnair', LO:'LOT', A3:'Aegean', PC:'Pegasus', TK:'Turkish Airlines',
  EK:'Emirates', QR:'Qatar Airways', EY:'Etihad', AT:'Royal Air Maroc', TU:'Tunisair', AH:'Air Algérie',
  DY:'Norwegian', D8:'Norwegian', EI:'Aer Lingus', UX:'Air Europa', EN:'Air Dolomiti', V7:'Volotea',
  XK:'Air Corsica', BF:'French Bee', SS:'Corsair', TX:'Air Caraïbes', ZB:'Air Albania', JU:'Air Serbia'
};
const airlineName = c => AIRLINES[c] || c || '—';

async function tpSearch(){
  const zone = $('#zoneRy');
  const token = tpKey();
  if(!token){
    zone.innerHTML = errHTML('Token Travelpayouts absent de config.js.');
    return;
  }
  const from = $('#ryFrom').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const to   = $('#ryTo').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const date = $('#ryDate').value || ryDefaultDate();
  const stay = +$('#ryStay').value;
  if(from.length<2 || to.length<2){ toast('Renseigne 2 codes IATA'); return; }
  zone.innerHTML = loaderHTML('Interrogation Aviasales — toutes compagnies…');
  const ret = addDays(date, stay);
  const base = `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=${from}&destination=${to}`
    + `&one_way=false&unique=false&sorting=price&direct=false&currency=eur&cy=eur&market=fr&limit=12&page=1&token=${encodeURIComponent(token)}`;
  try{
    /* 1er essai : dates précises · 2e essai : mois entier (le cache Aviasales est plus riche au mois) */
    let r = await fetch(`${base}&departure_at=${date}&return_at=${ret}`);
    let d = r.ok ? await r.json() : null;
    let broad = false;
    if(!d || !d.success || !(d.data||[]).length){
      broad = true;
      r = await fetch(`${base}&departure_at=${date.slice(0,7)}&return_at=${ret.slice(0,7)}`);
      d = r.ok ? await r.json() : null;
    }
    if(!d || d.success === false){
      const err = d?.error || '';
      zone.innerHTML = errHTML(/token/i.test(err) ? 'Token Travelpayouts invalide — vérifie dans ⚙.' : 'Aviasales : ' + (err || 'réponse invalide.'));
      return;
    }
    const rows = (d.data||[]).slice(0,10);
    if(!rows.length){
      zone.innerHTML = errHTML(`Aucun prix en cache pour ${from} → ${to}. L'API Aviasales sert les prix des recherches récentes des utilisateurs : essaie des codes VILLE (PAR, LON, ROM…) ou une grande ligne.`);
      return;
    }
    zone.innerHTML = `<h3 style="margin-bottom:10px">${ICO('monde',17)} Toutes compagnies — ${esc(from)} ⇄ ${esc(to)}${broad ? ' <span class="tag" style="margin-left:6px">mois entier</span>' : ''}</h3>` +
      rows.map((f,i)=>{
        const dep = f.departure_at, ret2 = f.return_at;
        const dd = dep ? dep.slice(8,10)+dep.slice(5,7) : '', rr = ret2 ? ret2.slice(8,10)+ret2.slice(5,7) : '';
        const link = f.link ? 'https://www.aviasales.com' + f.link : `https://www.aviasales.com/search/${from}${dd}${to}${rr}1`;
        const stops = (f.transfers||0) + (f.return_transfers||0);
        return `<div class="item">
          <div class="emo" style="display:flex;align-items:center">${i===0?ICO('trophee',20):`<img src="https://pics.avs.io/60/30/${esc(f.airline)}.png" alt="${esc(f.airline)}" style="height:20px;border-radius:4px" onerror="this.replaceWith('✈️')">`}</div>
          <div style="flex:1">
            <h4>${esc(airlineName(f.airline))} <span class="tag" style="margin-left:6px">${stops===0?'direct':stops+' escale'+(stops>1?'s':'')}</span></h4>
            <p>Aller ${esc(frDate(dep))} à ${esc(frTime(dep))}${ret2 ? ` · Retour ${esc(frDate(ret2))}` : ''} · vol ${esc(f.airline)}${esc(String(f.flight_number||''))}</p>
            <a class="tl-loc" href="${esc(link)}" target="_blank" rel="noopener" style="margin-top:8px">${ICO('billet',13)} Voir sur Aviasales</a>
          </div>
          <div class="side"><span class="tag money" style="font-size:.85rem">${ICO('money',12)} ${esc(String(f.price))} € A/R</span></div>
        </div>`;
      }).join('') +
      `<p class="hint">Prix issus du cache Aviasales (recherches réelles des dernières 48h, toutes compagnies confondues) — clique sur "Voir" pour le tarif à la seconde.</p>`;
    if(rows[0]?.price){
      state.cache.realPrice = `à partir de ${rows[0].price} € A/R par personne (toutes compagnies, ${new Date().toLocaleDateString(LOC())})`;
      trackPrice(+rows[0].price, 'toutes compagnies');
      save();
    }
  }catch(e){
    zone.innerHTML = errHTML('API Aviasales injoignable (adblocker ? réseau ?).');
  }
}

/* --- 🚄 Deutsche Bahn : horaires réels --- */
const DB_API = 'https://v6.db.transport.rest';
async function dbStation(q){
  const r = await fetch(`${DB_API}/locations?query=${encodeURIComponent(q)}&results=1&poi=false&addresses=false`);
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return d[0] || null;
}
async function dbSearch(){
  const zone = $('#zoneDb');
  const qFrom = $('#dbFrom').value.trim(), qTo = $('#dbTo').value.trim();
  const when = $('#dbWhen').value;
  if(!qFrom || !qTo){ toast('Renseigne les 2 gares'); return; }
  zone.innerHTML = loaderHTML('Recherche des gares…');
  try{
    const [a, b] = await Promise.all([dbStation(qFrom), dbStation(qTo)]);
    if(!a || !b){ zone.innerHTML = errHTML(`Gare introuvable : ${!a?qFrom:qTo}. Essaie le nom de la gare principale (ex : "Paris Est").`); return; }
    zone.innerHTML = loaderHTML(`${a.name} → ${b.name}…`);
    const dep = when ? new Date(when).toISOString() : new Date().toISOString();
    const r = await fetch(`${DB_API}/journeys?from=${a.id}&to=${b.id}&departure=${encodeURIComponent(dep)}&results=5&tickets=true&language=fr`);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const js = d.journeys || [];
    if(!js.length){ zone.innerHTML = errHTML('Aucun trajet trouvé dans le réseau DB pour cette liaison — passe par Trainline.'); return; }
    zone.innerHTML = `<h3 style="margin-bottom:10px">${ICO('train',17)} ${esc(a.name)} → ${esc(b.name)}</h3>` + js.map(j=>{
      const legs = (j.legs||[]).filter(l=>!l.walking);
      if(!legs.length) return '';
      const dep0 = legs[0], arrN = legs[legs.length-1];
      const durMs = new Date(arrN.arrival||arrN.plannedArrival) - new Date(dep0.departure||dep0.plannedDeparture);
      const dur = `${Math.floor(durMs/36e5)}h${String(Math.round(durMs%36e5/6e4)).padStart(2,'0')}`;
      const changes = legs.length - 1;
      const lines = legs.map(l=>l.line?.name).filter(Boolean).join(' → ');
      const price = j.price?.amount ? `${j.price.amount.toFixed(2)} ${j.price.currency==='EUR'?'€':j.price.currency}` : null;
      const delay = dep0.departureDelay ? Math.round(dep0.departureDelay/60) : 0;
      return `<div class="item">
        <div class="emo">${ICO('train',20)}</div>
        <div style="flex:1">
          <h4>${esc(frTime(dep0.departure||dep0.plannedDeparture))} → ${esc(frTime(arrN.arrival||arrN.plannedArrival))}
            <span class="tag cyan" style="margin-left:6px">⏱ ${dur}</span>
            <span class="tag" style="margin-left:4px">${changes===0?'direct':changes+' corresp.'}</span>
            ${delay>0?`<span class="tag money" style="margin-left:4px">${ICO('alerte',12)} +${delay} min</span>`:''}
          </h4>
          <p>${esc(lines)} · le ${esc(frDate(dep0.departure||dep0.plannedDeparture))}${dep0.departurePlatform?` · voie ${esc(dep0.departurePlatform)}`:''}</p>
        </div>
        ${price?`<div class="side"><span class="tag money">${ICO('money',12)} ${esc(price)}</span></div>`:''}
      </div>`;
    }).join('') + `<p class="hint">Horaires temps réel (retards inclus) via le réseau Deutsche Bahn. Les prix ne sont affichés que sur les liaisons vendues par DB.</p>`;
  }catch(e){
    zone.innerHTML = errHTML('API Deutsche Bahn injoignable (limite 100 req/min) — réessaie dans quelques secondes.');
  }
}

/* Délégation : les blocs sont re-rendus, donc handlers au niveau document */
document.addEventListener('click', e => {
  if(e.target.id === 'btnRyRT')  ryRoundTrip();
  if(e.target.id === 'btnRyCal') ryCalendar();
  if(e.target.id === 'btnTpAll') tpSearch();
  if(e.target.id === 'btnDb')    dbSearch();
});

/* ============================================================
   ÉTAPE 3 — DORMIR  (Gemini · heavy)
============================================================ */

async function loadStay(){
  const zone = $('#zoneStay');
  if(state.cache.stay){ renderStay(state.cache.stay); return; }
  zone.innerHTML = loaderHTML('Repérage des meilleurs quartiers…');
  const t = state.trip;
  const styp = $('#stayType').value, sprio = $('#stayPrio').value;
  const prompt = `Tu es Acolyte, expert voyage. ${ctx()}
Recommande où loger à ${t.nom} (${t.pays}) pour ce profil.
${state.cache.plan?.logement ? 'PLAN VALIDÉ — le voyageur a accepté : ' + state.cache.plan.logement.type + ' dans le quartier ' + state.cache.plan.logement.quartier + ' (~' + state.cache.plan.logement.prix_nuit + '). Mets ce quartier en premier et propose 2 alternatives.' : ''}
${styp ? 'Type de logement souhaité : ' + styp + '.' : ''}
${sprio ? 'Priorité du voyageur : ' + sprio + '.' : ''}
Réponds UNIQUEMENT en JSON :
{
 "quartiers":[
   {"nom":"...","emoji":"un emoji","pourquoi":"2 phrases : ambiance + pour qui c'est idéal","prix_nuit":"fourchette €/nuit réaliste","ideal_pour":"ex: couples, familles…"}
 ],
 "type_conseille":"1 phrase : hôtel / appart / auberge selon le profil et pourquoi",
 "conseils":["3 conseils réservation : quand réserver, arnaques à éviter, quartiers à éviter le soir si pertinent"]
}
Donne exactement 3 quartiers.`;
  try{
    const d = await gemini(prompt);
    state.cache.stay = d; save();
    renderStay(d);
  }catch(e){
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Recherche logement impossible pour le moment.');
  }
}

function renderStay(d){
  if(!$('#zoneStay')) return;            /* panneau non affiché */
  const t = state.trip;
  const booking = q => `https://www.booking.com/searchresults.fr.html?ss=${encodeURIComponent(q)}`;
  const airbnb  = q => `https://www.airbnb.fr/s/${encodeURIComponent(q)}/homes`;
  const hostel  = q => `https://www.hostelworld.com/s?q=${encodeURIComponent(q)}`;
  $('#zoneStay').innerHTML = `
    <div class="item"><div class="emo">${ICO('cible',20)}</div><p style="margin-top:4px"><strong>Le bon plan pour toi :</strong> ${esc(d.type_conseille)}</p></div>
    <h3 style="margin:16px 0 10px">Les 3 quartiers où viser</h3>
    ${(d.quartiers||[]).map(q=>`
      <div class="item">
        <div class="emo">${ICO('quartier',20)}</div>
        <div style="flex:1">
          <h4>${esc(q.nom)} <span class="tag" style="margin-left:6px">${esc(q.ideal_pour||'')}</span></h4>
          <p>${esc(q.pourquoi)}</p>
          <div class="row" style="margin-top:9px">
            <a class="btn sm" href="${booking(q.nom + ', ' + t.nom)}" target="_blank" rel="noopener">Booking</a>
            <a class="btn sm ghost" href="${airbnb(q.nom + ', ' + t.nom)}" target="_blank" rel="noopener">Airbnb</a>
          </div>
        </div>
        <div class="side"><span class="tag money">${ICO('money',13)} ${esc(q.prix_nuit)}</span></div>
      </div>`).join('')}
    <h3 style="margin:16px 0 8px">Conseils réservation</h3>
    ${(d.conseils||[]).map(c=>`<div class="item"><div class="emo">${ICO('ampoule',20)}</div><p style="margin-top:4px">${esc(c)}</p></div>`).join('')}
    <div class="divider"></div>
    <div class="row">
      <a class="btn" href="${booking(t.nom)}" target="_blank" rel="noopener">${ICO('hotel',15)} Booking</a>
      <a class="btn ghost" href="${airbnb(t.nom)}" target="_blank" rel="noopener">Airbnb</a>
      <a class="btn ghost" href="${hostel(t.nom)}" target="_blank" rel="noopener">Hostelworld</a>
    </div>`;
}

/* ============================================================
   ÉTAPE 4 — SUR PLACE
============================================================ */

/* ⚠️ CE CHEMIN ÉTAIT CASSÉ EN PRODUCTION. setMap() écrivait dans un
   `<iframe id="mapFrame">` retiré lors du passage à la carte maison — donc
   `$('#mapFrame').src = …` levait une TypeError, et la ligne suivante en levait
   une seconde sur scrollIntoView. Or [data-loc], c'est le « 📍 Carte » de
   CHAQUE étape de chaque journée, plus les restaurants et les spécialités :
   un des contrôles les plus cliqués du site.
   On route maintenant vers la carte du projet, qui existe et connaît déjà les
   lieux du voyage. Si le lieu n'y figure pas encore, on bascule quand même sur
   l'onglet Carte : mieux vaut y arriver et chercher que rester sur une erreur. */
function ouvreLieuSurCarte(nom){
  const bouton = document.querySelector('.catnav [data-cat="map"]');
  if(bouton) bouton.click();
  const map = (typeof mapEngine === 'function') ? mapEngine() : null;
  if(!map) return false;
  /* On cherche le lieu parmi les repères déjà posés par buildProjectMap. */
  const cible = String(nom || '').toLowerCase().trim();
  const marques = Array.isArray(window._projMarks) ? window._projMarks : [];
  const i = marques.findIndex(m => String(m && (m.nom || m.titre) || '').toLowerCase().includes(cible));
  if(i >= 0 && marques[i].lat != null){
    map.panTo(marques[i].lat, marques[i].lon, 15);
    try{ map.openMark(i); }catch(e){}
    return true;
  }
  return false;
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-loc]');
  if(!el) return;
  const nom = el.dataset.loc;
  const trouve = ouvreLieuSurCarte(nom);
  toast(trouve ? '📍 ' + nom : '📍 ' + nom + ' — cherche-le sur la carte');
});

/* --- sous-onglets --- */
const TAB_PANELS = {iti:'#pIti', food:'#pFood', shop:'#pShop', spec:'#pSpec', bag:'#pBag', talk:'#pTalk', bud:'#pBud', info:'#pInfo', act:'#pAct', tools:'#pTools', note:'#pNote'};
$$('.subtab').forEach(el => el.onclick = () => {
  $$('.subtab').forEach(x=>x.classList.remove('on')); el.classList.add('on');
  Object.entries(TAB_PANELS).forEach(([k,sel]) => $(sel).classList.toggle('hidden', k !== el.dataset.t));
});

/* ============================================================
   ITINÉRAIRE (Gemini · heavy)
============================================================ */

/* ============================================================
   JOURNÉE HEURE PAR HEURE — modifiable et réorganisable
   ------------------------------------------------------------
   Le programme d'Acolyte est un point de départ, pas un ordre : le voyageur
   doit pouvoir déplacer un moment, corriger une heure, en ajouter un ou en
   retirer un. Tout est écrit dans state.cache.days[jour].etapes et sauvé.
   ⚠️ Comme les commentaires (_comDrafts), la saisie en cours DOIT survivre à
   un changement d'onglet : c'est une régression déjà vécue sur ce projet.
============================================================ */
/* ⚠️ Cette table stocke des CLES du registre d'icones, plus des glyphes.
   Elle sert a DEUX endroits qui n'ont pas les memes contraintes : la frise
   d'une journee, ou l'icone se dessine, et un <option> de formulaire, qui
   ne peut PAS contenir de SVG — la liste deroulante n'y montre donc que le
   mot, ce qui suffit puisqu'il est deja explicite. */
const TL_TYPES = { visite:'monument', repas:'assiette', pause:'cafe', trajet:'pied' };
let _tlEdit = null;                 /* { jour, i } — moment en cours d'édition */
const _tlDraft = {};                /* saisie en cours, par « jour:index:champ » */
const tlDraftKey = (jour, i, champ) => `${jour}:${i}:${champ}`;
/* valeur à afficher dans le champ : le brouillon s'il existe, sinon la donnée */
function tlVal(jour, i, champ, e){
  const k = tlDraftKey(jour, i, champ);
  return Object.prototype.hasOwnProperty.call(_tlDraft, k) ? _tlDraft[k] : (e?.[champ] ?? '');
}
function tlEtapes(jour){
  return state.cache.days?.[jour]?.etapes || null;
}
/* Formulaire d'un moment en cours de modification */
function tlFormHTML(jour, i, e){
  const T = isEN()
    ? { h:'Time', t:'What', d:'Details', l:'Place (for the map)', ok:'✅ Save', no:'Cancel', ty:'Kind', p:'Entry price' }
    : { h:'Heure', t:'Quoi', d:'Détails', l:'Lieu (pour la carte)', ok:'✅ Enregistrer', no:'Annuler', ty:'Genre', p:'Prix d’entrée' };
  const opts = Object.keys(TL_TYPES).map(k =>
    `<option value="${k}"${tlVal(jour, i, 'type', e) === k ? ' selected' : ''}>${k}</option>`).join('');
  return `<div class="tl-form" data-tlform="${i}">
    <div class="tl-fr">
      <label>${T.h}<input type="time" data-tlinp="heure" value="${esc(tlVal(jour, i, 'heure', e))}"></label>
      <label>${T.ty}<select data-tlinp="type">${opts}</select></label>
    </div>
    <label>${T.t}<input type="text" maxlength="80" data-tlinp="titre" value="${esc(tlVal(jour, i, 'titre', e))}"></label>
    <label>${T.d}<textarea rows="2" maxlength="300" data-tlinp="description">${esc(tlVal(jour, i, 'description', e))}</textarea></label>
    <div class="tl-fr">
      <label>${T.l}<input type="text" maxlength="80" data-tlinp="lieu" value="${esc(tlVal(jour, i, 'lieu', e))}"></label>
      <label>${T.p}<input type="text" maxlength="24" data-tlinp="prix" placeholder="${
        isEN() ? '18 € · free' : '18 € · gratuit'}" value="${esc(tlVal(jour, i, 'prix', e))}"></label>
    </div>
    <div class="tl-fbtn">
      <button class="btn sm" data-tlsave="${i}">${T.ok}</button>
      <button class="btn sm ghost" data-tlcancel="${i}">${T.no}</button>
    </div>
  </div>`;
}
/* ============================================================
   LE TRAJET ENTRE DEUX MOMENTS
   ------------------------------------------------------------
   Les positions sont DÉJÀ relevées (state.cache.plan._geo, rempli par
   ensurePlanGeo). Il ne manquait qu'une soustraction pour dire ce que la
   relecture croisée cherche à deviner par le raisonnement : une journée qui
   traverse la ville en zigzag se voit d'un coup d'œil quand chaque saut porte
   sa durée.

   ⚠️ On n'affiche RIEN si l'une des deux positions manque. Inventer « 15 min »
   entre deux lieux qu'on ne sait pas situer serait pire que le silence : le
   voyageur s'y fierait.

   ⚠️ Le facteur 1,35 sur la distance à vol d'oiseau approche le trajet réel en
   ville — les rues ne sont pas droites. Au-delà de 45 min, on conseille un
   transport plutôt que d'annoncer une heure et demie de marche.
============================================================ */
/* ============================================================
   LE PRIX D'ENTRÉE D'UNE VISITE
   ------------------------------------------------------------
   ⚠️ Un tarif vient d'un modèle : il peut être périmé, et personne ne doit
   réserver sur cette base. On l'affiche donc comme une INDICATION, jamais
   comme un prix ferme — et le total de la journée porte le même avertissement.

   On distingue trois cas, et le troisième compte autant que les autres :
   · un tarif → on l'affiche ;
   · « gratuit » → on le dit, c'est une information utile ;
   · rien → on n'affiche rien. Un repas n'a pas de prix d'entrée, et inventer
     « — € » ferait croire à une donnée manquante alors qu'elle n'a pas lieu.
============================================================ */
function tlPrixHTML(e){
  const p = String(e?.prix || '').trim();
  if(!p) return '';
  if(/^(gratuit|free|0\s*€?)$/i.test(p))
    return `<span class="tl-prix tl-gratuit">${isEN() ? 'free' : 'gratuit'}</span>`;
  return `<span class="tl-prix">${esc(p.slice(0, 24))}</span>`;
}
/* Total du jour : on additionne ce qui est chiffrable. ⚠️ Sur une fourchette
   « 12-16 € », on retient le BAS : annoncer le minimum et se tromper vers le
   haut est moins grave que l'inverse, où le voyageur se retrouve à court. */
function tlTotalHTML(etapes){
  if(!Array.isArray(etapes)) return '';
  let somme = 0, n = 0, incertain = false;
  for(const e of etapes){
    const p = String(e?.prix || '').trim();
    if(!p || /^(gratuit|free)$/i.test(p)) continue;
    const nums = p.replace(',', '.').match(/\d+(?:\.\d+)?/g);
    if(!nums) continue;
    somme += parseFloat(nums[0]);
    if(nums.length > 1) incertain = true;      /* c'était une fourchette */
    n++;
  }
  if(!n) return '';
  const EN = isEN();
  return `<p class="tl-total">${ICO('money',13)} ${EN ? 'Entries this day' : 'Entrées de la journée'} :
    <b>${incertain ? '≈ ' : ''}${somme.toLocaleString(LOC())} €</b>
    <span>${EN ? 'per adult · indicative, check before booking'
                : 'par adulte · à titre indicatif, vérifie avant de réserver'}</span></p>`;
}

function tlTrajetHTML(etapes, i){
  if(i === 0 || !Array.isArray(etapes)) return '';
  const geo = state.cache.plan?._geo || {};
  const nom = (e) => e && (e.lieu || e.titre);
  const a = geo[nom(etapes[i - 1])], b = geo[nom(etapes[i])];
  if(!a || !b) return '';
  const km = havKm({ latitude:a[0], longitude:a[1] }, { latitude:b[0], longitude:b[1] });
  if(km < 0.05) return '';                      /* même endroit : rien à dire */
  /* ⚠️ Le mode vient des PRÉFÉRENCES : quelqu'un qui loue une voiture n'a rien
     à faire d'un temps de marche, et à vélo « 45 min » n'a pas le même sens.
     La distance ne change pas, la durée et le seuil d'alerte si. */
  const M = surPlaceActuel();
  const reel = km * M.detour;
  const min = Math.round(reel / M.kmh * 60);
  const EN = isEN();
  /* ⚠️ toLocaleString et non toFixed : « 1.2 km » avec un point est de l'anglais.
     En français le séparateur décimal est la virgule, et LOC() suit la langue
     choisie dans l'app. */
  const kmTxt = reel.toLocaleString(LOC(), { minimumFractionDigits:1, maximumFractionDigits:1 });
  const dist = reel < 1 ? Math.round(reel * 1000) + ' m' : kmTxt + ' km';
  /* Le seuil d'alerte suit le mode : 45 min de marche est beaucoup, 45 min de
     voiture entre deux visites d'une même journée est absurde. */
  const seuil = SET?.surPlace === 'pied' ? 45 : 30;
  let txt, cls = '';
  if(min <= seuil){
    txt = `${min} min · ${dist}`;
  }else{
    /* ⚠️ Au-delà du seuil, on le SIGNALE : c'est le symptôme d'une journée mal
       regroupée, et c'est précisément ce qu'on veut rendre visible. */
    cls = ' tl-loin';
    txt = `${min} min · ${dist} — ${EN ? 'that is far for one day' : 'c’est loin pour une même journée'}`;
  }
  /* ⚠️ L'icône est posée HORS de esc() : le texte reste échappé (il vient de
     données), et le SVG n'est pas transformé en entités. Les mélanger dans une
     même chaîne échappée est exactement ce qui affichait « &lt;svg… ». */
  return `<div class="tl-trajet${cls}">${ICO(M.ico, 15)} ${esc(txt)}</div>`;
}

function timelineHTML(d, jour){
  const ed = jour != null;          /* pas de boutons si on n'est pas dans une journée */
  const n = (d.etapes || []).length;
  const T = isEN()
    ? { up:'Move earlier', dn:'Move later', mod:'Edit', del:'Remove', add:'Add a moment', map:'See on the map', vide:'This day is empty — add a first moment.' }
    : { up:'Monter', dn:'Descendre', mod:'Modifier', del:'Retirer', add:'Ajouter un moment', map:'Voir sur la carte', vide:'Journée vide — ajoute un premier moment.' };
  const items = (d.etapes || []).map((e, i) => {
    if(ed && _tlEdit && String(_tlEdit.jour) === String(jour) && _tlEdit.i === i)
      return `<div class="tl-item tl-editing">${tlFormHTML(jour, i, e)}</div>`;
    return `<div class="tl-item">
      ${tlTrajetHTML(d.etapes, i)}
      <div class="tl-time">${esc(e.heure || '')} ${ICO(TL_TYPES[e.type] || 'epingle', 14)}</div>
      <div class="tl-title">${esc(e.titre || '')}${tlPrixHTML(e)}</div>
      <div class="tl-desc">${esc(e.description || '')}</div>
      ${e.lieu ? `<span class="tl-loc" data-loc="${esc(e.lieu)}">${ICO('epingle',13)} ${T.map}</span>` : ''}
      ${ed ? `<div class="tl-acts">
        <button class="tl-act" data-tlup="${i}" title="${T.up}" aria-label="${T.up}"${i === 0 ? ' disabled' : ''}>▲</button>
        <button class="tl-act" data-tldn="${i}" title="${T.dn}" aria-label="${T.dn}"${i === n - 1 ? ' disabled' : ''}>▼</button>
        <button class="tl-act" data-tlmod="${i}" title="${T.mod}" aria-label="${T.mod}">${ICO('crayon',14)}</button>
        <button class="tl-act tl-danger" data-tldel="${i}" title="${T.del}" aria-label="${T.del}">${ICO('poubelle',14)}</button>
      </div>` : ''}
    </div>`;
  }).join('');
  return `<div class="timeline">${items || (ed ? `<p class="hint" style="margin:0 0 10px">${T.vide}</p>` : '')}</div>`
    + tlTotalHTML(d.etapes)
    + (ed ? `<button class="btn sm ghost tl-add" data-tladd="${esc(String(jour))}">${ICO('plus',14)} ${T.add}</button>` : '');
}
/* Re-rend UNIQUEMENT la journée concernée : re-rendre tout le plan perdrait
   les autres journées dépliées et les commentaires en cours de frappe. */
function tlRender(jour){
  const box = document.querySelector(`[data-daybox="${jour}"]`);
  const d = state.cache.days?.[jour];
  if(box && d) box.innerHTML = timelineHTML(d, jour);
}
function tlSwap(jour, i, j){
  const et = tlEtapes(jour);
  if(!et || !et[i] || !et[j]) return;
  /* ⚠️ LES HEURES RESTENT À LEUR PLACE, seul le contenu se déplace.
     Avant, l'échange emportait l'objet ENTIER — donc son heure. Déplacer une
     étape de 09:00 sous une étape de 11:00 produisait « 11:00 » puis « 09:00 » :
     la journée cessait d'être chronologique, et les trajets calculés entre deux
     étapes devenaient absurdes. C'est précisément l'incohérence géographique
     qu'on veut éviter.
     Un créneau appartient à la POSITION dans la journée, pas à l'activité :
     échanger le musée et le déjeuner doit donner « le déjeuner à 09:00, le musée
     à 11:00 », pas remonter 11:00 avant 09:00. */
  const hi = et[i].heure, hj = et[j].heure;
  [et[i], et[j]] = [et[j], et[i]];
  et[i].heure = hi; et[j].heure = hj;
  save();
  tlRender(jour);
  /* Les trajets et la carte dépendent de l'ordre : sans ça, la carte garde
     l'ancien tracé et le temps de marche annoncé ne correspond plus à rien. */
  try{ buildProjectMap(); }catch(e){}
}
document.addEventListener('click', e => {
  const box = e.target.closest('[data-daybox]');
  if(!box) return;
  const jour = box.dataset.daybox;
  const et = tlEtapes(jour);
  const up = e.target.closest('[data-tlup]');
  if(up && et){ tlSwap(jour, +up.dataset.tlup, +up.dataset.tlup - 1); return; }
  const dn = e.target.closest('[data-tldn]');
  if(dn && et){ tlSwap(jour, +dn.dataset.tldn, +dn.dataset.tldn + 1); return; }
  const mod = e.target.closest('[data-tlmod]');
  if(mod){ _tlEdit = { jour, i:+mod.dataset.tlmod }; tlRender(jour); return; }
  const cancel = e.target.closest('[data-tlcancel]');
  if(cancel){
    /* on abandonne la saisie : les brouillons de CE moment sont effacés */
    for(const k of Object.keys(_tlDraft)) if(k.startsWith(`${jour}:${cancel.dataset.tlcancel}:`)) delete _tlDraft[k];
    _tlEdit = null; tlRender(jour); return;
  }
  const save2 = e.target.closest('[data-tlsave]');
  if(save2 && et){
    const i = +save2.dataset.tlsave;
    const form = save2.closest('.tl-form');
    const lu = {};
    form?.querySelectorAll('[data-tlinp]').forEach(inp => { lu[inp.dataset.tlinp] = inp.value.trim(); });
    /* ⚠️ « prix » se lit avec ?? et non || : une chaîne VIDE est un choix
       délibéré (« ce moment n'a pas de tarif »), et || l'écraserait par
       l'ancienne valeur — on ne pourrait jamais effacer un prix erroné. */
    et[i] = { ...et[i], heure: lu.heure || et[i].heure, titre: lu.titre || et[i].titre,
              description: lu.description || '', lieu: lu.lieu || null, type: lu.type || et[i].type,
              prix: lu.prix ?? et[i].prix ?? '' };
    for(const k of Object.keys(_tlDraft)) if(k.startsWith(`${jour}:${i}:`)) delete _tlDraft[k];
    _tlEdit = null; save(); tlRender(jour);
    toast(isEN() ? '✔ Moment updated' : '✔ Moment mis à jour');
    return;
  }
  const del = e.target.closest('[data-tldel]');
  if(del && et){
    const i = +del.dataset.tldel;
    const nom = String(et[i]?.titre || '').slice(0, 60);
    if(!confirm(isEN() ? `Remove “${nom}” from this day?` : `Retirer « ${nom} » de cette journée ?`)) return;
    /* Ce qu'on retire en dit plus que ce qu'on garde : voir goutsCtx(). */
    try{ goutsNote(nom, et[i]?.type); }catch(e){}
    et.splice(i, 1);
    _tlEdit = null; save(); tlRender(jour);
    return;
  }
  const add = e.target.closest('[data-tladd]');
  if(add){
    state.cache.days = state.cache.days || {};
    const d = state.cache.days[jour] = state.cache.days[jour] || { etapes: [] };
    d.etapes = d.etapes || [];
    /* on part de l'heure du dernier moment + 1 h : le plus souvent, on ajoute
       à la suite. C'est modifiable juste après, le formulaire s'ouvre. */
    const last = d.etapes[d.etapes.length - 1]?.heure || '09:00';
    const h = Math.min(23, (parseInt(String(last).slice(0, 2), 10) || 9) + 1);
    d.etapes.push({ heure: String(h).padStart(2, '0') + ':00',
                    titre: isEN() ? 'New moment' : 'Nouveau moment',
                    description: '', lieu: null, type: 'visite' });
    _tlEdit = { jour, i: d.etapes.length - 1 };
    save(); tlRender(jour);
    return;
  }
});
/* la saisie en cours est mémorisée à chaque frappe → elle survit à un
   changement d'onglet, comme les commentaires */
document.addEventListener('input', e => {
  const inp = e.target.closest('[data-tlinp]');
  if(!inp) return;
  const box = inp.closest('[data-daybox]');
  const form = inp.closest('[data-tlform]');
  if(!box || !form) return;
  _tlDraft[tlDraftKey(box.dataset.daybox, form.dataset.tlform, inp.dataset.tlinp)] = inp.value;
});


/* --- tout le séjour d'un coup --- */
function daysFromPrefs(){
  const d = (state.prefs?.days || '').toLowerCase();
  if(d.includes('week-end')) return 3;
  if(d.includes('deux')) return 14;
  if(d.includes('trois')) return 14;
  return 7;
}

/* ⚠️ Délégué : le bouton est fabriqué par sejourCompletHTML() à chaque rendu
   du panneau Programme. Un écouteur posé au chargement ne trouverait rien —
   c'est exactement ce qui rendait ce générateur inerte. */
document.addEventListener('click', async e => {
  if(!e.target.closest || !e.target.closest('#btnItiAll')) return;
  const zone = $('#zoneItiAll');
  const t = state.trip;
  const n = Math.min(daysFromPrefs(), 10);
  zone.innerHTML = loaderHTML(`Planification des ${n} jours… (ça peut prendre ~30s)`);
  $('#btnItiAll').disabled = true;
  const pace = $('#itiPace').value, move = $('#itiMove').value;
  const prompt = `Tu es Acolyte, guide local expert de ${t.nom} (${t.pays}). ${ctx()}
Construis le programme COMPLET du séjour sur ${n} jours. Rythme : ${pace}. Déplacements : ${move}.
Chaque jour a un thème différent, sans répéter les lieux. Jour 1 = incontournables. Prévois une demi-journée détente vers le milieu.
Réponds UNIQUEMENT en JSON :
{
 "jours":[
   {"jour":1,"titre":"thème","etapes":[{"heure":"09:00","titre":"...","description":"1 phrase concrète","lieu":"lieu précis ou null","type":"visite|repas|pause|trajet","prix":"tarif d'entrée RÉEL par adulte, ex : « 18 € » ou « 12-16 € ». Écris « gratuit » quand ça l'est vraiment, et une chaîne VIDE pour un repas, une pause ou un trajet — on ne devine pas l'addition d'un restaurant."}]}
 ]
}
4 à 6 étapes par jour, pour rester lisible.`;
  try{
    const d = await gemini(prompt, true, 8192);
    state.cache.fullPlan = d; save();
    renderFullPlan(d);
  }catch(e){
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Trop gros pour cette fois — réessaie ou génère jour par jour.');
  }
  $('#btnItiAll').disabled = false;
});

function renderFullPlan(d){
  if(!$('#zoneItiAll')) return;            /* panneau non affiché */
  $('#zoneItiAll').innerHTML = `<div class="divider"></div><h3 style="margin-bottom:12px">${ICO('calendrier',17)} Ton séjour complet</h3>` +
    (d.jours||[]).map((j,i)=>`
      <div class="acc ${i===0?'open':''}">
        <div class="acc-head" data-acc>
          Jour ${esc(j.jour)} — ${esc(j.titre)} <span class="arr">›</span>
        </div>
        <div class="acc-body">${timelineHTML(j)}</div>
      </div>`).join('');
}

/* ============================================================
   RESTOS (Gemini · heavy — connaissance locale précise)
============================================================ */

async function loadFood(){
  const zone = $('#zoneFood');
  if(state.cache.food){ renderFood(state.cache.food); return; }
  zone.innerHTML = loaderHTML('Je cherche les bonnes tables du quartier…');
  const t = state.trip;
  const fb = $('#foodBud').value, ft = $('#foodType').value;

  /* On ancre l'IA sur des adresses qui EXISTENT (relevé OpenStreetMap du
     quartier). Sans ça elle produit des noms plausibles mais fantômes. */
  let foodCtx = '', osmRows = [];
  try{
    const q = state.cache.plan?.logement?.quartier;
    const g = (q && await geoPlace(`${q} ${t.nom}`, ccFor(t.pays))) || await geoPlace(cleanPlace(t.nom), ccFor(t.pays));
    if(g){
      osmRows = await osmFood(+g.latitude, +g.longitude);
      foodCtx = osmFoodCtx(osmRows);
    }
  }catch(e){}

  const prompt = `Tu es Acolyte, fin connaisseur des bonnes tables de ${t.nom} (${t.pays}). ${ctx()}${foodCtx}
${fb ? 'Budget souhaité : ' + fb + '.' : ''}
${ft ? 'Envie : ' + ft + '.' : ''}
OBJECTIF : des adresses où l'on mange BIEN sans payer le prix touristique.
${alimDur()}RÈGLES :
- Écarte les terrasses des rues très touristiques et les abords immédiats des monuments.
- Privilégie les endroits où mangent les habitants : cuisine locale, salle modeste, menu du midi.
- Donne une fourchette de prix CHIFFRÉE et réaliste (ex : « 12–18 € le plat »), jamais « pas cher ».
- Le « pourquoi » doit être concret et vérifiable (ex : « menu du midi à 14 €, cantine de quartier »), jamais un adjectif creux.
${osmRows.length ? '- N\'INVENTE AUCUN NOM : choisis uniquement dans la liste réelle ci-dessus et recopie le nom exactement.' : '- Ne cite que des établissements dont tu es certain qu\'ils existent encore.'}
Réponds UNIQUEMENT en JSON :
{"restos":[
 {"nom":"nom exact","emoji":"1 emoji plat","style":"ex: trattoria de quartier","plat_star":"le plat à commander","budget":"fourchette chiffrée, ex 12–18 € le plat","quartier":"quartier","pourquoi":"1 phrase concrète et vérifiable"}
]}
Exactement 5 adresses VARIÉES (gammes et cuisines différentes).`;
  try{
    const d = await gemini(prompt);
    /* garde-fou : si l'IA a inventé un nom absent du relevé, on l'écarte */
    if(osmRows.length && Array.isArray(d?.restos)){
      const reels = new Set(osmRows.map(r => r.nom.toLowerCase()));
      const gardes = d.restos.filter(r => r && r.nom && reels.has(String(r.nom).toLowerCase()));
      if(gardes.length) d.restos = gardes;
    }
    d._verifies = osmRows.length > 0;
    state.cache.food = d; save();
    renderFood(d);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Impossible de charger les adresses pour le moment.', 'food'); }
}
_retryFns.food = () => { delete state.cache.food; save(); loadFood(); };
function renderFood(d){
  if(!$('#zoneFood')) return;            /* panneau non affiché */
  const t = state.trip;
  const rows = d.restos || [];
  if(!rows.length){
    $('#zoneFood').innerHTML = `<p class="hint" style="margin:0">Aucune adresse trouvée pour ce quartier — essaie une autre envie.</p>`;
    return;
  }
  $('#zoneFood').innerHTML = rows.map(r=>`
    <div class="resto-card">
      <div class="rc-top">
        <span class="rc-emo">${ICO('assiette',20)}</span>
        <div class="rc-id">
          <h4>${esc(r.nom)}</h4>
          <div class="rc-meta">${r.style ? esc(r.style) : ''}${r.quartier ? ' · ' + ICO('epingle',12) + ' ' + esc(r.quartier) : ''}</div>
        </div>
        <span class="rc-price">${esc(r.budget || '—')}</span>
      </div>
      ${r.plat_star ? `<p class="rc-dish">${ICO('assiette',13)} À commander : <strong>${esc(r.plat_star)}</strong></p>` : ''}
      ${r.pourquoi ? `<p class="rc-why">${esc(r.pourquoi)}</p>` : ''}
      <div class="rc-acts">
        <span class="tl-loc" data-loc="${esc(r.nom)}">${ICO('epingle',13)} Voir sur la carte</span>
        <a class="tl-loc" href="https://www.google.com/maps/search/${encodeURIComponent(r.nom + ' ' + t.nom)}" target="_blank" rel="noopener">↗ Avis &amp; horaires</a>
      </div>
    </div>`).join('')
    + `<p class="hint" style="margin-top:12px">${d._verifies
        ? ICO('coche',13) + ' Adresses <strong>relevées sur OpenStreetMap</strong> : elles existent bel et bien. Acolyte a choisi parmi elles.'
        : 'Sélection d\'Acolyte — vérifie les horaires avant de t\'y rendre.'} Les avis se consultent en un clic.</p>`;
}

/* ============================================================
   COURSES (light → Groq)
============================================================ */
async function loadShop(){
  const zone = $('#zoneShop');
  if(state.cache.shop){ renderShop(state.cache.shop, state.cache.shopVia); return; }
  zone.innerHTML = loaderHTML('Repérage des supermarchés…');
  const t = state.trip;
  const prompt = `Tu es Acolyte, expert du quotidien à ${t.nom} (${t.pays}). ${ctx()}
Réponds UNIQUEMENT en JSON :
{
 "supermarches":[{"nom":"chaîne réelle du pays","niveau":"discount|standard|premium","astuce":"1 phrase utile (horaires, ce qu'on y trouve, prix)"}],
 "marches":[{"nom":"marché local réel","quand":"jours/horaires","pourquoi":"1 phrase"}],
 "budget_conseils":["3 conseils concrets pour manger pas cher sur place"]
}
3 supermarchés, 1-2 marchés.`;
  try{
    const {data, via} = await ai('light', prompt);
    state.cache.shop = data; state.cache.shopVia = via; save();
    renderShop(data, via);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderShop(d, via){
  if(!$('#zoneShop')) return;            /* panneau non affiché */
  const lvl = {discount:'💸 Discount', standard:'🛒 Standard', premium:'✨ Premium'};
  $('#zoneShop').innerHTML = `
    <h3 style="margin-bottom:10px">Supermarchés ${badge(via)}</h3>
    ${(d.supermarches||[]).map(s=>`
      <div class="item"><div class="emo">${ICO('panier',20)}</div>
        <div style="flex:1"><h4>${esc(s.nom)} <span class="tag cyan" style="margin-left:6px">${lvl[s.niveau]||esc(s.niveau)}</span></h4><p>${esc(s.astuce)}</p></div>
        <div class="side"><span class="tl-loc" data-loc="${esc(s.nom)}" aria-label="Voir sur la carte">${ICO('epingle',14)}</span></div>
      </div>`).join('')}
    <h3 style="margin:14px 0 10px">Marchés locaux</h3>
    ${(d.marches||[]).map(m=>`
      <div class="item"><div class="emo">${ICO('panier',20)}</div>
        <div style="flex:1"><h4>${esc(m.nom)}</h4><p>${esc(m.pourquoi)} · <strong>${esc(m.quand)}</strong></p></div>
        <div class="side"><span class="tl-loc" data-loc="${esc(m.nom)}" aria-label="Voir sur la carte">${ICO('epingle',14)}</span></div>
      </div>`).join('')}
    <h3 style="margin:14px 0 10px">Manger malin</h3>
    ${(d.budget_conseils||[]).map(c=>`<div class="item"><div class="emo">${ICO('ampoule',20)}</div><p style="margin-top:4px">${esc(c)}</p></div>`).join('')}`;
}

/* ============================================================
   SPÉCIALITÉS (light → Groq)
============================================================ */
async function loadSpec(){
  const zone = $('#zoneSpec');
  if(state.cache.spec){ renderSpec(state.cache.spec, state.cache.specVia); return; }
  zone.innerHTML = loaderHTML('Enquête gourmande…');
  const t = state.trip;
  const prompt = `Tu es Acolyte, passionné de gastronomie de ${t.nom} (${t.pays}). ${ctx()}
Réponds UNIQUEMENT en JSON :
{
 "specialites":[{"nom":"plat/produit local","emoji":"1 emoji","description":"c'est quoi, en 1-2 phrases appétissantes","ou_gouter":"type d'endroit ou lieu précis","prix":"fourchette locale"}],
 "conseils_locaux":["3-4 conseils culture food locale : usages à table, pourboire, horaires des repas, pièges à touristes"]
}
5-6 spécialités emblématiques.`;
  try{
    const {data, via} = await ai('light', prompt);
    state.cache.spec = data; state.cache.specVia = via; save();
    renderSpec(data, via);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderSpec(d, via){
  if(!$('#zoneSpec')) return;            /* panneau non affiché */
  $('#zoneSpec').innerHTML = `
    <div style="margin-bottom:10px">${badge(via)}</div>
    ${(d.specialites||[]).map(s=>`
      <div class="item"><div class="emo">${ICO('assiette',20)}</div>
        <div style="flex:1"><h4>${esc(s.nom)}</h4><p>${esc(s.description)}<br><strong>Où :</strong> ${esc(s.ou_gouter)}</p></div>
        <div class="side"><span class="tag money">${esc(s.prix)}</span></div>
      </div>`).join('')}
    <h3 style="margin:14px 0 10px">Les codes locaux ${ICO('poignee',17)}</h3>
    ${(d.conseils_locaux||[]).map(c=>`<div class="item"><div class="emo">${ICO('ampoule',20)}</div><p style="margin-top:4px">${esc(c)}</p></div>`).join('')}`;
}

/* ============================================================
   VALISE (light → Groq) — checklist persistée
============================================================ */
async function loadBag(){
  const zone = $('#zoneBag');
  if(state.cache.bag){ renderBag(state.cache.bag, state.cache.bagVia); return; }
  zone.innerHTML = loaderHTML('Préparation de ta checklist…');
  const t = state.trip;
  const R = state.cache._real || {};
  const d = stayDates();
  const nuits = d ? Math.max(1, Math.round((new Date(d.out) - new Date(d.in)) / 86400000)) : null;
  const prompt = `Tu es Acolyte. ${ctx()}
Génère la checklist valise idéale pour ce voyage à ${t.nom} (${t.pays}).
${R.meteo ? `MÉTÉO RÉELLE MESURÉE (adapte les vêtements À CES CHIFFRES, ne les contredis pas) : ${R.meteo}` : ''}
${nuits ? `DURÉE EXACTE : ${nuits} nuit(s) — dimensionne les quantités (nombre de t-shirts, sous-vêtements…) sur cette durée précise.` : ''}
${state.cache.plan?.programme?.length ? `PROGRAMME PRÉVU (prévois les tenues adaptées) : ${state.cache.plan.programme.map(j => j.resume).join(' | ')}` : ''}
${state.prefs?.kids ? `Voyage AVEC ${state.prefs.kids} enfant(s) : ajoute le nécessaire.` : ''}
Adapte aux activités probables et au profil.
Réponds UNIQUEMENT en JSON :
{"categories":[
 {"nom":"ex: Vêtements","emoji":"1 emoji","items":["6-10 items courts et concrets, quantités incluses si utile"]}
]}
4-5 catégories (Vêtements, Documents & argent, Tech, Santé & trousse, Spécifique destination).`;
  try{
    const {data, via} = await ai('light', prompt);
    state.cache.bag = data; state.cache.bagVia = via; save();
    renderBag(data, via);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderBag(d, via){
  /* ⚠️ Ces trois zones n'existaient nulle part : la première ligne levait donc
     une TypeError avant même d'afficher quoi que ce soit. On sort proprement si
     le panneau n'est pas à l'écran plutôt que de casser le rendu qui l'entoure. */
  if(!$('#zoneBag')) return;
  const badge = $('#bagBadge');
  if(badge) badge.style.display = via === 'groq' ? '' : 'none';
  let html = '';
  (d.categories||[]).forEach((c,ci)=>{
    html += `<h3 style="margin:${ci?14:0}px 0 9px">${ICO('sac',16)} ${esc(c.nom)}</h3>`;
    (c.items||[]).forEach((it,ii)=>{
      const k = ci + '_' + ii;
      html += `<div class="check ${state.checklist[k]?'done':''}" data-ck="${k}">
        <div class="box">${state.checklist[k]?'✔':''}</div><span>${esc(it)}</span>
      </div>`;
    });
  });
  $('#zoneBag').innerHTML = html;
  updateBagProg();
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-ck]');
  if(!el) return;
  const k = el.dataset.ck;
  state.checklist[k] = !state.checklist[k];
  save();
  el.classList.toggle('done', state.checklist[k]);
  el.querySelector('.box').textContent = state.checklist[k] ? '✔' : '';
  updateBagProg();
  const boxes = $$('#zoneBag .check');
  if(boxes.length && boxes.every(b => b.classList.contains('done'))){ confetti(); toast('🎉 Valise bouclée à 100 % !'); }
});
function updateBagProg(){
  const barre = $('#bagProg');
  if(!barre) return;                      /* panneau non affiché : rien à mettre à jour */
  const total = $$('#zoneBag .check').length;
  const done  = $$('#zoneBag .check.done').length;
  barre.style.width = total ? Math.round(done/total*100)+'%' : '0%';
  const cnt = $('#bagCnt');
  if(cnt) cnt.textContent = total ? `${done}/${total}` : '';
}

/* ============================================================
   PHRASES (light → Groq)
============================================================ */
async function loadTalk(){
  const zone = $('#zoneTalk');
  if(state.cache.talk){ renderTalk(state.cache.talk, state.cache.talkVia); return; }
  zone.innerHTML = loaderHTML('Traduction en cours…');
  const t = state.trip;
  const prompt = `Tu es Acolyte. Destination : ${t.nom} (${t.pays}), langue locale : ${t.langue || 'langue du pays'}.
Si la langue locale est le français, donne plutôt les expressions/argot local typiques de la région.
Réponds UNIQUEMENT en JSON :
{"langue":"nom de la langue","phrases":[
 {"fr":"phrase en français","local":"traduction en langue locale","pron":"prononciation phonétique à la française"}
]}
12 phrases : bonjour/merci/svp, se présenter, commander au resto, demander l'addition, demander son chemin, prix, urgence, "c'est délicieux", "je ne parle pas [langue]", au revoir.`;
  try{
    const {data, via} = await ai('light', prompt);
    state.cache.talk = data; state.cache.talkVia = via; save();
    renderTalk(data, via);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderTalk(d, via){
  if(!$('#zoneTalk')) return;            /* panneau non affiché */
  $('#talkBadge').style.display = via==='groq' ? '' : 'none';
  $('#zoneTalk').innerHTML = `<h3 style="margin-bottom:12px">Langue : ${esc(d.langue||'')}</h3>` +
    (d.phrases||[]).map(p=>`
      <div class="phrase">
        <div class="fr">${esc(p.fr)}</div>
        <div class="loc">${esc(p.local)}</div>
        <div class="pron">${ICO('son',13)} ${esc(p.pron)}</div>
      </div>`).join('');
}

/* ============================================================
   BUDGET (Gemini · heavy) + tracker dépenses
============================================================ */
const BUD_COLORS = ['#00F0FF','#A855F7','#FFE600','#FF6B00','#22C55E','#EF4444'];


/* --- dépenses réelles --- */
function renderSpends(){
  if(!$('#zoneSpends')) return;          /* panneau non affiché */
  const zone = $('#zoneSpends');
  if(!zone) return;
  const total = state.spends.reduce((a, s) => a + s.amount, 0);
  /* budget de référence : celui du plan IA en priorité, sinon l'estimation détaillée */
  const A = (state.prefs?.adults || 1) + (state.prefs?.kids || 0);
  const btPlan = parseInt((String(state.cache.plan?.budget?.total || '').replace(/\s/g,'').match(/\d+/)||[])[0], 10) || 0;
  const est = btPlan * A || state.cache.bud?.total_estime || 0;
  const d = stayDates();
  let bar = '';
  if(est){
    const pct = Math.round(total / est * 100);
    /* rythme attendu : où devrais-tu en être aujourd'hui ? */
    let attendu = null;
    if(d){
      const dep = new Date(d.in), fin = new Date(d.out), now = new Date();
      const nDays = Math.max(1, Math.round((fin - dep) / 86400000));
      const passed = Math.min(nDays, Math.max(0, Math.ceil((now - dep) / 86400000)));
      if(passed > 0 && now <= fin) attendu = Math.round(est * passed / nDays);
    }
    const derive = attendu ? total - attendu : 0;
    const alerte = attendu && Math.abs(derive) > est * 0.08;
    bar = `
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="spend-total">${total.toFixed(2)} €</div>
        <span class="tag ${pct > 100 ? 'money' : 'cyan'}">${pct}% du budget (${est} €)</span>
      </div>
      <div class="progress"><i style="width:${Math.min(100, pct)}%;background:${pct > 100 ? 'var(--accent-orange)' : 'var(--primary)'}"></i></div>
      ${alerte ? `<p class="hint" style="margin-top:8px;font-weight:800;color:${derive > 0 ? 'var(--accent-orange)' : 'inherit'}">
        ${derive > 0
          ? `⚠️ Tu dépenses plus vite que prévu : ${Math.round(derive)} € au-dessus du rythme (tu devrais être à ~${attendu} € à ce stade). Lève le pied ou ajuste ton budget.`
          : `✅ Tu es en dessous du rythme prévu : ${Math.abs(Math.round(derive))} € d'avance (attendu ~${attendu} € à ce stade). Tu peux te faire plaisir.`}</p>` : ''}
      ${pct > 100 ? `<p class="hint" style="margin-top:6px;font-weight:800;color:var(--accent-orange)">${ICO('alerte',14)} Budget dépassé de ${Math.round(total - est)} €.</p>` : ''}`;
  }
  if(!state.spends.length){
    zone.innerHTML = bar + `<p class="hint">Aucune dépense enregistrée. Ajoute-les au fil du séjour : Acolyte compare en direct avec le budget prévu par l'IA et te prévient si tu dérives.</p>`;
    return;
  }
  zone.innerHTML = bar + state.spends.map((s, i) => `
      <div class="item" style="padding:10px 14px">
        <div class="emo">${ICO('cb',18)}</div>
        <div style="flex:1;min-width:0">
          <p style="margin-top:2px">${esc(s.label)}</p>
          <p class="hint" style="margin:0">${new Date(s.ts).toLocaleDateString(LOC(), {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}</p>
        </div>
        <div class="side row"><span class="tag money">${s.amount.toFixed(2)} €</span><span class="spend-del" data-sp="${i}" role="button" aria-label="Supprimer">${ICO('poubelle',15)}</span></div>
      </div>`).join('');
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-sp]');
  if(!el) return;
  state.spends.splice(+el.dataset.sp, 1);
  save(); renderSpends();
});



/* ============================================================
   EXPORT .md
============================================================ */
const _e11 = $('#btnExport'); if(_e11) _e11.onclick = () => {
  if(!state.trip){ toast('Choisis d’abord une destination'); return; }
  const t = state.trip, p = state.prefs || {}, c = state.cache;
  let md = `# ✈️ Voyage Acolyte — ${t.nom}, ${t.pays}\n\n`;
  md += `- **Départ :** ${p.from||''}\n- **Durée :** ${p.days||''}\n- **Période :** ${p.when||'flexible'}\n- **Budget :** ${t.budget_estime||''}\n- **Voyageurs :** ${p.who||''}\n\n${t.resume||''}\n`;
  if(c.plan){
    const pl = c.plan;
    md += `\n## 🤖 Plan Acolyte${state.planOk ? ' (validé ✅)' : ''}\n`;
    md += `- **Transport choisi :** ${pl.transport?.mode||''} — ${pl.transport?.pourquoi||''} (${pl.transport?.prix_estime||''})\n`;
    md += `- **Logement :** ${pl.logement?.type||''} à ${pl.logement?.quartier||''} (${pl.logement?.prix_nuit||''}/nuit)\n`;
    md += `- **Budget total :** ${pl.budget?.total||''} €/pers — ${pl.budget?.repartition||''}\n`;
    (pl.programme||[]).forEach(j=> md += `- Jour ${j.jour} : ${j.resume}\n`);
    if(pl.sur_place) md += `- **Sur place :** ${pl.sur_place}\n`;
    (pl.a_reserver||[]).forEach(r=> md += `- 🎟️ À réserver tôt : ${r}\n`);
    md += `- 💡 ${pl.conseil_cle||''}\n`;
  }
  const tr = c['transport_'+state.mode];
  if(tr){
    md += `\n## 🛫 Transport (${state.mode})\n`;
    Object.entries(tr).forEach(([k,v])=>{
      if(Array.isArray(v)) md += `- **${k} :**\n` + v.map(x=>`  - ${x}`).join('\n') + '\n';
      else md += `- **${k} :** ${v}\n`;
    });
  }
  if(c.stay){
    md += `\n## 🏨 Logement\n${c.stay.type_conseille||''}\n`;
    (c.stay.quartiers||[]).forEach(q=> md += `- **${q.nom}** (${q.prix_nuit}) — ${q.pourquoi}\n`);
  }
  if(c.fullPlan){
    md += `\n## 📆 Programme\n`;
    (c.fullPlan.jours||[]).forEach(j=>{
      md += `\n### Jour ${j.jour} — ${j.titre}\n`;
      (j.etapes||[]).forEach(e=> md += `- **${e.heure}** ${e.titre}${e.lieu?` _(${e.lieu})_`:''} — ${e.description}\n`);
    });
  }
  if(c.food){ md += `\n## 🍽️ Restos\n`; (c.food.restos||[]).forEach(r=> md += `- **${r.nom}** (${r.budget}, ${r.quartier}) — à commander : ${r.plat_star}\n`); }
  if(c.spec){ md += `\n## 🥘 Spécialités\n`; (c.spec.specialites||[]).forEach(s=> md += `- **${s.nom}** (${s.prix}) — ${s.description} Où : ${s.ou_gouter}\n`); }
  if(c.shop){ md += `\n## 🛒 Courses\n`; (c.shop.supermarches||[]).forEach(s=> md += `- ${s.nom} (${s.niveau}) — ${s.astuce}\n`); }
  if(c.bag){ md += `\n## 🎒 Valise\n`; (c.bag.categories||[]).forEach(cat=>{ md += `\n**${cat.nom}**\n`; (cat.items||[]).forEach(i=> md += `- [ ] ${i}\n`); }); }
  if(c.talk){ md += `\n## 🗣️ Phrases utiles (${c.talk.langue||''})\n`; (c.talk.phrases||[]).forEach(ph=> md += `- ${ph.fr} → **${ph.local}** _(${ph.pron})_\n`); }
  if(c.bud){ md += `\n## 💶 Budget estimé : ${c.bud.total_estime} €/pers\n`; (c.bud.postes||[]).forEach(po=> md += `- ${po.nom} : ${po.montant} €\n`); }
  if(c.act){ md += `\n## 🎡 Activités\n`; (c.act.activites||[]).forEach(a=> md += `- **${a.nom}** (${a.prix}, ${a.duree}) — ${a.description}\n`); }
  if(c.info){
    md += `\n## 🛟 Infos pratiques\n`;
    Object.entries(c.info).forEach(([k,v])=> md += `- **${k} :** ${v}\n`);
  }
  if(state.resas.length){
    md += `\n## 📎 Réservations\n`;
    state.resas.forEach(r=> md += `- ${r.type} — ${r.ref}${r.link?` (${r.link})`:''}\n`);
  }
  if(state.notes.trim()){ md += `\n## 📝 Notes\n${state.notes}\n`; }
  if(state.spends.length){
    const tot = state.spends.reduce((a,s)=>a+s.amount,0);
    md += `\n## 💳 Dépenses réelles : ${tot.toFixed(2)} €\n`;
    state.spends.forEach(s=> md += `- ${s.label} : ${s.amount.toFixed(2)} €\n`);
  }
  md += `\n---\n_Généré par Acolyte ✦ Gemini ⚡ Groq_\n`;
  const blob = new Blob([md], {type:'text/markdown'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `acolyte-${t.nom.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Voyage exporté 📄');
};

/* ============================================================
   CARTES HORS-LIGNE — une carte par journée (tuiles OSM → image
   en cache local) : consultable sans réseau + intégrée au carnet
============================================================ */
const _lon2t = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
const _lat2t = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z);
function loadTileImg(url){
  return new Promise(res => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = url;
  });
}
async function buildDayMap(jour){
  const t = state.trip, plan = state.cache.plan;
  const jr = (plan?.programme || []).find(x => String(x.jour) === String(jour));
  if(!t || !jr) return null;
  const cc = ccFor(t.pays);
  /* géocode les lieux du jour (les monuments échouent parfois → on garde ceux trouvés) */
  const lieux = (jr.lieux || []).filter(Boolean).slice(0, 4);
  const found = [];
  for(const l of lieux){
    const g0 = await geoPlace(cleanPlace(l), cc);
    if(g0) found.push({ nom: l, lat: +g0.latitude, lon: +g0.longitude });
  }
  /* repli : la base du jour (multi-étapes) sinon le centre-ville */
  if(!found.length){
    const g0 = (jr.base ? await geoPlace(cleanPlace(jr.base), cc) : null) || await geocode();
    if(!g0) return null;
    found.push({ nom: jr.base || t.nom, lat: +g0.latitude, lon: +g0.longitude });
  }
  /* filtre les points aberrants (géocodage parti dans un autre pays : > 80 km du 1er) */
  const ref = found[0];
  const pts = found.filter(p => havKm({latitude:ref.lat, longitude:ref.lon}, {latitude:p.lat, longitude:p.lon}) < 80);
  /* zoom qui fait tenir tous les points dans 3×2 tuiles */
  let z = 15;
  for(; z > 10; z--){
    const xs = pts.map(p => _lon2t(p.lon, z)), ys = pts.map(p => _lat2t(p.lat, z));
    if(Math.max(...xs) - Math.min(...xs) < 2.4 && Math.max(...ys) - Math.min(...ys) < 1.5) break;
  }
  const cx = pts.reduce((a, p) => a + _lon2t(p.lon, z), 0) / pts.length;
  const cy = pts.reduce((a, p) => a + _lat2t(p.lat, z), 0) / pts.length;
  const startX = Math.floor(cx - 1.5), startY = Math.floor(cy - 1);
  /* 3×2 tuiles de 256 → 768×512 */
  const cv = document.createElement('canvas'); cv.width = 768; cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#e8e4da'; g.fillRect(0, 0, 768, 512);
  const jobs = [];
  for(let dx = 0; dx < 3; dx++) for(let dy = 0; dy < 2; dy++)
    jobs.push(loadTileImg(`https://tile.openstreetmap.org/${z}/${startX + dx}/${startY + dy}.png`)
      .then(im => ({ im, dx, dy })));
  const tiles = await Promise.all(jobs);
  const okTiles = tiles.filter(x => x.im);
  if(!okTiles.length) return null;              /* aucun réseau/tuile → pas de carte */
  okTiles.forEach(({ im, dx, dy }) => g.drawImage(im, dx * 256, dy * 256, 256, 256));
  /* pins numérotés */
  pts.forEach((p, i) => {
    const x = (_lon2t(p.lon, z) - startX) * 256, y = (_lat2t(p.lat, z) - startY) * 256;
    if(x < 8 || y < 8 || x > 760 || y > 504) return;
    g.fillStyle = '#101010'; g.beginPath(); g.arc(x + 2, y + 2, 15, 0, 7); g.fill();
    g.fillStyle = '#FFE600'; g.beginPath(); g.arc(x, y, 15, 0, 7); g.fill();
    g.strokeStyle = '#101010'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#101010'; g.font = '900 16px Fraunces, Georgia'; g.textAlign = 'center';
    g.fillText(String(i + 1), x, y + 6); g.textAlign = 'left';
  });
  /* bandeau titre + légende + attribution */
  g.fillStyle = '#FFE600'; g.fillRect(0, 0, 768, 40);
  g.strokeStyle = '#101010'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 765, 37);
  g.fillStyle = '#101010'; g.font = '900 19px Fraunces, Georgia';
  g.fillText(`Jour ${jour} — ${String(jr.resume || '').slice(0, 44)}`, 14, 27);
  const leg = pts.map((p, i) => `${i + 1}·${String(p.nom).split(',')[0].slice(0, 18)}`).join('   ');
  g.fillStyle = 'rgba(255,255,255,.94)'; g.fillRect(0, 512 - 30, 768, 30);
  g.fillStyle = '#101010'; g.font = '700 13px Inter, Arial';
  g.fillText(leg.slice(0, 88), 12, 512 - 10);
  g.textAlign = 'right'; g.fillStyle = '#555'; g.font = '600 11px Arial';
  g.fillText('© OpenStreetMap contributors', 758, 512 - 10); g.textAlign = 'left';
  return cv.toDataURL('image/jpeg', 0.72);
}
async function prepareOfflineMaps(){
  const plan = state.cache.plan;
  if(!state.trip || !(plan?.programme || []).length){ toast('Génère d’abord le plan (étape 3) 😉'); return; }
  const btn = $('#btnMaps'); if(btn){ btn.disabled = true; }
  state.cache.maps = state.cache.maps || {};
  let ok = 0, ko = 0;
  for(const jr of plan.programme){
    if(state.cache.maps[jr.jour]){ ok++; continue; }
    toast(`🗺️ Carte du jour ${jr.jour}…`);
    try{
      const url = await buildDayMap(jr.jour);
      if(url){ state.cache.maps[jr.jour] = url; ok++; save(); }
      else ko++;
    }catch(e){ ko++; }
  }
  if(btn) btn.disabled = false;
  renderPlan(plan);   /* réaffiche avec les vignettes cartes */
  toast(ok ? `🗺️ ${ok} carte(s) prête(s) hors-ligne ✔${ko ? ` (${ko} indisponible(s))` : ''}` : '🗺️ Cartes indisponibles — vérifie ta connexion');
}
const _eMaps = $('#btnMaps'); if(_eMaps) _eMaps.onclick = prepareOfflineMaps;

/* ============================================================
   CARNET DE VOYAGE (PDF) — plan complet + réservations, pensé
   pour être imprimé/enregistré en PDF AVANT le départ (hors-ligne)
============================================================ */
function buildDossierHTML(){
  const t = state.trip, p = state.prefs || {}, pl = state.cache.plan || {}, d = stayDates();
  const days = state.cache.days || {};
  const esc2 = esc;
  const dates = d ? `${d.in} → ${d.out}` : (p.when || 'dates flexibles');
  const A = `${p.adults || 2} adulte(s)${p.kids ? ' + ' + p.kids + ' enfant(s)' : ''}`;
  let h = `<div class="cover">
    <p class="brand">ACOLYTE · CARNET DE VOYAGE</p>
    <h1>${esc2(t.nom)}</h1>
    <div class="rule"></div>
    <p class="meta">${esc2(t.pays || '')}${t.pays ? ' · ' : ''}${esc2(dates)}<br>${esc2(A)} · départ de ${esc2(p.from || '—')}</p>
  </div>`;
  h += `<section><h2>L'essentiel</h2><table>
    <tr><th>Transport</th><td>${esc2(pl.transport?.mode || '—')} · ${esc2(pl.transport?.prix_estime || '')}<br>${esc2(pl.transport?.details || '')}</td></tr>
    <tr><th>Logement</th><td>${(pl.logement?.etapes || []).length
      ? pl.logement.etapes.map(e => `${esc2(e.ville || '')} — ${esc2(e.quartier || '')} · ${esc2(String(e.nuits ?? '?'))} nuit(s)${e.prix_nuit ? ' · ' + esc2(e.prix_nuit) + '/nuit' : ''}`).join('<br>')
      : `${esc2(pl.logement?.type || '—')} · quartier ${esc2(pl.logement?.quartier || '—')} · ${esc2(pl.logement?.prix_nuit || '')}/nuit`}</td></tr>
    <tr><th>Budget</th><td>${esc2(String(pl.budget?.total ?? '—'))} €/pers — ${esc2(pl.budget?.repartition || '')}</td></tr>
    ${pl.sur_place ? `<tr><th>Sur place</th><td>${esc2(pl.sur_place)}</td></tr>` : ''}
  </table></section>`;
  if(state.resas?.length){
    h += `<section><h2>Réservations &amp; références</h2><table class="refs">` +
      state.resas.map(r => `<tr><th>${esc2(r.type)}</th><td><strong>${esc2(r.ref)}</strong>${r.link ? `<span class="lnk">${esc2(r.link)}</span>` : ''}</td></tr>`).join('') +
      `</table></section>`;
  }
  if((pl.a_reserver || []).length){
    h += `<section><h2>À réserver à l'avance</h2><ul>` + pl.a_reserver.map(r => `<li>${esc2(r)}</li>`).join('') + `</ul></section>`;
  }
  if((pl.programme || []).length){
    h += `<section><h2>Programme jour par jour</h2>`;
    pl.programme.forEach(j => {
      h += `<div class="dj"><h3>Jour ${esc2(String(j.jour))} — ${esc2(j.resume || '')}${j.base ? ` <small>(${esc2(j.base)})</small>` : ''}</h3>`;
      if((j.lieux || []).length) h += `<p class="lieux">${ICO('epingle',12)} ${j.lieux.map(esc2).join(' · ')}</p>`;
      if(safeDataImg(state.cache.maps?.[j.jour])) h += `<img class="djmap" src="${safeDataImg(state.cache.maps[j.jour])}" alt="Carte jour ${esc2(String(j.jour))}">`;
      const det = days[j.jour];
      if(det?.etapes?.length){
        h += `<ul class="heures">` + det.etapes.map(e =>
          `<li><strong>${esc2(e.heure || '')}</strong> ${esc2(e.titre || '')}${e.lieu ? ` <em>(${esc2(e.lieu)})</em>` : ''} — ${esc2(e.description || '')}</li>`).join('') + `</ul>`;
      }
      const coms = state.board?.comments?.[String(j.jour)] || [];
      if(coms.length) h += `<p class="lieux">${ICO('discussion',12)} ${coms.map(c => `<strong>${esc2(c.who)}</strong> : ${esc2(c.txt)}`).join(' · ')}</p>`;
      h += `</div>`;
    });
    h += `</section>`;
  }
  const info = state.cache['cinfo_' + (t.pays || t.nom)];
  if(info){
    const rows = [['🛂 Formalités', info.visa], ['🔌 Prises', info.prise], ['🚨 Urgences', info.urgence], ['💶 Pourboire', info.pourboire],
                  ['🚰 Eau', info.eau], ['🕐 Décalage', info.decalage], ['💉 Santé', info.sante]].filter(r => r[1]);
    if(rows.length) h += `<section><h2>Infos pratiques</h2><table>` +
      rows.map(r => `<tr><th>${r[0]}</th><td>${esc2(String(r[1]))}</td></tr>`).join('') + `</table></section>`;
  }
  if(pl.conseil_cle) h += `<section><h2>Le conseil à retenir</h2><p>${esc2(pl.conseil_cle)}</p></section>`;
  if((state.notes || '').trim()) h += `<section><h2>Mes notes</h2><p>${esc2(state.notes).replace(/\n/g, '<br>')}</p></section>`;
  h += `<footer>Ticket souvenir — ne permet pas d'embarquer. Prix et horaires : estimations à vérifier. acolyte</footer>`;
  return h;
}
function openDossier(){
  if(!state.trip){ toast('Choisis d’abord un voyage'); return; }
  if(!state.cache.plan){ toast('Génère d’abord le plan (étape 3) 😉'); return; }
  const dz = $('#dossier');
  dz.innerHTML = buildDossierHTML();
  dz.hidden = false;
  const done = () => { dz.hidden = true; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();   /* le voyageur choisit « Enregistrer en PDF » */
  toast('📄 Choisis « Enregistrer au format PDF » dans la fenêtre d’impression');
}
const _eDos = $('#btnDossier'); if(_eDos) _eDos.onclick = openDossier;

/* --- Signal hors-ligne : rassure le voyageur, son plan reste là --- */
window.addEventListener('offline', () => toast('📴 Hors connexion — ton plan reste consultable dans Acolyte'));

/* --- Sauvegarde / restauration du voyage complet (fichier .json) ---
   Sécurise les données contre un vidage du localStorage / changement d'appareil. */
function backupTrip(){
  try{
    const data = { _acolyte: 'trip-backup', v: 1, when: Date.now(), state };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `acolyte-voyage-${String(state.trip?.nom || 'brouillon').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('💾 Voyage sauvegardé dans un fichier');
  }catch(e){ toast('Sauvegarde impossible'); }
}
function restoreTrip(file){
  const rd = new FileReader();
  rd.onload = () => {
    try{
      const data = JSON.parse(rd.result);
      const s = (data && data.state) ? data.state : data;   /* tolère un state brut */
      const looksAcolyte = data?._acolyte === 'trip-backup' || (s && ['trip','prefs','cache','destinations'].some(k => k in s));
      if(!s || typeof s !== 'object' || Array.isArray(s) || !looksAcolyte) throw new Error('bad');
      /* on ne fusionne PLUS le JSON tel quel : il vient d'un fichier, donc
         de l'extérieur. safeState() ne garde que des clés connues et typées. */
      state = safeState(s);
      save();
      _pcPhotos = null;   /* invalide les photos de la carte postale */
      toast('📂 Voyage importé ✔');
      renderGallery();
      if(state.trip){ unlockSteps(); gotoStep(Math.min(3, state.step || 3)); }
      else gotoStep(1);
    }catch(e){ toast('Fichier invalide — ce n’est pas une sauvegarde Acolyte'); }
  };
  rd.onerror = () => toast('Lecture du fichier impossible');
  rd.readAsText(file);
}
const _eBk = $('#btnBackup'); if(_eBk) _eBk.onclick = backupTrip;
const _eRs = $('#btnRestore'); if(_eRs) _eRs.onclick = () => $('#restoreFile')?.click();
const _eRf = $('#restoreFile'); if(_eRf) _eRf.onchange = (e) => { const f = e.target.files?.[0]; if(f) restoreTrip(f); e.target.value = ''; };

/* ============================================================
   ACTIVITÉS & EXPÉRIENCES (Gemini · heavy)
============================================================ */

/* ============================================================
   OUTILS — APIs publiques gratuites, données réelles
   Open-Meteo (géo + météo) · Frankfurter (devises) · Groq (traduction)
============================================================ */

// --- Géocodage (Open-Meteo geocoding, sans clé) ---
async function geocode(){
  if(state._geo) return state._geo;
  const t = state.trip;
  if(!t) return null;
  const cc = ccFor(t.pays);
  for(const nom of [...new Set([t.ville_aeroport, t.nom, t.pays].map(cleanPlace).filter(Boolean))]){
    const g = await geoPlace(nom, cc);
    if(g){ state._geo = g; return g; }
  }
  return null;
}

// --- Météo 7 jours (Open-Meteo, données réelles gratuites) ---

// --- Heure locale + devises ---

// --- Traducteur express (light → Groq) ---

// --- Compte à rebours ---
let countT;

/* ============================================================
   CARNET — notes + réservations (localStorage)
============================================================ */
let noteT;
function initNote(){
  const a = $('#noteArea');
  if(!a) return;                          /* panneau non affiché */
  a.value = state.notes || '';
  a.oninput = () => {
    state.notes = a.value;
    clearTimeout(noteT);
    /* ⚠️ 500 ms plus tard, le panneau a pu être reconstruit par un changement
       d'onglet : #noteSaved n'existe alors plus, et l'écrire levait une
       TypeError non capturée. La sauvegarde, elle, doit avoir lieu quoi qu'il
       arrive — c'est le texte du voyageur. */
    noteT = setTimeout(() => {
      save();
      const m = $('#noteSaved');
      if(m) m.textContent = 'Enregistré ✓ ' + new Date().toLocaleTimeString(LOC(), { hour:'2-digit', minute:'2-digit' });
    }, 500);
  };
}
const _e13 = $('#btnRes'); if(_e13) _e13.onclick = () => {
  const ref = $('#resRef').value.trim();
  if(!ref){ toast('Ajoute au moins une référence'); return; }
  state.resas.push({ type: $('#resType').value, ref, link: $('#resLink').value.trim() });
  save();
  $('#resRef').value = ''; $('#resLink').value = '';
  renderResas();
  toast('Réservation ajoutée 📎');
};
function renderResas(){
  if(!$('#zoneRes')) return;             /* accordéon replié */
  const zone = $('#zoneRes');
  if(!state.resas.length){ zone.innerHTML = `<p class="hint">Aucune réservation enregistrée. Garde tes numéros de résa à portée de main.</p>`; return; }
  zone.innerHTML = state.resas.map((r,i)=>`
    <div class="item" style="padding:12px 14px">
      <div class="emo">${esc(r.type.split(' ')[0])}</div>
      <div style="flex:1"><h4>${esc(r.type.replace(/^\S+\s/,''))}</h4><p>${esc(r.ref)}${r.link?` · <a href="${esc(r.link)}" target="_blank" rel="noopener" style="color:var(--accent-orange);font-weight:900">ouvrir ↗</a>`:''}</p></div>
      <div class="side"><span class="spend-del" data-res="${i}" role="button" aria-label="Supprimer">${ICO('poubelle',15)}</span></div>
    </div>`).join('');
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-res]');
  if(!el) return;
  state.resas.splice(+el.dataset.res, 1);
  save(); renderResas();
});

/* ============================================================
   UI GÉNÉRALE
============================================================ */
const _e14 = $('#btnGo'); if(_e14) _e14.onclick = () => { state.propAnswers = []; state._qsDone = false; proposeTrips(); };
const _e15 = $('#btnLucky'); if(_e15) _e15.onclick = () => { state.propAnswers = []; state._qsDone = false; proposeTrips('', true); };
const _e15b = $('#btnCountry'); if(_e15b) _e15b.onclick = () => {
  const c = $('#fDest').value.trim();
  if(!c){ toast('Écris un pays dans « Destination souhaitée » 😉'); $('#fDest').focus(); return; }
  state.propAnswers = []; state._qsDone = false;
  proposeTrips('', false, c);
};



const _e16 = $('#btnReset'); if(_e16) _e16.onclick = () => {
  if(!confirm('Repartir de zéro ? (tes clés API sont conservées)')) return;
  localStorage.removeItem(LS_TRIP);
  location.reload();
};

/* ============================================================
   COMPTE — création, connexion, vérification par email
   Stockage local (test) · envoi du code via EmailJS si configuré,
   sinon mode démo (code affiché à l'écran).
============================================================ */
const LS_USER = 'acolite_user';
const LS_AUTH = 'acolite_logged';
const getUser = () => { try{ return JSON.parse(localStorage.getItem(LS_USER)); }catch(e){ return null; } };
const setUser = u => lsSet(LS_USER, JSON.stringify(u));

async function sha(txt){
  try{
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
    return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
  }catch(e){ /* contexte non sécurisé (file://) → hash simple de secours */
    let h = 0; for(const c of txt){ h = (h*31 + c.charCodeAt(0)) >>> 0; } return 'x' + h.toString(16);
  }
}

function authErr(msg){ const el = $('#authErr'); if(!msg){ el.classList.add('hidden'); return; } el.textContent = msg; el.classList.remove('hidden'); }
function authShow(which){
  ['authSignup','authLogin','authVerify','authForgot'].forEach(id => $('#'+id)?.classList.toggle('hidden', id !== which));
  authErr('');
  const S = { authSignup:"Crée ton compte pour commencer l'aventure.",
              authLogin:'Content de te revoir !',
              authVerify:'Dernière étape : vérifie ton email.',
              authForgot:'Ça arrive à tout le monde.' };
  $('#authSub').textContent = S[which] || '';
  /* Le grand titre suit l'écran. Il était figé sur « Créer ton compte » dans le
     HTML : quelqu'un qui cliquait « Se connecter » lisait encore l'invitation à
     s'inscrire au-dessus du formulaire de connexion. */
  const T = { authSignup:'Créer ton compte', authLogin:'Se connecter',
              authVerify:'Vérifie ton email', authForgot:'Mot de passe oublié' };
  const h = $('#authTitre');
  if(h) h.textContent = T[which] || '';
}


/* ============================================================
   COMPTES CÔTÉ SERVEUR
   Le navigateur ne génère plus aucun code et n'envoie plus aucun email :
   il demande, le serveur décide. C'est ce qui empêche de s'approprier
   l'adresse d'un autre en lisant le code dans la console.
============================================================ */
const LS_TOKEN = 'acolite_token';
const authToken = () => { try{ return localStorage.getItem(LS_TOKEN) || ''; }catch(e){ return ''; } };
/* ⚠️ LE PRÉDICAT DE CONNEXION, NOMMÉ UNE FOIS.
   requireAuth() ne RENVOIE rien : c'est une fonction d'AIGUILLAGE — elle entre
   dans l'app ou affiche l'écran de connexion, puis s'arrête. Je l'avais prise
   pour un booléen dans l'assistant (`if(!requireAuth()) return;`) : comme elle
   renvoie undefined dans toutes ses branches, la garde se déclenchait TOUJOURS
   et le bouton « Envoyer » ne faisait rien — connecté ou non, sans une erreur.
   Une fonction dont le nom commence par « require » a l'air d'un test ; celle-ci
   n'en est pas un. D'où ce prédicat séparé, qui porte la condition réelle et
   sert désormais de source unique aux deux. */
const estConnecte = () => {
  try{ return !!(getUser() && authToken() && localStorage.getItem(LS_AUTH) === '1'); }
  catch(e){ return false; }
};
/* Vrai quand on parcourt l'app sans compte. Déclarés en `var` : requireAuth()
   et les points d'entrée IA vivent bien plus haut dans le fichier, et un
   `let` les mettrait en zone morte au démarrage — le piège du _blogIdx. */
var _visiteLibre = false;
var _authForcee  = false;   /* mis à vrai quand on demande VOLONTAIREMENT l'écran */

/* ⚠️ LA PORTE, AU MOMENT OÙ ELLE SERT.
   À appeler juste avant toute action qui passe par l'IA. Renvoie true si on
   peut continuer ; sinon elle explique POURQUOI on demande un compte, ouvre
   l'écran de connexion, et renvoie false.
   Dire la raison n'est pas une politesse : sans elle, un écran de connexion qui
   surgit après un clic ressemble à une panne. */
function exigeCompte(raison){
  if(estConnecte()) return true;
  toast('🔑 ' + (raison || 'Un compte est nécessaire pour cette action'));
  _authForcee = true;
  _visiteLibre = false;
  try{ requireAuth(); }catch(e){}
  _authForcee = false;
  return false;
}
/* Vrai dès qu'un 401 est tombé : on cesse alors d'appeler les routes
   authentifiées. Déclaré ICI, avant setToken qui s'en sert — le mettre plus bas
   marcherait par chance (setToken n'est appelé qu'à l'exécution), mais un
   déplacement de code suffirait à casser. */
let _sessionMorte = false;
/* ⚠️ Poser un jeton REMET la session en vie. C'est fait ici, et pas dans chaque
   chemin de connexion (mot de passe, code de vérification, inscription) :
   oublier l'un des trois laisserait l'utilisateur reconnecté mais incapable
   d'appeler le serveur, sans aucune erreur visible. */
const setToken = t => { _sessionMorte = false; return lsSet(LS_TOKEN, t); };
const clearToken = () => { try{ localStorage.removeItem(LS_TOKEN); }catch(e){} };

/* ============================================================
   SESSION EXPIRÉE — LE 401 DOIT ARRÊTER LES FRAIS
   ------------------------------------------------------------
   ⚠️ LE DÉFAUT CORRIGÉ ICI. Un 401 (« non autorisé ») était traité comme une
   panne réseau ordinaire : pullSync faisait « if(!r.ok) return », et personne
   n'en tirait de conclusion. Conséquences observées dans la console :

       /sync   401 · /groq 401 · /sync 401 · /groq 401 · …

   · le navigateur se croyait connecté alors que le serveur avait oublié la
     session (elle dure 30 jours au plus, et seuls les 5 derniers appareils sont
     gardés) ;
   · chaque action retentait, échouait, et recommençait — sans jamais le dire ;
   · l'utilisateur voyait simplement l'app ne « rien faire ».

   Le traitement est CENTRALISÉ ici et pas dans chaque appelant : il y a une
   quinzaine de routes authentifiées, et en oublier une ramènerait la boucle.
   (Le drapeau _sessionMorte est déclaré plus haut, près de setToken.)
============================================================ */
function sessionExpiree(){
  if(_sessionMorte) return;     /* une seule fois, pas un message par appel */
  _sessionMorte = true;
  clearToken();
  try{ localStorage.removeItem(LS_AUTH); }catch(e){}
  toast(isEN() ? '🔐 Session expired — please sign in again'
                : '🔐 Session expirée — reconnecte-toi');
  /* On renvoie à l'écran de connexion. Les voyages restent dans l'appareil :
     se reconnecter les retrouvera, rien n'est perdu. */
  try{ requireAuth(); }catch(e){}
}

/* Appel au backend. Renvoie toujours { ok, data } — jamais d'exception,
   pour qu'un réseau coupé n'interrompe pas l'action en cours. */
async function srvFetch(path, { method = 'GET', body = null, auth = false } = {}){
  const base = (CFG.proxy || '').replace(/\/+$/, '');
  if(!base) return { ok:false, data:{ error:"Le serveur n'est pas configuré" } };
  /* ⚠️ On ne tente MÊME PAS un appel authentifié après un 401 : c'est ce qui
     transforme une session expirée en martèlement du serveur. Les routes
     publiques (/blog, /ping…) continuent de fonctionner normalement. */
  if(auth && (_sessionMorte || !authToken()))
    return { ok:false, status:401, data:{ error:'Session expirée' } };
  const headers = {};
  if(body) headers['Content-Type'] = 'application/json';
  if(auth) headers.Authorization = 'Bearer ' + authToken();
  try{
    const r = await fetchT(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    }, netTimeout(15000));
    const data = await r.json().catch(() => ({}));
    /* ⚠️ L'exception : /auth/login et /auth/verify répondent 401 sur un mauvais
       mot de passe. Ce n'est PAS une session expirée — la traiter comme telle
       déconnecterait quelqu'un qui essaie justement de se connecter. */
    if(r.status === 401 && auth && !/^\/auth\//.test(path)) sessionExpiree();
    return { ok: r.ok, status: r.status, data };
  }catch(e){
    return { ok:false, data:{ error:'Serveur injoignable — vérifie ta connexion' } };
  }
}

/* --- Synchronisation des voyages ---
   On n'envoie PAS l'état brut : state.cache.maps contient les cartes
   hors-ligne en JPEG base64 (des centaines de Ko), qui feraient dépasser
   la limite du serveur — le voyage ne serait alors jamais enregistré.
   Ces images se régénèrent sur l'autre appareil ; on ne synchronise que
   ce qui ne se recalcule pas : le voyage et ce que l'IA a produit. */
function slimTrip(){
  const { cache, ...rest } = state || {};
  const c = cache || {};
  return {
    ...rest,
    cache: {                       /* on garde le fruit du raisonnement IA… */
      plan: c.plan, _real: c._real, hotels: c.hotels,
      events: c.events, transport: c.transport,
    },                             /* …mais jamais les images (maps, postcard) */
  };
}
function histLocal(){
  try{ return JSON.parse(localStorage.getItem(LS_HIST)) || []; }catch(e){ return []; }
}
function syncPayload(){
  return { trip: slimTrip(), history: histLocal() };
}
let _syncT = null;
let _syncWarned = false;   /* on ne prévient qu'une fois par session */
function pushSync(){
  if(!authToken()) return;
  clearTimeout(_syncT);                       /* on groupe les rafales de save() */
  _syncT = setTimeout(async () => {
    const r = await srvFetch('/sync', { method:'POST', body:{ payload: syncPayload() }, auth:true });
    /* un échec de synchro ne doit pas passer inaperçu : c'est ce qui nous
       avait fait croire que « ça marche » alors que le serveur refusait */
    if(!r.ok && !_syncWarned){
      _syncWarned = true;
      toast(r.status === 413
        ? '⚠️ Voyage trop lourd pour la synchro — il reste sur cet appareil'
        : '⚠️ Synchronisation en pause — tes voyages restent sur cet appareil');
    }else if(r.ok){ _syncWarned = false; }
  }, 1500);
}
/* Première connexion : si le compte est vide et que l'appareil a des voyages,
   on ENVOIE le local. Sinon le serveur fait foi. On n'efface jamais un
   travail existant sans qu'il ait été sauvegardé d'abord. */
async function pullSync(){
  if(!authToken()) return;
  const r = await srvFetch('/sync', { auth:true });
  if(!r.ok) return;
  const dist = r.data && r.data.payload;
  const localVide = !state.trip && !(state.destinations || []).length;
  if(!dist){
    if(!localVide) await srvFetch('/sync', { method:'POST', body:{ payload: syncPayload() }, auth:true });
    return;
  }
  if(dist.trip){
    /* on greffe le voyage distant en gardant les images déjà présentes
       sur CET appareil (cartes hors-ligne) : elles ne voyagent pas, mais
       si elles sont là, autant les conserver */
    const localMaps = state.cache?.maps;
    state = dist.trip;
    if(localMaps){ state.cache = state.cache || {}; state.cache.maps = localMaps; }
    save();
  }
  if(Array.isArray(dist.history)) lsSet(LS_HIST, JSON.stringify(dist.history));
  /* on ré-affiche ce qui vient d'arriver, comme au démarrage */
  try{
    renderGallery();
    if(state.lastProps) renderDestinations(state.lastProps);
    if(state.step > 1) gotoStep(Math.min(state.step, 3));
  }catch(e){}
}


const _e17 = $('#goLogin'); if(_e17) _e17.onclick  = () => authShow('authLogin');
const _e18 = $('#goSignup'); if(_e18) _e18.onclick = () => authShow('authSignup');
const _e19 = $('#vfBack'); if(_e19) _e19.onclick   = () => { localStorage.removeItem(LS_USER); authShow('authSignup'); };

/* ============================================================
   MOT DE PASSE OUBLIÉ — DEPUIS L'ÉCRAN DE CONNEXION
   ------------------------------------------------------------
   Le serveur savait déjà tout faire (/auth/forgot et /auth/reset), et le profil
   proposait bien un changement de mot de passe. Mais il exigeait getUser(),
   donc une session ouverte : la récupération était réservée à ceux qui
   n'en avaient PAS besoin. Quelqu'un de réellement bloqué dehors n'avait
   aucune porte.

   ⚠️ Ce que le serveur garantit, et qu'il ne faut pas contredire ici :
   · il répond « ok » MÊME si l'adresse est inconnue — c'est volontaire, ça
     évite de révéler qui possède un compte. Notre message doit donc rester
     neutre : « si un compte existe, un code est parti ». Écrire « code envoyé »
     serait un mensonge dans un cas sur deux, et « adresse inconnue » serait la
     fuite qu'on cherche à éviter ;
   · réinitialiser COUPE toutes les sessions ouvertes ailleurs. C'est le bon
     réflexe quand on se croit piraté, et il faut le dire.

   ⚠️ Un vrai formulaire, pas des prompt() comme le fait le profil : prompt()
   est bloqué dans certains contextes, illisible sur téléphone, et empêche de
   coller un code depuis l'application Mail.
============================================================ */
let _fgEmail = '';
const fgShow2 = (on) => {
  $('#fgStep1')?.classList.toggle('hidden', on);
  $('#fgStep2')?.classList.toggle('hidden', !on);
};
const _eFgGo = $('#goForgot'); if(_eFgGo) _eFgGo.onclick = () => {
  /* on reprend l'adresse déjà saisie dans la connexion : la retaper est pénible
     et c'est la première cause d'abandon à cette étape */
  const dejaSaisi = ($('#loEmail')?.value || '').trim();
  if(dejaSaisi && $('#fgEmail')) $('#fgEmail').value = dejaSaisi;
  fgShow2(false);
  authShow('authForgot');
};
const _eFgBack = $('#fgBack'); if(_eFgBack) _eFgBack.onclick = () => authShow('authLogin');

async function fgDemandeCode(btn){
  const email = ($('#fgEmail')?.value || '').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authErr('Adresse email invalide.');
  authErr(''); authWait(btn, true);
  const r = await srvFetch('/auth/forgot', { method:'POST', body:{ email } });
  authWait(btn, false);
  if(!r.ok) return authErr(r.data.error || 'Envoi impossible — réessaie dans un instant.');
  _fgEmail = email;
  if($('#fgWho')) $('#fgWho').textContent = email;
  fgShow2(true);
  $('#fgCode')?.focus();
  /* Formulation NEUTRE : voir l'avertissement ci-dessus. */
  toast('📬 Si un compte existe pour cette adresse, un code vient de partir');
}
const _eFgSend = $('#btnFgSend'); if(_eFgSend) _eFgSend.onclick = () => { if(!authBusy) fgDemandeCode(_eFgSend); };
const _eFgAgain = $('#btnFgAgain'); if(_eFgAgain) _eFgAgain.onclick = () => { if(!authBusy) fgDemandeCode(_eFgAgain); };

const _eFgReset = $('#btnFgReset'); if(_eFgReset) _eFgReset.onclick = async () => {
  if(authBusy) return;
  const code = ($('#fgCode')?.value || '').trim();
  const p1 = $('#fgPass')?.value || '', p2 = $('#fgPass2')?.value || '';
  if(!/^\d{6}$/.test(code)) return authErr('Le code fait 6 chiffres.');
  if(p1.length < 8) return authErr('Mot de passe : 8 caractères minimum.');
  if(p1 !== p2) return authErr('Les deux mots de passe ne correspondent pas.');
  authErr(''); authWait(_eFgReset, true);
  const r = await srvFetch('/auth/reset', { method:'POST', body:{ email:_fgEmail, code, password:p1 } });
  authWait(_eFgReset, false);
  if(!r.ok) return authErr(r.data.error || 'Changement impossible.');
  /* Le serveur renvoie un jeton neuf : on est connecté dans la foulée. Faire
     retaper le mot de passe qu'on vient de choisir serait absurde. */
  setToken(r.data.token);
  lsSet(LS_AUTH, '1');
  const u = getUser() || {};
  setUser({ ...u, email:_fgEmail, created: u.created || Date.now() });
  /* on n'oublie pas les champs derrière soi : un mot de passe reste lisible
     dans le DOM, et cet écran peut être réaffiché */
  ['fgCode','fgPass','fgPass2'].forEach(id => { const e = $('#'+id); if(e) e.value = ''; });
  toast('🔑 Mot de passe changé — tu es connecté');
  await pullSync();
  enterApp();
};
/* Entrée valide l'étape en cours : sur téléphone, c'est la touche qu'on a sous
   le pouce, et devoir viser le bouton après avoir tapé six chiffres est pénible. */
['fgEmail','fgCode','fgPass','fgPass2'].forEach(id => {
  const e = $('#' + id);
  if(e) e.addEventListener('keydown', ev => {
    if(ev.key !== 'Enter') return;
    ev.preventDefault();
    ($('#fgStep2')?.classList.contains('hidden') ? _eFgSend : _eFgReset)?.click();
  });
});

/* garde anti double-clic : une inscription lancée deux fois enverrait
   deux codes et déclencherait l'anti-spam du serveur */
let authBusy = false;
const authWait = (btn, on) => { authBusy = on; if(btn) btn.disabled = on; };

const _e20 = $('#btnSignup'); if(_e20) _e20.onclick = async () => {
  if(authBusy) return;
  const email = $('#auEmail').value.trim().toLowerCase();
  const pseudo = $('#auPseudo').value.trim();
  const p1 = $('#auPass').value, p2 = $('#auPass2').value;
  if(!pseudo) return authErr('Choisis un pseudo.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authErr('Adresse email invalide.');
  if(p1.length < 8) return authErr('Mot de passe : 8 caractères minimum.');
  if(p1 !== p2) return authErr('Les deux mots de passe ne correspondent pas.');
  if(!$('#auPrivacy')?.checked) return authErr('Merci d’accepter la politique de confidentialité.');
  lsSet(LS_PRIVACY, PRIVACY_VERSION);           /* acceptation enregistrée */
  authErr(''); authWait(_e20, true);
  const r = await srvFetch('/auth/signup', { method:'POST', body:{ email, password:p1 } });
  authWait(_e20, false);
  if(!r.ok) return authErr(r.data.error || 'Inscription impossible.');
  /* le pseudo reste local : le serveur n'en a pas besoin */
  setUser({ email, pseudo, created: Date.now() });
  statCompte('inscription');
  $('#vfEmail').textContent = email;
  authShow('authVerify');
  toast('📬 Code envoyé — pense à regarder tes indésirables');
};

const _e21 = $('#btnResend'); if(_e21) _e21.onclick = async () => {
  if(authBusy) return;
  const u = getUser(); if(!u) return;
  authWait(_e21, true);
  const r = await srvFetch('/auth/forgot', { method:'POST', body:{ email:u.email } });
  authWait(_e21, false);
  authErr(r.ok ? '' : (r.data.error || 'Envoi impossible.'));
  if(r.ok) toast('📬 Nouveau code envoyé');
};

const _e22 = $('#btnVerify'); if(_e22) _e22.onclick = async () => {
  if(authBusy) return;
  const u = getUser(); if(!u) return;
  const code = $('#vfCode').value.trim();
  authErr(''); authWait(_e22, true);
  const r = await srvFetch('/auth/verify', { method:'POST', body:{ email:u.email, code } });
  authWait(_e22, false);
  if(!r.ok) return authErr(r.data.error || 'Code incorrect.');
  setToken(r.data.token);
  lsSet(LS_AUTH, '1');
  await pullSync();
  enterApp();
  toast('Compte vérifié — bienvenue ! 🎉');
};

/* ============================================================
   VOIR SON MOT DE PASSE
   ------------------------------------------------------------
   Une faute de frappe invisible est la première cause d'échec de connexion, et
   sur un clavier de téléphone on ne voit RIEN de ce qu'on tape. On ajoute donc
   un œil à chaque champ de mot de passe.

   Écrit comme une amélioration automatique plutôt qu'en dur dans le HTML :
   un seul endroit à lire, les trois champs (inscription, confirmation,
   connexion) sont couverts, et tout champ ajouté plus tard le sera aussi.
============================================================ */
function passEyes(){
  $$('input[type="password"]:not([data-eye])').forEach(inp => {
    inp.setAttribute('data-eye', '1');
    /* On enveloppe le champ pour pouvoir poser le bouton PAR-DESSUS, sans
       toucher à la structure « .field > label + input » du reste du site. */
    /* ⚠️ Un ŒIL DESSINÉ, plus l'emoji 👁️/🙈. Trois raisons, dans l'ordre :
       l'emoji est le dernier caractère en couleur de l'interface (tout le reste
       est passé au trait) ; son dessin change d'un système à l'autre, et sur
       Windows il sortait en glyphe noir et blanc ; et « singe qui se cache les
       yeux » n'a jamais voulu dire « masquer un mot de passe ».
       Le trait barré est la convention universelle du « caché ». */
    const box = document.createElement('div');
    box.className = 'pass-wrap';
    inp.parentNode.insertBefore(box, inp);
    box.appendChild(inp);

    const b = document.createElement('button');
    b.type = 'button';               /* ⚠️ sinon il valide le formulaire */
    b.className = 'pass-eye';
    b.tabIndex = 0;
    const dire = () => {
      const vu = inp.type === 'text';
      b.innerHTML = ICO_OEIL(vu);
      b.setAttribute('aria-pressed', vu ? 'true' : 'false');
      b.setAttribute('aria-label', isEN()
        ? (vu ? 'Hide the password' : 'Show the password')
        : (vu ? 'Masquer le mot de passe' : 'Afficher le mot de passe'));
      b.title = b.getAttribute('aria-label');
    };
    b.onclick = () => {
      /* On garde la position du curseur : sans ça, il saute à la fin et
         corriger une faute au milieu devient pénible. */
      const d = inp.selectionStart, f = inp.selectionEnd;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      dire();
      inp.focus();
      try{ inp.setSelectionRange(d, f); }catch(e){}
    };
    dire();
    box.appendChild(b);
  });
}
passEyes();
/* Les champs de l'authentification existent dès le départ, mais on couvre aussi
   ceux qui apparaîtraient plus tard.
   ⚠️ On INSPECTE les nœuds ajoutés au lieu de rebalayer la page entière. La
   version précédente appelait passEyes() — donc un querySelectorAll global — à
   chaque lot de mutations, alors que l'app réécrit de gros blocs de HTML en
   permanence (le plan, la liste du blog, la galerie). Ce travail était perdu
   dans la quasi-totalité des cas : un mot de passe n'apparaît qu'à
   l'authentification. */
new MutationObserver(muts => {
  for(const m of muts) for(const n of m.addedNodes){
    if(n.nodeType !== 1) continue;
    if(n.matches?.('input[type="password"]:not([data-eye])')
       || n.querySelector?.('input[type="password"]:not([data-eye])')){ passEyes(); return; }
  }
}).observe(document.body, { childList:true, subtree:true });
/* ⚠️ On REMASQUE en quittant l'écran : un mot de passe laissé en clair reste
   lisible par-dessus l'épaule, et il partirait dans une capture d'écran. */
function passEyesReset(){
  $$('input[type="text"][data-eye]').forEach(i => {
    i.type = 'password';
    const b = i.parentNode.querySelector('.pass-eye');
    if(b){
      b.innerHTML = ICO_OEIL(false);
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', isEN() ? 'Show the password' : 'Afficher le mot de passe');
      b.title = b.getAttribute('aria-label');
    }
  });
}

const _e23 = $('#btnLogin'); if(_e23) _e23.onclick = async () => {
  if(authBusy) return;
  const email = $('#loEmail').value.trim().toLowerCase();
  const pass = $('#loPass').value;
  authErr(''); authWait(_e23, true);
  const r = await srvFetch('/auth/login', { method:'POST', body:{ email, password:pass } });
  authWait(_e23, false);
  /* compte existant mais adresse jamais confirmée : le serveur a renvoyé
     un code, on bascule sur l'écran de vérification */
  if(!r.ok && r.data && r.data.etape === 'verification'){
    setUser({ ...(getUser() || {}), email });
    $('#vfEmail').textContent = email;
    authShow('authVerify');
    return authErr(r.data.error || '');
  }
  if(!r.ok) return authErr(r.data.error || 'Connexion impossible.');
  setToken(r.data.token);
  const prev = getUser() || {};
  setUser({ ...prev, email, pseudo: prev.email === email ? prev.pseudo : (prev.pseudo || email.split('@')[0]) });
  lsSet(LS_AUTH, '1');
  await pullSync();
  enterApp();
  toast('Re-bonjour ' + email.split('@')[0] + ' 👋');
};

function enterApp(){
  $('#authWrap').classList.add('hidden');
  passEyesReset();   /* on ne laisse pas un mot de passe en clair derrière soi */
  /* si la politique a changé depuis la dernière acceptation, on la redemande
     avant tout le reste */
  if(!requirePrivacy()) return;
  renderProfile(); renderSettings(); renderGallery(); checkNews();
  /* Après la lecture de l'état : c'est safeState qui vient de lever le drapeau. */
  futurBarMaj();
  /* ⚠️ L'ORDRE COMPTE, et c'est tout l'objet du changement : Acolyte POSE SES
     QUESTIONS d'abord, il explique ensuite. qzShow() renvoie faux si elles ont
     déjà été posées — dans ce cas on enchaîne directement sur les explications,
     et à la fin des questions c'est qzTermine() qui les enclenche.
     Ne PAS appeler les deux à la suite : les deux calques s'ouvriraient l'un
     par-dessus l'autre à la première visite. */
  if(!qzShow()) showOnboard();
}

/* ============================================================
   NOUVEAUTÉS — journal des mises à jour.
   Pour publier une màj : ajoute une entrée EN HAUT de CHANGELOG
   (date au format AAAA-MM-JJ) et incrémente CACHE dans sw.js.
============================================================ */
const CHANGELOG = [
  { v:'7.9', date:'2026-08-17', titre:'L’assistant ne refuse plus ce qu’il sait faire', items:[
    '🛠️ « Modifie l’après-midi du jour 3 » juste après avoir créé ton voyage : l’assistant répondait qu’il fallait d’abord créer un voyage. Il construit maintenant la journée visée, puis applique ta demande',
    '🎯 Il comprend quelle journée tu désignes — « jour 3 », « J3 », « la troisième journée » — et va modifier celle-là',
    '💬 Quand tu ne précises aucun jour, il prend le premier et le dit, au lieu de choisir en silence'
  ]},
  { v:'7.8', date:'2026-08-17', titre:'L’onglet Voyage remis en ordre', items:[
    '🗂️ Les sept onglets du voyage tiennent enfin tous à l’écran : ils se rangent sur trois rangées au lieu de défiler. Budget et Maison n’étaient tout simplement pas visibles',
    '🧭 Ils sont rangés dans l’ordre du voyage : ce qui sert sur place d’abord, ce qui sert avant de partir ensuite',
    '✨ Le renvoi vers l’assistant passe sous ton voyage — tu vois ton billet et ton programme en arrivant, pas un lien vers un autre onglet',
    '⚠️ Dans « Gérer ce voyage », les six boutons identiques deviennent trois groupes nommés, et « Nouveau voyage » — qui efface tout — est isolé en rouge, avec ce qu’il supprime écrit noir sur blanc'
  ]},
  { v:'7.7', date:'2026-08-16', titre:'Ton passeport, et un cran de sécurité', items:[
    '🆘 Ton contact d’urgence s’affiche enfin — dans ton passeport et sous les numéros de secours du pays. Il était demandé puis jamais montré',
    '💱 Ta monnaie sert vraiment : les taux de change partent d’elle, plus de l’euro imposé',
    '🏅 Cinq badges de terrain qui ne se débloquent qu’en voyageant pour de bon — pas depuis ton canapé',
    '📈 Ton niveau dit ce qu’il reste avant le suivant, et le passeport compte tes pays et tes jours',
    '🧠 « Ce qu’Acolyte a appris de toi » : ce qu’il a retenu de tes goûts s’affiche en clair, avec un bouton pour tout oublier',
    '🔒 Les deux bibliothèques chargées depuis l’extérieur sont désormais scellées par empreinte : un fichier modifié en route est refusé au lieu d’être exécuté',
    '🛡️ Le site ne peut plus parler qu’à son propre serveur, et non à n’importe quel voisin de son hébergeur'
  ]},
  { v:'7.6', date:'2026-08-16', titre:'Acolyte te suit sur place', items:[
    '📍 « Autour de moi » : où manger, se soigner, retirer de l’argent près de toi — relevé sur la carte réelle, pas inventé, et ajouté au programme du jour en un bouton',
    '🎚️ Trois curseurs de dosage avant la recherche : Ville ou Nature, Lent ou Intense, Économe ou Confort. Laissés au centre, ils ne disent rien — c’est voulu',
    '🧠 Acolyte retient ce que tu retires de tes journées : trois musées supprimés et il cesse d’en proposer',
    '🍽️ Ton régime et tes allergies sont désormais une contrainte, pas une préférence : chaque adresse proposée doit avoir une vraie option pour toi',
    '🏘️ Mode « comme un habitant » : les pièges à touristes sautent de tout le voyage, pas seulement des restaurants'
  ]},
  { v:'7.5', date:'2026-08-15', titre:'Les lieux inventés, c’est fini', items:[
    '🛡️ Chaque lieu de ton programme est confronté à la carte après coup. Un nom réel situé à 1000 km de ta destination est signalé — rien n’est supprimé, tu tranches',
    '🧩 Le glisser-déposer arrive dans tes journées : déplace une activité au doigt, les horaires restent à leur place',
    '🔑 Nouvel onglet « Avant de partir » : couper l’eau, confier le chat, faire suivre le courrier. La liste s’adapte à ton voyage et ne part sur aucun serveur',
    '🎨 Le fond du site prend la couleur de ta destination — sable pour la plage, gris bleuté pour la montagne. Une nuance, jamais une repeinte',
    '🕹️ « Où est-ce ? » pioche dans les lieux de TON voyage, avec leurs vraies photos'
  ]},
  { v:'7.4', date:'2026-08-14', titre:'Attendre autrement', items:[
    '🎮 Quand la génération prend du temps, Acolyte te propose un jeu. Et si ton voyage arrive pendant la partie, il attend que tu aies fini',
    '⏳ Mode plein écran « compte à rebours » : le nombre de jours avant le départ, en grand, pour poser sur un meuble. Raccourci depuis l’écran d’accueil une fois l’application installée',
    '🔄 « Refaire cette journée » ne passe plus par une boîte grise du navigateur : six raisons proposées, ou la tienne'
  ]},
  { v:'7.3', date:'2026-08-12', titre:'Le questionnaire respire', items:[
    '🧾 Trois blocs au lieu d’un mur de champs : où et quand, budget et compagnie, style de voyage',
    '📊 Une barre de progression suit les trois étapes du parcours',
    '💶 Mode « budget inversé » : tu donnes ce que tu as, Acolyte ajuste la durée et le transport pour y tenir — et dit ce qu’il a sacrifié',
    '📖 Choisir une ambiance fait remonter un article du Journal, pour donner envie au bon moment'
  ]},
  { v:'7.2', date:'2026-08-10', titre:'Corrections', items:[
    '🔍 L’animation de recherche tournait en boucle et cachait les onglets quand c’était l’assistant qui cherchait — corrigé',
    '💾 Un voyage préparé sur une version récente puis rouvert sur une ancienne perdait ses réglages. Ils sont maintenant mis de côté et rendus au retour',
    '📨 Le bouton « Envoyer » de l’assistant ne répondait plus du tout — corrigé',
    '🚩 Les drapeaux ne s’affichent plus en carrés vides sur Windows : une épingle prend le relais'
  ]},
  { v:'7.1', date:'2026-08-06', titre:'Plus facile à viser au pouce', items:[
    '👍 Sur téléphone, 20 boutons trop petits passent à 44 px de haut — ceux du profil, la réinitialisation, le curseur de taille du texte',
    '✏️ L’œil des champs de mot de passe est dessiné au trait : le même sur tous les appareils, et barré quand le mot de passe est visible',
    '❓ Acolyte te pose cinq questions à ta première arrivée, et tu peux les passer une par une ou toutes d’un coup'
  ]},
  { v:'7.0', date:'2026-08-06', titre:'Les onglets passent en haut', items:[
    '🧭 Sur ordinateur, les onglets forment une barre en haut du site : plus de colonne flottante à droite, et 132 px de largeur récupérés pour le contenu',
    '🌙 Le thème, l’installation et ton compte sont désormais à portée de main en haut à droite, quel que soit l’écran où tu te trouves',
    '📍 La colonne de gauche s’allège : les étapes deviennent trois points sur un fil, le bloc du bas n’est plus une carte',
    '🔢 Le nombre d’articles de la rubrique choisie était devenu illisible dans le journal — corrigé',
    '✏️ Les icônes de la barre sont redessinées : la carte et l’avion ne ressemblent plus à un gribouillis',
    '👤 Ton compte se lit enfin d’un coup d’œil : deux colonnes, plus d’aplats jaunes empilés, et la suppression isolée en bas',
    '🔵 Sur la page de connexion, la case de la politique et la mascotte étaient trop grosses — remises à leur taille'
  ]},
  { v:'6.9', date:'2026-08-05', titre:'Le journal, en vrai journal', items:[
    '📰 Un article à la une, les autres en trois colonnes — plus une pile de fiches identiques',
    '🗂️ Une colonne pour parcourir le journal par rubrique, avec le nombre d’articles de chacune',
    '📅 La date et le temps de lecture sur chaque article, écrits comme dans un journal'
  ]},
  { v:'6.8', date:'2026-08-05', titre:'Google sur la carte, et des icônes dessinées', items:[
    '🗺️ La carte passe sur Google quand tu as du réseau — avec le vrai itinéraire à pied entre tes étapes',
    '📴 Et elle bascule toute seule sur la carte hors-ligne d’Acolyte dès que le réseau manque : la promesse tient toujours',
    '✏️ Les icônes de l’app sont désormais dessinées au trait. La mascotte redevient le seul élément coloré'
  ]},
  { v:'6.7', date:'2026-08-05', titre:'Un nouvel écran d’accueil', items:[
    '✨ La création de compte et la connexion changent de visage : la promesse à gauche, le formulaire à droite',
    '📱 Sur téléphone, le formulaire seul — c’est lui qui compte sur un petit écran',
    '✍️ Des champs plus légers, soulignés au lieu d’être encadrés'
  ]},
  { v:'6.6', date:'2026-08-04', titre:'En cas d’urgence', items:[
    '🆘 Les numéros d’urgence du pays, dans l’onglet Papiers — consultables sans réseau et appelables d’un appui',
    '🇫🇷 Et le rappel d’enregistrer le numéro du consulat avant de partir',
    '📰 Dans le jeu des merveilles, le bouton « Lire l’article » n’apparaît plus que si l’article existe vraiment'
  ]},
  { v:'6.5', date:'2026-08-04', titre:'Mot de passe oublié', items:[
    '🔑 Un lien « Mot de passe oublié ? » sur l’écran de connexion : tu reçois un code, tu en choisis un nouveau, et tu es connecté dans la foulée',
    '🛡️ Le changement coupe toutes les sessions ouvertes ailleurs — le bon réflexe si tu te crois piraté',
    '🔐 Quand ta session expire, Acolyte te le dit et te ramène à la connexion, au lieu d’échouer en silence'
  ]},
  { v:'6.4', date:'2026-08-04', titre:'Les prix, ton allure, et le partage', items:[
    '💶 Le prix d’entrée de chaque visite, avec le total de la journée — modifiable si tu trouves mieux',
    '🚶 Dis dans tes préférences comment tu te déplaces sur place : à pied, à vélo, en transports ou en voiture. Les durées et le regroupement des journées suivent',
    '🤝 Donne ton voyage à un ami : un fichier avec tout le programme, sans aucune donnée personnelle',
    '❓ Une visite guidée en 8 écrans pour les nouveaux comptes, et un bouton pour la revoir'
  ]},
  { v:'6.3', date:'2026-08-04', titre:'Pendant le voyage', items:[
    '📍 Le mode Jour J : sur place, Acolyte n’affiche que ta prochaine étape, l’heure, la distance à pied et ce qu’il te reste à dépenser',
    '🚶 Entre deux moments d’une journée, le temps de marche s’affiche — et te prévient quand c’est trop loin',
    '💶 Ton budget réel face au prévu, avec un repère qui montre où tu en es du séjour',
    '📅 Ton voyage s’ajoute à ton agenda : une journée = un événement, avec le programme en détail',
    '📑 Les longs articles du journal ont maintenant un sommaire cliquable'
  ]},
  { v:'6.2', date:'2026-08-03', titre:'Lire, puis partir', items:[
    '✈️ Un bouton « Partir à… » au bas de chaque article : l’envie de lire devient un voyage en un clic',
    '↗ Un bouton pour partager un article — le partage du téléphone sur mobile, le lien copié ailleurs',
    '📡 Le journal a désormais un flux : tu peux le suivre dans ton lecteur d’actualités',
    '🗿 Dix merveilles de plus au programme du journal — celles du jeu « Où est-ce ? » n’étaient pas prévues'
  ]},
  { v:'6.1', date:'2026-08-03', titre:'Chez toi sur ton téléphone', items:[
    '🍏 Sur iPhone, la barre du bas devient du verre translucide et les boutons prennent le ressort d’iOS',
    '🤖 Sur Android, la pastille Material se glisse sous l’icône active et une onde part de chaque appui',
    '✨ Rien d’autre ne change : seuls la barre, les boutons et leurs animations s’adaptent au système'
  ]},
  { v:'6.0', date:'2026-08-03', titre:'Plus confortable au doigt, mieux écrit', items:[
    '👆 Les puces, les cases et les onglets sont plus grands sur téléphone — on ne les rate plus',
    '🔠 Les libellés de navigation et des étapes ne sont plus en tout petit',
    '✍️ Chaque article du blog est maintenant RELU et réécrit avant publication : moins de langue de bois, de meilleures attaques, plus de faits',
    '🛂 La relecture du voyage contrôle aussi les formalités et les prix locaux — une erreur de visa fait rater un avion'
  ]},
  { v:'5.9', date:'2026-08-01', titre:'Installer Acolyte, sur tous les appareils', items:[
    '📲 Un bouton « Installer » dans ton profil — il ne s’affichait jamais sur iPhone, il y est enfin',
    '🍎 Sur iPhone, Acolyte t’explique les trois gestes : Apple interdit à un site de s’installer lui-même',
    '✨ Quand ton voyage est prêt, Acolyte te propose de le garder sous la main — une seule fois, jamais s’il est déjà installé',
    '🛡️ Et il te dit pourquoi ça compte : Safari efface les données d’un site après 7 jours sans visite, une app installée en est exemptée'
  ]},
  { v:'5.8', date:'2026-08-01', titre:'Papiers, formalités et prix sur place', items:[
    '🛂 Un onglet « Papiers » : visa, validité du passeport, santé, et le lien vers la fiche officielle du ministère',
    '🔌 La prise électrique et la tension du pays — données fiables, elles ne viennent pas de l’IA',
    '💶 Ce que coûtent vraiment un café, un repas ou un ticket de métro sur place, dans la monnaie locale',
    '⚠️ Un avertissement clair : les règles d’entrée changent, vérifie toujours à la source officielle'
  ]},
  { v:'5.7', date:'2026-08-01', titre:'Toujours une image, et accessible à tous', items:[
    '🖼️ Chaque article a désormais une image : quand la photo manque, une couverture est dessinée pour lui',
    '🔎 Acolyte cherche l’illustration de trois façons au lieu d’une — beaucoup d’articles en manquaient pour rien',
    '♿ Un lien « Aller au contenu » pour la navigation au clavier, et tous les boutons atteignables au doigt',
    '🏷️ Chaque champ et chaque image porte enfin son étiquette pour les lecteurs d’écran'
  ]},
  { v:'5.6', date:'2026-07-31', titre:'Mentions légales et RGPD', items:[
    '⚖️ Des mentions légales complètes, accessibles depuis le bas de chaque page',
    '🌍 On te dit noir sur blanc que tes données partent aux États-Unis, lesquelles, et sur quelle base',
    '📜 Chaque usage de tes données a sa base légale expliquée, et tes droits s’exercent sans rien demander à personne',
    '🇫🇷 Le droit de saisir la CNIL est indiqué, avec son adresse'
  ]},
  { v:'5.5', date:'2026-07-31', titre:'Le monde entier, et les jeux au doigt', items:[
    '🌍 Tous les pays du monde sont reconnus — il n’y en avait que 65, presque tous européens',
    '🎮 La salle de jeux s’ouvre enfin sur téléphone : elle était réservée aux ordinateurs, et le Pong y était injouable',
    '👁️ Un œil dans les champs de mot de passe : plus besoin de deviner ce qu’on tape',
    '📋 La colonne de gauche se tait pendant la lecture d’un article, et retrouve les étapes côté voyage'
  ]},
  { v:'5.4', date:'2026-07-31', titre:'Une icône sans cadre blanc', items:[
    '🅰️ Plus de carré blanc autour du A : l’icône est détourée, elle se pose proprement sur ton bureau comme sur ton écran d’accueil',
    '🌑 L’écran de lancement de l’application ne flashe plus en blanc',
    '📋 Sur ordinateur, la colonne de gauche ne répète plus les étapes — le fil au-dessus du formulaire les affichait déjà'
  ]},
  { v:'5.3', date:'2026-07-30', titre:'Les articles ont enfin leur adresse', items:[
    '🔗 Chaque article du journal a maintenant son propre lien : tu peux le partager, et Google peut le trouver',
    '📝 Un article par heure au lieu d’un toutes les six heures, et l’écriture a été retravaillée en profondeur',
    '🅰️ L’icône de l’application a des coins arrondis — elle ne fait plus tache sur le bureau',
    '🔤 Le logo se lit correctement même si le globe tarde à s’afficher, et la mascotte est pile sur la ligne'
  ]},
  { v:'5.2', date:'2026-07-30', titre:'Nouveau logo et blog sur téléphone', items:[
    '🅰️ Le nouveau logo d’Acolyte est partout : icône de l’onglet dans le navigateur, écran d’accueil du téléphone, aperçu quand tu partages le lien',
    '📰 L’onglet Blog arrive sur téléphone — il était réservé à l’ordinateur',
    '🗺️ Les journées du voyage ne s’affichent plus qu’à un seul endroit sur ordinateur : la colonne de gauche'
  ]},
  { v:'5.1', date:'2026-07-30', titre:'Plus lisible, partout', items:[
    '🟡 Fini le texte blanc sur les aplats jaunes : l’heure d’un moment, les messages, les en-têtes, le pseudo — tout repasse en encre foncée',
    '🎨 Même correction sur les pastilles et boutons de couleur (vert, orange, violet, rouge) : leur écriture s’adapte enfin au thème',
    '🗺️ Sur ordinateur, la vue Carte ne liste plus les journées deux fois : la colonne de gauche s’en charge, et elle répond au clavier',
    '🗑️ Les corbeilles retrouvent leur couleur',
    '👁️ Les textes secondaires du mode sombre sont plus lumineux, et les vignettes de la carte postale réagissent enfin au survol'
  ]},
  { v:'5.0', date:'2026-07-24', titre:'Des voyages à travers plusieurs pays', items:[
    '🌍 Une case à cocher dans le questionnaire : « Traverser plusieurs pays », et Acolyte construit un grand itinéraire',
    '🧭 Acolyte enchaîne alors les étapes dans un ordre logique, avec les trajets entre elles comptés dans le budget',
    '📷 Le QR de ton ticket s’ouvre maintenant avec l’appareil photo de n’importe quel téléphone — plus besoin de passer par l’app',
    '🔗 Un lien de voyage reçu quand Acolyte est déjà ouvert s’importe tout de suite'
  ]},
  { v:'4.9', date:'2026-07-24', titre:'Des chiffres plus clairs côté coulisses', items:[
    '📊 Le tableau de bord montre l’essentiel d’un coup d’œil : courbe des inscriptions, parcours, saisons, budgets',
    '🔒 Rien de personnel n’y apparaît : uniquement des totaux, et les répartitions se taisent tant que la base est petite'
  ]},
  { v:'4.8', date:'2026-07-24', titre:'Tes données mieux protégées', items:[
    '🛡️ Un voyage importé (fichier, QR, lien) est désormais inspecté et nettoyé avant d’entrer dans l’app',
    '🔐 Tes sessions durent 30 jours au lieu de 90, et seuls tes 5 derniers appareils restent connectés',
    '🧹 Ce qui ne sert plus est effacé tout seul : sessions expirées, codes de vérification périmés'
  ]},
  { v:'4.7', date:'2026-07-24', titre:'Une vraie salle de jeux', items:[
    '🕹️ Deux clics sur la mascotte et tu choisis parmi quatre mini-jeux',
    '🌍 « Où est-ce ? » : une photo de monument, à toi de le situer sur la carte et de le nommer',
    '🏓 « Ne me lâche pas » : un pong où la mascotte est la balle — et elle râle à chaque choc',
    '🧳 « Bagage express » : le tapis défile, attrape ce qu’il faut emporter avant que la destination change'
  ]},
  { v:'4.6', date:'2026-07-24', titre:'Acolyte parle anglais', items:[
    '🇬🇧 Bascule tout Acolyte en anglais depuis ton profil — interface comprise',
    '✈️ Tes voyages sont aussi écrits en anglais : programme, conseils, budget, tout',
    '🌍 Si ton téléphone n’est pas en français, Acolyte s’ouvre directement en anglais'
  ]},
  { v:'4.5', date:'2026-07-24', titre:'Une carte qui montre enfin ta journée', items:[
    '🗺️ Chaque journée se lit d’un coup d’œil : tes étapes numérotées, reliées dans l’ordre de la balade, avec ton hôtel repéré',
    '📍 « Où je suis » te dit à quelle distance est ta prochaine étape et en combien de minutes à pied',
    '🏨 Ton hôtel apparaît sur chaque journée : tu vois d’un coup d’œil ce qui est près de là où tu dors',
    '📴 La carte reste consultable sans connexion une fois que tu l’as ouverte — pratique en avion ou à l’étranger'
  ]},
  { v:'4.4', date:'2026-07-24', titre:'Des restaurants qui existent vraiment', items:[
    '🍽️ Acolyte relève les vraies adresses du quartier et choisit parmi elles — fini les restaurants inventés',
    '💶 Il vise le bon rapport qualité/prix : cuisine locale, menu du midi, loin des pièges à touristes',
    '🍴 Chaque adresse indique le plat à commander, une fourchette de prix chiffrée et pourquoi elle vaut le détour'
  ]},
  { v:'4.3', date:'2026-07-24', titre:'Le jeu monte d’un cran', items:[
    '🔥 Enchaîne les tirs sans laisser passer d’astéroïde : ton multiplicateur grimpe jusqu’à ×5',
    '✨ Astéroïdes dorés qui rapportent triple, points qui s’envolent, niveaux et secousse à l’impact',
    '🏅 Ton record personnel est gardé, et Échap ferme le jeu'
  ]},
  { v:'4.2', date:'2026-07-24', titre:'Un jeu personnalisable et un transport enfin clair', items:[
    '🎨 Le jeu « Défends la Terre » est plus grand et personnalisable : change le style des astéroïdes et de la planète (sans changer la difficulté)',
    '🚆 L’onglet Transport est réécrit : ce que tu prends, pourquoi, le prix et l’impact climat — en clair',
    '🌍 L’animation « tour du monde » n’apparaît plus que pour la recherche de destinations ; ailleurs, c’est la mascotte seule'
  ]},
  { v:'4.1', date:'2026-07-24', titre:'Un jeu caché, un budget clair et de belles adresses', items:[
    '🛰️ Clique 3 fois sur le globe du logo (sur ordinateur) : défends la Terre contre les astéroïdes, avec un classement !',
    '💶 L’onglet Budget montre où part ton argent, poste par poste, avec le coût par jour',
    '🏨 Les logements ont de vraies fiches : étoiles, prix par nuit, et Airbnb pour les appartements'
  ]},
  { v:'4.0', date:'2026-07-24', titre:'Nouveau look et voyage en temps réel', items:[
    '🌍 Le globe coiffe désormais le « i » d’ACOLYTE — un vrai logo',
    '✨ Écran de démarrage à l’effigie de la mascotte, et transitions plus douces entre les écrans',
    '📍 Pendant ton séjour, Acolyte s’ouvre directement sur la journée du moment'
  ]},
  { v:'3.8', date:'2026-07-24', titre:'Un titre, et un secret bien caché', items:[
    '🧳 La barre de ton voyage a désormais un titre « Ton voyage »',
    '🎳 Un easter egg attend les curieux du côté de la mascotte… (sur ordinateur)'
  ]},
  { v:'3.7', date:'2026-07-24', titre:'C’est la mascotte qui s’occupe de tout', items:[
    '💬 Pendant les recherches, la mascotte te parle dans une bulle : c’est elle qui travaille',
    '🧹 Fini le jargon : plus de détails techniques, plus de réglages compliqués',
    '😌 Un souci ? Un message clair et un bouton pour le signaler en un clic',
    '🔒 Politique de confidentialité renforcée et transparente',
    '🌙 L’animation de chargement gagne un ciel étoilé la nuit'
  ]},
  { v:'3.6', date:'2026-07-23', titre:'Des détails qui prennent vie', items:[
    '👀 Sur ordinateur, les yeux de la mascotte suivent ta souris',
    '🌅 L’animation de chargement gagne un ciel, des nuages et un sol — la mascotte survole vraiment le monde',
    '🎛️ La barre Programme · Logement · Transport · Événements · Budget est plus soignée',
    '📊 Le tableau qui compare tes destinations est plus clair : lignes alternées, en-têtes nets'
  ]},
  { v:'3.5', date:'2026-07-23', titre:'La mascotte survole les monuments du monde', items:[
    '🗼 Pendant les chargements, la mascotte survole une ligne d’horizon des grands monuments — Tour Eiffel, Pyramides, Colisée, Big Ben, Taj Mahal, Statue de la Liberté'
  ]},
  { v:'3.4', date:'2026-07-23', titre:'Mascotte joueuse, confidentialité et page épurée', items:[
    '🌍 Clique sur la mascotte : elle saute ! Et elle réagit toute seule de temps en temps',
    '🔒 Une politique de confidentialité claire, à accepter à la création du compte',
    '🧳 Dans « Mes voyages », un bouton déplie tous tes voyages au-delà de trois',
    '🧹 Page « Ton voyage » épurée : le trajet passe dans l’onglet Transport, le conseil dans Programme',
    '🧭 Le bandeau de trajet est plus lisible : départ, arrivée et infos en étiquettes'
  ]},
  { v:'3.3', date:'2026-07-23', titre:'Un bandeau de trajet plus clair et des événements automatiques', items:[
    '🧭 Le bandeau de ton trajet est redessiné : le départ et l’arrivée en grand, les infos en étiquettes lisibles',
    '🎉 Plus besoin de cliquer « Voir les événements » : Acolyte les cherche dès qu’il organise ton voyage',
    '➕ Ils sont prêts dans l’onglet Événements, à ajouter à ton programme en un clic'
  ]},
  { v:'3.2', date:'2026-07-23', titre:'La page « Ton voyage » remise au clair', items:[
    '🧳 « Ton voyage » ne montre plus que ton trajet en un coup d’œil',
    '🎛️ Une barre juste en dessous range TOUT le reste : Programme · Logement · Transport · Événements · Budget',
    '🕘 Les boutons d’une journée sont enfin explicites : « Voir heure par heure » et « Refaire ce jour »',
    '🎫 « Réserver » se replie comme « Gérer ce voyage » — la page respire'
  ]},
  { v:'3.1', date:'2026-07-23', titre:'La synchronisation des voyages fonctionne', items:[
    '☁️ Tes voyages remontent bien sur ton compte, même les gros — seules les cartes hors-ligne restent sur chaque appareil (elles se refont toutes seules)',
    '🔔 Si la synchro échoue, tu es prévenu au lieu de le découvrir trop tard'
  ]},
  { v:'3.0', date:'2026-07-23', titre:'Ton compte te suit sur tous tes appareils', items:[
    '☁️ Tes voyages sont enregistrés sur ton compte — retrouve-les sur ton téléphone comme sur ton ordinateur',
    '🔐 Ton mot de passe n’est plus jamais stocké en clair, et ton code de vérification arrive par email',
    '🔑 Mot de passe oublié : reçois un code et choisis-en un nouveau',
    '🗑️ Supprimer ton compte efface aussi tout ce qui était enregistré côté serveur'
  ]},
  { v:'2.4', date:'2026-07-22', titre:'Des détails plus confortables', items:[
    '🚆 Le choix du transport devient un menu déroulant, comme les autres questions',
    '👍 Les boutons j’aime, j’aime pas et commentaire sont mieux espacés dans chaque journée',
    '💛 Le bloc « donne ton avis » a été redessiné'
  ]},
  { v:'2.3', date:'2026-07-22', titre:'Tu choisis comment tu voyages', items:[
    '🚆 Nouveau choix dans le questionnaire : train, voiture, avion ou peu importe — Acolyte construit le trajet avec ce que tu as choisi',
    '🌍 Le logo est plus grand, la mascotte se voit enfin',
    '🧳 Quand Acolyte ne propose qu’un seul voyage, il se déploie en largeur sur ordinateur',
    '🧹 La fiche pratique a été retirée'
  ]},
  { v:'2.2', date:'2026-07-22', titre:'Des logements qui existent vraiment', items:[
    '🏨 Acolyte relève les hébergements réels autour de ton quartier sur OpenStreetMap, puis choisit dedans',
    '📍 Chaque proposition existe donc pour de vrai, avec sa distance au quartier conseillé',
    '🔗 Les liens Airbnb, Booking et Abritel restent pré-remplis avec tes dates pour voir les prix du jour'
  ]},
  { v:'2.1', date:'2026-07-22', titre:'Des boutons et des cartes bien alignés', items:[
    '🔘 Les 4 boutons du questionnaire font tous la même taille — plus aucun tout seul sur sa ligne',
    '🧱 « Réserver » et « À savoir avant de partir » ont désormais la même hauteur',
    '📌 Le bouton « fiche pratique » se cale en bas de sa carte, sur toute la largeur'
  ]},
  { v:'2.0', date:'2026-07-22', titre:'La mascotte prend la place du logo', items:[
    '🌍 Le globe aux grands yeux remplace le carré orange, en haut à gauche',
    '🧭 Carte · Voyage · Profil filent tout au bout de la barre',
    '🪜 Questions · Les choix · Ton voyage sont bien détachés les uns des autres',
    '✨ « Quoi de neuf » se lit comme une frise : les versions s’enchaînent, la dernière est mise en avant'
  ]},
  { v:'1.9', date:'2026-07-22', titre:'Un écran d’ordinateur mieux rempli', items:[
    '🎯 Les 3 étapes et les onglets ne s’étirent plus aux quatre coins de l’écran',
    '🔘 Les boutons se rangent en ligne au lieu d’empiler quatre barres',
    '💛 Le bloc « donne ton avis » est plus clair, et ne tombe plus juste après la suppression de compte'
  ]},
  { v:'1.8', date:'2026-07-22', titre:'Une barre en haut, et un mode sombre qui ne pique plus les yeux', items:[
    '🧭 Sur ordinateur, Carte · Voyage · Profil passent dans une barre en haut du site',
    '🌙 Mode sombre : quand tu écris dans une case, le texte reste lisible — la case ne vire plus au blanc',
    '🌙 L’étape verrouillée et les cartes survolées ne s’éclairent plus en blanc non plus',
    '📱 Sur téléphone, la barre reste en bas, à portée de pouce'
  ]},
  { v:'1.7', date:'2026-07-22', titre:'Acolyte s’installe enfin sur grand écran', items:[
    '🖥️ Sur ordinateur, la barre du bas devient un petit îlot posé au centre — fini le bandeau qui traverse tout l’écran',
    '🧳 Dans « Ton voyage », « Réserver » et « À savoir avant de partir » se placent côte à côte : deux fois moins à faire défiler',
    '💶 Le budget s’affiche sur une seule ligne au lieu de deux',
    '📱 Rien ne change sur téléphone'
  ]},
  { v:'1.6', date:'2026-07-22', titre:'Une mascotte pendant les chargements', items:[
    '🌍 Le globe d’Acolyte tourne les yeux partout pendant que l’IA réfléchit',
    '✨ Il remplace l’ancien rond qui tournait, sur tous les écrans de chargement',
    '♿ Animation coupée automatiquement si tu as réduit les animations sur ton appareil'
  ]},
  { v:'1.5', date:'2026-07-21', titre:'Prix réels automatiques et vue voyage épurée', items:[
    '💶 Prix réels du transport chargés tout seuls — plus aucun bouton « simuler »',
    '🏨 Vrais logements sélectionnés pour ton quartier, avec lien de réservation pré-rempli',
    '🧭 Vue « Ton voyage » repensée en onglets : Programme · Logement · Événements · Budget',
    '➕ Ajoute un événement à ton programme en un clic',
    '🐢 Mode réseau faible : chargements allégés et reprise automatique au retour du réseau',
    '📄 Carnet PDF entièrement redessiné'
  ]},
  { v:'1.4', date:'2026-07-20', titre:'Hors-ligne, multi-pays et voyage à plusieurs', items:[
    '🗺️ Cartes de chaque journée téléchargeables : consultables sans réseau',
    '📄 Carnet de voyage en PDF : plan complet + n° de réservation, à emporter',
    '🌍 Voyages multi-pays : découpage en étapes, logement et jours par ville',
    '👍 Tableau partagé : votes et commentaires sur chaque journée',
    '🧭 Vue « Ton voyage » réorganisée : le programme d’abord, le détail replié'
  ]},
  { v:'1.3', date:'2026-07-19', titre:'L’IA raisonne dans l’ordre', items:[
    '🧠 Nouveau pipeline : ville → transport (CO₂, temps, prix) → lieux → logement → jours',
    '🕘 Programme heure par heure pour chaque journée',
    '🌍 Empreinte carbone du trajet avec l’alternative plus sobre',
    '📍 Mode « Jour J » : ta journée en cours mise en avant pendant le voyage'
  ]},
  { v:'1.2', date:'2026-07-18', titre:'Souvenirs et personnalisation', items:[
    '🖼️ Carte postale : 8 modèles, 6 styles, tes photos ou celles du web',
    '🎫 Ticket d’embarquement souvenir avec code-barres',
    '🎨 Thème clair / sombre / système et valeurs par défaut du questionnaire'
  ]},
  { v:'1.1', date:'2026-07-17', titre:'Comparer et retrouver ses voyages', items:[
    '📊 Comparatif des propositions côte à côte',
    '🧳 Galerie « Mes voyages » pour rouvrir un voyage passé',
    '💾 Sauvegarde et import du voyage en fichier'
  ]}
];
const APP_VERSION = CHANGELOG[0].v;
const LS_SEEN_V = 'acolite_seen_version';
/* date longue « 20 juillet 2026 » (distincte de frDate, utilisée pour les vols) */
const newsDate = iso => { const d = new Date(iso + 'T12:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString(LOC(), { day:'numeric', month:'long', year:'numeric' }); };

/* Chaque nouveauté commence par un emoji. On le détache pour qu'il serve
   de puce : sinon on lit « • 🎯 Les 3 étapes… », deux puces pour une. */
/* Construite via new RegExp et non en littéral : \p{...} est de l'ES2018,
   et un littéral non supporté serait une SyntaxError qui empêcherait TOUT
   app.js de s'exécuter. Ici, au pire, on retombe sur la puce ronde. */
let NEWS_EMO = null;
try { NEWS_EMO = new RegExp('^(\\p{Extended_Pictographic}\\uFE0F?)\\s*', 'u'); } catch(e){}
function newsItemHTML(txt){
  const m = NEWS_EMO ? txt.match(NEWS_EMO) : null;
  const emo = m ? m[1] : '•';
  const rest = m ? txt.slice(m[0].length) : txt;
  return `<li><span class="ni-emo" aria-hidden="true">${esc(emo)}</span><span>${esc(rest)}</span></li>`;
}
function newsHTML(list){
  return list.map((e, i) => `<article class="news-entry${i === 0 ? ' latest' : ''}">
    <div class="news-head">
      <span class="news-v">v${esc(e.v)}</span>
      <span class="news-date">${esc(newsDate(e.date))}</span>
      ${i === 0 ? '<span class="news-new">nouveau</span>' : ''}
    </div>
    <h4>${esc(e.titre)}</h4>
    <ul class="news-items">${e.items.map(newsItemHTML).join('')}</ul>
  </article>`).join('');
}
function openNews(all){
  const seen = localStorage.getItem(LS_SEEN_V);
  /* à l'ouverture auto : seulement les versions non vues ; sinon tout l'historique */
  const list = all ? CHANGELOG : CHANGELOG.slice(0, Math.max(1, CHANGELOG.findIndex(e => e.v === seen)));
  const body = $('#newsBody');
  const intro = all
    ? `<p class="news-intro">Tout ce qui a changé depuis le début, du plus récent au plus ancien.</p>`
    : `<div class="news-hello">${mascotSVG()}<p>Acolyte a été mis à jour pendant ton absence — voici ce qui change.</p></div>`;
  if(body) body.innerHTML = intro + `<div class="news-rail">${newsHTML(list)}</div>`;
  $('#ovNews')?.classList.add('show');
}
function closeNews(){
  lsSet(LS_SEEN_V, APP_VERSION);
  $('#ovNews')?.classList.remove('show');
}
/* à l'ouverture : si la version a changé depuis la dernière visite → on annonce */
function checkNews(){
  const seen = localStorage.getItem(LS_SEEN_V);
  if(seen === APP_VERSION) return;
  if(!seen){ lsSet(LS_SEEN_V, APP_VERSION); return; }   /* 1ʳᵉ visite : l'onboarding suffit */
  openNews(false);
}
{
  const ok = $('#newsOk'); if(ok) ok.onclick = closeNews;
  const pf = $('#pfNews'); if(pf) pf.onclick = () => openNews(true);
  const v = $('#pfVersion'); if(v) v.textContent = `· version ${APP_VERSION}`;
}

/* ============================================================
   POLITIQUE DE CONFIDENTIALITÉ
   Acceptée au moins une fois à l'inscription. Si le texte change, on
   incrémente PRIVACY_VERSION : tous les utilisateurs devront ré-accepter
   à leur prochaine ouverture (comparaison avec la version mémorisée).
   ⚠️ Texte fourni de bonne foi, sans valeur d'avis juridique — à faire
   relire par un professionnel avant une mise en production sérieuse.
============================================================ */
/* Changement de fond : mentions légales, transferts hors UE, bases légales
   distinctes, droit de réclamation CNIL. Les utilisateurs doivent donc
   ré-accepter — c'est précisément à quoi sert cette date. */
const PRIVACY_VERSION = '2026-07-31';
const LS_PRIVACY = 'acolite_privacy';
const privacyAccepted = () => { try{ return localStorage.getItem(LS_PRIVACY) === PRIVACY_VERSION; }catch(e){ return false; } };
function privacyHTML(){
  return `
  <p class="sub" style="margin:0 0 14px">En vigueur au ${esc(PRIVACY_VERSION)}. Acolyte protège tes données : pas de publicité ciblée et <strong>sans revente d'aucune donnée</strong>. Pour toute question : <a href="${reportMailLink('confidentialité')}">${esc(SUPPORT_MAIL)}</a>.</p>
  <div class="legal">
    <h4>0. Mentions légales</h4>
    <p><strong>Éditeur du site.</strong> Acolyte est édité à titre personnel, par un particulier, sans activité commerciale. Conformément à l'article 6-III-2 de la loi du 21 juin 2004 pour la confiance dans l'économie numérique, un éditeur non professionnel peut ne pas rendre publiques son identité et son adresse, à condition d'avoir communiqué ces éléments à son hébergeur — ce qui est le cas. Contact : <a href="${reportMailLink('mentions légales')}">${esc(SUPPORT_MAIL)}</a>.</p>
    <p><strong>Hébergeur du site.</strong> GitHub, Inc. — 88 Colin P. Kelly Jr. Street, San Francisco, CA 94107, États-Unis (service GitHub Pages). <a href="https://github.com" target="_blank" rel="noopener noreferrer">github.com</a></p>
    <p><strong>Hébergeur du serveur applicatif.</strong> Val Town, Inc. — États-Unis. C'est lui qui héberge les comptes, la synchronisation et le journal d'articles.</p>
    <p><strong>Propriété intellectuelle.</strong> Le nom Acolyte, son logo et son interface sont la propriété de l'éditeur. Les fonds de carte proviennent d'OpenStreetMap (licence ODbL), les photographies de Wikimédia Commons — leurs auteurs et licences respectives s'appliquent, et sont indiqués sous chaque image.</p>

    <h4>1. Responsable du traitement</h4>
    <p>Acolyte est une application de préparation de voyage, éditée à titre personnel et proposée « en l'état ». Le responsable du traitement au sens du RGPD est l'éditeur, joignable à <a href="${reportMailLink('confidentialité')}">${esc(SUPPORT_MAIL)}</a>. Au vu de la taille du service, aucun délégué à la protection des données n'est désigné : c'est l'éditeur qui répond directement.</p>

    <h4>2. Les données que nous traitons</h4>
    <p>• <strong>Compte</strong> : ton adresse email et une empreinte chiffrée de ton mot de passe (le mot de passe lui-même n'est jamais stocké ni lisible, y compris par nous).<br>
    • <strong>Contenu de voyage</strong> : ce que tu saisis (destinations, dates, notes, dépenses, préférences) et ce qu'Acolyte génère pour toi. Enregistré dans ton navigateur, et — si tu as un compte — copié sur notre serveur pour te suivre d'un appareil à l'autre.<br>
    • <strong>Aucune</strong> localisation précise, aucun accès à tes contacts, aucun traceur ni cookie publicitaire.</p>

    <h4>3. Finalités & base légale</h4>
    <p>Chaque usage a sa propre base légale — elles ne se valent pas :</p>
    <p>• <strong>Ton compte et tes voyages</strong> → l'<em>exécution du contrat</em> (article 6.1.b du RGPD). Sans ces données, le service ne peut pas exister : c'est ce que tu demandes en créant un compte.<br>
    • <strong>La sécurité</strong> (limitation des sessions, plafonds anti-abus) → l'<em>intérêt légitime</em> (article 6.1.f) à protéger le service et ses utilisateurs.<br>
    • <strong>Les offres de voyage par email</strong> → ton <em>consentement</em> (article 6.1.a), et uniquement lui. Personne n'y est inscrit d'office : c'est un accord à donner, jamais une case à décocher. Tu peux le retirer d'un clic par le lien présent dans chaque message, sans avoir à te connecter.</p>
    <p><strong>Stockage dans ton navigateur.</strong> Acolyte garde tes voyages et tes préférences dans le stockage local de ton appareil. Cet usage est <em>strictement nécessaire</em> au service que tu demandes : il ne relève donc pas du consentement préalable, et c'est pourquoi tu ne vois aucune bannière. Il n'y a <strong>aucun cookie publicitaire, aucun traceur, aucune mesure d'audience</strong> — rien qui suive ta navigation.</p>
    <p><strong>Décisions automatisées.</strong> Les propositions de voyage sont produites par un traitement automatisé, mais elles ne produisent aucun effet juridique : elles te suggèrent des choix, tu décides seul, et rien n'est réservé ni engagé sans toi.</p>

    <h4>4. Prestataires techniques (transparence complète)</h4>
    <p>Pour fonctionner, Acolyte transmet le strict nécessaire à des prestataires, sans jamais leur transmettre ton mot de passe :</p>
    <p>• <strong>Intelligence artificielle</strong> — la préparation de ton voyage s'appuie sur les modèles <strong>Google Gemini</strong> (raisonnement) et <strong>Groq</strong> (tâches rapides). Ce que tu écris pour décrire ton voyage leur est envoyé afin de générer des propositions. Nos clés d'accès sont gardées secrètes sur notre serveur ; elles ne transitent jamais par ton navigateur.<br>
    • <strong>Envoi d'emails</strong> — les codes de vérification sont expédiés via <strong>EmailJS</strong>.<br>
    • <strong>Données ouvertes</strong> — météo et géocodage (Open-Meteo), horaires et prix de transport (Deutsche Bahn, Ryanair), jours fériés (Nager.Date), taux de change (Frankfurter), lieux et cartes (OpenStreetMap, Wikipédia, Wikivoyage).<br>
    Chacun de ces prestataires applique sa propre politique de confidentialité.</p>

    <h4>4 bis. Transferts en dehors de l'Union européenne</h4>
    <p>Il faut le dire clairement : <strong>tes données sortent de l'Union européenne</strong>. Les prestataires ci-dessus sont établis aux États-Unis — l'hébergement du site (GitHub Pages), celui du serveur et de la base (Val Town), les modèles d'intelligence artificielle (Google, Groq) et l'envoi des emails (EmailJS).</p>
    <p>Concrètement, ce qui traverse l'Atlantique : ton adresse email, l'empreinte de ton mot de passe, le contenu de tes voyages, et le texte que tu écris pour décrire ton envie de voyage. Jamais ton mot de passe en clair — il n'existe nulle part.</p>
    <p>Ces transferts s'appuient sur les mécanismes prévus aux articles 44 à 49 du RGPD : le <em>cadre de protection des données UE–États-Unis</em> pour les prestataires qui y ont adhéré, et à défaut les <em>clauses contractuelles types</em> de la Commission européenne, telles qu'elles figurent dans les conditions de chacun. Si ce point te dérange, la conséquence est simple et légitime : n'ouvre pas de compte, et n'utilise pas la génération de voyage. Le reste de l'application fonctionne dans ton seul navigateur.</p>

    <h4>5. Hébergement & durée de conservation</h4>
    <p>Tes données de compte sont conservées tant que ton compte existe. Les données restées dans ton navigateur y demeurent jusqu'à ce que tu les effaces. Aucune donnée n'est conservée à d'autres fins que le service.</p>
    <p>Ce qui n'a plus d'utilité est effacé automatiquement : les sessions expirées, les codes de vérification périmés, et les sessions au-delà des 5 appareils les plus récents. Une session dure 30 jours au maximum. Quand tu supprimes ton compte, chaque table qui porte ton adresse est vidée — il ne reste rien.</p>

    <h4>6. Sécurité</h4>
    <p>Les mots de passe sont protégés par une empreinte cryptographique renforcée. Les échanges avec nos serveurs sont chiffrés (HTTPS). Aucun système n'étant infaillible, nous ne pouvons garantir une sécurité absolue, mais nous mettons en œuvre des mesures raisonnables.</p>

    <h4>7. Tes droits</h4>
    <p>La plupart de tes droits s'exercent <strong>sans rien demander à personne</strong>, directement dans l'application — c'est plus rapide qu'un courrier :</p>
    <p>• <strong>Accès et rectification</strong> → ton profil et tes voyages sont modifiables à tout moment.<br>
    • <strong>Portabilité</strong> → le bouton d'<strong>export</strong> de ton profil te rend tes voyages dans un fichier lisible et réutilisable ailleurs.<br>
    • <strong>Effacement</strong> → la <strong>suppression de ton compte</strong> (depuis ton profil) efface définitivement tout ce qui y est associé, côté serveur comme dans ce navigateur.<br>
    • <strong>Retrait du consentement</strong> aux offres de voyage → le lien de désinscription au bas de chaque message, sans connexion.<br>
    • <strong>Opposition et limitation</strong> → écris à <a href="${reportMailLink('mes données')}">${esc(SUPPORT_MAIL)}</a>. Réponse sous un mois au plus, comme le prévoit le RGPD.</p>
    <p><strong>Réclamation.</strong> Si une réponse ne te satisfait pas, tu peux saisir l'autorité de contrôle française : la <strong>CNIL</strong>, 3 place de Fontenoy — TSA 80715 — 75334 Paris Cedex 07, <a href="https://www.cnil.fr/fr/plaintes" target="_blank" rel="noopener noreferrer">cnil.fr/fr/plaintes</a>. C'est un droit, et il n'a pas à passer par nous.</p>

    <h4>8. Mineurs</h4>
    <p>Acolyte n'est pas destiné aux personnes de moins de 15 ans sans l'accord d'un représentant légal.</p>

    <h4>9. Limites & responsabilité</h4>
    <p>Les destinations, itinéraires, prix, horaires et conseils sont <strong>générés automatiquement</strong> et peuvent comporter des <strong>erreurs, approximations ou informations périmées</strong>. Ils sont fournis à titre purement indicatif : <strong>vérifie toujours</strong> les informations essentielles (documents de voyage, horaires, disponibilités, tarifs, conditions sanitaires et de sécurité) auprès des transporteurs, hébergeurs et autorités officielles avant de réserver ou de partir. Dans les limites permises par la loi, Acolyte et son éditeur ne sauraient être tenus responsables d'un dommage, d'une perte, d'une dépense ou d'un préjudice, direct ou indirect, résultant de l'usage du service, d'une information erronée, d'une décision prise sur cette base, ou d'une interruption du service. Tu utilises Acolyte sous ta seule responsabilité.</p>

    <h4>10. Évolutions</h4>
    <p>Cette politique peut évoluer. En cas de changement important, ton acceptation te sera redemandée à l'ouverture de l'application.</p>
  </div>`;
}
let _privacyGate = false;   /* true = acceptation obligatoire (bloque la fermeture) */
function openPrivacy(gate){
  _privacyGate = !!gate;
  const b = $('#privacyBody'); if(b) b.innerHTML = privacyHTML();
  $('#privacyClose')?.classList.toggle('hidden', _privacyGate);   /* pas de croix si obligatoire */
  $('#privacyAccept')?.classList.toggle('hidden', !_privacyGate); /* bouton accepter seulement en mode obligatoire */
  $('#ovPrivacy')?.classList.add('show');
}
function acceptPrivacy(){
  lsSet(LS_PRIVACY, PRIVACY_VERSION);
  $('#ovPrivacy')?.classList.remove('show');
  const cb = $('#auPrivacy'); if(cb) cb.checked = true;
  /* si on était sur la barrière obligatoire (utilisateur déjà connecté),
     on reprend l'entrée dans l'app maintenant que c'est accepté */
  if(_privacyGate){ _privacyGate = false; enterApp(); }
}
{
  const op = $('#openPrivacy'); if(op) op.onclick = () => openPrivacy(false);
  const pa = $('#privacyAccept'); if(pa) pa.onclick = acceptPrivacy;
  const pf = $('#pfPrivacy'); if(pf) pf.onclick = () => openPrivacy(false);
}
/* Barrière : un utilisateur connecté qui n'a pas accepté la version en cours
   doit le faire avant d'utiliser l'app. Appelée à l'entrée. */
function requirePrivacy(){
  if(privacyAccepted()) return true;
  openPrivacy(true);
  return false;
}

/* --- Onboarding première visite (3 slides, mémorisé) --- */
const ONB_KEY = 'acolite_onboarded';
/* ============================================================
   LA VISITE GUIDÉE DES NOUVEAUX COMPTES
   ------------------------------------------------------------
   Il n'y avait que trois écrans, et ils décrivaient une PROMESSE : « des
   destinations sur mesure », « des propositions différentes ». C'est du
   discours, pas du mode d'emploi. Quelqu'un qui arrive ne savait toujours pas
   qu'il y a quatre onglets, que la carte marche sans réseau, ni où retrouver
   son ticket.

   Ces écrans-ci expliquent COMMENT ça marche, dans l'ordre où on s'en sert.
   ⚠️ Chacun nomme un endroit précis de l'interface (« l'onglet Carte »,
   « ton profil ») : une explication qui ne dit pas OÙ ne sert à rien.
   ⚠️ On peut les revoir depuis le profil — personne ne retient sept écrans du
   premier coup, et les perdre à jamais après un « Passer » serait dommage.
============================================================ */
const ONB_STEPS = [
  { emoji:'🌍', title:'1. Dis ce dont tu as envie',
    text:'Une phrase suffit : « une semaine au chaud, moins de 800 €, pas d’auberge ». Remplis le questionnaire de l’onglet Voyage, puis touche « Propose-moi des voyages ». Tu peux tout laisser vide sauf ta ville de départ.' },
  { emoji:'🧭', title:'2. Choisis parmi trois voyages',
    text:'Acolyte propose trois destinations volontairement différentes, comparées ligne par ligne : prix, durée, et CO₂. Touche celle qui te plaît — tu pourras toujours revenir en arrière.' },
  { emoji:'📆', title:'3. Ton programme, jour par jour',
    text:'Chaque journée regroupe des lieux PROCHES les uns des autres. Touche une journée pour la détailler heure par heure, avec les prix d’entrée. Tout est modifiable : déplace un moment, corrige une heure, ajoutes-en un.' },
  { emoji:'🗺️', title:'4. La carte marche sans réseau',
    text:'L’onglet Carte trace ton itinéraire journée par journée. Ouvre-la UNE fois avant de partir : elle se garde en mémoire, et reste consultable dans l’avion, dans le métro et à l’étranger sans données.' },
  { emoji:'🛂', title:'5. Les papiers et les vrais prix',
    text:'Dans ton voyage, l’onglet Papiers réunit le visa, la validité du passeport, la prise électrique du pays, et ce que coûtent vraiment un café ou un ticket de métro sur place. Vérifie toujours sur la fiche officielle avant de réserver.' },
  { emoji:'📍', title:'6. Sur place, le mode Jour J',
    text:'Pendant ton séjour, l’écran d’accueil n’affiche plus que l’essentiel : ta prochaine étape, l’heure, la distance, et ce qu’il te reste à dépenser. Rien d’autre à chercher.' },
  { emoji:'🔒', title:'7. Tes données t’appartiennent',
    text:'Tes voyages vivent dans ton téléphone. Ton compte sert à les retrouver d’un appareil à l’autre. Depuis ton profil tu peux tout exporter, l’ajouter à ton agenda, ou supprimer ton compte — ce qui efface tout, vraiment.' },
  { emoji:'🎮', title:'Et un secret',
    text:'Touche deux fois la mascotte du logo : elle ouvre une salle de jeux. Bon voyage !' }
];
let _onbI = 0;
function renderOnboard(){
  const s = ONB_STEPS[_onbI];
  $('#onboardEmoji').textContent = s.emoji;
  $('#onboardTitle').textContent = s.title;
  $('#onboardText').textContent = s.text;
  $('#onboardDots').innerHTML = ONB_STEPS.map((_, i) => `<i class="${i === _onbI ? 'on' : ''}"></i>`).join('');
  $('#onboardNext').textContent = _onbI === ONB_STEPS.length - 1 ? "C'est parti ! 🚀" : 'Suivant →';
}
function showOnboard(){
  if(localStorage.getItem(ONB_KEY)) return;
  const ov = $('#onboard'); if(!ov) return;
  _onbI = 0; renderOnboard(); ov.hidden = false;
}
function closeOnboard(){ try{ localStorage.setItem(ONB_KEY, '1'); }catch(e){} const ov = $('#onboard'); if(ov) ov.hidden = true; }
/* ============================================================
   DONNER SON VOYAGE À UN AMI
   ------------------------------------------------------------
   « Exporter » produisait un document Markdown : agréable à lire, impossible à
   réouvrir dans l'app. Et la sauvegarde de compte, elle, emporte TOUT — y
   compris ce qui ne regarde personne. Il manquait un format entre les deux :
   le voyage seul, réutilisable.

   ⚠️ CE QUI N'ENTRE PAS DANS LE FICHIER, et c'est le point important : pas
   d'adresse email, pas de dépenses, pas de notes personnelles, pas de
   conversation, pas de photos de carte postale. On partage un itinéraire, pas
   un carnet intime. Chaque champ est recopié EXPLICITEMENT — une copie en bloc
   emporterait un jour une donnée qu'on n'avait pas prévue.

   ⚠️ À l'ouverture, on AFFICHE d'abord et on ne touche à rien. Recevoir un
   voyage ne doit jamais écraser le sien par surprise ; c'est un clic
   supplémentaire, et il est délibéré.
============================================================ */
const AMI_MARQUE = 'acolyte-voyage-ami-1';

function amiPayload(){
  const t = state.trip, p = state.prefs || {}, c = state.cache || {};
  if(!t) return null;
  const pl = c.plan || null;
  /* Les journées heure par heure : on garde l'essentiel de chaque moment,
     prix compris — c'est justement ce que l'ami veut savoir. */
  const jours = {};
  for(const [k, v] of Object.entries(c.days || {})){
    if(!Array.isArray(v?.etapes)) continue;
    jours[k] = { etapes: v.etapes.slice(0, 20).map(e => ({
      heure: _sTxt(e.heure, 10), titre: _sTxt(e.titre, 90),
      description: _sTxt(e.description, 400), lieu: _sTxt(e.lieu, 90),
      type: _sTxt(e.type, 12), prix: _sTxt(e.prix, 24) })) };
  }
  return {
    _acolyte: AMI_MARQUE,
    quand: new Date().toISOString().slice(0, 10),
    trip: { nom:_sTxt(t.nom, 80), pays:_sTxt(t.pays, 80), drapeau:_sTxt(t.drapeau, 8),
            iata:_sTxt(t.iata, 6), resume:_sTxt(t.resume, 600),
            budget_estime:_sTxt(String(t.budget_estime ?? ''), 40) },
    /* Les préférences de VOYAGE seulement : la durée et la période aident à
       refaire le séjour. La ville de départ n'y est pas — c'est la sienne. */
    prefs: { days:_sTxt(p.days, 40), when:_sTxt(p.when, 40),
             adults:_sNum(p.adults, 1, 12), kids:_sNum(p.kids, 0, 10) },
    mode: _sTxt(state.mode, 12),
    plan: pl ? safeJSON(pl) : null,
    days: jours
  };
}

const _eAmiOut = $('#pfAmiOut'); if(_eAmiOut) _eAmiOut.onclick = () => {
  const d = amiPayload();
  if(!d){ toast(isEN() ? 'Plan a trip first 😉' : 'Organise d’abord un voyage 😉'); return; }
  const nom = 'voyage-' + String(d.trip.nom || 'acolyte')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.json';
  const b = new Blob([JSON.stringify(d, null, 1)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = nom; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(isEN() ? '🤝 File ready — send it to your friend'
                : '🤝 Fichier prêt — envoie-le à ton ami');
};

const _eAmiIn = $('#pfAmiIn'); if(_eAmiIn) _eAmiIn.onclick = () => $('#amiFile')?.click();
const _eAmiF = $('#amiFile'); if(_eAmiF) _eAmiF.onchange = (ev) => {
  const f = ev.target.files?.[0];
  ev.target.value = '';                        /* rechoisir le même fichier doit remarcher */
  if(!f) return;
  if(f.size > 3e6){ toast(isEN() ? 'File too large' : 'Fichier trop volumineux'); return; }
  const rd = new FileReader();
  rd.onload = () => {
    let d = null;
    try{ d = JSON.parse(rd.result); }catch(e){}
    if(!d || d._acolyte !== AMI_MARQUE || !d.trip?.nom){
      toast(isEN() ? 'This is not an Acolyte trip file' : 'Ce n’est pas un fichier de voyage Acolyte');
      return;
    }
    amiOuvre(d);
  };
  rd.onerror = () => toast(isEN() ? 'Could not read the file' : 'Lecture du fichier impossible');
  rd.readAsText(f);
};

/* L'aperçu. ⚠️ TOUT est échappé : ce fichier vient de l'extérieur, même s'il
   arrive d'un ami — son téléphone a pu être compromis, ou le fichier modifié
   en route. On ne fait jamais confiance à un contenu qu'on n'a pas produit. */
let _amiRecu = null;
function amiOuvre(d){
  _amiRecu = d;
  const EN = isEN();
  const t = d.trip, pl = d.plan || {};
  const jours = Object.keys(d.days || {}).length;
  const prog = Array.isArray(pl.programme) ? pl.programme : [];
  $('#amiBody').innerHTML = `
    <p class="sub" style="margin:0 0 14px">${EN
      ? 'Here is what your friend did. Nothing has changed in your own trip.'
      : 'Voici ce que ton ami a fait. Rien n’a changé dans ton voyage.'}</p>

    <div class="art-faits">
      <div class="af"><span class="af-k">${EN ? 'Destination' : 'Destination'}</span>
        <span class="af-v">${esc(t.drapeau || '')} ${esc(t.nom)}${t.pays ? ', ' + esc(t.pays) : ''}</span></div>
      ${t.budget_estime ? `<div class="af"><span class="af-k">${EN ? 'Budget' : 'Budget'}</span>
        <span class="af-v">${esc(t.budget_estime)}</span></div>` : ''}
      ${d.prefs?.days ? `<div class="af"><span class="af-k">${EN ? 'Length' : 'Durée'}</span>
        <span class="af-v">${esc(d.prefs.days)}</span></div>` : ''}
      ${d.prefs?.when ? `<div class="af"><span class="af-k">${EN ? 'When' : 'Période'}</span>
        <span class="af-v">${esc(d.prefs.when)}</span></div>` : ''}
      ${pl.logement?.quartier ? `<div class="af"><span class="af-k">${EN ? 'Stayed in' : 'Logé à'}</span>
        <span class="af-v">${esc(pl.logement.quartier)}</span></div>` : ''}
      ${jours ? `<div class="af"><span class="af-k">${EN ? 'Detailed days' : 'Journées détaillées'}</span>
        <span class="af-v">${jours}</span></div>` : ''}
    </div>

    ${prog.length ? `<h3 class="pan-h3" style="margin-top:20px">${EN ? 'Day by day' : 'Jour par jour'}</h3>
      <div class="tableau-ami">${prog.slice(0, 30).map(j =>
        `<div class="l"><b>${EN ? 'D' : 'J'}${esc(String(j.jour))}</b>
           <span>${esc(j.resume || '')}${(j.lieux || []).length
             ? '<br><i>' + esc((j.lieux || []).join(' · ')) + '</i>' : ''}</span></div>`).join('')}</div>` : ''}

    ${pl.conseil_cle ? `<div class="key-tip" style="margin-top:16px"><span class="kt-emo">${ICO('ampoule',18)}</span>
      <p>${esc(pl.conseil_cle)}</p></div>` : ''}

    <div class="art-pied">
      <button class="btn" id="amiPrendre">${ICO('avion',15)} ${EN ? 'Make this trip mine' : 'Reprendre ce voyage'}</button>
      <button class="btn ghost" data-close="ovAmi">${EN ? 'Just looking' : 'Je regardais seulement'}</button>
    </div>
    <p class="hint" style="margin:12px 0 0">${EN
      ? 'Making it yours replaces your current trip. Your account, your other trips and your spending are untouched.'
      : 'Le reprendre remplace ton voyage en cours. Ton compte, tes autres voyages et tes dépenses ne sont pas touchés.'}</p>`;

  const b = $('#amiPrendre');
  if(b) b.onclick = () => amiPrendre();
  $('#ovAmi')?.classList.add('show');
}

function amiPrendre(){
  const d = _amiRecu;
  if(!d) return;
  if(!confirm(isEN()
    ? 'Replace your current trip with this one?'
    : 'Remplacer ton voyage en cours par celui-ci ?')) return;
  /* ⚠️ On recopie CHAMP PAR CHAMP à travers les mêmes filtres que la
     restauration de sauvegarde. Écrire l'objet reçu directement dans state
     rouvrirait exactement la faille corrigée sur restoreTrip(). */
  state.trip = safeJSON(d.trip) || null;
  state.prefs = { ...(state.prefs || {}), ...(safeJSON(d.prefs) || {}) };
  state.mode = _sTxt(d.mode, 12) || state.mode;
  state.cache = state.cache || {};
  state.cache.plan = d.plan ? safeJSON(d.plan) : null;
  state.cache.days = {};
  for(const [k, v] of Object.entries(d.days || {})){
    if(!/^\d{1,3}$/.test(k) || !Array.isArray(v?.etapes)) continue;
    state.cache.days[k] = safeJSON(v);
  }
  /* ⚠️ Les dépenses restent LES SIENNES : elles n'ont rien à voir avec le
     voyage reçu, et les écraser ferait perdre son propre suivi. */
  save();
  $('#ovAmi')?.classList.remove('show');
  switchCat('trip');
  gotoStep(3);
  if(state.cache.plan) renderPlan(state.cache.plan);
  renderGallery();
  toast(isEN() ? '✈️ Trip is yours — adjust anything you like'
                : '✈️ Le voyage est à toi — modifie ce que tu veux');
}

/* Revoir la visite guidée depuis le profil, à la demande. On NE touche pas au
   jalon : la rouvrir ne doit pas la faire réapparaître au prochain démarrage. */
const _eAide = $('#pfAide'); if(_eAide) _eAide.onclick = () => {
  const ov = $('#onboard'); if(!ov) return;
  _onbI = 0; renderOnboard(); ov.hidden = false;
};
{
  const nx = $('#onboardNext'); if(nx) nx.onclick = () => { if(_onbI < ONB_STEPS.length - 1){ _onbI++; renderOnboard(); } else closeOnboard(); };
  const sk = $('#onboardSkip'); if(sk) sk.onclick = closeOnboard;
}
/* ============================================================
   L'ENTRÉE N'EST PLUS UN MUR
   ------------------------------------------------------------
   L'écran de connexion s'ouvrait AVANT tout : on ne voyait rien d'Acolyte tant
   qu'on n'avait pas créé un compte. Pour quelqu'un qui découvre le site, c'est
   un péage devant une vitrine fermée.
   Il s'ouvre désormais directement. La connexion reste nécessaire, mais elle
   est demandée AU MOMENT où elle sert — pas une seconde avant.

   ⚠️ POURQUOI ON NE PEUT PAS LA SUPPRIMER TOUT À FAIT, et c'est vérifié dans le
   backend, pas supposé : `aiGuard()` répond 401 « Connecte-toi pour utiliser
   Acolyte » sur /gemini, /groq, /hotels et le relais. Le compte n'est pas une
   formalité d'interface, c'est ce qui porte le compteur de quota (AI_MAX_H par
   heure et par compte). Un profil local fabriqué côté navigateur ne franchit
   pas cette porte : l'app s'ouvrirait, et RIEN ne se générerait — on aurait
   déplacé le mur au lieu de l'enlever.
   Ce qui change vraiment : on peut tout PARCOURIR sans compte (le journal, la
   carte, un voyage importé, ses réglages), et le compte n'est demandé qu'à la
   première action qui appelle l'IA.
============================================================ */
/* ⚠️ NE RENVOIE RIEN — c'est un AIGUILLAGE, pas un test. Pour savoir si
   quelqu'un est connecté, utilise estConnecte(). */
function requireAuth(){
  const u = getUser();
  /* la présence d'un jeton fait foi : c'est le serveur qui tranchera à la
     première synchronisation si la session est encore valable */
  if(estConnecte()){
    enterApp();
    pullSync();
    return;
  }
  /* Pas de session : on ouvre quand même. `_visiteLibre` dit au reste de l'app
     qu'on navigue sans compte — c'est lui que lisent les points d'entrée IA. */
  if(!_authForcee){
    _visiteLibre = true;
    enterApp();
    return;
  }
  $('#authWrap').classList.remove('hidden');
  if(!u) authShow('authSignup');
  else if(u.email && !authToken()) authShow('authLogin');
  else authShow('authSignup');
}

/* ============================================================
   CATÉGORIES — 🗺️ Carte · 🤖 Voyage · 👤 Profil
============================================================ */
function switchCat(cat){
  /* (Le renvoi « Assistant → Voyage sur petit écran » a été retiré : l'onglet
     existe désormais sur téléphone aussi, il n'y a plus rien à refuser.) */
  $$('.catnav button').forEach(b => b.classList.toggle('on', b.dataset.cat === cat));
  $('#catTrip').classList.toggle('hidden', cat !== 'trip');
  $('#catMap').classList.toggle('hidden', cat !== 'map');
  $('#catProfile').classList.toggle('hidden', cat !== 'profile');
  $('#catBlog')?.classList.toggle('hidden', cat !== 'blog');
  $('#catIA')?.classList.toggle('hidden', cat !== 'ia');
  window.scrollTo({top:0});
  /* Un compteur par ecran : c'est ce qui dit si le blog ou la carte servent
     vraiment, ou si personne n'y va jamais. */
  statCompte({ map:'carte_ouverte', blog:'blog_ouvert', trip:'voyage_ouvert', ia:'assistant_ouvert' }[cat], true);
  if(cat === 'map') buildProjectMap();
  if(cat === 'profile'){ renderProfile(); renderSettings(); }
  if(cat === 'blog') openBlog();
  /* Le fil peut avoir changé depuis le dernier passage (autre appareil, via la
     synchro) : on le relit à l'ouverture plutôt que de garder l'affichage
     construit au chargement de la page. */
  if(cat === 'ia' && typeof iaRender === 'function'){
    iaRender();
    if(typeof iaHauteur === 'function') iaHauteur();
    /* L'avertissement de bêta arrive ICI, à la première ouverture de l'onglet —
       pas au chargement de l'app. Quelqu'un qui ne vient jamais sur l'assistant
       n'a aucune raison de voir une pop-up à son sujet. */
    if(typeof iaBetaSiPremiereFois === 'function') iaBetaSiPremiereFois();
  }
  /* états vides : pas de voyage → invitations plutôt qu'écrans vides */
  const noTrip = !state.trip;
  $('#catMap')?.classList.toggle('empty', noTrip);
  const me = $('#mapEmpty'); if(me) me.hidden = !noTrip;
  const pe = $('#profileEmpty'); if(pe) pe.hidden = !noTrip;
  _cat = cat;
  renderRail();
  /* Sur ordinateur, l'onglet Profil est masqué : c'est le rond au nom de
     l'utilisateur qui y mène, donc c'est lui qui doit porter l'état actif.
     aria-current plutôt qu'une classe : l'information est la même pour l'œil et
     pour le lecteur d'écran, et le CSS s'y accroche directement. */
  /* ⚠️ PAS `me` : cette fonction déclare déjà un `me` plus haut (#mapEmpty), et
     deux `const` du même nom dans le même bloc tuent tout le fichier. */
  const btnMe = $('#ntMe');
  if(btnMe){ if(cat === 'profile') btnMe.setAttribute('aria-current', 'page'); else btnMe.removeAttribute('aria-current'); }
  /* Le pseudo de la barre du haut peut avoir changé depuis le dernier passage
     (connexion, déconnexion, pseudo modifié) : on le relit ici plutôt que
     d'appeler majNavTools() depuis chacun de ces trois endroits, dont un
     finirait par être oublié. */
  majNavTools();
}

/* ============================================================
   COLONNE DE GAUCHE — son contenu suit la catégorie
   ------------------------------------------------------------
   Afficher « Questions · Les choix · Ton voyage » pendant qu'on regarde la
   carte n'a aucun sens : ces étapes ne mènent nulle part depuis là. La
   colonne montre donc ce qui est utile ICI :
   · Voyage  → les 3 étapes du parcours
   · Carte   → les journées du voyage, pour sauter de l'une à l'autre
   · Profil  → les deux sections de la page, pour y aller directement
============================================================ */
let _cat = 'trip';
function renderRail(){
  const box = $('#railSteps');
  if(!box) return;
  const T = isEN()
    ? { etapes:'Steps', jours:'Days of the trip', sections:'My account',
        q:['Questions','Tell us all about your trip'], c:['The options','Our suggestions for you'],
        v:['Your trip','Your tailor-made route'],
        aller:['Getting there','Departure → arrival'], vide:'No trip yet',
        act:['Actions','Export, install, sign out'], pref:['Preferences','Style, pace, appearance'] }
    : { etapes:'Étapes', jours:'Journées du voyage', sections:'Mon compte',
        q:['Questions','Dis-nous tout sur ton voyage'], c:['Les choix','Nos suggestions pour toi'],
        v:['Ton voyage','Ton itinéraire personnalisé'],
        aller:['Aller','Départ → arrivée'], vide:'Pas encore de voyage',
        act:['Actions','Export, installation, déconnexion'], pref:['Préférences','Style, rythme, apparence'] };

  const ligne = (cle, num, titre, sous, actif, bloque) =>
    `<li data-rail="${esc(cle)}"${actif ? ' class="on"' : (bloque ? ' class="off"' : '')}
        aria-current="${actif ? 'step' : 'false'}">
      <span class="rs-n">${esc(num)}</span>
      <span class="rs-t"><b>${esc(titre)}</b><em>${esc(sous)}</em></span>
    </li>`;

  let titre = T.etapes, html = '';

  if(_cat === 'map'){
    titre = T.jours;
    const routes = window._projRoutes || [];
    if(!routes.length){
      html = `<li class="off"><span class="rs-n">—</span><span class="rs-t"><b>${esc(T.vide)}</b></span></li>`;
    }else{
      html = routes.map((r, i) => {
        /* le libellé du trajet fait déjà « J1 », « ✈️ Aller » : on le reprend
           tel quel, et le résumé de la journée sert de sous-titre */
        const est0 = i === 0 && !/^\s*[JD]\d/.test(r.label);
        const num = est0 ? '✈' : String(i).padStart(2, '0');
        const nom = est0 ? T.aller[0] : r.label;
        const sous = (r.note || (est0 ? T.aller[1] : '')).slice(0, 60);
        return ligne('day:' + i, num, nom, sous, i === _mapIdx, false);
      }).join('');
    }
  }else if(_cat === 'profile'){
    titre = T.sections;
    html = ligne('sec:actions', '01', T.act[0], T.act[1], false, false)
         + ligne('sec:prefs',   '02', T.pref[0], T.pref[1], false, false);
  }else if(_cat === 'blog'){
    /* La colonne du journal : les catégories, avec le nombre d'articles de
       chacune. Elle était vide auparavant — mais un journal se PARCOURT, et
       sans repère on ne sait pas ce qu'il contient.
       ⚠️ Les compteurs sont calculés depuis la liste réellement chargée, jamais
       écrits en dur : une catégorie affichée « 9 » alors qu'elle en contient 2
       est pire que pas de compteur. */
    titre = isEN() ? 'The journal' : 'Le journal';
    const arts = _blogListe || [];
    const cats = [['', isEN() ? 'All articles' : 'Tous les articles']]
      .concat(Object.keys(BLOG_CATS_FR).map(k => [k, blogCatNom(k)]));
    html = cats.map(([k, nom]) => {
      const n = k ? arts.filter(a => a.categorie === k).length : arts.length;
      const actif = (_blogCat || '') === k;
      /* Une catégorie vide n'est pas cliquable : proposer un filtre qui ne
         renvoie rien est une promesse non tenue. */
      const vide = !n && k;
      return `<li data-rail="bcat:${esc(k)}"${actif ? ' class="on"' : (vide ? ' class="off"' : '')}
          aria-current="${actif ? 'true' : 'false'}">
        <span class="rs-t"><b>${esc(nom)}</b></span>
        <span class="rs-n rs-cnt">${n}</span>
      </li>`;
    }).join('');
  }else if(_cat === 'ia'){
    /* ---- La colonne de l'assistant : L'HISTORIQUE DE LA CONVERSATION ----
       Elle listait « ce qu'Acolyte sait faire » : trois lignes fixes, vraies au
       premier passage et inutiles ensuite. Or dans une conversation longue,
       c'est retrouver SA question d'il y a dix messages qui coûte — un fil se
       parcourt mal en remontant à l'aveugle.
       On ne liste donc QUE les demandes du voyageur : ce sont ses repères à
       lui, et les réponses d'Acolyte n'en sont pas (il ne s'en souvient pas
       comme d'un point de repère). Un clic ramène au message. */
    titre = isEN() ? 'Your questions' : 'Tes demandes';
    const L = Array.isArray(state.chatLog) ? state.chatLog : [];
    /* On garde l'index RÉEL dans le fil : c'est lui qui sert d'ancre, et il ne
       doit pas se décaler quand on ne retient qu'un message sur deux. */
    const miennes = L.map((m, i) => ({ m, i })).filter(x => x.m && x.m.qui === 'moi');
    if(!miennes.length){
      html = `<li class="off"><span class="rs-n">—</span><span class="rs-t"><b>${
        esc(isEN() ? 'No question yet' : 'Aucune demande')}</b><em>${
        esc(isEN() ? 'Your questions will be listed here' : 'Tes demandes s’afficheront ici')}</em></span></li>`;
    }else{
      /* Les plus RÉCENTES en premier : dans une conversation, c'est ce qu'on
         vient de dire qu'on relit, pas le début. Plafonné à 20 — au-delà la
         colonne devient elle-même une chose à parcourir. */
      html = miennes.slice(-20).reverse().map(({ m, i }) => {
        const t = String(m.t || '').replace(/\s+/g, ' ').trim();
        const court = t.length > 46 ? t.slice(0, 45) + '…' : t;
        const h = new Date(m.ts || Date.now()).toLocaleTimeString(LOC(), { hour:'2-digit', minute:'2-digit' });
        return `<li data-rail="iah:${i}" title="${esc(t.slice(0, 200))}">
          <span class="rs-n rs-h">${esc(h)}</span>
          <span class="rs-t"><b>${esc(court)}</b></span>
        </li>`;
      }).join('');
    }
  }else{
    const n = state.step || 1;
    const bloque2 = !(state.destinations || []).length, bloque3 = !state.trip;
    html = ligne('step:1', '01', T.q[0], T.q[1], n === 1, false)
         + ligne('step:2', '02', T.c[0], T.c[1], n === 2, bloque2)
         + ligne('step:3', '03', T.v[0], T.v[1], n === 3, bloque3);
  }
  box.innerHTML = html;
  /* Le CSS a besoin de savoir QUELLE forme la colonne prend : le fil vertical
     qui relie les étapes n'a pas de sens pour les catégories du journal, dont
     les lignes n'ont pas de point en tête — il traverserait le texte. */
  box.dataset.rail = _cat;
  /* Sans entrée à afficher, le titre seul flotterait au-dessus du vide : on
     escamote le bloc entier plutôt que de laisser une étiquette orpheline. */
  box.hidden = !html;
  /* Tout de suite, sans attendre l'observateur : celui-ci ne passe qu'à la
     micro-tâche suivante, et la navigation aux flèches redonne le focus à la
     ligne active DANS le même tour — sans tabindex, le focus serait perdu. */
  a11yEnhanceChips(box);
  const h = $('#railTitle');
  if(h){ h.textContent = titre; h.hidden = !titre; }
}
/* Un seul écouteur pour les trois formes de la colonne. Il ne DÉCIDE de rien :
   il délègue à gotoStep / showRoute, qui gardent leurs garde-fous. */
document.addEventListener('click', e => {
  const li = e.target.closest('#railSteps li[data-rail]');
  if(!li || li.classList.contains('off')) return;
  const [genre, val] = li.dataset.rail.split(':');
  if(genre === 'step') gotoStep(+val);
  /* Historique de l'assistant : on ramène au message, et on le SIGNALE.
     Faire défiler sans rien marquer laisse chercher lequel des messages
     visibles était celui qu'on venait de demander. */
  else if(genre === 'iah'){
    const cible = document.querySelector('#iaFil .ia-msg[data-i="' + Number(val) + '"]');
    if(cible){
      cible.scrollIntoView({ block:'center', behavior: motionOff() ? 'auto' : 'smooth' });
      cible.classList.add('vise');
      setTimeout(() => cible.classList.remove('vise'), 1600);
    }
  }
  else if(genre === 'day'){
    /* renderRail() remplace les <li> : si l'activation venait du clavier, le
       focus tomberait dans le vide. On le repose sur la nouvelle ligne active,
       sinon la tabulation repartirait du début de la page. */
    const auClavier = document.activeElement === li;
    showRoute(+val); renderRail();
    if(auClavier) $('#railSteps li.on')?.focus();
  }
  else if(genre === 'bcat'){
    /* Filtrer par catégorie. On revient à la LISTE si on lisait un article :
       cliquer une catégorie pendant la lecture doit montrer la catégorie, pas
       laisser l'article à l'écran avec une colonne qui a changé. */
    _blogCat = val || '';
    renderRail();
    renderBlogListe(_blogListe || []);
    $('#blogOne')?.classList.add('hidden');
    $('#blogList')?.classList.remove('hidden');
    $('#blogBack')?.classList.add('hidden');
    seoAccueil();
  }
  else if(genre === 'sec'){
    /* #accPrefs et #accActions étaient les anciens accordéons du profil,
       remplacés par les onglets. On vise directement ce qui existe. */
    const cible = val === 'prefs' ? $('#stStyle') : $('#pfExport');
    /* si la section est dans un accordéon replié, on l'ouvre avant de viser */
    const acc = cible?.closest('.acc');
    if(acc && !acc.classList.contains('open')) acc.classList.add('open');
    cible?.scrollIntoView({ behavior:'smooth', block:'center' });
  }
});
$$('.catnav button').forEach(b => b.onclick = () => switchCat(b.dataset.cat));
document.addEventListener('click', e => {
  if(e.target.id === 'mapEmptyGo' || e.target.id === 'profileEmptyGo'){ switchCat('trip'); gotoStep(1); }
});

/* ============================================================
   ACCESSIBILITÉ — les faux boutons activables au clavier partout

   Trois familles d'éléments cliquables sont des <div>/<li> : les puces du
   questionnaire (.chip), les vignettes de la carte postale (.pc-chip) et les
   entrées de la colonne de gauche. Aucune n'est atteignable au clavier sans
   ça — et depuis que les pastilles de journée sont masquées sur ordinateur,
   la colonne est le SEUL moyen de changer de journée dans la vue Carte.

   Un seul sélecteur, un seul observateur : tout nouvel élément est équipé
   automatiquement, sans que la fonction qui le fabrique ait à y penser.
   ⚠️ Les entrées « .off » sont verrouillées : elles ne doivent PAS recevoir
   le focus, sinon la tabulation s'arrête sur un élément qui ne fait rien.
============================================================ */
/* ⚠️ Une FONCTION, pas une const : renderRail() appelle a11yEnhanceChips() et
   se trouve plus haut dans le fichier. Une const serait dans sa zone morte si
   un appel partait pendant le démarrage. */
function a11ySel(pose){
  const l = ['.chip', '.pc-chip', '#railSteps li[data-rail]:not(.off)'];
  return l.map(s => s + (pose ? '[role="button"]' : ':not([data-a11y])')).join(', ');
}
function a11yEnhanceChips(root){
  (root || document).querySelectorAll(a11ySel()).forEach(c => {
    c.setAttribute('tabindex', '0');
    c.setAttribute('role', 'button');
    c.setAttribute('data-a11y', '1');
  });
}
new MutationObserver(muts => {
  for(const m of muts) for(const n of m.addedNodes){
    if(n.nodeType !== 1) continue;
    if(n.matches?.(a11ySel())){ n.setAttribute('tabindex','0'); n.setAttribute('role','button'); n.setAttribute('data-a11y','1'); }
    if(n.querySelector?.(a11ySel())) a11yEnhanceChips(n);
  }
}).observe(document.body, { childList:true, subtree:true });
document.addEventListener('keydown', e => {
  const c = e.target.closest?.(a11ySel(true));
  if(c && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); c.click(); }
});
a11yEnhanceChips(document);

/* ============================================================
   PRÉFÉRENCES — pilotent l'IA ET l'interface
============================================================ */
const LS_SET = 'acolite_settings';
const SET_DEF = {
  style: [],            /* détente, culture, aventure… (multi) */
  rythme: 'equilibre',
  food: 'aucun',
  acces: 'non',
  eviter: [],           /* modes de transport à éviter */
  model: 'auto',
  detail: 'normal',
  verif: true,          /* relecture croisée par une 2e IA */
  reels: true,          /* données réelles (météo, trains, fériés…) */
  font: 100,
  motion: true,         /* animations */
  theme: 'auto',        /* auto (système) | light | dark */
  homeCity: '',         /* ville de départ pré-remplie à chaque nouveau voyage */
  defAdults: 2,         /* voyageurs par défaut */
  defKids: 0,
  /* Comment on se déplace SUR PLACE, une fois arrivé. À ne pas confondre avec
     le transport POUR y aller (state.mode : avion, train, voiture) : ce sont
     deux décisions différentes, et l'une n'implique pas l'autre — on prend
     l'avion pour Rome et on y marche. */
  surPlace: 'pied'      /* pied | velo | transports | voiture */
};
/* ⚠️ Les vitesses sont MOYENNES ET URBAINES, portes à portes : elles incluent
   les arrêts, les feux, le stationnement. Une voiture en ville ne fait pas du
   50 — c'est pour ça qu'elle est à 22, à peine mieux que le vélo.
   Le détour : les rues ne sont pas droites. À pied on coupe (1,35), en voiture
   on suit les sens uniques (1,5). */
const SUR_PLACE = {
  /* ⚠️ `ico` porte désormais une CLÉ du jeu d'icônes, plus un émoji. Je l'avais
     vidé en retirant les émojis — mais trois endroits l'affichent encore, et
     ils sortaient donc « ≈ 12 min · 1,2 km » avec une espace en tête et aucun
     pictogramme. Une clé vaut mieux qu'une chaîne vide : elle se rend en SVG
     là où c'est possible, et s'ignore proprement là où le texte est échappé. */
  pied:       { ico:'pied',     nom:'À pied',                en:'On foot',          kmh:4.8, detour:1.35 },
  velo:       { ico:'velo',     nom:'À vélo',                en:'By bike',          kmh:14,  detour:1.30 },
  transports: { ico:'metro',    nom:'Transports en commun',  en:'Public transport', kmh:18,  detour:1.25 },
  voiture:    { ico:'voiture',  nom:'En voiture',            en:'By car',           kmh:22,  detour:1.50 }
};
const surPlaceActuel = () => SUR_PLACE[SET?.surPlace] || SUR_PLACE.pied;
let SET = { ...SET_DEF };
function loadSettings(){
  try{ SET = { ...SET_DEF, ...(JSON.parse(localStorage.getItem(LS_SET)) || {}) }; }catch(e){ SET = { ...SET_DEF }; }
  applySettings();
}
function saveSettings(){
  try{ localStorage.setItem(LS_SET, JSON.stringify(SET)); }catch(e){}
  applySettings();
}
function applySettings(){
  document.documentElement.style.fontSize = (SET.font || 100) + '%';
  document.documentElement.classList.toggle('no-motion', !SET.motion);
  applyTheme();
}

/* Ce bloc part dans TOUS les prompts : l'IA connaît enfin tes goûts */
function prefsBlock(){
  const L = [];
  if(SET.style?.length) L.push(`Style de voyage recherché : ${SET.style.join(', ')}`);
  const R = { doux:'rythme DOUX : peu d\'activités par jour, du temps libre, pas de course',
              equilibre:'rythme ÉQUILIBRÉ : 2-3 activités par jour',
              intense:'rythme INTENSE : programme dense, on optimise chaque heure' };
  L.push(R[SET.rythme] || R.equilibre);
  const F = { vege:'végétarien', vegan:'végan', halal:'halal', casher:'casher', sansgluten:'sans gluten' };
  if(F[SET.food]) L.push(`Alimentation ${F[SET.food]} : les restaurants et adresses proposés DOIVENT proposer cette option`);
  if(SET.acces === 'oui') L.push("ACCESSIBILITÉ : le voyageur est à mobilité réduite — privilégie les lieux accessibles, évite les escaliers, sentiers escarpés et longues marches, et signale-le");
  if(SET.eviter?.length){
    const M = { avion:"l'AVION", train:'le TRAIN', voiture:'la VOITURE' };
    const noms = SET.eviter.map(x => M[x]).filter(Boolean);
    L.push(`TRANSPORTS À ÉVITER : le voyageur ne veut PAS prendre ${noms.join(' ni ')}. Propose autre chose (${['avion','train','voiture','bus','ferry'].filter(x => !SET.eviter.includes(x)).join(', ')}). Si vraiment aucune alternative n'existe, dis-le clairement et explique pourquoi.`);
  }
  /* ⚠️ Le déplacement SUR PLACE change le regroupement des journées, pas
     seulement un affichage : à pied on ne tient qu'un quartier par jour, en
     voiture on peut sortir de la ville. C'est une contrainte de PLANIFICATION,
     et l'IA doit l'avoir. */
  const SP = {
    pied: 'DÉPLACEMENTS SUR PLACE : À PIED uniquement. Regroupe chaque journée dans UN SEUL quartier, avec au maximum 20 à 25 minutes de marche entre deux lieux consécutifs. Ne mets jamais dans la même journée deux lieux éloignés, même si le thème s\'y prête. Signale les transports en commun utiles dans "sur_place".',
    velo: 'DÉPLACEMENTS SUR PLACE : À VÉLO. Les journées peuvent couvrir une ville entière ; privilégie les villes plates ou signale les côtes. Indique où louer un vélo et le prix dans "sur_place".',
    transports: 'DÉPLACEMENTS SUR PLACE : TRANSPORTS EN COMMUN. Les journées peuvent couvrir toute l\'agglomération. Indique OBLIGATOIREMENT dans "sur_place" le pass ou la carte à prendre, avec son prix réel, et les lignes utiles.',
    voiture: 'DÉPLACEMENTS SUR PLACE : EN VOITURE. Les journées peuvent sortir de la ville (30 à 60 min de route acceptables). Signale le stationnement (payant, difficile, zones interdites) et les péages dans "sur_place", et compte-les dans le budget.'
  };
  if(SP[SET.surPlace]) L.push(SP[SET.surPlace]);

  const D = { court:'Sois CONCIS : phrases courtes, va à l\'essentiel.',
              normal:'', long:'Sois DÉTAILLÉ : explique tes choix, donne des astuces concrètes et des alternatives.' };
  if(D[SET.detail]) L.push(D[SET.detail]);
  return L.length ? `\nPRÉFÉRENCES PERMANENTES DU VOYAGEUR (à respecter dans TOUTES tes réponses) :\n- ${L.join('\n- ')}\n` : '';
}

/* --- Rendu du panneau Préférences --- */
const OPT = {
  stStyle:  { key:'style',  multi:true,  items:[['detente','Détente'],['culture','Culture'],['aventure','Aventure'],['fete','Fête'],['nature','Nature'],['gastro','Gastronomie'],['famille','Famille'],['romantique','Romantique']] },
  stRythme: { key:'rythme', items:[['doux','Doux'],['equilibre','Équilibré'],['intense','Intense']] },
  /* Les libellés viennent de SUR_PLACE : une seule source, donc pas de risque
     qu'un choix existe ici sans vitesse associée — ou l'inverse. */
  stSurPlace: { key:'surPlace', items: Object.entries(SUR_PLACE).map(([k, v]) => [k, v.nom]) },
  stFood:   { key:'food',   items:[['aucun','Aucune contrainte'],['vege','Végétarien'],['vegan','Végan'],['halal','Halal'],['casher','Casher'],['sansgluten','Sans gluten']] },
  stAcces:  { key:'acces',  items:[['non','Aucun besoin'],['oui','Mobilité réduite']] },
  stEco:    { key:'eviter', multi:true, items:[['avion','Éviter l\'avion'],['train','Éviter le train'],['voiture','Éviter la voiture']] },
  stTheme:  { key:'theme',  items:[['auto','Système'],['light','Clair'],['dark','Sombre']] },
  stIA:     { key:null,     toggles:[['verif','Double vérification du plan'],['reels','Données réelles (météo, trains, fériés)']] },
  stUI:     { key:null,     toggles:[['motion','Animations']] }
};
/* La fabrique de puces, sortie de renderSettings pour que l'écran de questions
   de la première visite s'en serve AUSSI. Un seul dessin, un seul jeu
   d'attributs — et surtout : ces attributs sont ceux que le gestionnaire global
   [data-set] lit déjà. Les questions n'ont donc AUCUN chemin d'écriture propre.
   C'est le point important : une deuxième façon d'enregistrer une préférence
   serait une deuxième façon de se tromper, et elle finirait par oublier
   saveSettings() ou par écrire une valeur que le questionnaire ne connaît pas. */
function chipsHTML(cfg){
  return cfg.items.map(([v, lbl]) => {
    const on = cfg.multi ? (SET[cfg.key] || []).includes(v) : SET[cfg.key] === v;
    return `<div class="chip ${on ? 'on' : ''}" data-set="${cfg.key}" data-val="${v}" data-multi="${cfg.multi ? 1 : 0}">${lbl}</div>`;
  }).join('');
}
function renderSettings(){
  Object.entries(OPT).forEach(([id, cfg]) => {
    const box = $('#' + id);
    if(!box) return;
    if(cfg.toggles){
      box.innerHTML = cfg.toggles.map(([k, lbl]) =>
        `<div class="chip ${SET[k] ? 'on' : ''}" data-tog="${k}">${lbl} ${SET[k] ? '✔' : ''}</div>`).join('');
      return;
    }
    box.innerHTML = chipsHTML(cfg);
  });
  const dt = $('#stDetail'); if(dt) dt.value = SET.detail;
  const f = $('#stFont'); if(f) f.value = SET.font;
  const fv = $('#stFsVal'); if(fv) fv.textContent = SET.font + ' %';
  const hc = $('#stHome'); if(hc) hc.value = SET.homeCity || '';
  const sa = $('#stAdults'); if(sa) sa.value = String(SET.defAdults ?? 2);
  const sk = $('#stKids'); if(sk) sk.value = String(SET.defKids ?? 0);
}
/* Valeurs par défaut → pré-remplissage du questionnaire (uniquement si vide) */
function applyTripDefaults(){
  const from = $('#fFrom'); if(from && !from.value.trim() && SET.homeCity) from.value = SET.homeCity;
  const ad = $('#fAdults'); if(ad && SET.defAdults) ad.value = String(SET.defAdults);
  const ki = $('#fKids'); if(ki && SET.defKids !== undefined) ki.value = String(SET.defKids);
}
{
  const hc = $('#stHome'); if(hc) hc.onchange = () => { SET.homeCity = hc.value.trim().slice(0, 60); saveSettings(); applyTripDefaults(); toast('🏠 Ville de départ par défaut enregistrée'); };
  const sa = $('#stAdults'); if(sa) sa.onchange = () => { SET.defAdults = +sa.value || 2; saveSettings(); applyTripDefaults(); };
  const sk = $('#stKids'); if(sk) sk.onchange = () => { SET.defKids = +sk.value || 0; saveSettings(); applyTripDefaults(); };
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-set]');
  if(c){
    const k = c.dataset.set, v = c.dataset.val;
    if(c.dataset.multi === '1'){
      const arr = SET[k] || [];
      SET[k] = arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
    } else SET[k] = v;
    saveSettings(); renderSettings();
    toast('✔ Préférence enregistrée — l\'IA en tiendra compte');
    return;
  }
  const tg = e.target.closest('[data-tog]');
  if(tg){
    SET[tg.dataset.tog] = !SET[tg.dataset.tog];
    saveSettings(); renderSettings();
    return;
  }
  if(e.target.id === 'stReset'){
    if(!confirm('Réinitialiser toutes tes préférences ?')) return;
    SET = { ...SET_DEF };
    saveSettings(); renderSettings();
    toast('↺ Préférences réinitialisées');
  }
});
document.addEventListener('change', e => {
  if(e.target.id === 'stDetail'){ SET.detail = e.target.value; saveSettings(); }
});
document.addEventListener('input', e => {
  if(e.target.id !== 'stFont') return;
  SET.font = +e.target.value;
  $('#stFsVal').textContent = SET.font + ' %';
  saveSettings();
});

/* --- Barre "l'IA cherche" : remplace la nav du bas pendant la réflexion --- */
/* La mascotte parle à la première personne : c'est elle qui cherche. */
const SB_MSG = [
  'J’explore le monde pour toi…',
  'Je compare les destinations…',
  'Je vérifie les vols et les prix…',
  'Je repère les bons quartiers…',
  'Je finalise tes propositions…'
];
let _sbTimer = null;
function searchBar(on, first){
  const bar = $('#searchBar'), nav = $('.catnav');
  if(!bar || !nav) return;
  clearInterval(_sbTimer);
  if(on){
    let i = 0;
    const mk = $('#sbMascot');
    if(mk && !mk.querySelector('.mascot')) mk.innerHTML = travelSceneHTML();   /* la mascotte survole les monuments pendant la recherche */
    $('#sbText').textContent = first || SB_MSG[0];
    bar.hidden = false;
    nav.style.display = 'none';          /* les 3 boutons laissent la place à la barre */
    _sbTimer = setInterval(() => {
      i = (i + 1) % SB_MSG.length;
      $('#sbText').textContent = SB_MSG[i];
    }, 2200);
  } else {
    bar.hidden = true;
    nav.style.display = '';
  }
}

/* ============================================================
   MOTEUR DE CARTE — tuiles OpenStreetMap, sans aucune librairie
   ------------------------------------------------------------
   Pourquoi maison plutôt qu'une librairie : l'iframe d'OSM ne pose qu'UN
   marqueur, elle ne pouvait donc jamais montrer une journée entière. Et une
   librairie se charge depuis un CDN, indisponible en avion — or « consultable
   hors-ligne » est la promesse du produit. Ici les tuiles sont de simples
   <img> : le service worker sait les garder, et la CSP les autorise déjà.
   Projection Web Mercator, la même que celle des tuiles.
============================================================ */
const AM_TS = 256, AM_ZMIN = 3, AM_ZMAX = 18;
/* Couronne de tuiles posée AUTOUR du visible : on peut se déplacer de cette
   distance sans rien recalculer ni rien recharger. Une tuile entière. */
const AM_BUF = 256;
function amProject(lat, lon, z){
  const s = AM_TS * Math.pow(2, z);
  const la = Math.max(-85.0511, Math.min(85.0511, +lat || 0)) * Math.PI / 180;
  return {
    x: ((+lon || 0) + 180) / 360 * s,
    y: (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * s
  };
}
function amUnproject(x, y, z){
  const s = AM_TS * Math.pow(2, z);
  const n = Math.PI - 2 * Math.PI * y / s;
  return {
    lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
    lon: x / s * 360 - 180
  };
}
/* minutes de marche pour une distance à vol d'oiseau (5 km/h, +25 % de détours) */
const amWalkMin = km => Math.max(1, Math.round(km * 1.25 / 5 * 60));
const amDist = km => km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;

function acoMapCreate(el){
  el.classList.add('acomap');
  el.innerHTML = `<div class="am-tiles"></div>
    <svg class="am-lines" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>
    <div class="am-marks"></div>
    <div class="am-pop" hidden></div>
    <div class="am-zoom">
      <button type="button" class="am-zb" data-amz="1" title="Zoomer" aria-label="Zoomer">+</button>
      <button type="button" class="am-zb" data-amz="-1" title="Dézoomer" aria-label="Dézoomer">−</button>
    </div>
    <a class="am-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>`;

  const elTiles = el.querySelector('.am-tiles');
  const elLines = el.querySelector('.am-lines');
  const elMarks = el.querySelector('.am-marks');
  const elPop   = el.querySelector('.am-pop');

  const M = {
    center: { lat: 48.8566, lon: 2.3522 },
    zoom: 12,
    marks: [],          /* { lat, lon, kind, n, nom } */
    line: [],           /* [[lat,lon], …] */
    dash: [],           /* trait pointillé (position → prochaine étape) */
    tiles: new Map(),
    lay: null,          /* origine de la dernière mise en place des tuiles */
    raf: 0
  };

  /* ---- tuiles ---- */
  /* ---- Couche de tuiles ----------------------------------------------------
     Trois règles apprises à la dure :
     1. On dessine une COURONNE de tuiles autour de ce qui est visible (AM_BUF).
        Ainsi un petit déplacement révèle des tuiles déjà chargées, au lieu de
        montrer du vide puis d'attendre le réseau.
     2. Pendant un déplacement, on ne recalcule PAS la position de chaque
        tuile : on translate le CONTENEUR, ce qui ne coûte qu'une composition
        GPU. On ne refait la mise en place que si on sort de la couronne.
     3. On ne supprime jamais une tuile pendant un geste : jeter une tuile
        chargée pour la redemander une seconde plus tard, c'est ce qui donnait
        l'impression d'une carte lente. Le ménage se fait à l'arrêt.
  ------------------------------------------------------------------------- */
  function tileURL(z, xw, y){ return `https://tile.openstreetmap.org/${z}/${xw}/${y}.png`; }
  function drawTiles(w, h, z, ox, oy){
    const n = Math.pow(2, z);
    const B = AM_BUF;
    const x0 = Math.floor((ox - B) / AM_TS), x1 = Math.floor((ox + w + B) / AM_TS);
    const y0 = Math.max(0, Math.floor((oy - B) / AM_TS)), y1 = Math.min(n - 1, Math.floor((oy + h + B) / AM_TS));
    const garde = new Set();
    for(let x = x0; x <= x1; x++){
      for(let y = y0; y <= y1; y++){
        /* la clé porte x NON replié : c'est lui qui donne la position, et deux
           positions différentes ne doivent jamais partager le même nœud */
        const k = `${z}:${x}:${y}`;
        garde.add(k);
        let img = M.tiles.get(k);
        if(!img){
          img = new Image();
          img.className = 'am-tile';
          img.alt = '';
          img.decoding = 'async';
          /* ⚠️ draggable=false : sans ça le navigateur lance SON glisser-déposer
             d'image dès qu'on tire sur la carte, et le déplacement ne marche
             plus — la carte semblait « collée ». C'était le vrai bug. */
          img.draggable = false;
          /* CORS explicite : sans ça la réponse est « opaque », le service
             worker ne peut ni la lire ni la juger valide, et la carte hors-ligne
             ne marche pas. OpenStreetMap renvoie bien Access-Control-Allow-Origin. */
          img.crossOrigin = 'anonymous';
          img.addEventListener('load', () => img.classList.add('on'), { once: true });
          img.src = tileURL(z, ((x % n) + n) % n, y);
          elTiles.appendChild(img);
          M.tiles.set(k, img);
        }
        img.style.transform = `translate3d(${Math.round(x * AM_TS - ox)}px,${Math.round(y * AM_TS - oy)}px,0)`;
      }
    }
    /* Cette fonction fait AUTORITÉ sur ce qui est affiché : toute tuile
       absente de la couronne part. Garder une tuile sans la repositionner la
       laissait dessinée à son ancienne place — d'où des morceaux de carte
       décalés. Comme drawTiles n'est plus appelée à chaque image (le
       déplacement passe par la translation du conteneur), ce ménage ne coûte
       plus rien. */
    for(const [k, img] of M.tiles){
      if(!garde.has(k)){ img.remove(); M.tiles.delete(k); }
    }
    /* origine de cette mise en place : le déplacement s'y réfère */
    M.lay = { z, ox, oy, x0, x1, y0, y1, w, h };
    elTiles.style.transform = '';
  }

  /* ---- marqueurs : le DOM n'est reconstruit que si la liste change ---- */
  function buildMarks(){
    elMarks.innerHTML = M.marks.map((m, i) => {
      const lbl = m.kind === 'stop' ? String(m.n)
        : m.kind === 'hotel' ? '🏨' : m.kind === 'me' ? '📍'
        : m.kind === 'start' ? '🏠' : m.kind === 'end' ? '🎯' : '•';
      return `<button type="button" class="am-mark am-${esc(m.kind)}" data-ammark="${i}"
        title="${esc(m.nom || '')}" aria-label="${esc(m.nom || '')}">${esc(lbl)}</button>`;
    }).join('');
  }
  function placeMarks(w, h, z, ox, oy){
    const els = elMarks.children;
    for(let i = 0; i < M.marks.length; i++){
      const m = M.marks[i], node = els[i];
      if(!node) continue;
      const p = amProject(m.lat, m.lon, z);
      node.style.transform = `translate3d(${Math.round(p.x - ox)}px,${Math.round(p.y - oy)}px,0)`;
    }
  }

  /* ---- traits ---- */
  function drawLines(w, h, z, ox, oy){
    elLines.setAttribute('viewBox', `0 0 ${w} ${h}`);
    elLines.setAttribute('width', w);
    elLines.setAttribute('height', h);
    const pts = arr => arr.map(([la, lo]) => {
      const p = amProject(la, lo, z);
      return `${Math.round(p.x - ox)},${Math.round(p.y - oy)}`;
    }).join(' ');
    let html = '';
    if(M.line.length > 1){
      /* deux traits superposés : le noir épais dessous fait la bordure dure
         du style néo-brutaliste, le jaune passe par-dessus */
      html += `<polyline class="am-line-b" points="${pts(M.line)}"/>`
           +  `<polyline class="am-line-f" points="${pts(M.line)}"/>`;
    }
    if(M.dash.length > 1) html += `<polyline class="am-dash" points="${pts(M.dash)}"/>`;
    elLines.innerHTML = html;
  }

  function draw(){
    M.raf = 0;
    const w = el.clientWidth, h = el.clientHeight;
    if(!w || !h) return;
    const z = Math.round(M.zoom);
    const c = amProject(M.center.lat, M.center.lon, z);
    const ox = c.x - w / 2, oy = c.y - h / 2;
    /* Tant qu'on reste dans la couronne déjà posée, on se contente de
       translater le conteneur : aucun calcul par tuile, aucune écriture DOM.
       C'est ce qui rend le déplacement fluide. */
    const L = M.lay;
    const dedans = L && L.z === z && L.w === w && L.h === h
      && Math.abs(ox - L.ox) < AM_BUF && Math.abs(oy - L.oy) < AM_BUF;
    if(dedans) elTiles.style.transform = `translate3d(${Math.round(L.ox - ox)}px,${Math.round(L.oy - oy)}px,0)`;
    else drawTiles(w, h, z, ox, oy);
    drawLines(w, h, z, ox, oy);
    placeMarks(w, h, z, ox, oy);
    if(!elPop.hidden && elPop._i != null){
      const m = M.marks[elPop._i];
      if(m){
        const p = amProject(m.lat, m.lon, z);
        elPop.style.transform = `translate3d(${Math.round(p.x - ox)}px,${Math.round(p.y - oy)}px,0)`;
      }
    }
  }
  function schedule(){ if(!M.raf) M.raf = requestAnimationFrame(draw); }

  /* ---- zoom autour d'un point de l'écran (curseur ou pincement) ---- */
  function zoomAt(cx, cy, d){
    const r = el.getBoundingClientRect();
    const z0 = Math.round(M.zoom);
    const z1 = Math.max(AM_ZMIN, Math.min(AM_ZMAX, z0 + d));
    if(z1 === z0) return;
    const px = cx - r.left, py = cy - r.top;
    const c0 = amProject(M.center.lat, M.center.lon, z0);
    const g = amUnproject(c0.x - r.width / 2 + px, c0.y - r.height / 2 + py, z0);
    const p1 = amProject(g.lat, g.lon, z1);
    M.zoom = z1;
    M.center = amUnproject(p1.x - px + r.width / 2, p1.y - py + r.height / 2, z1);
    hidePop();
    draw();
  }

  /* ---- déplacement ---- */
  let drag = null;
  const pts = new Map();
  let pinch = 0;
  let _dragDist = 0;   /* distance du dernier glissement : sert à distinguer un clic d'un déplacement */
  el.addEventListener('pointerdown', e => {
    if(e.target.closest('.am-zb, .am-credit, .am-mark')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(pts.size === 2){ drag = null; pinch = pinchDist(); return; }
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    _dragDist = 0;
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    el.classList.add('am-grab');
  });
  function pinchDist(){
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  el.addEventListener('pointermove', e => {
    if(pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(pts.size === 2 && pinch){
      const d = pinchDist();
      const [a, b] = [...pts.values()];
      if(d / pinch > 1.55){ zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, 1); pinch = d; }
      else if(d / pinch < 0.65){ zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, -1); pinch = d; }
      return;
    }
    if(!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX; drag.y = e.clientY;
    const z = Math.round(M.zoom);
    const c = amProject(M.center.lat, M.center.lon, z);
    M.center = amUnproject(c.x - dx, c.y - dy, z);
    schedule();
  });
  function endPointer(e){
    pts.delete(e.pointerId);
    if(pts.size < 2) pinch = 0;
    if(drag){
      _dragDist = drag.moved; drag = null; el.classList.remove('am-grab');
      /* Le geste est fini : on repose proprement les tuiles autour de la
         nouvelle position. Pendant le geste, on ne touche pas au DOM. */
      const w = el.clientWidth, h = el.clientHeight;
      if(w && h){
        const z = Math.round(M.zoom);
        const c = amProject(M.center.lat, M.center.lon, z);
        drawTiles(w, h, z, c.x - w / 2, c.y - h / 2);
      }
    }
  }
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);
  el.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  el.addEventListener('dblclick', e => {
    if(e.target.closest('.am-zb, .am-credit')) return;
    zoomAt(e.clientX, e.clientY, 1);
  });
  el.addEventListener('click', e => {
    const zb = e.target.closest('.am-zb');
    if(zb){
      const r = el.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, +zb.dataset.amz);
      return;
    }
    const mk = e.target.closest('.am-mark');
    if(mk){ showPop(+mk.dataset.ammark); return; }
    hidePop();
    /* Point d'accroche : le mini-jeu des monuments s'en sert pour savoir où
       le joueur pointe. On ignore le clic qui termine un déplacement, sinon
       tout glissement de carte poserait un marqueur par accident. */
    if(M.onClick && !e.target.closest('.am-credit') && _dragDist < 6){
      const r = el.getBoundingClientRect();
      const z = Math.round(M.zoom);
      const c = amProject(M.center.lat, M.center.lon, z);
      const g = amUnproject(c.x - r.width / 2 + (e.clientX - r.left),
                            c.y - r.height / 2 + (e.clientY - r.top), z);
      M.onClick(g.lat, g.lon);
    }
  });

  /* ---- bulle d'un lieu : le nom, et de quoi s'y faire guider ---- */
  function showPop(i){
    const m = M.marks[i];
    if(!m || !m.nom){ hidePop(); return; }
    const url = `https://www.google.com/maps/search/${encodeURIComponent(m.nom + (m.ville ? ', ' + m.ville : ''))}`;
    elPop._i = i;
    elPop.hidden = false;
    elPop.innerHTML = `<span class="am-pop-in"><b>${esc(m.nom)}</b>`
      + `<a href="${esc(url)}" target="_blank" rel="noopener">↗ M'y guider</a></span>`;
    draw();
  }
  function hidePop(){ elPop.hidden = true; elPop._i = null; }

  if(window.ResizeObserver) new ResizeObserver(() => schedule()).observe(el);

  return {
    el,
    /* le mini-jeu des monuments branche ici sa fonction de clic */
    onClick(fn){ M.onClick = fn; },
    setView(lat, lon, z){ M.center = { lat: +lat, lon: +lon }; if(z) M.zoom = z; draw(); },
    panTo(lat, lon, z){
      M.center = { lat: +lat, lon: +lon };
      if(z) M.zoom = Math.max(AM_ZMIN, Math.min(AM_ZMAX, z));
      hidePop(); draw();
    },
    setMarks(list){
      M.marks = list || [];
      /* Exposé pour ouvreLieuSurCarte() : les repères vivent dans cette
         fermeture, et le clic sur « 📍 Carte » a besoin de les retrouver. */
      window._projMarks = M.marks;
      hidePop(); buildMarks(); draw();
    },
    setLine(line, dash){ M.line = line || []; M.dash = dash || []; draw(); },
    openMark(i){ showPop(i); },
    /* cadre la carte sur un ensemble de points, avec une marge en pixels */
    fit(points, pad){
      const pl = (points || []).filter(p => p && isFinite(p[0]) && isFinite(p[1]));
      if(!pl.length) return;
      if(pl.length === 1){ M.center = { lat: pl[0][0], lon: pl[0][1] }; M.zoom = 15; draw(); return; }
      const las = pl.map(p => p[0]), los = pl.map(p => p[1]);
      const N = Math.max(...las), S = Math.min(...las), E = Math.max(...los), W = Math.min(...los);
      const w = Math.max(40, el.clientWidth - (pad || 40) * 2);
      const h = Math.max(40, el.clientHeight - (pad || 40) * 2);
      let z = AM_ZMAX;
      for(; z > AM_ZMIN; z--){
        const a = amProject(N, W, z), b = amProject(S, E, z);
        if(Math.abs(b.x - a.x) <= w && Math.abs(b.y - a.y) <= h) break;
      }
      M.zoom = z;
      /* centre calculé en pixels : la moyenne des latitudes décale en Mercator */
      const a = amProject(N, W, z), b = amProject(S, E, z);
      M.center = amUnproject((a.x + b.x) / 2, (a.y + b.y) / 2, z);
      draw();
    },
    draw
  };
}

/* ============================================================
   CARTE DU VOYAGE — une journée = des étapes numérotées reliées
============================================================ */
let _acoMap = null;
let _mapIdx = 0;

function mapEngine(){
  const box = $('#projMap');
  if(!box) return null;
  if(!_acoMap) _acoMap = acoMapCreate(box);
  return _acoMap;
}

/* position du point de départ (ville du voyageur), mise en cache */
async function fromCoords(){
  const nom = cleanPlace(state.prefs?.from || '');
  if(!nom) return null;
  const ck = 'geo_from_' + nom.toLowerCase();
  if(state.cache[ck]) return state.cache[ck];
  const g = await geoPlace(nom);
  if(!g) return null;
  const v = { lat: +g.latitude, lon: +g.longitude };
  state.cache[ck] = v; save();
  return v;
}

/* Construit la liste des trajets : l'aller, puis une entrée par journée.
   Chaque étape porte sa position réelle — c'est ce qui permet le tracé. */
async function buildProjectMap(){
  const t = state.trip, p = state.prefs || {}, c = state.cache;
  const bar = $('#mapDays');
  if(!bar) return;
  const map = mapEngine();
  if(!t){
    bar.innerHTML = '';
    const n = $('#mapNote'); if(n) n.textContent = '';
    const w = $('#mapWarn'); if(w) w.textContent = '';
    const z = $('#zoneStops'); if(z) z.innerHTML = '';
    window._projRoutes = [];
    if(map){
      map.setMarks([]);
      map.setLine([]);
      map.setView(48.8566, 2.3522, 5);
    }
    return;
  }
  /* les positions des lieux : déjà là si le plan est récent, sinon on les
     relève maintenant (un voyage créé avant cette version) */
  await ensurePlanGeo().catch(() => null);

  const plan = c.plan;
  const geo = plan?._geo || {};
  const g = await geocode();
  const villeLL = g ? { lat: +g.latitude, lon: +g.longitude } : null;
  const hotel = plan?._geoHotel || null;
  const routes = [];

  /* ---- l'aller : un vrai trait départ → arrivée, pas un point isolé ---- */
  const dep = await fromCoords();
  if(villeLL){
    const ico = ({ plane: '✈️', train: '🚆', car: '🚗' })[state.mode] || '✈️';
    const modeNom = ({ plane: 'avion', train: 'train', car: 'voiture' })[state.mode] || 'avion';
    const km = c._real?.dist;
    const co2 = km ? Math.round(km * 2 * (CO2_G_KM[modeNom === 'avion' ? 'avion' : modeNom === 'train' ? 'train' : 'voiture']) / 1000) : null;
    routes.push({
      label: `${ico} Aller`,
      note: `${p.from || 'Départ'} → ${t.nom}`
        + (km ? ` · ${km} km` : '')
        + (co2 ? ` · ~${co2} kg de CO₂ aller-retour` : ''),
      marks: [
        ...(dep ? [{ lat: dep.lat, lon: dep.lon, kind: 'start', nom: p.from || 'Départ' }] : []),
        { lat: villeLL.lat, lon: villeLL.lon, kind: 'end', nom: t.nom, ville: t.pays }
      ],
      line: dep ? [[dep.lat, dep.lon], [villeLL.lat, villeLL.lon]] : [],
      stops: []
    });
  }

  /* ---- une entrée par journée ---- */
  (plan?.programme || []).forEach(j => {
    const lieux = (j.lieux || []).filter(Boolean);
    if(!lieux.length) return;
    const ville = j.base || t.nom;
    const stops = lieux.map(l => {
      const ll = geo[l];
      return { nom: l, ville, lat: ll ? ll[0] : null, lon: ll ? ll[1] : null };
    });
    const situes = stops.filter(s => s.lat != null);
    const marks = situes.map((s, i) => ({ lat: s.lat, lon: s.lon, kind: 'stop', n: i + 1, nom: s.nom, ville }));
    if(hotel) marks.push({ lat: hotel.lat, lon: hotel.lon, kind: 'hotel', nom: hotel.nom, ville });
    routes.push({
      label: `${isEN()?'D':'J'}${j.jour}`,
      note: `${j.base ? j.base + ' · ' : ''}${j.resume || ''}`,
      marks,
      line: situes.map(s => [s.lat, s.lon]),
      stops,
      ville
    });
  });

  window._projRoutes = routes;
  renderRail();   /* la colonne liste les journées : elle suit */
  _mapIdx = Math.min(_mapIdx, Math.max(0, routes.length - 1));
  bar.innerHTML = routes.map((r, i) =>
    `<button type="button" class="rt${i === _mapIdx ? ' on' : ''}" data-mapday="${i}">${esc(r.label)}</button>`
  ).join('');
  showRoute(_mapIdx);
}

/* Affiche un trajet : marqueurs, tracé, cadrage, et la bande d'étapes */
/* ============================================================
   DEUX CARTES, UNE SEULE VISIBLE
   ------------------------------------------------------------
   · GOOGLE : le rendu que tout le monde reconnaît, avec les rues nommées, les
     commerces, et un vrai itinéraire à pied qui suit les trottoirs. Il faut du
     réseau.
   · ACOLYTE : le moteur maison sur tuiles OpenStreetMap. Les tuiles sont mises
     en cache par le service worker, donc il marche dans l'avion.

   ⚠️ POURQUOI ON NE REMPLACE PAS PURE ET SIMPLE. « La carte reste consultable
   sans réseau » est l'argument principal de l'app — il est dans l'onboarding,
   dans le panneau de connexion et dans la description publique. Une carte
   Google seule le rendrait faux. On garde donc les deux, et on suit le réseau
   par défaut : Google quand il y en a, Acolyte quand il n'y en a plus.

   ⚠️ AUCUNE CLÉ, AUCUN COMPTE DE FACTURATION. On utilise l'intégration
   « output=embed » de Google Maps, qui ne demande rien. L'API JavaScript de
   Google exigerait une carte bancaire, et MapKit d'Apple 99 $/an — les deux
   contredisent la contrainte « ça ne doit rien coûter ».
============================================================ */
const LS_MAPSRC = 'acolite_mapsrc';        /* 'auto' | 'google' | 'aco' */
const mapSrcChoix = () => { try{ return localStorage.getItem(LS_MAPSRC) || 'auto'; }catch(e){ return 'auto'; } };
/* Google est utilisé si l'utilisateur le demande, ou si on est en « auto » ET
   qu'il y a du réseau. Hors ligne, on n'essaie même pas : un cadre gris avec
   « impossible de charger » serait pire que la carte maison. */
const mapUseGoogle = () => {
  const c = mapSrcChoix();
  if(c === 'aco') return false;
  if(c === 'google') return navigator.onLine !== false;
  return navigator.onLine !== false;
};
/* L'adresse de l'intégration. Avec plusieurs arrêts, on demande un ITINÉRAIRE
   à pied qui les enchaîne — c'est plus utile qu'un simple point centré, et
   c'est ce que la carte maison ne sait pas faire (elle trace à vol d'oiseau). */
function mapGoogleURL(r){
  const noms = (r?.stops || []).map(s => s?.nom).filter(Boolean).slice(0, 9);
  const ville = r?.ville || state.trip?.nom || '';
  const q = (n) => encodeURIComponent(n + (ville && !n.includes(ville) ? ', ' + ville : ''));
  if(noms.length >= 2){
    /* « +to: » enchaîne les étapes ; dirflg=w demande le trajet à pied */
    const dest = noms.slice(1).map(q).join('+to:');
    return `https://www.google.com/maps?saddr=${q(noms[0])}&daddr=${dest}&dirflg=w&hl=${isEN() ? 'en' : 'fr'}&output=embed`;
  }
  /* une seule étape (ou aucune) : on centre sur elle, ou sur la ville */
  const seul = noms[0] || ville;
  if(!seul){
    const m = (r?.marks || [])[0];
    if(!m) return '';
    return `https://www.google.com/maps?q=${m.lat},${m.lon}&z=13&hl=${isEN() ? 'en' : 'fr'}&output=embed`;
  }
  return `https://www.google.com/maps?q=${q(seul)}&z=14&hl=${isEN() ? 'en' : 'fr'}&output=embed`;
}
function mapSrcApplique(r){
  const g = $('#projGoogle'), a = $('#projMap');
  if(!g || !a) return;
  const url = mapUseGoogle() ? mapGoogleURL(r) : '';
  const surGoogle = !!url;
  /* ⚠️ On ne réécrit l'adresse que si elle CHANGE : réassigner src recharge le
     cadre à chaque rendu, ce qui fait clignoter la carte et repart du zoom
     initial alors que le voyageur venait de la déplacer. */
  if(surGoogle && g.getAttribute('src') !== url) g.setAttribute('src', url);
  g.hidden = !surGoogle;
  a.style.display = surGoogle ? 'none' : '';
  $('#mapSrcG')?.classList.toggle('on', surGoogle);
  $('#mapSrcA')?.classList.toggle('on', !surGoogle);
  /* Hors ligne alors que Google était demandé : on le dit, sinon la bascule
     ressemble à un bug. */
  const forceG = mapSrcChoix() === 'google';
  $('#mapSrcG')?.setAttribute('title', forceG && !surGoogle
    ? (isEN() ? 'No connection — offline map in use' : 'Pas de réseau — carte hors-ligne utilisée')
    : (isEN() ? 'Google map — needs a connection' : 'Carte Google — demande du réseau'));
}
document.addEventListener('click', e => {
  const g = e.target.closest('#mapSrcG'), a = e.target.closest('#mapSrcA');
  if(!g && !a) return;
  lsSet(LS_MAPSRC, g ? 'google' : 'aco');
  mapSrcApplique((window._projRoutes || [])[_mapIdx]);
});
/* Le réseau revient ou disparaît : la carte suit, sans rien demander. */
addEventListener('online',  () => mapSrcApplique((window._projRoutes || [])[_mapIdx]));
addEventListener('offline', () => mapSrcApplique((window._projRoutes || [])[_mapIdx]));

function showRoute(i){
  const routes = window._projRoutes || [];
  const r = routes[i];
  const map = mapEngine();
  if(!r || !map) return;
  _mapIdx = i;
  $$('#mapDays .rt').forEach((b, k) => b.classList.toggle('on', k === i));
  mapSrcApplique(r);

  map.setMarks(r.marks || []);
  map.setLine(r.line || []);
  const pts = (r.marks || []).map(m => [m.lat, m.lon]);
  if(pts.length) map.fit(pts, 56);

  const note = $('#mapNote');
  if(note){
    const sans = (r.stops || []).filter(s => s.lat == null).length;
    note.textContent = r.note || '';
    note.title = r.note || '';
    /* on le dit plutôt que de laisser croire que la journée est vide */
    const av = $('#mapWarn');
    if(av) av.textContent = sans ? `${sans} lieu${sans > 1 ? 'x' : ''} non localisé${sans > 1 ? 's' : ''}` : '';
  }
  renderStops(r);
  updateProjOpen(r);
}

/* La bande d'étapes : cliquer recentre la carte au lieu de quitter l'app */
function renderStops(r){
  const stops = $('#zoneStops');
  if(!stops) return;
  if(!(r.stops || []).length){ stops.innerHTML = ''; return; }
  stops.innerHTML = r.stops.map((s, i) => {
    const situe = s.lat != null;
    return `<button type="button" class="stop${situe ? '' : ' off'}" data-mapstop="${i}"
      title="${esc(s.nom)}"><b>${i + 1}</b> ${esc(String(s.nom).split(',')[0])}</button>`;
  }).join('');
}

function updateProjOpen(r){
  const a = $('#projOpen');
  if(!a) return;
  const noms = (r.stops || []).map(s => `${s.nom}, ${s.ville || ''}`);
  const pts = noms.length ? noms : (r.marks || []).map(m => m.nom).filter(Boolean);
  a.href = 'https://www.google.com/maps/dir/' + pts.map(encodeURIComponent).join('/');
}

function mapStep(dir){
  const routes = window._projRoutes || [];
  if(routes.length < 2) return;
  showRoute((_mapIdx + dir + routes.length) % routes.length);
}

/* 🧭 : ta position ET la prochaine étape — sur place, c'est la seule
   question qui compte. On trace le pointillé jusqu'à l'étape la plus proche. */
function mapLocate(){
  const map = mapEngine();
  if(!navigator.geolocation || !map){ toast('Géolocalisation indisponible sur cet appareil'); return; }
  toast('🧭 Recherche de ta position…');
  navigator.geolocation.getCurrentPosition(pos => {
    const me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    const r = (window._projRoutes || [])[_mapIdx];
    const situes = (r?.stops || []).filter(s => s.lat != null);
    const marks = (r?.marks || []).filter(m => m.kind !== 'me').concat([{ ...me, kind: 'me', nom: 'Toi' }]);
    map.setMarks(marks);
    if(!situes.length){
      map.setLine(r?.line || []);
      map.panTo(me.lat, me.lon, 15);
      toast('📍 Te voilà !');
      return;
    }
    /* l'étape la plus proche : c'est « et maintenant ? » répondu en un chiffre */
    let best = null, bestKm = Infinity;
    for(const s of situes){
      const km = havKm({ latitude: me.lat, longitude: me.lon }, { latitude: s.lat, longitude: s.lon });
      if(km < bestKm){ bestKm = km; best = s; }
    }
    map.setLine(r.line || [], [[me.lat, me.lon], [best.lat, best.lon]]);
    map.fit([[me.lat, me.lon], [best.lat, best.lon]], 70);
    toast(`📍 Tu es à ${amDist(bestKm)} de ${String(best.nom).split(',')[0]} — ${amWalkMin(bestKm)} min à pied`);
  }, () => toast('Position refusée ou introuvable'), { timeout: 8000, enableHighAccuracy: true });
}

document.addEventListener('click', e => {
  const day = e.target.closest('[data-mapday]');
  /* renderRail() est indispensable : sans lui la surbrillance de la colonne
     de gauche reste sur l'ancienne journée. Le clic sur la colonne, lui,
     faisait déjà les deux. */
  if(day){ showRoute(+day.dataset.mapday); renderRail(); return; }
  const st = e.target.closest('[data-mapstop]');
  if(st){
    const r = (window._projRoutes || [])[_mapIdx];
    const s = (r?.stops || [])[+st.dataset.mapstop];
    if(!s) return;
    if(s.lat == null){ toast(`« ${String(s.nom).split(',')[0]} » n’a pas pu être localisé`); return; }
    const map = mapEngine();
    if(!map) return;
    map.panTo(s.lat, s.lon, 16);
    /* on ouvre la bulle du marqueur correspondant pour faire le lien visuel */
    const idx = (r.marks || []).findIndex(m => m.kind === 'stop' && m.nom === s.nom);
    if(idx >= 0) map.openMark(idx);
    return;
  }
  if(e.target.id === 'mapLocate') mapLocate();
});
/* Flèches ← → pour passer d'une journée à l'autre. Deux points d'entrée : la
   bande de pastilles (téléphone et tablette) et la colonne de gauche, qui la
   remplace au-delà de 1080 px — sans ce second cas, la navigation au clavier
   entre les journées disparaîtrait purement et simplement sur ordinateur. */
document.addEventListener('keydown', e => {
  if(e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const dir = e.key === 'ArrowRight' ? 1 : -1;
  if(e.target.closest?.('#mapDays')){
    e.preventDefault(); mapStep(dir); $('#mapDays .rt.on')?.focus();
  }else if(_cat === 'map' && e.target.closest?.('#railSteps li[data-rail^="day:"]')){
    e.preventDefault(); mapStep(dir); renderRail();
    /* renderRail() a remplacé les <li> : on récupère le focus sur le neuf */
    $('#railSteps li.on')?.focus();
  }
});

/* --- Profil : infos + stats + paramètres --- */
/* ============================================================
   LE PASSEPORT VOYAGEUR
   ------------------------------------------------------------
   ⚠️ CE QUI A ÉTÉ RETIRÉ, ET POURQUOI : le pseudo se changeait par un
   `prompt()` natif. Une boîte du navigateur ne se met pas au thème, ne se
   traduit pas, bloque tout le fil d'exécution, et — surtout — ne porte qu'UN
   champ. C'est pour ça qu'il n'y avait ni avatar, ni devise, ni contact
   d'urgence : il n'y avait pas de place pour les demander. Une modale les
   porte tous, et le geste devient « modifier mon passeport » plutôt que
   « changer une chaîne de caractères ».
============================================================ */
const PP_AVATARS = ['🌍','✈️','🎒','🧭','🏖️','🏔️','🚆','🗺️','⛵','🏛️','🌋','🐘'];
const LS_PP = 'acolite_passeport';

/* Le passeport vit à part du compte : le compte porte ce que le SERVEUR
   connaît (email, pseudo), le passeport ce qui ne quitte jamais l'appareil. */
function ppLire(){
  try{ return JSON.parse(localStorage.getItem(LS_PP)) || {}; }catch(e){ return {}; }
}
function ppEcrire(p){ lsSet(LS_PP, JSON.stringify(p || {})); }

/* Le niveau : il se déduit de ce qu'on a fait, il ne s'achète pas et ne se
   règle pas. Les seuils sont volontairement bas — un niveau qu'on n'atteint
   jamais ne récompense personne. */
function ppNiveau(n){
  if(n >= 10) return 'Globe-trotteur';
  if(n >= 5)  return 'Grand voyageur';
  if(n >= 2)  return 'Baroudeur';
  if(n >= 1)  return 'Explorateur';
  return 'Nouveau venu';
}

function ppBadges(){
  const h = getHistory(), n = h.length;
  const t = state.trip, c = state.cache || {};
  const jours = Object.keys(c.days || {}).length;
  const pays = new Set(h.map(x => x && x.pays).filter(Boolean)).size;
  /* Les badges portent des ICÔNES, comme le reste : six émojis en couleur sur
     une grille grise attiraient l'œil plus que le voyage lui-même. */
  return [
    { i:'valise',     nom:'Premier départ', d:'Préparer un voyage',              ok: n >= 1 },
    { i:'carte',      nom:'Cartographe',    d:'Détailler une journée',            ok: jours >= 1 },
    { i:'calendrier', nom:'Organisé',       d:'Détailler 3 journées',             ok: jours >= 3 },
    { i:'monde',      nom:'Deux pays',      d:'Préparer 2 pays différents',       ok: pays >= 2 },
    { i:'etincelle',  nom:'Habitué',        d:'Préparer 5 voyages',               ok: n >= 5 },
    { i:'telephone',  nom:'Hors-ligne',     d:'Installer Acolyte sur l’appareil', ok: pwaInstalle() }
  ];
}

function renderProfile(){
  const u = getUser();
  const pp = ppLire();
  const av = $('#pfAvatar'), nom = $('#pfEmail'), meta = $('#pfMeta');
  if(!av || !nom || !meta) return;

  /* ⚠️ Le profil s'affiche AUSSI sans compte, depuis que l'entrée n'est plus
     un mur : `u` peut être null. Avant, la fonction sortait immédiatement et
     l'écran restait sur ses tirets. */
  const pseudo = (u && (u.pseudo || String(u.email || '').split('@')[0])) || 'Voyageur';
  const h = getHistory();

  av.textContent = pp.avatar || PP_AVATARS[0];
  nom.textContent = pseudo;
  const niv = $('#pfNiveau'); if(niv) niv.textContent = ppNiveau(h.length);
  const bio = $('#pfBio'); if(bio) bio.textContent = pp.bio || '';

  /* connecté = vérifié : le serveur refuse la connexion tant que l'adresse
     n'est pas confirmée, il n'y a donc plus d'état intermédiaire à afficher */
  meta.textContent = u
    ? `${u.email} · ${authToken() ? 'synchronisé' : 'hors ligne'}`
      + (u.created ? ` · membre depuis le ${new Date(u.created).toLocaleDateString(LOC())}` : '')
    : 'Visite libre — crée un compte pour générer tes voyages';

  /* --- Les chiffres --- */
  const jours = Object.keys((state.cache || {}).days || {}).length;
  const stats = [
    ['Voyages préparés', String(h.length)],
    ['Journées détaillées', String(jours)],
    ['Ville de départ', pp.home || (state.prefs && state.prefs.from) || '—'],
    ['Hors-ligne', pwaInstalle() ? '✔ installé' : 'navigateur']
  ];
  const box = $('#pfStats');
  if(box) box.innerHTML = stats.map(([k, v]) =>
    `<div class="pp-stat"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');

  /* --- Le voyage en cours, avec ses raccourcis --- */
  const zv = $('#pfVoyageActif');
  if(zv){
    const t = state.trip;
    zv.innerHTML = t
      ? `<div class="pp-voyage">
           <div class="pp-voyage-i" aria-hidden="true">${ICO("valise",26)}</div>
           <div class="pp-voyage-t">
             <h3>${esc(t.nom || '?')}${t.pays ? ' · ' + esc(t.pays) : ''}</h3>
             <p>${esc(state.prefs && state.prefs.from ? 'Départ de ' + state.prefs.from : 'Voyage en préparation')}${
               jours ? ` · ${jours} journée${jours > 1 ? 's' : ''} détaillée${jours > 1 ? 's' : ''}` : ''}</p>
           </div>
         </div>
         <div class="pp-raccourcis">
           <button class="btn sm ghost" data-ppgo="trip">Ouvrir le voyage</button>
           <button class="btn sm ghost" data-ppgo="map">Voir la carte</button>
           <button class="btn sm ghost" data-ppgo="ia">Demander à l’assistant</button>
         </div>`
      : `<div class="pp-voyage">
           <div class="pp-voyage-i" aria-hidden="true">${ICO("avion",26)}</div>
           <div class="pp-voyage-t">
             <h3>Aucun voyage en cours</h3>
             <p>Décris une envie, Acolyte s’occupe du reste.</p>
           </div>
         </div>
         <div class="pp-raccourcis">
           <button class="btn sm" data-ppgo="trip">Commencer un voyage</button>
         </div>`;
  }

  /* --- Les badges --- */
  const zb = $('#pfBadges');
  if(zb) zb.innerHTML = ppBadges().map(b =>
    `<div class="pp-badge${b.ok ? '' : ' off'}">
       <span class="pb-i" aria-hidden="true">${ICO(b.i, 22)}</span>
       <span class="pb-t"><b>${esc(b.nom)}</b><em>${esc(b.ok ? 'Débloqué' : b.d)}</em></span>
     </div>`).join('');
}

/* Les raccourcis du passeport : un seul écouteur, posé une fois — le bloc est
   reconstruit à chaque rendu, un écouteur posé dessus serait perdu. */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-ppgo]');
  if(!b) return;
  const ou = b.dataset.ppgo;
  switchCat(ou);
  if(ou === 'trip' && !state.trip) gotoStep(1);
});

/* ---- La modale d'édition ---- */
function ppOuvreEdition(){
  const u = getUser() || {}, pp = ppLire();
  const pseudo = u.pseudo || String(u.email || '').split('@')[0] || '';
  const choisi = pp.avatar || PP_AVATARS[0];
  const grille = $('#edAvatars');
  if(grille) grille.innerHTML = PP_AVATARS.map(a =>
    `<button type="button" class="ed-av${a === choisi ? ' on' : ''}" data-edav="${esc(a)}"
             aria-label="Avatar ${esc(a)}" aria-pressed="${a === choisi}">${a}</button>`).join('');
  const p = (id, v) => { const e = $(id); if(e) e.value = v || ''; };
  p('#edPseudo', pseudo);
  p('#edBio', pp.bio);
  p('#edHome', pp.home || (state.prefs && state.prefs.from));
  p('#edUrgence', pp.urgence);
  p('#edEmail', u.email);
  const dv = $('#edDevise'); if(dv) dv.value = pp.devise || 'EUR';
  $('#ovProfil')?.classList.add('show');
}
/* Le choix d'avatar : délégué, parce que la grille est reconstruite à chaque
   ouverture. */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-edav]');
  if(!b) return;
  $$('#edAvatars .ed-av').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed','false'); });
  b.classList.add('on'); b.setAttribute('aria-pressed','true');
});
function ppEnregistre(){
  const u = getUser();
  const pp = ppLire();
  const v = id => ($(id) && $(id).value || '').trim();
  const choisi = $('#edAvatars .ed-av.on');
  pp.avatar  = choisi ? choisi.dataset.edav : (pp.avatar || PP_AVATARS[0]);
  pp.bio     = v('#edBio').slice(0, 70);
  pp.home    = v('#edHome').slice(0, 60);
  pp.urgence = v('#edUrgence').slice(0, 80);
  pp.devise  = ($('#edDevise') && $('#edDevise').value) || 'EUR';
  ppEcrire(pp);
  /* Le pseudo appartient au COMPTE, pas au passeport : il est synchronisé. */
  const np = v('#edPseudo').slice(0, 20);
  if(u && np && np !== (u.pseudo || '')){ u.pseudo = np; setUser(u); }
  /* La ville de départ nourrit aussi les valeurs par défaut du questionnaire —
     la saisir deux fois serait absurde. */
  if(pp.home){ const sh = $('#stHome'); if(sh && !sh.value) sh.value = pp.home; }
  $('#ovProfil')?.classList.remove('show');
  renderProfile();
  try{ majNavTools(); }catch(e){}
  toast('✔ Passeport mis à jour');
}

/* ⚠️ Les icônes du profil sont posées ICI, une fois, à partir de ICO_D.
   `data-ico` marque l'emplacement dans index.html : le HTML dit OÙ, le JS dit
   QUOI. Écrire les tracés SVG dans le HTML en aurait fait un second jeu
   d'icônes à tenir d'accord avec le premier. */
const PF_ICO_ONGLETS = { passeport:'passeport', ia:'boussole', look:'image', outils:'document' };
function pfIcones(){
  $$('.pf-tab').forEach(b => {
    const k = PF_ICO_ONGLETS[b.dataset.pftab];
    if(k && !b.querySelector('svg')) b.insertAdjacentHTML('afterbegin', ICO(k, 17));
  });
  $$('#catProfile [data-ico]').forEach(e => {
    const k = e.dataset.ico;
    if(k && !e.querySelector('svg')) e.insertAdjacentHTML('afterbegin', ICO(k, e.classList.contains('emo') ? 20 : 17));
  });
}

/* ---- Les quatre onglets ---- */
const PF_PANNEAUX = { passeport:'#pfPanPasseport', ia:'#pfPanIa', look:'#pfPanLook', outils:'#pfPanOutils' };
function pfOnglet(id){
  if(!PF_PANNEAUX[id]) id = 'passeport';
  $$('.pf-tab').forEach(b => {
    const on = b.dataset.pftab === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  Object.entries(PF_PANNEAUX).forEach(([k, sel]) => $(sel)?.classList.toggle('hidden', k !== id));
  pfTabsOmbre();
}
/* Même indice de défilement que la rangée « Ton voyage » — deux barres qui se
   ressemblent doivent se comporter pareil. */
function pfTabsOmbre(){
  const box = $('#pfTabs'), wrap = box && box.parentElement;
  if(!box || !wrap) return;
  const reste = box.scrollWidth - box.clientWidth, x = box.scrollLeft;
  wrap.classList.toggle('a-gauche', x > 2);
  wrap.classList.toggle('a-droite', reste > 2 && x < reste - 2);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-pftab]');
  if(b) pfOnglet(b.dataset.pftab);
});
document.addEventListener('scroll', e => {
  if(e.target && e.target.id === 'pfTabs') pfTabsOmbre();
}, true);
window.addEventListener('resize', () => { try{ pfTabsOmbre(); }catch(e){} });

{
  const e = $('#pfEdit');   if(e){ e.onclick = ppOuvreEdition; e.innerHTML = ICO('crayon', 16) + '<span>Modifier</span>'; }
  const a = $('#pfAvatar'); if(a) a.onclick = ppOuvreEdition;
  const s = $('#edSave');   if(s) s.onclick = ppEnregistre;
  const d = $('#pfDelete'); if(d) d.innerHTML = ICO('poubelle', 16) + '<span>Supprimer définitivement mon compte</span>';
  pfIcones();
}
const _e25 = $('#pfExport'); if(_e25) _e25.onclick = () => $('#btnExport').click();

/* ============================================================
   METTRE LE VOYAGE DANS SON AGENDA  (fichier .ics)
   ------------------------------------------------------------
   Une journée = un événement d'une journée entière, avec les lieux et le
   programme horaire en description. Le format iCalendar est du texte : rien à
   installer, rien à payer, et TOUS les agendas le lisent — Google, Apple,
   Outlook, Thunderbird.

   ⚠️ Trois pièges du format, et ils font échouer l'import en silence :
   1. Les fins de ligne sont des CRLF (\r\n). Un simple \n et certains
      lecteurs refusent le fichier sans dire pourquoi.
   2. Les virgules, points-virgules et barres obliques inverses doivent être
      échappés DANS les valeurs, et les retours à la ligne deviennent « \n »
      littéral. Une virgule non échappée coupe le champ en deux.
   3. DTEND d'un événement « journée entière » est EXCLUSIF : pour couvrir le
      3 août, il faut DTEND=4 août. Sans ça, l'événement dure un jour de moins.
============================================================ */
function icsEsc(s){
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
/* Une ligne iCalendar ne doit pas dépasser 75 octets : au-delà, on la replie
   avec une espace en début de ligne suivante. Peu de lecteurs s'en plaignent,
   mais la norme l'exige et certains imports stricts le vérifient. */
function icsPlie(ligne){
  if(ligne.length <= 73) return ligne;
  const out = [ligne.slice(0, 73)];
  let reste = ligne.slice(73);
  while(reste.length > 72){ out.push(' ' + reste.slice(0, 72)); reste = reste.slice(72); }
  if(reste) out.push(' ' + reste);
  return out.join('\r\n');
}
const icsJour = (d) => d.getFullYear()
  + String(d.getMonth() + 1).padStart(2, '0')
  + String(d.getDate()).padStart(2, '0');

function icsVoyage(){
  const t = state.trip;
  if(!t) return null;
  const dts = stayDates();
  if(!dts) return null;
  const debut = new Date(dts.in + 'T00:00:00');
  if(isNaN(debut)) return null;
  const prog = state.cache.plan?.programme || [];
  const horod = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dom = location.hostname || 'acolyte';

  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Acolyte//Voyage//FR',
             'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
             'X-WR-CALNAME:' + icsEsc((isEN() ? 'Trip — ' : 'Voyage — ') + t.nom)];

  const ev = (jour, titre, desc) => {
    const d0 = new Date(debut); d0.setDate(d0.getDate() + (jour - 1));
    const d1 = new Date(d0);   d1.setDate(d1.getDate() + 1);   /* DTEND exclusif */
    L.push('BEGIN:VEVENT');
    L.push('UID:' + jour + '-' + Math.abs(hashTxt(t.nom + jour)) + '@' + dom);
    L.push('DTSTAMP:' + horod);
    L.push('DTSTART;VALUE=DATE:' + icsJour(d0));
    L.push('DTEND;VALUE=DATE:' + icsJour(d1));
    L.push(icsPlie('SUMMARY:' + icsEsc(titre)));
    if(desc) L.push(icsPlie('DESCRIPTION:' + icsEsc(desc)));
    if(t.nom) L.push(icsPlie('LOCATION:' + icsEsc(t.nom + (t.pays ? ', ' + t.pays : ''))));
    L.push('END:VEVENT');
  };

  if(!prog.length){
    /* Pas de programme : on met au moins le séjour, ce qui reste utile */
    ev(1, (isEN() ? 'Trip to ' : 'Voyage à ') + t.nom, state.cache.plan?.conseil_cle || '');
  }else{
    prog.forEach(jr => {
      const n = +jr.jour || 1;
      const titre = `${isEN() ? 'D' : 'J'}${n} · ${jr.resume || t.nom}`;
      /* La description reprend les lieux ET le programme horaire s'il existe :
         c'est ce qu'on veut lire dans son agenda, pas un simple titre. */
      const lignes = [];
      if((jr.lieux || []).length) lignes.push('📍 ' + jr.lieux.join(' · '));
      const et = tlEtapes(n);
      if(Array.isArray(et) && et.length){
        lignes.push('');
        et.forEach(e => lignes.push(`${e.heure || ''} ${e.titre || ''}`.trim()));
      }
      if(jr.base) lignes.push('', (isEN() ? 'Based in: ' : 'Base : ') + jr.base);
      ev(n, titre, lignes.join('\n'));
    });
  }
  L.push('END:VCALENDAR');
  /* ⚠️ CRLF, pas \n — voir le piège n° 1 ci-dessus. */
  return L.join('\r\n') + '\r\n';
}
/* petite empreinte stable, pour que le même voyage garde les mêmes UID :
   sans ça, un second import créerait des doublons au lieu de mettre à jour */
function hashTxt(s){
  let h = 0;
  for(const c of String(s)) h = (h * 31 + c.codePointAt(0)) | 0;
  return h;
}
const _eIcs = $('#pfIcs'); if(_eIcs) _eIcs.onclick = () => {
  const ics = icsVoyage();
  if(!ics){ toast(isEN() ? 'Plan a trip first 😉' : 'Organise d’abord un voyage 😉'); return; }
  const nom = 'acolyte-' + String(state.trip?.nom || 'voyage')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.ics';
  const b = new Blob([ics], { type:'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = nom;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(isEN() ? '📅 Calendar file downloaded' : '📅 Fichier d’agenda téléchargé');
};
const _e26 = $('#pfNewTrip'); if(_e26) _e26.onclick = () => $('#btnReset').click();
const _e27 = $('#pfLogout'); if(_e27) _e27.onclick = async () => {
  /* on ferme la session côté serveur AVANT d'oublier le jeton, sinon elle
     resterait ouverte jusqu'à son expiration */
  await srvFetch('/auth/logout', { method:'POST', auth:true });
  clearToken();
  localStorage.removeItem(LS_AUTH);
  toast('À bientôt 👋');
  requireAuth();
};
const LS_THEME = 'acolite_theme';
const _sysDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;
/* 3 modes : auto (suit le système) · light · dark.
   On reste compatible avec l'ancien réglage stocké dans LS_THEME. */
function themeMode(){
  if(SET?.theme) return SET.theme;
  return localStorage.getItem(LS_THEME) === 'dark' ? 'dark' : 'auto';
}
/* ============================================================
   PLATEFORME — POUR QUE LA BARRE ET LES BOUTONS SOIENT « CHEZ EUX »
   ------------------------------------------------------------
   Pose data-os="ios" ou "android" sur <html>. Le CSS s'en sert pour donner à
   la barre du bas et aux boutons l'idiome du système : verre translucide et
   ressort côté Apple, pastille et onde côté Android.

   ⚠️ La portée est VOLONTAIREMENT étroite — la barre, les boutons, leurs
   animations. Rien d'autre ne dépend de cette détection : le reste du design
   est le même partout, et doit le rester.

   ⚠️ Le test de l'iPad est indispensable : depuis iPadOS 13 il se déclare
   « MacIntel », et une détection naïve le prendrait pour un ordinateur.
   ⚠️ Aucune conséquence FONCTIONNELLE ici. Si la détection se trompe, on a le
   mauvais style d'animation, jamais une fonctionnalité perdue — c'est pour ça
   qu'une détection par l'agent utilisateur est acceptable à cet endroit précis,
   alors qu'elle serait à éviter pour décider de ce qui marche ou non.
============================================================ */
(function detecteOS(){
  const ua = navigator.userAgent || '';
  const ios = /iP(hone|ad|od)/.test(ua)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  const android = !ios && /Android/.test(ua);
  if(ios) document.documentElement.dataset.os = 'ios';
  else if(android) document.documentElement.dataset.os = 'android';
})();

function applyTheme(){
  const mode = themeMode();
  const dark = mode === 'dark' || (mode === 'auto' && _sysDark());
  /* ⚠️ Le SOMBRE est désormais le thème par défaut du CSS : c'est donc le
     CLAIR qui doit être annoncé explicitement. Écrire une chaîne vide, comme
     avant, laissait le site en sombre alors que l'appareil demandait le clair. */
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const m = document.createElement('meta');
  m.name = 'theme-color';
  m.content = dark ? '#121212' : '#F5F4F0';
  document.head.appendChild(m);
}
/* le mode « Système » réagit en direct au changement de thème de l'appareil */
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if(themeMode() === 'auto') applyTheme(); });
/* Une seule bascule pour deux boutons : celui du profil et la lune de la barre
   du haut. Écrite comme fonction nommée, et non recopiée dans le second
   gestionnaire : deux copies, c'est la garantie qu'un jour l'une des deux
   oubliera saveSettings(). */
function basculeTheme(){
  const dark = document.documentElement.dataset.theme === 'dark';
  SET.theme = dark ? 'light' : 'dark';
  saveSettings(); renderSettings();
  toast(SET.theme === 'dark' ? '🌙 Vol de nuit activé' : '☀️ Retour au jour');
}
const _e28 = $('#pfTheme'); if(_e28) _e28.onclick = basculeTheme;
applyTheme();

/* Changement de mot de passe : on passe par un code envoyé à l'adresse.
   Plus sûr que l'ancien mot de passe seul — si quelqu'un s'installe sur une
   session ouverte, il ne peut pas verrouiller le compte sans accès à l'email.
   Le serveur ferme d'ailleurs toutes les autres sessions au passage. */
const _e29 = $('#pfChangePass'); if(_e29) _e29.onclick = async () => {
  const u = getUser(); if(!u) return;
  if(!confirm(`Un code va être envoyé à ${u.email} pour confirmer le changement. Continuer ?`)) return;
  const r0 = await srvFetch('/auth/forgot', { method:'POST', body:{ email:u.email } });
  if(!r0.ok) return toast('❌ ' + (r0.data.error || 'Envoi impossible'));
  toast('📬 Code envoyé — regarde tes indésirables');
  const code = (prompt('Code reçu par email (6 chiffres) :') || '').trim();
  if(!code) return;
  const np = prompt('Nouveau mot de passe (8 caractères minimum) :'); if(np === null) return;
  if(np.length < 8){ toast('❌ 8 caractères minimum'); return; }
  const r = await srvFetch('/auth/reset', { method:'POST', body:{ email:u.email, code, password:np } });
  if(!r.ok) return toast('❌ ' + (r.data.error || 'Changement impossible'));
  setToken(r.data.token);          /* l'ancienne session vient d'être fermée */
  toast('🔑 Mot de passe changé ✔');
};

/* Le changement d'adresse reposait sur le mot de passe stocké dans le
   navigateur. Les comptes vivant désormais sur le serveur, il faudra une
   route dédiée (vérifier l'ancienne adresse, puis la nouvelle). En
   attendant on le dit franchement plutôt que de laisser un bouton mort. */
const _e30 = $('#pfChangeEmail'); if(_e30) _e30.onclick = () => {
  toast('✉️ Changement d’adresse bientôt disponible');
};

const _e31 = $('#pfClearCache'); if(_e31) _e31.onclick = () => {
  if(!confirm('Vider le cache IA ? Le voyage, tes notes et tes dépenses sont conservés — seuls les contenus générés par l\'IA (plan, itinéraire, restos…) seront recalculés.')) return;
  state.cache = {}; save();
  toast('🧹 Cache IA vidé — contenus régénérés à la prochaine visite');
};

const _e32 = $('#pfMyData'); if(_e32) _e32.onclick = () => {
  const data = { compte: getUser(), voyage: state, exporte_le: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'acolite-mes-donnees.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('📄 Données téléchargées');
};

/* Suppression de compte : confirmation DANS l'app.
   (confirm()/prompt() sont bloqués dans les PWA installées : le bouton
   semblait ne rien faire — c'était ça, le bug.) */
const _e33 = $('#pfDelete'); if(_e33) _e33.onclick = () => {
  const u = getUser();
  $('#delPseudo').textContent = u?.pseudo || 'SUPPRIMER';
  $('#delConfirm').value = '';
  $('#delGo').disabled = true;
  $('#ovDel').classList.add('show');
};
document.addEventListener('input', e => {
  if(e.target.id !== 'delConfirm') return;
  const attendu = ($('#delPseudo').textContent || '').trim();
  $('#delGo').disabled = e.target.value.trim() !== attendu;
});
document.addEventListener('click', async e => {
  if(e.target.id !== 'delGo') return;
  const attendu = ($('#delPseudo').textContent || '').trim();
  if(($('#delConfirm').value || '').trim() !== attendu){ toast('❌ Pseudo incorrect'); return; }
  /* on efface d'abord le compte SUR LE SERVEUR : effacer le navigateur en
     premier ferait perdre le jeton, et les données resteraient en base */
  if(authToken()){
    const r = await srvFetch('/account', { method:'DELETE', auth:true });
    if(!r.ok){ toast('❌ ' + (r.data.error || 'Suppression impossible — réessaie')); return; }
  }
  Object.keys(localStorage)
    .filter(k => k.startsWith('acolyte_'))
    .forEach(k => localStorage.removeItem(k));
  location.reload();
});

/* --- Filet de sécurité global : une erreur JS ne meurt plus en silence --- */
let _lastErrToast = 0;
window.addEventListener('error', () => {
  const now = Date.now();
  if(now - _lastErrToast > 8000){ _lastErrToast = now; try{ toast("⚠️ Oups, un pépin technique — recharge la page si ça persiste"); }catch(e){} }
});
window.addEventListener('unhandledrejection', e => {
  const m = String(e.reason?.message||'');
  if(['NO_KEY','BAD_KEY','RATE','EMPTY','BAD_JSON','GROQ_RATE'].some(x=>m.includes(x))) return; /* déjà gérés par toast dédié */
  const now = Date.now();
  if(now - _lastErrToast > 8000){ _lastErrToast = now; try{ toast("⚠️ Une action a échoué — réessaie"); }catch(err){} }
});

/* --- Voyage <-> QR : encodage compact + import --- */
/* ============================================================
   CHARGE PARTAGEABLE (lien + QR du ticket)
   ------------------------------------------------------------
   ⚠️ La TAILLE est ici une contrainte de premier ordre, pas un détail :
   plus la charge est longue, plus le QR a de modules, et plus les carrés
   deviennent petits. Mesuré : l'ancienne version faisait 477 caractères,
   soit un QR de 87×87 modules — moins de 2 pixels par carré sur le ticket,
   donc INSCANNABLE par un téléphone.
   D'où le format court « ACO2 » : clés d'une lettre, et on ne transporte
   QUE ce qui est nécessaire pour rouvrir le voyage. Le texte libre (jusqu'à
   120 caractères à lui seul) a été retiré : il ne sert pas à l'import, et
   c'était le plus gros contributeur.
   base64url (« - » et « _ » au lieu de « + » et « / ») : pas d'échappement
   %XX dans l'URL, donc pas de caractères gaspillés.
============================================================ */
const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return atob(t + '==='.slice(0, (4 - t.length % 4) % 4));
};
function tripPayload(){
  const t = state.trip, p = state.prefs || {};
  if(!t) return null;
  /* clés courtes : n=nom, p=pays, d=drapeau, i=iata, b=budget, c=transport conseillé
     f=départ, j=durée, w=période, t=date, a=adultes, k=enfants, u=budget, r=forme */
  const o = { n:t.nom, p:t.pays };
  if(t.drapeau) o.d = t.drapeau;
  if(t.iata) o.i = t.iata;
  if(t.budget_estime) o.b = String(t.budget_estime).slice(0, 40);
  if(t.transport_conseille) o.c = t.transport_conseille;
  if(p.from) o.f = p.from;
  if(p.days) o.j = p.days;
  if(p.when) o.w = String(p.when).slice(0, 40);
  if(p.depart) o.t = p.depart;
  if(p.adults) o.a = p.adults;
  if(p.kids) o.k = p.kids;
  if(p.budget) o.u = p.budget;
  if(p.itin) o.r = p.itin;
  /* Les pays imposés ne sont PAS transmis à part : pour un itinéraire
     multi-pays, le champ « pays » du voyage les liste déjà (« Autriche,
     Slovaquie, Hongrie »). Les envoyer deux fois allongeait la charge de
     30 caractères pour rien — et chaque caractère compte ici. */
  return 'ACO2' + b64url(unescape(encodeURIComponent(JSON.stringify(o))));
}
/* L'URL que porte le QR : scannée avec l'appareil photo du téléphone, elle
   OUVRE Acolyte et importe le voyage. Un QR contenant « ACOLITE1:… » ne
   donnait qu'un texte incompréhensible dans l'appareil photo — c'était
   l'autre moitié du problème « ça ne se scanne pas ». */
function tripURL(){
  const pl = tripPayload();
  return pl ? location.origin + location.pathname + '#v=' + pl : null;
}
function importPayload(str){
  const s = String(str);
  let json;
  if(s.startsWith('ACO2')){
    json = decodeURIComponent(escape(unb64url(s.slice(4))));
  }else if(s.startsWith('ACOLITE1:')){
    /* ancien format : les tickets et liens déjà partagés doivent continuer
       de fonctionner, on ne casse pas ce qui circule */
    json = decodeURIComponent(escape(atob(s.slice(9))));
  }else throw new Error('format');
  const brut = JSON.parse(json);
  /* on ramène le format court vers la forme attendue par le reste du code */
  const o = brut.trip ? brut : {
    trip:  { nom:brut.n, pays:brut.p, drapeau:brut.d, iata:brut.i,
             budget_estime:brut.b, transport_conseille:brut.c },
    prefs: { from:brut.f, days:brut.j, when:brut.w, depart:brut.t,
             adults:brut.a, kids:brut.k, budget:brut.u, itin:brut.r,
             /* on reconstitue la liste depuis le champ « pays » du voyage,
                seul endroit où elle est transportée */
             pays: brut.r === 'pays'
               ? String(brut.p || '').split(/\s*[,;/]\s*/).filter(Boolean).slice(0, 6)
               : [] }
  };
  if(!o.trip?.nom) throw new Error('vide');
  /* voyage et préférences viennent d'un QR ou d'un lien : on les assainit
     avant de les faire entrer dans l'état (mêmes raisons que restoreTrip) */
  const trip = safeJSON(o.trip);
  const prefs = o.prefs && typeof o.prefs === 'object' ? safeJSON(o.prefs) : null;
  if(!trip?.nom) throw new Error('vide');
  if(!confirm(`Importer le voyage "${String(trip.nom).slice(0, 80)}, ${String(trip.pays || '').slice(0, 80)}" ?\nTon voyage en cours sera remplacé (ton compte est conservé).`)) return false;
  state.trip = trip;
  state.prefs = { ...(state.prefs||{}), ...(prefs||{}) };
  state.destinations = [trip];
  state.cache = {}; state.checklist = {}; state.maison = {}; state.spends = []; state.notes = ''; state.resas = [];
  state.planAnswers = []; state._qsDone = false; state.modeManual = false;
  _pcPhotos = null;   /* photos de carte postale liées au voyage précédent */
  state.board = { votes:{}, comments:{} };   /* votes/commentaires liés à l'ancien voyage */
  save(); unlockSteps();
  switchCat('trip');
  gotoStep(3);
  toast(`🎫 Voyage importé : cap sur ${trip.nom} !`);
  return true;
}

/* --- Chargeurs de libs QR (cdnjs, à la demande, jamais bloquant) --- */
const _lib = {};
/* ⚠️ EMPREINTE OBLIGATOIRE (SRI). Ces deux fichiers viennent de serveurs qu'on
   ne contrôle pas et s'exécutent avec TOUS les droits de la page — dont l'accès
   au jeton de session dans localStorage. La CSP les autorise par leur domaine,
   ce qui ne dit rien de leur CONTENU : si cdnjs servait un jour un fichier
   modifié, il tournerait ici sans que rien ne le signale.
   L'empreinte règle exactement ça : le navigateur calcule le hachage du fichier
   reçu et refuse de l'exécuter s'il ne correspond pas. Les deux versions sont
   figées (qrcodejs 1.0.0, jsqr 1.4.0), leur contenu ne peut donc pas changer
   légitimement.
   ⚠️ crossOrigin='anonymous' est INDISPENSABLE : sans requête CORS, le
   navigateur ne peut pas lire le corps pour le vérifier, et il bloque le script
   au lieu de l'accepter. Si tu changes une adresse, recalcule l'empreinte —
   sinon la fonctionnalité cesse simplement de marcher.
     openssl dgst -sha384 -binary fichier.js | openssl base64 -A          */
const LIB_SRI = {
  qrgen:  'sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU',
  qrread: 'sha384-hStSInNIZ8ljtOVrmrgf7zdHMapaLBWoSnPTtF0nzsybp4+LuhDz6sHuEVpWIX8o'
};
function loadLib(name, src, test){
  if(_lib[name]) return _lib[name];
  _lib[name] = new Promise((res, rej) => {
    if(test()) return res();
    const sc = document.createElement('script');
    const to = setTimeout(() => { _lib[name] = null; rej(new Error(name)); }, 8000);
    if(LIB_SRI[name]){
      sc.integrity = LIB_SRI[name];
      sc.crossOrigin = 'anonymous';
    }
    /* L'adresse de la page ne part pas chez le CDN avec la requête. */
    sc.referrerPolicy = 'no-referrer';
    sc.src = src;
    sc.onload = () => { clearTimeout(to); test() ? res() : rej(new Error(name)); };
    sc.onerror = () => { clearTimeout(to); _lib[name] = null; rej(new Error(name)); };
    document.head.appendChild(sc);
  });
  return _lib[name];
}
const loadQRGen  = () => loadLib('qrgen', 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js', () => !!window.QRCode);
/* ⚠️ jsQR n'est PAS hébergé par cdnjs : l'ancienne adresse répondait 404, et
   le scanner de tickets était donc silencieusement inutilisable. jsDelivr le
   sert bien — vérifié. Si tu changes cette adresse, teste le scanner. */
const loadQRRead = () => loadLib('qrread', 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js', () => !!window.jsQR);

/* --- Scanner : caméra ou photo -> import du voyage --- */
let _scanStream = null, _scanRun = false;
async function openScan(){
  $('#ovScan').classList.add('show');
  $('#scanMsg').textContent = '';
  try{ await loadQRRead(); }catch(e){ $('#scanMsg').textContent = '⚠️ Lecteur QR indisponible hors-ligne — réessaie connecté.'; return; }
  try{
    _scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'environment' } });
    const v = $('#scanVideo');
    v.srcObject = _scanStream; await v.play();
    _scanRun = true;
    const cv = document.createElement('canvas'), g = cv.getContext('2d');
    (function tick(){
      if(!_scanRun) return;
      if(v.videoWidth && g){
        cv.width = v.videoWidth; cv.height = v.videoHeight;
        g.drawImage(v, 0, 0);
        const img = g.getImageData(0, 0, cv.width, cv.height);
        const q = window.jsQR(img.data, img.width, img.height);
        if(q && q.data.startsWith('ACOLITE1:')){
          closeScan();
          try{ importPayload(q.data); }catch(e){ toast('❌ QR illisible'); }
          return;
        }
      }
      requestAnimationFrame(tick);
    })();
  }catch(e){
    $('#scanMsg').textContent = '📷 Caméra indisponible ou refusée — choisis plutôt une photo du ticket ci-dessous.';
  }
}
function closeScan(){
  _scanRun = false;
  if(_scanStream){ _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }
  $('#ovScan').classList.remove('show');
}
const _cscanFile = $('#scanFile'); if(_cscanFile) _cscanFile.onchange = async e => {
  const f = e.target.files[0]; if(!f) return;
  try{ await loadQRRead(); }catch(err){ $('#scanMsg').textContent = '⚠️ Lecteur QR indisponible hors-ligne.'; return; }
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d');
    if(!g){ $('#scanMsg').textContent = '❌ Lecture impossible.'; return; }
    g.drawImage(img, 0, 0);
    const q = window.jsQR(g.getImageData(0,0,cv.width,cv.height).data, cv.width, cv.height);
    if(q && q.data.startsWith('ACOLITE1:')){ closeScan(); try{ importPayload(q.data); }catch(er){ toast('❌ QR illisible'); } }
    else $('#scanMsg').textContent = '❌ Aucun QR Acolyte détecté sur cette photo.';
  };
  img.src = URL.createObjectURL(f);
};
document.addEventListener('click', e => {
  if(e.target.id === 'btnScanTicket' || e.target.id === 'pfScan'){ openScan(); return; }
  if(e.target.closest('[data-closescan]')) closeScan();
});

/* --- Partage par lien : #v=payload → import direct à l'ouverture --- */
async function shareLink(){
  const pl = tripPayload();
  if(!pl){ toast('Choisis d’abord un voyage'); return; }
  const url = tripURL();      /* base64url : rien à échapper */
  const txt = `Mon voyage à ${state.trip.nom} sur Acolyte ✈️`;
  try{
    if(navigator.share){ await navigator.share({ title:'Acolyte', text:txt, url }); return; }
    await navigator.clipboard.writeText(url);
    toast('🔗 Lien copié — envoie-le à tes amis');
  }catch(e){
    if(e.name !== 'AbortError') prompt('Copie ce lien :', url);
  }
}
document.addEventListener('click', e => { if(e.target.closest('[data-sharelink]')) shareLink(); });

/* import automatique si l'app est ouverte avec #v=… */
function checkImportHash(){
  const m = location.hash.match(/[#&]v=([^&]+)/);
  if(!m) return;
  history.replaceState(null, '', location.pathname);
  try{ importPayload(decodeURIComponent(m[1])); }
  catch(e){ toast('❌ Lien de voyage invalide'); }
}
/* Le lien peut arriver alors qu'Acolyte est DÉJÀ ouvert : dans ce cas le
   navigateur change juste l'ancre, sans recharger la page — et rien ne se
   passait. C'est le cas courant quand on scanne un QR depuis son téléphone
   avec l'app déjà dans un onglet. */
addEventListener('hashchange', checkImportHash);

/* --- Export .ics : le programme dans ton agenda (Google/Apple/Outlook) --- */
function exportICS(){
  const t = state.trip, plan = state.cache.plan, d = stayDates();
  if(!t || !plan?.programme?.length || !d){ toast('Il faut un voyage avec une date de départ'); return; }
  const pad = n => String(n).padStart(2, '0');
  const fmt = dt => `${dt.getUTCFullYear()}${pad(dt.getUTCMonth()+1)}${pad(dt.getUTCDate())}`;
  const start = new Date(d.in + 'T00:00:00Z');
  const ev = (i, j) => {
    const day = new Date(start.getTime() + i * 86400000);
    const end = new Date(day.getTime() + 86400000);
    const lieux = (j.lieux||[]).join(', ');
    return ['BEGIN:VEVENT',
      `UID:acolyte-${Date.now()}-${i}@acolyte`,
      `DTSTAMP:${fmt(new Date())}T000000Z`,
      `DTSTART;VALUE=DATE:${fmt(day)}`,
      `DTEND;VALUE=DATE:${fmt(end)}`,
      `SUMMARY:J${j.jour} ${t.drapeau||''} ${String(j.resume||'').replace(/[,;\\]/g, ' ').slice(0,70)}`,
      lieux ? `DESCRIPTION:${lieux.replace(/[,;\\]/g, ' ').slice(0,180)}` : '',
      `LOCATION:${String(t.nom).replace(/[,;\\]/g,' ')}`,
      'END:VEVENT'].filter(Boolean).join('\r\n');
  };
  const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Acolyte//FR','CALSCALE:GREGORIAN',
    ...plan.programme.map((j, i) => ev(i, j)), 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type:'text/calendar' }));
  a.download = `acolyte-${String(t.nom).toLowerCase().replace(/[^a-z0-9]+/g,'-')}.ics`;
  a.click(); URL.revokeObjectURL(a.href);
  toast('📅 Programme exporté — ouvre-le pour l’ajouter à ton agenda');
}
document.addEventListener('click', e => { if(e.target.closest('[data-ics]')) exportICS(); });

/* --- Boarding pass → image PNG partageable (canvas maison) --- */
async function passPNG(){
  const t = state.trip, p = state.prefs || {};
  if(!t){ toast('Choisis d’abord un voyage'); return; }
  const W = 1200, H = 560, M = 30;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  if(!g){ toast('Canvas indisponible'); return; }
  const K = '#101010', Y = '#FFE600', WH = '#FFFFFF', P = '#F4F3EF';
  const plan = state.cache.plan || {}, d = stayDates(), u = getUser();
  const CW = W - M * 2, CH = H - M * 2 - 12;        /* carte */
  const STUB = 300;                                  /* largeur du talon */
  /* la police du site, si elle est déjà chargée sur la page */
  try{ await document.fonts.load('900 76px Fraunces'); await document.fonts.load('800 15px Fraunces'); }catch(e){}
  const fit = (txt, size, max, weight = '700', fam = 'Inter, Arial') => {
    let px = size;
    do { g.font = `${weight} ${px}px ${fam}`; px -= 1; } while(g.measureText(txt).width > max && px > 9);
    return g.font;
  };
  /* fond papier + trame de points (comme le site) */
  g.fillStyle = P; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.10)';
  for(let dy = 8; dy < H; dy += 22) for(let dx = 8; dx < W; dx += 22){ g.beginPath(); g.arc(dx, dy, 1.6, 0, 7); g.fill(); }
  /* ombre dure sur le bas et la droite — SANS trou dans les coins (bas-gauche / haut-droit) */
  const SH = 12, ov = 4;                     /* ov : couvre le débord du trait de bord (7px) */
  g.fillStyle = K;
  g.fillRect(M - ov, M + CH, CW + SH + ov, SH);   /* bande basse : part du coin bas-gauche */
  g.fillRect(M + CW, M - ov, SH, CH + SH + ov);   /* bande droite : part du coin haut-droit */
  g.fillStyle = Y; g.fillRect(M, M, CW - STUB, CH);
  g.fillStyle = WH; g.fillRect(M + CW - STUB, M, STUB, CH);

  /* ---- CORPS ---- */
  /* logo : carré noir + A jaune, comme l'écran de démarrage */
  g.fillStyle = K; g.fillRect(M + 34, M + 26, 46, 46);
  g.fillStyle = Y; g.textAlign = 'center';
  g.font = '900 30px Fraunces, Georgia';
  g.fillText('A', M + 57, M + 60);
  g.textAlign = 'left';
  g.fillStyle = K;
  g.font = '900 26px Fraunces, Georgia';
  g.fillText('ACOLYTE · BOARDING PASS', M + 96, M + 58);
  g.fillRect(M + 96, M + 68, 372, 5);
  /* route : départ à gauche, arrivée alignée à droite, avion au centre */
  const from = (p.from || 'PAR').slice(0, 3).toUpperCase();
  const to = (t.iata || t.nom.slice(0, 3)).toUpperCase();
  const bodyR = M + CW - STUB - 34;                  /* bord droit interne du corps */
  g.font = '900 76px Fraunces, Georgia';
  /* espacement entre lettres : sinon le Y colle au O et le code devient illisible */
  const LS = 9;
  const spacedW = s => { let w = 0; for(const ch of s) w += g.measureText(ch).width + LS; return Math.max(0, w - LS); };
  const drawSpaced = (s, x, y) => { let cx = x; for(const ch of s){ g.fillText(ch, cx, y); cx += g.measureText(ch).width + LS; } };
  const wFrom = spacedW(from);
  const wTo = spacedW(to);
  drawSpaced(from, M + 34, M + 168);
  drawSpaced(to, bodyR - wTo, M + 168);
  g.setLineDash([13, 9]); g.lineWidth = 5;
  g.beginPath(); g.moveTo(M + 52 + wFrom, M + 142); g.lineTo(bodyR - wTo - 18, M + 142); g.stroke();
  g.setLineDash([]);
  const midX = (M + 52 + wFrom + bodyR - wTo - 18) / 2;
  g.fillStyle = Y; g.beginPath(); g.arc(midX, M + 140, 30, 0, 7); g.fill();
  g.strokeStyle = K; g.lineWidth = 4; g.stroke();
  g.fillStyle = K; g.textAlign = 'center';
  g.font = '900 32px Arial';
  g.fillText('✈', midX, M + 152);
  g.textAlign = 'left';
  /* graine déterministe → siège/porte/vol stables pour un même voyage (déco souvenir) */
  const seed = [...(from + to + (d ? d.in : '') + (t.nom || ''))].reduce((a, ch) => a + ch.charCodeAt(0), 7);
  const seat = `${1 + seed % 42}${'ABCDEF'[seed % 6]}`;
  const gate = `${'ABCDE'[seed % 5]}${1 + seed % 45}`;
  const flight = `ACO ${1000 + seed % 8999}`;
  /* infos : 9 cases sur 3 rangées, étiquette au-dessus de la valeur */
  const cells = [
    ['PASSAGER', (u?.pseudo || 'Voyageur').toUpperCase()],
    ['DESTINATION', `${t.nom}`.toUpperCase() + (t.drapeau ? ' ' + t.drapeau : '')],
    ['DATES', d ? `${d.in.split('-').reverse().slice(0,2).join('/')} → ${d.out.split('-').reverse().slice(0,2).join('/')}` : (p.when || 'FLEXIBLES').toUpperCase()],
    ['VOYAGEURS', `${p.adults || 2} ADULTE(S)${p.kids ? ` + ${p.kids} ENFANT(S)` : ''}`],
    ['SÉJOUR', [plan.transport?.mode, plan.logement ? String(plan.logement.type || '').split(/[( ]|ou /)[0].trim() : '', plan.logement?.quartier].filter(Boolean).join(' · ').toUpperCase() || (p.days || '—').toUpperCase()],
    ['BUDGET', plan.budget?.total ? `${plan.budget.total} € / PERS.` : (t.budget_estime || '—').toUpperCase()],
    ['SIÈGE', seat],
    ['PORTE', gate],
    ['VOL', flight]
  ];
  const colW = 258;
  cells.forEach((c, i) => {
    const x = M + 34 + (i % 3) * colW;
    const y = M + 232 + Math.floor(i / 3) * 74;
    g.fillStyle = 'rgba(16,16,16,0.62)';
    g.font = '800 14px Fraunces, Georgia';
    g.fillText(c[0], x, y);
    g.fillStyle = K;
    g.font = fit(c[1], 25, colW - 24, '800');
    /* si même à la taille mini le texte déborde (nom de destination très long) → coupe avec … */
    let val = c[1];
    if(g.measureText(val).width > colW - 24){
      while(val.length > 1 && g.measureText(val + '…').width > colW - 24) val = val.slice(0, -1);
      val = val.replace(/\s+$/, '') + '…';
    }
    g.fillText(val, x, y + 30);
  });
  /* bandeau noir de mentions, en bas du corps */
  g.fillStyle = K;
  g.fillRect(M, M + CH - 58, CW - STUB, 58);
  g.fillStyle = Y;
  g.font = '800 13px Inter, Arial';
  g.fillText("TICKET SOUVENIR — NE PERMET PAS D'EMBARQUER NI DE VOYAGER.", M + 34, M + CH - 34);
  g.fillStyle = WH;
  g.font = '600 13px Inter, Arial';
  g.fillText("Le QR sert uniquement à importer ce voyage dans l'application Acolyte.", M + 34, M + CH - 14);

  /* bord du ticket */
  g.strokeStyle = K; g.lineWidth = 7; g.strokeRect(M, M, CW, CH);
  const px0 = M + CW - STUB;
  /* ligne de déchirure (perforation) entre corps et talon : pointillés nets, pleine hauteur.
     Pointillés BLANCS sur la partie basse (bande noire des mentions) pour rester visibles. */
  g.lineCap = 'round';
  g.setLineDash([4, 12]); g.lineWidth = 6;
  const bandTop = M + CH - 58;
  g.strokeStyle = K; g.beginPath(); g.moveTo(px0, M + 12); g.lineTo(px0, bandTop); g.stroke();
  g.strokeStyle = WH; g.beginPath(); g.moveTo(px0, bandTop); g.lineTo(px0, M + CH - 12); g.stroke();
  g.setLineDash([]); g.lineCap = 'butt';

  /* ---- TALON : QR encadré avec ombre dure ---- */
  const sx = px0 + STUB / 2;
  let qrOK = false;
  try{
    await loadQRGen();
    const tmp = document.createElement('div');
    /* On encode une URL, pas un texte maison : ainsi l'appareil photo du
       téléphone propose d'ouvrir Acolyte, qui importe le voyage tout seul.
       On génère GRAND (600 px) puis on réduit à l'affichage : les carrés
       restent nets, alors qu'un QR généré petit puis agrandi devient flou. */
    new QRCode(tmp, { text: tripURL(), width: 600, height: 600, correctLevel: QRCode.CorrectLevel.M });
    await new Promise(r => setTimeout(r, 120));
    const q = tmp.querySelector('canvas') || tmp.querySelector('img');
    if(q){
      /* QR agrandi de 170 à 230 px : à densité égale, chaque carré gagne
         un tiers de sa taille — c'est ce qui fait la différence entre « ça
         ne scanne pas » et « ça scanne du premier coup ». */
      const QS = 230, QB = QS + 20;
      const qx = sx - QB / 2, qy = M + 52;
      g.fillStyle = K; g.fillRect(qx + 7, qy + 7, QB, QB);              /* ombre dure */
      g.fillStyle = WH; g.fillRect(qx, qy, QB, QB);
      g.strokeStyle = K; g.lineWidth = 4; g.strokeRect(qx, qy, QB, QB);
      /* la marge blanche autour du QR (« quiet zone ») fait partie du code :
         sans elle, un lecteur ne trouve pas les bords. Elle est ici assurée
         par le cadre blanc, plus large que le QR. */
      g.imageSmoothingEnabled = false;
      g.drawImage(q, sx - QS / 2, qy + 10, QS, QS);
      g.imageSmoothingEnabled = true;
      qrOK = true;
    }
  }catch(e){}
  g.fillStyle = K;
  g.textAlign = 'center';
  if(!qrOK){
    g.font = '900 17px Fraunces, Georgia';
    g.fillText('QR INDISPONIBLE', sx, M + 150);
    g.font = '600 12px Inter, Arial';
    g.fillText('hors-ligne — regénère le ticket', sx, M + 172);
  }
  g.font = '900 16px Fraunces, Georgia';
  /* le texte reflète le nouveau comportement : n'importe quel téléphone suffit */
  g.fillText('SCANNE-MOI', sx, M + 306);
  g.font = '600 12px Inter, Arial';
  g.fillText('avec l\'appareil photo de ton', sx, M + 326);
  g.fillText('téléphone pour ouvrir ce voyage', sx, M + 344);
  /* séparateur pointillé + route + numéro de ticket */
  g.setLineDash([10, 8]); g.lineWidth = 3;
  g.beginPath(); g.moveTo(sx - 105, M + 358); g.lineTo(sx + 105, M + 358); g.stroke();
  g.setLineDash([]);
  g.font = fit(`${from} ✈ ${to}`, 30, STUB - 60, '900', 'Fraunces, Georgia, serif');
  g.fillText(`${from} ✈ ${to}`, sx, M + 402);
  g.font = '800 13px Inter, Arial';
  g.fillStyle = 'rgba(16,16,16,0.62)';
  g.fillText(`N° ACO-${from}${to}-${new Date().getFullYear()}`, sx, M + 424);
  /* faux code-barres (déco souvenir, non scannable) */
  const bcW = STUB - 96, bcX = sx - bcW / 2, bcY = M + 444, bcH = 30;
  g.fillStyle = K; let bx = bcX, si = seed || 7;
  while(bx < bcX + bcW - 1){
    si = (si * 16807) % 2147483647; const w = 1 + (si % 5);
    if(bx + w > bcX + bcW) break;
    g.fillRect(bx, bcY, w, bcH); bx += w;
    si = (si * 16807) % 2147483647; bx += 1 + (si % 4);
  }
  g.textAlign = 'left';

  cv.toBlob(async b => {
    const name = `acolyte-${t.nom.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    const file = typeof File !== 'undefined' ? new File([b], name, { type: 'image/png' }) : null;
    if(file && navigator.canShare?.({ files: [file] })){
      try{
        await navigator.share({ files: [file], title: 'Mon ticket Acolyte', text: `Mon voyage à ${t.nom} ✈️` });
        toast('📤 Ticket partagé — le QR s’ouvre avec l’appareil photo');
        return;
      }catch(e){ if(e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('📷 Ticket téléchargé — le QR s’ouvre avec l’appareil photo');
  }, 'image/png');
}
document.addEventListener('click', e => { if(e.target.closest('[data-passpng]')) passPNG(); });

/* ============================================================
   CARTE POSTALE — choix du style + mise en page des photos
   Photos : Wikipédia si dispo, sinon vignette illustrée. Export canvas.
============================================================ */
const PC_STYLES  = [
  {id:'pop', nom:'Pop'}, {id:'polaroid', nom:'Polaroïd'}, {id:'retro', nom:'Rétro'},
  {id:'noir', nom:'Cinéma'}, {id:'azur', nom:'Bord de mer'}, {id:'kraft', nom:'Kraft'}
];
const PC_LAYOUTS = [{id:'grande', nom:'Une grande'}, {id:'duo', nom:'Deux'}, {id:'collage', nom:'Collage'}];
let _pcStyle = 'pop', _pcLayout = 'grande', _pcPhotos = null, _pcTemplate = 'classique';

async function fetchWikiThumb(name){
  try{
    const r = await fetchT(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`, {}, 8000);
    if(!r.ok) return null;
    const d = await r.json();
    const src = d.thumbnail?.source || d.originalimage?.source || null;
    if(!src) return null;
    /* évite drapeaux / blasons / armoiries (souvent renvoyés pour une ville) — pas des photos de voyage */
    if(/flag|drapeau|bandeira|bandera|coat|_coa|\bcoa\b|arms|escudo|escut|wappen|wapen|blason|bras[aã]o|stemma|armoiries|gonfalone|seal|crest|emblem|logo|\.svg/i.test(src)) return null;
    return src.replace(/\/\d+px-/, '/640px-');
  }catch(e){ return null; }
}
function pcLoadImg(url){
  return new Promise(res => {
    if(!url) return res(null);
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = url;
  });
}
function pcChips(){
  const tp = $('#pcTemplates'), st = $('#pcStyles'), ly = $('#pcLayouts');
  if(tp) tp.innerHTML = PC_TEMPLATES.map(m => `<div class="pc-chip ${m.id===_pcTemplate?'on':''}" data-pctpl="${m.id}">${m.nom}</div>`).join('');
  if(st) st.innerHTML = PC_STYLES.map(s => `<div class="pc-chip ${s.id===_pcStyle?'on':''}" data-pcstyle="${s.id}">${s.nom}</div>`).join('');
  if(ly) ly.innerHTML = PC_LAYOUTS.map(l => `<div class="pc-chip ${l.id===_pcLayout?'on':''}" data-pclayout="${l.id}">${l.nom}</div>`).join('');
  /* le modèle « Dos de carte » n'utilise qu'une vignette → la disposition n'a pas d'effet */
  const lyGroup = $('#pcLayoutGroup');
  if(lyGroup) lyGroup.style.display = _pcTemplate === 'dos' ? 'none' : '';
}
async function openPostcard(){
  const t = state.trip; if(!t) return;
  $('#ovPostcard').classList.add('show');
  pcChips();
  if($('#pcLoading')) $('#pcLoading').style.display = '';
  if($('#pcImg')) $('#pcImg').removeAttribute('src');
  if(!_pcPhotos){
    /* on privilégie les LIEUX (photos de monuments) puis la ville, puis le pays */
    const places = [...((state.cache.plan?.programme || []).flatMap(j => j.lieux || [])), t.nom, t.pays].filter(Boolean);
    const uniq = [...new Set(places)].slice(0, 4);
    const imgs = await Promise.all(uniq.map(async n => pcLoadImg(await fetchWikiThumb(n))));
    _pcPhotos = uniq.map((cap, i) => ({ cap, img: imgs[i] }));
  }
  renderPostcard();
}
function pcCover(g, img, x, y, w, h){
  const ir = img.width / img.height, rr = w / h;
  let sw, sh, sx, sy;
  if(ir > rr){ sh = img.height; sw = sh * rr; sx = (img.width - sw) / 2; sy = 0; }
  else { sw = img.width; sh = sw / rr; sx = 0; sy = (img.height - sh) / 2; }
  g.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}
/* Photo BIEN CADRÉE : l'image entière est visible (jamais rognée),
   posée sur une version floutée d'elle-même qui remplit le cadre. */
function pcPhoto(g, img, x, y, w, h){
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  try{ g.filter = 'blur(18px) brightness(.6)'; }catch(e){}
  pcCover(g, img, x - 24, y - 24, w + 48, h + 48);   /* fond flou débordant */
  try{ g.filter = 'none'; }catch(e){}
  const ir = img.width / img.height, rr = w / h;
  let dw, dh;
  if(ir > rr){ dw = w; dh = w / ir; } else { dh = h; dw = h * ir; }
  g.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);  /* image entière, centrée */
  g.restore();
}
/* Emplacement vide : juste une icône + le mot PHOTO (l'utilisateur y mettra sa photo). */
function pcTile(g, x, y, w, h){
  g.fillStyle = '#E7E2D6'; g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 2; g.setLineDash([9, 7]);
  g.strokeRect(x + 9, y + 9, w - 18, h - 18); g.setLineDash([]);
  const cx = x + w / 2, cy = y + h / 2, u = Math.min(w, h);
  g.fillStyle = 'rgba(0,0,0,.4)'; g.textAlign = 'center';
  g.font = `${Math.round(u * 0.24)}px Arial`;
  g.fillText('📷', cx, cy + u * 0.02);
  g.font = `900 ${Math.max(12, Math.round(u * 0.11))}px Fraunces, Georgia`;
  g.fillText('PHOTO', cx, cy + u * 0.28);
  g.textAlign = 'left';
}
/* cachet d'oblitération circulaire (comme sur une vraie enveloppe) */
function pcPostmark(g, cx, cy, r, txt, sub){
  g.save();
  g.globalAlpha = .55; g.strokeStyle = '#2b2b2b'; g.lineWidth = 3;
  g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke();
  g.beginPath(); g.arc(cx, cy, r - 7, 0, 7); g.stroke();
  g.textAlign = 'center'; g.fillStyle = '#2b2b2b';
  g.font = `900 ${Math.round(r * 0.30)}px Fraunces, Georgia`;
  g.fillText(String(txt || '').slice(0, 9).toUpperCase(), cx, cy - 1);
  g.font = `700 ${Math.round(r * 0.21)}px Inter, Arial`;
  g.fillText(String(sub || '').slice(0, 12), cx, cy + r * 0.34);
  /* petites barres d'oblitération */
  g.lineWidth = 2;
  for(let i = -2; i <= 2; i++){ g.beginPath(); g.moveTo(cx + r + 6, cy + i * 7); g.lineTo(cx + r + 40, cy + i * 7); g.stroke(); }
  g.restore(); g.textAlign = 'left';
}
/* faux timbre postal */
function pcStamp(g, x, y){
  const w = 84, h = 100;
  g.fillStyle = '#FFFDF3'; g.fillRect(x, y, w, h);
  g.strokeStyle = '#2b2b2b'; g.lineWidth = 2; g.setLineDash([4, 4]);
  g.strokeRect(x + 5, y + 5, w - 10, h - 10); g.setLineDash([]);
  g.textAlign = 'center';
  g.fillStyle = '#C0392B'; g.font = '34px Arial'; g.fillText('✈', x + w / 2, y + h / 2 + 8);
  g.fillStyle = '#2b2b2b'; g.font = '900 10px Fraunces, Georgia'; g.fillText('PAR AVION', x + w / 2, y + h - 14);
  g.textAlign = 'left';
}
/* La disposition dépend UNIQUEMENT du choix de l'utilisateur : les emplacements
   en trop affichent un pavé « PHOTO » (avant, 1 seule photo forçait la grande image). */
function pcLayoutRects(pz, layout){
  const gp = 14, rects = [];
  if(layout === 'grande'){ rects.push([pz.x, pz.y, pz.w, pz.h]); }
  else if(layout === 'duo'){
    const w = (pz.w - gp) / 2;
    rects.push([pz.x, pz.y, w, pz.h], [pz.x + w + gp, pz.y, w, pz.h]);
  }else{ /* collage 2x2 */
    const w = (pz.w - gp) / 2, h = (pz.h - gp) / 2;
    rects.push([pz.x, pz.y, w, h], [pz.x + w + gp, pz.y, w, h], [pz.x, pz.y + h + gp, w, h], [pz.x + w + gp, pz.y + h + gp, w, h]);
  }
  return rects;
}
/* Palettes de couleurs — indépendantes du MODÈLE (qui, lui, réorganise les infos) */
const PC_PALETTES = {
  pop:      { bg:'#FFE600', ink:'#101010', band:'#101010', bandInk:'#FFE600', border:10, bandFill:true,  sub:'rgba(255,230,0,.9)',  hlt:'rgba(255,230,0,.65)', accent:'#FFE600', frame:6 },
  polaroid: { bg:'#ECECEC', ink:'#141414', band:'#FFFFFF', bandInk:'#141414', border:6,  bandFill:true,  sub:'#555',               hlt:'#8a8a8a',             accent:'#FF6B00', frame:3 },
  retro:    { bg:'#F1E7CE', ink:'#3B2E20', band:'#F1E7CE', bandInk:'#3B2E20', border:6,  bandFill:false, sub:'#6b5a44',            hlt:'#8a7a63',             accent:'#C0392B', frame:3 },
  noir:     { bg:'#14171C', ink:'#F2F2F2', band:'#14171C', bandInk:'#F5F5F5', border:4,  bandFill:false, sub:'#9AA3AD',            hlt:'#6E7681',             accent:'#E23B3B', frame:2 },
  azur:     { bg:'#DFF3F7', ink:'#0E3A46', band:'#FFFFFF', bandInk:'#0E3A46', border:7,  bandFill:true,  sub:'#3d7d8c',            hlt:'#6fa3ae',             accent:'#00A6C0', frame:4 },
  kraft:    { bg:'#C9A66B', ink:'#2E2013', band:'#C9A66B', bandInk:'#2E2013', border:7,  bandFill:false, sub:'#5b4227',            hlt:'#6f5334',             accent:'#7A4E2D', frame:4 }
};
/* MODÈLES : chacun réorganise complètement les informations et la mise en page */
const PC_TEMPLATES = [
  { id:'classique', nom:'Classique' },
  { id:'magazine',  nom:'Magazine' },
  { id:'dos',       nom:'Dos de carte' },
  { id:'pellicule', nom:'Pellicule' },
  { id:'mosaique',  nom:'Mosaïque' },
  { id:'passeport', nom:'Passeport' },
  { id:'minimal',   nom:'✦ Minimal' },
  { id:'vertical',  nom:'Portrait', w:700, h:1000 }   /* format vertical */
];

/* Infos du voyage, préparées une fois pour tous les modèles */
function pcInfo(t){
  const d = stayDates();
  return {
    nom: String(t.nom || '').toUpperCase(),
    pays: String(t.pays || '').toUpperCase(),
    dates: d ? `${d.in.split('-').reverse().slice(0,2).join('/')} – ${d.out.split('-').reverse().slice(0,2).join('/')}` : String(state.prefs?.when || 'souvenir').toUpperCase(),
    hl: (state.cache.plan?.programme || []).flatMap(j => j.lieux || []).filter(Boolean).slice(0, 4)
  };
}
/* règle la taille de police pour tenir dans `max` */
function pcFit(g, txt, max, start, weight = '900', fam = 'Fraunces, Georgia, serif'){
  let fs = start;
  do { g.font = `${weight} ${fs}px ${fam}`; fs -= 2; } while(g.measureText(txt).width > max && fs > 14);
  return Math.min(g.measureText(txt).width, max);
}
/* texte à lettres espacées (petites capitales type « eyebrow ») */
function pcTrack(g, txt, x, y, sp = 3){
  let cx = x; for(const ch of String(txt)){ g.fillText(ch, cx, y); cx += g.measureText(ch).width + sp; }
  return cx - x - sp;
}
/* dessine les photos dans des rectangles, avec le traitement propre au style */
function pcDrawPhotos(g, rects, photos, style, S, bare){
  rects.forEach((r, i) => {
    const p = photos[i] || {};
    const [x, y, w, h] = r;
    if(!bare && style === 'polaroid'){
      const fr = 12, capH = 26;
      g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(x + 5, y + 6, w, h);
      g.fillStyle = '#fff'; g.fillRect(x, y, w, h);
      g.strokeStyle = '#141414'; g.lineWidth = 3; g.strokeRect(x, y, w, h);
      const ix = x + fr, iy = y + fr, iw = w - 2 * fr, ih = h - fr - capH;
      if(p.img) pcPhoto(g, p.img, ix, iy, iw, ih); else pcTile(g, ix, iy, iw, ih);
      return;
    }
    if(!bare && style === 'pop'){ g.fillStyle = '#101010'; g.fillRect(x + 8, y + 8, w, h); }
    if(!bare && style === 'azur'){ g.fillStyle = '#fff'; g.fillRect(x - 6, y - 6, w + 12, h + 12); }
    if(p.img) pcPhoto(g, p.img, x, y, w, h); else pcTile(g, x, y, w, h);
    if(!bare){ g.strokeStyle = S.ink; g.lineWidth = S.frame; g.strokeRect(x, y, w, h); }
  });
}

/* ---- MODÈLE 1 : Classique (photos en haut, bandeau d'infos en bas) ---- */
function tplClassique(g, W, H, { S, I, style, layout, photos }){
  const pad = 30, bandH = 168;
  pcDrawPhotos(g, pcLayoutRects({ x:pad, y:pad, w:W - 2*pad, h:H - 2*pad - bandH - 8 }, layout), photos, style, S);
  const by = H - pad - bandH;
  if(S.bandFill){
    g.fillStyle = S.band; g.fillRect(pad, by, W - 2*pad, bandH);
    g.strokeStyle = S.ink; g.lineWidth = S.frame; g.strokeRect(pad, by, W - 2*pad, bandH);
  }else{
    g.strokeStyle = S.ink; g.globalAlpha = .35; g.lineWidth = 2;
    g.beginPath(); g.moveTo(pad + 4, by + 2); g.lineTo(W - pad - 4, by + 2); g.stroke(); g.globalAlpha = 1;
  }
  const tx = pad + 24;
  pcStamp(g, W - pad - 104, by + 16);
  g.textAlign = 'left';
  g.font = '800 12px Fraunces, Georgia'; g.fillStyle = S.hlt;
  pcTrack(g, 'CARNET DE VOYAGE', tx, by + 30, 3);          /* sur-titre */
  const tw = pcFit(g, I.nom, W - 2*pad - 150, 58);
  g.fillStyle = S.bandInk; g.fillText(I.nom, tx, by + 78);
  g.fillStyle = S.accent; g.fillRect(tx, by + 90, tw, 7);
  g.font = '800 22px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, by + 124);
  if(I.hl.length){ g.font = '700 17px Inter, Arial'; g.fillStyle = S.hlt; g.fillText('📍 ' + I.hl.slice(0,3).join('  ·  ').slice(0,62), tx, by + 152); }
  g.textAlign = 'right'; g.font = '900 19px Fraunces, Georgia'; g.fillStyle = S.bandInk;
  g.fillText('ACOLYTE ✈', W - pad - 20, by + bandH - 14); g.textAlign = 'left';
}

/* ---- MODÈLE 2 : Magazine (photo plein cadre, titre en surimpression) ---- */
function tplMagazine(g, W, H, { S, I, layout, photos, style }){
  pcDrawPhotos(g, pcLayoutRects({ x:0, y:0, w:W, h:H }, layout), photos, style, S, true);
  const gr = g.createLinearGradient(0, H * .38, 0, H);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(.55, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,.9)');
  g.fillStyle = gr; g.fillRect(0, H * .38, W, H * .62);
  g.fillStyle = S.accent; g.fillRect(0, 0, W, 12);            /* bandeau accent en haut */
  const tx = 48;
  g.textAlign = 'left';
  /* sur-titre façon magazine, en haut à gauche */
  g.fillStyle = 'rgba(255,255,255,.9)'; g.font = '800 13px Fraunces, Georgia';
  pcTrack(g, 'CARNET DE VOYAGE', tx, 56, 4);
  const tw = pcFit(g, I.nom, W - 210, 86);
  g.fillStyle = '#fff'; g.fillText(I.nom, tx, H - 112);
  g.fillStyle = S.accent; g.fillRect(tx, H - 96, tw, 9);
  g.font = '800 25px Inter, Arial'; g.fillStyle = 'rgba(255,255,255,.92)';
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, H - 54);
  if(I.hl.length){ g.font = '700 18px Inter, Arial'; g.fillStyle = 'rgba(255,255,255,.72)'; g.fillText('📍 ' + I.hl.slice(0,3).join('  ·  ').slice(0,64), tx, H - 22); }
  pcStamp(g, W - 132, 32);
  g.textAlign = 'right'; g.font = '900 18px Fraunces, Georgia'; g.fillStyle = 'rgba(255,255,255,.85)';
  g.fillText('ACOLYTE ✈', W - 40, H - 22); g.textAlign = 'left';
}

/* ---- MODÈLE 3 : Dos de carte (message à gauche, timbre + adresse à droite) ---- */
function tplDos(g, W, H, { S, I, photos, style }){
  const pad = 44, mid = W / 2;
  g.strokeStyle = S.ink; g.globalAlpha = .45; g.lineWidth = 3;
  g.beginPath(); g.moveTo(mid, pad); g.lineTo(mid, H - pad); g.stroke(); g.globalAlpha = 1;
  /* gauche : vignette photo + « message » */
  const lx = pad + 12, tw2 = 200, th = 148, p0 = photos[0] || {};
  g.fillStyle = '#fff'; g.fillRect(lx - 7, pad + 4, tw2 + 14, th + 14);
  g.strokeStyle = S.ink; g.lineWidth = 3; g.strokeRect(lx - 7, pad + 4, tw2 + 14, th + 14);
  if(p0.img) pcPhoto(g, p0.img, lx, pad + 11, tw2, th); else pcTile(g, lx, pad + 11, tw2, th);
  let my = pad + th + 82;
  g.textAlign = 'left';
  const lw = mid - pad - 60;
  const tw3 = pcFit(g, I.nom, lw, 46);
  g.fillStyle = S.ink; g.fillText(I.nom, lx, my);
  g.fillStyle = S.accent; g.fillRect(lx, my + 13, tw3, 6);
  my += 54;
  g.font = '700 19px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays} · ${I.dates}`, lx, my); my += 36;
  g.font = '600 17px Inter, Arial'; g.fillStyle = S.hlt;
  I.hl.slice(0, 4).forEach(l => { if(my < H - pad){ g.fillText('·  ' + String(l).slice(0, 32), lx, my); my += 28; } });
  /* droite : timbre + lignes d'adresse */
  const rx = mid + 46;
  /* en-tête façon vraie carte postale */
  g.font = '800 13px Fraunces, Georgia'; g.fillStyle = S.hlt;
  pcTrack(g, 'CARTE POSTALE · CORRESPONDANCE', rx, pad + 22, 3);
  pcStamp(g, W - pad - 96, pad + 44);
  pcPostmark(g, W - pad - 124, pad + 88, 38, I.pays.slice(0, 3), I.dates.slice(0, 5));
  g.strokeStyle = S.ink; g.globalAlpha = .3; g.lineWidth = 2;
  for(let i = 0, ay = H / 2 - 4; i < 4; i++, ay += 46){ g.beginPath(); g.moveTo(rx, ay); g.lineTo(W - pad - 16, ay); g.stroke(); }
  g.globalAlpha = 1;
  g.fillStyle = S.ink; g.font = '800 21px Inter, Arial';
  g.fillText(I.nom.slice(0, 22), rx + 6, H / 2 - 12);
  g.font = '700 18px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(I.pays, rx + 6, H / 2 + 34);
  g.fillText(I.dates, rx + 6, H / 2 + 80);
  g.textAlign = 'right'; g.font = '900 17px Fraunces, Georgia'; g.fillStyle = S.ink;
  g.fillText('ACOLYTE ✈', W - pad, H - pad + 10); g.textAlign = 'left';
}

/* ---- MODÈLE 4 : Pellicule (bande de film + infos dessous) ---- */
function tplPellicule(g, W, H, { S, I, layout, photos, style }){
  const sy = 64, sh = 312;
  g.fillStyle = '#111'; g.fillRect(0, sy, W, sh);
  g.fillStyle = S.bg;
  for(let x = 16; x < W - 12; x += 44){ g.fillRect(x, sy + 13, 23, 16); g.fillRect(x, sy + sh - 29, 23, 16); }
  /* marquages de pellicule (numéros de vue + marque du film) */
  g.fillStyle = '#E8A33D'; g.font = '700 12px monospace'; g.textAlign = 'left';
  g.fillText('ACOLYTE 400  ·  12A   13   13A   14', 30, sy + 40);
  g.fillText('→  ' + I.dates, 30, sy + sh - 34);
  const n = layout === 'grande' ? 1 : layout === 'duo' ? 2 : 4;
  const gp = 12, iw = (W - 60 - gp * (n - 1)) / n, iy = sy + 44, ih = sh - 88;
  const rects = []; for(let i = 0; i < n; i++) rects.push([30 + i * (iw + gp), iy, iw, ih]);
  pcDrawPhotos(g, rects, photos, style, S, true);
  const tx = 44; const y = sy + sh + 72;
  g.textAlign = 'left';
  const tw = pcFit(g, I.nom, W - 250, 62);
  g.fillStyle = S.ink; g.fillText(I.nom, tx, y);
  g.fillStyle = S.accent; g.fillRect(tx, y + 14, tw, 7);
  g.font = '800 22px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, y + 56);
  if(I.hl.length){ g.font = '700 17px Inter, Arial'; g.fillStyle = S.hlt; g.fillText('📍 ' + I.hl.slice(0,3).join('  ·  ').slice(0,58), tx, y + 88); }
  pcStamp(g, W - 138, H - 156);
  g.textAlign = 'right'; g.font = '900 17px Fraunces, Georgia'; g.fillStyle = S.ink;
  g.fillText('ACOLYTE ✈', W - 44, H - 26); g.textAlign = 'left';
}

/* ---- MODÈLE 5 : Mosaïque (1 grande + 2 petites, bloc d'infos en surimpression) ---- */
function tplMosaique(g, W, H, { S, I, photos, style }){
  const pad = 26, gp = 12;
  const bigW = (W - 2*pad) * .60, colW = (W - 2*pad) - bigW - gp, zh = H - 2*pad, rh = (zh - gp) / 2;
  pcDrawPhotos(g, [[pad, pad, bigW, zh]], [photos[0] || {}], style, S, true);
  pcDrawPhotos(g, [[pad + bigW + gp, pad, colW, rh], [pad + bigW + gp, pad + rh + gp, colW, rh]],
               [photos[1] || {}, photos[2] || {}], style, S, true);
  /* bloc d'infos posé sur la grande photo */
  const bw = bigW - 32, bh = 158, bx = pad + 16, by = H - pad - 20 - bh;
  g.fillStyle = S.ink; g.globalAlpha = .92; g.fillRect(bx, by, bw, bh); g.globalAlpha = 1;
  g.fillStyle = S.accent; g.fillRect(bx, by, 8, bh);
  const tx = bx + 26;
  g.textAlign = 'left'; g.fillStyle = S.bg;
  g.font = '800 12px Fraunces, Georgia'; pcTrack(g, 'CARNET DE VOYAGE', tx, by + 30, 3);
  pcFit(g, I.nom, bw - 52, 46); g.fillStyle = S.bg; g.fillText(I.nom, tx, by + 76);
  g.font = '800 19px Inter, Arial'; g.globalAlpha = .8;
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, by + 108);
  if(I.hl.length){ g.font = '700 15px Inter, Arial'; g.globalAlpha = .62; g.fillText('📍 ' + I.hl.slice(0,2).join('  ·  ').slice(0,40), tx, by + 136); }
  g.globalAlpha = 1;
  pcStamp(g, W - pad - 100, pad + 14);
  /* signature posée sur une photo → blanc + ombre pour rester lisible */
  g.textAlign = 'right'; g.font = '900 16px Fraunces, Georgia';
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillText('ACOLYTE ✈', W - pad - 11, H - pad - 7);
  g.fillStyle = '#fff'; g.fillText('ACOLYTE ✈', W - pad - 12, H - pad - 8); g.textAlign = 'left';
}

/* ---- MODÈLE 6 : Passeport (page de passeport + tampon d'entrée) ---- */
function tplPasseport(g, W, H, { S, I, photos }){
  const pad = 42;
  g.textAlign = 'left'; g.fillStyle = S.ink; g.font = '900 20px Fraunces, Georgia';
  pcTrack(g, 'PASSEPORT · PASSPORT', pad, pad + 24, 4);
  g.strokeStyle = S.ink; g.globalAlpha = .35; g.lineWidth = 2;
  g.beginPath(); g.moveTo(pad, pad + 42); g.lineTo(W - pad, pad + 42); g.stroke(); g.globalAlpha = 1;
  const pw = 186, ph = 236, px = pad, py = pad + 70, p0 = photos[0] || {};
  g.fillStyle = '#fff'; g.fillRect(px - 5, py - 5, pw + 10, ph + 10);
  g.strokeStyle = S.ink; g.lineWidth = 3; g.strokeRect(px - 5, py - 5, pw + 10, ph + 10);
  if(p0.img) pcPhoto(g, p0.img, px, py, pw, ph); else pcTile(g, px, py, pw, ph);
  const fx = px + pw + 54; let fy = py + 10;
  const field = (lbl, val) => {
    g.font = '700 12px Inter, Arial'; g.fillStyle = S.hlt; pcTrack(g, lbl, fx, fy, 2);
    g.fillStyle = S.ink; pcFit(g, String(val || '—'), W - fx - pad, 30);
    g.fillText(String(val || '—'), fx, fy + 36); fy += 78;
  };
  field('DESTINATION / DESTINATION', I.nom);
  field('PAYS / COUNTRY', I.pays);
  field('DATES / DATES', I.dates);
  pcPostmark(g, W - pad - 96, H - pad - 118, 44, I.pays.slice(0, 3), I.dates.slice(0, 5));
  /* bande lisible par machine, façon passeport */
  g.fillStyle = S.ink; g.globalAlpha = .1; g.fillRect(pad, H - pad - 54, W - 2*pad, 54); g.globalAlpha = 1;
  g.font = '700 17px monospace'; g.fillStyle = S.ink;
  const mrz = ('ACO<' + I.nom.replace(/[^A-Z0-9]/gi, '<') + '<<' + I.pays.replace(/[^A-Z0-9]/gi, '<')).slice(0, 42).padEnd(42, '<');
  g.fillText(mrz, pad + 12, H - pad - 20);
}

/* ---- MODÈLE 7 : Minimal (une photo centrée, typo aérée) ---- */
function tplMinimal(g, W, H, { S, I, photos, style }){
  const pw = W * .52, ph = H * .44, px = (W - pw) / 2, py = H * .12, p0 = photos[0] || {};
  if(p0.img) pcPhoto(g, p0.img, px, py, pw, ph); else pcTile(g, px, py, pw, ph);
  g.strokeStyle = S.ink; g.lineWidth = 2; g.strokeRect(px, py, pw, ph);
  g.textAlign = 'center';
  const cy = py + ph + 62;
  g.fillStyle = S.hlt; g.font = '800 11px Fraunces, Georgia';
  const ew = g.measureText('CARNET DE VOYAGE').width + 15 * 3;
  pcTrack(g, 'CARNET DE VOYAGE', W / 2 - ew / 2, cy - 34, 3);
  pcFit(g, I.nom, W * .8, 52); g.fillStyle = S.ink; g.fillText(I.nom, W / 2, cy);
  g.fillStyle = S.accent; g.fillRect(W / 2 - 32, cy + 18, 64, 5);
  g.font = '700 20px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays}  ·  ${I.dates}`, W / 2, cy + 60);
  if(I.hl.length){ g.font = '600 16px Inter, Arial'; g.fillStyle = S.hlt; g.fillText(I.hl.slice(0,3).join('   ·   ').slice(0,56), W / 2, cy + 92); }
  g.font = '900 15px Fraunces, Georgia'; g.fillStyle = S.ink; g.fillText('ACOLYTE ✈', W / 2, H - 34);
  g.textAlign = 'left';
}

/* ---- MODÈLE 8 : Portrait (format vertical, façon story) ---- */
function tplVertical(g, W, H, { S, I, layout, photos, style }){
  const pad = 26, pzh = H * .54;
  pcDrawPhotos(g, pcLayoutRects({ x: pad, y: pad, w: W - 2*pad, h: pzh }, layout), photos, style, S);
  const tx = pad + 8; let y = pad + pzh + 78;
  g.textAlign = 'left';
  g.font = '800 12px Fraunces, Georgia'; g.fillStyle = S.hlt;
  pcTrack(g, 'CARNET DE VOYAGE', tx, y - 48, 3);
  const tw = pcFit(g, I.nom, W - 2*pad - 16, 58);
  g.fillStyle = S.ink; g.fillText(I.nom, tx, y);
  g.fillStyle = S.accent; g.fillRect(tx, y + 16, tw, 8);
  g.font = '800 21px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, y + 58);
  g.font = '700 17px Inter, Arial'; g.fillStyle = S.hlt;
  let ly = y + 100;
  I.hl.slice(0, 4).forEach(l => { if(ly < H - 70){ g.fillText('📍 ' + String(l).slice(0, 28), tx, ly); ly += 30; } });
  pcStamp(g, W - pad - 96, pad + pzh + 16);
  g.textAlign = 'right'; g.font = '900 17px Fraunces, Georgia'; g.fillStyle = S.ink;
  g.fillText('ACOLYTE ✈', W - pad - 8, H - 28); g.textAlign = 'left';
}

function drawPostcard(g, W, H, style, layout, photos, t){
  const S = PC_PALETTES[style] || PC_PALETTES.pop;   /* style inconnu → repli sûr */
  const I = pcInfo(t);
  g.fillStyle = S.bg; g.fillRect(0, 0, W, H);
  const TPL = { classique: tplClassique, magazine: tplMagazine, dos: tplDos, pellicule: tplPellicule,
                mosaique: tplMosaique, passeport: tplPasseport, minimal: tplMinimal, vertical: tplVertical };
  (TPL[_pcTemplate] || tplClassique)(g, W, H, { S, I, style, layout, photos });
  g.strokeStyle = S.ink; g.lineWidth = S.border; g.strokeRect(S.border / 2, S.border / 2, W - S.border, H - S.border);
}
function renderPostcard(){
  const t = state.trip; if(!t) return;
  /* chaque modèle peut imposer son format (ex : « Portrait » est vertical) */
  const tpl = PC_TEMPLATES.find(x => x.id === _pcTemplate) || PC_TEMPLATES[0];
  const W = tpl.w || 1000, H = tpl.h || 700;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  drawPostcard(cv.getContext('2d'), W, H, _pcStyle, _pcLayout, _pcPhotos || [], t);
  window._pcCanvas = cv;
  const img = $('#pcImg');
  if(img){ img.onload = () => { const l = $('#pcLoading'); if(l) l.style.display = 'none'; }; img.src = cv.toDataURL('image/png'); }
}
document.addEventListener('click', e => {
  if(e.target.closest('[data-postcard]')){ openPostcard(); return; }
  const tp = e.target.closest('[data-pctpl]');
  if(tp){ _pcTemplate = tp.dataset.pctpl; pcChips(); renderPostcard(); return; }
  const st = e.target.closest('[data-pcstyle]');
  if(st){ _pcStyle = st.dataset.pcstyle; pcChips(); renderPostcard(); return; }
  const ly = e.target.closest('[data-pclayout]');
  if(ly){ _pcLayout = ly.dataset.pclayout; pcChips(); renderPostcard(); return; }
});
/* --- Tes propres photos --- */
function pcUseFiles(files){
  const arr = [...files].filter(f => /^image\//.test(f.type)).slice(0, 4);
  if(!arr.length){ toast('Choisis des images 📷'); return; }
  /* data: URL (et non blob:) car la CSP img-src n'autorise pas blob: */
  Promise.all(arr.map(f => new Promise(res => {
    const rd = new FileReader();
    rd.onload = () => { const im = new Image(); im.onload = () => res({ cap:'', img: im }); im.onerror = () => res(null); im.src = rd.result; };
    rd.onerror = () => res(null);
    rd.readAsDataURL(f);
  }))).then(ps => {
    const ok = ps.filter(Boolean);
    if(!ok.length){ toast('Photos illisibles'); return; }
    _pcPhotos = ok;
    /* on ne force la disposition que si elle est trop petite pour montrer toutes les photos —
       sinon on respecte le choix de l'utilisateur (ex : 1 photo en « Collage »). */
    const slots = { grande:1, duo:2, collage:4 }[_pcLayout] || 1;
    if(ok.length > slots) _pcLayout = ok.length >= 3 ? 'collage' : 'duo';
    pcChips(); renderPostcard();
    toast(`📸 ${ok.length} photo(s) ajoutée(s)`);
  });
}
const _ePcMine = $('#pcMine'); if(_ePcMine) _ePcMine.onclick = () => $('#pcFile')?.click();
const _ePcFile = $('#pcFile'); if(_ePcFile) _ePcFile.onchange = e => { const fs = e.target.files; if(fs?.length) pcUseFiles(fs); e.target.value = ''; };
const _ePcWeb = $('#pcWeb'); if(_ePcWeb) _ePcWeb.onclick = async () => {
  const t = state.trip; if(!t) return;
  if($('#pcLoading')){ $('#pcLoading').textContent = 'Recherche de photos…'; $('#pcLoading').style.display = ''; }
  if($('#pcImg')) $('#pcImg').removeAttribute('src');
  const places = [...((state.cache.plan?.programme || []).flatMap(j => j.lieux || [])), t.nom, t.pays].filter(Boolean);
  const uniq = [...new Set(places)].slice(0, 4);
  const imgs = await Promise.all(uniq.map(async n => pcLoadImg(await fetchWikiThumb(n))));
  _pcPhotos = uniq.map((cap, i) => ({ cap, img: imgs[i] }));
  const found = _pcPhotos.filter(p => p.img).length;
  renderPostcard();
  toast(found ? `🌐 ${found} photo(s) trouvée(s)` : 'Aucune photo trouvée — ajoute les tiennes 📸');
};
const _ePcD = $('#pcDownload'); if(_ePcD) _ePcD.onclick = () => {
  if(!window._pcCanvas) return;
  window._pcCanvas.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `acolyte-postcard-${String(state.trip?.nom||'voyage').toLowerCase().replace(/[^a-z0-9]+/g,'-')}.png`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('🖼️ Carte postale téléchargée');
  }, 'image/png');
};
const _ePcS = $('#pcShare'); if(_ePcS) _ePcS.onclick = () => {
  if(!window._pcCanvas) return;
  window._pcCanvas.toBlob(async b => {
    const file = typeof File !== 'undefined' ? new File([b], 'postcard.png', { type:'image/png' }) : null;
    if(file && navigator.canShare?.({ files:[file] })){
      try{ await navigator.share({ files:[file], title:'Ma carte postale Acolyte', text:`Mon voyage à ${state.trip?.nom} ✈️` }); return; }
      catch(e){ if(e.name === 'AbortError') return; }
    }
    _ePcD.click();
  }, 'image/png');
};

/* --- Ajuste la taille des valeurs pour qu'aucun mot ne soit coupé --- */
function fitStats(){
  $$('.plan-stat .v').forEach(el => {
    let px = 16;
    el.style.fontSize = px + 'px';
    while(el.scrollWidth > el.clientWidth + 1 && px > 9){
      px -= 0.5;
      el.style.fontSize = px + 'px';
    }
  });
}

/* --- Météo animée en canvas (soleil / nuages / pluie / neige selon données réelles) --- */
let _wxRun = 0;
function startWx(){
  const cv = $('#wxCv'), m = state.cache._real?.mNums;
  if(!cv || !m) return;
  const g = cv.getContext('2d');
  if(!g) return;
  const my = ++_wxRun;
  const mode = m.min <= 1 && m.rain > 25 ? 'snow' : m.rain > 55 ? 'rain' : m.rain > 25 ? 'cloud' : 'sun';
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const drops = Array.from({length: 7}, (_, i) => ({ x: 8 + i * 6.5, y: Math.random() * 56 }));
  let f = 0;
  (function tick(){
    if(my !== _wxRun || !cv.isConnected) return;
    f++;
    g.clearRect(0, 0, 56, 56);
    const INK = dark() ? '#F4F3EF' : '#101010';
    if(mode === 'sun' || mode === 'cloud'){
      /* soleil qui tourne */
      const cx = mode === 'sun' ? 28 : 20, cy = mode === 'sun' ? 28 : 20, r = mode === 'sun' ? 11 : 8;
      g.save(); g.translate(cx, cy); g.rotate(f * 0.02);
      g.strokeStyle = INK; g.lineWidth = 2.5;
      for(let i = 0; i < 8; i++){ g.rotate(Math.PI / 4); g.beginPath(); g.moveTo(r + 4, 0); g.lineTo(r + 9, 0); g.stroke(); }
      g.restore();
      g.fillStyle = '#FFE600'; g.strokeStyle = INK; g.lineWidth = 2.5;
      g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); g.stroke();
    }
    if(mode !== 'sun'){
      /* nuage qui dérive */
      const ox = 6 * Math.sin(f * 0.03);
      g.fillStyle = dark() ? '#1B1B26' : '#fff'; g.strokeStyle = INK; g.lineWidth = 2.5;
      g.beginPath();
      g.arc(22 + ox, 32, 9, Math.PI * 0.5, Math.PI * 1.5);
      g.arc(30 + ox, 26, 8, Math.PI * 0.8, Math.PI * 1.98);
      g.arc(38 + ox, 32, 9, Math.PI * 1.5, Math.PI * 0.5);
      g.closePath(); g.fill(); g.stroke();
    }
    if(mode === 'rain' || mode === 'snow'){
      g.strokeStyle = mode === 'rain' ? '#00A8C0' : INK;
      g.fillStyle = g.strokeStyle; g.lineWidth = 2;
      drops.forEach(dp => {
        dp.y += mode === 'rain' ? 1.8 : 0.7;
        if(dp.y > 56) dp.y = 40;
        if(dp.y > 38){
          if(mode === 'rain'){ g.beginPath(); g.moveTo(dp.x, dp.y); g.lineTo(dp.x - 2, dp.y + 5); g.stroke(); }
          else { g.beginPath(); g.arc(dp.x + 2 * Math.sin(f * 0.1 + dp.x), dp.y, 1.8, 0, 7); g.fill(); }
        }
      });
    }
    requestAnimationFrame(tick);
  })();
}

/* --- Confettis 🎉 (valise complétée à 100 %) --- */
function confetti(){
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed;inset:0;z-index:90;pointer-events:none';
  cv.width = innerWidth; cv.height = innerHeight;
  document.body.appendChild(cv);
  const g = cv.getContext('2d');
  if(!g){ cv.remove(); return; }
  const C = ['#FFE600', '#00F0FF', '#FF6B00', '#A855F7', '#22C55E', '#101010'];
  const ps = Array.from({length: 120}, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.5,
    s: 6 + Math.random() * 8, v: 2.4 + Math.random() * 3.6,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.25,
    c: C[Math.floor(Math.random() * C.length)]
  }));
  let n = 0;
  (function tick(){
    g.clearRect(0, 0, cv.width, cv.height);
    ps.forEach(q => {
      q.y += q.v; q.r += q.vr;
      g.save(); g.translate(q.x, q.y); g.rotate(q.r);
      g.fillStyle = q.c; g.fillRect(-q.s/2, -q.s/2, q.s, q.s);
      g.restore();
    });
    if(++n < 150) requestAnimationFrame(tick); else cv.remove();
  })();
}


/* --- PWA : app installable + hors-ligne --- */
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

/* bandeau hors-ligne (mode avion : l'app reste utilisable, l'IA non) */
function netBanner(){
  let b = $('#offBar');
  if(!navigator.onLine){
    if(!b){
      b = document.createElement('div');
      b.id = 'offBar';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:80;background:var(--accent-orange);color:#101010;border-bottom:3px solid var(--stroke);font-weight:900;font-size:.78rem;text-align:center;padding:7px 12px';
      b.textContent = '✈️ Hors-ligne — ton voyage reste consultable, l’IA et les prix reviendront avec le réseau';
      document.body.appendChild(b);
    }
  } else if(b) b.remove();
}
addEventListener('online', netBanner);
addEventListener('offline', netBanner);
netBanner();

/* ============================================================
   INSTALLER L'APPLICATION — LES TROIS PLATEFORMES
   ------------------------------------------------------------
   ⚠️ CE QUI NE MARCHAIT PAS. La ligne « Installer » du profil était masquée et
   n'était révélée que par l'événement « beforeinstallprompt ». Cet événement
   N'EXISTE PAS sur iOS : la ligne restait donc invisible pour toujours sur
   iPhone. Le code contenait pourtant déjà le bon conseil (« Partager → Sur
   l'écran d'accueil ») — mais il ne s'affichait qu'au CLIC d'un bouton qui
   n'apparaissait jamais. Le conseil était juste, et inatteignable.

   Trois cas, trois comportements, parce que les navigateurs ne se valent pas :
   · Android / Chrome / Edge → le navigateur sait installer. Un bouton suffit.
   · iPhone / iPad → Apple INTERDIT toute installation déclenchée par le site.
     Le geste doit venir de l'utilisateur : on explique, on ne promet pas.
   · Safari sur Mac, Firefox → pas d'API non plus, on explique aussi.

   ⚠️ Pourquoi installer compte VRAIMENT ici : Safari efface le stockage local
   d'un site après 7 jours sans visite. Les voyages vivent dans ce stockage —
   un visiteur qui ne revient pas d'une semaine perd tout. Une app posée sur
   l'écran d'accueil est exemptée de cet effacement. Ce n'est donc pas un
   confort, c'est ce qui protège ses voyages, et c'est ce qu'on lui dit.
============================================================ */
let _deferredPrompt = null;
const LS_INSTALL_ASK = 'acolite_install_ask';

/* Déjà installée ? Trois signaux, parce qu'aucun n'est universel :
   navigator.standalone est propre à iOS, display-mode couvre le reste. */
function pwaInstalle(){
  try{
    if(navigator.standalone === true) return true;
    return ['standalone', 'minimal-ui', 'fullscreen']
      .some(m => matchMedia(`(display-mode: ${m})`).matches);
  }catch(e){ return false; }
}
/* Famille iOS. Le test du iPad est indispensable : depuis iPadOS 13 il se
   déclare « MacIntel », et une détection naïve le prendrait pour un Mac. */
function pwaIOS(){
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)/.test(ua)
      || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
}
/* Y a-t-il quelque chose à proposer ? Sur iOS et les navigateurs sans API, on
   n'a que des explications — mais des explications valent mieux que rien.

   ⚠️ Le second test n'est pas une redondance. Quand on installe depuis Chrome
   sur ordinateur, l'ONGLET COURANT continue de tourner dans le navigateur :
   « display-mode » y reste « browser », et pwaInstalle() répond donc « non »
   juste après une installation réussie. Sans ce garde-fou, le profil continuait
   d'afficher « Installer Acolyte » à quelqu'un qui venait de le faire. */
function pwaProposable(){
  if(pwaInstalle()) return false;
  try{ if(localStorage.getItem(LS_INSTALL_ASK) === 'fait') return false; }catch(e){}
  return true;
}

function installBodyHTML(){
  const EN = isEN();
  const garde = `<p class="hint" style="margin-top:14px">${EN
    ? 'Why it matters: Safari wipes a site’s local data after 7 days without a visit. Your trips live there. An app on the home screen is exempt — installing is what protects them.'
    : 'Pourquoi ça compte : Safari efface les données locales d’un site après 7 jours sans visite. Tes voyages y sont. Une app posée sur l’écran d’accueil en est exemptée — l’installer, c’est ce qui les protège.'}</p>`;

  if(_deferredPrompt){
    /* Android, Chrome et Edge sur ordinateur : le navigateur fait le travail. */
    return `<p>${EN
      ? 'Acolyte becomes a real app: its own icon, full screen, no address bar, and it opens without a connection.'
      : 'Acolyte devient une vraie application : son icône, plein écran, sans barre d’adresse, et elle s’ouvre sans connexion.'}</p>
      <button class="btn" id="instGo" style="width:100%;justify-content:center;margin-top:14px">${ICO('telephone',15)} ${
        EN ? 'Install now' : 'Installer maintenant'}</button>
      ${garde}`;
  }
  if(pwaIOS()){
    /* ⚠️ Aucun bouton ici, et c'est volontaire : iOS n'offre aucun moyen de
       déclencher l'installation depuis le site. Promettre un bouton qui ne
       fait rien serait pire que de ne rien proposer. */
    return `<p>${EN
      ? 'On iPhone and iPad, Apple does not let a website install itself — the gesture has to come from you. It takes three seconds:'
      : 'Sur iPhone et iPad, Apple n’autorise pas un site à s’installer lui-même : le geste doit venir de toi. C’est trois secondes :'}</p>
      <ol class="inst-pas">
        <li>${EN ? 'Tap the <strong>Share</strong> button at the bottom of Safari (the square with an arrow pointing up).'
                 : 'Touche le bouton <strong>Partager</strong> en bas de Safari (le carré avec une flèche vers le haut).'}</li>
        <li>${EN ? 'Scroll down and choose <strong>Add to Home Screen</strong>.'
                 : 'Fais défiler et choisis <strong>Sur l’écran d’accueil</strong>.'}</li>
        <li>${EN ? 'Tap <strong>Add</strong>. The Acolyte icon lands next to your other apps.'
                 : 'Touche <strong>Ajouter</strong>. L’icône Acolyte se pose à côté de tes autres apps.'}</li>
      </ol>
      <p class="hint">${EN
        ? 'One thing to know: the installed app has its own storage, separate from Safari. Sign in to find your trips again there.'
        : 'Un point à savoir : l’app installée a son propre stockage, séparé de Safari. Connecte-toi pour y retrouver tes voyages.'}</p>
      ${garde}`;
  }
  /* Safari sur Mac (Ajouter au Dock), Firefox, et tout le reste. */
  return `<p>${EN
    ? 'Your browser can keep Acolyte within reach, without going through a store:'
    : 'Ton navigateur peut garder Acolyte à portée de main, sans passer par un magasin d’applications :'}</p>
    <ol class="inst-pas">
      <li>${EN ? '<strong>Chrome or Edge</strong>: the install icon appears at the right end of the address bar.'
               : '<strong>Chrome ou Edge</strong> : l’icône d’installation apparaît au bout de la barre d’adresse, à droite.'}</li>
      <li>${EN ? '<strong>Safari on Mac</strong>: File menu → <strong>Add to Dock</strong>.'
               : '<strong>Safari sur Mac</strong> : menu Fichier → <strong>Ajouter au Dock</strong>.'}</li>
      <li>${EN ? '<strong>Firefox</strong>: no install, but a bookmark works — Acolyte still runs offline.'
               : '<strong>Firefox</strong> : pas d’installation, mais un favori suffit — Acolyte fonctionne quand même hors connexion.'}</li>
    </ol>
    ${garde}`;
}

function openInstall(){
  const b = $('#installBody'); if(b) b.innerHTML = installBodyHTML();
  $('#ovInstall')?.classList.add('show');
}

/* La ligne du profil : visible dès que l'installation a un sens, sur TOUS les
   appareils — plus seulement là où le navigateur veut bien nous prévenir. */
function pwaRow(){
  const it = $('#pwaItem');
  if(it) it.style.display = pwaProposable() ? '' : 'none';
}
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredPrompt = e;
  pwaRow();
});
/* installée pendant la session : on retire la proposition sur-le-champ */
addEventListener('appinstalled', () => {
  _deferredPrompt = null;
  try{ lsSet(LS_INSTALL_ASK, 'fait'); }catch(e){}
  $('#ovInstall')?.classList.remove('show');
  pwaRow();
});
pwaRow();

document.addEventListener('click', async e => {
  if(e.target.id === 'pfInstall'){ openInstall(); return; }
  if(e.target.id !== 'instGo') return;
  if(!_deferredPrompt) return;
  $('#ovInstall')?.classList.remove('show');
  _deferredPrompt.prompt();
  const r = await _deferredPrompt.userChoice.catch(() => null);
  /* ⚠️ Une invitation ne sert QU'UNE fois : après « prompt() », le navigateur
     la consomme. La rappeler ne ferait rien du tout, il faut la relâcher. */
  _deferredPrompt = null;
  if(r?.outcome === 'accepted'){ try{ lsSet(LS_INSTALL_ASK, 'fait'); }catch(e){} }
  pwaRow();
});

/* ---- La proposition après un voyage réussi ----
   Le bon moment pour demander, c'est juste après avoir obtenu son programme :
   la valeur vient d'être prouvée. Mais une fenêtre qui surgit sur le plan qu'on
   vient d'attendre gâche l'effet — d'où le délai.

   ⚠️ Trois garde-fous, parce qu'une proposition d'installation devient vite du
   harcèlement : jamais si c'est déjà installé, jamais deux fois de suite, et
   un mois de silence après un refus. */
function proposerInstall(){
  if(!pwaProposable()) return;                       /* déjà installée */
  let etat = '';
  try{ etat = localStorage.getItem(LS_INSTALL_ASK) || ''; }catch(e){}
  if(etat === 'fait') return;
  const quand = parseInt(etat, 10);
  if(quand && Date.now() - quand < 30 * 864e5) return;   /* refusée récemment */
  /* on laisse le voyage s'afficher et se lire avant d'ouvrir quoi que ce soit */
  setTimeout(() => {
    if(!pwaProposable()) return;
    if($('.overlay.show')) return;                   /* on ne s'empile pas */
    openInstall();
    try{ lsSet(LS_INSTALL_ASK, String(Date.now())); }catch(e){}
  }, 4000);
}

/* ---------- Boot ---------- */
loadSettings();
load();
checkImportHash();
if(state.prefs){
  $('#fFrom').value = state.prefs.from || '';
  $('#fWhen').value = state.prefs.when || '';
  if(state.prefs.depart) $('#fDepart').value = state.prefs.depart;
  if(state.prefs.dest) $('#fDest').value = state.prefs.dest;
  if(state.prefs.adults) $('#fAdults').value = state.prefs.adults;
  if(state.prefs.kids !== undefined) $('#fKids').value = state.prefs.kids;
  if(state.prefs.free) $('#fFree').value = (state.prefs.free||'').split(' | Affinage :')[0];
  if(state.prefs.transport) $('#fTransport').value = state.prefs.transport;
  if($('#fMulti')) $('#fMulti').checked = state.prefs.itin === 'pays';
  if(Array.isArray(state.prefs.pays)) _paysChoisis = state.prefs.pays.slice(0, PAYS_MAX);
  paysBoxSync();
}else{
  applyTripDefaults();   /* pas encore de voyage → on pré-remplit avec les valeurs par défaut */
}
unlockSteps();
if(state.lastProps) renderDestinations(state.lastProps);
if(state.step > 1) gotoStep(Math.min(state.step, 3));
/* Mode « voyage en cours » : si on est sur place aux dates du séjour, on ouvre
   directement le plan et on déplie la journée du moment. */
(function openTodayIfTraveling(){
  if(!state.trip || !state.cache?.plan) return;
  const d = stayDates(); if(!d) return;
  const now = new Date(), start = new Date(d.in + 'T00:00:00'), end = new Date(d.out + 'T23:59:59');
  if(isNaN(start) || now < start || now > end) return;   /* pas pendant le séjour */
  const jour = Math.floor((now - start) / 86400000) + 1;
  gotoStep(3);
  _planTab = 'programme';
  /* on déplie la journée du jour quand le plan est rendu */
  setTimeout(() => { try{ if(typeof loadDayDetail === 'function' && state.cache.plan?.programme?.some(x => +x.jour === jour)) {
    const box = document.querySelector(`[data-daybox="${CSS.escape(String(jour))}"]`);
    if(box && box.dataset.open !== '1') loadDayDetail(String(jour));
    box?.closest('.day-block')?.scrollIntoView({ block:'center' });
  } }catch(e){} }, 400);
})();
requireAuth();

/* app.js est arrivé au bout : le vérificateur de démarrage ne déclenchera pas d'alerte */
if(window.__ACOLITE) window.__ACOLITE.loaded = true;

/* ============================================================
   TRADUCTION — mode anglais
   ------------------------------------------------------------
   Pourquoi traduire le DOM plutôt que remplacer 900 chaînes par des
   appels t('clé') : app.js écrit son interface en injectant du HTML depuis
   des centaines d'endroits. Réécrire chaque site d'appel dans un fichier à
   portée globale unique, c'est des centaines d'occasions de casser quelque
   chose en silence — exactement ce que ce projet a déjà vécu.
   Ici, un seul point d'entrée traduit ce qui apparaît, d'où qu'il vienne :
   le HTML statique ET tout ce que le code génère ensuite.
   La clé, c'est le texte français lui-même : rien à inventer, rien à
   maintenir en double.
============================================================ */

/* Normalise avant comparaison : apostrophe typographique, espaces
   insécables de la ponctuation française, retours à la ligne du HTML
   indenté. Sans ça, « Ton voyage » et « Ton voyage » ne se ressemblent pas. */
const i18nKey = s => String(s ?? '')
  .replace(/[\u2019\u02bc]/g, "'")
  .replace(/[\u00a0\u202f\u2009]/g, ' ')
  /* S\u00e9lecteur de variante emoji (U+FE0F) : invisible, mais il fait partie de
     la cha\u00eene. Sans cette ligne, ajouter ou retirer le s\u00e9lecteur sur un
     \ud83d\uddd1\ufe0f du HTML cassait SILENCIEUSEMENT la traduction du bouton, la cl\u00e9 du
     dictionnaire ne correspondant plus. */
  .replace(/\ufe0f/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const EN_RAW = {
  /* ---- Salle de jeux ---- */
  '🕹️ La salle de jeux': '🕹️ The arcade',
  "Tu m'as trouvée. Choisis à quoi on joue.": 'You found me. Pick what we play.',
  'Défends la Terre': 'Defend the Earth',
  'Descends les astéroïdes avant qu’ils touchent la planète.': 'Shoot the asteroids down before they reach the planet.',
  'Où est-ce ?': 'Where is it?',
  '🌍 Où est-ce ?': '🌍 Where is it?',
  'Une photo, une carte : place le monument et donne son nom.': 'A photo, a map: place the monument and name it.',
  'Ne me lâche pas': 'Don’t drop me',
  '🏓 Ne me lâche pas': '🏓 Don’t drop me',
  'Un pong où la balle, c’est moi. Et je n’aime pas ça.': 'A pong game where I am the ball. And I do not enjoy it.',
  'Bagage express': 'Express packing',
  '🧳 Bagage express': '🧳 Express packing',
  'Le tapis défile : attrape ce qu’il faut emporter.': 'The belt keeps rolling: grab what you need to take.',
  'Monument à reconnaître': 'Monument to identify',
  '🖱️ Bouge la raquette avec la souris et empêche la mascotte de tomber.': '🖱️ Move the paddle with your mouse and keep the mascot off the floor.',
  "💡 Elle n'aime pas être cognée. Au bout de 10 chocs, elle voit rouge — et ça va plus vite.": '💡 She hates being knocked about. After 10 bumps she sees red — and it speeds up.',
  '🏓 Commencer': '🏓 Start',
  "🖱️ Le tapis défile. Clique sur ce qu'il faut emporter, laisse passer le reste.": '🖱️ The belt rolls past. Click what you need to pack, let the rest go by.',
  "💡 La destination change en cours de route : ce qui était utile ne l'est plus.": '💡 The destination changes mid-game: what was useful no longer is.',
  '🧳 Commencer': '🧳 Start',
  'Tu m’as laissée tomber !': 'You dropped me!',
  'Valise bouclée': 'Bag packed',
  'Partie terminée': 'Round over',

  /* ---- Onglets du voyage ---- */
  'Logement': 'Where you sleep',
  'Événements': 'Events',
  /* onglet « Papiers » du voyage : le libellé est écrit en dur dans PLAN_TABS,
     c'est donc ici qu'il se traduit */
  'Papiers': 'Paperwork',

  /* ---- Fragments : texte coupé par du gras en ligne ---- */
  'Ton programme jour par jour. Une journée ne te va pas ?': 'Your day-by-day programme. A day doesn’t suit you?',
  ', ou demande à Acolyte de la': ', or ask Acolyte to',
  'refaire': 'redo it',
  '✈️ Avant le décollage : télécharge le carnet PDF et prépare les': '✈️ Before take-off: download the PDF travel book and prepare the',
  'cartes de chaque journée': 'maps for each day',
  '— tout reste consultable': '— everything stays readable',
  'sans connexion': 'offline',
  '📬 Un code de vérification à 6 chiffres a été envoyé à': '📬 A 6-digit verification code has been sent to',
  '. Entre-le pour sécuriser ton compte.': '. Enter it to secure your account.',
  'politique de confidentialité': 'privacy policy',

  /* ---- Collaboration ---- */
  'planifiez à plusieurs': 'plan it together',
  'Aucun commentaire — lance la discussion !': 'No comments yet — start the conversation!',

  /* ---- Réglages : pastilles ---- */
  '🏖️ Détente': '🏖️ Relaxing',
  '🏛️ Culture': '🏛️ Culture',
  '🥾 Aventure': '🥾 Adventure',
  '🎉 Fête': '🎉 Partying',
  '🌿 Nature': '🌿 Nature',
  '🍽️ Gastronomie': '🍽️ Food & wine',
  '👨‍👩‍👧 Famille': '👨‍👩‍👧 Family',
  '🐢 Doux': '🐢 Gentle',
  '⚖️ Équilibré': '⚖️ Balanced',
  '⚡ Intense': '⚡ Packed',
  '🍽️ Aucune contrainte': '🍽️ No restrictions',
  '🥗 Végétarien': '🥗 Vegetarian',
  '🌱 Végan': '🌱 Vegan',
  '☪️ Halal': '☪️ Halal',
  '✡️ Casher': '✡️ Kosher',
  '🌾 Sans gluten': '🌾 Gluten-free',
  '✅ Aucun besoin': '✅ No needs',
  '♿ Mobilité réduite': '♿ Reduced mobility',
  "✈️ Éviter l'avion": '✈️ Avoid flying',
  '🚆 Éviter le train': '🚆 Avoid trains',
  '🚗 Éviter la voiture': '🚗 Avoid cars',
  '🖥️ Système': '🖥️ System',
  '☀️ Clair': '☀️ Light',
  '🌙 Sombre': '🌙 Dark',
  '✨ Animations': '✨ Animations',
  '✨ Animations ✔': '✨ Animations ✔',
  '🔍 Double vérification du plan': '🔍 Double-check the plan',
  '🔍 Double vérification du plan ✔': '🔍 Double-check the plan ✔',
  '📡 Données réelles (météo, trains, fériés)': '📡 Real data (weather, trains, holidays)',
  '📡 Données réelles (météo, trains, fériés) ✔': '📡 Real data (weather, trains, holidays) ✔',

  /* ---- Réseau ---- */
  '🐢 Réseau lent — Acolyte allège les chargements': '🐢 Slow connection — Acolyte is loading less',
  '📴 Hors connexion — ton voyage reste consultable': '📴 Offline — your trip is still readable',

  /* ---- Coque, navigation, démarrage ---- */
  'COPILOTE DE VOYAGE': 'YOUR TRAVEL COPILOT',
  'Démarrage…': 'Starting…',
  'Carte': 'Map',
  'Voyage': 'Trip',
  'Profil': 'Profile',
  'Questions': 'Questions',
  'Les choix': 'The options',
  'Ton voyage': 'Your trip',
  'Ton voyage 🧳': 'Your trip 🧳',
  'Acolyte explore le monde…': 'Acolyte is exploring the world…',

  /* ---- Vue 1 : le questionnaire ---- */
  '🧳 Mes voyages': '🧳 My trips',
  'Reprends un voyage déjà exploré, ou lances-en un nouveau ci-dessous.': 'Pick up a trip you already explored, or start a new one below.',
  "Où est-ce qu'on t'emmène ? 🌍": 'Where are we taking you? 🌍',
  "Décris tes envies, Acolyte te propose des destinations sur mesure — puis t'aide à affiner.": 'Describe what you fancy: Acolyte suggests tailor-made destinations, then helps you narrow them down.',
  'Ville de départ': 'Departure city',
  'Destination souhaitée': 'Preferred destination',
  'Durée': 'Length',
  '🌤️ Week-end (2-3 j)': '🌤️ Weekend (2-3 days)',
  '🗓️ 1 semaine': '🗓️ 1 week',
  '🗓️ 2 semaines': '🗓️ 2 weeks',
  '🌍 3 semaines +': '🌍 3 weeks +',
  'Période': 'When',
  'Date de départ (optionnel)': 'Departure date (optional)',
  'Budget total / personne': 'Total budget / person',
  '🪙 Petit (< 500 €)': '🪙 Small (< €500)',
  '💶 Moyen (500 – 1200 €)': '💶 Medium (€500 – 1,200)',
  '💳 Confort (1200 – 2500 €)': '💳 Comfortable (€1,200 – 2,500)',
  '💎 Élevé (2500 € +)': '💎 High (€2,500 +)',
  'Adultes': 'Adults',
  'Enfants': 'Children',
  'Ambiance recherchée': 'The mood you want',
  'Peu importe — surprends-moi': 'No preference — surprise me',
  '🏖️ Plage & détente': '🏖️ Beach & chill',
  '🏛️ Ville & culture': '🏛️ City & culture',
  '🥾 Nature & aventure': '🥾 Nature & adventure',
  '🎉 Fête & vie nocturne': '🎉 Parties & nightlife',
  '💘 Romantique': '💘 Romantic',
  '🧘 Bien-être & repos': '🧘 Wellness & rest',
  'Avec qui': 'Who with',
  'Peu importe': 'No preference',
  '🧍 En solo': '🧍 Solo',
  '💞 En couple': '💞 As a couple',
  '👯 Entre amis': '👯 With friends',
  '👨‍👩‍👧 En famille': '👨‍👩‍👧 As a family',
  '💼 Entre collègues': '💼 With colleagues',
  'Comment tu veux voyager': 'How you want to travel',
  '🌍 Traverser plusieurs pays': '🌍 Travel across several countries',
  'Quels pays ?': 'Which countries?',
  'ex : Italie': 'e.g. Italy',
  'Acolyte construit un itinéraire de 2 à 3 pays, avec les trajets entre étapes comptés dans le budget.': 'Acolyte builds a 2 to 3 country route, with the journeys between stops counted in the budget.',
  '🤷 Peu importe — Acolyte décide': '🤷 No preference — Acolyte decides',
  '🚆 Train': '🚆 Train',
  '🚗 Voiture': '🚗 Car',
  '✈️ Avion': '✈️ Plane',
  "Style d'hébergement": 'Type of stay',
  '🏨 Hôtel': '🏨 Hotel',
  '🏠 Appartement / Airbnb': '🏠 Flat / Airbnb',
  '🎒 Auberge / éco': '🎒 Hostel / budget',
  '✨ Séjour de luxe': '✨ Luxury stay',
  'Tes limites & conditions': 'Your limits & conditions',
  '✨ Propose-moi des voyages': '✨ Suggest me some trips',
  "🎯 Choisis un pays, l'IA trouve le lieu": '🎯 Pick a country, Acolyte finds the spot',
  '🎲 Surprends-moi': '🎲 Surprise me',
  '📷 Scanner un ticket': '📷 Scan a ticket',
  'Paris': 'Paris',
  'Pays ou ville — vide = surprends-moi': 'Country or city — leave empty to be surprised',
  'août 2026, vacances de la Toussaint…': 'August 2026, half-term break…',
  "Ex : max 3h de trajet, pas d'auberge, je pars avec un bébé, je veux la plage, budget serré sur le logement…": 'E.g. max 3h travel, no hostels, travelling with a baby, I want the beach, tight budget on the room…',
  'ex : Paris': 'e.g. Paris',
  'ex : Sacha': 'e.g. Sacha',
  'toi@exemple.com': 'you@example.com',
  '8 caractères minimum': '8 characters minimum',

  /* ---- Vue 2 : les propositions ---- */
  "Remplis le questionnaire à l'étape 1 pour voir tes propositions ici.": 'Fill in the questionnaire at step 1 to see your options here.',
  'Choisir ce voyage →': 'Choose this trip →',
  'Choisir →': 'Choose →',
  '📊 Comparatif': '📊 Side by side',
  '✍️ Pas tout à fait ça ?': '✍️ Not quite it?',
  'Reproposer →': 'Suggest again →',
  '🎯 Précisons ton voyage': '🎯 Let’s pin down your trip',
  'Acolyte a besoin de quelques précisions pour viser juste. Réponds, et il ajuste tes propositions de voyage.': 'Acolyte needs a few details to aim right. Answer, and it will adjust your options.',
  '✅ Affiner mes propositions': '✅ Refine my options',
  'Passer — garder ces propositions': 'Skip — keep these options',

  /* ---- Vue 3 : le voyage ---- */
  '🎫 RÉSERVER': '🎫 BOOK',
  'Tous les liens de réservation, déjà pré-remplis avec ta destination et tes dates.': 'Every booking link, already filled in with your destination and dates.',
  '🎫 Réserver — billets, hôtels, activités': '🎫 Book — tickets, hotels, activities',
  '📄 Carnet (PDF)': '📄 Travel book (PDF)',
  '🗺️ Cartes hors-ligne': '🗺️ Offline maps',
  '🧰 GÉRER CE VOYAGE': '🧰 MANAGE THIS TRIP',
  '🔄 Tout réorganiser': '🔄 Reorganise everything',
  '↩ Changer de destination': '↩ Change destination',
  '💾 Sauvegarder (fichier)': '💾 Save to a file',
  '📂 Importer': '📂 Import',
  '⬇ Exporter (.md)': '⬇ Export (.md)',
  '↺ Nouveau voyage': '↺ New trip',
  'Bon à savoir': 'Good to know',
  'Une fois sur place': 'Once you’re there',
  'À réserver tôt': 'Book early',
  '🕘 Voir heure par heure': '🕘 See it hour by hour',
  '🕘 Détailler ma journée': '🕘 Break down my day',
  'Vois-la heure par heure': 'See it hour by hour',
  '🔄 Refaire ce jour': '🔄 Redo this day',
  'Envoyer': 'Send',
  '➕ Ajouter': '➕ Add',
  '↻ Réessayer': '↻ Try again',
  "Le prix exact du jour s'affiche à la réservation": 'The exact price of the day shows at booking',
  'Impact sur le climat': 'Climate impact',
  '✈️ Billets de transport': '✈️ Travel tickets',
  '🏨 Logement — prix réels': '🏨 Stays — real prices',
  '🔎 Comparer tous les logements': '🔎 Compare every stay',
  '🎡 Activités & visites': '🎡 Activities & sights',
  'Départ': 'Departure',
  'Arrivée': 'Arrival',
  'Prix estimé A/R': 'Estimated return price',
  'Chercher les billets 🎫': 'Find tickets 🎫',
  'Distance': 'Distance',
  'Coût estimé': 'Estimated cost',
  'Itinéraire': 'Route',
  'Verdict': 'Verdict',
  'Trajet': 'Journey',

  /* ---- Carte ---- */
  'Pas encore de voyage': 'No trip yet',
  "Choisis une destination et Acolyte trace ton itinéraire, jour par jour, ici même.": 'Choose a destination and Acolyte draws your route, day by day, right here.',
  '✨ Commencer un voyage': '✨ Start a trip',
  '🧭 Où je suis': '🧭 Where I am',
  "↗ M'y guider": '↗ Take me there',
  'Journées du voyage': 'Days of the trip',
  '✈️ Aller': '✈️ Getting there',
  'Zoomer': 'Zoom in',
  'Dézoomer': 'Zoom out',
  '📍 Te voilà !': '📍 There you are!',
  'Position refusée ou introuvable': 'Location refused or unavailable',
  'Géolocalisation indisponible sur cet appareil': 'Location is not available on this device',
  '🧭 Recherche de ta position…': '🧭 Finding your position…',

  /* ---- Profil ---- */
  'Mon compte 👤': 'My account 👤',
  'Aucun voyage en cours': 'No trip in progress',
  'Lance ton premier voyage pour débloquer la carte, le programme et le ticket.': 'Start your first trip to unlock the map, the programme and the ticket.',
  'Commencer': 'Get started',
  'PRÉFÉRENCES': 'PREFERENCES',
  '🌐 Langue': '🌐 Language',
  "Change la langue de l'interface et celle des voyages qu'Acolyte écrit pour toi.": 'Changes the language of the interface and of the trips Acolyte writes for you.',
  '🧭 Ton style de voyage': '🧭 Your travel style',
  "L'IA en tient compte à chaque proposition et à chaque plan.": 'Acolyte takes this into account in every suggestion and every plan.',
  '⚡ Ton rythme': '⚡ Your pace',
  '🍽️ Alimentation': '🍽️ Food',
  '♿ Accessibilité': '♿ Accessibility',
  '🚫 Transports à éviter': '🚫 Transport to avoid',
  "L'IA ne te proposera pas ces modes de transport (sauf s'il n'existe aucune alternative).": 'Acolyte will not suggest these modes of transport (unless there is no alternative at all).',
  "✨ Réponses d'Acolyte": '✨ Acolyte’s answers',
  'Niveau de détail': 'Level of detail',
  "✂️ Concis — l'essentiel": '✂️ Brief — the essentials',
  '📄 Normal': '📄 Normal',
  '📚 Détaillé — tout expliquer': '📚 Detailed — explain everything',
  '🎨 Apparence': '🎨 Appearance',
  '« Système » suit automatiquement le thème clair/sombre de ton appareil.': '“System” follows your device’s light/dark theme automatically.',
  'Taille du texte :': 'Text size:',
  '📌 Valeurs par défaut': '📌 Defaults',
  'Pré-remplies à chaque nouveau voyage — tu peux toujours les changer dans le questionnaire.': 'Pre-filled for every new trip — you can always change them in the questionnaire.',
  '🏠 Ville de départ': '🏠 Departure city',
  '🧑 Adultes': '🧑 Adults',
  '🧒 Enfants': '🧒 Children',
  '↺ Tout réinitialiser': '↺ Reset everything',
  'ACTIONS': 'ACTIONS',
  'Nouveautés': 'What’s new',
  'Voir': 'View',
  'Exporter mon voyage': 'Export my trip',
  'Exporter': 'Export',
  'Recommencer un voyage': 'Start a trip over',
  'Nouveau voyage': 'New trip',
  'Changer le mot de passe': 'Change password',
  'Changer': 'Change',
  "Changer d'adresse email": 'Change email address',
  "Installer Acolyte sur l'appareil": 'Install Acolyte on this device',
  'Installer': 'Install',
  'Importer un voyage (scanner un ticket)': 'Import a trip (scan a ticket)',
  'Ouvrir le scanner': 'Open the scanner',
  'Régénérer les contenus IA': 'Regenerate Acolyte’s content',
  'Vider le cache IA': 'Clear the cache',
  'Télécharger mes données': 'Download my data',
  'Télécharger (.json)': 'Download (.json)',
  'Mode "Vol de nuit"': '“Night flight” mode',
  'Activer / désactiver': 'Turn on / off',
  'Politique de confidentialité': 'Privacy policy',
  'Consulter': 'Read',
  'Se déconnecter': 'Sign out',
  'Déconnexion': 'Sign out',
  'Ton avis compte': 'Your opinion counts',
  'Aide Acolyte à grandir': 'Help Acolyte grow',
  "Pas de pub intrusive, pas de données revendues. La meilleure façon de soutenir Acolyte, c'est de laisser ton avis.": 'No intrusive ads, no data sold on. The best way to support Acolyte is to leave your review.',
  '⚠️ Zone sensible': '⚠️ Danger zone',
  'La suppression est': 'Deletion is',
  'définitive': 'permanent',
  ': compte, voyages, notes et souvenirs seront perdus. Aucun retour possible.': ': account, trips, notes and memories will be lost. There is no way back.',
  '🗑️ Supprimer définitivement mon compte': '🗑️ Permanently delete my account',

  /* ---- Compte ---- */
  "Crée ton compte pour commencer l'aventure.": 'Create your account to start the adventure.',
  'Ton pseudo': 'Your nickname',
  /* Les questions de la première arrivée. Elles sont écrites en dur en français
     dans QZ, donc elles passent par le dictionnaire comme tout le reste de
     l'interface — sans ces lignes, un anglophone voit cinq questions en
     français dès la première seconde. */
  'Qu’est-ce qui te fait partir ?': 'What makes you want to travel?',
  'Choisis-en autant que tu veux — l’IA cherchera des destinations qui cochent ces cases.':
    'Pick as many as you like — Acolyte will look for destinations that tick these boxes.',
  'Tu voyages à quel rythme ?': 'What pace do you travel at?',
  'Ça décide du nombre de visites par journée, et du temps laissé entre elles.':
    'This sets how many stops per day, and how much time is left between them.',
  'Tu manges comment ?': 'How do you eat?',
  'Les restaurants et les marchés proposés en tiendront compte.':
    'Suggested restaurants and markets will take this into account.',
  'Sur place, tu te déplaces comment ?': 'How will you get around once there?',
  'Ça change les durées entre deux visites, et la façon de grouper tes journées.':
    'This changes travel times between stops, and how your days are grouped.',
  'Un besoin d’accessibilité ?': 'Any accessibility needs?',
  'Si oui, l’IA évite les sites escarpés et privilégie les accès de plain-pied.':
    'If so, Acolyte avoids steep sites and favours step-free access.',
  'Tout passer — je réglerai plus tard': 'Skip all — I’ll set this up later',
  'Adresse email': 'Email address',
  'Mot de passe': 'Password',
  'Confirme le mot de passe': 'Confirm password',
  "J'ai lu et j'accepte la": 'I have read and accept the',
  'Créer mon compte →': 'Create my account →',
  'Déjà un compte ?': 'Already have an account?',
  'Se connecter': 'Sign in',
  'Se connecter →': 'Sign in →',
  'Pas de compte ?': 'No account yet?',
  'En créer un': 'Create one',
  'Code de vérification': 'Verification code',
  'Vérifier ✔': 'Verify ✔',
  'Renvoyer le code': 'Resend the code',
  "Changer d'email": 'Change email',
  '⚠️ Supprimer le compte': '⚠️ Delete account',
  'Compte, voyages, notes et préférences seront': 'Account, trips, notes and preferences will be',
  'définitivement effacés': 'permanently erased',
  "de cet appareil. Aucun retour possible.": 'from this device. There is no way back.',
  'Pour confirmer, écris': 'To confirm, type',
  'ton pseudo': 'your nickname',
  '🗑️ Supprimer définitivement': '🗑️ Delete permanently',
  'Annuler': 'Cancel',

  /* ---- Modales diverses ---- */
  'Réservation 🎫': 'Booking 🎫',
  'Scanner un ticket 📷': 'Scan a ticket 📷',
  "Vise le QR d'un ticket Acolyte pour importer le voyage (idéal entre amis).": 'Point at the QR code on an Acolyte ticket to import the trip (great between friends).',
  '🖼 Ou choisir une photo du ticket': '🖼 Or pick a photo of the ticket',
  'Fermer': 'Close',
  'Ta carte postale 🖼️': 'Your postcard 🖼️',
  'Composition…': 'Composing…',
  'Modèle — mise en page': 'Template — layout',
  'Style — couleurs': 'Style — colours',
  'Disposition des photos': 'Photo layout',
  'Photos': 'Photos',
  '📸 Mes photos': '📸 My photos',
  '🌐 Photos du web': '🌐 Photos from the web',
  '⬇ Télécharger': '⬇ Download',
  '📤 Partager': '📤 Share',
  'Ajoute': 'Add',
  'tes photos': 'your photos',
  "ou laisse Acolyte chercher des photos du web. Souvenir uniquement.": 'or let Acolyte look for photos on the web. Keepsake only.',
  '✨ Quoi de neuf ?': '✨ What’s new?',
  "👍 J'ai vu": '👍 Got it',
  '🔒 Confidentialité': '🔒 Privacy',
  "✅ J'accepte": '✅ I accept',
  'Passer': 'Skip',
  'Bienvenue sur Acolyte': 'Welcome to Acolyte',
  'Ton copilote de voyage.': 'Your travel copilot.',
  'Suivant →': 'Next →',
  "Passer l'introduction": 'Skip the intro',
  'Aperçu de la carte postale': 'Postcard preview',

  /* ---- Mini-jeu ---- */
  '🛰️ Défends la Terre': '🛰️ Defend the Earth',
  'Niveau 1': 'Level 1',
  'Terre perdue !': 'Earth lost!',
  '🔄 Rejouer': '🔄 Play again',
  '🖱️ Clique sur les astéroïdes pour les détruire avant qu’ils touchent la Terre.': '🖱️ Click the asteroids to destroy them before they hit the Earth.',
  "💡 Enchaîne sans laisser passer d'astéroïde : ton multiplicateur monte. Les dorés valent triple.": '💡 Keep hitting without letting one through: your multiplier climbs. Golden ones are worth triple.',
  '🚀 Commencer': '🚀 Start',
  '🎨 Personnaliser': '🎨 Customise',
  '🎨 Personnalisation': '🎨 Customisation',
  'Change le style — sans toucher à la difficulté.': 'Change the look — the difficulty stays exactly the same.',
  '☄️ Astéroïdes': '☄️ Asteroids',
  '🌍 Planète': '🌍 Planet',
  '✅ Terminé': '✅ Done',
  '🏆 Meilleurs défenseurs': '🏆 Top defenders',

  /* ---- Messages : chargement, succès, erreurs ---- */
  'Recherche des événements…': 'Looking for events…',
  'Événements indisponibles pour le moment.': 'Events are unavailable right now.',
  'Sélection des meilleurs logements…': 'Picking the best places to stay…',
  'Sélection indisponible — les comparateurs ci-dessous restent pré-remplis.': 'Selection unavailable — the comparison sites below are still pre-filled.',
  'Construction de la journée heure par heure…': 'Building your day hour by hour…',
  'Journée indisponible pour le moment.': 'This day is unavailable right now.',
  'Repérage des meilleurs quartiers…': 'Scouting the best neighbourhoods…',
  'Recherche logement impossible pour le moment.': 'Can’t search for a place to stay right now.',
  'Construction de ton programme…': 'Building your programme…',
  'Génération impossible, réessaie.': 'Couldn’t generate it — please try again.',
  'Trop gros pour cette fois — réessaie ou génère jour par jour.': 'Too much at once — try again, or build it day by day.',
  'Je cherche les bonnes tables du quartier…': 'Hunting down the good tables nearby…',
  'Impossible de charger les adresses pour le moment.': 'Can’t load the addresses right now.',
  'Repérage des supermarchés…': 'Spotting the supermarkets…',
  'Chargement impossible.': 'Loading failed.',
  'Enquête gourmande…': 'Food scouting…',
  'Préparation de ta checklist…': 'Preparing your checklist…',
  '🎉 Valise bouclée à 100 % !': '🎉 Bag packed, 100 % done!',
  'Traduction en cours…': 'Translating…',
  'Traduction…': 'Translating…',
  'Traduction impossible.': 'Translation failed.',
  'Calcul du budget…': 'Working out the budget…',
  'Calcul impossible pour le moment.': 'Can’t work it out right now.',
  'Repérage des meilleures activités…': 'Scouting the best things to do…',
  'Localisation introuvable pour la météo.': 'Couldn’t locate the place for the weather.',
  'Météo indisponible pour le moment.': 'Weather is unavailable right now.',
  'Taux de change indisponible.': 'Exchange rate unavailable.',
  'Analyse impossible pour le moment.': 'Can’t analyse it right now.',
  'Choisis d’abord un voyage.': 'Choose a trip first.',
  'Choisis d’abord un voyage': 'Choose a trip first',
  'Choisis d’abord un voyage 😉': 'Choose a trip first 😉',
  'Choisis d’abord une destination': 'Choose a destination first',
  'Choisis d’abord un des 3 voyages 😉': 'Pick one of the 3 trips first 😉',
  'Remplis d’abord le questionnaire 😉': 'Fill in the questionnaire first 😉',
  'Génère d’abord le programme': 'Generate the programme first',
  'Génère d’abord le plan (étape 3) 😉': 'Generate the plan first (step 3) 😉',
  'Destination pré-remplie 👍': 'Destination pre-filled 👍',
  'Écris quelque chose ou ajoute une photo 😉': 'Write something or add a photo 😉',
  '📓 Souvenir enregistré': '📓 Memory saved',
  '🔄 Nouvelle version du jour': '🔄 New version of the day',
  '❌ Impossible de refaire cette journée': '❌ Couldn’t redo this day',
  '💬 Commentaire ajouté — partage la sauvegarde à ton co-voyageur': '💬 Comment added — share the save file with your travel buddy',
  '🎯 Merci — Acolyte affine tes propositions…': '🎯 Thanks — Acolyte is refining your options…',
  '🎯 Acolyte réajuste ses propositions…': '🎯 Acolyte is readjusting its options…',
  'Ok, Acolyte garde ses propositions actuelles 👍': 'Fine, Acolyte keeps the current options 👍',
  "Le plan n'est pas encore prêt": 'The plan isn’t ready yet',
  'Réponse prise en compte ✔': 'Answer taken into account ✔',
  'Entre un montant valide 💶': 'Enter a valid amount 💶',
  'Voyage exporté 📄': 'Trip exported 📄',
  '📄 Choisis « Enregistrer au format PDF » dans la fenêtre d’impression': '📄 Choose “Save as PDF” in the print dialogue',
  '📴 Hors connexion — ton plan reste consultable dans Acolyte': '📴 Offline — your plan is still readable in Acolyte',
  '💾 Voyage sauvegardé dans un fichier': '💾 Trip saved to a file',
  'Sauvegarde impossible': 'Couldn’t save',
  '📂 Voyage importé ✔': '📂 Trip imported ✔',
  'Fichier invalide — ce n’est pas une sauvegarde Acolyte': 'Invalid file — this isn’t an Acolyte save',
  'Lecture du fichier impossible': 'Couldn’t read the file',
  'Ajoute au moins une référence': 'Add at least one reference',
  'Réservation ajoutée 📎': 'Booking added 📎',
  'Écris un pays dans « Destination souhaitée » 😉': 'Type a country in “Preferred destination” 😉',
  '📬 Code envoyé — pense à regarder tes indésirables': '📬 Code sent — remember to check your spam folder',
  '📬 Code envoyé — regarde tes indésirables': '📬 Code sent — check your spam folder',
  '📬 Nouveau code envoyé': '📬 New code sent',
  'Compte vérifié — bienvenue ! 🎉': 'Account verified — welcome! 🎉',
  'Re-bonjour': 'Welcome back',
  '🏠 Ville de départ par défaut enregistrée': '🏠 Default departure city saved',
  '↺ Préférences réinitialisées': '↺ Preferences reset',
  'Pseudo mis à jour ✔': 'Nickname updated ✔',
  'À bientôt 👋': 'See you soon 👋',
  '❌ 8 caractères minimum': '❌ 8 characters minimum',
  '🔑 Mot de passe changé ✔': '🔑 Password changed ✔',
  '✉️ Changement d’adresse bientôt disponible': '✉️ Changing your address is coming soon',
  '🧹 Cache IA vidé — contenus régénérés à la prochaine visite': '🧹 Cache cleared — content will be rebuilt on your next visit',
  '📄 Données téléchargées': '📄 Data downloaded',
  '❌ Pseudo incorrect': '❌ Wrong nickname',
  '⚠️ Oups, un pépin technique — recharge la page si ça persiste': '⚠️ Oops, a technical hiccup — reload the page if it keeps happening',
  '⚠️ Une action a échoué — réessaie': '⚠️ Something failed — please try again',
  '❌ QR illisible': '❌ Unreadable QR code',
  '🔗 Lien copié — envoie-le à tes amis': '🔗 Link copied — send it to your friends',
  '❌ Lien de voyage invalide': '❌ Invalid trip link',
  'Il faut un voyage avec une date de départ': 'You need a trip with a departure date',
  '📅 Programme exporté — ouvre-le pour l’ajouter à ton agenda': '📅 Programme exported — open it to add it to your calendar',
  'Canvas indisponible': 'Canvas unavailable',
  '📤 Ticket partagé — le QR s’ouvre avec l’appareil photo': '📤 Ticket shared — the QR opens with any phone camera',
  '📷 Ticket téléchargé — le QR s’ouvre avec l’appareil photo': '📷 Ticket downloaded — the QR opens with any phone camera',
  'Choisis des images 📷': 'Pick some images 📷',
  'Photos illisibles': 'Couldn’t read those photos',
  '🖼️ Carte postale téléchargée': '🖼️ Postcard downloaded',
  'Sur iPhone : Partager → « Sur l’écran d’accueil »': 'On iPhone: Share → “Add to Home Screen”',
  '💾 Stockage plein — cache allégé': '💾 Storage full — cache trimmed',
  '⚠️ Sauvegarde impossible (stockage plein ou désactivé)': '⚠️ Couldn’t save (storage full or disabled)',
  '😕 Service momentanément indisponible': '😕 Service temporarily unavailable',
  '😕 Petit accroc — je réessaie': '😕 Small hiccup — trying again',
  'Ticket souvenir — ne permet pas d\'embarquer. Le QR sert uniquement à importer ce voyage dans Acolyte.': 'Keepsake ticket — not valid for boarding. The QR code only imports this trip into Acolyte.'
};

/* On normalise les clés une fois pour toutes au démarrage */
const EN = {};
for(const k in EN_RAW) EN[i18nKey(k)] = EN_RAW[k];

const i18nLook = s => {
  const k = i18nKey(s);
  return k && Object.prototype.hasOwnProperty.call(EN, k) ? EN[k] : null;
};

let _i18nMo = null;
const I18N_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
/* jamais touchés : ce que le voyageur a tapé, et le code */
const I18N_SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, CODE: 1, CANVAS: 1 };

function i18nWalk(root){
  if(!isEN() || !root) return;
  const el = root.nodeType === 1 ? root : root.parentElement;
  if(!el) return;

  /* attributs */
  for(const node of [el, ...el.querySelectorAll('*')]){
    if(node.closest('[data-noi18n]')) continue;
    for(const a of I18N_ATTRS){
      const cur = node.getAttribute(a);
      if(!cur) continue;
      const tr = i18nLook(cur);
      if(tr && tr !== cur) node.setAttribute(a, tr);
    }
  }

  /* textes — on collecte d'abord, on écrit ensuite : modifier pendant le
     parcours d'un TreeWalker donne des résultats imprévisibles */
  const jobs = [];
  const it = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while((n = it.nextNode())){
    const p = n.parentElement;
    if(!p || I18N_SKIP[p.nodeName] || p.closest('[data-noi18n]')) continue;
    const tr = i18nLook(n.nodeValue);
    if(tr !== null) jobs.push([n, tr]);
  }
  for(const [node, tr] of jobs){
    /* on garde les espaces autour, sinon la mise en page saute */
    const v = node.nodeValue.match(/^\s*/)[0] + tr + node.nodeValue.match(/\s*$/)[0];
    /* n'écrire QUE si ça change vraiment : certaines entrées se traduisent
       par elles-mêmes (« Budget », « Distance »). Réécrire à l'identique
       déclencherait une mutation, qui relancerait la traduction, en boucle.
       Cette garde rend la fonction idempotente — elle peut repasser autant
       de fois qu'on veut sans rien coûter ni rien casser. */
    if(v !== node.nodeValue) node.nodeValue = v;
  }
}

function i18nStart(){
  document.documentElement.lang = LANG;
  if(!isEN()) return;
  document.title = 'Acolyte — Plan your trip: destination, transport, itinerary';
  i18nWalk(document.body);
  if(!window.MutationObserver) return;
  /* app.js réécrit son interface en permanence : on traduit ce qui arrive */
  _i18nMo = new MutationObserver(muts => {
    for(const m of muts){
      if(m.type === 'characterData') i18nWalk(m.target.parentElement);
      else for(const nd of m.addedNodes) i18nWalk(nd);
    }
  });
  _i18nMo.observe(document.body, { childList: true, subtree: true, characterData: true });
}

/* Sélecteur de langue (profil). Un changement recharge la page : c'est le
   seul moyen sûr de repartir d'un DOM propre, et l'état vit dans
   localStorage — rien n'est perdu. */
function renderLangChips(){
  $$('#stLang [data-lang], #stLangAuth [data-lang]')
    .forEach(b => b.classList.toggle('on', b.dataset.lang === LANG));
}
document.addEventListener('click', e => {
  const b = e.target.closest('#stLang [data-lang], #stLangAuth [data-lang]');
  if(!b) return;
  const v = b.dataset.lang;
  if(v === LANG) return;
  lsSet(LS_LANG, v);
  location.reload();
});

i18nStart();
renderLangChips();
/* La colonne de gauche restait VIDE jusqu'à la première navigation, et son
   titre gardait le français inscrit dans le HTML même en anglais. Ce premier
   rendu doit venir APRÈS i18nStart(), sinon il repartirait en français. */
renderRail();

/* ============================================================
   LA SALLE DE JEUX — 2 clics sur la mascotte (PC)
   ------------------------------------------------------------
   Quatre jeux, quatre fenêtres séparées. Le carrousel de choix vit dans
   #ovArcade ; chaque jeu garde son propre overlay et sa propre boucle.
   Règle commune : à la fermeture, on ARRÊTE la boucle. Un requestAnimationFrame
   oublié continue de tourner dans le vide et mange la batterie.
============================================================ */
const ARCADE_JEUX = [
  { id:'ast',  ico:'🛰️', nom:'Défends la Terre', desc:'Descends les astéroïdes avant qu’ils touchent la planète.' },
  { id:'geo',  ico:'🌍', nom:'Où est-ce ?',      desc:'Une photo, une carte : place le monument et donne son nom.' },
  { id:'pong', ico:'🏓', nom:'Ne me lâche pas',  desc:'Un pong où la balle, c’est moi. Et je n’aime pas ça.' },
  { id:'pack', ico:'🧳', nom:'Bagage express',   desc:'Le tapis défile : attrape ce qu’il faut emporter.' }
];

function openArcade(){
  const ov = $('#ovArcade'); if(!ov) return;
  const grid = $('#arcadeGrid');
  if(grid){
    grid.innerHTML = ARCADE_JEUX.map(j => `
      <button class="arcade-card" data-arcade="${j.id}">
        <span class="ac-ico">${j.ico}</span>
        <span class="ac-nom">${esc(j.nom)}</span>
        <span class="ac-desc">${esc(j.desc)}</span>
      </button>`).join('');
  }
  ov.classList.add('show');
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-arcade]');
  if(!b) return;
  $('#ovArcade')?.classList.remove('show');
  ({ ast: openGame, geo: openGeo, pong: openPong, pack: openPack })[b.dataset.arcade]?.();
});

/* ============================================================
   JEU 2 — « Où est-ce ? »
   ------------------------------------------------------------
   Photos et coordonnées relevées sur Wikipédia (largeurs de vignette
   imposées par Wikimedia : ne change pas le « 960px- », les autres tailles
   sont refusées avec une erreur 400).
============================================================ */
const GEO_LIEUX = [
  { fr:"Colisée", en:"Colosseum", lat:41.8905, lon:12.4926, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/960px-Colosseo_2020.jpg" },
  { fr:"Tour Eiffel", en:"Eiffel Tower", lat:48.8583, lon:2.2945, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/960px-Tour_Eiffel_Wikimedia_Commons.jpg" },
  { fr:"Taj Mahal", en:"Taj Mahal", lat:27.175, lon:78.0419, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/b/bd/Taj_Mahal%2C_Agra%2C_India_edit3.jpg/960px-Taj_Mahal%2C_Agra%2C_India_edit3.jpg" },
  { fr:"Palais de Westminster", en:"Big Ben", lat:51.4994, lon:-0.1242, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/3/3b/Houses_of_Parliament_in_2022_%28cropped%29.jpg/960px-Houses_of_Parliament_in_2022_%28cropped%29.jpg" },
  { fr:"Statue de la Liberté", en:"Statue of Liberty", lat:40.6892, lon:-74.0444, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/f/fd/Statue_of_Liberty%2C_statue%2C_Liberty_Island%2C_New_York.jpg/960px-Statue_of_Liberty%2C_statue%2C_Liberty_Island%2C_New_York.jpg" },
  { fr:"Machu Picchu", en:"Machu Picchu", lat:-13.1633, lon:-72.5456, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/1/13/Before_Machu_Picchu.jpg/960px-Before_Machu_Picchu.jpg" },
  { fr:"Sagrada Família", en:"Sagrada Família", lat:41.4034, lon:2.1744, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/SF_maig_2026.jpg/960px-SF_maig_2026.jpg" },
  { fr:"Opéra de Sydney", en:"Sydney Opera House", lat:-33.8571, lon:151.2149, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/Sydney_Opera_House_from_Circular_Quay%2C_2023%2C_10.jpg/960px-Sydney_Opera_House_from_Circular_Quay%2C_2023%2C_10.jpg" },
  { fr:"Pyramide de Khéops", en:"Great Pyramid of Giza", lat:29.9789, lon:31.1339, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Great_Pyramid_of_Giza.jpg/960px-Great_Pyramid_of_Giza.jpg" },
  { fr:"Tour de Pise", en:"Leaning Tower of Pisa", lat:43.723, lon:10.3966, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/2/2a/Exterior_of_the_Leaning_Tower_%28Pisa%29_in_April_2024.jpg/960px-Exterior_of_the_Leaning_Tower_%28Pisa%29_in_April_2024.jpg" },
  { fr:"Parthénon", en:"Parthenon", lat:37.9715, lon:23.7267, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/The_Parthenon_in_Athens.jpg/960px-The_Parthenon_in_Athens.jpg" },
  { fr:"Mont Saint-Michel", en:"Mont-Saint-Michel", lat:48.6361, lon:-1.5114, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Mont_St_Michel_in_the_afternoon.jpg/960px-Mont_St_Michel_in_the_afternoon.jpg" },
  { fr:"Château de Neuschwanstein", en:"Neuschwanstein Castle", lat:47.5578, lon:10.7499, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/Schloss_Neuschwanstein_2013.jpg/960px-Schloss_Neuschwanstein_2013.jpg" },
  { fr:"Pétra", en:"Petra", lat:30.3292, lon:35.4436, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/View_of_Petra.jpg/960px-View_of_Petra.jpg" },
  { fr:"Angkor Vat", en:"Angkor Wat", lat:13.4125, lon:103.8668, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Angkor_Wat.jpg/960px-Angkor_Wat.jpg" },
  { fr:"Grande Muraille", en:"Great Wall of China", lat:40.3347, lon:116.045, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Great_Wall_of_China_July_2006.JPG/960px-Great_Wall_of_China_July_2006.JPG" },
  { fr:"Chichén Itzá", en:"Chichén Itzá", lat:20.6829, lon:-88.5687, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/El_Castillo_Stitch_2008_Edit_1.jpg/960px-El_Castillo_Stitch_2008_Edit_1.jpg" },
  { fr:"Basilique Saint-Marc", en:"St Mark's Basilica", lat:45.4344, lon:12.3398, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/6/61/Venezia_Basilica_di_San_Marco_Fassade_2.jpg/960px-Venezia_Basilica_di_San_Marco_Fassade_2.jpg" },
  { fr:"Alhambra", en:"Alhambra", lat:37.1769, lon:-3.5899, img:"https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Dawn_Charles_V_Palace_Alhambra_Granada_Andalusia_Spain.jpg/960px-Dawn_Charles_V_Palace_Alhambra_Granada_Andalusia_Spain.jpg" }
];
const geoNom = m => isEN() ? m.en : m.fr;
const LS_GEOBEST = 'acolite_geo_best';
const GEO_MANCHES = 5;

let _geoMap = null, _geo = null;

function geoMelange(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){ const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function openGeo(){
  const ov = $('#ovGeo'); if(!ov) return;
  ov.classList.add('show');
  if(!_geoMap){
    _geoMap = acoMapCreate($('#geoMap'));
    _geoMap.onClick((lat, lon) => geoPose(lat, lon));
  }
  geoNouvellePartie();
}
function geoNouvellePartie(){
  _geo = { manche: 0, score: 0, lieux: geoMelange(GEO_LIEUX).slice(0, GEO_MANCHES), pose: null };
  $('#geoOver').hidden = true;
  geoManche();
}
function geoManche(){
  const m = _geo.lieux[_geo.manche];
  _geo.pose = null;
  $('#geoPhoto').src = m.img;
  $('#geoPhoto').alt = isEN() ? 'Monument to identify' : 'Monument à reconnaître';
  $('#geoRound').textContent = (isEN() ? 'Round ' : 'Manche ') + (_geo.manche + 1) + ' / ' + GEO_MANCHES;
  $('#geoScore').textContent = (isEN() ? 'Score: ' : 'Score : ') + _geo.score;
  $('#geoHint').hidden = false;
  $('#geoHint').textContent = isEN()
    ? 'Click the map where you think this monument stands.'
    : "Clique sur la carte à l'endroit où se trouve ce monument.";
  $('#geoNames').hidden = true;
  $('#geoResult').hidden = true;
  $('#geoNext').hidden = true;
  _geoMap.setMarks([]);
  _geoMap.setLine([]);
  _geoMap.setView(20, 5, 2);
}
/* 1re étape : situer sur la carte */
function geoPose(lat, lon){
  if(!_geo || _geo.pose) return;                 /* une seule tentative par manche */
  _geo.pose = { lat, lon };
  _geoMap.setMarks([{ lat, lon, kind:'me', nom: isEN() ? 'Your guess' : 'Ta réponse' }]);
  $('#geoHint').hidden = true;
  /* 2e étape : nommer, parmi 4 propositions */
  const bon = _geo.lieux[_geo.manche];
  const leurres = geoMelange(GEO_LIEUX.filter(x => x.fr !== bon.fr)).slice(0, 3);
  const choix = geoMelange([bon, ...leurres]);
  const zone = $('#geoNames');
  zone.innerHTML = `<p class="geo-q">${isEN() ? 'And what is it called?' : 'Et ça s’appelle comment ?'}</p>`
    + choix.map(c => `<button class="geo-name" data-geoname="${esc(c.fr)}">${esc(geoNom(c))}</button>`).join('');
  zone.hidden = false;
}
/* 2e étape : nommer — puis on révèle tout */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-geoname]');
  if(!b || !_geo || !_geo.pose) return;
  const bon = _geo.lieux[_geo.manche];
  const juste = b.dataset.geoname === bon.fr;
  const km = Math.round(havKm(
    { latitude: _geo.pose.lat, longitude: _geo.pose.lon },
    { latitude: bon.lat, longitude: bon.lon }));
  /* le score de distance décroît jusqu'à 5 000 km, au-delà c'est zéro */
  const ptsDist = Math.max(0, Math.round(1000 * (1 - km / 5000)));
  const ptsNom = juste ? 500 : 0;
  _geo.score += ptsDist + ptsNom;

  _geoMap.setMarks([
    { lat: _geo.pose.lat, lon: _geo.pose.lon, kind:'me', nom: isEN() ? 'Your guess' : 'Ta réponse' },
    { lat: bon.lat, lon: bon.lon, kind:'end', nom: geoNom(bon) }
  ]);
  _geoMap.setLine([[_geo.pose.lat, _geo.pose.lon], [bon.lat, bon.lon]]);
  _geoMap.fit([[_geo.pose.lat, _geo.pose.lon], [bon.lat, bon.lon]], 60);

  $('#geoNames').hidden = true;
  const res = $('#geoResult');
  res.innerHTML = isEN()
    ? `<b>${esc(bon.en)}</b> — you were <b>${km} km</b> off (+${ptsDist})`
      + `<br>${juste ? '✅ Right name (+500)' : '❌ Wrong name'}`
    : `<b>${esc(bon.fr)}</b> — tu étais à <b>${km} km</b> (+${ptsDist})`
      + `<br>${juste ? '✅ Bon nom (+500)' : '❌ Mauvais nom'}`;
  res.hidden = false;
  $('#geoScore').textContent = (isEN() ? 'Score: ' : 'Score : ') + _geo.score;
  $('#geoNext').hidden = false;
  $('#geoNext').textContent = _geo.manche + 1 >= GEO_MANCHES
    ? (isEN() ? 'See my result →' : 'Voir mon résultat →')
    : (isEN() ? 'Next round →' : 'Manche suivante →');
});
const _geoNextBtn = $('#geoNext'); if(_geoNextBtn) _geoNextBtn.onclick = () => {
  if(_geo.manche + 1 >= GEO_MANCHES){ geoFin(); return; }
  _geo.manche++;
  geoManche();
};
const _geoReplay = $('#geoReplay'); if(_geoReplay) _geoReplay.onclick = geoNouvellePartie;
function geoFin(){
  let best = 0;
  try{ best = parseInt(localStorage.getItem(LS_GEOBEST), 10) || 0; }catch(e){}
  const record = _geo.score > best;
  if(record) lsSet(LS_GEOBEST, String(_geo.score));
  $('#geoOverTitle').textContent = _geo.score >= 4000
    ? (isEN() ? '🏆 Globe-trotter!' : '🏆 Grand voyageur !')
    : (isEN() ? '🌍 Round over' : '🌍 Partie terminée');
  $('#geoOverScore').textContent = record
    ? (isEN() ? '🎉 New best: ' : '🎉 Nouveau record : ') + _geo.score
    : (isEN() ? 'Score: ' : 'Score : ') + _geo.score + (isEN() ? '  ·  your best: ' : '  ·  ton record : ') + best;
  $('#geoOver').hidden = false;
}

/* ============================================================
   JEU 3 — « Ne me lâche pas » : un pong dont la balle est la mascotte,
   qui se plaint à chaque choc et finit par se vexer pour de bon.
============================================================ */
const LS_PONGBEST = 'acolite_pong_best';
const PONG_RALE = {
  fr: ['Aïe !', 'Non mais oh !', 'Doucement !', 'Ça tourne…', 'Arrête ça !',
       'Je suis pas une balle !', 'Tu vas me décoiffer !', 'Encore ?', 'Ouille !', 'Pas la tête !'],
  en: ['Ouch!', 'Hey!', 'Gently!', 'I’m dizzy…', 'Stop that!',
       'I am not a ball!', 'Mind my hair!', 'Again?', 'Oof!', 'Not the face!']
};
const PONG_FACHE = {
  fr: ['JE SUIS PAS UNE BALLE !', 'ÇA SUFFIT !', 'REPOSE-MOI !', 'TU VAS VOIR !', 'J’EN AI ASSEZ !'],
  en: ['I AM NOT A BALL!', 'ENOUGH!', 'PUT ME DOWN!', 'YOU’LL SEE!', 'I’VE HAD IT!']
};
const PONG_SEUIL = 10;   /* nombre de chocs avant que la mascotte voie rouge */

function openPong(){
  const ov = $('#ovPong'); if(!ov) return;
  ov.classList.add('show');
  pongInit();
}

let _pongStop = null;
function pongInit(){
  const cv = $('#pongCanvas'); if(!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  let ball, pad, chocs, renvois, vies, running, raf, bulle, secousse;

  let best = 0;
  try{ best = parseInt(localStorage.getItem(LS_PONGBEST), 10) || 0; }catch(e){}
  const bd = $('#pongBest');
  if(bd){ bd.hidden = !best; bd.textContent = (isEN() ? 'Your best: ' : 'Ton record : ') + best; }

  const fache = () => chocs >= PONG_SEUIL;

  function reset(){
    pad = { x: W / 2, w: 118, h: 15, y: H - 28 };
    ball = { x: W / 2, y: H / 2, r: 24, vx: 3.4 * (Math.random() < .5 ? 1 : -1), vy: -3.6 };
    chocs = 0; renvois = 0; vies = 3; bulle = null; secousse = 0;
    running = true;
    hud();
  }
  function relance(){
    ball = { x: W / 2, y: H / 2, r: 24, vx: 3.4 * (Math.random() < .5 ? 1 : -1), vy: -3.6 };
  }
  function hud(){
    $('#pongScore').textContent = (isEN() ? 'Returns: ' : 'Renvois : ') + renvois;
    $('#pongBumps').textContent = (isEN() ? 'Bumps: ' : 'Chocs : ') + chocs;
    $('#pongLives').textContent = '❤️'.repeat(Math.max(0, vies)) || '💀';
  }
  function rale(){
    const src = fache() ? PONG_FACHE : PONG_RALE;
    const l = isEN() ? src.en : src.fr;
    bulle = { txt: l[(Math.random() * l.length) | 0], t: 1 };
  }
  function choc(){
    chocs++;
    rale();
    if(chocs === PONG_SEUIL) secousse = 18;      /* le moment où elle se vexe */
    /* elle s'énerve : ça accélère, mais d'un coup net et plafonné */
    const k = fache() ? 1.035 : 1.012;
    ball.vx = Math.max(-9, Math.min(9, ball.vx * k));
    ball.vy = Math.max(-9, Math.min(9, ball.vy * k));
    hud();
  }

  /* ⚠️ « onmousemove » ne se déclenche JAMAIS au doigt : la raquette restait
     plantée et le jeu était injouable sur téléphone. pointermove marche pour
     la souris ET le doigt. On écoute aussi pointerdown pour que la raquette
     saute sous le doigt dès le premier contact, sans attendre un glissement. */
  const suivre = e => {
    const r = cv.getBoundingClientRect();
    pad.x = (e.clientX - r.left) * (W / r.width);
  };
  cv.onpointermove = suivre;
  cv.onpointerdown = suivre;

  function pas(){
    ball.x += ball.vx; ball.y += ball.vy;
    if(ball.x - ball.r < 0){ ball.x = ball.r; ball.vx *= -1; choc(); }
    if(ball.x + ball.r > W){ ball.x = W - ball.r; ball.vx *= -1; choc(); }
    if(ball.y - ball.r < 0){ ball.y = ball.r; ball.vy *= -1; choc(); }
    /* raquette */
    if(ball.vy > 0 && ball.y + ball.r >= pad.y && ball.y + ball.r <= pad.y + pad.h + 12
       && ball.x > pad.x - pad.w / 2 - ball.r && ball.x < pad.x + pad.w / 2 + ball.r){
      ball.y = pad.y - ball.r;
      ball.vy *= -1;
      /* l'angle dépend du point d'impact : c'est ce qui rend le jeu jouable */
      ball.vx += ((ball.x - pad.x) / (pad.w / 2)) * 1.6;
      renvois++;
      choc();
    }
    if(ball.y - ball.r > H){
      vies--;
      hud();
      if(vies <= 0){ fin(); return; }
      relance();
    }
    if(bulle) bulle.t -= 0.016;
    if(bulle && bulle.t <= 0) bulle = null;
    if(secousse > 0) secousse--;
  }

  function mascotte(x, y, r, enColere){
    const ocean = enColere ? '#E23B3B' : '#3E93C9';
    const terre = enColere ? '#B22222' : '#6FBE5C';
    const bord  = enColere ? '#7A1414' : '#1C5A78';
    g.save();
    g.translate(x, y);
    g.beginPath(); g.arc(0, 0, r, 0, 7); g.fillStyle = ocean; g.fill();
    g.save(); g.clip();
    g.fillStyle = terre;
    g.beginPath(); g.ellipse(-r * .45, -r * .35, r * .34, r * .24, -.35, 0, 7); g.fill();
    g.beginPath(); g.ellipse(r * .40, r * .38, r * .26, r * .32, .2, 0, 7); g.fill();
    g.beginPath(); g.ellipse(r * .38, -r * .5, r * .34, r * .18, .1, 0, 7); g.fill();
    g.restore();
    g.lineWidth = Math.max(2, r * .11); g.strokeStyle = bord;
    g.beginPath(); g.arc(0, 0, r, 0, 7); g.stroke();
    /* yeux */
    g.fillStyle = '#fff';
    g.beginPath(); g.ellipse(-r * .28, -r * .06, r * .30, r * .38, 0, 0, 7); g.fill();
    g.beginPath(); g.ellipse(r * .30, -r * .06, r * .28, r * .36, 0, 0, 7); g.fill();
    g.fillStyle = '#0B0B10';
    g.beginPath(); g.arc(-r * .24, r * .02, r * .16, 0, 7); g.fill();
    g.beginPath(); g.arc(r * .34, r * .02, r * .15, 0, 7); g.fill();
    if(enColere){
      /* sourcils en accent circonflexe inversé : la colère se lit d'un coup */
      g.strokeStyle = '#7A1414'; g.lineWidth = Math.max(3, r * .13); g.lineCap = 'round';
      g.beginPath(); g.moveTo(-r * .62, -r * .52); g.lineTo(-r * .05, -r * .28); g.stroke();
      g.beginPath(); g.moveTo(r * .62, -r * .52);  g.lineTo(r * .05, -r * .28);  g.stroke();
    }
    g.restore();
  }

  function dessine(){
    g.clearRect(0, 0, W, H);
    const sx = secousse > 0 ? (Math.random() - .5) * 7 : 0;
    const sy = secousse > 0 ? (Math.random() - .5) * 7 : 0;
    g.save(); g.translate(sx, sy);

    /* fond : vire au rouge sombre quand elle est fâchée */
    g.fillStyle = fache() ? '#2A0E0E' : '#0E1726';
    g.fillRect(-10, -10, W + 20, H + 20);

    /* raquette */
    g.fillStyle = '#FFE600';
    g.strokeStyle = '#101010'; g.lineWidth = 4;
    g.fillRect(pad.x - pad.w / 2, pad.y, pad.w, pad.h);
    g.strokeRect(pad.x - pad.w / 2, pad.y, pad.w, pad.h);

    mascotte(ball.x, ball.y, ball.r, fache());

    /* bulle de bande dessinée : c'est la mascotte qui parle */
    if(bulle){
      g.font = '900 16px Fraunces, Georgia, serif';
      const w = g.measureText(bulle.txt).width + 22;
      const bx = Math.max(8, Math.min(W - w - 8, ball.x - w / 2));
      const by = Math.max(8, ball.y - ball.r - 42);
      g.globalAlpha = Math.max(0, Math.min(1, bulle.t * 1.6));
      g.fillStyle = '#fff'; g.strokeStyle = '#101010'; g.lineWidth = 3;
      g.beginPath(); g.roundRect(bx, by, w, 30, 9); g.fill(); g.stroke();
      g.fillStyle = fache() ? '#C81E1E' : '#101010';
      g.fillText(bulle.txt, bx + 11, by + 21);
      g.globalAlpha = 1;
    }
    g.restore();
  }

  function boucle(){
    if(!running) return;
    pas();
    if(!running) return;
    dessine();
    raf = requestAnimationFrame(boucle);
  }
  function fin(){
    running = false;
    cancelAnimationFrame(raf);
    const record = renvois > best;
    if(record) lsSet(LS_PONGBEST, String(renvois));
    $('#pongOverTitle').textContent = fache()
      ? (isEN() ? 'She’d had enough.' : 'Elle en avait assez.')
      : (isEN() ? 'You dropped me!' : 'Tu m’as laissée tomber !');
    $('#pongOverScore').textContent = record
      ? (isEN() ? '🎉 New best: ' : '🎉 Nouveau record : ') + renvois
      : (isEN() ? 'Returns: ' : 'Renvois : ') + renvois + (isEN() ? '  ·  your best: ' : '  ·  ton record : ') + best;
    $('#pongOver').hidden = false;
  }
  function demarre(){
    $('#pongStart').hidden = true;
    $('#pongOver').hidden = true;
    reset();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(boucle);
  }
  const go = $('#pongGo'); if(go) go.onclick = demarre;
  const rj = $('#pongReplay'); if(rj) rj.onclick = demarre;

  $('#pongStart').hidden = false;
  $('#pongOver').hidden = true;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#0E1726'; g.fillRect(0, 0, W, H);

  _pongStop = () => { running = false; cancelAnimationFrame(raf); };
}

/* ============================================================
   JEU 4 — « Bagage express »
   ------------------------------------------------------------
   Le tapis défile, la destination change en cours de route : ce qui était
   indispensable devient inutile. C'est tout le sel du jeu.
============================================================ */
const LS_PACKBEST = 'acolite_pack_best';
/* fractions de la durée où la destination bascule */
const PACK_VIRAGES = [2/3, 1/3];
const PACK_DEST = [
  { id:'plage',    ico:'🏖️', fr:'Plage',      en:'Beach' },
  { id:'montagne', ico:'⛰️', fr:'Montagne',   en:'Mountains' },
  { id:'ville',    ico:'🏙️', fr:'Ville',      en:'City' },
  { id:'froid',    ico:'❄️', fr:'Grand froid', en:'Deep cold' }
];
/* pour[] = destinations où l'objet est utile. Vide = jamais (les pièges). */
const PACK_OBJETS = [
  { ico:'🩱', fr:'Maillot',        en:'Swimsuit',      pour:['plage'] },
  { ico:'🩴', fr:'Tongs',          en:'Flip-flops',    pour:['plage'] },
  { ico:'🕶️', fr:'Lunettes',       en:'Sunglasses',    pour:['plage','montagne'] },
  { ico:'🧴', fr:'Crème solaire',  en:'Sunscreen',     pour:['plage','montagne'] },
  { ico:'🥾', fr:'Chaussures',     en:'Hiking boots',  pour:['montagne'] },
  { ico:'🎿', fr:'Skis',           en:'Skis',          pour:['montagne','froid'] },
  { ico:'🧤', fr:'Gants',          en:'Gloves',        pour:['montagne','froid'] },
  { ico:'🧣', fr:'Écharpe',        en:'Scarf',         pour:['montagne','froid'] },
  { ico:'🧥', fr:'Doudoune',       en:'Down jacket',   pour:['froid','montagne'] },
  { ico:'🧦', fr:'Chaussettes',    en:'Warm socks',    pour:['froid','montagne'] },
  { ico:'👔', fr:'Chemise',        en:'Shirt',         pour:['ville'] },
  { ico:'☂️', fr:'Parapluie',      en:'Umbrella',      pour:['ville'] },
  { ico:'🎫', fr:'Billets',        en:'Tickets',       pour:['ville'] },
  { ico:'📷', fr:'Appareil photo', en:'Camera',        pour:['plage','montagne','ville','froid'] },
  { ico:'🔌', fr:'Adaptateur',     en:'Adapter',       pour:['plage','montagne','ville','froid'] },
  { ico:'💊', fr:'Pharmacie',      en:'First aid',     pour:['plage','montagne','ville','froid'] },
  { ico:'🍳', fr:'Poêle',          en:'Frying pan',    pour:[] },
  { ico:'🪑', fr:'Chaise',         en:'Chair',         pour:[] },
  { ico:'🕯️', fr:'Bougie',         en:'Candle',        pour:[] },
  { ico:'🪴', fr:'Plante verte',   en:'House plant',   pour:[] }
];

let _packStop = null;
function openPack(){
  const ov = $('#ovPack'); if(!ov) return;
  ov.classList.add('show');
  packInit();
}
function packInit(){
  const cv = $('#packCanvas'); if(!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const DUREE = 40;              /* secondes */
  const BANDE = 150;             /* hauteur de la zone du tapis */
  let objets, score, dest, running, raf, reste, spawn, dernier, flashs, changeT, virages;

  let best = 0;
  try{ best = parseInt(localStorage.getItem(LS_PACKBEST), 10) || 0; }catch(e){}
  const bd = $('#packBest');
  if(bd){ bd.hidden = !best; bd.textContent = (isEN() ? 'Your best: ' : 'Ton record : ') + best; }

  const utile = o => o.pour.includes(dest.id);
  const destNom = d => isEN() ? d.en : d.fr;

  function hud(){
    $('#packDest').textContent = (isEN() ? 'Destination: ' : 'Destination : ') + dest.ico + ' ' + destNom(dest);
    $('#packScore').textContent = (isEN() ? 'Score: ' : 'Score : ') + score;
    $('#packTime').textContent = Math.max(0, Math.ceil(reste)) + ' s';
  }
  function changeDest(){
    const autres = PACK_DEST.filter(d => !dest || d.id !== dest.id);
    dest = autres[(Math.random() * autres.length) | 0];
    changeT = 1.4;               /* durée du bandeau d'annonce */
    hud();
  }
  function reset(){
    objets = []; score = 0; running = true; reste = DUREE;
    spawn = 0; dernier = performance.now(); flashs = [];
    virages = 0; dest = null; changeDest();
  }
  function pousse(){
    const o = PACK_OBJETS[(Math.random() * PACK_OBJETS.length) | 0];
    objets.push({ o, x: W + 40, y: H - BANDE / 2 + (Math.random() * 26 - 13), pris: false, r: 30 });
  }
  function flash(x, y, txt, bon){ flashs.push({ x, y, txt, bon, t: 1 }); }

  cv.onclick = e => {
    if(!running) return;
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (W / r.width);
    const my = (e.clientY - r.top) * (H / r.height);
    for(const it of objets){
      if(it.pris) continue;
      if(Math.hypot(it.x - mx, it.y - my) > it.r + 6) continue;
      it.pris = true;
      if(utile(it.o)){ score += 100; flash(it.x, it.y, '+100', true); }
      else { score = Math.max(0, score - 60); flash(it.x, it.y, '-60', false); }
      hud();
      return;
    }
  };

  function pas(dt){
    reste -= dt;
    if(reste <= 0){ fin(); return; }
    if(changeT > 0) changeT -= dt;
    /* La destination change deux fois dans la partie. On compare avec un SEUIL
       FRANCHI, pas avec une égalité approchée : une comparaison à ± une demi-
       image ne tombe presque jamais juste, et le changement — qui fait tout
       l'intérêt du jeu — ne se déclenchait qu'au hasard. */
    while(virages < PACK_VIRAGES.length && reste <= PACK_VIRAGES[virages] * DUREE){
      virages++;
      changeDest();
    }

    spawn += dt;
    /* le tapis accélère doucement : la fin est plus nerveuse que le début */
    const cadence = 0.95 - (1 - reste / DUREE) * 0.35;
    if(spawn >= cadence){ spawn = 0; pousse(); }

    const v = 118 + (1 - reste / DUREE) * 70;
    for(const it of objets){
      it.x -= v * dt;
      /* un objet utile qu'on laisse filer, ça coûte */
      if(!it.pris && it.x < -40){
        it.pris = true;
        if(utile(it.o)){ score = Math.max(0, score - 40); flash(30, it.y, '-40', false); hud(); }
      }
    }
    objets = objets.filter(it => it.x > -80 && !(it.pris && it.x < -40));
    for(const f of flashs) f.t -= dt * 1.6;
    flashs = flashs.filter(f => f.t > 0);
  }

  function dessine(){
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0E1726'; g.fillRect(0, 0, W, H);

    /* la valise, à gauche : c'est la cible mentale du joueur */
    g.font = '54px serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.globalAlpha = .25; g.fillText('🧳', 12, H - BANDE / 2); g.globalAlpha = 1;

    /* tapis roulant */
    g.fillStyle = '#1B2740';
    g.fillRect(0, H - BANDE, W, BANDE);
    g.strokeStyle = '#101010'; g.lineWidth = 4;
    g.strokeRect(0, H - BANDE, W, BANDE);
    g.strokeStyle = '#2C3B5C'; g.lineWidth = 3;
    for(let x = -((performance.now() / 14) % 44); x < W; x += 44){
      g.beginPath(); g.moveTo(x, H - BANDE + 6); g.lineTo(x, H - 6); g.stroke();
    }

    /* objets */
    g.textAlign = 'center';
    for(const it of objets){
      if(it.pris) continue;
      g.font = '40px serif';
      g.fillText(it.o.ico, it.x, it.y - 6);
      g.font = '900 12px Fraunces, Georgia, serif';
      g.fillStyle = '#F4F3EF';
      g.fillText(isEN() ? it.o.en : it.o.fr, it.x, it.y + 26);
    }

    /* gains et pertes */
    for(const f of flashs){
      g.globalAlpha = Math.max(0, f.t);
      g.font = '900 20px Fraunces, Georgia, serif';
      g.fillStyle = f.bon ? '#4ADE80' : '#FF5F5F';
      g.fillText(f.txt, f.x, f.y - 40 - (1 - f.t) * 26);
      g.globalAlpha = 1;
    }

    /* bandeau d'annonce quand la destination change */
    if(changeT > 0){
      g.globalAlpha = Math.min(1, changeT);
      g.fillStyle = '#FFE600';
      g.fillRect(0, H / 2 - 42, W, 74);
      g.strokeStyle = '#101010'; g.lineWidth = 4;
      g.strokeRect(0, H / 2 - 42, W, 74);
      g.fillStyle = '#101010';
      g.font = '900 26px Fraunces, Georgia, serif';
      g.fillText((isEN() ? 'Now: ' : 'Cap sur : ') + dest.ico + ' ' + destNom(dest), W / 2, H / 2 - 4);
      g.globalAlpha = 1;
    }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }

  function boucle(t){
    if(!running) return;
    const dt = Math.min(0.05, (t - dernier) / 1000);
    dernier = t;
    pas(dt);
    if(!running) return;
    dessine();
    hud();
    raf = requestAnimationFrame(boucle);
  }
  function fin(){
    running = false;
    cancelAnimationFrame(raf);
    const record = score > best;
    if(record) lsSet(LS_PACKBEST, String(score));
    $('#packOverTitle').textContent = score >= 900
      ? (isEN() ? '🏆 Packed like a pro' : '🏆 Valise de pro')
      : (isEN() ? '🧳 Bag closed' : '🧳 Valise bouclée');
    $('#packOverScore').textContent = record
      ? (isEN() ? '🎉 New best: ' : '🎉 Nouveau record : ') + score
      : (isEN() ? 'Score: ' : 'Score : ') + score + (isEN() ? '  ·  your best: ' : '  ·  ton record : ') + best;
    $('#packOver').hidden = false;
  }
  function demarre(){
    $('#packStart').hidden = true;
    $('#packOver').hidden = true;
    reset(); hud();
    cancelAnimationFrame(raf);
    dernier = performance.now();
    raf = requestAnimationFrame(boucle);
  }
  const go = $('#packGo'); if(go) go.onclick = demarre;
  const rj = $('#packReplay'); if(rj) rj.onclick = demarre;

  $('#packStart').hidden = false;
  $('#packOver').hidden = true;
  g.fillStyle = '#0E1726'; g.fillRect(0, 0, W, H);

  _packStop = () => { running = false; cancelAnimationFrame(raf); };
}

/* Fermeture : on coupe TOUJOURS la boucle du jeu concerné. Sans ça elle
   continue de tourner sur un canvas invisible. */
function arcadeStop(id){
  if(id === 'ovPong') _pongStop?.();
  if(id === 'ovPack') _packStop?.();
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-close]');
  if(c) arcadeStop(c.dataset.close);
  else if(e.target.classList?.contains('overlay')) arcadeStop(e.target.id);
});
document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  for(const id of ['ovArcade', 'ovGeo', 'ovPong', 'ovPack']){
    const ov = $('#' + id);
    if(ov?.classList.contains('show')){ arcadeStop(id); ov.classList.remove('show'); }
  }
});

/* ============================================================
   BLOGUE — lecture des articles, et liens depuis un voyage
   ------------------------------------------------------------
   Le générateur d'origine était une application React à part. Seule la
   consigne de rédaction a été gardée ; elle vit maintenant dans le backend,
   pilotée depuis le panel admin. Ici, on ne fait que LIRE.

   ⚠️ On ne reçoit JAMAIS de HTML rédigé par le modèle : le serveur renvoie des
   champs séparés (titre, sections, faits) et c'est nous qui les mettons en
   forme, en échappant tout au passage. Un article est du texte venu de
   l'extérieur : il est traité comme tel.
============================================================ */
const LS_BLOGIDX = 'acolyte_blog_index';
/* ⚠️ « var » et non « let », volontairement. renderRail() lit _blogListe pour
   compter les articles par catégorie, et il est déclaré ~1 900 lignes PLUS HAUT
   dans ce fichier — et appelé au démarrage. Avec « let », cette lecture tombait
   dans la zone morte : elle ne passait que parce que la catégorie active au
   démarrage n'est jamais « blog ». Un jour où ce ne serait plus vrai, l'app
   entière s'arrêterait sur une ReferenceError, sans rapport apparent avec le
   blog. « var » remonte la déclaration et ferme le piège.
   _blogCat est déclaré ici pour la même raison. */
var _blogListe = null;      /* liste des articles, en cache pour la session */
var _blogCat = '';          /* catégorie filtrée dans la colonne ('' = toutes) */
/* ⚠️ « var » ET PAS « let » — le voisin du dessus décrit le piège, celui-ci y
   était encore tombé. Le chemin est réel, pas théorique :
     loadPlan() → renderPlan → renderSections → panProgramme → blogLienHTML
     → blogPour() → lit _blogIdx
   panProgramme vit vers la ligne 3030, soit 7 500 lignes AVANT cette
   déclaration. Quand un plan est déjà en cache, loadPlan() rend la main
   SYNCHRONEMENT (le raccourci « if(state.cache.plan) renderPlan(...) » est en
   tête, avant tout await) : tout ce chemin s'exécute donc pendant l'évaluation
   du fichier, alors que `let` laisse encore _blogIdx en zone morte.
   → « Cannot access '_blogIdx' before initialization », et le plan ne
   s'affichait plus du tout. Avec « var » la déclaration remonte, la valeur est
   `undefined`, blogPour() renvoie null, et le programme s'affiche simplement
   sans les icônes d'article jusqu'à ce que l'index arrive. Dégrader, pas
   casser — la même règle que partout ailleurs ici. */
var _blogIdx = null;        /* index léger : sert à repérer les lieux qui ont un article */

/* Index des lieux qui ont un article. Gardé en mémoire ET dans le stockage :
   il sert à chaque affichage du programme, on ne va pas le redemander. */
async function blogIndex(){
  if(_blogIdx) return _blogIdx;
  try{
    const cache = JSON.parse(localStorage.getItem(LS_BLOGIDX) || 'null');
    /* on garde 12 h : un article nouvellement publié apparaît le lendemain
       au plus tard, et on n'interroge pas le serveur à chaque page */
    if(cache && Date.now() - cache.quand < 12 * 3600e3){ _blogIdx = cache.index; return _blogIdx; }
  }catch(e){}
  const r = await srvFetch('/blog/index');
  _blogIdx = (r.ok && Array.isArray(r.data?.index)) ? r.data.index : [];
  lsSet(LS_BLOGIDX, JSON.stringify({ quand: Date.now(), index: _blogIdx }));
  return _blogIdx;
}
/* Retrouve l'article qui parle d'un lieu. On compare sur la forme réduite
   (sans accents ni casse), comme pour les lieux de la carte. */
function blogPour(nom){
  if(!_blogIdx || !nom) return null;
  const n = normPlace(nom);
  if(n.length < 3) return null;
  return _blogIdx.find(a => normPlace(a.sujet) === n)
      || _blogIdx.find(a => { const s = normPlace(a.sujet); return s.length >= 4 && (s.includes(n) || n.includes(s)); })
      || null;
}
/* Le lien à coller à côté d'un lieu. Vide si aucun article : on n'affiche
   jamais un lien mort. */
function blogLienHTML(nom){
  const a = blogPour(nom);
  if(!a) return '';
  return ` <button class="blog-link" data-blogopen="${esc(a.slug)}"
    title="${esc(isEN() ? 'Read the article' : 'Lire l’article')} : ${esc(a.titre)}">📰</button>`;
}

/* ⚠️ « var » et fonction déclarée, pour la même raison que _blogListe :
   renderRail() s'en sert bien plus haut dans le fichier. Un « const » les
   mettrait en zone morte au démarrage. */
var BLOG_CATS_FR = { nature:'Merveille naturelle', bati:'Merveille bâtie', ville:'Grande ville' };
function blogCatNom(c){
  return isEN()
    ? ({ nature:'Natural wonder', bati:'Built wonder', ville:'Great city' })[c] || 'Article'
    : BLOG_CATS_FR[c] || 'Article';
}

/* ============================================================
   TOUJOURS UNE IMAGE
   ------------------------------------------------------------
   Wikipédia n'illustre pas tout : certains sujets n'ont aucune photo libre, et
   l'article s'affichait alors avec un 📰 gris translucide — on lisait « image
   manquante », pas « article ».

   Quand la photo manque, on DESSINE une couverture. Elle n'est pas aléatoire :
   sa teinte est calculée à partir du slug, donc un article garde toujours la
   même — un lecteur le reconnaît d'une visite à l'autre. Et comme c'est du SVG
   écrit sur place, elle marche hors-ligne, ne coûte aucune requête, et ne peut
   pas casser.

   ⚠️ Pas de data:URI ni de <img> : un <svg> en ligne évite toute question de
   politique de sécurité, et reste net à n'importe quelle taille.
============================================================ */
/* Teinte stable tirée du texte. Un simple cumul suffit : on ne cherche pas une
   fonction de hachage solide, seulement un nombre reproductible. */
function blogTeinte(txt){
  let h = 0;
  for(const c of String(txt || 'acolyte')) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}
const BLOG_EMOJI = { nature:'🏔️', bati:'🏛️', ville:'🌆' };
function blogVisuel(a, ou){
  /* La photo n'est acceptée QUE depuis Wikimédia : l'adresse arrive par le
     réseau, donc de l'extérieur. Tout le reste est refusé. */
  const photo = /^https:\/\/upload\.wikimedia\.org\//.test(String(a.image || '')) ? a.image : '';
  if(photo){
    const alt = ou === 'liste' ? '' : esc(a.sujet || a.titre || '');
    return `<img src="${esc(photo)}" alt="${alt}" ${ou === 'liste' ? 'loading="lazy"' : ''} referrerpolicy="no-referrer">`;
  }
  const h = blogTeinte(a.slug || a.titre);
  const emo = BLOG_EMOJI[a.categorie] || '🧭';
  /* deux teintes voisines : un dégradé lisible, jamais criard */
  const c1 = `hsl(${h} 42% 26%)`, c2 = `hsl(${(h + 42) % 360} 46% 14%)`;
  const id = 'bgv' + h + (ou === 'liste' ? 'l' : 'a');
  return `<svg class="bc-dessin" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice"
       role="img" aria-label="${esc((a.sujet || a.titre || '') + ' — illustration générée')}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#${id})"/>
    <!-- une ligne d'horizon : de quoi évoquer un paysage sans rien représenter de faux -->
    <path d="M0 132 L74 100 L128 126 L196 84 L262 118 L320 96 L320 180 L0 180 Z"
          fill="rgba(0,0,0,.22)"/>
    <circle cx="258" cy="46" r="17" fill="rgba(255,230,0,.30)"/>
    <text x="160" y="86" text-anchor="middle" font-size="46">${emo}</text>
  </svg>`;
}

async function openBlog(){
  const liste = $('#blogList'), une = $('#blogOne');
  $('#blogBack')?.classList.add('hidden');
  une?.classList.add('hidden');
  liste?.classList.remove('hidden');
  /* liste déjà en cache : on redessine aussi la colonne, sinon les compteurs
     resteraient à zéro au retour sur l'onglet */
  if(_blogListe){ renderBlogListe(_blogListe); renderRail(); return; }
  if(liste) liste.innerHTML = loaderHTML(isEN() ? 'Fetching the articles…' : 'Récupération des articles…');
  const r = await srvFetch('/blog');
  if(!r.ok){
    if(liste) liste.innerHTML = errHTML(isEN() ? 'The journal is unreachable right now.' : 'Le journal est injoignable pour le moment.');
    return;
  }
  _blogListe = r.data?.articles || [];
  renderBlogListe(_blogListe);
  /* ⚠️ La colonne AUSSI. Elle est dessinée par switchCat('blog'), donc AVANT que
     la liste n'arrive du réseau : ses compteurs affichaient tous « 0 » et toutes
     les catégories paraissaient vides. C'est ici, et seulement ici, qu'on sait
     enfin combien d'articles il y a. */
  renderRail();
  /* on remonte le réveil du générateur, sans faire attendre le lecteur */
  blogTick().catch(() => {});
}
/* ============================================================
   LE JOURNAL — MISE EN PAGE ÉDITORIALE
   ------------------------------------------------------------
   Un article EN TÊTE, les autres en trois colonnes. C'était une simple pile de
   fiches identiques : rien ne ressortait, et le journal ressemblait à une liste
   de résultats plutôt qu'à un journal.

   ⚠️ Beaucoup d'air et des filets d'un pixel, pas de cartes empilées : c'est la
   direction « éditorial » du reste de l'app (même langage que l'écran de
   compte). Ne rajoute pas de fond aux fiches — c'est le blanc entre elles qui
   fait la hiérarchie.
============================================================ */
/* La date, écrite comme dans un journal : « 2 août 2026 » et non « 02/08/2026 ». */
function blogDate(q){
  if(!q) return '';
  const d = new Date(q);
  if(isNaN(d)) return '';
  return d.toLocaleDateString(LOC(), { day:'numeric', month:'long', year:'numeric' });
}
const ICO_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="mi" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M8 3v3.6M16 3v3.6M3.5 10h17"/></svg>';
const ICO_CLK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="mi" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 2"/></svg>';

function renderBlogListe(arts){
  const liste = $('#blogList');
  if(!liste) return;
  const EN = isEN();
  /* Le filtre de la colonne s'applique ici, jamais sur la liste en cache :
     _blogListe doit rester complète pour que les compteurs restent justes. */
  const vus = (_blogCat ? arts.filter(a => a.categorie === _blogCat) : arts.slice());

  if(!vus.length){
    liste.innerHTML = `<div class="blog-vide"><p>${
      _blogCat ? (EN ? 'Nothing in this section yet.' : 'Rien encore dans cette rubrique.')
               : (EN ? 'No article published yet — come back soon.'
                     : 'Aucun article publié pour l’instant — reviens bientôt.')}</p></div>`;
    return;
  }

  const meta = (a) => `<span class="bc-meta">
      ${a.quand ? `<span>${ICO_CAL}${esc(blogDate(a.quand))}</span>` : ''}
      ${a.lecture ? `<span>${ICO_CLK}${esc(a.lecture)}</span>` : ''}
    </span>`;

  /* ---- L'article en tête ---- */
  const une = vus[0];
  const tete = `
    <button class="blog-une" data-blogopen="${esc(une.slug)}">
      <span class="bu-img">${blogVisuel(une, 'liste')}</span>
      <span class="bu-txt">
        <span class="bu-badge">${EN ? 'Featured' : 'À la une'} · ${esc(blogCatNom(une.categorie))}</span>
        <b class="bu-titre">${esc(une.titre)}</b>
        <span class="bu-sous">${esc(une.resume || une.sous_titre || '')}</span>
        ${meta(une)}
      </span>
    </button>`;

  /* ---- Les autres, en trois colonnes ---- */
  const grille = vus.slice(1).map(a => `
    <button class="blog-card" data-blogopen="${esc(a.slug)}">
      <span class="bc-img">${blogVisuel(a, 'liste')}</span>
      <span class="bc-cat">${esc(blogCatNom(a.categorie))}</span>
      <b class="bc-titre">${esc(a.titre)}</b>
      <span class="bc-sous">${esc(a.resume || a.sous_titre || '')}</span>
      ${meta(a)}
    </button>`).join('');

  liste.innerHTML = tete + (grille ? `<div class="blog-grille">${grille}</div>` : '');
}

async function openArticle(slug){
  switchCat('blog');
  const liste = $('#blogList'), une = $('#blogOne');
  liste?.classList.add('hidden');
  une?.classList.remove('hidden');
  $('#blogBack')?.classList.remove('hidden');
  if(une) une.innerHTML = loaderHTML(isEN() ? 'Opening the article…' : 'Ouverture de l’article…');
  const r = await srvFetch('/blog/article?slug=' + encodeURIComponent(slug));
  if(!r.ok || !r.data?.article){
    /* ⚠️ PAS D'IMPASSE. Ce chemin est emprunté depuis L'EXTÉRIEUR — le jeu des
       merveilles envoie « ?a=tour-de-pise » sans pouvoir savoir si l'article
       existe (il est sur un autre domaine, il ne peut pas interroger le
       serveur). Un simple message d'erreur laissait le visiteur sur un écran
       mort, arrivé d'un autre site, sans rien à faire. On lui propose donc le
       journal, qui est ce qu'il cherchait. */
    if(une) une.innerHTML = `
      <div class="card">
        <h2 style="margin:0 0 8px">${isEN() ? 'Not written yet' : 'Pas encore écrit'}</h2>
        <p class="hint" style="margin:0 0 14px">${isEN()
          ? 'Acolyte has not covered this one yet — its journal fills up on its own, come back soon. Meanwhile, here is what is already there.'
          : 'Acolyte n’a pas encore traité celui-là — son journal se remplit tout seul, repasse bientôt. En attendant, voici ce qui existe déjà.'}</p>
        <button class="btn" id="blogVersListe" style="width:100%;justify-content:center">${ICO('document',15)} ${
          isEN() ? 'Browse the journal' : 'Parcourir le journal'}</button>
      </div>`;
    const b = $('#blogVersListe');
    if(b) b.onclick = () => { history.pushState({}, '', './'); seoAccueil(); openBlog(); };
    return;
  }
  const a = r.data.article;
  /* Tout est échappé : ce texte vient d'un modèle, donc de l'extérieur.
     Les paragraphes sont découpés sur les retours à la ligne — on ne fait
     JAMAIS confiance à un balisage fourni. */
  const paras = t => String(t || '').split(/\n{1,}/).filter(p => p.trim())
    .map(p => `<p>${esc(p.trim())}</p>`).join('');
  /* L'illustration vient de Wikimédia et de nulle part ailleurs — c'est
     VÉRIFIÉ dans blogVisuel(), pas supposé. Faute de photo, une couverture est
     dessinée : un article n'apparaît JAMAIS sans image d'en-tête. */
  const aPhoto = /^https:\/\/upload\.wikimedia\.org\//.test(String(a.image || ''));
  une.innerHTML = `
    <figure class="art-hero${aPhoto ? '' : ' art-hero-dessin'}">${blogVisuel(a, 'article')}
      ${aPhoto && a.credit ? `<figcaption>Photo · ${esc(a.credit)}</figcaption>` : ''}</figure>`.replace(/\s+$/, '') + `
    <span class="bc-cat">${esc(blogCatNom(a.categorie))}</span>
    <h1 class="art-titre">${esc(a.titre)}</h1>
    ${a.sous_titre ? `<p class="art-sous">${esc(a.sous_titre)}</p>` : ''}
    <p class="art-meta">${esc(a.lecture || '')}${a.quand ? ' · ' + new Date(a.quand).toLocaleDateString(LOC()) : ''}</p>
    ${a.resume ? `<p class="art-resume">${esc(a.resume)}</p>` : ''}
    ${(a.faits || []).length ? `<div class="art-faits">${a.faits.map(f =>
      `<div class="af"><span class="af-k">${esc(f.label)}</span><span class="af-v">${esc(f.valeur)}</span></div>`).join('')}</div>` : ''}
    ${artSommaireHTML(a)}
    ${(a.sections || []).map((s, i) => `<section class="art-sec" id="sec-${i}"><h2>${esc(s.titre)}</h2>${paras(s.texte)}</section>`).join('')}
    ${(a.tags || []).length ? `<div class="art-tags">${a.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${artPiedHTML(a, slug)}
    <p class="hint art-note">${isEN()
      ? 'Article written by Acolyte. Figures are given for guidance — check them before you rely on them.'
      : 'Article rédigé par Acolyte. Les chiffres sont donnés à titre indicatif — vérifie-les avant de t’y fier.'}</p>`;
  artPiedBranche(a, slug);
  seoArticle(a, slug);
  window.scrollTo({ top:0, behavior:'smooth' });
}

/* ============================================================
   LE PIED D'ARTICLE — LIRE, PUIS PARTIR
   ------------------------------------------------------------
   ⚠️ LE CHAÎNON QUI MANQUAIT. Le point d'entrée « ?lieu= » existait, mais seul
   le jeu des merveilles s'en servait. Un lecteur qui venait de lire quatre
   sections sur Kyoto n'avait AUCUN moyen de dire « emmène-moi là » : il devait
   revenir au questionnaire et retaper le nom. L'article donnait l'envie et ne
   faisait rien de cette envie.

   Deux boutons, et pas plus : partir, ou partager. Un pied d'article encombré
   ne fait cliquer sur rien.
============================================================ */
/* Sommaire d'un article : cinq sections denses sans aucun repère, on ne sait
   pas où l'on va. ⚠️ Sous trois sections on ne l'affiche pas — un sommaire de
   deux lignes au-dessus de deux titres est du bruit. */
function artSommaireHTML(a){
  const s = a.sections || [];
  if(s.length < 3) return '';
  return `<nav class="art-som" aria-label="${isEN() ? 'In this article' : 'Dans cet article'}">
    <p class="art-som-t">${isEN() ? 'In this article' : 'Dans cet article'}</p>
    <ol>${s.map((x, i) =>
      `<li><a href="#sec-${i}">${esc(x.titre || '')}</a></li>`).join('')}</ol>
  </nav>`;
}

function artPiedHTML(a, slug){
  const sujet = String(a.sujet || a.titre || '').trim();
  const EN = isEN();
  /* Le partage natif n'existe pas partout (ordinateurs surtout) : on ne
     propose le bouton que s'il peut vraiment servir, plutôt que d'afficher un
     bouton qui échoue. Le repli est la copie du lien. */
  const partageNatif = typeof navigator.share === 'function';
  return `
    <div class="art-pied">
      ${sujet ? `<button class="btn" id="artVoyage">${ICO('avion',15)} ${EN
        ? `Plan a trip to ${esc(sujet)}` : `Partir à ${esc(sujet)}`}</button>` : ''}
      <button class="btn ghost" id="artPartage">${partageNatif
        ? (EN ? '↗ Share' : '↗ Partager')
        : (EN ? '🔗 Copy the link' : '🔗 Copier le lien')}</button>
    </div>`;
}
function artPiedBranche(a, slug){
  const sujet = String(a.sujet || a.titre || '').trim();
  const v = $('#artVoyage');
  if(v) v.onclick = () => {
    /* On reste DANS l'app : pas besoin de repasser par une adresse, on appelle
       directement ce que ?lieu= déclenche. Recharger la page ferait perdre
       l'état et clignoter l'écran pour rien. */
    ouvreAvecLieu(sujet.slice(0, 60));
  };
  const p = $('#artPartage');
  if(p) p.onclick = async () => {
    const url = SEO_BASE + '?a=' + encodeURIComponent(slug);
    const titre = String(a.titre || 'Acolyte');
    try{
      if(typeof navigator.share === 'function'){
        await navigator.share({ title: titre, text: String(a.resume || '').slice(0, 160), url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast(isEN() ? '🔗 Link copied' : '🔗 Lien copié');
    }catch(e){
      /* Un partage ANNULÉ lève aussi : on ne montre donc pas d'erreur, ce
         serait accuser l'utilisateur d'avoir changé d'avis. */
      if(e && e.name === 'AbortError') return;
      toast(isEN() ? 'Could not share — here is the link: ' + url
                   : 'Partage impossible — voici le lien : ' + url);
    }
  };
}

/* ============================================================
   RÉFÉRENCEMENT DES ARTICLES
   ------------------------------------------------------------
   ⚠️ Le problème que ça règle : tous les articles vivaient derrière LA MÊME
   adresse. Impossible d'en partager un, impossible pour Google d'en indexer
   un seul — le site entier n'avait qu'une URL et qu'un titre. Chaque article
   a maintenant la sienne (?a=le-slug), son titre, son résumé et sa fiche
   BlogPosting. C'est ce qui les rend trouvables.

   Pourquoi une PARAMÈTRE et pas un dossier : le site est hébergé en statique
   (GitHub Pages), il n'y a pas de serveur pour router /blog/xxx vers
   index.html. Un paramètre marche sans serveur, et Google l'indexe très bien.
============================================================ */
const SEO_BASE = 'https://lechat45.github.io/Acolyte/';
/* Les valeurs d'origine, pour pouvoir TOUT remettre en quittant l'article :
   sans ça, la page d'accueil garderait le titre du dernier article lu. */
const _seoDefaut = {
  titre: document.title,
  desc: $('meta[name="description"]')?.content || '',
  canon: $('link[rel="canonical"]')?.href || SEO_BASE,
  ogTitre: $('meta[property="og:title"]')?.content || '',
  ogDesc: $('meta[property="og:description"]')?.content || '',
  ogUrl: $('meta[property="og:url"]')?.content || SEO_BASE,
  ogImg: $('meta[property="og:image"]')?.content || '',
  ogType: $('meta[property="og:type"]')?.content || 'website',
};
function _seoPose(sel, attr, val){ const e = $(sel); if(e) e[attr] = val; }
function seoArticle(a, slug){
  const titre = `${a.titre} — Acolyte`;
  const desc = String(a.resume || a.sous_titre || '').slice(0, 300);
  const url = SEO_BASE + '?a=' + encodeURIComponent(slug);
  document.title = titre;
  _seoPose('meta[name="description"]', 'content', desc);
  _seoPose('link[rel="canonical"]', 'href', url);
  _seoPose('meta[property="og:title"]', 'content', titre);
  _seoPose('meta[property="og:description"]', 'content', desc);
  _seoPose('meta[property="og:url"]', 'content', url);
  _seoPose('meta[property="og:type"]', 'content', 'article');
  if(/^https:\/\/upload\.wikimedia\.org\//.test(String(a.image || '')))
    _seoPose('meta[property="og:image"]', 'content', a.image);
  /* L'adresse dans la barre suit : l'article devient partageable, et le bouton
     « retour » du navigateur ramène à la liste au lieu de quitter le site. */
  try{ history.pushState({ article: slug }, '', './?a=' + encodeURIComponent(slug)); }catch(e){}
  seoJsonLd({
    '@context':'https://schema.org', '@type':'BlogPosting',
    headline: String(a.titre || '').slice(0, 110),
    description: desc,
    datePublished: a.quand ? new Date(a.quand).toISOString() : undefined,
    image: /^https:\/\/upload\.wikimedia\.org\//.test(String(a.image || '')) ? a.image : undefined,
    inLanguage: isEN() ? 'en' : 'fr-FR',
    mainEntityOfPage: { '@type':'WebPage', '@id': url },
    author: { '@type':'Organization', name:'Acolyte', url: SEO_BASE },
    publisher: { '@type':'Organization', name:'Acolyte', url: SEO_BASE },
    keywords: (a.tags || []).join(', ') || undefined,
  });
}
function seoAccueil(){
  document.title = _seoDefaut.titre;
  _seoPose('meta[name="description"]', 'content', _seoDefaut.desc);
  _seoPose('link[rel="canonical"]', 'href', _seoDefaut.canon);
  _seoPose('meta[property="og:title"]', 'content', _seoDefaut.ogTitre);
  _seoPose('meta[property="og:description"]', 'content', _seoDefaut.ogDesc);
  _seoPose('meta[property="og:url"]', 'content', _seoDefaut.ogUrl);
  _seoPose('meta[property="og:image"]', 'content', _seoDefaut.ogImg);
  _seoPose('meta[property="og:type"]', 'content', _seoDefaut.ogType);
  seoJsonLd(null);
}
/* Une SEULE fiche à la fois : on remplace, on n'empile pas. Deux BlogPosting
   dans la même page et Google ne sait plus lequel décrit l'article. */
function seoJsonLd(obj){
  let s = $('#ldArticle');
  if(!obj){ s?.remove(); return; }
  if(!s){ s = document.createElement('script'); s.type = 'application/ld+json'; s.id = 'ldArticle'; document.head.appendChild(s); }
  s.textContent = JSON.stringify(obj, (k, v) => v === undefined ? undefined : v);
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-blogopen]');
  if(b){ openArticle(b.dataset.blogopen); return; }
  if(e.target.closest('#blogBack')){ history.pushState({}, '', './'); seoAccueil(); openBlog(); }
});

/* Le lien du pied de page reste un VRAI lien (href="./") : sans JavaScript il
   ramène à l'accueil, et un robot le suit. Avec JavaScript, il ouvre l'onglet
   sans recharger la page. */
const _fb = $('#footBlog');
if(_fb) _fb.onclick = e => { e.preventDefault(); switchCat('blog'); };
/* Les mentions légales s'ouvrent en lecture (pas en mode « accepte ou sors ») :
   on doit pouvoir les consulter sans être forcé à valider quoi que ce soit. */
const _fl = $('#footLegal');
if(_fl) _fl.onclick = e => { e.preventDefault(); openPrivacy(false); };

/* ---- L'adresse fait foi ---- */
/* Un lien reçu (?a=le-slug) doit ouvrir DIRECTEMENT l'article : c'est ce que
   fera Googlebot, et c'est ce qu'attend quelqu'un qui reçoit le lien. Le slug
   est filtré avant tout usage — il vient de l'extérieur. */
const SLUG_OK = /^[a-z0-9][a-z0-9-]{0,79}$/;
function blogRouteURL(){
  const p = new URLSearchParams(location.search).get('a');
  return p && SLUG_OK.test(p) ? p : null;
}
/* Les boutons « précédent / suivant » du navigateur restent cohérents. */
window.addEventListener('popstate', () => {
  const slug = blogRouteURL();
  if(slug) openArticle(slug);
  else { seoAccueil(); if(_cat === 'blog') openBlog(); }
});
/* ============================================================
   ARRIVER DEPUIS L'EXTÉRIEUR AVEC UN LIEU EN TÊTE  (?lieu=…)
   ------------------------------------------------------------
   Le jeu des merveilles est un site SÉPARÉ. Quand un joueur vient de
   reconnaître le Taj Mahal, il doit pouvoir dire « emmène-moi là » en un clic :
   ce point d'entrée pré-remplit la destination et le dépose sur le
   questionnaire, prêt à partir.

   ⚠️ Le paramètre vient de l'EXTÉRIEUR : on le borne avant tout usage. Pas de
   chiffre, pas d'arobase, pas d'adresse web, 60 caractères au plus — les mêmes
   règles que pour un nom de pays. Sans ça, n'importe qui pourrait faire écrire
   ce qu'il veut dans le champ par un simple lien.
   ⚠️ On n'INJECTE jamais ce texte en HTML : il va dans la VALEUR d'un champ,
   ce qui ne peut rien exécuter.
============================================================ */
const LIEU_OK = /^[\p{L}][\p{L}\p{M}\s'’\-.()]{1,59}$/u;
function lieuDeLURL(){
  const p = new URLSearchParams(location.search).get('lieu');
  if(!p) return null;
  const v = p.normalize('NFC').trim().replace(/\s+/g, ' ');
  if(!LIEU_OK.test(v) || /\d|@|https?:|www\./i.test(v)) return null;
  return v;
}
function ouvreAvecLieu(lieu){
  const d = $('#fDest');
  if(!d) return;
  d.value = lieu;
  state.prefs = state.prefs || {};
  state.prefs.dest = lieu;
  save();
  switchCat('trip');
  gotoStep(1);
  /* ⚠️ On remet le titre et les métadonnées de l'accueil. Sans ça, quitter un
     article par « Partir à … » laissait l'onglet du navigateur au nom de
     l'article alors qu'on est revenu au questionnaire — et la canonique
     désignait encore l'article. */
  seoAccueil();
  /* on met le champ en évidence : sinon le voyageur ne voit pas ce qui a
     changé et croit que le lien n'a rien fait */
  d.scrollIntoView({ behavior:'smooth', block:'center' });
  d.classList.add('field-neuf');
  setTimeout(() => d.classList.remove('field-neuf'), 2400);
  toast(isEN() ? `📍 ${lieu} is set — tell us the rest.`
                : `📍 ${lieu} est noté — dis-nous le reste.`);
  /* l'adresse est nettoyée : recharger la page ne doit pas re-déclencher */
  try{ history.replaceState(null, '', location.pathname); }catch(e){}
}

/* Au chargement : si l'adresse désigne un article, on l'ouvre ; si elle porte
   un lieu, on pré-remplit. En différé, pour laisser le démarrage se terminer. */
setTimeout(() => {
  const slug = blogRouteURL();
  if(slug){ openArticle(slug); return; }
  const lieu = lieuDeLURL();
  if(lieu) ouvreAvecLieu(lieu);
}, 0);

/* On charge l'index au démarrage, sans bloquer : il sert à décorer le
   programme. S'il arrive APRÈS l'affichage du plan, on redessine la barre
   d'onglets pour que les liens apparaissent — mais uniquement elle, jamais
   tout le plan, sinon on perdrait les journées dépliées et les commentaires
   en cours de frappe. */
blogIndex().then(idx => {
  if(idx.length && state.cache?.plan && _planTab === 'programme') renderSections(state.cache.plan);
}).catch(() => {});

/* ---- Le battement du générateur ----
   Le serveur écrit un article tout seul, à intervalle régulier. Encore
   faut-il que quelqu'un vienne « remonter le réveil » : cet appel le fait,
   discrètement, quand un visiteur ouvre le journal.
   Le serveur REFUSE de travailler si le délai n'est pas écoulé — appeler
   souvent ne coûte donc rien et ne peut pas emballer la machine.
   Si un nouvel article vient de paraître, on rafraîchit la liste pour qu'il
   s'affiche tout de suite. */
let _tickEnCours = false;
let _tickAbandonne = false;   /* backend sans la route : on n'insiste pas */
async function blogTick(){
  /* Si le serveur ne connaît pas encore la route (backend pas redéployé), on
     arrête pour de bon : sinon chaque visiteur salit sa console d'un 404 à
     chaque ouverture du journal. */
  if(_tickAbandonne) return;
  /* ⚠️ Garde-fou contre la boucle : le battement recharge la liste, et
     recharger la liste rebat. Le serveur coupe déjà la chaîne (il pose son
     jalon avant d'écrire), mais on ne fait pas dépendre l'absence de boucle
     infinie d'un comportement distant. Un seul battement à la fois. */
  if(_tickEnCours) return;
  _tickEnCours = true;
  try{
    const r = await srvFetch('/blog/tick');
    if(r.status === 404){ _tickAbandonne = true; return; }
    if(r.ok && r.data?.fait){
      _blogListe = null;               /* la liste a changé */
      _blogIdx = null;
      try{ localStorage.removeItem(LS_BLOGIDX); }catch(e){}
      if(!$('#catBlog')?.classList.contains('hidden')) await openBlog();
    }
  }finally{ _tickEnCours = false; }
}

/* ============================================================
   BARRE DU HAUT — LE CÔTÉ DROIT (thème · installation · compte)
   ------------------------------------------------------------
   Trois raccourcis, aucun réglage qui n'existe QUE là : le thème,
   l'installation et le compte sont tous les trois dans l'onglet Profil, où le
   téléphone les trouve. C'est délibéré — un bouton présent seulement sur
   ordinateur crée deux applications différentes.

   ⚠️ Les trois boutons ne sont pas dessinés en dessous de 900 px (le CSS met
   .navtools en display:none). Le JavaScript, lui, tourne partout : il ne faut
   donc RIEN faire dépendre de leur visibilité, et surtout ne pas y mettre
   l'unique chemin vers une fonction.
============================================================ */
function majNavTools(){
  const u = (typeof getUser === 'function') ? getUser() : null;
  const av = $('#ntAv'), nom = $('#ntNom');
  if(av && nom){
    if(u){
      const p = u.pseudo || (u.email || '').split('@')[0] || '?';
      /* Array.from et non p[0] : une initiale peut être un emoji ou une lettre
         accentuée composée, que l'indexation couperait en deux moitiés
         illisibles. */
      av.textContent = (Array.from(p)[0] || '?').toUpperCase();
      nom.textContent = p;
    }else{
      av.textContent = '?';
      nom.textContent = isEN() ? 'Sign in' : 'Se connecter';
    }
  }
  /* Le bouton d'installation ne s'affiche que s'il y a quelque chose à
     installer : proposer d'installer une application déjà installée est une
     promesse vide. Même test que le bouton du profil. */
  const proposable = pwaProposable();
  /* Les DEUX boutons d'installation décidés au même endroit : celui de la barre
     du haut et celui de l'en-tête du compte (maquette 1g). Deux tests séparés,
     c'est la garantie qu'un jour l'un des deux proposera d'installer une app
     déjà installée. */
  ['#ntInstall', '#pfInstTop'].forEach(sel => {
    const b = $(sel);
    if(b) b.style.display = proposable ? '' : 'none';
  });
  /* La ligne du Discord n'apparaît que si l'adresse est renseignée dans
     config.js. Proposer « rejoindre la communauté » et ouvrir une page morte est
     pire que ne rien proposer — c'est la même règle que pour l'installation et
     pour les liens d'affiliation : une invitation qu'on ne peut pas honorer ne
     s'affiche pas. */
  const dOk = !!discordURL();
  /* Les DEUX entrées vers le Discord décidées ici : la ligne de la liste
     d'actions et le bouton du bloc « Aide Acolyte à grandir ». Deux tests
     séparés, c'est la garantie qu'un jour l'un des deux montrera un lien mort. */
  [['#pfDiscordRow', ''], ['#phDiscord', 'inline-flex']].forEach(([sel, aff]) => {
    const e = $(sel);
    if(e) e.style.display = dOk ? aff : 'none';
  });
}
/* Une seule lecture de l'adresse, avec le même repli que les autres réglages :
   config.js d'abord, localStorage pour tester sans toucher au fichier. */
function discordURL(){
  const c = window.ACOLITE_KEYS || {};
  let u = '';
  try{ u = String(c.discord || localStorage.getItem('acolite_discord') || '').trim(); }
  catch(e){ u = String(c.discord || '').trim(); }
  /* ⚠️ On n'ouvre QUE du https, et seulement vers Discord. Cette valeur vient
     d'un fichier de configuration, mais elle finit dans un window.open : si un
     jour elle est remplie depuis ailleurs, on ne veut pas d'un javascript: */
  return /^https:\/\/(discord\.gg|discord\.com|invite\.gg)\//i.test(u) ? u : '';
}
{
  const t = $('#ntTheme'); if(t) t.onclick = basculeTheme;
  const i = $('#ntInstall'); if(i) i.onclick = () => openInstall();
  const i2 = $('#pfInstTop'); if(i2) i2.onclick = () => openInstall();
  /* Un seul gestionnaire pour les deux boutons : la validation de l'adresse et
     le noopener ne doivent exister qu'à un endroit. */
  const ouvreDiscord = () => {
    const u = discordURL();
    /* noopener : sans lui, la page ouverte peut manipuler celle d'Acolyte */
    if(u) window.open(u, '_blank', 'noopener,noreferrer');
  };
  const dc = $('#pfDiscord'); if(dc) dc.onclick = ouvreDiscord;
  const dp = $('#phDiscord'); if(dp) dp.onclick = ouvreDiscord;
  const m = $('#ntMe'); if(m) m.onclick = () => switchCat('profile');
  majNavTools();
}

/* ============================================================
   FOND FIGÉ QUAND UN CALQUE EST OUVERT
   ------------------------------------------------------------
   Sans ça, faire défiler par-dessus une fenêtre modale fait défiler la PAGE
   derrière : on rouvre le calque sur un contenu qui a bougé, et sur téléphone
   on croit que le calque saute.

   ⚠️ Un SEUL observateur, pas un verrou posé à chaque ouverture. Les calques
   s'ouvrent depuis des dizaines d'endroits en ajoutant la classe « show » ;
   poser et retirer le verrou dans chacun, c'est la garantie qu'un jour l'un
   d'eux laissera la page bloquée pour de bon.

   ⚠️ position:fixed et pas seulement overflow:hidden. Safari sur iOS IGNORE
   overflow:hidden sur <body> : la page continue de défiler derrière le calque,
   et c'est précisément le cas qu'on veut corriger. Le prix de position:fixed,
   c'est que la page remonte en haut — d'où la mémorisation de la position et
   sa restauration à la fermeture.
============================================================ */
var _scrollFige = 0;
function verrouFond(){
  const ouvert = !!document.querySelector('.overlay.show');
  const fige = document.body.classList.contains('fond-fige');
  if(ouvert && !fige){
    _scrollFige = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = (-_scrollFige) + 'px';
    document.body.classList.add('fond-fige');
  }else if(!ouvert && fige){
    document.body.classList.remove('fond-fige');
    document.body.style.top = '';
    /* 'instant' : un retour en douceur donnerait l'impression que la page
       glisse toute seule à la fermeture. */
    window.scrollTo({ top: _scrollFige, behavior: 'instant' });
  }
}
/* On surveille les changements de classe : c'est « show » qui fait foi, et
   l'observateur voit donc TOUS les calques, y compris ceux ajoutés plus tard. */
new MutationObserver(verrouFond).observe(document.body, {
  subtree: true, attributes: true, attributeFilter: ['class']
});
verrouFond();

/* ============================================================
   LES QUESTIONS D'ACOLYTE — À LA PREMIÈRE ARRIVÉE
   ------------------------------------------------------------
   Avant, la première visite ouvrait huit écrans qui EXPLIQUAIENT l'app. Ça se
   lit une fois et ça ne sert plus jamais. Maintenant Acolyte commence par
   DEMANDER : ce que tu aimes, ton rythme, ce que tu manges, comment tu te
   déplaces, tes besoins d'accessibilité. Les explications viennent après.

   Pourquoi c'est mieux qu'un écran de plus à lire : ces réponses existaient
   déjà dans l'app, enfouies dans un accordéon du profil que personne n'ouvre.
   L'IA s'en sert à CHAQUE proposition et à chaque plan — les demander à
   l'arrivée, c'est la différence entre un premier voyage générique et un
   premier voyage qui te ressemble.

   ⚠️ AUCUN chemin d'écriture propre. Les puces portent les mêmes attributs
   data-set / data-val / data-multi que celles du profil, et c'est le
   gestionnaire global qui enregistre. Voir chipsHTML().
   ⚠️ On peut TOUT passer. Un questionnaire obligatoire devant la porte fait
   fermer l'onglet, et ces réglages sont tous modifiables dans le profil.
============================================================ */
const QZ_KEY = 'acolite_questions';
const QZ = [
  { opt:'stStyle',    q:'Qu’est-ce qui te fait partir ?',            s:'Choisis-en autant que tu veux — l’IA cherchera des destinations qui cochent ces cases.' },
  { opt:'stRythme',   q:'Tu voyages à quel rythme ?',                s:'Ça décide du nombre de visites par journée, et du temps laissé entre elles.' },
  { opt:'stFood',     q:'Tu manges comment ?',                       s:'Les restaurants et les marchés proposés en tiendront compte.' },
  { opt:'stSurPlace', q:'Sur place, tu te déplaces comment ?',       s:'Ça change les durées entre deux visites, et la façon de grouper tes journées.' },
  { opt:'stAcces',    q:'Un besoin d’accessibilité ?',               s:'Si oui, l’IA évite les sites escarpés et privilégie les accès de plain-pied.' }
];
var _qzI = 0;
function qzFait(){ try{ return !!localStorage.getItem(QZ_KEY); }catch(e){ return true; } }
function qzTermine(){
  /* on distingue « repondu » de « passe » : c'est la difference entre un
     questionnaire trop long et un questionnaire mal compris. */
  statCompte(_qzI >= QZ.length - 1 ? 'questions_finies' : 'questions_passees');
  try{ localStorage.setItem(QZ_KEY, '1'); }catch(e){}
  const ov = $('#ovQz'); if(ov) ov.classList.remove('show');
  /* Les explications ENSUITE : Acolyte demande d'abord, raconte après. */
  showOnboard();
}
function qzRender(){
  const ov = $('#ovQz'); if(!ov) return;
  const it = QZ[_qzI], cfg = OPT[it.opt];
  const EN = isEN();
  $('#qzPas').textContent = EN
    ? `Question ${_qzI + 1} of ${QZ.length}`
    : `Question ${_qzI + 1} sur ${QZ.length}`;
  $('#qzQ').textContent = it.q;
  $('#qzS').textContent = it.s;
  $('#qzChips').innerHTML = chipsHTML(cfg);
  $('#qzPoints').innerHTML = QZ.map((_, i) => `<i class="${i === _qzI ? 'on' : ''}"></i>`).join('');
  /* ⚠️ « Passer » est un bouton À PART, toujours présent, et non plus le
     libellé du bouton principal quand rien n'est coché. Fondre les deux dans un
     seul bouton rendait l'échappatoire invisible : dès qu'on effleurait une
     puce, le mot « Passer » disparaissait de l'écran et plus rien ne disait
     qu'on avait le droit de ne pas répondre. */
  const dernier = _qzI === QZ.length - 1;
  $('#qzNext').textContent = dernier
    ? (EN ? 'Let’s go' : 'C’est parti')
    : (EN ? 'Next' : 'Suivant');
  const sk = $('#qzSkip');
  if(sk){
    sk.textContent = EN ? 'Skip' : 'Passer';
    /* à la dernière question, « Passer » et « C'est parti » feraient la même
       chose : on n'en garde qu'un. */
    sk.hidden = dernier;
  }
}
function qzShow(){
  if(qzFait()) return false;
  let ov = $('#ovQz');
  if(!ov){
    ov = document.createElement('div');
    ov.className = 'overlay qz';
    ov.id = 'ovQz';
    /* role/aria-modal : c'est une vraie boîte de dialogue, elle doit être
       annoncée comme telle et non comme un bloc de page parmi d'autres. */
    ov.innerHTML = `<div class="card qz-card" role="dialog" aria-modal="true" aria-labelledby="qzQ">
      <span class="qz-pas" id="qzPas"></span>
      <h3 class="qz-q" id="qzQ"></h3>
      <p class="qz-s" id="qzS"></p>
      <div class="chips qz-chips" id="qzChips"></div>
      <div class="qz-bas">
        <div class="qz-points" id="qzPoints" aria-hidden="true"></div>
        <button class="btn ghost qz-skip" id="qzSkip" type="button">Passer</button>
        <button class="btn" id="qzNext" type="button"></button>
      </div>
      <button class="qz-tout" id="qzTout" type="button">Tout passer — je réglerai plus tard</button>
    </div>`;
    document.body.appendChild(ov);
    const avance = () => { if(_qzI < QZ.length - 1){ _qzI++; qzRender(); } else qzTermine(); };
    $('#qzNext').onclick = avance;
    /* Passer, c'est avancer sans rien écrire : SET n'est pas touché, donc la
       préférence garde sa valeur par défaut. Aucun cas particulier à gérer. */
    $('#qzSkip').onclick = avance;
    $('#qzTout').onclick = qzTermine;
    /* Un clic sur une puce est déjà enregistré par le gestionnaire global : on
       ne fait que redessiner pour montrer la sélection et remettre à jour le
       libellé du bouton. Le délai zéro est nécessaire — sans lui on redessine
       AVANT que le gestionnaire global ait écrit dans SET, et la puce paraît
       ne pas réagir au premier clic. */
    $('#qzChips').addEventListener('click', e => {
      if(e.target.closest('[data-set]')) setTimeout(qzRender, 0);
    });
  }
  _qzI = 0; qzRender(); ov.classList.add('show');
  return true;
}

/* L'œil des champs de mot de passe, dessiné au trait comme toutes les icônes du
   site. `vu` vrai = le mot de passe est visible, donc on montre l'œil BARRÉ :
   l'icône annonce ce que fait le bouton (masquer), elle ne décrit pas l'état
   courant. C'est la convention de tous les champs de mot de passe. */
function ICO_OEIL(vu){
  const o = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  return vu
    ? o + '<path d="M3 12s3.6-6.2 9-6.2 9 6.2 9 6.2-3.6 6.2-9 6.2S3 12 3 12Z"/>'
        + '<circle cx="12" cy="12" r="2.9"/><path d="m4 20 16-16"/></svg>'
    : o + '<path d="M3 12s3.6-6.2 9-6.2 9 6.2 9 6.2-3.6 6.2-9 6.2S3 12 3 12Z"/>'
        + '<circle cx="12" cy="12" r="2.9"/></svg>';
}

/* ============================================================
   LIENS PARTENAIRES — L'AFFILIATION, EN UN SEUL ENDROIT
   ------------------------------------------------------------
   Acolyte envoie déjà ses visiteurs chez Booking, GetYourGuide et Aviasales,
   avec les dates et le nombre de voyageurs pré-remplis : 14 liens dans le code.
   Aucun ne portait d'identifiant d'affilié. Chaque réservation faite depuis
   Acolyte rapportait donc zéro, alors que le travail de recommandation était
   déjà fait — c'est la seule source de revenu du projet, et elle était
   débranchée.

   ⚠️ UN SEUL POINT DE PASSAGE, et c'est délibéré : un délégué de clic qui
   réécrit le lien au moment où on le suit. Ajouter le paramètre dans les 14
   endroits, c'est la garantie d'en oublier un — et surtout d'oublier le 15e
   qu'on écrira demain. Ici, tout nouveau lien vers un hôte connu est couvert
   sans y penser.

   ⚠️ SANS IDENTIFIANT, RIEN NE CHANGE. Tant que les champs de config.js sont
   vides, l'URL est renvoyée telle quelle : le lien marche exactement comme
   aujourd'hui. Aucune régression possible si tu ne t'inscris jamais.

   ⚠️ Aucune donnée personnelle ne part dans l'URL — seulement la destination,
   les dates et le nombre de voyageurs, qui étaient déjà là. On n'ajoute QUE
   l'identifiant de compte, qui est le tien, pas celui du visiteur.

   Les trois programmes sont GRATUITS à rejoindre :
     · Booking.com    → partenaire Booking (paramètre « aid »)
     · GetYourGuide   → partenaire GYG    (paramètre « partner_id »)
     · Travelpayouts  → Aviasales, Omio…  (paramètre « marker »)
============================================================ */
const PARTENAIRES = [
  { hote:/(^|\.)booking\.com$/i,      param:'aid',        cle:'booking' },
  { hote:/(^|\.)getyourguide\.[a-z.]+$/i, param:'partner_id', cle:'gyg' },
  { hote:/(^|\.)aviasales\.[a-z.]+$/i,    param:'marker',     cle:'tp' },
  { hote:/(^|\.)omio\.[a-z.]+$/i,         param:'marker',     cle:'tp' },
  { hote:/(^|\.)tp\.st$/i,                param:'marker',     cle:'tp' }
];
/* Les identifiants vivent dans config.js, à côté du reste. Le repli sur
   localStorage sert à tester sans toucher au fichier. */
function idAffilie(cle){
  const c = (window.ACOLITE_KEYS && window.ACOLITE_KEYS.affiliation) || {};
  try{ return String(c[cle] || localStorage.getItem('acolite_aff_' + cle) || '').trim(); }
  catch(e){ return String(c[cle] || '').trim(); }
}
function lienPartenaire(url){
  try{
    const u = new URL(url, location.href);
    const p = PARTENAIRES.find(x => x.hote.test(u.hostname));
    if(!p) return url;
    const id = idAffilie(p.cle);
    if(!id) return url;                  /* pas d'identifiant → lien inchangé */
    /* On n'écrase JAMAIS un paramètre déjà présent : si un lien porte
       explicitement son propre identifiant, il a une raison. */
    if(u.searchParams.has(p.param)) return url;
    u.searchParams.set(p.param, id);
    return u.toString();
  }catch(e){ return url; }              /* URL illisible → on ne touche à rien */
}
/* Le délégué. En phase de CAPTURE et non de bouillonnement : on réécrit le lien
   avant que d'autres gestionnaires ne l'ouvrent eux-mêmes. */
document.addEventListener('click', e => {
  const a = e.target.closest?.('a[href]');
  if(!a) return;
  const neuf = lienPartenaire(a.href);
  if(neuf !== a.href) a.href = neuf;
  /* Le seul endroit où l'on sait qu'un visiteur part vers un partenaire. La
     question n'est pas l'argent, c'est de savoir si le programme mène à
     l'action ou s'il reste un joli document. */
  try{ if(PARTENAIRES.some(x => x.hote.test(new URL(a.href, location.href).hostname))) statCompte('reservation_clic'); }catch(e){}
}, true);

/* ============================================================
   ASSISTANT DE MODIFICATION DU VOYAGE
   ------------------------------------------------------------
   « Enlève le musée du jour 3 » · « ajoute un marché le matin » ·
   « décale tout d'une heure ». Avant, changer une seule chose obligeait à
   retourner au questionnaire et à TOUT régénérer : on perdait le programme
   qu'on aimait pour corriger un détail. C'est le manque qui séparait Acolyte
   des gros — chez eux on discute avec son itinéraire.

   ⚠️ L'IA RENVOIE UNE MODIFICATION, PAS UN VOYAGE. C'est la décision centrale.
   Elle produit une liste d'opérations sur la structure existante, jamais le
   programme complet. Trois raisons :
     · ~20 fois moins de texte à générer → rapide, et ça tient dans les quotas
       gratuits ;
     · le reste du voyage NE PEUT PAS changer par accident — ce qui n'est pas
       visé n'est pas touché ;
     · c'est annulable : on garde l'état d'avant, donc on sait revenir.

   ⚠️ RIEN N'EST APPLIQUÉ SANS VALIDATION. Un modèle qui renvoie
   {"action":"supprimer","jour":9} sur un voyage de 5 jours, ça arrivera.
   asstValide() vérifie CHAQUE opération — action connue, jour existant, index
   dans les bornes — et rejette la fautive sans abandonner les autres. On ne
   fait pas plus confiance à une sortie de modèle qu'à un champ de formulaire.
============================================================ */
const ASST_ACTIONS = ['supprimer', 'ajouter', 'modifier', 'deplacer'];

/* Valide UNE opération contre le voyage réel. Renvoie null si elle est bonne,
   sinon la raison du refus (affichée telle quelle, pour que l'utilisateur
   comprenne ce qui a été ignoré plutôt que de voir un changement partiel). */
function asstValide(op){
  if(!op || typeof op !== 'object') return 'opération illisible';
  if(!ASST_ACTIONS.includes(op.action)) return `action inconnue « ${op.action} »`;
  const j = Number(op.jour);
  if(!Number.isInteger(j)) return 'jour manquant';
  const etapes = tlEtapes(j);
  if(!etapes) return `le jour ${j} n'existe pas dans ce voyage`;
  /* Pour tout sauf « ajouter », l'étape visée doit exister. */
  if(op.action !== 'ajouter'){
    const i = Number(op.etape);
    if(!Number.isInteger(i) || i < 0 || i >= etapes.length)
      return `le jour ${j} n'a pas de moment n°${op.etape}`;
  }
  if(op.action === 'deplacer'){
    const jd = Number(op.versJour);
    if(!Number.isInteger(jd) || !tlEtapes(jd)) return `jour d'arrivée ${op.versJour} inconnu`;
  }
  if(op.action === 'ajouter' && !String(op.titre || '').trim())
    return 'ajout sans titre';
  return null;
}

/* Exécute les opérations valides. Renvoie { faites, refusees }.
   ⚠️ Les suppressions et déplacements sont traités du DERNIER index au
   PREMIER : retirer l'étape 1 puis l'étape 3 supprimerait la mauvaise, parce
   que les index glissent après chaque retrait. C'est l'erreur classique, et
   elle est silencieuse. */
function asstApplique(ops){
  const bonnes = [], refusees = [];
  for(const op of ops){
    const err = asstValide(op);
    if(err) refusees.push({ op, err }); else bonnes.push(op);
  }
  const ordre = [...bonnes].sort((a, b) => (Number(b.etape) || 0) - (Number(a.etape) || 0));
  const faites = [];
  for(const op of ordre){
    const etapes = tlEtapes(Number(op.jour));
    const i = Number(op.etape);
    try{
      if(op.action === 'supprimer'){
        faites.push({ op, quoi: etapes[i]?.titre || '' });
        try{ goutsNote(etapes[i]?.titre, etapes[i]?.type); }catch(e){}
        etapes.splice(i, 1);
      }else if(op.action === 'ajouter'){
        const e = {
          heure: /^\d{1,2}:\d{2}$/.test(String(op.heure)) ? String(op.heure) : '10:00',
          titre: String(op.titre).slice(0, 90),
          description: String(op.description || '').slice(0, 400),
          lieu: op.lieu ? String(op.lieu).slice(0, 90) : null,
          type: TL_TYPES && TL_TYPES[op.type] ? op.type : 'visite'
        };
        /* « apres » absent → à la fin. Un index hors bornes est ramené dedans
           plutôt que refusé : l'intention est claire, la position est un
           détail. */
        const pos = Number.isInteger(Number(op.apres))
          ? Math.max(0, Math.min(etapes.length, Number(op.apres) + 1))
          : etapes.length;
        etapes.splice(pos, 0, e);
        faites.push({ op, quoi: e.titre });
      }else if(op.action === 'modifier'){
        const e = etapes[i];
        faites.push({ op, quoi: e.titre });
        if(op.titre)       e.titre = String(op.titre).slice(0, 90);
        if(op.description) e.description = String(op.description).slice(0, 400);
        if(op.lieu)        e.lieu = String(op.lieu).slice(0, 90);
        if(/^\d{1,2}:\d{2}$/.test(String(op.heure))) e.heure = String(op.heure);
        if(op.type && TL_TYPES && TL_TYPES[op.type]) e.type = op.type;
      }else if(op.action === 'deplacer'){
        const e = etapes[i];
        faites.push({ op, quoi: e?.titre || '' });
        etapes.splice(i, 1);
        tlEtapes(Number(op.versJour)).push(e);
      }
    }catch(err){ refusees.push({ op, err: 'échec : ' + err.message }); }
  }
  /* Les journées restent triées par heure : sinon un ajout à 8h se retrouve
     après le déjeuner et le programme devient illisible. */
  const jours = new Set(faites.map(f => Number(f.op.jour))
    .concat(faites.filter(f => f.op.versJour != null).map(f => Number(f.op.versJour))));
  for(const j of jours){
    const e = tlEtapes(j);
    if(e) e.sort((a, b) => String(a.heure).localeCompare(String(b.heure)));
  }
  return { faites, refusees };
}

/* Le voyage, résumé pour l'IA. On n'envoie QUE ce qu'il faut pour viser une
   étape : jour, index, heure, titre. Pas les notes, pas les dépenses, pas
   l'email — l'assistant n'a aucun besoin de les connaître, donc ils ne
   sortent pas de l'appareil. */
function asstResume(){
  const days = state.cache?.days || {};
  const L = [];
  for(const j of Object.keys(days).sort((a, b) => a - b)){
    const e = tlEtapes(Number(j));
    if(!e) continue;
    L.push(`Jour ${j} :`);
    e.forEach((x, i) => L.push(`  [${i}] ${x.heure} — ${x.titre}`));
  }
  return L.join('\n');
}
function asstPrompt(demande){
  return `Tu modifies un programme de voyage EXISTANT. Voici son état :

${asstResume()}

Demande du voyageur : « ${String(demande).slice(0, 400)} »

Renvoie UNIQUEMENT les opérations nécessaires, jamais le programme entier.
Format : {"operations":[…],"resume":"une phrase disant ce que tu changes"}

Actions possibles :
· {"action":"supprimer","jour":3,"etape":2}
· {"action":"ajouter","jour":3,"apres":1,"heure":"10:30","titre":"…","description":"…","lieu":"…","type":"visite"}
· {"action":"modifier","jour":2,"etape":0,"heure":"09:00","titre":"…","description":"…"}
· {"action":"deplacer","jour":2,"etape":1,"versJour":3}

Règles :
1. "jour" et "etape" sont ceux affichés ci-dessus. N'invente jamais un numéro absent.
2. Ne touche QUE ce que la demande concerne. Tout le reste doit rester intact.
3. Si la demande est impossible ou incompréhensible, renvoie {"operations":[],"resume":"…"} en expliquant pourquoi.
4. "type" vaut : visite, repas, transport, hotel, pause, activite.
5. "resume" est écrit pour le voyageur, à la deuxième personne, sans jargon.`;
}

/* Le va-et-vient complet : demande → opérations → APERÇU → confirmation.
   ⚠️ On applique sur une COPIE d'abord pour pouvoir montrer le résultat, puis
   on annule si l'utilisateur refuse. C'est ce qui rend l'assistant sûr : il ne
   peut pas abîmer un voyage sans qu'on ait dit oui. */
var _asstAvant = null;
async function asstDemande(texte){
  statCompte('assistant_utilise');
  if(!state.cache?.days || !Object.keys(state.cache.days).length){
    toast(isEN() ? 'No trip to modify yet' : 'Pas encore de voyage à modifier');
    return;
  }
  const bar = $('#asstBar');
  bar?.classList.add('occupe');
  const st = $('#asstEtat');
  if(st) st.textContent = isEN() ? 'Acolyte is looking…' : 'Acolyte regarde…';
  try{
    const { data } = await ai('light', asstPrompt(texte), true, 1400);
    const ops = Array.isArray(data?.operations) ? data.operations : [];
    if(!ops.length){
      if(st) st.textContent = String(data?.resume || (isEN() ? 'Nothing to change.' : 'Rien à changer.')).slice(0, 200);
      return;
    }
    /* état d'avant, pour l'annulation */
    _asstAvant = JSON.stringify(state.cache.days);
    const { faites, refusees } = asstApplique(ops);
    if(!faites.length){
      _asstAvant = null;
      if(st) st.textContent = (isEN() ? 'Could not apply: ' : 'Impossible d’appliquer : ')
        + refusees.map(r => r.err).join(' · ').slice(0, 200);
      return;
    }
    save();
    if(typeof tlRender === 'function') faites.forEach(f => { try{ tlRender(Number(f.op.jour)); }catch(e){} });
    if(typeof buildProjectMap === 'function'){ try{ buildProjectMap(); }catch(e){} }
    const lignes = faites.map(f => {
      const v = { supprimer:'−', ajouter:'+', modifier:'~', deplacer:'→' }[f.op.action] || '·';
      return `${v} jour ${f.op.jour} : ${f.quoi}`;
    });
    if(st) st.innerHTML = `<b>${esc(String(data?.resume || '').slice(0, 160))}</b><br>`
      + lignes.map(esc).join('<br>')
      + (refusees.length ? `<br><i>${esc(refusees.length + (isEN() ? ' ignored' : ' ignorée(s)'))}</i>` : '');
    bar?.classList.add('modifie');
  }catch(e){
    statCompte('ia_echec');
    if(st) st.textContent = isEN() ? 'Acolyte could not answer. Try again.' : 'Acolyte n’a pas pu répondre. Réessaie.';
  }finally{
    bar?.classList.remove('occupe');
  }
}
/* Annuler : on remet l'état d'avant, tel quel. Pas d'inversion d'opérations —
   rejouer une suppression à l'envers demanderait de deviner la position, et une
   copie de la structure coûte quelques kilooctets. */
function asstAnnule(){
  if(!_asstAvant) return;
  /* Un refus est le signal de qualité le plus honnête qu'on ait sur l'IA :
     comparé à assistant_utilise, il donne un taux de rejet. */
  statCompte('assistant_annule');
  try{
    state.cache.days = JSON.parse(_asstAvant);
    _asstAvant = null;
    save();
    Object.keys(state.cache.days).forEach(j => { try{ tlRender(Number(j)); }catch(e){} });
    try{ buildProjectMap(); }catch(e){}
    const st = $('#asstEtat'); if(st) st.textContent = isEN() ? 'Change undone.' : 'Modification annulée.';
    $('#asstBar')?.classList.remove('modifie');
    toast(isEN() ? '↩ Undone' : '↩ Annulé');
  }catch(e){}
}

/* La barre, posée en tête de l'écran du voyage. Construite en JS pour ne pas
   dépendre d'un emplacement précis dans index.html — et pour qu'elle
   n'apparaisse que s'il y a un voyage à modifier. */
function asstMonte(){
  const hote = $('#view3');
  if(!hote || $('#asstBar')) return;
  const EN = isEN();
  const bar = document.createElement('div');
  bar.className = 'asst-bar';
  bar.id = 'asstBar';
  /* ⚠️ PLUS DE FORMULAIRE ICI — un RENVOI vers l'onglet Assistant.
     Cette barre faisait exactement ce que fait l'onglet : deux endroits pour
     une seule fonction, et le doublon occupait 211 px en TÊTE du voyage,
     au-dessus du billet. On ne voyait plus son propre voyage en arrivant
     dessus.
     Le formulaire avait d'abord été gardé pour le téléphone, où l'onglet
     n'existait pas. Il existe partout maintenant : il n'y a plus rien à
     dupliquer, et la barre se réduit à une ligne. Ce qui RESTE ici, c'est
     « Vérifier les horaires » — une fonction distincte, pas un doublon. */
  bar.innerHTML = `
    <button class="asst-vers" id="asstVers" type="button">
      <span class="asst-vers-ico" aria-hidden="true">${ICO('etincelle',18)}</span>
      <span class="asst-vers-t"><b>${EN ? 'Ask the assistant' : 'Demander à l’assistant'}</b>
      <em>${EN ? 'Change your trip, or just ask a question' : 'Modifie ton voyage, ou pose simplement une question'}</em></span>
      <span class="asst-vers-fl" aria-hidden="true">→</span>
    </button>
    <p class="asst-etat" id="asstEtat" role="status" aria-live="polite"></p>
    <button class="asst-undo" id="asstUndo" type="button">${EN ? '↩ Undo' : '↩ Annuler'}</button>`;
  /* ⚠️ APRÈS LE VOYAGE, PLUS AVANT. Le commentaire ci-dessus disait déjà le
     problème — « on ne voyait plus son propre voyage en arrivant dessus » —
     mais la barre avait seulement été RÉTRÉCIE, pas déplacée : elle occupait
     encore 132 px au-dessus du billet. Or c'est un renvoi vers un autre
     onglet ; ça n'a pas à passer avant ce qu'on vient voir.
     Elle se pose donc juste après le contenu du voyage, avec les autres
     actions (Réserver, Gérer) auxquelles elle appartient. Le repli sur
     appendChild couvre le cas où #zoneSections n'existerait pas encore. */
  const apres = $('#zoneSections');
  if(apres && apres.parentNode === hote) hote.insertBefore(bar, apres.nextSibling);
  else hote.appendChild(bar);
  $('#asstUndo').onclick = asstAnnule;
  const vers = $('#asstVers');
  if(vers) vers.onclick = () => { if(typeof switchCat === 'function') switchCat('ia'); };
}
asstMonte();

/* ============================================================
   VÉRIFICATION DES HORAIRES — le défaut de fiabilité
   ------------------------------------------------------------
   C'est le reproche fait à tous les planificateurs qui s'appuient sur les
   connaissances figées d'un modèle : ils « manquent régulièrement les
   fermetures ». Un musée fermé le mardi se retrouve dans le programme, et
   l'utilisateur ne le découvre que devant la porte.

   On interroge OpenStreetMap (gratuit, sans clé) pour les horaires réels des
   lieux du programme.

   ⚠️ RÈGLE ABSOLUE ICI : UNE ALERTE FAUSSE EST PIRE QUE PAS D'ALERTE. Le
   format opening_hours d'OSM est une spécification entière (congés scolaires,
   « Su[1] », semaines paires, exceptions par date…). On ne prétend pas le lire.
   On ne signale QUE les cas dont la lecture est certaine :
     · une journée explicitement fermée (« Mo off », « Tu closed ») ;
     · une liste de jours d'ouverture qui EXCLUT le jour prévu (« Tu-Su … »).
   Tout le reste — 24/7, horaires par saison, syntaxe qu'on ne reconnaît pas —
   ne produit RIEN. Le silence est le comportement correct par défaut.

   ⚠️ Et l'absence d'un lieu dans OSM ne veut PAS dire qu'il n'existe pas :
   OSM est incomplet. On ne signale donc jamais « ce lieu n'existe pas ».
============================================================ */
const OSM_JOURS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/* Renvoie true SEULEMENT si la règle dit de façon certaine que c'est fermé ce
   jour-là. Dans le doute : false. */
function osmFermeLe(oh, jourSem){
  if(!oh) return false;
  const s = String(oh).trim();
  if(/^24\/7$/i.test(s)) return false;
  /* On refuse tout ce qui contient de la syntaxe qu'on ne sait pas lire :
     semaines, dates, congés, ordinaux. Mieux vaut se taire. */
  if(/week|:\s*\w+\s*\d{4}|\bPH\b|\bSH\b|\[|\d{4}|,\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(s)) return false;
  const code = OSM_JOURS[jourSem];
  const dev = j => OSM_JOURS.indexOf(j);
  /* 1. fermeture explicite : « Mo off », « Tu-We closed » */
  for(const m of s.matchAll(/\b(Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su))?\s*(?:off|closed)\b/gi)){
    const a = dev(m[1][0].toUpperCase() + m[1][1].toLowerCase());
    const b = m[2] ? dev(m[2][0].toUpperCase() + m[2][1].toLowerCase()) : a;
    for(let k = 0; k < 7; k++){ if(OSM_JOURS[(a + k) % 7] === code) return true; if((a + k) % 7 === b) break; }
  }
  /* 2. liste de jours ouverts qui n'inclut pas le nôtre */
  const plages = [...s.matchAll(/\b(Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su))?(?=[\s,]*\d{1,2}:)/gi)];
  if(!plages.length) return false;
  const ouverts = new Set();
  for(const m of plages){
    const a = dev(m[1][0].toUpperCase() + m[1][1].toLowerCase());
    const b = m[2] ? dev(m[2][0].toUpperCase() + m[2][1].toLowerCase()) : a;
    for(let k = 0; k < 7; k++){ ouverts.add(OSM_JOURS[(a + k) % 7]); if((a + k) % 7 === b) break; }
  }
  return !ouverts.has(code);
}

/* Relève les horaires des lieux nommés autour du voyage. Même chemin réseau que
   osmStays : miroirs, délai, repli silencieux, cache dans state. */
async function osmHoraires(lat, lon, radiusM = 12000){
  const ck = `osm_oh_${lat.toFixed(3)}_${lon.toFixed(3)}_${radiusM}`;
  if(state.cache[ck]) return state.cache[ck];
  if(netSlow()) return {};
  const q = `[out:json][timeout:20];nwr(around:${radiusM},${lat},${lon})`
    + `[name]["opening_hours"];out center 400;`;
  let d = null;
  for(const url of OVERPASS_URLS){
    try{
      const r = await fetchT(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
      }, netTimeout(12000));
      if(r.status === 429 || r.status >= 500) continue;
      if(!r.ok) return {};
      d = await r.json(); break;
    }catch(e){ _netFails++; }
  }
  if(!d) return {};
  const map = {};
  for(const e of (d.elements || [])){
    const n = e.tags?.name, oh = e.tags?.opening_hours;
    if(n && oh) map[n.toLowerCase()] = oh;
  }
  state.cache[ck] = map; save();
  return map;
}

/* Confronte le programme aux horaires réels. Renvoie la liste des moments dont
   le lieu est CERTAINEMENT fermé ce jour-là.
   ⚠️ On a besoin de la DATE de chaque journée pour connaître le jour de la
   semaine. Sans date de départ, on ne peut rien conclure — et on ne devine pas :
   la fonction renvoie simplement une liste vide. */
async function osmVerifieProgramme(){
  const dep = state.trip?.depart || state.depart;
  const c = state.trip?.coords || state.coords;
  if(!dep || !c?.lat) return { alertes: [], raison: 'sansDate' };
  const map = await osmHoraires(c.lat, c.lon);
  if(!Object.keys(map).length) return { alertes: [], raison: 'sansDonnees' };
  const alertes = [];
  for(const j of Object.keys(state.cache?.days || {})){
    const etapes = tlEtapes(Number(j));
    if(!etapes) continue;
    const d = new Date(dep);
    if(isNaN(d)) return { alertes: [], raison: 'sansDate' };
    d.setDate(d.getDate() + (Number(j) - 1));
    const jourSem = d.getDay();
    etapes.forEach((e, i) => {
      /* On cherche le lieu, puis le titre : souvent le titre EST le nom du
         musée, alors que « lieu » porte le quartier. */
      for(const cle of [e.lieu, e.titre]){
        const oh = cle && map[String(cle).toLowerCase()];
        if(oh && osmFermeLe(oh, jourSem)){
          alertes.push({ jour: Number(j), etape: i, titre: e.titre, horaires: oh,
                         jourNom: ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'][jourSem] });
          break;
        }
      }
    });
  }
  return { alertes, raison: null };
}
/* Bouton dans la barre de l'assistant : la vérification est un APPEL RÉSEAU de
   plusieurs secondes, elle ne doit pas partir toute seule à chaque affichage. */
function osmMonteBouton(){
  const bar = $('#asstBar');
  if(!bar || $('#asstOh')) return;
  const EN = isEN();
  const b = document.createElement('button');
  b.className = 'asst-oh'; b.id = 'asstOh'; b.type = 'button';
  b.textContent = EN ? 'Check opening hours' : 'Vérifier les horaires';
  bar.appendChild(b);
  b.onclick = async () => {
    const st = $('#asstEtat');
    b.disabled = true;
    if(st) st.textContent = EN ? 'Asking OpenStreetMap…' : 'Acolyte interroge OpenStreetMap…';
    try{
      statCompte('horaires_verifies');
      const { alertes, raison } = await osmVerifieProgramme();
      if(raison === 'sansDate'){
        st.textContent = EN ? 'Set a departure date first — without it there is no weekday to check.'
                            : 'Indique d’abord une date de départ — sans elle, aucun jour de la semaine à vérifier.';
      }else if(raison === 'sansDonnees'){
        st.textContent = EN ? 'OpenStreetMap did not answer. Nothing changed.'
                            : 'OpenStreetMap n’a pas répondu. Rien n’a changé.';
      }else if(!alertes.length){
        st.textContent = EN ? 'Nothing certainly closed. (OpenStreetMap is incomplete — check the official page before booking.)'
                            : 'Rien de certainement fermé. (OpenStreetMap est incomplet — vérifie la page officielle avant de réserver.)';
      }else{
        st.innerHTML = `<b>${alertes.length} ${EN ? 'possible closure(s)' : 'fermeture(s) à vérifier'}</b><br>`
          + alertes.map(a => esc(`jour ${a.jour} · ${a.titre} — fermé le ${a.jourNom} (${a.horaires})`)).join('<br>');
      }
    }catch(e){
      if(st) st.textContent = EN ? 'Check failed. Nothing changed.' : 'La vérification a échoué. Rien n’a changé.';
    }finally{ b.disabled = false; }
  };
}
osmMonteBouton();

/* ============================================================
   MESURE D'AUDIENCE — CÔTÉ VISITEUR
   ------------------------------------------------------------
   On envoie UN MOT, celui de l'événement. Rien d'autre : ni identifiant, ni
   adresse, ni horaire, ni parcours. Le serveur incrémente un entier par jour
   et par événement (voir /stat dans valtown-backend.js).

   ⚠️ Pas de cookie, pas d'identifiant de session, donc pas de bandeau de
   consentement à ajouter : il n'y a aucune donnée personnelle à consentir.
   C'est le seul dessin qui permet de mesurer sans rien demander.

   ⚠️ TOTALEMENT FACULTATIF PAR CONSTRUCTION. Si le backend est éteint, hors
   ligne, ou refuse l'origine, la fonction échoue en silence et l'app continue
   exactement pareil. Une mesure ne doit jamais gêner celui qu'elle mesure.
   ⚠️ keepalive : sans lui, l'envoi est annulé quand la page se ferme, et on
   perdrait précisément les événements de fin de parcours.
============================================================ */
const STAT_DEJA = new Set();
function statCompte(cle, uneFois = false){
  /* Certains événements n'ont de sens qu'une fois par session (« arrivee ») :
     les compter à chaque changement d'onglet gonflerait le chiffre sans rien
     apprendre. */
  if(uneFois){
    if(STAT_DEJA.has(cle)) return;
    STAT_DEJA.add(cle);
  }
  try{
    if(!useBackend()) return;
    fetch(`${API()}/stat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cle }),
      keepalive: true
    }).catch(() => {});
  }catch(e){}
}
statCompte('arrivee', true);
/* Le hors-ligne est LA différence d'Acolyte face à Layla et Mindtrip. Encore
   faut-il savoir s'il sert : sans mesure, c'est une conviction, pas un fait. */
if(navigator.onLine === false) statCompte('hors_ligne', true);

/* L'ABANDON LE PLUS COÛTEUX, et le seul qu'on ne voyait pas.
   « arrivee » compte ceux qui ouvrent le site, « voyage_genere » ceux qui vont
   au bout. Entre les deux, il manquait ceux qui COMMENCENT à remplir puis
   partent : sans ce compteur, on ne sait pas si le questionnaire rebute avant
   ou après la première question.
   ⚠️ Une seule fois par session, et au PREMIER caractère tapé — pas au focus :
   cliquer dans un champ par curiosité n'est pas commencer. */
{
  const champs = ['#fFrom', '#fDest', '#fWhen', '#fDays'];
  const marque = () => statCompte('questionnaire_commence', true);
  champs.forEach(sel => {
    const el = $(sel);
    if(el) el.addEventListener('input', marque, { once: true });
  });
}

/* Le bandeau d'avertissement « voyage venu d'une version plus récente ».
   ⚠️ _etatDuFutur était posé par safeState mais PERSONNE ne le lisait : le mode
   de transport de l'utilisateur revenait à « avion » sans un mot d'explication.
   Une protection à moitié construite est pire qu'aucune — elle donne l'illusion
   d'être protégé. */
function futurBarMaj(){
  const b = $('#futurBar');
  if(!b) return;
  b.hidden = !_etatDuFutur;
}
{
  const x = $('#futurX');
  /* On masque pour la session seulement, sans rien enregistrer : au prochain
     chargement l'état sera relu, et s'il vient encore du futur l'avertissement
     doit revenir. Le mémoriser reviendrait à taire un problème persistant. */
  if(x) x.onclick = () => { const b = $('#futurBar'); if(b) b.hidden = true; };
  futurBarMaj();
}

/* ============================================================
   CARTE SIM SUR PLACE — la première chose qu'on cherche en atterrissant
   ------------------------------------------------------------
   Aucune API gratuite ne donne cette information. Mais elle est STABLE : les
   opérateurs d'un pays ne changent pas tous les mois, contrairement aux prix
   d'hôtel. Une table écrite à la main est donc le bon outil — le même choix que
   pour URGENCE et pour les prises électriques.

   ⚠️ ÉCRITE À LA MAIN, JAMAIS GÉNÉRÉE. Un opérateur inventé, c'est quelqu'un
   qui cherche une boutique inexistante en sortant de l'avion. Les pays absents
   n'affichent RIEN : on ne devine pas.
   ⚠️ Les prix sont des ORDRES DE GRANDEUR datés, pas des tarifs. Ils vieillissent,
   d'où la mention explicite sous le tableau.
============================================================ */
const SIM_UE = ['FR','DE','IT','ES','PT','BE','NL','LU','AT','IE','GR','PL','CZ','SK',
                'HU','RO','BG','HR','SI','DK','SE','FI','EE','LV','LT','MT','CY'];
const SIM = {
  GB: { op:'EE, Vodafone, Three', ou:'aéroport, supermarchés, boutiques en ville', prix:'10–20 £ pour 20 Go', esim:true },
  CH: { op:'Salt, Swisscom', ou:'gares et aéroports', prix:'20–30 CHF', esim:true },
  US: { op:'T-Mobile (meilleure couverture prépayée), AT&T', ou:'boutiques en ville — pas toujours en aéroport', prix:'30–50 $ par mois', esim:true },
  CA: { op:'Public Mobile, Fido', ou:'centres commerciaux', prix:'30–45 CAD', esim:true },
  JP: { op:'IIJmio, Sakura Mobile (données seules)', ou:'à réserver AVANT le départ, retrait à l’aéroport', prix:'25–40 € pour 2 semaines', esim:true,
        note:'la voix est rare sur les SIM touristiques japonaises : prévois des appels par internet' },
  TH: { op:'AIS, TrueMove', ou:'guichets à la sortie de l’aéroport', prix:'8–15 € pour 15 jours', esim:true },
  VN: { op:'Viettel (meilleure couverture rurale), Vinaphone', ou:'aéroport ou n’importe quelle boutique', prix:'5–10 € par mois', esim:true },
  ID: { op:'Telkomsel', ou:'boutiques officielles — les stands d’aéroport sont plus chers', prix:'8–15 €', esim:true },
  MY: { op:'Hotlink (Maxis), CelcomDigi', ou:'aéroport et centres commerciaux', prix:'8–12 €', esim:true },
  IN: { op:'Airtel, Jio', ou:'boutique officielle — passeport et photo exigés', prix:'5–10 € par mois', esim:false,
        note:'l’activation prend parfois 24 h : prends-la dès l’arrivée' },
  MA: { op:'Maroc Telecom, Orange', ou:'aéroport et kiosques', prix:'5–10 €', esim:false },
  TR: { op:'Turkcell, Vodafone TR', ou:'aéroport, passeport exigé', prix:'20–30 €', esim:true,
        note:'les SIM touristiques sont chères en Turquie : une eSIM régionale coûte souvent moins' },
  AU: { op:'Telstra (la seule couvrante hors des villes), Optus', ou:'aéroport et supermarchés', prix:'20–35 AUD', esim:true },
  NZ: { op:'One NZ, Spark', ou:'aéroport', prix:'25–40 NZD', esim:true },
  MX: { op:'Telcel (la seule couvrante partout)', ou:'boutiques Telcel et magasins OXXO', prix:'10–15 €', esim:true },
  BR: { op:'Vivo, Claro', ou:'boutiques en ville — un CPF est parfois demandé', prix:'10–15 €', esim:true },
  AR: { op:'Personal, Claro', ou:'boutiques en ville', prix:'5–10 €', esim:false },
  PE: { op:'Claro, Movistar', ou:'aéroport et boutiques', prix:'8–12 €', esim:true },
  ZA: { op:'Vodacom, MTN', ou:'aéroport — passeport et adresse exigés', prix:'10–15 €', esim:true },
  EG: { op:'Vodafone EG, Orange', ou:'aéroport', prix:'10–15 €', esim:false },
  AE: { op:'du, Etisalat', ou:'aéroport — une SIM touristique est parfois offerte à l’arrivée', prix:'15–30 €', esim:true },
  CN: { op:'China Unicom', ou:'à réserver avant le départ, ou eSIM', prix:'20–35 €', esim:true,
        note:'sans VPN installé AVANT le départ, la plupart des services occidentaux sont inaccessibles' }
};
/* Renvoie l'information d'un pays, ou null. Jamais d'invention. */
function simFor(cc){
  if(!cc) return null;
  const c = String(cc).toUpperCase();
  if(SIM[c]) return { ...SIM[c], ue:false };
  if(SIM_UE.includes(c)) return { ue:true };
  return null;
}
function simHTML(cc){
  const s = simFor(cc);
  if(!s) return '';
  const EN = isEN();
  const T = EN
    ? { t:'Getting online there',
        ue:'You are in the EU: your plan works at no extra cost. No local SIM needed.',
        op:'Operators', ou:'Where to buy', prix:'Rough price', esim:'eSIM',
        oui:'available', non:'not available',
        pied:'Written table, not AI. Prices are orders of magnitude and do age — check on arrival.' }
    : { t:'Se connecter sur place',
        ue:'Tu es dans l’Union européenne : ton forfait fonctionne sans surcoût. Aucune carte SIM locale nécessaire.',
        op:'Opérateurs', ou:'Où l’acheter', prix:'Prix indicatif', esim:'eSIM',
        oui:'disponible', non:'indisponible',
        pied:'Tableau écrit, pas de l’IA. Les prix sont des ordres de grandeur et vieillissent — vérifie à l’arrivée.' };
  if(s.ue) return '\n  <h3 class="pan-h3" style="margin-top:22px">' + ICO('reseau',17) + ' ' + T.t + '</h3>\n'
    + '  <p class="hint" style="margin:0">' + T.ue + '</p>';
  const l = (k, v) => v
    ? '<div class="af"><span class="af-k">' + k + '</span><span class="af-v">' + esc(v) + '</span></div>'
    : '';
  return '\n  <h3 class="pan-h3" style="margin-top:22px">' + ICO('reseau',17) + ' ' + T.t + '</h3>\n'
    + '  <div class="art-faits">'
    + l(T.op, s.op) + l(T.ou, s.ou) + l(T.prix, s.prix) + l(T.esim, s.esim ? T.oui : T.non)
    + '</div>\n'
    + (s.note ? '  <p class="hint" style="margin-top:8px">' + ICO('alerte',13) + ' ' + esc(s.note) + '</p>\n' : '')
    + '  <p class="hint" style="margin-top:6px">' + T.pied + '</p>';
}

/* ============================================================
   SÉCURITÉ — on RENVOIE vers la source officielle, on ne l'écrit pas
   ------------------------------------------------------------
   Le ministère des Affaires étrangères publie ses « Conseils aux voyageurs »
   pays par pays, tenus à jour par des gens payés pour ça.

   ⚠️ ON NE GÉNÈRE AUCUNE APPRÉCIATION. Un texte d'IA sur la sécurité ou la
   situation d'un pays est contesté par nature, se périme en semaines, et un seul
   paragraphe maladroit coûte la confiance d'un lecteur qu'on ne récupère pas.
   Un lien vers une source qui engage l'État vaut mieux qu'une analyse qu'il
   faudrait relire pour 249 pays.
   ⚠️ On envoie vers la page d'accueil des conseils et non vers une fiche
   devinée : les adresses des fiches ont leurs propres identifiants, et un lien
   fabriqué tomberait en 404 — pire qu'une page d'où l'on trouve son pays.
============================================================ */
function securiteHTML(pays){
  const nom = String(pays || '').trim();
  if(!nom) return '';
  const EN = isEN();
  const u = 'https://www.diplomatie.gouv.fr/fr/conseils-aux-voyageurs/conseils-par-pays-destination/';
  return '\n  <h3 class="pan-h3" style="margin-top:22px">' + ICO('bouclier',17) + ' ' + (EN ? 'Safety' : 'Sécurité') + '</h3>\n'
    + '  <p class="hint" style="margin:0">'
    + (EN
        ? 'Acolyte does not assess risk itself. The French foreign ministry publishes an up-to-date advisory for every country: '
        : 'Acolyte ne juge pas le risque lui-même. Le ministère des Affaires étrangères publie une fiche à jour pour chaque pays : ')
    + '<a href="' + u + '" target="_blank" rel="noopener noreferrer">'
    + (EN ? 'official advisories' : 'conseils aux voyageurs') + '</a>'
    + (EN ? ' — look up ' : ' — cherche ') + esc(nom) + '.</p>';
}

/* Le champ des âges n'apparaît que s'il y a des enfants — et disparaît si on
   repasse à zéro, sinon un âge saisi puis oublié partirait dans le prompt d'un
   voyage sans enfant. */
{
  const maj = () => {
    const n = +($('#fKids')?.value || 0);
    const box = $('#fKidsAgesBox');
    if(box) box.style.display = n > 0 ? '' : 'none';
    if(!n){ const c = $('#fKidsAges'); if(c) c.value = ''; }
  };
  const k = $('#fKids');
  if(k) k.addEventListener('change', maj);
  maj();
}

/* L'ÂGE DES ENFANTS EST UNE CONTRAINTE DE PLANIFICATION, pas un détail.
   Avec un enfant de moins de 4 ans, une journée tient trois lieux et une sieste.
   À 12 ans, on marche autant qu'un adulte mais on s'ennuie dans un musée de
   peinture. L'IA doit l'avoir, et formulé en règles — pas en chiffres bruts
   qu'elle interpréterait à sa façon. */
function agesEnfantsTexte(ages){
  if(!Array.isArray(ages) || !ages.length) return '';
  const min = Math.min(...ages), max = Math.max(...ages);
  const L = ['VOYAGE AVEC ENFANTS de ' + ages.join(', ') + ' ans. Adapte CHAQUE journée en conséquence.'];
  if(min <= 3) L.push('Un enfant a 3 ans ou moins : maximum 3 lieux par jour, une pause d’au moins 1 h l’après-midi, jamais plus de 20 min de marche d’affilée, et vérifie l’accès poussette.');
  else if(min <= 6) L.push('Le plus jeune a entre 4 et 6 ans : 3 à 4 lieux par jour, une vraie pause l’après-midi, et au moins une activité par jour faite POUR lui (parc, animaux, plage) et non subie.');
  else if(min <= 11) L.push('Les enfants ont entre 7 et 11 ans : rythme adulte allégé, mais chaque journée doit contenir une activité concrète — grimper, toucher, fabriquer — et non seulement regarder.');
  else L.push('Ce sont des adolescents : rythme adulte possible, mais prévois du temps libre et évite d’enchaîner les musées de même nature.');
  if(max - min >= 6) L.push('L’écart d’âge est important : privilégie les lieux qui parlent aux deux, ou prévois des moments où le groupe peut se séparer.');
  L.push('Signale les tarifs enfants et les gratuités quand ils existent, et évite les lieux avec un âge minimum.');
  return L.join(' ');
}

/* ============================================================
   ASSISTANT IA (bêta) — la console de l'onglet « Assistant »
   ------------------------------------------------------------
   ⚠️ RÉSERVÉ À L'ORDINATEUR. Le bouton est masqué en CSS sous 900 px, mais un
   bouton caché n'est pas une porte fermée : on peut arriver ici par le retour
   arrière, par un rechargement, ou en rétrécissant la fenêtre. Le garde-fou
   est donc DANS switchCat(), pas seulement dans la feuille de style.

   ⚠️ LE MODE EST UNE PERMISSION, PAS UNE PRÉFÉRENCE. C'est la décision de
   fond : « répondre » et « modifier ton voyage » n'ont pas les mêmes
   conséquences, et laisser un modèle deviner laquelle on veut, c'est accepter
   qu'il modifie un programme quand on lui posait une question. Le mode est
   donc choisi par l'humain, visible en permanence, et il borne ce que le CODE
   accepte de faire de la réponse — pas ce qu'on demande gentiment au modèle.

   ⚠️ ON NE RÉÉCRIT PAS L'ASSISTANT DE MODIFICATION. Le mode « modifier »
   réutilise asstPrompt() et asstApplique() — le contrat du prompt et la
   validation opération par opération. Recopier cette logique ici en aurait
   fait une seconde version, qui aurait dérivé, et la sécurité serait tombée
   du côté le moins relu.
============================================================ */
let _iaOccupe = false;
let _iaAvant = null;                   /* instantané du programme, pour annuler */

/* Ce qu'Acolyte annonce avoir compris, avant d'agir. */
const IA_INTENTS = {
  question: { mot: 'Je réponds à ta question',     ico: 'discussion' },
  creer:    { mot: 'Je prépare un nouveau voyage', ico: 'boussole'   },
  modifier: { mot: 'Je modifie ton programme',     ico: 'crayon'     }
};

/* ------------------------------------------------------------
   DÉTECTION D'INTENTION
   ------------------------------------------------------------
   ⚠️ CE CHOIX EST CELUI DU MODÈLE, ET C'EST UN VRAI RISQUE ASSUMÉ. Classer
   « et si je rajoutais un marché le matin ? » en modification alors que c'est
   une question, ça arrivera. Trois choses le rendent supportable, et il faut
   les garder toutes les trois :
     1. Acolyte ANNONCE ce qu'il a compris avant d'agir, et la phrase reste à
        l'écran. Une erreur se voit au lieu de se subir.
     2. Une modification passe toujours par asstApplique() : chaque opération
        est validée contre le voyage réel, et le bouton Annuler restaure
        l'état d'avant.
     3. La création REMPLIT le questionnaire mais ne lance RIEN toute seule —
        c'est l'action la plus chère (quota IA) et la plus visible, donc elle
        garde un clic humain. Détecter l'intention n'oblige pas à tout
        déclencher sans confirmation.
   ⚠️ En cas de doute, le classificateur doit répondre « question » : c'est le
   seul des trois qui ne touche à rien. Un défaut sûr, pas un défaut probable.
------------------------------------------------------------ */
function iaPromptIntention(demande){
  const aUnVoyage = !!(state.cache && state.cache.days && Object.keys(state.cache.days).length);
  /* ⚠️ Le dernier échange compte pour classer. « Et le lendemain ? » n'est ni
     une création ni une modification : c'est la SUITE de ce qui précède, et
     sans lui la phrase est illisible. Deux tours suffisent — au-delà on paie
     des jetons pour du contexte que la question ne mobilise plus. */
  /* Pour CLASSER, deux tours suffisent — on cherche à savoir si la phrase
     prolonge l'échange, pas à en comprendre le fond. C'est la réponse qui a
     besoin de tout l'historique (voir iaHistorique), pas le classificateur :
     lui payer 6 000 caractères à chaque message serait du gaspillage. */
  const avant = (Array.isArray(state.chatLog) ? state.chatLog : []).slice(-3, -1)
    .map(m => (m.qui === 'moi' ? 'Voyageur' : 'Acolyte') + ' : ' + String(m.t || '').slice(0, 160))
    .join('\n');
  return 'Classe la demande d’un voyageur en UNE catégorie.\n\n'
    + (avant ? 'Ce qui vient d’être dit :\n' + avant + '\n\n' : '')
    + 'Demande à classer : « ' + String(demande).slice(0, 400) + ' »\n\n'
    + 'Contexte : ' + (aUnVoyage
        ? 'il a DÉJÀ un voyage avec un programme jour par jour.'
        : "il n'a PAS encore de voyage.") + '\n\n'
    + 'Catégories :\n'
    + '· "question" — il demande une information, un conseil, une explication. RIEN ne doit changer.\n'
    + '· "creer" — il décrit une envie de NOUVEAU voyage (destination, durée, budget, période).\n'
    + '· "modifier" — il demande de CHANGER son programme existant (ajouter, enlever, déplacer, décaler une étape).\n\n'
    + 'Règles :\n'
    + '1. Dans le DOUTE, réponds "question" : c\'est la seule catégorie qui ne modifie rien.\n'
    + '2. Une phrase interrogative qui évoque un changement sans le demander ("est-ce que je pourrais…", "ça vaut le coup de…") est une "question".\n'
    + "3. \"modifier\" exige un ordre clair ET un voyage existant. Sans voyage, ce n'est jamais \"modifier\".\n"
    + "4. Une demande de NOUVEAU voyage alors qu'il en a déjà un reste \"creer\" : changer de destination n'est pas retoucher un programme.\n"
    + "5. Une phrase courte qui prolonge l'échange précédent (\"et le lendemain ?\", \"pourquoi ?\", \"et sinon ?\") est une \"question\".\n\n"
    /* ⚠️ La difficulté est demandée DANS LE MÊME APPEL que l'intention : elle ne
       coûte donc pas un aller-retour de plus, alors qu'elle décide du modèle
       qui répondra. C'est le meilleur rapport qualité/prix du dispositif. */
    + 'Évalue AUSSI la difficulté de la demande :\n'
    + '· "simple" — un fait à lire dans les informations du voyage, ou une réponse courte et directe.\n'
    + '· "complexe" — il faut comparer, arbitrer, réorganiser, tenir plusieurs contraintes ensemble, '
    + 'ou raisonner sur une conséquence (budget, temps, distances, faisabilité).\n\n'
    /* ⚠️ L'EXTRACTION SE FAIT DANS CE MÊME APPEL quand c'est une création.
       Avant, créer un voyage enchaînait : classer → extraire les champs →
       générer → relire. Quatre allers-retours en série, et l'attente devenait
       insupportable avant même la génération. Demander les champs ICI ne coûte
       rien de plus quand ce n'est pas une création (le modèle les omet), et
       supprime un appel entier quand c'en est une. */
    + 'Si — et SEULEMENT si — l’intention est "creer", ajoute aussi les champs du questionnaire '
    + 'que la phrase permet de déduire, dans un objet "voyage" :\n'
    + '{"from":"ville de départ","dest":"destination ou pays","days":"…","when":"période en clair",'
    + '"budget":"…","adults":2,"kids":0,"libre":"le reste de l’envie en une phrase"}\n'
    + 'N’INVENTE RIEN : un champ que la phrase ne permet pas de déduire est ABSENT.\n'
    + '"days" doit être copié MOT POUR MOT depuis : ' + iaOptions('#fDays') + '\n'
    + '"budget" doit être copié MOT POUR MOT depuis : ' + iaOptions('#fBudget') + '\n\n'
    + 'Réponds en JSON : {"intention":"question|creer|modifier","difficulte":"simple|complexe","voyage":{…}}';
}

/* Renvoie { intention, difficulte }, avec repli sûr. Une classification
   illisible, un modèle saturé, une catégorie inventée : tout retombe sur
   « question » — la seule qui ne touche à rien. */
async function iaIntention(texte){
  try{
    /* 420 jetons : il faut de la place pour l'objet "voyage" quand c'est une
       création. Sur une question, le modèle n'en produit qu'une trentaine. */
    const r = await ai('light', iaPromptIntention(texte), true, 420);
    const d = r && r.data || {};
    const v = String(d.intention || '').toLowerCase().trim();
    const dur = String(d.difficulte || '').toLowerCase().trim() === 'complexe';
    const voyage = (d.voyage && typeof d.voyage === 'object') ? d.voyage : null;
    if(IA_INTENTS[v]){
      /* Garde-fou de bon sens : on ne modifie pas un programme qui n'existe pas.
         Le modèle a beau l'avoir dit, le code garde le dernier mot. */
      if(v === 'modifier' && !(state.cache && state.cache.days && Object.keys(state.cache.days).length))
        return { intention:'creer', complexe:dur, voyage };
      return { intention:v, complexe:dur, voyage };
    }
  }catch(e){}
  /* Le repli est « simple » : sans classification fiable, rien ne justifie de
     dépenser le modèle lourd. */
  return { intention:'question', complexe:false, voyage:null };
}

function iaAnnonce(intent){
  const el = $('#iaIntent');
  if(!el) return;
  const i = IA_INTENTS[intent];
  if(!i){ el.hidden = true; return; }
  el.innerHTML = ICO(i.ico, 16) + '<span>' + esc(i.mot) + '</span>';
  el.hidden = false;
}

/* Le fil vit dans state.chatLog — un champ présent dans le contrat de l'état
   depuis le début : déclaré, assaini, synchronisé… et jamais rempli. Il est
   déjà borné à 100 entrées par safeState : rien à plafonner ici. */
function iaLog(){ if(!Array.isArray(state.chatLog)) state.chatLog = []; return state.chatLog; }

function iaAjoute(qui, texte, rate){
  iaLog().push({ qui, t: String(texte || '').slice(0, 4000), rate: !!rate, ts: Date.now() });
  save();
  iaRender();
}

/* ------------------------------------------------------------
   LES PROPOSITIONS S'AFFICHENT DANS LA DISCUSSION
   ------------------------------------------------------------
   ⚠️ Avant, décrire un voyage à l'assistant remplissait le questionnaire puis
   BASCULAIT sur l'onglet Voyage. On perdait le fil : la phrase qu'on venait
   d'écrire disparaissait, et il fallait revenir en arrière pour se souvenir de
   ce qu'on avait demandé. Les propositions arrivent maintenant sous la
   question qui les a produites, comme une réponse.
   Le message porte les destinations dans `cartes` — un tableau d'objets simples
   qui traverse safeState (chatLog est assaini par safeJSON, profondeur 6) et
   la synchronisation, donc la conversation se retrouve d'un appareil à l'autre
   avec ses propositions.
------------------------------------------------------------ */
function iaAjouteCartes(d){
  const T = (v, n) => String(v || '').slice(0, n);
  /* ⚠️ ON GARDE BEAUCOUP PLUS QUE LE NOM ET LE BUDGET. Le prompt produit déjà
     les points forts, le pourquoi du transport, sa durée, son prix, le quartier
     ET la raison de ce quartier — je n'en affichais qu'un tiers, et les
     propositions ressemblaient à des vignettes d'agence. Tout ce qui suit était
     DÉJÀ calculé et payé : on cessait simplement de le montrer. */
  const dest = (d && d.destinations || []).slice(0, 3).map(x => ({
    nom: T(x.nom, 80),
    pays: T(x.pays, 60),
    resume: T(x.resume, 320),
    budget: T(x.budget_estime, 60),
    duree: T(x.duree_ideale, 40),
    meteo: T(x.meteo_periode, 60),
    forts: (Array.isArray(x.points_forts) ? x.points_forts : []).slice(0, 4).map(f => T(f, 60)),
    trMode: T(x.transport_conseille, 20),
    trPourquoi: T(x.transport_pourquoi, 120),
    trPrix: T(x.transport_prix, 50),
    trDuree: T(x.transport_duree, 60),
    quartier: T(x.logement_quartier, 60),
    logPourquoi: T(x.logement_pourquoi, 120),
    logPrix: T(x.logement_prix, 50),
    logType: T(x.logement_type, 30),
    langue: T(x.langue, 40),
    monnaie: T(x.monnaie, 40)
  }));
  if(!dest.length){
    iaAjoute('aco', "Je n'ai pas réussi à sortir de proposition. Reformule en donnant un lieu ou une période.", true);
    return;
  }
  /* Le champ « analyse » du prompt, c'est le RAISONNEMENT d'Acolyte : pourquoi
     ces destinations-là, quelles contraintes il a retenues, quels pièges il a
     écartés. Il était produit à chaque recherche et jeté. C'est pourtant la
     seule chose qui explique le voyage au lieu de le décrire. */
  const analyse = T(d && d.analyse, 700);
  const intro = dest.length > 1
    ? `J'ai retenu ${dest.length} pistes volontairement différentes.`
    : `Voilà la formule que je te conseille.`;
  iaLog().push({
    qui: 'aco',
    t: analyse ? intro + '\n\n' + analyse : intro,
    cartes: dest,
    ts: Date.now()
  });
  save();
  iaRender();
}

/* ⚠️ L'AJOUT SE FAIT DEPUIS LA CONVERSATION, sans quitter l'assistant.
   On réutilise chooseTrip() — c'est lui qui pose le voyage, l'inscrit dans
   l'historique, débloque l'étape 3 et vide les caches périmés. Réécrire cette
   séquence ici en aurait fait une deuxième version, et c'est exactement le
   genre de duplication qui finit par diverger. */
function iaAjouteAuxVoyages(i, j){
  const m = iaLog()[i];
  const c = m && m.cartes && m.cartes[j];
  if(!c) return;
  /* chooseTrip lit state.destinations : on y remet la proposition choisie sous
     la forme que le reste de l'app attend. */
  const src = (state.lastProps && state.lastProps.destinations || [])
    .find(x => x && String(x.nom) === c.nom);
  if(!src){
    toast('Cette proposition n’est plus disponible — relance la recherche');
    return;
  }
  state.destinations = [src];
  chooseTrip(0);
  iaAjoute('aco', `« ${c.nom} » est ajouté à tes voyages. Tu peux me demander le programme, ou aller le voir dans l’onglet Voyage.`);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-iaadd]');
  if(!b) return;
  const [i, j] = b.dataset.iaadd.split(':').map(Number);
  iaAjouteAuxVoyages(i, j);
});

function iaRender(){
  const fil = $('#iaFil');
  if(!fil) return;
  const L = iaLog();
  /* posé ici, avant les deux sorties : c'est le seul endroit traversé par tout
     changement du fil (envoi, réponse, effacement, arrivée par la synchro) */
  iaClearMaj();
  if(!L.length){
    fil.innerHTML = '<div class="ia-vide">'
      + ICO('etincelle',30,'ia-vide-ico')
      + "Pose une question sur ton voyage, décris-en un nouveau, ou demande une modification. "
      + 'En français, comme à quelqu’un.</div>';
    return;
  }
  /* data-i porte l'index RÉEL dans chatLog : c'est l'ancre utilisée par
     l'historique de la colonne de gauche pour ramener à un message précis. */
  fil.innerHTML = L.map((m, i) => {
    const moi = m.qui === 'moi';
    /* Les propositions occupent toute la largeur du fil : ce sont des objets à
       comparer, pas une réplique dans une bulle. */
    const cartes = Array.isArray(m.cartes) && m.cartes.length
      ? '<div class="ia-cartes">' + m.cartes.map((c, j) => {
          const mode = { avion:'avion', train:'train', voiture:'voiture' }[c.trMode] || 'avion';
          /* Une ligne = un sujet, avec son icône et son POURQUOI. C'est le
             « pourquoi » qui explique le voyage : sans lui, on liste des faits. */
          const ligne = (ico, titre, detail, pourquoi) => detail || pourquoi ? `
            <div class="iac-l">
              <span class="iac-li">${ICO(ico, 17)}</span>
              <span class="iac-lt">
                <b>${esc(titre)}${detail ? ' · ' + esc(detail) : ''}</b>
                ${pourquoi ? `<em>${esc(pourquoi)}</em>` : ''}
              </span>
            </div>` : '';
          return `
          <div class="ia-carte">
            <div class="iac-t">
              <b>${esc(c.nom)}</b>
              ${c.pays ? `<em>${esc(c.pays)}</em>` : ''}
            </div>
            ${c.resume ? `<p class="iac-r">${esc(c.resume)}</p>` : ''}
            ${c.forts && c.forts.length ? `<ul class="iac-forts">${
              c.forts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
            <div class="iac-lignes">
              ${ligne(mode, 'Y aller', [c.trPrix, c.trDuree].filter(Boolean).join(' · '), c.trPourquoi)}
              ${ligne('hotel', c.quartier || 'Logement',
                      [c.logType, c.logPrix].filter(Boolean).join(' · '), c.logPourquoi)}
            </div>
            <div class="iac-f">
              ${c.budget ? `<span>${esc(c.budget)}</span>` : ''}
              ${c.duree ? `<span>${esc(c.duree)}</span>` : ''}
              ${c.meteo ? `<span>${esc(c.meteo)}</span>` : ''}
              ${c.monnaie ? `<span>${esc(c.monnaie)}</span>` : ''}
            </div>
            <button class="btn sm iac-go" data-iaadd="${i}:${j}" type="button">
              ${ICO('plus', 16)}<span>Ajouter à mes voyages</span>
            </button>
          </div>`; }).join('') + '</div>'
      : '';
    return '<div class="ia-msg ' + (moi ? 'moi' : 'aco') + (m.rate ? ' rate' : '')
      + (cartes ? ' large' : '') + '" data-i="' + i + '">'
      + '<span class="ia-qui">' + (moi ? 'Toi' : 'Acolyte') + '</span>'
      + '<div class="ia-txt">' + esc(m.t) + '</div>'
      + cartes + '</div>';
  }).join('');
  /* on colle au dernier message : sans ça, chaque réponse arrive hors champ */
  fil.scrollTop = fil.scrollHeight;
  /* la colonne de gauche EST l'historique : elle doit suivre chaque message.
     ⚠️ Seulement quand on est sur l'onglet — sinon on redessine la colonne
     d'une autre catégorie. */
  if(typeof _cat !== 'undefined' && _cat === 'ia' && typeof renderRail === 'function') renderRail();
}

/* La ligne d'état. `pense` ajoute les trois points animés : ils disent que le
   travail continue, ce qu'un texte figé ne dit pas pendant quarante secondes. */
function iaEtat(msg, pense){
  const e = $('#iaEtat');
  if(!e) return;
  if(!msg){ e.textContent = ''; return; }
  e.innerHTML = esc(msg) + (pense ? '<span class="ia-pense" aria-hidden="true"><i></i><i></i><i></i></span>' : '');
}

/* « Effacer » n'a de sens que s'il y a quelque chose à effacer. Actif sur une
   conversation vide, c'est une commande qui ne fait rien — et une commande qui
   ne fait rien apprend à douter de toutes les autres. */
function iaClearMaj(){
  const b = $('#iaClear');
  if(b) b.disabled = !(Array.isArray(state.chatLog) && state.chatLog.length);
}

/* ⚠️ `_iaDernier` a été SUPPRIMÉ avec la liste « Ce qu'Acolyte fait » : la
   colonne de gauche porte désormais l'historique de la conversation, et plus
   rien ne lisait cette variable. Une valeur qu'on continue d'écrire sans que
   personne ne la lise est une fausse piste pour la prochaine lecture — c'est
   la même raison qui avait fait retirer .cat-pc de la feuille de style.
   L'intention reste affichée là où elle compte : la ligne #iaIntent. */

/* ---- Mode QUESTION : lecture seule, et c'est tout son intérêt ----
   ⚠️ expectJson = false. On veut une phrase, pas une structure : demander du
   JSON pour en extraire un champ « reponse » ajouterait un point de rupture
   (JSON invalide → échec) sans rien apporter. */
/* ------------------------------------------------------------
   CE QUE L'ASSISTANT SAIT DU VOYAGE
   ------------------------------------------------------------
   ⚠️ IL NE RECEVAIT QUE LA LISTE DES ÉTAPES. Tout le reste — le budget calculé,
   le mode de transport retenu, le quartier du logement, les formalités, et
   surtout les DONNÉES RÉELLES déjà relevées (météo, distance, taux de change,
   jours fériés, horaires de train) — dormait dans state.cache sans jamais lui
   être montré. Il répondait donc de mémoire sur des faits que l'app avait
   pourtant vérifiés, et se contredisait avec ses propres écrans.
   Tout ce qui suit est DÉJÀ en mémoire : rien n'est recalculé, aucun appel
   réseau. C'est de l'information qu'on cessait simplement de transmettre. */
function iaContexteVoyage(){
  const t = state.trip, p = state.prefs || {}, c = state.cache || {};
  if(!t) return "Le voyageur n'a pas encore de voyage en cours.";
  const L = [];
  L.push('VOYAGE EN COURS : ' + (t.nom || '?') + (t.pays ? ', ' + t.pays : ''));
  if(p.from) L.push('Départ depuis : ' + p.from);
  if(p.depart){
    const d = new Date(p.depart + 'T12:00:00');
    if(!isNaN(d)){
      const jours = Math.round((d - new Date()) / 86400000);
      L.push('Date de départ : ' + d.toLocaleDateString(LOC())
        + (jours > 0 ? ' (dans ' + jours + ' jour(s))' : jours === 0 ? " (c'est aujourd'hui)" : ' (voyage commencé)'));
    }
  }
  if(p.days) L.push('Durée : ' + p.days);

  /* Le plan retenu : ce que le voyageur VOIT dans ses onglets. Répondre à côté
     de ses propres écrans est la pire façon de perdre sa confiance. */
  const pl = c.plan;
  if(pl){
    if(pl.budget && pl.budget.total) L.push('Budget total annoncé : ' + pl.budget.total);
    if(pl.transport) L.push('Transport retenu : ' + (pl.transport.mode || '?')
      + (pl.transport.details ? ' — ' + String(pl.transport.details).slice(0, 200) : ''));
    if(pl.logement) L.push('Logement : quartier ' + (pl.logement.quartier || '?'));
    if(pl.formalites) L.push('Formalités annoncées : ' + String(pl.formalites).slice(0, 250));
    if(pl.couts_sur_place) L.push('Coûts sur place : ' + String(pl.couts_sur_place).slice(0, 250));
    if(pl.conseil_cle) L.push('Conseil clé du plan : ' + String(pl.conseil_cle).slice(0, 200));
  }

  /* Les relevés réels. Ce sont les SEULS chiffres sur lesquels il a le droit
     d'être affirmatif — ils viennent d'API, pas du modèle. */
  const R = c._real;
  if(R){
    const V = [];
    if(R.dist)  V.push('distance à vol d’oiseau : ' + R.dist + ' km');
    if(R.meteo) V.push('météo : ' + R.meteo);
    if(R.train) V.push('train : ' + R.train);
    if(R.fx)    V.push('change : ' + R.fx);
    if(R.feries)V.push('jours fériés pendant le séjour : ' + R.feries);
    if(R.wv)    V.push('infos voyageur (Wikivoyage) : ' + String(R.wv).slice(0, 250));
    if(V.length) L.push('\nDONNÉES RÉELLES DÉJÀ VÉRIFIÉES (API, pas des souvenirs — appuie-toi dessus et ne les contredis jamais) :\n- ' + V.join('\n- '));
  }

  const prog = (typeof asstResume === 'function') ? asstResume() : '';
  if(prog) L.push('\nPROGRAMME JOUR PAR JOUR :\n' + prog);
  return L.join('\n');
}

/* ------------------------------------------------------------
   TOUTE LA CONVERSATION, PAS SES CINQ DERNIERS MESSAGES
   ------------------------------------------------------------
   ⚠️ L'assistant ne recevait que `slice(-6,-1)` : cinq messages. Au sixième
   échange il avait déjà oublié la contrainte posée au deuxième (« je pars avec
   un enfant de 3 ans », « pas d'avion »), et il fallait la répéter. Une
   conversation dont on doit se souvenir à la place de son interlocuteur n'en
   est pas une.
   Il reçoit désormais TOUTE la session. Deux bornes, et elles sont là pour ne
   pas exploser le budget de jetons, pas pour oublier :
     · chaque message est tronqué à 400 caractères — au-delà, c'est du détail
       qu'on ne mobilise pas pour comprendre un sous-entendu ;
     · l'ensemble est plafonné à IA_CTX_MAX caractères, en gardant les plus
       RÉCENTS. Si on doit couper, on coupe le début : c'est ce qu'on vient de
       dire qui éclaire la phrase suivante.
   Le fil lui-même est déjà borné à 100 entrées par safeState : ce plafond n'est
   donc atteint que dans des conversations très longues.
------------------------------------------------------------ */
const IA_CTX_MAX = 6000;
function iaHistorique(){
  const L = Array.isArray(state.chatLog) ? state.chatLog : [];
  /* on retire le dernier : c'est la question qu'on est en train de poser */
  const lignes = L.slice(0, -1).map(m =>
    (m.qui === 'moi' ? 'Voyageur' : 'Toi') + ' : ' + String(m.t || '').replace(/\s+/g, ' ').slice(0, 400));
  let total = 0;
  const gardes = [];
  for(let i = lignes.length - 1; i >= 0; i--){
    total += lignes[i].length + 1;
    if(total > IA_CTX_MAX) break;
    gardes.unshift(lignes[i]);
  }
  /* On DIT qu'on a coupé plutôt que de laisser croire à un fil complet : le
     modèle doit savoir qu'il lui manque un début, sinon il répond comme si le
     premier message visible était le premier de la conversation. */
  const coupe = gardes.length < lignes.length;
  return { texte: gardes.join('\n'), coupe, gardes: gardes.length, total: lignes.length };
}

function iaPromptQuestion(demande, complexe){
  const h = iaHistorique();
  const derniers = h.texte;
  return "Tu es Acolyte, copilote de voyage. Tu réponds à la question d'un voyageur "
    + 'à partir de SON voyage, pas de généralités.\n\n'
    + iaContexteVoyage() + '\n'
    /* ⚠️ Les échanges précédents : sans eux, « et le lendemain ? » ne veut rien
       dire. C'est ce qui sépare une conversation d'une suite de questions. */
    + (derniers ? '\nTOUTE VOTRE CONVERSATION jusqu’ici'
        + (h.coupe ? ' (le début a été coupé, elle a commencé plus tôt)' : '')
        + ' — tiens compte de TOUT ce qui y a été dit, notamment des contraintes '
        + 'que le voyageur a posées une seule fois :\n' + derniers + '\n' : '')
    + '\nQuestion : « ' + String(demande).slice(0, 400) + ' »\n\n'
    + 'RÈGLES, dans cet ordre de priorité :\n'
    + "1. Appuie-toi D'ABORD sur les informations ci-dessus. Si la réponse s'y trouve, cite-la telle quelle — ne la recalcule pas et ne la contredis pas.\n"
    + "2. Si tu n'es pas sûr d'un horaire, d'un prix, d'une disponibilité ou d'une règle d'entrée, DIS-LE franchement et renvoie à la source officielle. "
    + "Un « je ne suis pas sûr, vérifie sur leur site » est une bonne réponse ; un chiffre inventé fait rater un train. Ne devine JAMAIS un nombre.\n"
    + '3. Sois CONCRET : un lieu, une heure, un ordre de grandeur, un conseil actionnable. Pas de généralités touristiques.\n'
    /* Une question complexe attend un ARBITRAGE, pas un résumé : on autorise la
       longueur nécessaire, et on demande explicitement de trancher. Une réponse
       qui expose deux options sans choisir ne sert à rien à quelqu'un qui part
       dans douze jours. */
    + (complexe
        ? "4. Cette question demande de comparer ou d'arbitrer. Prends le temps : pose les termes du choix, "
          + 'pèse-les avec les données ci-dessus (budget, durée, distances, météo, jours fériés), puis TRANCHE en '
          + "recommandant une option et en disant pourquoi. 8 phrases maximum. Une réponse qui n'ose pas choisir ne "
          + "sert à rien. En français, tutoiement, ton direct.\n"
        : '4. 4 phrases maximum, en français, tutoiement, ton direct. Pas de liste à puces, pas de titre : une réponse parlée.\n')
    + "5. Tu ne modifies RIEN ici. Si la demande implique un changement du programme, réponds à la question ET dis-lui qu'il peut simplement te demander la modification.";
}

/* ---- Mode CRÉER : la phrase libre devient le questionnaire ----
   On ne fabrique pas un voyage ici. On remplit les champs, puis on laisse le
   pipeline existant travailler — c'est lui qui a les données réelles, la
   relecture croisée et les garde-fous. */
/* ⚠️ LES VALEURS PERMISES SONT LUES DANS LE <select>, JAMAIS RECOPIÉES ICI.
   Première version : le prompt demandait « week|1sem|2sem » et « petit|moyen|
   large ». Les vraies valeurs du formulaire sont des phrases françaises
   (« une semaine », « budget moyen (500-1200€) ») : rien ne correspondait,
   iaPoseSelect refusait — correctement, sans forcer de valeur fausse — et la
   durée comme le budget n'étaient tout simplement jamais remplis. Le bug était
   SILENCIEUX : le questionnaire s'ouvrait, à moitié rempli, sans une erreur.
   En listant les options réelles, le vocabulaire ne peut plus diverger : le
   jour où une option change dans index.html, le prompt suit tout seul. */
function iaOptions(sel){
  const el = $(sel);
  if(!el) return '';
  return [...el.options].map(o => '"' + o.value + '"').join(' | ');
}
function iaPromptCreer(demande){
  return 'Transforme cette envie de voyage en champs de formulaire.\n\n'
    + 'Envie : « ' + String(demande).slice(0, 500) + ' »\n\n'
    + 'Réponds en JSON strict, uniquement avec les champs que la phrase permet de déduire :\n'
    + '{"from":"ville de départ","dest":"destination ou pays souhaité","days":"…","when":"période en clair (ex. mai, été)",'
    + '"budget":"…","adults":2,"kids":0,"libre":"le reste de l\'envie, en une phrase"}\n\n'
    + 'Règles :\n'
    + "1. N'INVENTE RIEN. Un champ que la phrase ne permet pas de déduire est ABSENT du JSON — surtout \"from\" et \"dest\".\n"
    + '2. "days" doit être COPIÉ MOT POUR MOT depuis cette liste : ' + iaOptions('#fDays') + '\n'
    + '3. "budget" doit être COPIÉ MOT POUR MOT depuis cette liste : ' + iaOptions('#fBudget') + '\n'
    + '   (le budget s\'entend PAR PERSONNE ; si la phrase n\'en donne aucun, omets le champ)\n'
    + "4. \"libre\" reprend les envies qui n'entrent dans aucun champ (ambiance, contraintes, centres d'intérêt).";
}

/* Pose une valeur dans un <select> SEULEMENT si l'option existe vraiment.
   Un select forcé à une valeur inconnue retombe silencieusement sur sa
   première option — donc sur un choix que personne n'a fait. */
function iaPoseSelect(sel, valeur){
  const el = $(sel);
  if(!el || !valeur) return false;
  const v = String(valeur).toLowerCase();
  const opt = [...el.options].find(o =>
    o.value.toLowerCase() === v || o.value.toLowerCase().includes(v) || v.includes(o.value.toLowerCase()));
  if(!opt) return false;
  el.value = opt.value;
  return true;
}

async function iaCreer(demande, deja){
  /* `deja` : les champs extraits par la classification. S'ils sont là, on
     économise un appel complet — c'est l'attente que ça supprime, pas des
     jetons. On ne rappelle le modèle que s'il ne les a pas fournis. */
  let data = deja;
  if(!data || typeof data !== 'object' || !Object.keys(data).length){
    const r = await ai('light', iaPromptCreer(demande), true, 700);
    data = r && r.data;
  }
  if(!data || typeof data !== 'object') throw new Error('IA_FORME');
  const mis = [];
  const texte = (sel, val, nom) => {
    const el = $(sel);
    if(el && val && String(val).trim()){ el.value = String(val).slice(0, 90); mis.push(nom); }
  };
  texte('#fFrom', data.from, 'départ');
  texte('#fDest', data.dest, 'destination');
  texte('#fWhen', data.when, 'période');
  if(iaPoseSelect('#fDays', data.days)) mis.push('durée');
  if(iaPoseSelect('#fBudget', data.budget)) mis.push('budget');
  const el = $('#fAdults');
  if(el && Number.isFinite(+data.adults) && +data.adults > 0){ el.value = String(Math.min(+data.adults, 6)); mis.push('voyageurs'); }
  const ek = $('#fKids');
  if(ek && Number.isFinite(+data.kids) && +data.kids >= 0) ek.value = String(Math.min(+data.kids, 4));
  const libre = $('#fFree');
  if(libre && data.libre) libre.value = String(data.libre).slice(0, 600);

  if(!mis.length){
    iaAjoute('aco', "Je n'ai pas réussi à en tirer de quoi remplir le questionnaire. "
      + 'Donne-moi au moins un lieu ou une période — par exemple « une semaine au Portugal en mai ».', true);
    return;
  }
  /* ⚠️ PLUS DE BASCULE D'ONGLET. La recherche part d'ici et son résultat
     revient ICI, sous la phrase qui l'a demandée.
     L'ancienne version remplissait le questionnaire puis emmenait sur l'onglet
     Voyage en demandant de lancer soi-même. C'était prudent — une intention
     mal classée n'aurait pas brûlé le quota — mais ça coupait la conversation
     en deux et obligeait à un aller-retour pour une demande qu'on venait
     d'exprimer clairement.
     La prudence est conservée autrement : les champs déduits sont ANNONCÉS
     avant la recherche, donc une erreur de lecture se voit dans le fil. */
  iaAjoute('aco', 'Compris : ' + mis.join(', ') + '. Je cherche…');
  /* ⚠️ UNE ATTENTE LONGUE SANS SIGNAL RESSEMBLE À UNE PANNE. La génération de
     propositions est l'appel le plus lourd de l'app (8192 jetons + réflexion,
     puis une relecture croisée) : elle prend couramment 30 à 60 secondes.
     Sans ces messages, l'écran restait figé sur « Acolyte réfléchit » et on
     concluait que c'était cassé — c'est exactement ce qui a été remonté.
     On fait donc défiler l'étape en cours, et on ANNONCE la durée. */
  const etapes = [
    'Acolyte explore le monde… (30 à 60 s)',
    'Il compare les villes et les ambiances…',
    'Vérification du budget, de la saison et des accès…',
    'Transport et quartier pour chaque proposition…',
    'Relecture par une seconde IA…',
    'Presque prêt…'
  ];
  let k = 0;
  iaEtat(etapes[0], true);
  const t = setInterval(() => { k++; iaEtat(etapes[Math.min(k, etapes.length - 1)], true); }, 6000);
  try{ await proposeTrips('', false, '', 'chat'); }
  finally{ clearInterval(t); }
}

/* ---- Mode MODIFIER : le noyau validé de l'assistant, piloté depuis ici ---- */
/* Le numéro de jour visé par une demande. « le jour 3 », « J3 », « troisième
   journée », « demain ». Rend null quand rien n'est désigné — on ne devine pas. */
/* ⚠️ TABLE EXPLICITE, PAS DE CALCUL D'INDICE. Ma première version rangeait les
   variantes accentuées et non accentuées dans un tableau plat et retrouvait le
   rang par Math.floor(i/2)+1. « premier » n'ayant pas de variante sans accent,
   tout était décalé d'un cran : « la troisième journée » rendait 2, et
   l'assistant serait allé modifier le mauvais jour sans que rien ne le signale.
   Une paire mot → nombre ne peut pas se décaler. */
const IA_RANGS = {
  1:['premier','première','premiere','1re','1ère'], 2:['deuxième','deuxieme','second','seconde'],
  3:['troisième','troisieme'],  4:['quatrième','quatrieme'], 5:['cinquième','cinquieme'],
  6:['sixième','sixieme'],      7:['septième','septieme'],   8:['huitième','huitieme'],
  9:['neuvième','neuvieme'],   10:['dixième','dixieme']
};
function iaJourVise(texte){
  const s = String(texte || '').toLowerCase();
  const m = s.match(/\bj(?:our)?\s*\.?\s*(\d{1,2})\b/);
  if(m) return +m[1];
  for(const [n, mots] of Object.entries(IA_RANGS)){
    if(mots.some(w => new RegExp('\\b' + w + '\\b').test(s))) return +n;
  }
  return null;
}

async function iaModifier(demande, complexe){
  /* ⚠️ CE REFUS ÉTAIT LE PIRE MOMENT DE L'ASSISTANT. Juste après avoir généré
     un voyage, `state.cache.days` est VIDE : les journées ne sont détaillées
     qu'au clic, une par une. La demande la plus naturelle qui suit — « modifie
     l'après-midi du jour 3 » — tombait donc sur « Crée d'abord un voyage »,
     c'est-à-dire un refus qui demande de faire ce qu'on vient de faire.
     On construit maintenant la journée visée avant de la modifier. Le coût est
     assumé et annoncé : une journée manquante, c'est un appel de plus, pas une
     impasse. */
  const aDesJours = state.cache && state.cache.days && Object.keys(state.cache.days).length;
  const aUnPlan   = state.cache && state.cache.plan && Array.isArray(state.cache.plan.programme)
                    && state.cache.plan.programme.length;
  if(!aDesJours){
    if(!aUnPlan){
      iaAjoute('aco', "Tu n'as pas encore de voyage à modifier. "
        + 'Décris-moi ce que tu cherches et je t’en propose un.', true);
      return;
    }
    const vise = iaJourVise(demande);
    const jours = state.cache.plan.programme.map(j => +j.jour).filter(n => n > 0);
    const cible = (vise && jours.includes(vise)) ? vise : jours[0];
    if(!cible){
      iaAjoute('aco', "Ton voyage n'a pas encore de journées numérotées. Ouvre l’onglet Voyage et lance le programme.", true);
      return;
    }
    iaEtat('Je construis d’abord le jour ' + cible + '…', true);
    try{
      await construitJour(cible);
      try{ tlRender(cible); }catch(e){}
      iaAjoute('aco', `Le jour ${cible} n’était pas encore détaillé — je viens de le construire, et j’applique ta demande dessus.`);
    }catch(e){
      iaAjoute('aco', "Je n’ai pas réussi à construire cette journée. Réessaie dans un instant.", true);
      return;
    }
  }
  statCompte('assistant_utilise');
  /* Réorganiser une journée (déplacer, décaler, recomposer) demande de tenir
     l'ordre, les heures et la géographie ensemble — c'est là que le modèle
     léger produit des opérations incohérentes, que asstApplique rejette
     ensuite. Mieux vaut payer le modèle lourd que faire refuser la demande. */
  const r = await ai(complexe ? 'heavy' : 'light', asstPrompt(demande), true, complexe ? 2200 : 1400);
  const data = r && r.data;
  const ops = Array.isArray(data && data.operations) ? data.operations : [];
  if(!ops.length){
    iaAjoute('aco', String((data && data.resume) || "Je n'ai rien trouvé à changer."), true);
    return;
  }
  _iaAvant = JSON.stringify(state.cache.days);
  const res = asstApplique(ops);
  if(!res.faites.length){
    _iaAvant = null;
    iaAjoute('aco', 'Je n’ai rien pu appliquer : ' + res.refusees.map(x => x.err).join(' · ').slice(0, 300), true);
    return;
  }
  save();
  res.faites.forEach(f => { try{ tlRender(Number(f.op.jour)); }catch(e){} });
  try{ buildProjectMap(); }catch(e){}
  const signe = { supprimer:'−', ajouter:'+', modifier:'~', deplacer:'→' };
  const lignes = res.faites.map(f => (signe[f.op.action] || '·') + ' jour ' + f.op.jour + ' : ' + f.quoi);
  const bloc = [String((data && data.resume) || 'C’est fait.'), ''].concat(lignes);
  if(res.refusees.length){
    bloc.push('', '(' + res.refusees.length + ' opération(s) ignorée(s) : '
      + res.refusees.map(x => x.err).join(' · ').slice(0, 160) + ')');
  }
  iaAjoute('aco', bloc.join('\n'));
  const u = $('#iaUndo'); if(u) u.hidden = false;
}

function iaAnnule(){
  if(!_iaAvant) return;
  statCompte('assistant_annule');
  try{
    state.cache.days = JSON.parse(_iaAvant);
    _iaAvant = null;
    save();
    Object.keys(state.cache.days).forEach(j => { try{ tlRender(Number(j)); }catch(e){} });
    try{ buildProjectMap(); }catch(e){}
    iaAjoute('aco', '↩ Modification annulée : ton programme est revenu à son état d’avant.');
    const u = $('#iaUndo'); if(u) u.hidden = true;
  }catch(e){}
}

/* ⚠️ AUCUNE SORTIE MUETTE DANS CETTE FONCTION.
   « J'appuie sur Envoyer et il ne se passe rien » a déjà coûté deux allers-
   retours de débogage, pour deux causes différentes. La leçon n'est pas la
   cause, c'est la FORME : chaque `return` précoce était invisible. Un bouton
   qui sort sans rien dire ne laisse rien à diagnostiquer — ni à l'utilisateur,
   ni à moi. Désormais chaque refus s'écrit à l'écran, et tout ce qui pourrait
   lever une exception est enveloppé. */
async function iaEnvoie(){
  const inp = $('#iaInp');
  if(_iaOccupe){
    iaEtat('Un instant — je termine la demande précédente.');
    return;
  }
  const texte = (inp && inp.value || '').trim();
  if(!texte){
    iaEtat('Écris ta demande d’abord.');
    if(inp) try{ inp.focus(); }catch(e){}
    return;
  }
  /* Les appels IA passent par le compte : même porte que partout ailleurs.
     ⚠️ On TESTE avec estConnecte(), et on n'appelle requireAuth() que pour son
     effet — ouvrir l'écran de connexion. L'inverse (`if(!requireAuth())`)
     sortait toujours, puisqu'elle ne renvoie jamais rien. */
  if(!estConnecte()){
    iaAjoute('aco', 'Il faut un compte pour que je puisse répondre — je t’ouvre la page de connexion.', true);
    iaEtat('');
    exigeCompte('Crée ton compte pour parler à l’assistant');
    return;
  }
  inp.value = '';
  iaGrandit();                 /* la barre se replie après l'envoi */
  iaAjoute('moi', texte);
  _iaOccupe = true;
  const hote = $('#catIA'); if(hote) hote.classList.add('ia-occupe');
  iaEtat('Acolyte lit ta demande', true);
  try{
    /* 1. QU'EST-CE QU'ON ME DEMANDE ? — un appel court et bon marché (120
       jetons), avant tout le reste. Il coûte moins qu'une réponse mal ciblée. */
    const { intention: intent, complexe, voyage } = await iaIntention(texte);
    iaAnnonce(intent);
    /* 2. On le DIT avant d'agir. Une intention mal lue doit se voir dans le fil,
       pas seulement dans ses conséquences. */
    iaEtat(IA_INTENTS[intent].mot
      + (complexe ? ' — je prends le temps de réfléchir' : ''), true);
    if(intent === 'question'){
      /* ⚠️ LE MODÈLE SUIT LA DIFFICULTÉ, il n'est plus le même pour tout.
         Tout partait sur « light » (Groq, petit modèle) avec 700 jetons : bien
         assez pour « à quelle heure ouvre le musée », beaucoup trop court dès
         qu'il faut comparer deux options, tenir un budget et une durée
         ensemble, ou expliquer une conséquence. Les réponses devenaient vagues
         exactement là où on attendait un avis.
         La difficulté est lue dans le MÊME appel que l'intention : ce
         discernement ne coûte donc aucun aller-retour supplémentaire, et le
         modèle lourd n'est dépensé que quand la question le mérite. */
      const r = await ai(complexe ? 'heavy' : 'light', iaPromptQuestion(texte, complexe),
                         false, complexe ? 1400 : 700);
      iaAjoute('aco', String(r && r.data || '').trim() || "Je n'ai pas su répondre.");
    }else if(intent === 'creer'){
      await iaCreer(texte, voyage);
    }else{
      await iaModifier(texte, complexe);
    }
  }catch(e){
    statCompte('ia_echec');
    iaAjoute('aco', "Je n'ai pas pu répondre — le service est peut-être saturé. Réessaie dans un instant.", true);
  }finally{
    /* iaEtat('') était écrit deux fois, dans le try ET dans le catch. Ça
       marchait, mais c'est le motif exact qui a laissé la barre de recherche
       tourner en boucle juste au-dessus : le jour où l'un de ces chemins gagne
       un `return`, l'indicateur « Acolyte réfléchit » reste allumé pour
       toujours. Le nettoyage appartient au finally. */
    iaEtat('');
    _iaOccupe = false;
    if(hote) hote.classList.remove('ia-occupe');
  }
}

/* ⚠️ REPÈRE DE VERSION. « Ça ne fait rien » a une cause bête et fréquente sur
   ce projet : le navigateur exécute un ANCIEN app.js servi par le service
   worker, pendant que le index.html, lui, est à jour — on voit donc le nouveau
   bouton branché sur l'ancien code. C'est exactement le défaut que le README
   appelle le plus coûteux du projet, et il ne laisse aucune trace.
   Cette ligne le rend vérifiable en une seconde : si la console ne l'affiche
   pas au chargement, le fichier qui tourne n'est pas celui qu'on croit. */
const IA_BUILD = 'assistant-2026-08-09';

/* ---- La pop-up de bêta ----
   Montrée UNE fois, au premier passage sur l'onglet, et relisable par le
   bouton 🧪. Elle a remplacé un encadré permanent : celui-ci mangeait un tiers
   de la hauteur à chaque visite et cessait d'être lu dès la deuxième.
   ⚠️ Le drapeau est posé à l'OUVERTURE, pas à la fermeture. Si on attendait le
   clic sur « J'ai compris », un rechargement pendant la lecture la ferait
   revenir indéfiniment — et un avertissement qui se répète devient un obstacle
   qu'on apprend à écarter sans lire. */
const IA_BETA_VUE = 'acolite_ia_beta_vue';
function iaBetaOuvre(){
  lsSet(IA_BETA_VUE, '1');
  $('#ovIaBeta')?.classList.add('show');
}
function iaBetaSiPremiereFois(){
  let vue = '1';
  try{ vue = localStorage.getItem(IA_BETA_VUE); }catch(e){}
  if(!vue) iaBetaOuvre();
}

/* La hauteur de la console : tout ce qui reste sous elle, moins la réserve du
   bas de page. On MESURE au lieu de recopier des constantes de la feuille de
   style — un `calc()` avec la hauteur de l'en-tête écrite en dur se périme au
   premier ajustement, et personne ne fait le lien.
   ⚠️ Appelé APRÈS l'affichage de la section : sur un élément encore masqué,
   getBoundingClientRect() renvoie 0 et la console naîtrait à 420px. */
function iaHauteur(){
  const s = $('#catIA');
  if(!s || s.classList.contains('hidden')) return;
  /* ⚠️ ON RÉSERVE CE QUI GÊNE VRAIMENT, PAS LE PADDING DE .wrap.
     Je retranchais son padding-bas — 120 px, la place de la barre d'onglets du
     téléphone. Sur ordinateur cette barre est DANS l'en-tête, en haut : les
     120 px n'obstruaient rien et laissaient un trou sous la zone d'écriture,
     qui flottait au milieu de l'écran au lieu de se poser en bas.
     On mesure donc l'obstacle réel : la barre d'onglets seulement si elle est
     réellement fixée en bas. Ailleurs, une simple respiration. */
  const nav = document.querySelector('.catnav');
  let reserve = 16;
  if(nav && getComputedStyle(nav).position === 'fixed'){
    reserve = Math.round(nav.getBoundingClientRect().height) + 12;
  }
  const dispo = window.innerHeight - s.getBoundingClientRect().top - reserve;
  s.style.height = Math.max(420, Math.round(dispo)) + 'px';
}

/* La zone de texte grandit avec ce qu'on écrit, au lieu d'être haute « au cas
   où ». Elle démarre à une ligne — donc à la hauteur du bouton Envoyer, qui
   cesse ainsi de flotter au bas d'une barre trop grande — et s'étire jusqu'au
   plafond posé par le CSS (max-height), au-delà duquel elle défile. */
function iaGrandit(){
  const t = $('#iaInp');
  if(!t) return;
  t.style.height = 'auto';
  const max = parseFloat(getComputedStyle(t).maxHeight) || 160;
  t.style.height = Math.min(t.scrollHeight, max) + 'px';
}

function iaMonte(){
  if(!$('#catIA')) return;
  console.info('[acolyte] assistant IA monté — build ' + IA_BUILD);
  /* Les icônes sont posées en JS : elles vivent dans ICO_D, un seul endroit à
     tenir. Les écrire en dur dans index.html en aurait fait deux. */
  { const b = $('#iaInfo'); if(b) b.innerHTML = ICO('ampoule', 17); }
  { const b = $('#iaClear'); if(b) b.innerHTML = ICO('poubelle', 17); }
  /* Le bouton d'envoi n'est plus qu'une icône : le mot « Envoyer » à côté d'un
     avion en papier disait deux fois la même chose, et il forçait la barre à
     s'élargir. Le libellé survit en aria-label et en title — un lecteur d'écran
     l'annonce toujours. */
  { const b = $('#iaGo'); if(b){ b.innerHTML = ICO('envoyer', 20);
      b.setAttribute('aria-label','Envoyer'); b.title = 'Envoyer'; } }
  window.__acolyteIA = { build: IA_BUILD, envoie: () => iaEnvoie() };
  const go = $('#iaGo'); if(go) go.onclick = iaEnvoie;
  const info = $('#iaInfo'); if(info) info.onclick = iaBetaOuvre;
  const inp = $('#iaInp');
  /* Entrée envoie, Maj+Entrée passe à la ligne : la convention de toutes les
     zones de conversation. C'est une zone MULTILIGNE, donc il faut le dire —
     son comportement par défaut est l'inverse. */
  if(inp) inp.addEventListener('keydown', e => {
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); iaEnvoie(); }
  });
  if(inp) inp.addEventListener('input', iaGrandit);
  /* ⚠️ « Effacer » est devenu « Nouvelle discussion », et ce n'est pas qu'un
     changement de mot. Depuis que l'assistant garde TOUTE la session en
     mémoire, ce bouton est le seul moyen de repartir d'une page blanche —
     c'est lui qui délimite une conversation. Son icône est une corbeille :
     l'action reste destructrice, on ne l'adoucit pas. */
  const cl = $('#iaClear');
  if(cl) cl.onclick = () => {
    if(iaLog().length && !confirm('Démarrer une nouvelle discussion ? Acolyte oubliera tout ce qui a été dit ici.')) return;
    state.chatLog = []; _iaAvant = null; save(); iaRender(); iaEtat('');
    const u = $('#iaUndo'); if(u) u.hidden = true;
    const ti = $('#iaIntent'); if(ti) ti.hidden = true;
    /* iaRender() ci-dessus redessine déjà la colonne d'historique, qui se vide
       en même temps que le fil. */
  };
  /* Le bouton d'annulation est créé ICI et non dans index.html : il n'a de
     sens qu'après une modification, et un bouton présent mais inerte au
     chargement est une promesse qu'on ne tient pas. */
  const saisie = $('.ia-saisie');
  if(saisie && !$('#iaUndo')){
    const u = document.createElement('button');
    u.id = 'iaUndo'; u.type = 'button'; u.className = 'btn ghost sm'; u.hidden = true;
    u.innerHTML = ICO('retour',16) + '<span>Annuler la modification</span>';
    u.onclick = iaAnnule;
    saisie.parentNode.insertBefore(u, saisie.nextSibling);
  }
  iaRender();
}
iaMonte();

/* La fenêtre change de taille (ordinateur qu'on réduit, téléphone qu'on
   tourne) → la console se réajuste, sinon elle garde la hauteur en pixels
   calculée pour l'ancienne.
   (Le renvoi vers l'onglet Voyage sous 900 px a disparu avec la restriction :
   l'Assistant existe désormais à toutes les tailles.) */
window.addEventListener('resize', () => {
  if(_cat === 'ia' && typeof iaHauteur === 'function') iaHauteur();
});

/* ============================================================
   MICRO-INTERACTIONS DU QUESTIONNAIRE
   ------------------------------------------------------------
   Une sélection qui ne répond pas laisse douter qu'elle a été prise — surtout
   sur un formulaire long, où l'on coche quatorze choses de suite sans jamais
   savoir si le geste a porté. Un signal de 200 ms suffit : il confirme sans
   faire attendre.
   ⚠️ Un seul écouteur délégué, en capture : les champs sont dans le HTML mais
   les puces sont reconstruites à chaque rendu des préférences. Poser un
   écouteur sur chacune les perdrait au premier redessin.
============================================================ */
function marqueChangement(el){
  if(!el || (typeof motionOff === 'function' && motionOff())) return;
  el.classList.remove('vient-de-changer');
  /* force un reflow : sans lui, retirer puis remettre la classe dans le même
     tour ne relance PAS l'animation — le navigateur ne voit aucun changement */
  void el.offsetWidth;
  el.classList.add('vient-de-changer');
  setTimeout(() => el.classList.remove('vient-de-changer'), 700);
}
document.addEventListener('change', e => {
  const el = e.target;
  if(el && el.closest && el.closest('#catTrip .field')) marqueChangement(el);
}, true);
document.addEventListener('click', e => {
  const c = e.target.closest && e.target.closest('.chip');
  if(c) marqueChangement(c);
}, true);

/* ============================================================
   LE JOURNAL DANS LE QUESTIONNAIRE
   ------------------------------------------------------------
   Une trentaine d'articles de fond sont écrits, et personne ne les voit avant
   d'avoir terminé son voyage. Choisir une ambiance fait remonter celui qui
   correspond : le contenu sert enfin à donner envie, au moment exact où
   l'envie se forme.
   ⚠️ AUCUN APPEL RÉSEAU AJOUTÉ. On lit _blogIdx, l'index déjà chargé pour
   repérer les lieux qui ont un article. S'il n'est pas encore là, on ne
   propose rien — on ne bloque pas le questionnaire pour un ornement.
============================================================ */
const VIBE_SUJETS = {
  'plage & détente':      ['baie', 'salar', 'barrière', 'corail', 'plage'],
  'ville & culture':      ['istanbul', 'kyoto', 'rome', 'venise', 'buenos', 'copenhague', 'marrakech'],
  'nature & aventure':    ['fjord', 'canyon', 'fuji', 'aurores', 'chutes', 'cappadoce'],
  'fête & vie nocturne':  ['buenos', 'istanbul', 'marrakech'],
  'romantique':           ['venise', 'taj', 'pise', 'neuschwanstein'],
  'bien-être & repos':    ['fjord', 'baie', 'aurores', 'kyoto']
};
function vibeSuggestion(){
  const box = $('#vibeBlog');
  if(!box) return;
  const vibe = $('#fVibe') && $('#fVibe').value;
  const idx = (typeof _blogIdx !== 'undefined' && Array.isArray(_blogIdx)) ? _blogIdx : null;
  const cles = VIBE_SUJETS[vibe];
  if(!vibe || !cles || !idx || !idx.length){ box.hidden = true; box.innerHTML = ''; return; }
  /* On cherche un article dont le SUJET contient l'un des mots-clés. La forme
     réduite (sans accents ni casse) est la même que celle du reste du site. */
  const norm = s => (typeof normPlace === 'function') ? normPlace(s) : String(s || '').toLowerCase();
  const a = idx.find(x => x && cles.some(k => norm(x.sujet).includes(k)));
  if(!a){ box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<button type="button" class="vb-carte" data-vbslug="${esc(a.slug)}">
      <span class="vb-i">${ICO('document', 20)}</span>
      <span class="vb-t"><b>${esc(a.titre)}</b><em>Un article du Journal, pour te donner envie</em></span>
      <span class="vb-fl">${ICO('lien', 16)}</span>
    </button>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-vbslug]');
  if(!b) return;
  if(typeof openArticle === 'function') openArticle(b.dataset.vbslug);
});
{
  const v = $('#fVibe');
  if(v) v.addEventListener('change', vibeSuggestion);
  /* L'index arrive de façon asynchrone : on retente une fois qu'il est là,
     plutôt que de laisser la suggestion muette pour toujours. */
  if(typeof blogIndex === 'function'){
    setTimeout(() => { try{ blogIndex().then(vibeSuggestion).catch(() => {}); }catch(e){} }, 1200);
  }
}

/* ============================================================
   BUDGET INVERSÉ — « voilà ce que j'ai, trouve-moi quelque chose »
   ------------------------------------------------------------
   Le questionnaire demande une TRANCHE de budget (« moyen, 500-1200 € »).
   C'est le bon réglage quand on est souple, et le mauvais quand on ne l'est
   pas : quelqu'un qui a exactement 800 € et pas un euro de plus n'a pas de
   tranche, il a un plafond.
   Ce mode renverse la contrainte : le montant devient une LIMITE DURE, et
   c'est la durée, le transport et le logement qui s'ajustent pour rentrer
   dedans. Techniquement, il n'ajoute aucun appel : il change ce qu'on demande
   au modèle dans le champ libre — donc il profite des données réelles, de la
   relecture croisée et de tous les garde-fous existants.
============================================================ */
function budgetInverseTexte(){
  const on = $('#fBudgetStrict') && $('#fBudgetStrict').checked;
  const v = parseInt(($('#fBudgetMax') && $('#fBudgetMax').value) || '', 10);
  if(!on || !Number.isFinite(v) || v <= 0) return '';
  return ` BUDGET INVERSÉ — CONTRAINTE DURE : le voyageur dispose de ${v} € PAR PERSONNE, tout compris `
    + `(transport aller-retour + logement + nourriture + activités). Ce montant est un PLAFOND ABSOLU, `
    + `pas une fourchette : ne propose RIEN qui le dépasse, même de peu. `
    + `Ajuste en priorité, dans cet ordre : la DURÉE (raccourcis plutôt que de dégrader), le TRANSPORT `
    + `(un train de nuit ou un vol moins direct valent mieux qu'un dépassement), puis le LOGEMENT. `
    + `Pour chaque proposition, DÉTAILLE la répartition dans "budget_estime" (ex : « 780 € = 140 vol + 360 logement `
    + `+ 180 repas + 100 activités ») et dis dans "resume" ce que tu as sacrifié pour tenir le plafond. `
    + `S'il est intenable pour la destination demandée, propose une destination plus proche PLUTÔT que de mentir sur les prix.`;
}
/* Le champ n'apparaît que si la case est cochée : un champ qui ne sert à rien
   dans un questionnaire déjà long est un motif d'abandon — même règle que
   pour l'âge des enfants et les pays imposés. */
{
  const c = $('#fBudgetStrict'), b = $('#fBudgetMaxBox'), t = $('#fBudget');
  if(c && b) c.addEventListener('change', () => {
    b.hidden = !c.checked;
    /* La tranche perd son sens quand un plafond dur est posé : on la grise
       plutôt que de la laisser dire le contraire du champ d'à côté. */
    if(t){ t.disabled = c.checked; t.closest('.field') && t.closest('.field').classList.toggle('q-inactif', c.checked); }
    if(c.checked && $('#fBudgetMax')) $('#fBudgetMax').focus();
  });
}


/* ============================================================
   L'ATTENTE JOUABLE — les mini-jeux comme écran de chargement
   ------------------------------------------------------------
   Quatre jeux dorment dans l'arcade, derrière un bouton qu'on ne pousse que
   si l'on s'ennuie DÉJÀ. Or il existe un moment, exactement un, où le voyageur
   s'ennuie et regarde l'écran sans rien pouvoir faire : la génération, qui
   tient jusqu'à deux minutes sur un gros séjour.
   ⚠️ DEUX RÈGLES, et ce sont elles qui dessinent tout le reste :
   1. NE RIEN PROPOSER TOUT DE SUITE. Une réponse en six secondes avec un
      « joue en attendant » qui traverse l'écran, c'est du bruit. On ne montre
      rien avant 6 s — au-delà, l'attente est réelle, la proposition aussi.
   2. NE JAMAIS ARRACHER LA PARTIE. Si le voyage arrive pendant le jeu, on
      l'annonce dans un bandeau et on laisse finir. Couper une partie pour
      afficher un résultat qui, lui, attendra très bien, reprendrait d'une
      main ce qu'on venait de donner de l'autre.
============================================================ */
var _attOn = false, _attT = 0, _attPret = false;
const ATT_JEUX = ['ovGame', 'ovGeo', 'ovPong', 'ovPack'];

/* Le jeu en cours, s'il y en a un. On ne compte PAS #ovArcade : le sélecteur
   n'est pas une partie, on peut le refermer sans rien interrompre. */
function attJeuOuvert(){
  for(const id of ATT_JEUX){
    const el = document.getElementById(id);
    if(el && el.classList.contains('show')) return el;
  }
  return null;
}

function attPilule(){
  let p = document.getElementById('attPilule');
  if(p) return p;
  p = document.createElement('div');
  p.id = 'attPilule';
  p.className = 'att-pilule';
  /* Deux formulations, une par largeur : sur un téléphone de 375 px la phrase
     longue chasserait le bouton hors de l'écran, et la masquer complètement
     laisserait une pastille « Jouer » qui tombe du ciel sans raison. */
  p.innerHTML = `<span class="att-txt"><span class="att-long">Ça va prendre un moment. Un jeu&nbsp;?</span><span class="att-court">Un jeu en attendant&nbsp;?</span></span>
    <button type="button" class="att-go">${ICO('manette', 16)}<span>Jouer</span></button>
    <button type="button" class="att-non" aria-label="Non merci">${ICO('fermer', 15)}</button>`;
  document.body.appendChild(p);
  p.querySelector('.att-go').addEventListener('click', () => {
    p.classList.remove('on');
    if(typeof openArcade === 'function') openArcade();
  });
  p.querySelector('.att-non').addEventListener('click', () => {
    p.classList.remove('on');
    /* Un refus vaut pour la session : reproposer à chaque génération, ce
       serait n'avoir pas écouté. */
    try{ sessionStorage.setItem('acolite_pas_de_jeu', '1'); }catch(e){}
  });
  return p;
}

function attMontre(){
  if(!_attOn) return;
  try{ if(sessionStorage.getItem('acolite_pas_de_jeu') === '1') return; }catch(e){}
  if(attJeuOuvert()) return;                 /* il joue déjà : rien à proposer */
  attPilule().classList.add('on');
}

function attenteDebut(){
  if(_attOn) return;
  _attOn = true; _attPret = false;
  clearTimeout(_attT);
  _attT = setTimeout(attMontre, 6000);
}

function attenteFin(){
  if(!_attOn) return;
  _attOn = false;
  clearTimeout(_attT);
  const p = document.getElementById('attPilule');
  if(p) p.classList.remove('on');
  const jeu = attJeuOuvert();
  if(jeu) attBandeau(jeu);
}

/* Le résultat est arrivé pendant la partie. On l'annonce SANS fermer : le
   bandeau se pose dans la fenêtre du jeu, et c'est le voyageur qui décide.
   ⚠️ On clique le VRAI bouton de fermeture plutôt que de retirer la classe
   nous-mêmes : chaque jeu accroche sa boucle d'animation et son nettoyage à ce
   bouton. Court-circuiter, ce serait laisser une boucle tourner dans le vide. */
function attBandeau(jeu){
  if(_attPret) return;
  _attPret = true;
  let b = jeu.querySelector('.att-pret');
  if(!b){
    b = document.createElement('div');
    b.className = 'att-pret';
    b.innerHTML = `<span>${ICO('coche', 16)} C'est prêt — quand tu veux, pas avant.</span>
      <button type="button" class="att-voir">Voir</button>`;
    (jeu.querySelector('.modal') || jeu).appendChild(b);
    b.querySelector('.att-voir').addEventListener('click', () => {
      b.remove(); _attPret = false;
      const x = jeu.querySelector('.close-btn[data-close]');
      if(x) x.click(); else jeu.classList.remove('show');
    });
  }
  b.classList.add('on');
}

/* On enveloppe plutôt que de modifier l'intérieur de ces fonctions : elles
   font déjà quinze choses, et l'attente n'est pas leur affaire.
   ⚠️ Les trois attrapent leurs erreurs elles-mêmes (try/catch/finally) — poser
   un gestionnaire de rejet ici ne masque donc AUCUNE erreur qui remonterait
   autrement jusqu'à la console. */
['proposeTrips', 'loadPlan', 'loadDayDetail'].forEach(nom => {
  const orig = window[nom];
  if(typeof orig !== 'function') return;
  window[nom] = function(){
    const r = orig.apply(this, arguments);
    if(r && typeof r.then === 'function'){
      attenteDebut();
      r.then(attenteFin, attenteFin);
    }
    return r;
  };
});

/* ============================================================
   MODE KIOSQUE — l'écran qui compte les jours
   ------------------------------------------------------------
   Il existait déjà un compte à rebours dans le code : startCountdown, écrit,
   complet… et INJOIGNABLE. Son seul appelant etait loadTools, que personne
   n'appelle, et ses trois zones (#zoneCount, #zoneMeteo, #zoneTime) n'existent
   nulle part dans le HTML. Il n'a donc jamais pu s'afficher une seule fois.
   Plutôt que d'écrire un second compte à rebours à côté du premier, celui-ci
   reprend son calcul et lui donne enfin un écran — mais un écran fait pour être
   REGARDÉ DE LOIN : chiffre énorme, contraste maximal, aucune commande.
   ⚠️ On ne touche PAS à "orientation":"portrait" du manifeste : ce réglage vaut
   pour toute l'application, et l'imposer en paysage pour un seul écran
   casserait le questionnaire. C'est le CSS du kiosque qui s'adapte.
============================================================ */
var _kioT = 0, _kioLock = null, _kioPhrase = 0;

/* Les mêmes bornes que startCountdown, isolées pour être testables seules. */
function kioCompte(){
  const dep = state.prefs && state.prefs.depart;
  if(!dep) return null;
  const cible = new Date(dep + 'T00:00:00');
  if(isNaN(cible.getTime())) return null;
  const diff = cible - new Date();
  return {
    cible, diff,
    parti: diff <= 0,
    jours:  Math.max(0, Math.floor(diff / 864e5)),
    heures: Math.max(0, Math.floor(diff % 864e5 / 36e5)),
    min:    Math.max(0, Math.floor(diff % 36e5 / 6e4))
  };
}

/* Ce qui défile en bas. Pas des slogans : des choses vraies tirées du voyage,
   pour qu'un coup d'œil en passant apprenne quelque chose. */
function kioPhrases(){
  const t = state.trip || {}, p = state.prefs || {}, out = [];
  const c = kioCompte();
  if(c && !c.parti){
    out.push('Départ le ' + c.cible.toLocaleDateString(LOC(), { weekday:'long', day:'numeric', month:'long' }));
    if(c.jours > 0) out.push(`soit ${c.jours} jour${c.jours > 1 ? 's' : ''}, ${c.heures} h et ${c.min} min`);
  }
  if(t.pays) out.push(String(t.pays));
  if(p.days) out.push(String(p.days) + ' sur place');
  const plan = state.cache && state.cache.plan;
  const j1 = plan && Array.isArray(plan.programme) && plan.programme[0];
  if(j1 && j1.titre) out.push('Jour 1 · ' + String(j1.titre));
  if(t.budget_estime) out.push('Budget estimé · ' + String(t.budget_estime));
  return out.length ? out : ['Ton voyage t’attend'];
}

function kioRend(){
  const box = document.getElementById('kioCorps');
  if(!box) return;
  const t = state.trip || {};
  const c = kioCompte();
  const nom = t.nom ? String(t.nom) : 'ton prochain voyage';
  let haut;
  if(!c){
    haut = '<div class="kio-n kio-vide">—</div><div class="kio-u">aucune date de départ</div>';
  }else if(c.parti){
    haut = '<div class="kio-n kio-go">Bon voyage</div><div class="kio-u">c’est maintenant</div>';
  }else if(c.jours === 0){
    haut = `<div class="kio-n">${c.heures}<small>h</small>${String(c.min).padStart(2, '0')}</div>
            <div class="kio-u">avant le départ</div>`;
  }else{
    haut = `<div class="kio-n">${c.jours}</div>
            <div class="kio-u">jour${c.jours > 1 ? 's' : ''} avant ${esc(nom)}</div>`;
  }
  const ph = kioPhrases();
  box.innerHTML = haut
    + `<div class="kio-dest">${esc(nom)}${t.drapeau ? ' ' + esc(t.drapeau) : ''}</div>`
    + `<div class="kio-bas">${esc(ph[_kioPhrase % ph.length])}</div>`;
}

function kioTick(){ _kioPhrase++; kioRend(); }

async function kioLock(on){
  /* Un écran mural qui s'éteint au bout d'une minute ne sert à rien. L'API
     n'existe pas partout (ni hors HTTPS) : son absence n'est pas une erreur,
     on continue sans. */
  try{
    if(on){
      if('wakeLock' in navigator && !_kioLock) _kioLock = await navigator.wakeLock.request('screen');
    }else if(_kioLock){
      await _kioLock.release(); _kioLock = null;
    }
  }catch(e){ _kioLock = null; }
}

function kioVisible(){
  const ov = document.getElementById('ovKiosque');
  if(document.visibilityState === 'visible' && ov && ov.classList.contains('on')) kioLock(true);
}

function ouvreKiosque(){
  let ov = document.getElementById('ovKiosque');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'ovKiosque';
    ov.className = 'kiosque';
    ov.innerHTML = '<div class="kio-corps" id="kioCorps"></div>'
      + `<button type="button" class="kio-x" aria-label="Quitter le mode kiosque">${ICO('fermer', 20)}</button>`;
    document.body.appendChild(ov);
    ov.querySelector('.kio-x').addEventListener('click', fermeKiosque);
  }
  _kioPhrase = 0;
  kioRend();
  ov.classList.add('on');
  document.documentElement.classList.add('kio-actif');
  clearInterval(_kioT);
  _kioT = setInterval(kioTick, 5000);
  kioLock(true);
  /* Le navigateur relâche le verrou dès que l'onglet passe en arrière-plan et
     ne le rend PAS tout seul au retour : il faut le redemander. */
  document.addEventListener('visibilitychange', kioVisible);
}

function fermeKiosque(){
  const ov = document.getElementById('ovKiosque');
  if(ov) ov.classList.remove('on');
  document.documentElement.classList.remove('kio-actif');
  clearInterval(_kioT); _kioT = 0;
  kioLock(false);
  document.removeEventListener('visibilitychange', kioVisible);
}

document.addEventListener('keydown', e => {
  const ov = document.getElementById('ovKiosque');
  if(e.key === 'Escape' && ov && ov.classList.contains('on')) fermeKiosque();
});
document.addEventListener('click', e => {
  if(e.target.closest && e.target.closest('[data-kiosque]')) ouvreKiosque();
});

/* Entrée directe : c'est ce qui en fait un vrai mode kiosque. On installe
   l'application, on lance le raccourci « Compte à rebours », et l'écran mural
   s'affiche sans passer par l'accueil.
   ⚠️ On attend que l'état soit chargé, sinon le kiosque s'ouvre sur un voyage
   vide et affiche « — » alors que la date existe bel et bien. */
function kiosqueDemande(){
  try{ return new URL(location.href).searchParams.has('kiosque'); }
  catch(e){ return false; }
}
if(kiosqueDemande()) setTimeout(() => { try{ ouvreKiosque(); }catch(e){} }, 900);


/* ============================================================
   À TABLE — régime, allergies, aversions
   ------------------------------------------------------------
   Le questionnaire savait déjà dire « plutôt street-food » ou « gastro ». Il ne
   savait pas dire « je suis allergique à l'arachide ». La différence n'est pas
   de degré : une envie ratée déçoit, une allergie ratée envoie à l'hôpital.
   D'où deux champs et non un — un menu déroulant pour le régime, du texte libre
   pour ce qui n'entre dans aucune case.
   ⚠️ La contrainte est posée DEUX FOIS, et c'est voulu : une fois dans ctx(),
   donc dans tous les prompts (voyages, journées, activités) ; une fois en tête
   des RÈGLES du prompt restaurants, là où elle décide vraiment. Un modèle perd
   les consignes du milieu d'un long prompt — sur une allergie, on préfère se
   répéter que se fier à sa mémoire.
============================================================ */
function alimCtx(p){
  p = p || state.prefs || {};
  const bits = [];
  if(p.regime) bits.push('régime ' + p.regime);
  if(p.evite)  bits.push('NE PEUT PAS MANGER : ' + p.evite);
  if(!bits.length) return '';
  return `\n- À TABLE (contrainte, pas préférence) : ${bits.join(' · ')}. `
    + `Chaque restaurant, chaque repas et chaque marché que tu proposes doit offrir une option qui respecte ça — `
    + `pas « on trouvera bien », une option identifiée. Si un lieu incontournable ne le permet pas, dis-le franchement.`;
}
/* Le bloc dur, en tête des règles du prompt restaurants. */
function alimDur(){
  const p = state.prefs || {};
  if(!p.regime && !p.evite) return '';
  let s = 'CONTRAINTE ALIMENTAIRE ABSOLUE — elle prime sur le budget, sur le quartier et sur ta propre idée de la bonne adresse :\n';
  if(p.regime) s += `- Régime : ${p.regime}. Chaque adresse doit avoir un VRAI plat ${p.regime} à la carte — pas une salade d'accompagnement, pas « ils peuvent adapter ». Dis dans le « pourquoi » LEQUEL.\n`;
  if(p.evite)  s += `- À ÉVITER ABSOLUMENT : ${p.evite}. Écarte toute adresse dont la cuisine tourne autour de ça. Si le mot « allergie » apparaît, considère que la moindre trace est exclue : préfère une adresse où la cuisine est simple et les ingrédients lisibles.\n`;
  s += '- Si tu n\'es pas certain qu\'une adresse convienne, NE LA PROPOSE PAS. Une adresse en moins vaut mieux qu\'un repas gâché.\n';
  return s;
}

/* ============================================================
   COMME UN HABITANT
   ------------------------------------------------------------
   Le prompt restaurants écartait déjà les terrasses à touristes. Ce mode étend
   la même exigence à TOUT le voyage — quartier, activités, journées — au lieu
   de la laisser à la seule page « Manger ».
============================================================ */
function localCtx(p){
  p = p || state.prefs || {};
  if(!p.local) return '';
  return `\n- MODE « COMME UN HABITANT » : le voyageur ne veut PAS l'itinéraire des cars de tourisme. `
    + `Écarte les lieux dont l'intérêt principal est d'être connus, les files d'attente, les rues commerçantes à souvenirs `
    + `et les restaurants à menu traduit en six langues. Propose ce que ferait quelqu'un qui habite là : cafés de quartier, `
    + `marchés du matin, parcs et bains publics, salles de concert, boutiques spécialisées, quartiers résidentiels qui valent la marche. `
    + `Tu peux garder UN incontournable si le voyage n'aurait pas de sens sans lui — mais donne alors l'heure ou l'angle `
    + `qui permet de l'aborder sans la foule, et dis-le. Pour chaque proposition, une raison CONCRÈTE de local, pas un adjectif.`;
}

/* ============================================================
   VÉRIFICATION DES LIEUX — le garde-fou contre les lieux inventés
   ------------------------------------------------------------
   C'est la faiblesse structurelle d'un voyage écrit par un modèle : un nom de
   musée plausible, dans la bonne ville, avec la bonne ambiance… et qui n'existe
   pas. Le prompt dit déjà « uniquement des lieux réels » ; ça réduit, ça
   n'élimine pas. On ne peut pas le savoir en relisant le texte — il faut aller
   voir dehors.
   Chaque lieu du programme est donc cherché dans le géocodeur Open-Meteo (le
   même que la météo, gratuit, sans clé) et confronté à la position de la
   destination. Trois issues : trouvé à proximité, trouvé mais LOIN (le modèle a
   pris un homonyme dans un autre pays), introuvable.
   ⚠️ ON INTERROGE WIKIPÉDIA, PAS LE GÉOCODEUR. Ma première version passait par
   geoPlace() (Open-Meteo) : c'est un géocodeur de VILLES. Il ne connaît ni la
   Fontaine de Trevi, ni les Musées du Vatican — il aurait donc signalé comme
   « introuvable » à peu près chaque monument d'un programme correct. Un contrôle
   qui crie au loup finit ignoré, et celui-là aurait hurlé en continu.
   wikiCoords() est fait pour ça : il rend les coordonnées de lieux nommés, et
   accepte cinquante titres en UNE requête. Le prompt du plan demande d'ailleurs
   déjà d'écrire chaque lieu sous son titre d'article Wikipédia — la vérification
   et la consigne de nommage sont les deux moitiés du même dispositif.
   ⚠️ CE CONTRÔLE NE SUPPRIME RIEN ET NE CORRIGE RIEN, et il se tait sur ce
   qu'il ignore. Un lieu sans article Wikipédia n'est PAS suspect : une bonne
   adresse de quartier n'en a jamais eu. On ne signale donc qu'un seul cas, celui
   où l'on a une preuve — le lieu existe, mais ses coordonnées tombent à des
   centaines de kilomètres de la destination : le modèle a pris un homonyme.
   Absence de preuve n'est pas preuve d'absence.
============================================================ */
const LIEU_LOIN_KM = 150;      /* au-delà, ce n'est plus une excursion à la journée */
var _lieuxVus = {};

function distKm(a1, o1, a2, o2){
  const R = 6371, r = x => x * Math.PI / 180;
  const da = r(a2 - a1), dO = r(o2 - o1);
  const h = Math.sin(da/2)**2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(dO/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function verifieLieux(noms){
  const g = await geocode();
  if(!g) return null;                       /* sans point d'ancrage, on se tait */
  const ville = (state.trip && state.trip.nom) || '';
  /* Comme wikiCoords lui-même : on demande « Lieu » ET « Lieu (Ville) », parce
     qu'un nom ambigu tombe sinon sur la page d'homonymie — ou sur l'homonyme
     parisien, ce qui produirait justement un faux « très loin ». */
  const titres = [];
  for(const n of noms){ titres.push(n); if(ville && !String(n).includes('(')) titres.push(`${n} (${ville})`); }
  let carte = null;
  try{ carte = await wikiCoords(titres.slice(0, 50)); }catch(e){}
  if(!carte) return null;

  const res = [];
  for(const nom of noms){
    const c = carte.get(nom) || carte.get(`${nom} (${ville})`);
    if(!c){ res.push({ nom, etat: 'muet' }); continue; }   /* pas d'article : on ne dit rien */
    const d = distKm(+g.latitude, +g.longitude, c[0], c[1]);
    res.push({ nom, etat: d <= LIEU_LOIN_KM ? 'ok' : 'loin', km: Math.round(d) });
  }
  return res;
}

/* Le rendu : muet quand on n'a rien à dire, précis quand on a une preuve. */
function lieuxBilanHTML(res){
  if(!res || !res.length) return '';
  const loin  = res.filter(x => x.etat === 'loin');
  const situes = res.filter(x => x.etat === 'ok').length;
  if(!loin.length){
    /* Rien d'anormal. On ne le dit que si on a vraiment pu vérifier quelque
       chose — annoncer « 0 lieu vérifié » n'informe personne. */
    if(situes < 2) return '';
    return `<div class="lx-bilan lx-ok">${ICO('coche', 15)} <span>${situes} lieux du programme retrouvés à leur place sur la carte.</span></div>`;
  }
  const l = loin.slice(0, 6).map(x =>
    `<li><b>${esc(x.nom)}</b> — situé à ${x.km} km de ${esc((state.trip && state.trip.nom) || 'la destination')}</li>`).join('');
  return `<div class="lx-bilan lx-doute">
      <div class="lx-tete">${ICO('bouclier', 15)} <b>${loin.length} lieu${loin.length > 1 ? 'x' : ''} à vérifier</b></div>
      <ul>${l}</ul>
      <p class="hint">Ces noms existent, mais Wikipédia les situe très loin d'ici — souvent le signe d'un homonyme.
      Rien n'a été supprimé : vérifie avant de rayer, il peut s'agir d'une excursion volontaire.</p>
    </div>`;
}

/* Lancé APRÈS le rendu, jamais pendant : la vérification prend plusieurs
   secondes et le voyageur doit voir son voyage tout de suite.
   Le bilan est gardé en mémoire : changer d'onglet reconstruit le panneau, et
   on ne va pas re-interroger le géocodeur à chaque aller-retour. */
var _lxBilan = null, _lxEnCours = false;

function lxPose(){
  if(!_lxBilan || _planTab !== 'programme') return;
  const pan = document.querySelector('.plan-panel');
  if(!pan || pan.querySelector('.lx-bilan')) return;
  pan.insertAdjacentHTML('beforeend', _lxBilan);
}

async function verifiePlanAffiche(){
  if(_lxEnCours) return;
  if(_lxBilan){ lxPose(); return; }
  const plan = state.cache && state.cache.plan;
  if(!plan || !Array.isArray(plan.programme) || _planTab !== 'programme') return;
  const noms = [...new Set(plan.programme.flatMap(j => Array.isArray(j.lieux) ? j.lieux : []))].slice(0, 18);
  if(noms.length < 2) return;
  _lxEnCours = true;
  try{
    const res = await verifieLieux(noms);
    if(res) _lxBilan = lieuxBilanHTML(res);
  }catch(e){}
  _lxEnCours = false;
  lxPose();
}

/* On enveloppe le rendu des sections plutôt que d'y toucher : il est appelé à
   chaque changement d'onglet, ce qui est exactement quand il faut reposer le
   bilan. Le voyage change → on repart de zéro. */
{
  const orig = window.renderSections;
  if(typeof orig === 'function'){
    window.renderSections = function(d){
      const r = orig.apply(this, arguments);
      /* Le panneau vient d'être reconstruit : les zones que remplissent les
         fonctions de rendu n'existent qu'à partir de maintenant. */
      try{ if(_planTab === 'budget') renderSpends(); }catch(e){}
      try{ if(_planTab === 'maison' && state.cache && state.cache.bag) renderBag(state.cache.bag, state.cache.bagVia); }catch(e){}
      try{ if(_planTab === 'programme') initNote(); }catch(e){}
      try{ if(_planTab === 'programme') startWx(); }catch(e){}
      try{ if(_planTab === 'logement' && state.cache && state.cache.stay) renderStay(state.cache.stay); }catch(e){}
      try{ if(_planTab === 'manger' && state.cache && state.cache.spec) renderSpec(state.cache.spec, state.cache.specVia); }catch(e){}
      try{ if(_planTab === 'manger' && state.cache && state.cache.shop) renderShop(state.cache.shop, state.cache.shopVia); }catch(e){}
      try{ if(_planTab === 'papiers' && state.cache && state.cache.talk) renderTalk(state.cache.talk, state.cache.talkVia); }catch(e){}
      try{ if(_planTab === 'manger' && state.cache && state.cache.food) renderFood(state.cache.food); }catch(e){}
      setTimeout(() => { try{ verifiePlanAffiche(); }catch(e){} }, 60);
      return r;
    };
  }
  /* Changer de voyage invalide le bilan : les lieux de Rome n'ont rien à dire
     sur ceux de Lisbonne. Les deux portes d'entrée sont chooseTrip (nouveau
     voyage) et reopenTrip (voyage repris dans l'historique). */
  ['chooseTrip', 'reopenTrip'].forEach(n => {
    const o = window[n];
    if(typeof o !== 'function') return;
    window[n] = function(){ _lxBilan = null; _lieuxVus = {}; return o.apply(this, arguments); };
  });
}


/* ============================================================
   AVANT DE PARTIR — la maison qu'on laisse derrière
   ------------------------------------------------------------
   Tout le reste de l'application prépare l'ARRIVÉE. Cet onglet prépare le
   départ : couper l'eau, vider le frigo, confier le chat. Ce sont les oublis
   les plus chers du voyage — un dégât des eaux coûte plus qu'un vol raté — et
   ils ne demandent aucune intelligence artificielle, juste une liste qui se
   souvient d'elle-même.
   ⚠️ La liste s'ADAPTE mais ne s'invente pas : les lignes « animaux » n'appa-
   raissent que si le voyageur a dit en avoir, et les lignes « longue absence »
   qu'au-delà de cinq nuits. Une liste générique de quarante points ne se coche
   pas, elle se ferme.
============================================================ */
const MAISON_BASE = [
  { id:'fenetres', t:'Fermer fenêtres et volets',            d:'Y compris la salle de bain et la cave.' },
  { id:'eau',      t:'Couper l’arrivée d’eau',                d:'Le robinet général. C’est le dégât le plus cher d’une absence.' },
  { id:'gaz',      t:'Couper le gaz',                         d:'Si tu en as.' },
  { id:'frigo',    t:'Vider le frais du frigo',               d:'Ce qui périme avant le retour part maintenant.' },
  { id:'poubelle', t:'Sortir les poubelles',                  d:'Surtout l’organique.' },
  { id:'veille',   t:'Débrancher les appareils en veille',    d:'Box, TV, chargeurs, cafetière.' },
  { id:'chauffe',  t:'Chauffage ou clim en mode absence',     d:'Hors-gel l’hiver, éteint l’été.' },
  { id:'cles',     t:'Laisser un double des clés',            d:'À quelqu’un de joignable, pas sous le paillasson.' },
  { id:'charge',   t:'Charger ce qui doit l’être',            d:'Téléphone, batterie externe, écouteurs, liseuse.' },
  { id:'photos',   t:'Photographier ses papiers',             d:'Passeport, carte d’identité, carte Vitale, permis.' }
];
const MAISON_LONG = [
  { id:'courrier', t:'Faire suivre ou garder le courrier',    d:'Une boîte qui déborde annonce une maison vide.' },
  { id:'plantes',  t:'Arroser, ou confier les plantes',       d:'Un bain avant de partir tient environ une semaine.' },
  { id:'banque',   t:'Prévenir la banque du voyage',          d:'Évite le blocage de la carte au premier paiement à l’étranger.' },
  { id:'presence', t:'Simuler une présence',                  d:'Une lampe sur minuterie, les rideaux entrouverts.' }
];
const MAISON_ANIMAUX = [
  { id:'anGarde',  t:'Organiser la garde',                    d:'Pension, famille, voisin — et confirmer la veille.' },
  { id:'anStock',  t:'Prévoir croquettes et litière',         d:'Compte large : le retour peut glisser d’un jour.' },
  { id:'anVeto',   t:'Laisser les infos vétérinaire',         d:'Nom, numéro, traitements en cours, carnet de santé.' },
  { id:'anIdent',  t:'Vérifier puce et médaille',             d:'Coordonnées à jour sur le fichier d’identification.' }
];
const MAISON_ENFANTS = [
  { id:'enSante',  t:'Carnet de santé et ordonnances',        d:'Copie photo, et les boîtes dans le bagage à main.' },
  { id:'enAutor',  t:'Autorisation de sortie du territoire',  d:'Si un enfant voyage sans ses deux parents.' }
];

/* La liste réellement affichée, selon le voyage. */
function maisonListe(){
  const p = state.prefs || {};
  const pp = (typeof ppLire === 'function' ? ppLire() : {}) || {};
  const d = (typeof stayDates === 'function' && stayDates()) || null;
  const nuits = d ? Math.max(1, Math.round((new Date(d.out) - new Date(d.in)) / 864e5)) : null;
  let L = MAISON_BASE.slice();
  if(!nuits || nuits > 5) L = L.concat(MAISON_LONG);
  if(pp.animaux) L = L.concat(MAISON_ANIMAUX);
  if(+p.kids > 0) L = L.concat(MAISON_ENFANTS);
  return L;
}

function maisonCoche(){
  state.maison = (state.maison && typeof state.maison === 'object') ? state.maison : {};
  return state.maison;
}

/* ============================================================
   LA VALISE — rebranchée
   ------------------------------------------------------------
   loadBag() croise la météo réelle mesurée, le nombre exact de nuits, le
   programme prévu et la présence d'enfants. Du bon travail, et #zoneBag
   n'existait dans aucun fichier : la liste n'a jamais pu s'afficher.
   Elle prend place ici, dans « Avant de partir » : on fait son sac puis on
   ferme la maison, c'est le même moment du voyage.
============================================================ */
function valiseHTML(){
  const dejaLa = state.cache && state.cache.bag;
  return `
    <div class="vl-tete">
      <div>
        <h3 style="margin:0 0 4px">Ta valise</h3>
        <p class="hint" style="margin:0">Construite d'après la météo réelle de tes dates, la durée exacte et ton programme.</p>
      </div>
      <button type="button" class="btn sm ghost" id="btnBagGo">${dejaLa ? 'Refaire' : 'Construire ma liste'}</button>
    </div>
    <span id="bagBadge" class="via-badge" style="display:none">rapide</span>
    <div class="vl-jauge"><div class="vl-barre"><span id="bagProg"></span></div><b id="bagCnt"></b></div>
    <div id="zoneBag">${dejaLa ? '' : '<p class="hint" style="margin:0">Pas encore de liste. Le bouton ci-dessus la construit pour ce voyage précis.</p>'}</div>`;
}
document.addEventListener('click', e => {
  if(!e.target.closest || !e.target.closest('#btnBagGo')) return;
  if(state.cache) delete state.cache.bag;
  save();
  loadBag();
});

function panMaison(){
  const L = maisonListe(), c = maisonCoche();
  const faits = L.filter(x => c[x.id]).length;
  const pct = L.length ? Math.round(faits / L.length * 100) : 0;
  const pp = (typeof ppLire === 'function' ? ppLire() : {}) || {};
  return valiseHTML()
    + `<h3 style="margin:26px 0 6px;padding-top:20px;border-top:1px solid var(--stroke)">La maison que tu laisses</h3>`
    + `<p class="pan-intro" style="margin-top:0">Rien ici ne part sur internet&nbsp;: c'est une liste, elle reste sur ton appareil.</p>
    <div class="mz-jauge" role="img" aria-label="${faits} sur ${L.length} faits">
      <div class="mz-barre"><span style="width:${pct}%"></span></div>
      <b>${faits}/${L.length}</b>
    </div>
    ${!pp.animaux ? `<label class="mz-opt"><input type="checkbox" id="mzAnimaux"><span>J'ai un animal à la maison — ajoute ce qu'il faut prévoir</span></label>` : ''}
    <ul class="mz-liste">
      ${L.map(x => `<li class="mz-li${c[x.id] ? ' fait' : ''}">
        <label>
          <input type="checkbox" data-mz="${esc(x.id)}"${c[x.id] ? ' checked' : ''}>
          <span class="mz-txt"><b>${esc(x.t)}</b><em>${esc(x.d)}</em></span>
        </label>
      </li>`).join('')}
    </ul>
    ${faits === L.length && L.length ? `<div class="mz-fini">${ICO('coche', 16)} Tout est fait. Tu peux fermer la porte.</div>` : ''}`;
}

document.addEventListener('change', e => {
  const b = e.target.closest('[data-mz]');
  if(b){
    const c = maisonCoche();
    if(b.checked) c[b.dataset.mz] = 1; else delete c[b.dataset.mz];
    save();
    /* On ne re-rend que la jauge et la ligne : re-rendre tout le panneau
       ferait sauter le focus au premier élément à chaque case cochée. */
    const li = b.closest('.mz-li'); if(li) li.classList.toggle('fait', b.checked);
    const L = maisonListe(), faits = L.filter(x => c[x.id]).length;
    const j = document.querySelector('.mz-jauge');
    if(j){
      j.querySelector('.mz-barre span').style.width = (L.length ? Math.round(faits/L.length*100) : 0) + '%';
      j.querySelector('b').textContent = faits + '/' + L.length;
      j.setAttribute('aria-label', faits + ' sur ' + L.length + ' faits');
    }
    return;
  }
  if(e.target.id === 'mzAnimaux'){
    /* L'information vit dans le passeport, pas dans la liste : elle resservira
       au prochain voyage, et le chat n'aura pas disparu entre-temps. */
    if(typeof ppEcrire === 'function'){ const pp = ppLire() || {}; pp.animaux = e.target.checked ? 1 : 0; ppEcrire(pp); }
    if(typeof renderSections === 'function' && state.cache && state.cache.plan) renderSections(state.cache.plan);
  }
});

/* ============================================================
   GLISSER-DÉPOSER DES ÉTAPES
   ------------------------------------------------------------
   Les flèches ▲▼ marchaient, mais déplacer une activité de la 6ᵉ à la 2ᵉ place
   demandait quatre clics et autant de re-rendus.
   ⚠️ POINTER EVENTS ET NON HTML5 DRAG. L'API drag-and-drop native ne fonctionne
   pas au doigt sur mobile — or c'est là qu'on réorganise sa journée, dans le
   train, la veille. Les Pointer Events couvrent souris et tactile d'un seul
   code.
   ⚠️ APPUI LONG DE 260 ms AVANT DE PRENDRE LA MAIN. Sans ce délai, tout geste
   de défilement commencé sur une carte l'arracherait de la liste : la page
   deviendrait impossible à faire défiler au doigt.
============================================================ */
var _dg = null;

function tlDeplace(jour, de, vers){
  const et = tlEtapes(jour);
  if(!et || de === vers || !et[de] || vers < 0 || vers >= et.length) return;
  /* Même invariant que tlSwap : les HEURES appartiennent à la position, pas à
     l'activité. On sort les créneaux, on déplace le contenu, on les remet dans
     l'ordre — sinon la journée cesse d'être chronologique. */
  const heures = et.map(x => x.heure);
  const [x] = et.splice(de, 1);
  et.splice(vers, 0, x);
  et.forEach((e, i) => { e.heure = heures[i]; });
  save();
  tlRender(jour);
  try{ buildProjectMap(); }catch(e){}
}

function dgFin(annule){
  if(!_dg) return;
  clearTimeout(_dg.tempo);
  const g = _dg; _dg = null;
  document.body.classList.remove('dg-actif');
  if(g.el){ g.el.classList.remove('dg-pris'); g.el.style.transform = ''; }
  document.querySelectorAll('.dg-cible').forEach(n => n.classList.remove('dg-cible'));
  if(!annule && g.actif && g.vers != null && g.vers !== g.de) tlDeplace(g.jour, g.de, g.vers);
}

document.addEventListener('pointerdown', e => {
  if(e.button != null && e.button !== 0) return;
  const it = e.target.closest && e.target.closest('.tl-item');
  if(!it || it.classList.contains('tl-editing')) return;
  /* On ne vole pas le geste aux commandes : boutons, liens, champs. */
  if(e.target.closest('button, a, input, textarea, select, .tl-loc')) return;
  const box = it.closest('[data-daybox]');
  if(!box) return;
  const freres = [...box.querySelectorAll('.tl-item')];
  if(freres.length < 2) return;
  _dg = { el: it, box, jour: box.dataset.daybox, de: freres.indexOf(it), vers: null,
          y0: e.clientY, actif: false, tempo: 0 };
  _dg.tempo = setTimeout(() => {
    if(!_dg) return;
    _dg.actif = true;
    _dg.el.classList.add('dg-pris');
    document.body.classList.add('dg-actif');
    if(navigator.vibrate) { try{ navigator.vibrate(12); }catch(e){} }
  }, 260);
}, { passive: true });

document.addEventListener('pointermove', e => {
  if(!_dg) return;
  const dy = e.clientY - _dg.y0;
  if(!_dg.actif){
    /* Bougé avant la fin de l'appui long → c'est un défilement, on lâche. */
    if(Math.abs(dy) > 9) dgFin(true);
    return;
  }
  e.preventDefault();
  _dg.el.style.transform = `translateY(${dy}px)`;
  const freres = [..._dg.box.querySelectorAll('.tl-item')];
  let vers = _dg.de;
  for(let i = 0; i < freres.length; i++){
    if(freres[i] === _dg.el) continue;
    const r = freres[i].getBoundingClientRect();
    if(e.clientY > r.top && e.clientY < r.bottom){ vers = i; break; }
  }
  if(vers !== _dg.vers){
    _dg.vers = vers;
    freres.forEach(n => n.classList.remove('dg-cible'));
    if(vers !== _dg.de && freres[vers]) freres[vers].classList.add('dg-cible');
  }
}, { passive: false });

document.addEventListener('pointerup',     () => dgFin(false));
document.addEventListener('pointercancel', () => dgFin(true));

/* ============================================================
   LA TEINTE DE LA DESTINATION
   ------------------------------------------------------------
   Le site garde son jaune — c'est sa marque, on n'y touche pas. Ce qui change,
   c'est le FOND : une chaleur de sable pour une destination balnéaire, un gris
   bleuté pour la montagne en hiver. L'écart est volontairement minuscule
   (quelques pourcents de teinte) : au-delà, on ne décore plus, on repeint le
   site en fonction de l'humeur du modèle.
   ⚠️ AUCUNE COULEUR DE TEXTE N'EST TOUCHÉE. Tous les contrastes du site sont
   calculés contre --bg et --secondary ; si la teinte déplaçait aussi les
   encres, chaque destination redemanderait un audit d'accessibilité complet.
   On ne déplace que la teinte des deux fonds, à luminosité quasi constante.
============================================================ */
const AMBIANCES = {
  mer:      { h: 32,  s: 14, mots: ['plage','mer','île','ile','côte','cote','baie','littoral','lagune','riviera','archipel','atoll'] },
  montagne: { h: 210, s: 10, mots: ['montagne','alpes','ski','sommet','pic','massif','glacier','fjord','andes','himalaya','pyrénées','pyrenees'] },
  foret:    { h: 140, s:  9, mots: ['forêt','foret','jungle','parc national','amazon','réserve','reserve','safari','savane'] },
  desert:   { h: 26,  s: 16, mots: ['désert','desert','sahara','dune','oasis','canyon','atacama','wadi'] },
  nord:     { h: 220, s:  8, mots: ['islande','norvège','norvege','laponie','groenland','finlande','suède','suede','aurores','arctique'] },
  ville:    { h: 0,   s:  0, mots: [] }
};

function ambiancePour(){
  const t = state.trip || {};
  const p = state.prefs || {};
  const foin = [t.nom, t.pays, t.resume, p.vibe].filter(Boolean).join(' ').toLowerCase();
  if(!foin) return null;
  for(const [nom, a] of Object.entries(AMBIANCES)){
    if(a.mots.some(m => foin.includes(m))) return { nom, ...a };
  }
  return null;
}

function appliqueAmbiance(){
  const r = document.documentElement;
  const a = ambiancePour();
  if(!a || !a.s){ r.style.removeProperty('--teinte-h'); r.style.removeProperty('--teinte-s'); r.removeAttribute('data-ambiance'); return; }
  r.style.setProperty('--teinte-h', a.h);
  r.style.setProperty('--teinte-s', a.s + '%');
  r.setAttribute('data-ambiance', a.nom);
}


/* ============================================================
   « OÙ EST-CE ? » SUR SON PROPRE VOYAGE
   ------------------------------------------------------------
   Le jeu propose des monuments du monde entier. Or le voyageur a déjà un
   programme, avec des lieux qu'il va vraiment voir et dont il ne sait pas
   encore à quoi ils ressemblent. Jouer dessus, c'est réviser son voyage sans
   s'en rendre compte.
   Les deux briques existaient déjà : wikiCoords() pour la position, et
   fetchWikiThumb() pour la photo (avec son filtre anti-blasons). Il ne
   manquait que de les brancher l'une sur l'autre.
   ⚠️ ON NE REMPLACE PAS LA LISTE MONDIALE, ON LA COMPLÈTE. Un voyage donne
   rarement cinq lieux illustrés : s'il en manque, les monuments du monde
   comblent. Et sans voyage en cours, le jeu doit rester exactement ce qu'il
   était — un jeu, pas une fonctionnalité qui refuse de démarrer.
============================================================ */
var _geoVoyage = null;          /* null = pas encore cherché, [] = rien trouvé */

async function geoLieuxDuVoyage(){
  if(_geoVoyage) return _geoVoyage;
  const plan = state.cache && state.cache.plan;
  if(!plan || !Array.isArray(plan.programme)) return (_geoVoyage = []);
  const ville = (state.trip && state.trip.nom) || '';
  const noms = [...new Set(plan.programme.flatMap(j => Array.isArray(j.lieux) ? j.lieux : []))].slice(0, 12);
  if(noms.length < 2) return (_geoVoyage = []);
  let carte = null;
  try{
    const titres = [];
    for(const n of noms){ titres.push(n); if(ville && !String(n).includes('(')) titres.push(`${n} (${ville})`); }
    carte = await wikiCoords(titres.slice(0, 50));
  }catch(e){}
  if(!carte) return (_geoVoyage = []);

  const out = [];
  for(const nom of noms){
    const c = carte.get(nom) || carte.get(`${nom} (${ville})`);
    if(!c) continue;
    /* La photo est indispensable : c'est TOUT le jeu. Un lieu sans image est
       écarté plutôt que montré comme un carré vide. */
    const img = await fetchWikiThumb(nom);
    if(!img) continue;
    out.push({ fr: nom, en: nom, lat: c[0], lon: c[1], img, mien: true });
    if(out.length >= 5) break;
  }
  _geoVoyage = out;
  return out;
}

/* On enveloppe l'ouverture du jeu : la recherche est asynchrone et ne doit pas
   retarder l'affichage. Le jeu démarre sur les monuments du monde, et la
   partie SUIVANTE profite des lieux du voyage — plutôt que de faire patienter
   devant un écran vide pour un jeu qu'on lance justement pour ne pas attendre. */
{
  const orig = window.openGeo;
  if(typeof orig === 'function'){
    window.openGeo = function(){
      const r = orig.apply(this, arguments);
      geoLieuxDuVoyage().then(l => {
        if(!l.length) return;
        const badge = document.getElementById('geoHint');
        if(badge && !badge.dataset.mien){
          badge.dataset.mien = '1';
          badge.insertAdjacentHTML('afterend',
            `<p class="geo-mien">${ICO('epingle', 14)} ${l.length} lieu${l.length > 1 ? 'x' : ''} de ton voyage à ${esc((state.trip && state.trip.nom) || '')} entrent dans la partie suivante.</p>`);
        }
      }).catch(() => {});
      return r;
    };
  }
  /* Le tirage : les lieux du voyage d'abord, le monde pour compléter. */
  const origP = window.geoNouvellePartie;
  if(typeof origP === 'function'){
    window.geoNouvellePartie = function(){
      const mien = (_geoVoyage || []).slice();
      if(!mien.length) return origP.apply(this, arguments);
      const reste = geoMelange(GEO_LIEUX).filter(x => !mien.some(m => m.fr === x.fr));
      _geo = { manche: 0, score: 0,
               lieux: geoMelange(mien).concat(reste).slice(0, GEO_MANCHES), pose: null };
      const ov = document.getElementById('geoOver'); if(ov) ov.hidden = true;
      geoManche();
    };
  }
}

/* ============================================================
   PLAN B — la fenêtre native remplacée
   ------------------------------------------------------------
   planB() faisait exactement ce qu'il fallait, mais demandait la raison avec
   prompt() : une boîte grise du système, hors du site, impossible à styler, que
   Safari iOS affiche au sommet de l'écran et que certains navigateurs bloquent
   purement et simplement. C'est aussi la seule saisie de l'application où l'on
   ne pouvait rien suggérer — alors que les raisons de refaire une journée sont
   presque toujours les quatre mêmes.
============================================================ */
const PB_RAISONS = [
  { t:'Il pleut',        v:'il pleut, il me faut des activités d’intérieur' },
  { t:'On est fatigués', v:'on est fatigués, il faut un rythme beaucoup plus doux' },
  { t:'Trop cher',       v:'c’est trop cher, propose surtout des choses gratuites' },
  { t:'Déjà vu',         v:'on connaît déjà ces lieux, propose autre chose' },
  { t:'C’est fermé',     v:'le lieu principal est fermé ce jour-là' },
  { t:'Trop de marche',  v:'trop de marche, regroupe tout dans un même quartier' }
];
var _pbJour = null, _pbSuite = null;

function pbDemande(jour){
  return new Promise(resolve => {
    _pbJour = jour; _pbSuite = resolve;
    let ov = document.getElementById('ovPlanB');
    if(!ov){
      ov = document.createElement('div');
      ov.className = 'overlay'; ov.id = 'ovPlanB';
      ov.innerHTML = `<div class="modal">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px">
          <h2 style="margin:0" id="pbTitre">Refaire la journée</h2>
          <button class="close-btn" data-close="ovPlanB" aria-label="Fermer">✕</button>
        </div>
        <p class="hint" style="margin:0 0 12px">Dis pourquoi : Acolyte garde le reste du séjour et ne repropose pas les lieux des autres journées.</p>
        <div class="pb-chips" id="pbChips"></div>
        <div class="field"><label for="pbTexte">Ou explique-le toi-même</label>
          <textarea id="pbTexte" maxlength="160" rows="2" placeholder="ex : on a un train à 18h, il faut finir tôt"></textarea>
        </div>
        <div class="row" style="gap:8px;margin-top:12px">
          <button class="btn" id="pbGo">Refaire cette journée</button>
          <button class="btn ghost" data-close="ovPlanB">Annuler</button>
        </div>
      </div>`;
      document.body.appendChild(ov);
      document.getElementById('pbChips').innerHTML =
        PB_RAISONS.map(r => `<button type="button" class="chip" data-pb="${esc(r.v)}">${esc(r.t)}</button>`).join('');
      ov.addEventListener('click', e => {
        const c = e.target.closest('[data-pb]');
        if(c){
          document.getElementById('pbTexte').value = c.dataset.pb;
          ov.querySelectorAll('[data-pb]').forEach(x => x.classList.toggle('on', x === c));
          return;
        }
        if(e.target.closest('#pbGo')){
          const v = (document.getElementById('pbTexte').value || '').trim();
          if(!v){ toast('Dis en deux mots ce qui ne va pas'); return; }
          ov.classList.remove('show');
          const f = _pbSuite; _pbSuite = null;
          if(f) f(v.slice(0, 160));
          return;
        }
        /* Fermeture (croix, Annuler, clic sur le fond) → on rend null, et
           planB() s'arrête exactement comme avec prompt() annulé. */
        if(e.target.closest('[data-close]') || e.target === ov){
          ov.classList.remove('show');
          const f = _pbSuite; _pbSuite = null;
          if(f) f(null);
        }
      });
    }
    document.getElementById('pbTitre').textContent = 'Refaire le jour ' + jour;
    document.getElementById('pbTexte').value = '';
    ov.querySelectorAll('[data-pb]').forEach(x => x.classList.remove('on'));
    ov.classList.add('show');
    setTimeout(() => { try{ document.getElementById('pbTexte').focus(); }catch(e){} }, 60);
  });
}

/* La teinte se pose au rendu du voyage : c'est là que la destination est
   connue, et le seul endroit où elle change. */
{
  ['renderPlan', 'chooseTrip', 'reopenTrip'].forEach(n => {
    const o = window[n];
    if(typeof o !== 'function') return;
    window[n] = function(){
      const r = o.apply(this, arguments);
      try{ appliqueAmbiance(); }catch(e){}
      return r;
    };
  });
  try{ appliqueAmbiance(); }catch(e){}
}

/* ============================================================
   AUTOUR DE MOI — l'assistant une fois sur place
   ------------------------------------------------------------
   Tout le site prépare le voyage. Celui-ci sert PENDANT : on est dans une rue,
   il est 13 h, on cherche à manger, et ouvrir un questionnaire n'a aucun sens.
   Les trois briques existaient déjà et ne s'étaient jamais rencontrées :
   la géolocalisation (utilisée pour la carte), osmFood() (les tables réelles du
   quartier, avec leurs coordonnées et même les régimes servis), et
   asstApplique() (l'ajout validé d'une étape dans une journée).
   ⚠️ AUCUN APPEL D'IA ICI, ET C'EST VOLONTAIRE. Une liste de commerces autour
   d'un point est un fait, pas une opinion : la demander à un modèle, c'est
   payer un aller-retour pour obtenir moins fiable que la donnée brute. Le
   modèle sert à arbitrer et à raconter, pas à savoir où est la pharmacie.
   ⚠️ « OUVERT MAINTENANT » N'EST PAS PROMIS. OpenStreetMap porte bien un champ
   opening_hours, mais il est absent sur une grande partie des commerces et sa
   grammaire admet des formes qu'on ne peut pas interpréter sans se tromper.
   On affiche donc l'horaire quand il existe, tel quel, sans jamais conclure à
   la place du voyageur : annoncer « ouvert » à tort envoie marcher pour rien.
============================================================ */
const AUTOUR_CATS = [
  { id:'manger',   nom:'Manger',    ico:'valise',      q:'[amenity~"^(restaurant|cafe|fast_food|bar|bistro)$"][name]' },
  { id:'courses',  nom:'Courses',   ico:'valise',      q:'[shop~"^(supermarket|convenience|bakery|greengrocer)$"][name]' },
  { id:'sante',    nom:'Santé',     ico:'aide',        q:'[amenity~"^(pharmacy|hospital|clinic|doctors)$"][name]' },
  { id:'argent',   nom:'Argent',    ico:'billet',      q:'[amenity~"^(atm|bank|bureau_de_change)$"]' },
  { id:'voir',     nom:'À voir',    ico:'epingle',     q:'[tourism~"^(attraction|museum|artwork|viewpoint)$"][name]' },
  { id:'transport',nom:'Transport', ico:'metro',       q:'[public_transport=station][name]' }
];
var _auPos = null, _auCat = 'manger', _auRayon = 800, _auRows = [];

/* Même forme qu'osmFood, mais pour n'importe quelle catégorie. On garde son
   double serveur : l'instance publique renvoie 429 dès qu'on enchaîne. */
async function osmAutour(lat, lon, filtre, rayon){
  const q = `[out:json][timeout:20];nwr(around:${rayon},${lat},${lon})${filtre};out center 60;`;
  let d = null;
  for(const url of OVERPASS_URLS){
    try{
      const r = await fetchT(url, { method:'POST',
        headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
        body:'data=' + encodeURIComponent(q) }, netTimeout(12000));
      if(r.status === 429 || r.status >= 500) continue;
      if(!r.ok) return [];
      d = await r.json(); break;
    }catch(e){}
  }
  if(!d) return [];
  const ref = { latitude: lat, longitude: lon };
  return (d.elements || []).map(e => {
    const t = e.tags || {};
    const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon;
    if(la == null || lo == null) return null;
    return {
      nom: String(t.name || t.operator || t.brand || 'Sans nom').slice(0, 70),
      genre: String(t.amenity || t.shop || t.tourism || t.public_transport || '').replace(/_/g, ' '),
      cuisine: t.cuisine ? String(t.cuisine).split(/[;,]/)[0].replace(/_/g, ' ').slice(0, 24) : '',
      horaires: t.opening_hours ? String(t.opening_hours).slice(0, 60) : '',
      vege: t['diet:vegetarian'] === 'yes' || t['diet:vegan'] === 'yes',
      lat: +(+la).toFixed(5), lon: +(+lo).toFixed(5),
      km: +havKm(ref, { latitude: la, longitude: lo }).toFixed(2)
    };
  }).filter(Boolean).sort((a, b) => a.km - b.km).slice(0, 30);
}

function auPosition(){
  return new Promise((ok, non) => {
    if(!navigator.geolocation) return non(new Error('PAS_DE_GEO'));
    navigator.geolocation.getCurrentPosition(
      p => ok({ lat: p.coords.latitude, lon: p.coords.longitude }),
      e => non(e),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });
}

function auRendu(){
  const z = document.getElementById('auListe');
  if(!z) return;
  if(!_auRows.length){
    z.innerHTML = `<p class="hint">Rien de répertorié dans ce rayon. Élargis la distance, ou change de catégorie —
      OpenStreetMap est riche en ville, plus clairsemé ailleurs.</p>`;
    return;
  }
  const p = state.prefs || {};
  z.innerHTML = _auRows.map((r, i) => {
    const m = Math.round(r.km * 1000);
    const dist = m < 1000 ? m + ' m' : r.km.toFixed(1) + ' km';
    /* ~12 min par km à pied, arrondi à la minute : de quoi décider, pas de quoi
       promettre. On ne prétend pas connaître les feux rouges. */
    const min = Math.max(1, Math.round(r.km * 12));
    return `<div class="au-item">
      <div class="au-txt">
        <b>${esc(r.nom)}</b>
        <em>${esc([r.genre, r.cuisine].filter(Boolean).join(' · '))}${r.vege && (p.regime || '').match(/vég/i) ? ' · végé confirmé' : ''}</em>
        ${r.horaires ? `<span class="au-h">${ICO('calendrier', 12)} ${esc(r.horaires)}</span>` : ''}
      </div>
      <div class="au-cote">
        <span class="au-km">${dist}</span>
        <span class="au-min">${min} min à pied</span>
        <button type="button" class="btn sm ghost" data-auadd="${i}">Ajouter</button>
      </div>
    </div>`;
  }).join('');
}

async function auCherche(){
  const z = document.getElementById('auListe');
  const cat = AUTOUR_CATS.find(c => c.id === _auCat) || AUTOUR_CATS[0];
  if(z) z.innerHTML = loaderHTML('Je regarde autour de toi…');
  try{
    if(!_auPos) _auPos = await auPosition();
    _auRows = await osmAutour(_auPos.lat, _auPos.lon, cat.q, _auRayon);
    auRendu();
  }catch(e){
    if(z) z.innerHTML = errHTML(e && e.message === 'PAS_DE_GEO'
      ? 'Cet appareil ne sait pas se localiser.'
      : 'Localisation refusée ou indisponible. Autorise l’accès à ta position pour utiliser cet outil.');
  }
}

function ouvreAutour(){
  let ov = document.getElementById('ovAutour');
  if(!ov){
    ov = document.createElement('div');
    ov.className = 'overlay'; ov.id = 'ovAutour';
    ov.innerHTML = `<div class="modal">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px">
        <h2 style="margin:0">Autour de moi</h2>
        <button class="close-btn" data-close="ovAutour" aria-label="Fermer">✕</button>
      </div>
      <p class="hint" style="margin:0 0 12px">Données OpenStreetMap, relevées autour de ta position réelle. Aucune IA ici : ce sont des faits, pas des suggestions.</p>
      <div class="au-cats" id="auCats"></div>
      <div class="au-rayon">
        <label for="auRayon">Rayon</label>
        <input type="range" id="auRayon" min="300" max="3000" step="100" value="${_auRayon}">
        <b id="auRayonV">${_auRayon} m</b>
      </div>
      <div class="au-liste" id="auListe"></div>
    </div>`;
    document.body.appendChild(ov);
    document.getElementById('auCats').innerHTML = AUTOUR_CATS.map(c =>
      `<button type="button" class="chip${c.id === _auCat ? ' on' : ''}" data-aucat="${c.id}">${esc(c.nom)}</button>`).join('');
    const sl = document.getElementById('auRayon');
    sl.addEventListener('input', () => { document.getElementById('auRayonV').textContent = sl.value + ' m'; });
    /* On ne relance la requête qu'au RELÂCHEMENT : à chaque cran, ce serait
       vingt-sept appels à Overpass pour un seul geste. */
    sl.addEventListener('change', () => { _auRayon = +sl.value; auCherche(); });
    ov.addEventListener('click', e => {
      const c = e.target.closest('[data-aucat]');
      if(c){
        _auCat = c.dataset.aucat;
        ov.querySelectorAll('[data-aucat]').forEach(x => x.classList.toggle('on', x === c));
        auCherche(); return;
      }
      const a = e.target.closest('[data-auadd]');
      if(a){ auAjoute(+a.dataset.auadd); return; }
      if(e.target.closest('[data-close]') || e.target === ov) ov.classList.remove('show');
    });
  }
  ov.classList.add('show');
  auCherche();
}
document.addEventListener('click', e => {
  if(e.target.closest && e.target.closest('#btnAutour')) ouvreAutour();
});

/* L'ajout passe par asstApplique : c'est le SEUL chemin d'écriture validé du
   programme. Écrire dans state.cache.days à la main contournerait la
   validation, la remise en ordre des index et la sauvegarde. */
function auAjoute(i){
  const r = _auRows[i];
  if(!r) return;
  const jours = Object.keys((state.cache && state.cache.days) || {});
  if(!jours.length){ toast('Détaille d’abord une journée pour pouvoir y ajouter quelque chose'); return; }
  /* Le jour d'aujourd'hui si le séjour a commencé, le premier détaillé sinon. */
  let jour = jours[0];
  try{
    const d = stayDates();
    if(d){
      const n = Math.floor((new Date() - new Date(d.in + 'T00:00:00')) / 864e5) + 1;
      if(jours.includes(String(n))) jour = String(n);
    }
  }catch(e){}
  const h = new Date();
  const heure = String(Math.min(23, h.getHours())).padStart(2, '0') + ':' + String(h.getMinutes() < 30 ? '00' : '30').padStart(2, '0');
  const res = asstApplique([{
    action: 'ajouter', jour: Number(jour), apres: 999,
    heure, titre: r.nom,
    description: `Trouvé à ${Math.round(r.km * 1000)} m de toi${r.genre ? ' · ' + r.genre : ''}${r.horaires ? ' · ' + r.horaires : ''}`,
    lieu: r.nom,
    type: _auCat === 'manger' ? 'repas' : _auCat === 'voir' ? 'visite' : 'pause'
  }]);
  if(res && res.refusees && res.refusees.length){ toast('Ajout refusé : ' + (res.refusees[0].err || '')); return; }
  toast(`✔ « ${r.nom.slice(0, 28)} » ajouté au jour ${jour}`);
  document.getElementById('ovAutour')?.classList.remove('show');
}

/* ============================================================
   CURSEURS DE PONDÉRATION
   ------------------------------------------------------------
   Le questionnaire pose des questions fermées : une ambiance, un budget, un
   style. Ce que ces cases ne savent pas dire, c'est le DOSAGE — « plutôt
   nature, mais pas au point de dormir sous la tente ». Trois curseurs le
   disent en un geste.
   ⚠️ On n'envoie PAS le chiffre au modèle. « nature : 72/100 » ne veut rien
   dire pour lui et il en fera ce qu'il veut. On traduit chaque position en une
   phrase franche, et seules les positions VRAIMENT marquées parlent : un
   curseur laissé au milieu ne doit rien ajouter au prompt, sinon les trois
   consignes tièdes noieraient les vraies contraintes du voyageur.
============================================================ */
const PONDS = [
  { id:'pNature', g:'Ville', d:'Nature',
    bas:'Le voyageur veut de la VILLE : rues, musées, cafés, vie urbaine. Ne construis pas un séjour autour de randonnées ou de paysages.',
    haut:'Le voyageur veut de la NATURE : paysages, marche, grand air, eau. Réduis au strict minimum les visites urbaines et les musées.' },
  { id:'pRythme', g:'Lent', d:'Intense',
    bas:'RYTHME LENT imposé : deux choses par jour au maximum, de longues pauses, rien avant 10 h. Un séjour où l’on s’assoit.',
    haut:'RYTHME INTENSE assumé : journées pleines, départs tôt, on enchaîne. Le voyageur préfère être fatigué que d’avoir raté quelque chose.' },
  { id:'pConfort', g:'Économe', d:'Confort',
    bas:'PRIORITÉ AU PRIX : sur chaque arbitrage, choisis le moins cher qui reste correct. Auberges, transports lents, cuisine de rue.',
    haut:'PRIORITÉ AU CONFORT : sur chaque arbitrage, choisis ce qui fatigue le moins — trajets directs, logement central, pas de fausse économie qui coûte deux heures.' }
];

function pondTexte(){
  const out = [];
  for(const p of PONDS){
    const el = document.getElementById(p.id);
    if(!el) continue;
    const v = +el.value;
    /* Zone morte volontaire entre 35 et 65 : au milieu, on n'a pas d'avis, et
       une consigne sans avis est du bruit qui dilue les autres. */
    if(v <= 35) out.push(p.bas);
    else if(v >= 65) out.push(p.haut);
  }
  return out.length ? ' DOSAGE DEMANDÉ — ' + out.join(' ') : '';
}

/* ============================================================
   MÉMOIRE DES GOÛTS
   ------------------------------------------------------------
   La demande parlait d'« ajuster les poids neuronaux » : ce n'est pas
   possible ici, et ça ne le serait pas davantage sur un serveur — on
   n'entraîne pas un modèle avec trois suppressions. Mais l'INTENTION est
   juste et se tient parfaitement sans réseau de neurones : ce que le voyageur
   retire de ses journées en dit long, et il n'y a aucune raison de le lui
   reproposer indéfiniment.
   On compte donc les retraits par genre d'étape, et à partir de trois du même
   genre, on le dit au modèle. Rien n'est deviné : le seuil est franc, la
   mémoire est lisible, et elle s'oublie (on ne garde que les vingt derniers).
============================================================ */
const LS_GOUTS = 'acolite_gouts';
function goutsLire(){
  try{ const o = JSON.parse(localStorage.getItem(LS_GOUTS) || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch(e){ return {}; }
}
function goutsNote(titre, type){
  const g = goutsLire();
  g.retraits = Array.isArray(g.retraits) ? g.retraits : [];
  g.retraits.push({ t: String(titre || '').slice(0, 60), y: String(type || 'visite'), q: Date.now() });
  g.retraits = g.retraits.slice(-20);
  try{ localStorage.setItem(LS_GOUTS, JSON.stringify(g)); }catch(e){}
}
/* Les mots qui reviennent dans ce qu'on retire — plus parlant que le seul
   « type », qui vaut « visite » pour un musée comme pour une cathédrale. */
const GOUT_SUJETS = {
  'musée':      /mus[ée]e|galerie|pinacoth/i,
  'église':     /[ée]glise|cath[ée]drale|basilique|chapelle|monast/i,
  'monument':   /monument|m[ée]morial|statue|palais|ch[âa]teau/i,
  'shopping':   /shopping|boutique|march[ée] aux|centre commercial/i,
  'randonnée':  /rando|marche|sentier|ascension|trek/i,
  'plage':      /plage|baignade|piscine/i
};
function goutsCtx(){
  const g = goutsLire();
  const L = Array.isArray(g.retraits) ? g.retraits : [];
  if(L.length < 3) return '';
  const compte = {};
  for(const r of L){
    for(const [nom, re] of Object.entries(GOUT_SUJETS)) if(re.test(r.t)) compte[nom] = (compte[nom] || 0) + 1;
  }
  const boudes = Object.entries(compte).filter(([, n]) => n >= 3).map(([nom]) => nom);
  if(!boudes.length) return '';
  return `\n- APPRIS DES VOYAGES PRÉCÉDENTS : ce voyageur retire systématiquement de son programme ce qui relève de : ${boudes.join(', ')}. `
    + `N'en propose pas, ou une seule fois s'il est impossible de faire autrement dans cette ville — et dis alors pourquoi. `
    + `Ce n'est pas une interdiction absolue : c'est une préférence observée, à respecter sauf raison forte.`;
}

/* Le retour visuel des curseurs : sans lui, on ne sait pas si un réglage
   « compte » ou s'il est dans la zone morte. */
function pondLu(){
  const z = document.getElementById('pondLu');
  if(!z) return;
  const dits = [];
  for(const p of PONDS){
    const el = document.getElementById(p.id);
    if(!el) continue;
    const v = +el.value;
    if(v <= 35) dits.push(p.g);
    else if(v >= 65) dits.push(p.d);
  }
  if(!dits.length){ z.hidden = true; z.textContent = ''; return; }
  z.hidden = false;
  z.innerHTML = 'Acolyte retiendra : ' + dits.map(x => `<b>${esc(x)}</b>`).join(' · ');
}
document.addEventListener('input', e => {
  if(e.target && e.target.closest && e.target.closest('.pond')) pondLu();
});

/* ============================================================
   LE PROFIL — ce qui était collecté et jamais rendu
   ------------------------------------------------------------
   Deux champs du passeport étaient écrits puis perdus : `urgence` et `devise`.
   Tous deux n'étaient relus QUE pour re-remplir leur propre formulaire — donc
   demandés au voyageur, stockés, et invisibles partout ailleurs.
   Le contact d'urgence est le plus grave : on demande qui prévenir en cas de
   problème, et l'information reste introuvable au moment exact où elle sert.
   Un champ qu'on ne rend jamais vaut moins que pas de champ du tout : il fait
   croire que quelque chose est en place.
============================================================ */

/* La ligne de contact personnel, greffée sous les numéros du pays. Elle ne
   REMPLACE pas les numéros officiels — elle vient après, parce qu'en urgence
   on appelle les secours d'abord et ses proches ensuite.
   ⚠️ `tel:` n'accepte pas n'importe quoi. On ne fabrique un lien d'appel que si
   la fiche contient vraiment un numéro ; sinon on affiche le texte tel quel,
   sans lien mort. Et le href est construit à partir des chiffres seuls : une
   saisie libre comme « Maman 06 12 34 56 78 » donnerait un href cassé. */
function urgencePersoHTML(){
  const pp = (typeof ppLire === 'function' ? ppLire() : {}) || {};
  const brut = String(pp.urgence || '').trim();
  if(!brut) return '';
  const EN = typeof isEN === 'function' && isEN();
  const num = (brut.match(/\+?[\d][\d\s.()-]{6,}/) || [''])[0].replace(/[^\d+]/g, '');
  const corps = num
    ? `<a class="urg-n urg-perso" href="tel:${esc(num)}">
         <span class="urg-ico">${ICO('telephone', 18)}</span>
         <span><b>${esc(brut)}</b><i>${EN ? 'your emergency contact' : 'ton contact d’urgence'}</i></span></a>`
    : `<div class="urg-n urg-perso urg-sansnum">
         <span class="urg-ico">${ICO('telephone', 18)}</span>
         <span><b>${esc(brut)}</b><i>${EN ? 'your emergency contact' : 'ton contact d’urgence'}</i></span></div>`;
  return `<div class="urg urg-mien">${corps}</div>
    <p class="hint" style="margin:6px 0 0">${EN ? 'Saved on this device only. Edit it in your passport.' : 'Enregistré sur cet appareil seulement. Modifiable dans ton passeport.'}</p>`;
}

/* ============================================================
   NIVEAU — avec le palier suivant
   ------------------------------------------------------------
   ppNiveau() rendait « Baroudeur » sans jamais dire qu'il manquait trois
   voyages pour la suite. Un niveau sans palier visible est une étiquette
   morte : elle décrit, elle n'appelle à rien.
============================================================ */
const PP_PALIERS = [
  { n: 0,  nom:'Nouveau venu' }, { n: 1,  nom:'Explorateur' },
  { n: 2,  nom:'Baroudeur' },    { n: 5,  nom:'Grand voyageur' },
  { n: 10, nom:'Globe-trotteur' }
];
function ppProchain(n){
  const suiv = PP_PALIERS.find(p => p.n > n);
  if(!suiv) return null;
  const prec = [...PP_PALIERS].reverse().find(p => p.n <= n) || PP_PALIERS[0];
  const total = Math.max(1, suiv.n - prec.n);
  return { nom: suiv.nom, reste: suiv.n - n, pct: Math.round((n - prec.n) / total * 100) };
}

/* ============================================================
   LES CHIFFRES DU PASSEPORT
   ------------------------------------------------------------
   L'onglet « Mon passeport » était le plus vide des quatre, alors que c'est
   celui de l'identité et celui qui s'ouvre par défaut. getHistory() portait
   déjà de quoi le remplir sans un seul appel réseau.
============================================================ */
function ppChiffres(){
  const h = (typeof getHistory === 'function' ? getHistory() : []) || [];
  const pays = new Set();
  let jours = 0;
  for(const x of h){
    if(x && x.pays) String(x.pays).split(/[,;]/).forEach(p => { const v = p.trim(); if(v) pays.add(v); });
    /* La durée est saisie en toutes lettres : « 5 jours », « 1 semaine »,
       « week-end ». Compter le premier nombre venu donnait 1 pour une semaine
       et 0 pour un week-end — un total faux affiché comme un fait. */
    jours += dureeEnJours(x && x.prefs && x.prefs.days);
  }
  const c = state.cache || {};
  return {
    voyages: h.length,
    pays: pays.size,
    jours,
    detaillees: Object.keys(c.days || {}).length,
    depenses: Array.isArray(state.spends) ? state.spends.length : 0
  };
}

/* ============================================================
   BADGES — récompenser le voyage, pas seulement sa préparation
   ------------------------------------------------------------
   Les six badges d'origine comptaient des voyages PRÉPARÉS, des journées
   DÉTAILLÉES, des pays PRÉPARÉS. Aucun ne se débloquait parce qu'on y était
   allé. Les signaux existent pourtant maintenant : la liste « avant de partir »
   cochée, des dépenses saisies sur place, une étape ajoutée depuis « Autour de
   moi » — ces trois-là ne peuvent pas être obtenus depuis son canapé.
============================================================ */
function ppBadgesTerrain(){
  const c = state.cache || {};
  const maison = Object.keys(state.maison || {}).length;
  const spends = Array.isArray(state.spends) ? state.spends : [];
  /* Une étape dont la description porte la marque d'« Autour de moi » : elle
     n'a pu être ajoutée qu'en étant physiquement sur place. */
  let surPlace = 0;
  for(const j of Object.values(c.days || {})){
    for(const e of (j && j.etapes) || []) if(/de toi/.test(String(e && e.description || ''))) surPlace++;
  }
  const chk = Object.keys(state.checklist || {}).length;
  return [
    { i:'cle',        nom:'Porte fermée',   d:'Cocher toute la liste « Avant de partir »', ok: maison >= 10 },
    { i:'valise',     nom:'Sac bouclé',     d:'Cocher 10 lignes de la valise',             ok: chk >= 10 },
    { i:'billet',     nom:'Sur le terrain', d:'Noter une dépense pendant le voyage',       ok: spends.length >= 1 },
    { i:'boussole',   nom:'À l’instinct',   d:'Ajouter un lieu trouvé « Autour de moi »',  ok: surPlace >= 1 },
    { i:'discussion', nom:'Bien accompagné',d:'Échanger 10 messages avec l’assistant',     ok: (state.chatLog || []).length >= 10 }
  ];
}

/* ============================================================
   CE QU'ACOLYTE A APPRIS DE TOI
   ------------------------------------------------------------
   La mémoire des goûts observe ce que tu retires de tes journées et en tient
   compte dans les prompts suivants. Elle était invisible.
   ⚠️ Une application qui accumule des préférences en silence doit les MONTRER
   et permettre de les EFFACER. Ce n'est pas un ornement : c'est la condition
   pour que l'observation reste acceptable. On affiche donc ce qui est retenu,
   en toutes lettres, avec le bouton pour tout oublier.
============================================================ */
function ppMemoireHTML(){
  const g = (typeof goutsLire === 'function' ? goutsLire() : {}) || {};
  const L = Array.isArray(g.retraits) ? g.retraits : [];
  if(!L.length){
    return `<p class="hint" style="margin:0">Acolyte n'a encore rien retenu. Quand tu retires des activités de tes journées, il finit par comprendre ce qui ne t'intéresse pas — et cesse d'en proposer.</p>`;
  }
  const compte = {};
  for(const r of L){
    for(const [nom, re] of Object.entries(GOUT_SUJETS)) if(re.test(r.t)) compte[nom] = (compte[nom] || 0) + 1;
  }
  const retenus = Object.entries(compte).filter(([, n]) => n >= 3).map(([nom]) => nom);
  const recents = L.slice(-6).reverse();
  return `
    ${retenus.length
      ? `<div class="mem-actif">${ICO('etincelle', 15)}
           <span>Acolyte évite désormais : <b>${esc(retenus.join(', '))}</b></span></div>`
      : `<p class="hint" style="margin:0 0 10px">Rien n'est encore retenu : il faut trois retraits du même genre pour qu'Acolyte en tienne compte.</p>`}
    <p class="mem-lbl">Tes derniers retraits</p>
    <ul class="mem-liste">${recents.map(r =>
      `<li><b>${esc(r.t || '—')}</b><span>${r.q ? new Date(r.q).toLocaleDateString(LOC()) : ''}</span></li>`).join('')}</ul>
    <button type="button" class="btn sm ghost" id="pfOublie">Tout oublier</button>`;
}
document.addEventListener('click', e => {
  if(!e.target.closest || !e.target.closest('#pfOublie')) return;
  try{ localStorage.removeItem(LS_GOUTS); }catch(err){}
  toast('Acolyte a tout oublié');
  if(typeof renderProfile === 'function') renderProfile();
});

/* On complète renderProfile plutôt que de le réécrire : il câble une vingtaine
   d'identifiants, et le rouvrir entier pour ajouter trois encarts serait le
   meilleur moyen d'en débrancher un au passage. */
function profilPlus(){
  const h = (typeof getHistory === 'function' ? getHistory() : []) || [];
  const ch = ppChiffres();

  /* --- le palier suivant, sous le niveau --- */
  const niv = document.getElementById('pfNiveau');
  if(niv && niv.parentElement){
    let p = document.getElementById('pfProchain');
    const suiv = ppProchain(h.length);
    if(!p && suiv){
      p = document.createElement('span');
      p.id = 'pfProchain'; p.className = 'pp-prochain';
      niv.insertAdjacentElement('afterend', p);
    }
    if(p) {
      if(suiv){ p.hidden = false; p.textContent = `encore ${suiv.reste} voyage${suiv.reste > 1 ? 's' : ''} avant « ${suiv.nom} »`; }
      else { p.hidden = true; }
    }
  }

  /* --- les chiffres enrichis --- */
  const box = document.getElementById('pfStats');
  if(box){
    const pp = (typeof ppLire === 'function' ? ppLire() : {}) || {};
    const stats = [
      ['Voyages préparés',  String(ch.voyages)],
      ['Pays différents',   String(ch.pays)],
      ['Jours planifiés',   ch.jours ? String(ch.jours) : '—'],
      ['Journées détaillées', String(ch.detaillees)],
      ['Ville de départ',   pp.home || (state.prefs && state.prefs.from) || '—'],
      ['Monnaie',           pp.devise || 'EUR'],
      ['Hors-ligne',        (typeof pwaInstalle === 'function' && pwaInstalle()) ? '✔ installé' : 'navigateur']
    ];
    box.innerHTML = stats.map(([k, v]) =>
      `<div class="pp-stat"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  }

  /* --- contact d'urgence, dans le passeport aussi --- */
  const pp = (typeof ppLire === 'function' ? ppLire() : {}) || {};
  const zv = document.getElementById('pfVoyageActif');
  if(zv && zv.parentElement){
    let u = document.getElementById('pfUrgence');
    if(!u){
      u = document.createElement('div');
      u.id = 'pfUrgence'; u.className = 'card pf-urg';
      zv.insertAdjacentElement('afterend', u);
    }
    u.innerHTML = pp.urgence
      ? `<h3 style="margin:0 0 4px">${ICO('telephone', 17)} En cas de problème</h3>
         <p class="hint" style="margin:0 0 10px">Rappelé aussi dans l'onglet Papiers de ton voyage, sous les numéros d'urgence du pays.</p>
         <p class="pf-urg-v">${esc(pp.urgence)}</p>`
      : `<h3 style="margin:0 0 4px">${ICO('telephone', 17)} En cas de problème</h3>
         <p class="hint" style="margin:0 0 10px">Tu n'as pas indiqué qui prévenir. Cette information reste sur ton appareil et n'est envoyée nulle part.</p>
         <button type="button" class="btn sm ghost" data-ppedit="1">L'ajouter</button>`;
  }

  /* --- badges de terrain, à la suite des badges de préparation --- */
  const bz = document.getElementById('pfBadges');
  if(bz && typeof ppBadges === 'function'){
    const tous = [].concat(ppBadges(), ppBadgesTerrain());
    /* Même gabarit que renderProfile : la classe est `off` quand c'est
       VERROUILLÉ, et le libellé bascule sur « Débloqué ». Inventer un autre
       balisage ici aurait donné deux styles de badges côte à côte. */
    bz.innerHTML = tous.map(b => `
      <div class="pp-badge${b.ok ? '' : ' off'}">
        <span class="pb-i" aria-hidden="true">${ICO(b.i, 22)}</span>
        <span class="pb-t"><b>${esc(b.nom)}</b><em>${esc(b.ok ? 'Débloqué' : b.d)}</em></span>
      </div>`).join('');
  }

  /* --- ce qu'Acolyte a appris --- */
  const pan = document.getElementById('pfPanPasseport');
  if(pan){
    let m = document.getElementById('pfMemoire');
    if(!m){
      m = document.createElement('div');
      m.id = 'pfMemoire'; m.className = 'card';
      pan.appendChild(m);
    }
    m.innerHTML = `<h3 style="margin:0 0 4px">${ICO('ampoule', 17)} Ce qu'Acolyte a appris de toi</h3>
      <p class="hint" style="margin:0 0 12px">Observé sur cet appareil, jamais envoyé. Tu peux tout effacer d'un bouton.</p>
      ${ppMemoireHTML()}`;
  }
}
document.addEventListener('click', e => {
  if(e.target.closest && e.target.closest('[data-ppedit]') && typeof ppOuvreEdition === 'function') ppOuvreEdition();
});

{
  const orig = window.renderProfile;
  if(typeof orig === 'function'){
    window.renderProfile = function(){
      const r = orig.apply(this, arguments);
      try{ profilPlus(); }catch(e){}
      return r;
    };
  }
}

/* Traduit une durée écrite à la main en nombre de jours. Rend 0 quand on ne
   sait pas : mieux vaut un total un peu bas qu'un chiffre inventé. */
function dureeEnJours(d){
  const s = String(d || '').toLowerCase();
  if(!s) return 0;
  if(/week-?end|weekend/.test(s)) return 2;
  const n = parseInt((s.match(/\d+/) || [0])[0], 10) || 0;
  if(/semaine|week/.test(s)) return n > 0 && n < 60 ? n * 7 : 7;
  if(/mois|month/.test(s))   return n > 0 && n < 13 ? n * 30 : 30;
  return n > 0 && n < 400 ? n : 0;
}

/* ============================================================
   MANGER — rebranché
   ------------------------------------------------------------
   loadFood() était le morceau le mieux construit du lot débranché : il relève
   les tables RÉELLES du quartier dans OpenStreetMap (osmFood), les donne au
   modèle avec l'ordre de n'inventer aucun nom, et porte le bloc dur des
   contraintes alimentaires. Il visait #zoneFood, absent de tous les fichiers.
   Il tournait donc dans le vide — et la contrainte « allergie » que j'ai
   ajoutée dans son prompt ne s'exécutait jamais.
   ⚠️ Les deux sélecteurs sont reconstruits à chaque rendu du panneau : leur
   valeur est relue par loadFood() au moment du clic, pas mémorisée ici.
============================================================ */
function panManger(){
  const dejaLa = state.cache && state.cache.food;
  const p = state.prefs || {};
  const contrainte = [p.regime, p.evite].filter(Boolean).join(' · ');
  return `
    <p class="pan-intro">Les adresses sont choisies dans un relevé réel du quartier, pas inventées.
    ${contrainte ? '' : 'Tu peux préciser un régime ou une allergie à l’étape 1 — Acolyte en tiendra compte ici.'}</p>
    ${contrainte ? `<div class="mg-contrainte">${ICO('bouclier', 15)} <span>Acolyte tient compte de&nbsp;: <b>${esc(contrainte)}</b></span></div>` : ''}
    <div class="mg-form">
      <div class="field"><label for="foodBud">Budget</label>
        <select id="foodBud">
          <option value="">Peu importe</option>
          <option value="petit budget">Petit budget</option>
          <option value="moyen">Moyen</option>
          <option value="belle table">Belle table</option>
        </select>
      </div>
      <div class="field"><label for="foodType">Envie</label>
        <select id="foodType">
          <option value="">Cuisine locale</option>
          <option value="street food">Street food</option>
          <option value="végétarien">Végétarien</option>
          <option value="poisson & fruits de mer">Poisson &amp; fruits de mer</option>
          <option value="petit-déjeuner / brunch">Petit-déjeuner / brunch</option>
        </select>
      </div>
      <button type="button" class="btn sm" id="btnFoodGo">${dejaLa ? 'Chercher à nouveau' : 'Trouver où manger'}</button>
    </div>
    <div id="zoneFood">${dejaLa ? '' : '<p class="hint" style="margin:0">Choisis un budget et une envie, puis lance la recherche.</p>'}</div>`
    + specialitesHTML() + coursesHTML();
}
/* Écouteur délégué : le bouton n'existe qu'après le rendu du panneau, celui
   posé au chargement du script ne s'accrochait à rien. */
document.addEventListener('click', e => {
  if(!e.target.closest || !e.target.closest('#btnFoodGo')) return;
  if(state.cache) delete state.cache.food;
  save();
  loadFood();
});

/* ============================================================
   CARNET DE NOTES ET GUIDE DE PHRASES — rebranchés
   ------------------------------------------------------------
   initNote() sauvegardait déjà les notes avec un anti-rebond de 500 ms, et
   state.notes est conservé par safeState — mais #noteArea n'existait nulle
   part. Des notes soigneusement persistées que personne ne pouvait écrire.
   loadTalk() produit douze phrases avec leur prononciation ; sa place est
   auprès du visa et des numéros d'urgence, dans « Papiers ».
   ⚠️ initNote pose a.oninput À CHAQUE appel, et le panneau est reconstruit à
   chaque changement d'onglet : oninput (et non addEventListener) est ici une
   qualité — il REMPLACE le gestionnaire au lieu de les empiler.
============================================================ */
function carnetHTML(){
  return `
    <h3 style="margin:26px 0 6px;padding-top:20px;border-top:1px solid var(--stroke)">Ton carnet</h3>
    <p class="hint" style="margin:0 0 10px">Ce que tu veux garder : un nom de rue, un horaire, une envie. Enregistré sur l'appareil au fil de la frappe.</p>
    <textarea id="noteArea" rows="5" placeholder="Le café en face du marché ouvre à 7h…"></textarea>
    <p class="hint" id="noteSaved" style="margin:6px 0 0"></p>`;
}
function phrasesHTML(){
  const dejaLa = state.cache && state.cache.talk;
  return `
    <h3 style="margin:26px 0 6px;padding-top:20px;border-top:1px solid var(--stroke)">Dire l'essentiel sur place</h3>
    <div class="ph-tete">
      <p class="hint" style="margin:0">Douze phrases utiles, avec la prononciation écrite à la française.</p>
      <button type="button" class="btn sm ghost" id="btnTalkGo">${dejaLa ? 'Refaire' : 'Obtenir les phrases'}</button>
    </div>
    <span id="talkBadge" class="via-badge" style="display:none">rapide</span>
    <div id="zoneTalk"></div>`
    + traducteurHTML();
}
document.addEventListener('click', e => {
  if(!e.target.closest || !e.target.closest('#btnTalkGo')) return;
  if(state.cache) delete state.cache.talk;
  save();
  loadTalk();
});

/* ============================================================
   LA MÉTÉO — rebranchée
   ------------------------------------------------------------
   startWx() dessine une petite météo animée sur un canvas de 56 px. Elle est
   appelée depuis renderPlan() — donc à CHAQUE affichage de voyage, chez tout
   le monde — et sortait aussitôt sur `if(!cv) return;` parce que #wxCv
   n'existait dans aucun fichier. Du code vivant appelant du code mort : le cas
   le plus trompeur, puisque rien ne le signale.
   Les chiffres (mNums : mini, maxi, probabilité de pluie) étaient relevés pour
   de vrai par realData(), envoyés au modèle dans le prompt… et jamais montrés
   au voyageur. Ils le sont maintenant.
============================================================ */
function meteoHTML(){
  const m = state.cache && state.cache._real && state.cache._real.mNums;
  if(!m) return '';
  const pluie = Math.round(m.rain);
  const mot = pluie > 55 ? 'pluie probable' : pluie > 25 ? 'averses possibles' : 'temps sec attendu';
  return `<div class="wx-bloc">
      <canvas id="wxCv" width="56" height="56" aria-hidden="true"></canvas>
      <div class="wx-txt">
        <b>${Math.round(m.min)}° à ${Math.round(m.max)}°</b>
        <span>${esc(mot)} · ${pluie} % de pluie · relevé réel</span>
      </div>
    </div>`;
}

/* ============================================================
   OÙ LOGER — rebranché
   ------------------------------------------------------------
   panLogement affiche ce que l'IA a PROPOSÉ à l'étape 2 : un type, un
   quartier, un prix. loadStay() fait autre chose — il compare plusieurs
   quartiers pour le profil du voyageur et s'appuie sur les hébergements
   RÉELS relevés par Overpass. Ce n'est pas un doublon, c'est l'étage du
   dessous, et il visait #zoneStay qui n'existait nulle part.
============================================================ */
function ouLogerHTML(){
  const dejaLa = state.cache && state.cache.stay;
  return `
    <h3 style="margin:26px 0 6px;padding-top:20px;border-top:1px solid var(--stroke)">Comparer les quartiers</h3>
    <p class="hint" style="margin:0 0 12px">Au-delà de la proposition ci-dessus : où dormir vraiment, selon ce qui compte pour toi.</p>
    <div class="mg-form">
      <div class="field"><label for="stayType">Type</label>
        <select id="stayType">
          <option value="">Peu importe</option>
          <option value="hôtel">Hôtel</option>
          <option value="appartement">Appartement</option>
          <option value="auberge">Auberge</option>
          <option value="maison d'hôtes">Maison d'hôtes</option>
        </select>
      </div>
      <div class="field"><label for="stayPrio">Ce qui compte</label>
        <select id="stayPrio">
          <option value="">Équilibré</option>
          <option value="le prix avant tout">Le prix</option>
          <option value="être au calme">Le calme</option>
          <option value="être au centre">Être au centre</option>
          <option value="proche des transports">Les transports</option>
        </select>
      </div>
      <button type="button" class="btn sm" id="btnStayGo">${dejaLa ? 'Chercher à nouveau' : 'Comparer'}</button>
    </div>
    <div id="zoneStay">${dejaLa ? '' : '<p class="hint" style="margin:0">Choisis un type et une priorité, puis lance la comparaison.</p>'}</div>`;
}
document.addEventListener('click', e => {
  if(!e.target.closest || !e.target.closest('#btnStayGo')) return;
  if(state.cache) delete state.cache.stay;
  save();
  loadStay();
});

/* ============================================================
   SPÉCIALITÉS ET COURSES — rebranchées dans « Manger »
   ------------------------------------------------------------
   loadSpec() est une enquête gourmande (plats locaux, où les goûter, prix) et
   loadShop() repère les supermarchés et le coût du quotidien. Toutes deux
   visaient des zones absentes. Leur place est ici : on ne mange pas qu'au
   restaurant, et savoir ce qu'on doit goûter fait partie du voyage.
============================================================ */
function specialitesHTML(){
  const dejaLa = state.cache && state.cache.spec;
  return `
    <h3 style="margin:26px 0 6px;padding-top:20px;border-top:1px solid var(--stroke)">Ce qu'il faut goûter</h3>
    <div class="ph-tete">
      <p class="hint" style="margin:0">Les spécialités du coin, où les trouver et à quel prix.</p>
      <button type="button" class="btn sm ghost" id="btnSpecGo">${dejaLa ? 'Refaire' : 'Découvrir'}</button>
    </div>
    <span id="specBadge" class="via-badge" style="display:none">rapide</span>
    <div id="zoneSpec"></div>`;
}
function coursesHTML(){
  const dejaLa = state.cache && state.cache.shop;
  return `
    <h3 style="margin:26px 0 6px;padding-top:20px;border-top:1px solid var(--stroke)">Faire ses courses</h3>
    <div class="ph-tete">
      <p class="hint" style="margin:0">Où acheter de quoi manger sans passer par le restaurant, et ce que ça coûte.</p>
      <button type="button" class="btn sm ghost" id="btnShopGo">${dejaLa ? 'Refaire' : 'Repérer'}</button>
    </div>
    <span id="shopBadge" class="via-badge" style="display:none">rapide</span>
    <div id="zoneShop"></div>`;
}
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('#btnSpecGo, #btnShopGo');
  if(!t) return;
  if(t.id === 'btnSpecGo'){ if(state.cache) delete state.cache.spec; save(); loadSpec(); }
  else { if(state.cache) delete state.cache.shop; save(); loadShop(); }
});

/* ============================================================
   TOUT LE SÉJOUR D'UN COUP — rebranché
   ------------------------------------------------------------
   Détailler une journée demande un clic et un appel. Sur huit jours, c'est
   huit attentes. Ce générateur fait tout en une fois, et sa zone n'existait
   pas : il n'a jamais servi.
   ⚠️ Le rythme et les déplacements sont relus par le handler d'origine
   (#itiPace, #itiMove) au moment du clic : les deux sélecteurs doivent porter
   ces identifiants exacts, et ne pas être renommés.
============================================================ */
function sejourCompletHTML(){
  const n = (typeof daysFromPrefs === 'function') ? Math.min(daysFromPrefs(), 10) : 0;
  if(!n) return '';
  return `
    <h3 style="margin:26px 0 6px;padding-top:20px;border-top:1px solid var(--stroke)">Tout le séjour d'un coup</h3>
    <p class="hint" style="margin:0 0 12px">Les ${n} journées détaillées en une seule fois, au lieu d'une par une. Compte environ 30 secondes.</p>
    <div class="mg-form">
      <div class="field"><label for="itiPace">Rythme</label>
        <select id="itiPace">
          <option value="équilibré (2-3 activités par jour)">Équilibré</option>
          <option value="doux (peu d'activités, du temps libre)">Doux</option>
          <option value="intense (programme dense)">Intense</option>
        </select>
      </div>
      <div class="field"><label for="itiMove">Déplacements</label>
        <select id="itiMove">
          <option value="à pied et transports en commun">À pied &amp; transports</option>
          <option value="beaucoup à pied">Surtout à pied</option>
          <option value="en voiture">En voiture</option>
        </select>
      </div>
      <button type="button" class="btn sm" id="btnItiAll">Tout planifier</button>
    </div>
    <div id="zoneItiAll"></div>`;
}

/* ============================================================
   SIMULATEUR ET TRADUCTEUR — rebranchés
   ------------------------------------------------------------
   #ovSim est un calque COMPLET dans index.html — vrais prix, vrais horaires,
   bascule avion/train/voiture — et le bouton qui l'ouvrait n'existait plus.
   Un écran entier, écrit et stylé, sans porte d'entrée.
   Le traducteur (#btnTr) est vivant lui aussi : il traduit une phrase libre
   vers la langue locale avec la prononciation. Sa place est sous le guide de
   phrases, dans « Papiers » — l'un donne douze phrases toutes faites, l'autre
   répond à celle qui manque.
============================================================ */
function traducteurHTML(){
  return `
    <h3 style="margin:22px 0 6px">Traduire une phrase</h3>
    <p class="hint" style="margin:0 0 10px">Celle qui te manque, sur le moment.</p>
    <div class="tr-form">
      <input id="trInp" maxlength="120" placeholder="Où est la gare ?" autocomplete="off">
      <button type="button" class="btn sm" id="btnTr">Traduire</button>
    </div>
    <span id="trBadge" class="via-badge" style="display:none">rapide</span>
    <div id="zoneTr"></div>`;
}
/* ⚠️ Délégués : ces deux blocs sont reconstruits à chaque rendu du panneau.
   Les écouteurs d'origine, posés au chargement, ne trouvaient rien — c'est
   précisément pourquoi ces fonctionnalités semblaient absentes. */
document.addEventListener('click', e => {
  if(!e.target.closest) return;
  if(e.target.closest('#btnOpenSimPan')){
    if(!state.trip){ toast('Choisis d’abord un voyage 😉'); return; }
    const ov = document.getElementById('ovSim');
    if(ov){ ov.classList.add('show'); try{ loadTransport(); }catch(err){} }
  }
});
document.addEventListener('keydown', e => {
  if(e.key === 'Enter' && e.target && e.target.id === 'trInp'){
    e.preventDefault();
    document.getElementById('btnTr')?.click();
  }
});

/* ⚠️ CE GESTIONNAIRE MANQUAIT. En retirant l'écouteur d'origine de #btnTr —
   posé au chargement, donc inerte — j'ai annoncé l'avoir remplacé par un
   délégué. J'avais délégué la touche Entrée et le bouton du simulateur, pas
   le bouton « Traduire » lui-même : le champ s'affichait et ne répondait pas.
   Trouvé par le test fonctionnel, pas par la relecture. */
document.addEventListener('click', async e => {
  if(!e.target.closest || !e.target.closest('#btnTr')) return;
  const champ = document.getElementById('trInp');
  const zone  = document.getElementById('zoneTr');
  const q = (champ && champ.value.trim()) || '';
  if(!q || !zone) return;
  const t = state.trip;
  if(!t){ toast('Choisis d’abord un voyage 😉'); return; }
  zone.innerHTML = loaderHTML('Traduction…');
  const prompt = `Traduis cette phrase française vers ${t.langue || 'la langue locale de ' + t.pays}.
Phrase : "${q}"
Réponds UNIQUEMENT en JSON : {"local":"la traduction","pron":"prononciation phonétique à la française"}`;
  try{
    const { data, via } = await ai('light', prompt);
    const badge = document.getElementById('trBadge');
    if(badge) badge.style.display = via === 'groq' ? '' : 'none';
    zone.innerHTML = `<div class="phrase"><div class="fr">${esc(q)}</div>`
      + `<div class="loc">${esc(data && data.local || '')}</div>`
      + `<div class="pron">🔊 ${esc(data && data.pron || '')}</div></div>`;
  }catch(err){
    if(err.message !== 'NO_KEY') zone.innerHTML = errHTML('Traduction impossible.');
  }
});
