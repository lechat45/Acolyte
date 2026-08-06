/* ============================================================
   ACOLYTE — Backend (Val Town, 100 % gratuit)
   ============================================================
   RÔLE : garder tes clés API SECRÈTES (même rôle que worker.js).

   ⚠️⚠️ NE COLLE PAS CE FICHIER-CI DANS VAL TOWN. ⚠️⚠️
   Val Town refuse au-delà de 80 000 caractères par val, et les commentaires
   qui expliquent chaque piège rencontré nous font largement dépasser :
       « Too big: expected string to have <=80000 characters »

   Lance d'abord :        node outils/valtown-build.js
   puis colle le fichier :  valtown-backend.deploy.js

   C'est le même code sans les commentaires — 61 000 caractères, donc de la
   marge. CE fichier reste la référence : c'est ici qu'on corrige, jamais dans
   la version générée, qui est écrasée à chaque passage du script.

   ── DÉPLOIEMENT (3 min, sans carte bancaire) ────────────────
   1. https://val.town → Sign up (avec ton compte GitHub)
   2. Bouton "+ New" → "Val" → choisis le type "HTTP"
   3. Efface le code d'exemple → colle CE fichier
      (c'est déployé automatiquement à chaque sauvegarde)
   4. Icône engrenage / menu à gauche → "Environment variables" :
        GEMINI_KEY        = ta clé AIza… (aistudio.google.com/apikey)
        GROQ_KEY          = ta clé gsk_…
        TRAVELPAYOUTS_KEY = ton token
        ALLOWED_ORIGIN    = https://lechat45.github.io
      Pour le panel admin (sans ça, /admin/stats répond 403 à TOUT LE MONDE) :
        ADMIN_EMAIL       = l'adresse EXACTE de ton compte Acolyte
      Pour les comptes (SANS ÇA, aucune inscription possible) :
        EMAILJS_PUBLIC    = Public Key   (dashboard.emailjs.com/admin/account)
        EMAILJS_PRIVATE   = Private Key  (même page — à ne JAMAIS mettre côté navigateur)
        EMAILJS_SERVICE   = Service ID   (ex service_xxxxxxx)
        EMAILJS_TEMPLATE  = Template ID  (ex template_xxxxxxx)
      ⚠️ Dans EmailJS → Account → Security, ACTIVE
         « Allow EmailJS API for non-browser applications »,
         sinon l'appel depuis Val Town est refusé.
      Le template doit utiliser {{to_email}} et {{code}}.
   5. Copie l'URL du val (en haut à droite, format
      https://tonpseudo--acolyte.web.val.run) dans config.js → proxy
   6. VIDE les clés de config.js : elles ne servent plus !
============================================================ */

const RELAY_HOSTS = ['engine.hotellook.com', 'yasen.hotellook.com', 'api.travelpayouts.com'];

/* Plafond d'appels IA par compte et par heure.
   Pourquoi : l'adresse du proxy est publique (elle est dans config.js), donc
   sans compteur un seul compte suffirait à vider le quota des clés API — et
   quand le quota est vide, le service est mort pour tout le monde. */
const AI_MAX_H = 120;

/* ============================================================
   COMPTES & SYNCHRONISATION
   ------------------------------------------------------------
   Email + mot de passe. Le mot de passe n'est JAMAIS stocké en clair :
   seul un PBKDF2 (210 000 itérations, sel unique) l'est. L'adresse doit
   être confirmée par un code avant que la connexion soit possible.

   L'email part depuis CE serveur, jamais depuis le navigateur : sinon le
   navigateur connaîtrait le code et pourrait valider l'adresse d'un tiers.

   Variables d'environnement : voir l'en-tête du fichier (EMAILJS_*).
============================================================ */
import { sqlite } from 'https://esm.town/v/std/sqlite';

const CODE_TTL   = 10 * 60 * 1000;        /* le code vit 10 minutes */
const CODE_WAIT  = 60 * 1000;             /* 1 envoi par minute et par email */
const CODE_TRIES = 5;                     /* au-delà, le code est brûlé */
/* 30 jours et non 90 : le jeton vit dans le navigateur, donc plus il vit
   longtemps, plus longtemps un appareil perdu ou prêté reste connecté.
   Ce réglage ne s'applique qu'aux NOUVELLES sessions — personne n'est
   déconnecté au déploiement. */
const SESS_TTL   = 30 * 24 * 3600 * 1000;
const SESS_MAX   = 5;                     /* appareils connectés simultanément */
const MAX_PAYLOAD = 400_000;              /* garde-fou : ~400 Ko par compte */
const PASS_MIN   = 8;                     /* longueur mini (recommandation NIST) */
const PBKDF2_IT  = 210_000;               /* itérations : minimum OWASP pour SHA-256 */
const LOGIN_FAILS = 8;                    /* essais ratés avant blocage temporaire */
const LOGIN_LOCK  = 15 * 60 * 1000;       /* durée du blocage */

let _dbReady = null;
function db() {
  /* une seule création de schéma par instance, pas à chaque requête */
  if (!_dbReady) _dbReady = (async () => {
    /* verified : tant que l'adresse n'est pas confirmée, la connexion est
       refusée — sinon on pourrait créer un compte avec l'email d'un autre */
    await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_users(
      email TEXT PRIMARY KEY, pass_h TEXT NOT NULL, salt TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_logins(
      email TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0)`);
    await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_codes(
      email TEXT PRIMARY KEY, code_h TEXT NOT NULL, expires_at INTEGER NOT NULL,
      tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL)`);
    await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_sessions(
      token_h TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
    await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_trips(
      email TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    /* Articles du blog. Ils n'appartiennent à personne : pas de colonne email,
       donc rien à effacer quand un compte est supprimé. */
    await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_posts(
      slug TEXT PRIMARY KEY, sujet TEXT NOT NULL, categorie TEXT NOT NULL,
      titre TEXT NOT NULL, sous_titre TEXT, resume TEXT, lecture TEXT,
      corps TEXT NOT NULL, image TEXT, credit TEXT,
      statut TEXT NOT NULL DEFAULT 'brouillon', created_at INTEGER NOT NULL)`);
  })();
  return _dbReady;
}

async function sha256(txt) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
}
/* ---- Mot de passe ----
   PBKDF2 via Web Crypto : intégré à Deno, aucune dépendance npm qui
   pourrait disparaître ou casser au déploiement. Volontairement LENT
   (210 000 itérations) — c'est ce qui rend une base volée inexploitable.
   Un SHA-256 simple serait cassé en quelques minutes sur GPU. */
async function hashPass(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_IT, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, '0')).join('');
}
/* comparaison à durée constante : un === sort au premier caractère
   différent, ce qui laisse mesurer le hachage caractère par caractère */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function cleanPass(v) {
  const p = String(v || '');
  return p.length >= PASS_MIN && p.length <= 200 ? p : null;
}

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 190 ? e : null;
}

/* Lit le porteur de session. Renvoie l'email ou null — jamais d'exception,
   les routes décident elles-mêmes du 401. */
async function sessionEmail(request) {
  const h = request.headers.get('Authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (tok.length < 32) return null;
  await db();
  const r = await sqlite.execute({
    sql: 'SELECT email, expires_at FROM aco_sessions WHERE token_h = ?',
    args: [await sha256(tok)],
  });
  const row = r.rows[0];
  if (!row) return null;
  if (Number(row[1]) < Date.now()) {                 /* session expirée : on nettoie */
    await sqlite.execute({ sql: 'DELETE FROM aco_sessions WHERE token_h = ?', args: [await sha256(tok)] });
    return null;
  }
  return String(row[0]);
}

/* L'envoi passe par EmailJS, mais DEPUIS LE SERVEUR — jamais depuis le
   navigateur. Si le navigateur envoyait le mail, il devrait connaître le
   code, et n'importe qui pourrait alors valider l'adresse d'un autre.
   L'appel serveur exige la clé privée (accessToken) et l'option
   « Allow EmailJS API for non-browser applications » activée.

   Si ça échoue, on renvoie false et la route répond en erreur : le code
   n'est jamais montré à l'écran. */
function mailReady(env) {
  return !!(env('EMAILJS_PUBLIC') && env('EMAILJS_PRIVATE')
         && env('EMAILJS_SERVICE') && env('EMAILJS_TEMPLATE'));
}
/* Trace du dernier envoi, pour /maildiag.
   ÉCRITE EN BASE et non en mémoire : Val Town est sans état, chaque requête
   repart d'un environnement neuf — une variable de module serait toujours
   vide au moment où on la lit depuis une AUTRE requête. */
async function diagTable() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS aco_diag(k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL)`);
}
/* ---- Garde d'accès aux proxys IA ----
   Deux conditions : une session valable, et un quota horaire pas dépassé.
   Renvoie { email } si ça passe, sinon { err, status }. */
async function aiGuard(request) {
  const email = await sessionEmail(request);
  if (!email) return { err: 'Connecte-toi pour utiliser Acolyte', status: 401 };
  try {
    await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_ai(
      email TEXT PRIMARY KEY, n INTEGER NOT NULL, window_start INTEGER NOT NULL)`);
    const now = Date.now(), H = 3600 * 1000;
    const r = await sqlite.execute({ sql: 'SELECT n, window_start FROM aco_ai WHERE email = ?', args: [email] });
    const row = r.rows[0];
    const debut = row ? Number(row[1]) : 0;
    /* fenêtre glissante d'une heure : passé ce délai, le compteur repart de zéro */
    const n = (row && now - debut < H) ? Number(row[0]) : 0;
    const fenetre = (row && now - debut < H) ? debut : now;
    if (n >= AI_MAX_H) return { err: 'Beaucoup de demandes d’un coup — réessaie dans un moment', status: 429 };
    await sqlite.execute({
      sql: `INSERT INTO aco_ai(email, n, window_start) VALUES(?,?,?)
            ON CONFLICT(email) DO UPDATE SET n = excluded.n, window_start = excluded.window_start`,
      args: [email, n + 1, fenetre],
    });
  } catch (e) { /* un compteur en panne ne doit pas bloquer un utilisateur légitime */ }
  return { email };
}

/* Purge des lignes périmées. Garder des sessions et des codes expirés, c'est
   garder des données personnelles dont on n'a plus l'usage. */
async function purge() {
  try {
    const now = Date.now();
    await sqlite.execute({ sql: 'DELETE FROM aco_sessions WHERE expires_at < ?', args: [now] });
    await sqlite.execute({ sql: 'DELETE FROM aco_codes WHERE expires_at < ?', args: [now - 3600 * 1000] });
    await sqlite.execute({ sql: 'DELETE FROM aco_logins WHERE locked_until < ? AND fails > 0', args: [now - 24 * 3600 * 1000] });
  } catch (e) {}
}

async function noteMail(msg) {
  try {
    await diagTable();
    await sqlite.execute({
      sql: `INSERT INTO aco_diag(k, v, ts) VALUES('mail', ?, ?)
            ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts`,
      args: [String(msg).slice(0, 300), Date.now()],
    });
  } catch (e) { /* le diagnostic ne doit jamais faire échouer un envoi */ }
}
async function readMail() {
  try {
    await diagTable();
    const r = await sqlite.execute({ sql: `SELECT v, ts FROM aco_diag WHERE k = 'mail'`, args: [] });
    if (!r.rows || !r.rows[0]) return 'aucun envoi enregistré';
    const row = r.rows[0];
    /* selon la version, les lignes sont des tableaux OU des objets */
    const v = row.v ?? row[0], ts = Number(row.ts ?? row[1]);
    return `${v}  (il y a ${Math.round((Date.now() - ts) / 1000)} s)`;
  } catch (e) {
    /* on montre la panne au lieu de l'avaler : c'est tout l'intérêt d'un diagnostic */
    return 'ERREUR DE LECTURE → ' + String(e && e.message || e).slice(0, 200);
  }
}

async function sendCodeMail(env, email, code) {
  if (!mailReady(env)) { await noteMail('variables EMAILJS_* incomplètes'); return false; }
  try {
    const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: env('EMAILJS_SERVICE'),
        template_id: env('EMAILJS_TEMPLATE'),
        user_id: env('EMAILJS_PUBLIC'),
        accessToken: env('EMAILJS_PRIVATE'),
        template_params: { to_email: email, email, code },
      }),
    });
    const txt = await r.text().catch(() => '');
    const why = `HTTP ${r.status} · ${txt.slice(0, 200) || '(corps vide)'}`;
    console.log('[acolyte] EmailJS →', why);        /* visible dans les logs Val Town */
    await noteMail(why);
    return r.ok;
  } catch (e) {
    const why = 'appel impossible : ' + String(e).slice(0, 120);
    console.log('[acolyte] EmailJS →', why);
    await noteMail(why);
    return false;
  }
}

export default async function (request) {
  const env = (k) => Deno.env.get(k) || '';
  const origin = request.headers.get('Origin') || '';
  /* ⚠️ PLUSIEURS ORIGINES, séparées par des virgules.
     Il n'y en avait qu'une, et ça bloquait deux choses d'un coup : le jeu
     « Où est-ce ? » vit sur une AUTRE adresse GitHub Pages, il ne pouvait donc
     ni envoyer un score au classement, ni demander quels articles existent
     pour n'afficher le bouton « Lire l'article » que dans ce cas.

     Exemple de valeur :
       https://lechat45.github.io,https://lechat45.github.io/ou-est-ce
     ⚠️ Une ORIGINE, c'est protocole + domaine, SANS chemin. Deux sites hébergés
     sur github.io partagent donc la même origine : une seule entrée suffit pour
     les deux. La liste sert au cas où le jeu déménage sur un autre domaine. */
  const allowedBrut = env('ALLOWED_ORIGIN') || '*';
  const allowedList = allowedBrut.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const allowed = allowedList[0] || '*';
  const okOrigin = allowedBrut === '*'
    || allowedList.includes(origin)
    || origin.startsWith('http://localhost');
  const cors = {
    /* On renvoie l'origine REÇUE quand elle est autorisée, jamais la liste :
       « Access-Control-Allow-Origin » n'accepte qu'une seule valeur. */
    'Access-Control-Allow-Origin': okOrigin ? (origin || '*') : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  /* ⚠️ EXCEPTION AU CONTRÔLE D'ORIGINE — et elle est indispensable.
     /promo/stop est ouvert en cliquant un lien DANS UN COURRIEL : c'est une
     navigation de premier niveau, le navigateur n'envoie donc AUCUN en-tête
     Origin. Avec ALLOWED_ORIGIN configuré, la garde ci-dessous voyait une
     origine vide, la refusait, et le lien de désinscription répondait 403 —
     autrement dit il était impossible de se désabonner, ce qui est justement
     ce que la loi interdit. Cette route ne lit aucune session et n'accepte
     qu'un jeton signé : l'ouvrir ne donne accès à rien d'autre. */
  /* ---- /ping : la seule route conçue pour être ouverte à la main ----
     ⚠️ Pourquoi elle existe. Coller l'adresse du backend dans un navigateur
     renvoyait « Origine non autorisée » : c'est le garde-fou qui fonctionne
     (une navigation directe n'envoie aucun en-tête Origin), mais c'est
     indistinguable d'une panne. On ne savait donc PAS dire si le serveur
     tournait, ni pourquoi l'app n'arrivait pas à lui parler.

     Elle est volontairement AVANT le contrôle d'origine, et volontairement
     avare : elle confirme que le code tourne et rappelle quelle origine est
     attendue — l'adresse publique du site, aucun secret. Elle ne dit RIEN de
     ce qui est configuré par ailleurs : savoir quelles clés existent
     renseignerait un attaquant sur ce qu'il vaut la peine d'attaquer. */
  if (path === '/ping') {
    return json({
      ok: true,
      service: 'Acolyte backend',
      origines_attendues: allowedBrut === '*' ? '*' : allowedList,
      origine_recue: origin || '(aucune — navigation directe, c’est normal)',
      cette_origine_passe: okOrigin,
      heure: new Date().toISOString(),
      aide: allowedBrut === '*'
        ? 'ALLOWED_ORIGIN n’est pas définie : le backend accepte TOUTES les origines. À corriger avant la mise en service.'
        : 'ALLOWED_ORIGIN accepte plusieurs origines séparées par des virgules. Une origine = protocole + domaine, SANS chemin ni barre oblique finale. Ex. : https://lechat45.github.io',
    });
  }

  /* ============================================================
     ROUTES APPELÉES SANS EN-TÊTE « ORIGIN »
     ------------------------------------------------------------
     ⚠️ LA RÈGLE À COMPRENDRE, sinon l'erreur revient : un navigateur n'envoie
     un en-tête « Origin » que pour une requête émise PAR UNE PAGE. Une
     navigation directe n'en envoie pas — et un fetch émis par un SERVEUR
     (Deno, Node, GitHub Actions) n'en envoie jamais non plus. Toute route
     destinée à être appelée de machine à machine doit donc figurer ici, ou
     elle répondra 403 « Origine non autorisée ».

     Chacune est ici pour une raison précise, et aucune n'expose quoi que ce
     soit : leur protection ne repose pas, et n'a jamais reposé, sur l'origine.

     · /ping       diagnostic, ouvert à la main dans un navigateur. Ne dit rien
                   de ce qui est configuré.
     · /promo/stop lien de désinscription cliqué DANS un courriel. Sans cette
                   exemption, se désabonner serait impossible — ce que la loi
                   interdit. Protégé par un jeton signé.
     · /blog/tick  appelé par le Cron de Val Town, donc de serveur à serveur.
                   C'était la cause du « HTTP 403 » dans l'historique du Cron.
                   Protégé par son INTERVALLE : peu importe qui l'appelle et à
                   quelle fréquence, jamais plus d'un article par créneau.
     · /blog       appelé par l'action GitHub qui reconstruit le plan du site.
                   Ne renvoie que des articles DÉJÀ PUBLICS.
  ============================================================ */
  /* ============================================================
     MESURE D'AUDIENCE — DES COMPTEURS, PAS UN TRACEUR
     ------------------------------------------------------------
     But : savoir OÙ les visiteurs abandonnent. Combien arrivent, combien
     créent un compte, combien vont au bout du questionnaire, combien génèrent
     un voyage. Sans ça, toute décision de design est un pari.

     ⚠️ CE QUI N'EST PAS ENREGISTRÉ, et c'est le cœur du dispositif :
     aucune adresse IP, aucun identifiant de visiteur, aucun cookie, aucune
     empreinte de navigateur, aucun horaire précis, aucun parcours individuel.
     La table ne contient que (jour, nom de l'événement, nombre). Il est
     MATHÉMATIQUEMENT impossible d'en reconstituer une personne : on ne stocke
     pas de ligne par visite, on incrémente un entier.

     Conséquence directe : ce ne sont pas des données personnelles au sens du
     RGPD, et il n'y a pas de cookie — donc ni bandeau de consentement, ni
     mention supplémentaire à ajouter. C'est le seul dessin qui permet de
     mesurer sans rien demander au visiteur.

     ⚠️ Liste BLANCHE d'événements. Sans elle, n'importe qui pourrait écrire
     n'importe quelle clé dans la table et s'en servir de stockage gratuit — ou
     y injecter du texte qui finirait affiché dans le panneau d'administration.
  ============================================================ */
  const STAT_CLES = new Set([
    'arrivee', 'inscription', 'connexion',
    'questions_finies', 'questions_passees',
    'voyage_genere', 'voyage_ouvert', 'carte_ouverte', 'blog_ouvert',
    'assistant_utilise', 'assistant_annule', 'horaires_verifies', 'install',
    /* Deuxième vague. Chacune répond à une question qu'on se posait sans
       pouvoir y répondre :
         questionnaire_commence → combien commencent mais n'arrivent pas au bout
                                  (l'abandon le plus coûteux, invisible jusqu'ici)
         assistant_annule       → la qualité de l'IA, mesurée par les refus
         ia_echec               → sa fiabilité, mesurée par les pannes
         hors_ligne             → est-ce que le mode avion sert vraiment
         jour_j                 → est-ce qu'on ouvre Acolyte PENDANT le voyage
         reservation_clic       → est-ce que le programme mène à l'action
         papiers_ouvert         → est-ce que la différence est utilisée
       ⚠️ Toujours des compteurs agrégés : aucun de ces événements n'ajoute la
       moindre donnée personnelle. */
    'questionnaire_commence', 'ia_echec', 'hors_ligne', 'jour_j',
    'reservation_clic', 'papiers_ouvert', 'postcard_cree', 'ics_telecharge', 'partage'
  ]);
  async function statTable() {
    await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_stats(
      jour TEXT NOT NULL, cle TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(jour, cle))`);
  }
  /* Route publique, en POST, sans authentification : le visiteur n'a pas de
     compte au moment où il arrive, et c'est justement l'événement le plus
     important à compter. Elle ne renvoie RIEN d'exploitable — pas même le
     total — pour qu'elle ne serve pas à espionner le trafic du site. */
  if (path === '/stat' && request.method === 'POST') {
    try {
      const b = await request.json().catch(() => ({}));
      const cle = String(b?.cle || '');
      if (!STAT_CLES.has(cle)) return json({ ok: false }, 204);
      await statTable();
      const jour = new Date().toISOString().slice(0, 10);
      await sqlite.execute({
        sql: `INSERT INTO aco_stats(jour, cle, n) VALUES(?, ?, 1)
              ON CONFLICT(jour, cle) DO UPDATE SET n = n + 1`,
        args: [jour, cle] });
    } catch (e) { /* une mesure qui échoue ne doit JAMAIS gêner le visiteur */ }
    return json({ ok: true });
  }

  const SANS_ORIGINE = new Set(['/ping', '/promo/stop', '/blog/tick', '/blog']);
  if (!okOrigin && !SANS_ORIGINE.has(path)) return json({ error: 'Origine non autorisée' }, 403);

  try {
    /* ---- Ce que le backend sait faire (le front l'interroge au démarrage) ---- */

    /* ============================================================
       BLOG — génération d'articles par IA, pilotée depuis le panel admin
       ------------------------------------------------------------
       Le générateur d'origine était une application React + Vite + Bun à part.
       Acolyte n'a pas de compilation : on n'a donc gardé que ce qui compte,
       la CONSIGNE DE RÉDACTION, et on l'a branchée ici. Trois raisons de la
       mettre côté serveur plutôt que dans le navigateur :
       · un article est écrit UNE fois et lu par tout le monde ;
       · il doit survivre au navigateur de celui qui l'a généré ;
       · la clé Gemini reste secrète.

       ⚠️ SÉCURITÉ — deux décisions à ne pas défaire :
       1. On ne stocke NI ne renvoie le HTML rédigé par le modèle. On garde des
          champs structurés (titre, sections, faits) et le navigateur les met en
          forme en échappant tout. Injecter du HTML écrit par un modèle, c'est
          rouvrir la porte au XSS que la CSP nous ferme.
       2. Les clés API du projet d'origine étaient ÉCRITES EN DUR dans son code.
          Elles ne sont pas reprises : on utilise GEMINI_KEY, la variable
          d'environnement déjà en place.
    ============================================================ */
    const BLOG_CATS = { nature:'Merveille naturelle', bati:'Merveille bâtie', ville:'Grande ville' };
    /* Un identifiant d'URL lisible et stable, dérivé du sujet. */
    const slugify = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);

    async function blogTable() {
      await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_posts(
        slug TEXT PRIMARY KEY, sujet TEXT NOT NULL, categorie TEXT NOT NULL,
        titre TEXT NOT NULL, sous_titre TEXT, resume TEXT, lecture TEXT,
        corps TEXT NOT NULL, image TEXT, credit TEXT,
        statut TEXT NOT NULL DEFAULT 'brouillon', created_at INTEGER NOT NULL)`);
    }

    /* ---- Illustration : Wikipédia uniquement ----
       Le générateur d'origine tapait aussi dans Unsplash. Ici ce serait un
       domaine de plus à autoriser dans la CSP pour rien : Wikipédia est déjà
       autorisé, gratuit et sans clé.
       ⚠️ La largeur 960 n'est pas décorative : Wikimedia REFUSE la plupart des
       autres tailles avec une erreur 400 (vérifié). Ne la change pas au hasard. */
    /* ⚠️ TROIS TENTATIVES, et pas une seule.
       L'ancienne version interrogeait le résumé de Wikipédia en français avec le
       sujet tel quel, et abandonnait au premier échec. Elle repartait donc les
       mains vides dès que : le titre ne correspondait pas au mot près (« Chutes
       Victoria » contre « Chutes Victoria (Zambèze) »), l'article français
       n'avait pas d'illustration, ou l'article n'existait qu'en anglais.
       Beaucoup d'articles se retrouvaient sans image pour rien.
       On enchaîne donc : titre exact → recherche puis titre trouvé → anglais. */
    async function wikiResume(langue, titre) {
      try {
        const r = await fetch(`https://${langue}.wikipedia.org/api/rest_v1/page/summary/`
          + encodeURIComponent(titre), { headers: { 'Accept': 'application/json' } });
        if (!r.ok) return '';
        const d = await r.json();
        return d?.originalimage?.source || d?.thumbnail?.source || '';
      } catch (e) { return ''; }
    }
    async function wikiCherche(langue, texte) {
      try {
        const r = await fetch(`https://${langue}.wikipedia.org/w/api.php?action=query&list=search`
          + `&srsearch=${encodeURIComponent(texte)}&srlimit=1&format=json&origin=*`);
        if (!r.ok) return '';
        const d = await r.json();
        return d?.query?.search?.[0]?.title || '';
      } catch (e) { return ''; }
    }
    async function blogImage(sujet) {
      const propre = String(sujet || '').trim();
      if (!propre) return { url: '', credit: '' };
      /* 1. le titre tel quel, en français */
      let src = await wikiResume('fr', propre);
      /* 2. on demande à Wikipédia le titre RÉEL, puis on retente */
      if (!src) {
        const vrai = await wikiCherche('fr', propre);
        if (vrai && vrai.toLowerCase() !== propre.toLowerCase()) src = await wikiResume('fr', vrai);
      }
      /* 3. l'anglais : beaucoup de lieux hors d'Europe y sont mieux illustrés */
      if (!src) {
        const en = await wikiCherche('en', propre);
        if (en) src = await wikiResume('en', en);
      }
      if (!src) return { url: '', credit: '' };
      /* 960 px : mesuré, c'est une des rares largeurs que Wikimédia accepte
         toujours — 640 et 1024 renvoient souvent une erreur 400. */
      return { url: src.replace(/\/\d+px-/, '/960px-'), credit: 'Wikipédia' };
    }

    /* ---- La consigne de rédaction, reprise du générateur d'origine ---- */
    function blogPrompt(sujet, categorie, ton) {
      const cat = BLOG_CATS[categorie] || 'Merveille du monde';
      const tons = { vivant:'vivant et immersif', sobre:'informatif et sobre',
                     poetique:'poétique et évocateur', concis:'concis et direct' };
      return `Tu es grand reporter, géographe et historien, et tu écris pour le magazine Acolyte.
Rédige un grand article de fond sur : ${sujet}.
Catégorie : ${cat}. Ton : ${tons[ton] || tons.vivant}.

Exigences :
1. Français impeccable, vivant, précis. Niveau grand reportage — jamais de remplissage.
2. 4 à 5 sections, titres évocateurs. Chaque section fait 3 paragraphes DENSES et intègre :
   les origines (histoire, géologie ou architecture), une anecdote ou légende peu connue,
   la géographie ou l'atmosphère du lieu, et un conseil d'initié (bonne heure, coin discret).
3. 6 à 8 faits chiffrés PRÉCIS et vérifiables : hauteur ou superficie, année ou époque,
   fréquentation annuelle, matériaux ou géologie, localisation, meilleure saison.
4. RÈGLE ABSOLUE : uniquement des faits réels et vérifiables. Si tu n'es pas sûr d'un
   chiffre, donne un ordre de grandeur ou omets-le. N'invente RIEN.
5. N'écris ni HTML ni Markdown : uniquement du texte. La mise en forme est faite ailleurs.

Ce qui sépare un bon article d'un texte d'IA — applique-le :
6. ATTAQUE. Commence par une scène concrète, un détail sensoriel ou un chiffre qui
   surprend. Jamais par une définition ni par « Situé au cœur de… ».
7. PHRASES INÉGALES. Alterne les longueurs. Une phrase courte après deux longues frappe.
   Un paragraphe entier de phrases de même longueur endort.
8. DU CONCRET, PAS DES ADJECTIFS. « Un escalier de 1 350 marches taillé dans le basalte »
   vaut mieux que « un lieu absolument époustouflant ». Bannis : incontournable,
   emblématique, véritable joyau, à couper le souffle, mythique, unique au monde,
   qui ne laisse personne indifférent, plongez au cœur de.
9. PAS DE CONCLUSION QUI RÉSUME. La dernière section apporte quelque chose de neuf ;
   elle ne récapitule pas ce qu'on vient de lire.
10. VOIX ACTIVE, présent de narration quand ça sert la scène. Pas de « il est
   intéressant de noter que », pas de « en conclusion », pas de « de nos jours ».
11. NOMS PROPRES. Cite des personnes, des dates, des matériaux, des rues, des plats
   précis. C'est ce qui prouve qu'on connaît le lieu.
12. Le titre ne contient ni « : » suivi d'un slogan, ni superlatif creux. Il dit une
   chose précise sur CE lieu-là.

Réponds UNIQUEMENT en JSON :
{
 "titre":"titre captivant, sans deux-points à rallonge",
 "sous_titre":"une phrase d'accroche",
 "resume":"2-3 phrases qui donnent envie de lire",
 "lecture":"ex : 6 min de lecture",
 "sujet":"le nom exact du lieu traité",
 "sections":[{"titre":"titre de section","texte":"3 paragraphes séparés par des retours à la ligne"}],
 "faits":[{"label":"Hauteur","valeur":"324 m"}],
 "tags":["3 à 5 mots-clés"]
}`;
    }

    /* ---- Génération : réservée à l'administrateur ---- */
    /* ============================================================
       GÉNÉRATION AUTOMATIQUE ET CONTINUE
       ------------------------------------------------------------
       Le programme écrit tout seul, sans qu'on lui demande. Trois pièces :

       1. UNE FILE DE SUJETS (aco_queue). Elle est amorcée avec une liste de
          merveilles et de grandes villes, puis elle se REGARNIT toute seule
          avec les destinations que les voyageurs choisissent réellement —
          l'intérêt du blog suit donc l'usage du site, il ne s'épuise pas.

       2. UN DÉCLENCHEUR (/blog/tick). Il ne fait quelque chose QUE si
          l'automatisme est actif ET que le délai est écoulé. C'est cette
          double condition qui borne la dépense : peu importe qui appelle la
          route et à quelle fréquence, il n'y aura jamais plus d'un article
          par intervalle. C'est pour ça qu'elle peut rester ouverte.

       3. UNE PUBLICATION IMMÉDIATE. Un article écrit automatiquement est
          publié automatiquement, sinon la file se remplirait de brouillons
          que personne ne relit. L'administrateur garde la main : il peut
          dépublier, supprimer, ou couper l'automatisme.
    ============================================================ */
    const BLOG_INTERVALLE_DEFAUT = 1;      /* heures entre deux articles : UN PAR HEURE */
    /* Quand une rédaction échoue (l'IA renvoie n'importe quoi, le quota est
       épuisé, le réseau tombe), on ne veut PAS perdre le créneau entier.
       On recule le jalon pour retenter dans ce délai-là. */
    const BLOG_RETRI_MINUTES = 6;
    /* Amorce : des sujets qui ont tous un article Wikipédia, donc une image. */
    const BLOG_AMORCE = [
      ['Mont Fuji','nature'], ['Grand Canyon','nature'], ['Aurores boréales','nature'],
      ['Chutes Victoria','nature'], ['Baie d’Halong','nature'], ['Fjords de Norvège','nature'],
      ['Salar d’Uyuni','nature'], ['Great Barrier Reef','nature'], ['Cappadoce','nature'],
      ['Colisée','bati'], ['Taj Mahal','bati'], ['Machu Picchu','bati'],
      ['Sagrada Família','bati'], ['Angkor Vat','bati'], ['Petra','bati'],
      ['Grande Muraille','bati'], ['Mont Saint-Michel','bati'], ['Alhambra','bati'],
      /* ⚠️ CES DIX-LÀ VIENNENT DU JEU « Où est-ce ? », et elles ne sont pas
         décoratives. Le jeu propose 19 merveilles et met sous chacune un bouton
         « Lire l'article » qui pointe vers ?a=<slug>. Sans ces entrées, DIX de
         ces boutons sur dix-neuf tombaient sur l'écran « pas encore écrit » :
         un joueur sur deux. Toute merveille ajoutée au jeu doit donc être
         ajoutée ici — c'est le seul endroit qui garantit que le lien aboutira. */
      ['Tour Eiffel','bati'], ['Palais de Westminster','bati'],
      ['Statue de la Liberté','bati'], ['Opéra de Sydney','bati'],
      ['Pyramide de Khéops','bati'], ['Tour de Pise','bati'],
      ['Parthénon','bati'], ['Château de Neuschwanstein','bati'],
      ['Chichén Itzá','bati'], ['Basilique Saint-Marc','bati'],
      ['Tokyo','ville'], ['Lisbonne','ville'], ['Istanbul','ville'], ['Marrakech','ville'],
      ['Kyoto','ville'], ['Buenos Aires','ville'], ['Copenhague','ville'], ['Séville','ville'],
    ];

    async function blogConfTable() {
      await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_conf(k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_queue(
        sujet TEXT PRIMARY KEY, categorie TEXT NOT NULL,
        statut TEXT NOT NULL DEFAULT 'attente', ajoute_le INTEGER NOT NULL)`);
    }
    async function conf(k, defaut) {
      await blogConfTable();
      const r = await sqlite.execute({ sql: 'SELECT v FROM aco_conf WHERE k = ?', args: [k] });
      return r.rows[0] ? String(r.rows[0].v ?? r.rows[0][0]) : defaut;
    }
    async function setConf(k, v) {
      await blogConfTable();
      await sqlite.execute({
        sql: `INSERT INTO aco_conf(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        args: [k, String(v)] });
    }

    /* Regarnit la file. Deux sources, dans cet ordre :
       · les destinations RÉELLES des voyages (ce qui intéresse vraiment) ;
       · l'amorce, pour ne jamais tomber à sec.
       On ne remet jamais un sujet déjà écrit ni déjà en file. */
    async function blogRegarnit() {
      await blogConfTable(); await blogTable();
      const pris = new Set();
      try {
        const a = await sqlite.execute(`SELECT sujet FROM aco_posts`);
        for (const r of (a.rows || [])) pris.add(slugify(String(r.sujet ?? r[0])));
        const b = await sqlite.execute(`SELECT sujet FROM aco_queue`);
        for (const r of (b.rows || [])) pris.add(slugify(String(r.sujet ?? r[0])));
      } catch (e) {}

      const aAjouter = [];
      /* 1. les villes et pays où les voyageurs vont vraiment
         ⚠️ CONFIDENTIALITÉ — ces noms viennent des voyages des CLIENTS, et ils
         finiraient en titre d'article PUBLIC. Deux verrous, parce qu'un champ
         rempli par un utilisateur peut contenir n'importe quoi (un prénom, une
         adresse, « voyage de noces de Léa ») :
           · le nom doit ressembler à un vrai toponyme (lettres, espaces,
             traits d'union, apostrophes — ni chiffre, ni @, ni URL) ;
           · il doit apparaître dans AU MOINS DEUX voyages distincts. Une
             destination partagée par plusieurs personnes n'est plus une donnée
             personnelle ; un libellé unique, si.
         Sans ces deux verrous, un seul client pouvait faire publier le texte
         de son choix sur le blog. */
      const TOPONYME = /^[\p{L}][\p{L}\p{M}\s'’\-.]{2,39}$/u;
      const nomPublicOk = (s) => TOPONYME.test(s) && !/\d|@|https?:|www\./i.test(s);
      const SEUIL_PARTAGE = 2;
      try {
        const rows = (await sqlite.execute(`SELECT payload FROM aco_trips LIMIT 400`)).rows || [];
        const vus = new Map();
        for (const row of rows) {
          try {
            const st = JSON.parse(String(row.payload ?? row[0]))?.trip || {};
            const nom = String(st?.trip?.nom ?? '').trim().slice(0, 40);
            if (!nom || /→/.test(nom) || !nomPublicOk(nom)) continue;
            vus.set(nom, (vus.get(nom) || 0) + 1);
          } catch (e) {}
        }
        /* les plus demandées d'abord, et seulement celles que plusieurs
           voyageurs ont choisies */
        for (const [nom, n] of [...vus.entries()].sort((x, y) => y[1] - x[1])) {
          if (n < SEUIL_PARTAGE) continue;
          if (!pris.has(slugify(nom))) { aAjouter.push([nom, 'ville']); pris.add(slugify(nom)); }
        }
      } catch (e) {}
      /* 2. l'amorce */
      for (const [nom, cat] of BLOG_AMORCE) {
        if (!pris.has(slugify(nom))) { aAjouter.push([nom, cat]); pris.add(slugify(nom)); }
      }

      /* 3. LE PUITS NE DOIT JAMAIS SE TARIR.
         ⚠️ C'est le défaut qui a arrêté le blog : les deux sources ci-dessus
         sont FINIES. BLOG_AMORCE est une liste écrite à la main, et les
         destinations des voyageurs n'en fournissent que si plusieurs personnes
         visent le même endroit. Une fois les ~60 sujets de l'amorce rédigés,
         aAjouter était vide, la file restait vide, et le battement horaire
         n'avait plus rien à écrire — sans erreur, sans trace, juste le silence.
         Un générateur qui s'arrête tout seul au bout de deux mois n'est pas un
         générateur, c'est un lot de départ.
         On demande donc à l'IA de proposer elle-même des sujets, en lui
         DISANT ce qui est déjà pris pour qu'elle ne tourne pas en rond.
         ⚠️ Les noms qu'elle renvoie passent par le MÊME contrôle que ceux des
         clients (nomPublicOk) : un modèle peut renvoyer n'importe quoi, et ces
         noms deviennent des titres publics. On ne fait pas confiance à une
         sortie de modèle plus qu'à un champ de formulaire.
         ⚠️ Appelé UNIQUEMENT quand il n'y a plus rien : tant que l'amorce a du
         stock, ça ne coûte pas un appel. */
      if (!aAjouter.length && env('GEMINI_KEY')) {
        try {
          const dejaVus = [...pris].slice(-120).join(', ');
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env('GEMINI_KEY')}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text:
                  `Donne 25 destinations de voyage réelles et notables à traiter dans un blog de voyage francophone.\n`
                  + `Interdit d'utiliser ces sujets, déjà traités : ${dejaVus}\n`
                  + `Varie les continents et les genres. Pour chacune, la catégorie exacte parmi :\n`
                  + `"nature" (merveille naturelle), "bati" (monument ou site construit), "ville" (grande ville).\n`
                  + `Réponds en JSON strict : {"sujets":[{"nom":"...","categorie":"nature|bati|ville"}]}\n`
                  + `Le "nom" est un toponyme seul, sans chiffre, sans ponctuation superflue, 3 à 39 caractères.` }] }],
                generationConfig: { responseMimeType: 'application/json', temperature: 0.9, maxOutputTokens: 2048 },
              }) });
          if (r.ok) {
            const d = await r.json();
            const brut = d?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const sujets = JSON.parse(brut)?.sujets || [];
            const CATS = new Set(['nature', 'bati', 'ville']);
            for (const s of sujets) {
              const nom = String(s?.nom ?? '').trim().slice(0, 40);
              const cat = String(s?.categorie ?? '').trim();
              /* mêmes verrous que pour les noms venant des clients */
              if (!nom || !nomPublicOk(nom) || !CATS.has(cat)) continue;
              if (pris.has(slugify(nom))) continue;
              aAjouter.push([nom, cat]); pris.add(slugify(nom));
            }
          }
        } catch (e) {}
      }

      const now = Date.now();
      for (const [nom, cat] of aAjouter.slice(0, 60)) {
        try {
          await sqlite.execute({
            sql: `INSERT INTO aco_queue(sujet,categorie,statut,ajoute_le) VALUES(?,?,'attente',?)
                  ON CONFLICT(sujet) DO NOTHING`, args: [nom, cat, now] });
        } catch (e) {}
      }
      return aAjouter.length;
    }

    /* Écrit UN article. Renvoie { ok, slug, titre } ou { erreur }.
       Extrait de la route admin pour que l'automatisme et le bouton
       « Rédiger » partagent exactement le même code — un seul chemin à
       maintenir, donc un seul chemin à corriger. */
    async function blogRedige(sujet, categorie, ton, statut) {
      if (!env('GEMINI_KEY')) return { erreur: 'GEMINI_KEY non configurée', code: 501 };
      const slug = slugify(sujet);
      await blogTable();
      let data;
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env('GEMINI_KEY')}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: blogPrompt(sujet, categorie, ton) }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0.75, maxOutputTokens: 8192 },
            }) });
        if (!r.ok) return { erreur: 'Le moteur de rédaction a refusé la demande (' + r.status + ')', code: 502 };
        const g = await r.json();
        const txt = g?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const m = txt.match(/\{[\s\S]*\}/);
        data = JSON.parse(m ? m[0] : txt);
      } catch (e) { return { erreur: 'Réponse illisible du moteur de rédaction', code: 502 }; }
      if (!data?.titre || !Array.isArray(data.sections) || !data.sections.length)
        return { erreur: 'Article incomplet', code: 502 };

      /* ============================================================
         RELECTURE — LE SECOND JET
         ------------------------------------------------------------
         ⚠️ Ce qui manquait : un plan de voyage passe par une relecture croisée
         (reviewPlan côté front), mais un ARTICLE partait en ligne au premier
         jet, sans que personne ne le relise — alors qu'il est publié
         publiquement, signé Acolyte, et qu'il reste.

         Un modèle applique mal une consigne de style du premier coup : il sait
         en revanche très bien REPÉRER ses propres tics quand on le lui demande
         séparément. On refait donc une passe, dédiée à la seule écriture.

         Elle ne peut PAS échouer bruyamment : si la relecture rate, on garde le
         premier jet. Un article moyen publié vaut mieux qu'aucun article.
      ============================================================ */
      async function relire(art) {
        try {
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env('GEMINI_KEY')}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text:
`Tu es chef d'édition. Voici un article destiné à la publication. Réécris-le pour le rendre MEILLEUR, sans rien inventer.

ARTICLE : ${JSON.stringify({ titre: art.titre, sous_titre: art.sous_titre, resume: art.resume, sections: art.sections })}

Ce que tu corriges, dans cet ordre :
1. LA LANGUE DE BOIS. Supprime : incontournable, emblématique, véritable joyau, à couper le souffle, mythique, unique au monde, ne laisse personne indifférent, plongez au cœur de, véritable, authentique, magique, féerique. Remplace chacun par un FAIT concret ou coupe la phrase.
2. LES ATTAQUES MOLLES. Si une section commence par « Situé au cœur de », « Niché entre », une définition ou une généralité, refais la première phrase : une scène, un détail matériel, ou un chiffre qui surprend.
3. LE RYTHME. Si trois phrases de suite ont la même longueur, casse-en une. Une phrase courte après deux longues frappe.
4. LES RÉPÉTITIONS. Un même mot marquant ne revient pas deux fois dans le même paragraphe.
5. LA CONCLUSION QUI RÉSUME. Si la dernière section récapitule ce qu'on vient de lire, remplace-la par quelque chose de neuf : ce que le lieu devient hors saison, ce qu'on y entend à l'aube, ce que les habitants en disent.
6. LE TITRE. S'il contient un superlatif creux ou un slogan après deux-points, refais-le : il doit dire une chose précise sur CE lieu.

RÈGLES ABSOLUES :
· N'INVENTE AUCUN FAIT, aucun chiffre, aucun nom. Tu réécris, tu ne documentes pas. Si une phrase te paraît douteuse, rends-la plus prudente au lieu de la préciser.
· Garde le même nombre de sections et le même sujet.
· Ni HTML ni Markdown : du texte seulement. Les paragraphes sont séparés par des retours à la ligne.

Réponds UNIQUEMENT en JSON :
{"titre":"…","sous_titre":"…","resume":"…","sections":[{"titre":"…","texte":"…"}]}` }] }],
                generationConfig: { responseMimeType: 'application/json', temperature: 0.6, maxOutputTokens: 8192 },
              }) });
          if (!r.ok) return null;
          const g = await r.json();
          const txt = g?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const m = txt.match(/\{[\s\S]*\}/);
          const v = JSON.parse(m ? m[0] : txt);
          /* On n'accepte la réécriture que si elle est COMPLÈTE et de même
             ampleur. Un modèle qui « résume » au lieu de réécrire renverrait un
             article amputé : on préfère alors le premier jet. */
          if (!v?.titre || !Array.isArray(v.sections)) return null;
          if (v.sections.length !== art.sections.length) return null;
          const avant = art.sections.reduce((n, s) => n + String(s.texte || '').length, 0);
          const apres = v.sections.reduce((n, s) => n + String(s.texte || '').length, 0);
          if (apres < avant * 0.75) return null;      /* trop court : refusé */
          return v;
        } catch (e) { return null; }
      }
      const mieux = await relire(data);
      if (mieux) {
        data = { ...data, titre: mieux.titre, sous_titre: mieux.sous_titre || data.sous_titre,
                 resume: mieux.resume || data.resume, sections: mieux.sections, _relu: 1 };
      }

      /* On borne tout : un article vient d'un modèle, donc de l'extérieur. */
      const corps = {
        sections: data.sections.slice(0, 8).map(s => ({
          titre: String(s.titre || '').slice(0, 140),
          texte: String(s.texte || '').slice(0, 6000),
        })),
        faits: (Array.isArray(data.faits) ? data.faits : []).slice(0, 10).map(f => ({
          label: String(f.label || '').slice(0, 60), valeur: String(f.valeur || '').slice(0, 90),
        })),
        tags: (Array.isArray(data.tags) ? data.tags : []).slice(0, 6).map(t => String(t).slice(0, 40)),
      };
      const img = await blogImage(String(data.sujet || sujet));
      const now = Date.now();
      await sqlite.execute({
        sql: `INSERT INTO aco_posts(slug,sujet,categorie,titre,sous_titre,resume,lecture,corps,image,credit,statut,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(slug) DO UPDATE SET sujet=excluded.sujet,categorie=excluded.categorie,
                titre=excluded.titre,sous_titre=excluded.sous_titre,resume=excluded.resume,
                lecture=excluded.lecture,corps=excluded.corps,image=excluded.image,credit=excluded.credit`,
        args: [slug, String(data.sujet || sujet).slice(0, 80), categorie,
               String(data.titre).slice(0, 180), String(data.sous_titre || '').slice(0, 240),
               String(data.resume || '').slice(0, 600), String(data.lecture || '').slice(0, 40),
               JSON.stringify(corps), img.url, img.credit, statut || 'brouillon', now],
      });
      return { ok: true, slug, titre: String(data.titre), sections: corps.sections.length, image: !!img.url };
    }

    /* ---- LE DÉCLENCHEUR ----
       Ouvert à tous, et ce n'est pas une négligence : il refuse de travailler
       si le délai n'est pas écoulé, donc il ne peut pas être détourné pour
       consommer le quota. Il est appelé par l'application (quand quelqu'un
       ouvre le blog) et par le panel admin ; on peut aussi le brancher sur un
       Cron de Val Town pour qu'il tourne même sans visiteur. */
    if (path === '/blog/tick') {
      const actif = (await conf('blog_auto', '1')) === '1';
      if (!actif) return json({ fait: false, raison: 'automatisme en pause' });
      const intervalle = Math.max(1, parseInt(await conf('blog_intervalle', String(BLOG_INTERVALLE_DEFAUT)), 10) || BLOG_INTERVALLE_DEFAUT);
      const dernier = parseInt(await conf('blog_dernier', '0'), 10) || 0;
      const reste = dernier + intervalle * 3600e3 - Date.now();
      if (reste > 0) return json({ fait: false, raison: 'pas encore l’heure', dans_minutes: Math.ceil(reste / 60e3) });

      /* On pose le jalon AVANT d'écrire : si deux appels arrivent en même
         temps, le second voit le délai non écoulé et repart. Sans ça, on
         paierait deux rédactions pour un seul créneau. */
      await setConf('blog_dernier', String(Date.now()));

      /* ⚠️ FILET DE SÉCURITÉ. Le jalon ci-dessus protège de la double dépense,
         mais il avait un effet pervers : posé avant l'écriture, il était
         consommé MÊME SI la rédaction échouait — et le blog restait alors muet
         une heure entière pour une simple erreur passagère (quota, réseau,
         JSON malformé). On recule donc le jalon dès qu'on repart sans article,
         pour retenter dans quelques minutes au lieu d'un cycle complet.
         C'est ce qui garantit qu'un article sort vraiment chaque heure. */
      const replier = async () => {
        await setConf('blog_dernier',
          String(Date.now() - intervalle * 3600e3 + BLOG_RETRI_MINUTES * 60e3));
      };
      const compte = async (cle) => {
        const n = parseInt(await conf(cle, '0'), 10) || 0;
        await setConf(cle, String(n + 1));
      };

      await blogConfTable();
      let q = await sqlite.execute(`SELECT sujet,categorie FROM aco_queue WHERE statut = 'attente' ORDER BY ajoute_le ASC LIMIT 1`);
      if (!q.rows[0]) {                       /* file vide → on la regarnit */
        await blogRegarnit();
        q = await sqlite.execute(`SELECT sujet,categorie FROM aco_queue WHERE statut = 'attente' ORDER BY ajoute_le ASC LIMIT 1`);
      }
      if (!q.rows[0]) { await replier(); return json({ fait: false, raison: 'plus aucun sujet à traiter', retente_dans_minutes: BLOG_RETRI_MINUTES }); }

      const sujet = String(q.rows[0].sujet ?? q.rows[0][0]);
      const categorie = String(q.rows[0].categorie ?? q.rows[0][1]);
      let r;
      try {
        r = await blogRedige(sujet, categorie, 'vivant', 'publie');
      } catch (e) {
        /* blogRedige ne devrait pas lever, mais une exception ici laisserait le
           jalon consommé et le blog muet une heure : on la rattrape. */
        r = { ok: false, erreur: String(e && e.message || e).slice(0, 200) };
      }
      await sqlite.execute({ sql: `UPDATE aco_queue SET statut = ? WHERE sujet = ?`,
                             args: [r.ok ? 'ecrit' : 'echec', sujet] });
      if (!r.ok) {
        await replier();
        await compte('blog_echecs');
        return json({ fait: false, sujet, erreur: r.erreur, retente_dans_minutes: BLOG_RETRI_MINUTES });
      }
      /* trace de bonne santé : c'est ce que le panel admin surveille */
      await setConf('blog_dernier_ok', String(Date.now()));
      await compte('blog_ecrits');
      return json({ fait: true, sujet, slug: r.slug, titre: r.titre, prochain_dans_h: intervalle });
    }

    /* ============================================================
       LETTRE À TOUS LES CLIENTS — LIVRÉE DÉSACTIVÉE
       ------------------------------------------------------------
       Permet d'écrire une fois à ceux qui l'ont ACCEPTÉ (une offre de voyage,
       une nouveauté). Trois verrous, et ils sont posés ICI, côté serveur — pas
       dans le panel : une case grisée dans une page ne protège rien, il suffit
       d'appeler la route à la main pour passer outre.

       VERROU 1 — L'interrupteur général « promo_actif » vaut '0' à la livraison.
         Tant qu'il n'est pas basculé à la main, la route REFUSE d'envoyer, même
         avec une session d'administrateur valable.

       VERROU 2 — Le consentement, colonne « promo_ok », vaut 0 pour TOUT LE
         MONDE. Personne n'est inscrit d'office. C'est ce que la loi européenne
         exige d'une lettre commerciale : un accord donné, pas un refus à
         cocher. Conséquence assumée : au premier essai, la liste est vide.
         C'est normal, ce n'est pas une panne.

       VERROU 3 — Aucun envoi sans lien de désinscription. Il est ajouté par le
         code, pas par celui qui rédige : on ne peut pas l'oublier. Le jeton est
         signé (HMAC) et dérivé de l'adresse, donc ni devinable ni transposable
         d'un client à l'autre — et se désabonner ne demande pas de se
         connecter, ce qui serait un obstacle illégitime.

       Par défaut, un appel d'envoi fait une SIMULATION : il dit qui serait
       touché, sans rien expédier. Il faut « pour_de_vrai:true » en plus de
       tout le reste pour qu'un message parte.
    ============================================================ */
    async function promoTable() {
      await blogConfTable();
      /* La colonne est ajoutée après coup : le ALTER échoue si elle existe
         déjà, et c'est très bien — on l'avale. */
      try {
        await sqlite.execute(`ALTER TABLE aco_users ADD COLUMN promo_ok INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {}
    }
    /* Jeton de désinscription : HMAC-SHA256 de l'adresse avec un secret tiré
       une seule fois et gardé en base. Sans signature, n'importe qui pourrait
       désabonner n'importe qui en devinant une adresse. */
    async function promoSecret() {
      let s = await conf('promo_secret', '');
      if (!s) { s = randomHex(32); await setConf('promo_secret', s); }
      return s;
    }
    async function promoJeton(email) {
      const cle = await crypto.subtle.importKey('raw',
        new TextEncoder().encode(await promoSecret()),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', cle, new TextEncoder().encode(email));
      return [...new Uint8Array(sig)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
    }

    /* ---- Se désinscrire : PUBLIC, et ça doit le rester ---- */
    if (path === '/promo/stop') {
      await promoTable();
      const email = String(url.searchParams.get('e') || '').trim().toLowerCase().slice(0, 160);
      const jeton = String(url.searchParams.get('t') || '');
      if (!email || !jeton) return json({ error: 'lien incomplet' }, 400);
      const attendu = await promoJeton(email);
      /* comparaison à temps constant : sinon on pourrait deviner le jeton
         signature par signature */
      if (!safeEqual(jeton, attendu)) return json({ error: 'lien invalide' }, 403);
      await sqlite.execute({ sql: `UPDATE aco_users SET promo_ok = 0 WHERE email = ?`, args: [email] });
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Désinscription</title>'
        + '<body style="font:16px/1.6 system-ui;background:#121212;color:#F2F1EC;padding:40px">'
        + '<h1 style="font-size:1.3rem">C’est fait.</h1>'
        + '<p>Tu ne recevras plus d’offres de voyage d’Acolyte. Ton compte et tes voyages ne sont pas touchés.</p>',
        { status: 200, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
    }

    /* ---- Lecture des compteurs : administrateur seulement ----
       ⚠️ Protégée alors que l'ÉCRITURE est publique, et c'est volontaire :
       compter est anodin, mais le trafic d'un site est une information
       commerciale. Même garde que le panneau promo. */
    if (path === '/admin/stats') {
      const adm = env('ADMIN_EMAIL').trim().toLowerCase();
      const who = await sessionEmail(request);
      if (!adm || !who || !safeEqual(who, adm)) return json({ error: 'Accès refusé' }, 403);
      await statTable();
      /* 60 jours : assez pour voir une tendance, assez court pour que la table
         ne grossisse jamais au-delà de quelques centaines de lignes. */
      const depuis = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const rows = (await sqlite.execute({
        sql: `SELECT jour, cle, n FROM aco_stats WHERE jour >= ? ORDER BY jour DESC`,
        args: [depuis] })).rows || [];
      const parJour = {}, totaux = {};
      for (const r of rows) {
        const j = String(r.jour ?? r[0]), c = String(r.cle ?? r[1]), n = Number(r.n ?? r[2]) || 0;
        (parJour[j] = parJour[j] || {})[c] = n;
        totaux[c] = (totaux[c] || 0) + n;
      }
      /* L'ENTONNOIR, calculé ici plutôt que dans l'interface : c'est la seule
         lecture qui répond à « où est-ce qu'ils abandonnent ». Un taux brut
         par événement ne le dit pas. */
      const pc = (a, b) => b ? Math.round((a / b) * 100) : null;
      const e = totaux;
      return json({
        ok: true, jours: parJour, totaux,
        entonnoir: {
          arrivees: e.arrivee || 0,
          inscrits: e.inscription || 0,           taux_inscription: pc(e.inscription, e.arrivee),
          questions_au_bout: e.questions_finies || 0,
          questions_passees: e.questions_passees || 0,
          voyages_generes: e.voyage_genere || 0,  taux_voyage: pc(e.voyage_genere, e.inscription)
        }
      });
    }

    /* ---- Le panneau : administrateur seulement ---- */
    if (path === '/admin/promo') {
      const adm = env('ADMIN_EMAIL').trim().toLowerCase();
      const who = await sessionEmail(request);
      if (!adm || !who || !safeEqual(who, adm)) return json({ error: 'Accès refusé' }, 403);
      await promoTable();

      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));

        if (typeof b.actif !== 'undefined') {
          await setConf('promo_actif', b.actif ? '1' : '0');
        }

        if (b.envoyer) {
          /* VERROU 1 */
          if ((await conf('promo_actif', '0')) !== '1')
            return json({ error: 'La lettre est désactivée. Active-la d’abord, en connaissance de cause.' }, 409);
          if (!mailReady(env))
            return json({ error: 'Les variables EMAILJS_* ne sont pas configurées.' }, 409);

          const sujet = String(b.sujet || '').trim().slice(0, 120);
          const message = String(b.message || '').trim().slice(0, 4000);
          if (sujet.length < 3 || message.length < 20)
            return json({ error: 'Il faut un objet et un message.' }, 400);

          /* VERROU 2 : uniquement ceux qui ont dit oui, et qui sont vérifiés */
          const cibles = (await sqlite.execute(
            `SELECT email FROM aco_users WHERE promo_ok = 1 AND verified = 1 LIMIT 2000`
          )).rows || [];
          const liste = cibles.map(r => String(r.email ?? r[0]));

          if (!b.pour_de_vrai)
            return json({ simulation: true, destinataires: liste.length,
                          note: 'Rien n’a été envoyé. Rappelle avec pour_de_vrai:true pour expédier.' });

          let ok = 0, ko = 0;
          for (const email of liste) {
            /* VERROU 3 : le lien de retrait est ajouté par le CODE */
            const stop = `${url.origin}/promo/stop?e=${encodeURIComponent(email)}&t=${await promoJeton(email)}`;
            const corps = message
              + `\n\n— \nTu reçois ce message parce que tu as accepté les offres de voyage d’Acolyte.`
              + `\nMe désinscrire : ${stop}`;
            try {
              const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  service_id: env('EMAILJS_SERVICE'), template_id: env('EMAILJS_TEMPLATE'),
                  user_id: env('EMAILJS_PUBLIC'), accessToken: env('EMAILJS_PRIVATE'),
                  template_params: { to_email: email, email, sujet, code: sujet, message: corps },
                }),
              });
              r.ok ? ok++ : ko++;
            } catch (e) { ko++; }
            /* on espace : EmailJS coupe net au-delà d'un certain débit */
            await new Promise(r => setTimeout(r, 250));
          }
          await setConf('promo_dernier', String(Date.now()));
          return json({ envoye: ok, echecs: ko });
        }
      }

      const total = (await sqlite.execute(`SELECT COUNT(*) AS n FROM aco_users WHERE verified = 1`)).rows[0];
      const oui = (await sqlite.execute(`SELECT COUNT(*) AS n FROM aco_users WHERE promo_ok = 1 AND verified = 1`)).rows[0];
      const dernier = parseInt(await conf('promo_dernier', '0'), 10) || 0;
      return json({
        actif: (await conf('promo_actif', '0')) === '1',
        mail_pret: mailReady(env),
        clients_verifies: total ? Number(total.n ?? total[0]) : 0,
        consentants: oui ? Number(oui.n ?? oui[0]) : 0,
        dernier_envoi: dernier,
      });
    }

    /* ---- Réglage de l'automatisme : administrateur ---- */
    if (path === '/admin/blog/auto') {
      const adm = env('ADMIN_EMAIL').trim().toLowerCase();
      const who = await sessionEmail(request);
      if (!adm || !who || !safeEqual(who, adm)) return json({ error: 'Accès refusé' }, 403);
      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (typeof b.actif !== 'undefined') await setConf('blog_auto', b.actif ? '1' : '0');
        if (b.intervalle) await setConf('blog_intervalle', String(Math.max(1, Math.min(168, parseInt(b.intervalle, 10) || BLOG_INTERVALLE_DEFAUT))));
        if (b.regarnir) await blogRegarnit();
        /* « maintenant » remet le compteur à zéro : le prochain appel au
           déclencheur écrira sans attendre */
        if (b.maintenant) await setConf('blog_dernier', '0');
      }
      await blogConfTable();
      const attente = await sqlite.execute(`SELECT COUNT(*) AS n FROM aco_queue WHERE statut = 'attente'`);
      const suivants = await sqlite.execute(`SELECT sujet FROM aco_queue WHERE statut = 'attente' ORDER BY ajoute_le ASC LIMIT 5`);
      const dernier = parseInt(await conf('blog_dernier', '0'), 10) || 0;
      const intervalle = parseInt(await conf('blog_intervalle', String(BLOG_INTERVALLE_DEFAUT)), 10) || BLOG_INTERVALLE_DEFAUT;
      /* ---- Témoin de bonne santé ----
         Savoir que l'automatisme est « actif » ne dit PAS qu'il produit. Sans
         Cron, /blog/tick n'est appelé que par les visiteurs : zéro visiteur
         pendant la nuit = zéro article, et rien ne le signalait. « en_retard »
         se déclenche dès qu'aucun article n'est sorti depuis plus de deux
         intervalles — c'est le signe qu'il manque un Cron côté Val Town. */
      const dernierOk = parseInt(await conf('blog_dernier_ok', '0'), 10) || 0;
      const depuisOk = dernierOk ? Date.now() - dernierOk : null;
      return json({
        actif: (await conf('blog_auto', '1')) === '1',
        intervalle, dernier,
        prochain_dans_minutes: dernier ? Math.max(0, Math.ceil((dernier + intervalle * 3600e3 - Date.now()) / 60e3)) : 0,
        en_attente: attente.rows[0] ? Number(attente.rows[0].n ?? attente.rows[0][0]) : 0,
        suivants: (suivants.rows || []).map(r => String(r.sujet ?? r[0])),
        dernier_ok: dernierOk,
        heures_depuis_dernier: depuisOk === null ? null : +(depuisOk / 3600e3).toFixed(1),
        en_retard: depuisOk !== null && depuisOk > intervalle * 2 * 3600e3,
        ecrits: parseInt(await conf('blog_ecrits', '0'), 10) || 0,
        echecs: parseInt(await conf('blog_echecs', '0'), 10) || 0,
      });
    }

    if (path === '/admin/blog/generate' && request.method === 'POST') {
      const adm = env('ADMIN_EMAIL').trim().toLowerCase();
      const who = await sessionEmail(request);
      if (!adm || !who || !safeEqual(who, adm)) return json({ error: 'Accès refusé' }, 403);

      const b = await request.json().catch(() => ({}));
      const sujet = String(b.sujet || '').trim().slice(0, 80);
      const categorie = BLOG_CATS[b.categorie] ? b.categorie : 'nature';
      if (sujet.length < 3) return json({ error: 'Sujet manquant' }, 400);

      await blogTable();
      const deja = await sqlite.execute({ sql: 'SELECT slug FROM aco_posts WHERE slug = ?', args: [slugify(sujet)] });
      if (deja.rows[0] && !b.remplacer) return json({ error: 'Un article existe déjà sur ce sujet', slug: slugify(sujet) }, 409);

      /* MÊME code que l'automatisme : un seul chemin de rédaction. Ici on
         garde le brouillon, car un article demandé à la main se relit. */
      const r = await blogRedige(sujet, categorie, String(b.ton || 'vivant'), 'brouillon');
      if (r.erreur) return json({ error: r.erreur }, r.code || 502);
      return json({ ok: true, slug: r.slug, titre: r.titre, sections: r.sections, image: r.image });
    }

    /* ---- Liste complète, brouillons compris : administrateur ---- */
    if (path === '/admin/blog/list') {
      const adm = env('ADMIN_EMAIL').trim().toLowerCase();
      const who = await sessionEmail(request);
      if (!adm || !who || !safeEqual(who, adm)) return json({ error: 'Accès refusé' }, 403);
      await blogTable();
      const r = await sqlite.execute(`SELECT slug,sujet,categorie,titre,statut,created_at,
        (image IS NOT NULL AND image <> '') AS a_image FROM aco_posts ORDER BY created_at DESC LIMIT 200`);
      return json({ articles: (r.rows || []).map(x => ({
        slug: String(x.slug ?? x[0]), sujet: String(x.sujet ?? x[1]), categorie: String(x.categorie ?? x[2]),
        titre: String(x.titre ?? x[3]), statut: String(x.statut ?? x[4]),
        quand: Number(x.created_at ?? x[5]), image: !!Number(x.a_image ?? x[6]) })) });
    }

    /* ---- Publier / dépublier / supprimer : administrateur ---- */
    if (path === '/admin/blog/statut' && request.method === 'POST') {
      const adm = env('ADMIN_EMAIL').trim().toLowerCase();
      const who = await sessionEmail(request);
      if (!adm || !who || !safeEqual(who, adm)) return json({ error: 'Accès refusé' }, 403);
      const b = await request.json().catch(() => ({}));
      const st = b.statut === 'publie' ? 'publie' : 'brouillon';
      await blogTable();
      await sqlite.execute({ sql: 'UPDATE aco_posts SET statut = ? WHERE slug = ?',
                             args: [st, String(b.slug || '').slice(0, 70)] });
      return json({ ok: true, statut: st });
    }
    if (path === '/admin/blog' && request.method === 'DELETE') {
      const adm = env('ADMIN_EMAIL').trim().toLowerCase();
      const who = await sessionEmail(request);
      if (!adm || !who || !safeEqual(who, adm)) return json({ error: 'Accès refusé' }, 403);
      await blogTable();
      await sqlite.execute({ sql: 'DELETE FROM aco_posts WHERE slug = ?',
                             args: [String(url.searchParams.get('slug') || '').slice(0, 70)] });
      return json({ ok: true });
    }

    /* ---- Lecture publique : uniquement les articles PUBLIÉS ---- */
    if (path === '/blog') {
      await blogTable();
      const r = await sqlite.execute(
        `SELECT slug,sujet,categorie,titre,sous_titre,resume,lecture,image,created_at
         FROM aco_posts WHERE statut = 'publie' ORDER BY created_at DESC LIMIT 60`);
      return json({ articles: (r.rows || []).map(x => ({
        slug: String(x.slug ?? x[0]), sujet: String(x.sujet ?? x[1]), categorie: String(x.categorie ?? x[2]),
        titre: String(x.titre ?? x[3]), sous_titre: String(x.sous_titre ?? x[4] ?? ''),
        resume: String(x.resume ?? x[5] ?? ''), lecture: String(x.lecture ?? x[6] ?? ''),
        image: String(x.image ?? x[7] ?? ''), quand: Number(x.created_at ?? x[8]) })) });
    }
    /* ---- Index léger : sert à repérer, dans un voyage, les lieux qui ont
       un article. On ne renvoie que le nécessaire pour faire un lien. ---- */
    if (path === '/blog/index') {
      await blogTable();
      const r = await sqlite.execute(`SELECT slug,sujet,titre FROM aco_posts WHERE statut = 'publie' LIMIT 300`);
      return json({ index: (r.rows || []).map(x => ({
        slug: String(x.slug ?? x[0]), sujet: String(x.sujet ?? x[1]), titre: String(x.titre ?? x[2]) })) });
    }
    if (path === '/blog/article') {
      await blogTable();
      const r = await sqlite.execute({
        sql: `SELECT slug,sujet,categorie,titre,sous_titre,resume,lecture,corps,image,credit,created_at
              FROM aco_posts WHERE slug = ? AND statut = 'publie'`,
        args: [String(url.searchParams.get('slug') || '').slice(0, 70)] });
      const x = r.rows[0];
      if (!x) return json({ error: 'Article introuvable' }, 404);
      let corps = { sections: [], faits: [], tags: [] };
      try { corps = JSON.parse(String(x.corps ?? x[7])); } catch (e) {}
      return json({ article: {
        slug: String(x.slug ?? x[0]), sujet: String(x.sujet ?? x[1]), categorie: String(x.categorie ?? x[2]),
        titre: String(x.titre ?? x[3]), sous_titre: String(x.sous_titre ?? x[4] ?? ''),
        resume: String(x.resume ?? x[5] ?? ''), lecture: String(x.lecture ?? x[6] ?? ''),
        image: String(x.image ?? x[8] ?? ''), credit: String(x.credit ?? x[9] ?? ''),
        quand: Number(x.created_at ?? x[10]), ...corps } });
    }
    if (path === '/capabilities') {
      return json({
        comptes: mailReady(env),
        gemini: !!env('GEMINI_KEY'),
        groq: !!env('GROQ_KEY'),
        travelpayouts: !!env('TRAVELPAYOUTS_KEY'),
      });
    }

    /* ---- Liste des modèles Gemini disponibles ---- */
    /* ---- Diagnostic email : dit CE QU'EMAILJS A RÉPONDU au dernier envoi.
       N'expose aucune clé — seulement les identifiants publics (déjà connus
       du navigateur) et le message d'erreur renvoyé. ---- */
    if (path === '/maildiag') {
      /* Réservé à l'administrateur. Avant, cette route était ouverte : elle
         disait publiquement quelles variables sont configurées et ce qu'a
         répondu EmailJS au dernier envoi. C'est une aide au diagnostic pour
         toi, donc une aide à la reconnaissance pour n'importe qui d'autre. */
      const adm = env('ADMIN_EMAIL').trim().toLowerCase();
      const who = await sessionEmail(request);
      if (!adm || !who || !safeEqual(who, adm)) return json({ error: 'Accès refusé' }, 403);
      return json({
        variables: {
          EMAILJS_PUBLIC: !!env('EMAILJS_PUBLIC'),
          EMAILJS_PRIVATE: !!env('EMAILJS_PRIVATE'),
          EMAILJS_SERVICE: env('EMAILJS_SERVICE') || '(vide)',
          EMAILJS_TEMPLATE: env('EMAILJS_TEMPLATE') || '(vide)',
        },
        derniereReponseEmailJS: await readMail(),
      });
    }

    /* --- outils partagés par les routes d'authentification --- */
    const newSession = async (email) => {
      const token = randomHex(32);
      await sqlite.execute({
        sql: 'INSERT INTO aco_sessions(token_h, email, expires_at) VALUES(?,?,?)',
        args: [await sha256(token), email, Date.now() + SESS_TTL],
      });
      /* On ne garde que les SESS_MAX sessions les plus récentes. Sans ça, un
         jeton oublié sur un ancien appareil reste valable des semaines, et
         chaque connexion en ajoute un de plus, indéfiniment. */
      try {
        await sqlite.execute({
          sql: `DELETE FROM aco_sessions WHERE email = ? AND token_h NOT IN (
                  SELECT token_h FROM aco_sessions WHERE email = ?
                  ORDER BY expires_at DESC LIMIT ?)`,
          args: [email, email, SESS_MAX],
        });
      } catch (e) { /* le plafond est un confort : il ne doit pas bloquer la connexion */ }
      return token;
    };
    /* envoie un code et l'enregistre — seulement si le mail est bien parti */
    const issueCode = async (email) => {
      if (!mailReady(env))
        return { err: "L'envoi d'email n'est pas configuré sur le serveur", status: 501 };
      const now = Date.now();
      const prev = await sqlite.execute({ sql: 'SELECT sent_at FROM aco_codes WHERE email = ?', args: [email] });
      if (prev.rows[0] && now - Number(prev.rows[0][0]) < CODE_WAIT)
        return { err: 'Un code vient déjà d’être envoyé. Attends une minute.', status: 429 };
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (!(await sendCodeMail(env, email, code)))
        return { err: "L'email n'a pas pu être envoyé. Réessaie dans un instant.", status: 502 };
      await sqlite.execute({
        sql: `INSERT INTO aco_codes(email, code_h, expires_at, tries, sent_at) VALUES(?,?,?,0,?)
              ON CONFLICT(email) DO UPDATE SET code_h=excluded.code_h,
              expires_at=excluded.expires_at, tries=0, sent_at=excluded.sent_at`,
        args: [email, await sha256('aco::' + email + '::' + code), now + CODE_TTL, now],
      });
      return { ok: true };
    };
    /* vérifie un code à usage unique ; le consomme en cas de succès */
    const checkCode = async (email, code) => {
      const r = await sqlite.execute({
        sql: 'SELECT code_h, expires_at, tries FROM aco_codes WHERE email = ?', args: [email],
      });
      const row = r.rows[0];
      if (!row) return { err: 'Demande un nouveau code', status: 400 };
      if (Number(row[1]) < Date.now()) {
        await sqlite.execute({ sql: 'DELETE FROM aco_codes WHERE email = ?', args: [email] });
        return { err: 'Code expiré — demandes-en un nouveau', status: 400 };
      }
      if (Number(row[2]) >= CODE_TRIES) {
        await sqlite.execute({ sql: 'DELETE FROM aco_codes WHERE email = ?', args: [email] });
        return { err: 'Trop d’essais — demande un nouveau code', status: 429 };
      }
      if (!safeEqual(String(row[0]), await sha256('aco::' + email + '::' + code))) {
        await sqlite.execute({ sql: 'UPDATE aco_codes SET tries = tries + 1 WHERE email = ?', args: [email] });
        return { err: 'Code incorrect', status: 400 };
      }
      await sqlite.execute({ sql: 'DELETE FROM aco_codes WHERE email = ?', args: [email] });
      return { ok: true };
    };

    /* ---------- 1) Inscription : email + mot de passe → code ---------- */
    if (path === '/auth/signup' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const email = cleanEmail(body.email), pass = cleanPass(body.password);
      if (!email) return json({ error: 'Adresse email invalide' }, 400);
      if (!pass) return json({ error: `Mot de passe : ${PASS_MIN} caractères minimum` }, 400);
      await db();
      const ex = await sqlite.execute({ sql: 'SELECT verified FROM aco_users WHERE email = ?', args: [email] });
      if (ex.rows[0] && Number(ex.rows[0][0]) === 1)
        return json({ error: 'Un compte existe déjà avec cette adresse — connecte-toi' }, 409);

      const salt = randomHex(16);
      /* tant que verified = 0, ce compte ne permet pas de se connecter :
         écraser un compte non vérifié n'expose donc rien */
      await sqlite.execute({
        sql: `INSERT INTO aco_users(email, pass_h, salt, verified, created_at) VALUES(?,?,?,0,?)
              ON CONFLICT(email) DO UPDATE SET pass_h=excluded.pass_h, salt=excluded.salt`,
        args: [email, await hashPass(pass, salt), salt, Date.now()],
      });
      const r = await issueCode(email);
      if (r.err) return json({ error: r.err }, r.status);
      return json({ ok: true, etape: 'verification' });
    }

    /* ---------- 2) Vérification de l'adresse → session ---------- */
    if (path === '/auth/verify' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const email = cleanEmail(body.email), code = String(body.code || '').trim();
      if (!email || !/^\d{6}$/.test(code)) return json({ error: 'Code invalide' }, 400);
      await db();
      const c = await checkCode(email, code);
      if (c.err) return json({ error: c.err }, c.status);
      await sqlite.execute({ sql: 'UPDATE aco_users SET verified = 1 WHERE email = ?', args: [email] });
      return json({ token: await newSession(email), email });
    }

    /* ---------- 3) Connexion ---------- */
    if (path === '/auth/login' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const email = cleanEmail(body.email), pass = String(body.password || '');
      if (!email || !pass) return json({ error: 'Identifiants invalides' }, 400);
      await db();
      const now = Date.now();
      const lk = await sqlite.execute({ sql: 'SELECT fails, locked_until FROM aco_logins WHERE email = ?', args: [email] });
      if (lk.rows[0] && Number(lk.rows[0][1]) > now)
        return json({ error: 'Trop de tentatives — réessaie dans un quart d’heure' }, 429);

      const u = await sqlite.execute({
        sql: 'SELECT pass_h, salt, verified FROM aco_users WHERE email = ?', args: [email],
      });
      const row = u.rows[0];
      /* même message et même travail que le compte existe ou non : sinon on
         peut deviner quelles adresses sont inscrites */
      const salt = row ? String(row[1]) : randomHex(16);
      const calc = await hashPass(pass, salt);
      const good = !!row && safeEqual(String(row[0]), calc);

      if (!good) {
        const fails = (lk.rows[0] ? Number(lk.rows[0][0]) : 0) + 1;
        await sqlite.execute({
          sql: `INSERT INTO aco_logins(email, fails, locked_until) VALUES(?,?,?)
                ON CONFLICT(email) DO UPDATE SET fails=excluded.fails, locked_until=excluded.locked_until`,
          args: [email, fails, fails >= LOGIN_FAILS ? now + LOGIN_LOCK : 0],
        });
        return json({ error: 'Email ou mot de passe incorrect' }, 401);
      }
      if (Number(row[2]) !== 1) {
        const r = await issueCode(email);
        return json({ error: 'Adresse non vérifiée — un code vient de t’être envoyé',
                      etape: 'verification', envoye: !r.err }, 403);
      }
      await sqlite.execute({ sql: 'DELETE FROM aco_logins WHERE email = ?', args: [email] });
      return json({ token: await newSession(email), email });
    }

    /* ---------- 4) Mot de passe oublié : demande de code ---------- */
    if (path === '/auth/forgot' && request.method === 'POST') {
      const email = cleanEmail((await request.json().catch(() => ({}))).email);
      if (!email) return json({ error: 'Adresse email invalide' }, 400);
      await db();
      const ex = await sqlite.execute({ sql: 'SELECT email FROM aco_users WHERE email = ?', args: [email] });
      /* réponse identique même si l'adresse est inconnue : ne pas révéler
         qui possède un compte. On n'envoie évidemment rien dans ce cas. */
      if (ex.rows[0]) await issueCode(email);
      return json({ ok: true });
    }

    /* ---------- 5) Mot de passe oublié : nouveau mot de passe ---------- */
    if (path === '/auth/reset' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const email = cleanEmail(body.email), code = String(body.code || '').trim();
      const pass = cleanPass(body.password);
      if (!email || !/^\d{6}$/.test(code)) return json({ error: 'Code invalide' }, 400);
      if (!pass) return json({ error: `Mot de passe : ${PASS_MIN} caractères minimum` }, 400);
      await db();
      const c = await checkCode(email, code);
      if (c.err) return json({ error: c.err }, c.status);
      const salt = randomHex(16);
      await sqlite.execute({
        sql: 'UPDATE aco_users SET pass_h = ?, salt = ?, verified = 1 WHERE email = ?',
        args: [await hashPass(pass, salt), salt, email],
      });
      /* changer de mot de passe coupe les sessions ouvertes ailleurs —
         c'est le premier réflexe quand on se croit piraté */
      await sqlite.execute({ sql: 'DELETE FROM aco_sessions WHERE email = ?', args: [email] });
      await sqlite.execute({ sql: 'DELETE FROM aco_logins WHERE email = ?', args: [email] });
      purge();                       /* ménage à l'occasion d'une connexion réussie */
      return json({ token: await newSession(email), email });
    }

    /* ---------- 3) Déconnexion ---------- */
    if (path === '/auth/logout' && request.method === 'POST') {
      const h = request.headers.get('Authorization') || '';
      const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      if (tok) {
        await db();
        await sqlite.execute({ sql: 'DELETE FROM aco_sessions WHERE token_h = ?', args: [await sha256(tok)] });
      }
      return json({ ok: true });
    }

    /* ---------- 4) Synchronisation des voyages ---------- */
    if (path === '/sync') {
      const email = await sessionEmail(request);
      if (!email) return json({ error: 'Session expirée — reconnecte-toi' }, 401);

      if (request.method === 'GET') {
        const r = await sqlite.execute({
          sql: 'SELECT payload, updated_at FROM aco_trips WHERE email = ?', args: [email],
        });
        const row = r.rows[0];
        return json(row ? { payload: JSON.parse(String(row[0])), updated_at: Number(row[1]) }
                        : { payload: null, updated_at: 0 });
      }
      if (request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || typeof body.payload === 'undefined') return json({ error: 'Contenu manquant' }, 400);
        const txt = JSON.stringify(body.payload);
        if (txt.length > MAX_PAYLOAD) return json({ error: 'Sauvegarde trop volumineuse' }, 413);
        const now = Date.now();
        /* dernier enregistrement gagne : simple et prévisible */
        await sqlite.execute({
          sql: `INSERT INTO aco_trips(email, payload, updated_at) VALUES(?,?,?)
                ON CONFLICT(email) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
          args: [email, txt, now],
        });
        return json({ ok: true, updated_at: now });
      }
    }

    /* ---------- 5) Suppression définitive du compte ---------- */
    if (path === '/account' && request.method === 'DELETE') {
      const email = await sessionEmail(request);
      if (!email) return json({ error: 'Session expirée — reconnecte-toi' }, 401);
      /* TOUTE table qui porte l'email doit figurer ici : « supprimer mon
         compte » doit vraiment ne rien laisser derrière. Si tu ajoutes une
         table avec une colonne email un jour, ajoute-la dans cette liste. */
      for (const t of ['aco_trips', 'aco_sessions', 'aco_codes', 'aco_logins', 'aco_users', 'aco_scores', 'aco_ai']) {
        /* try/catch par table : une table pas encore créée ne doit pas
           interrompre la suppression des autres */
        try { await sqlite.execute({ sql: `DELETE FROM ${t} WHERE email = ?`, args: [email] }); }
        catch (e) {}
      }
      return json({ ok: true });
    }

    /* ---------- Classement du mini-jeu ---------- */
    if (path === '/game/score' && request.method === 'POST') {
      const email = await sessionEmail(request);
      if (!email) return json({ error: 'Connecte-toi pour enregistrer ton score' }, 401);
      const body = await request.json().catch(() => ({}));
      const score = Math.max(0, Math.min(1_000_000, parseInt(body.score, 10) || 0));
      const name = String(body.name || 'Voyageur').trim().slice(0, 20) || 'Voyageur';
      await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_scores(
        email TEXT PRIMARY KEY, name TEXT NOT NULL, score INTEGER NOT NULL, at INTEGER NOT NULL)`);
      /* on ne garde que le MEILLEUR score de chaque joueur */
      await sqlite.execute({
        sql: `INSERT INTO aco_scores(email, name, score, at) VALUES(?,?,?,?)
              ON CONFLICT(email) DO UPDATE SET name=excluded.name,
              score=MAX(aco_scores.score, excluded.score), at=excluded.at`,
        args: [email, name, score, Date.now()],
      });
      return json({ ok: true });
    }
    if (path === '/game/top') {
      await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_scores(
        email TEXT PRIMARY KEY, name TEXT NOT NULL, score INTEGER NOT NULL, at INTEGER NOT NULL)`);
      const r = await sqlite.execute(`SELECT name, score FROM aco_scores ORDER BY score DESC, at ASC LIMIT 10`);
      const top = (r.rows || []).map(row => ({ name: String(row.name ?? row[0]), score: Number(row.score ?? row[1]) }));
      return json({ top });
    }

    /* ============================================================
       PANEL ADMIN — statistiques AGRÉGÉES uniquement.
       ------------------------------------------------------------
       Règles de sécurité tenues ici, pas côté navigateur :
       1. Autorisation serveur : la session doit correspondre EXACTEMENT
          à ADMIN_EMAIL. Aucun autre compte ne passe.
       2. Cette route ne renvoie QUE des nombres. Jamais un email, jamais
          un contenu de voyage, jamais une note. Même une session admin
          volée ne donnerait accès à aucune donnée personnelle.
       3. Seuil d'anonymat : une destination comptant moins de K voyages
          est fondue dans « autres » — sinon « 1 voyage à Reykjavik »
          désignerait quelqu'un dans une petite base.
    ============================================================ */
    if (path === '/admin/stats') {
      const admin = env('ADMIN_EMAIL').trim().toLowerCase();
      const email = await sessionEmail(request);
      /* message identique dans tous les cas de refus : on n'indique jamais
         si c'est la session ou le droit qui manque */
      if (!admin || !email || !safeEqual(email, admin)) return json({ error: 'Accès refusé' }, 403);

      const K = 5;                       /* seuil d'anonymat */
      const now = Date.now(), J7 = now - 7 * 864e5, J30 = now - 30 * 864e5;

      const cnt = async (sql, args = []) => {
        const r = await sqlite.execute({ sql, args });
        const row = r.rows?.[0];
        return row ? Number(row.n ?? row[0]) : 0;
      };
      const comptes = {
        total:      await cnt(`SELECT COUNT(*) AS n FROM aco_users`),
        verifies:   await cnt(`SELECT COUNT(*) AS n FROM aco_users WHERE verified = 1`),
        nouveaux7j: await cnt(`SELECT COUNT(*) AS n FROM aco_users WHERE created_at > ?`, [J7]),
        nouveaux30j:await cnt(`SELECT COUNT(*) AS n FROM aco_users WHERE created_at > ?`, [J30]),
      };

      /* ---- Inscriptions jour par jour sur 30 jours ----
         Des COMPTES par jour, jamais une date rattachée à quelqu'un. Avec un
         seul inscrit dans la journée la case vaut 1 : c'est un volume, pas une
         identité — on ne peut pas remonter à la personne depuis un nombre. */
      const courbe = [];
      try {
        const jours = new Map();
        for (let i = 29; i >= 0; i--) {
          const d = new Date(now - i * 864e5);
          jours.set(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`, 0);
        }
        const r = await sqlite.execute({ sql: `SELECT created_at FROM aco_users WHERE created_at > ?`, args: [now - 30 * 864e5] });
        for (const row of (r.rows || [])) {
          const d = new Date(Number(row.created_at ?? row[0]));
          const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
          if (jours.has(k)) jours.set(k, jours.get(k) + 1);
        }
        for (const [j, n] of jours) courbe.push({ j, n });
      } catch (e) {}

      /* ---- Agrégation des voyages ----
         On lit les payloads UNIQUEMENT pour compter. Rien de ce qui est lu
         ici ne sort de cette fonction : ni un nom, ni une note, ni un email. */
      const dest = new Map(), pays = new Map();
      const modes = { avion: 0, train: 0, voiture: 0, autre: 0 };
      const budget = { petit: 0, moyen: 0, confort: 0, eleve: 0, inconnu: 0 };
      const duree  = { weekend: 0, semaine: 0, deuxSemaines: 0, plus: 0, inconnu: 0 };
      const avecQui = { solo: 0, couple: 0, amis: 0, famille: 0, collegues: 0, inconnu: 0 };
      const sejour = { hotel: 0, appartement: 0, auberge: 0, luxe: 0, inconnu: 0 };
      const mois = new Array(12).fill(0);
      let voyagesTotal = 0, avecPlan = 0, actifs7j = 0, actifs30j = 0, multiBase = 0;

      /* Ranger une valeur libre dans un casier fixe : on ne stocke jamais le
         texte de l'utilisateur, seulement le casier où il tombe. */
      const casier = (v, table) => {
        const s = String(v || '').toLowerCase();
        for (const [motif, cle] of table) if (motif.test(s)) return cle;
        return 'inconnu';
      };
      const T_BUDGET = [[/petit|<\s*500|moins/, 'petit'], [/moyen|500/, 'moyen'], [/confort|1200/, 'confort'], [/élev|eleve|2500|luxe/, 'eleve']];
      const T_DUREE  = [[/week|2-3/, 'weekend'], [/1 semaine|7 j|une semaine/, 'semaine'], [/2 semaines|14/, 'deuxSemaines'], [/3 semaines|21|mois|\+/, 'plus']];
      const T_QUI    = [[/solo|seul/, 'solo'], [/couple/, 'couple'], [/ami/, 'amis'], [/famille|enfant/, 'famille'], [/collègue|collegue|travail/, 'collegues']];
      const T_SEJOUR = [[/hôtel|hotel/, 'hotel'], [/appart|airbnb/, 'appartement'], [/auberge|hostel|éco|eco/, 'auberge'], [/luxe|luxury/, 'luxe']];

      try {
        const rows = (await sqlite.execute(`SELECT payload, updated_at FROM aco_trips`)).rows || [];
        for (const row of rows) {
          voyagesTotal++;
          const maj = Number(row.updated_at ?? row[1]) || 0;
          if (maj > J7) actifs7j++;
          if (maj > J30) actifs30j++;
          try {
            const p = JSON.parse(String(row.payload ?? row[0]));
            const st = p?.trip || {};
            const nom = st?.trip?.nom, pa = st?.trip?.pays;
            if (nom) dest.set(String(nom).slice(0, 60), (dest.get(String(nom).slice(0, 60)) || 0) + 1);
            if (pa) pays.set(String(pa).slice(0, 60), (pays.get(String(pa).slice(0, 60)) || 0) + 1);
            const m = st?.cache?.plan?.transport?.mode;
            if (m && modes[m] !== undefined) modes[m]++; else if (m) modes.autre++;
            if (st?.cache?.plan) avecPlan++;
            if ((st?.cache?.plan?.logement?.etapes || []).length > 1) multiBase++;
            const pr = st?.prefs || {};
            budget[casier(pr.budget, T_BUDGET)]++;
            duree[casier(pr.days, T_DUREE)]++;
            avecQui[casier(pr.withWho, T_QUI)]++;
            sejour[casier(pr.stay, T_SEJOUR)]++;
            /* mois de départ : un chiffre de 1 à 12, jamais la date exacte */
            const dep = String(pr.depart || '');
            const mm = dep.match(/^\d{4}-(\d{2})/);
            if (mm) { const i = +mm[1] - 1; if (i >= 0 && i < 12) mois[i]++; }
          } catch (e) { /* payload illisible : on l'ignore, il ne compte pas */ }
        }
      } catch (e) { /* table absente : aucun voyage encore */ }

      /* seuil d'anonymat : en dessous de K, on ne nomme pas le lieu */
      const auSeuil = (map) => {
        const vus = [], masq = { lieux: 0, voyages: 0 };
        for (const [nom, n] of map) {
          if (n >= K) vus.push({ nom, n });
          else { masq.lieux++; masq.voyages += n; }
        }
        vus.sort((a, b) => b.n - a.n);
        return { vus: vus.slice(0, 12), masq };
      };
      const D = auSeuil(dest), P = auSeuil(pays);

      /* ---- GARDE-FOU « petit échantillon » ----
         Avec très peu de voyages, même un casier fixe devient indiscret :
         « 1 voyage en train » sur 2 voyages, et l'admin sait qui a choisi
         quoi. En dessous du seuil, on ne renvoie AUCUNE répartition —
         seulement les totaux. C'est la même règle que pour les lieux,
         appliquée à tout le reste. */
      const assezDeMonde = voyagesTotal >= K;

      let jeu = [], joueurs = 0;
      try {
        const r = await sqlite.execute(`SELECT name, score FROM aco_scores ORDER BY score DESC LIMIT 10`);
        jeu = (r.rows || []).map(x => ({ name: String(x.name ?? x[0]).slice(0, 20), score: Number(x.score ?? x[1]) }));
        joueurs = await cnt(`SELECT COUNT(*) AS n FROM aco_scores`);
      } catch (e) {}

      /* appareils connectés et appels IA de l'heure : des volumes, utiles pour
         surveiller la charge et le coût. Aucun rattachement à un compte. */
      let appareils = 0, iaHeure = 0, iaComptes = 0;
      try { appareils = await cnt(`SELECT COUNT(*) AS n FROM aco_sessions WHERE expires_at > ?`, [now]); } catch (e) {}
      try {
        iaHeure = await cnt(`SELECT COALESCE(SUM(n),0) AS n FROM aco_ai WHERE window_start > ?`, [now - 3600 * 1000]);
        iaComptes = await cnt(`SELECT COUNT(*) AS n FROM aco_ai WHERE window_start > ?`, [now - 3600 * 1000]);
      } catch (e) {}

      return json({
        comptes,
        /* multiBase est une RÉPARTITION des voyages : elle tombe donc sous le
           même garde-fou que les autres. Sur 2 voyages, « 1 itinérant »
           dirait ce qu'une personne précise a demandé. */
        voyages: { total: voyagesTotal, avecPlan, actifs7j, actifs30j,
                   multiBase: assezDeMonde ? multiBase : null },
        courbe,
        destinations: D.vus,
        destinationsMasquees: D.masq,
        pays: P.vus,
        paysMasques: P.masq,
        /* les répartitions ne partent QUE si l'échantillon est assez grand */
        transports: assezDeMonde ? modes : null,
        budget:     assezDeMonde ? budget : null,
        duree:      assezDeMonde ? duree : null,
        avecQui:    assezDeMonde ? avecQui : null,
        sejour:     assezDeMonde ? sejour : null,
        mois:       assezDeMonde ? mois : null,
        assezDeMonde,
        technique: { appareils, iaHeure, iaComptes },
        jeu, joueurs,
        seuil: K,
        genere: now,
      });
    }

    /* ---- Les trois routes ci-dessous consomment TES clés API. Elles étaient
       ouvertes à tous : l'adresse du proxy est publique, donc n'importe qui
       pouvait s'en servir gratuitement jusqu'à épuiser le quota. Désormais
       il faut une session Acolyte valable, et le nombre d'appels par heure
       est plafonné par compte. ---- */
    if (path === '/gemini/models') {
      const g = await aiGuard(request);
      if (g.err) return json({ error: g.err }, g.status);
      if (!env('GEMINI_KEY')) return json({ error: 'GEMINI_KEY non configurée' }, 501);
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env('GEMINI_KEY')}&pageSize=100`);
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ---- Génération Gemini : POST {model, body} ---- */
    if (path === '/gemini') {
      const g = await aiGuard(request);
      if (g.err) return json({ error: g.err }, g.status);
      if (!env('GEMINI_KEY')) return json({ error: 'GEMINI_KEY non configurée' }, 501);
      const { model, body } = await request.json();
      const m = String(model || 'gemini-2.5-flash').replace(/[^a-zA-Z0-9.\-_]/g, '');
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env('GEMINI_KEY')}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ---- Génération Groq : POST {body} ---- */
    if (path === '/groq') {
      const g = await aiGuard(request);
      if (g.err) return json({ error: g.err }, g.status);
      if (!env('GROQ_KEY')) return json({ error: 'GROQ_KEY non configurée' }, 501);
      const { body } = await request.json();
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('GROQ_KEY')}` },
        body: JSON.stringify(body),
      });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ---- Prix d'hôtels : le token est injecté ICI, jamais dans le navigateur ---- */
    if (path === '/hotels') {
      const g = await aiGuard(request);
      if (g.err) return json({ error: g.err }, g.status);
      if (!env('TRAVELPAYOUTS_KEY')) return json({ error: 'TRAVELPAYOUTS_KEY non configurée' }, 501);
      const p = url.searchParams;
      const api = new URL('https://engine.hotellook.com/api/v2/cache.json');
      ['location', 'checkIn', 'checkOut', 'adults', 'children', 'currency', 'limit'].forEach(k => {
        if (p.get(k)) api.searchParams.set(k, p.get(k));
      });
      api.searchParams.set('token', env('TRAVELPAYOUTS_KEY'));
      const r = await fetch(api.toString(), { headers: { Accept: 'application/json' } });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ---- Relais CORS générique (compat : ?url=…) ---- */
    const target = url.searchParams.get('url');
    if (target) {
      /* relais générique : session obligatoire aussi, et liste blanche d'hôtes */
      const g = await aiGuard(request);
      if (g.err) return json({ error: g.err }, g.status);
      let u;
      try { u = new URL(target); } catch { return json({ error: 'URL invalide' }, 400); }
      if (!RELAY_HOSTS.includes(u.hostname)) return json({ error: 'Domaine non autorisé : ' + u.hostname }, 403);
      const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return json({ error: 'Route inconnue', routes: ['/capabilities', '/gemini', '/gemini/models', '/groq', '/hotels', '/?url='] }, 404);
  } catch (e) {
    return json({ error: 'Backend : ' + e.message }, 502);
  }
}
