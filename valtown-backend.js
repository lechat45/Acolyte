/* ============================================================
   ACOLITE — Backend (Val Town, 100 % gratuit)
   ============================================================
   RÔLE : garder tes clés API SECRÈTES (même rôle que worker.js).

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
        ADMIN_EMAIL       = l'adresse EXACTE de ton compte Acolite
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
      https://tonpseudo--acolite.web.val.run) dans config.js → proxy
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
  if (!email) return { err: 'Connecte-toi pour utiliser Acolite', status: 401 };
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
    console.log('[acolite] EmailJS →', why);        /* visible dans les logs Val Town */
    await noteMail(why);
    return r.ok;
  } catch (e) {
    const why = 'appel impossible : ' + String(e).slice(0, 120);
    console.log('[acolite] EmailJS →', why);
    await noteMail(why);
    return false;
  }
}

export default async function (request) {
  const env = (k) => Deno.env.get(k) || '';
  const origin = request.headers.get('Origin') || '';
  const allowed = env('ALLOWED_ORIGIN') || '*';
  /* n'autorise que TON site (ou tout le monde si non configuré) */
  const okOrigin = allowed === '*' || origin === allowed || origin.startsWith('http://localhost');
  const cors = {
    'Access-Control-Allow-Origin': okOrigin ? (origin || '*') : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!okOrigin) return json({ error: 'Origine non autorisée' }, 403);

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  try {
    /* ---- Ce que le backend sait faire (le front l'interroge au démarrage) ---- */
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
       il faut une session Acolite valable, et le nombre d'appels par heure
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
