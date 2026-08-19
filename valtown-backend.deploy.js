// ===========================================================
// FICHIER GENERE - NE PAS MODIFIER ICI.
// Produit par : node outils/valtown-build.js
// Source (commentee, a corriger la-bas) : valtown-backend.js
// Les commentaires sont retires pour tenir sous les 80000 caracteres
// que Val Town autorise par val. Relance le script apres chaque
// correction : ce fichier est ecrase a chaque passage.
//
// --- Variables d'environnement (Val Town > onglet Secrets) ---
//   - ADMIN_EMAIL
//   - ALLOWED_ORIGIN
//   - EMAILJS_PRIVATE
//   - EMAILJS_PUBLIC
//   - EMAILJS_SERVICE
//   - EMAILJS_TEMPLATE
//   - GEMINI_KEY
//   - GROQ_KEY
//   - TRAVELPAYOUTS_KEY
//
// GEMINI_KEY et les quatre EMAILJS_* sont indispensables : sans elles,
// la redaction d'articles et l'envoi de courriels ne marchent pas.
// ALLOWED_ORIGIN = l'adresse du site, sans barre oblique finale.
// ADMIN_EMAIL = l'adresse qui ouvre le panneau de statistiques.
// ===========================================================
const RELAY_HOSTS = ['engine.hotellook.com', 'yasen.hotellook.com', 'api.travelpayouts.com'];

const AI_MAX_H = 120;

import { sqlite } from 'https://esm.town/v/std/sqlite';

const CODE_TTL   = 10 * 60 * 1000;        
const CODE_WAIT  = 60 * 1000;             
const CODE_TRIES = 5;                     

const SESS_TTL   = 30 * 24 * 3600 * 1000;
const SESS_MAX   = 5;                     
const MAX_PAYLOAD = 400_000;              
const PASS_MIN   = 8;                     
const PBKDF2_IT  = 210_000;               
const LOGIN_FAILS = 8;                    
const LOGIN_LOCK  = 15 * 60 * 1000;       

let _dbReady = null;
function db() {
  
  if (!_dbReady) _dbReady = (async () => {
    
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

async function hashPass(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_IT, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, '0')).join('');
}

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
  if (Number(row[1]) < Date.now()) {                 
    await sqlite.execute({ sql: 'DELETE FROM aco_sessions WHERE token_h = ?', args: [await sha256(tok)] });
    return null;
  }
  return String(row[0]);
}

function mailReady(env) {
  return !!(env('EMAILJS_PUBLIC') && env('EMAILJS_PRIVATE')
         && env('EMAILJS_SERVICE') && env('EMAILJS_TEMPLATE'));
}

async function diagTable() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS aco_diag(k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL)`);
}

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
    
    const n = (row && now - debut < H) ? Number(row[0]) : 0;
    const fenetre = (row && now - debut < H) ? debut : now;
    if (n >= AI_MAX_H) return { err: 'Beaucoup de demandes d’un coup — réessaie dans un moment', status: 429 };
    await sqlite.execute({
      sql: `INSERT INTO aco_ai(email, n, window_start) VALUES(?,?,?)
            ON CONFLICT(email) DO UPDATE SET n = excluded.n, window_start = excluded.window_start`,
      args: [email, n + 1, fenetre],
    });
  } catch (e) {  }
  return { email };
}

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
  } catch (e) {  }
}
async function readMail() {
  try {
    await diagTable();
    const r = await sqlite.execute({ sql: `SELECT v, ts FROM aco_diag WHERE k = 'mail'`, args: [] });
    if (!r.rows || !r.rows[0]) return 'aucun envoi enregistré';
    const row = r.rows[0];
    
    const v = row.v ?? row[0], ts = Number(row.ts ?? row[1]);
    return `${v}  (il y a ${Math.round((Date.now() - ts) / 1000)} s)`;
  } catch (e) {
    
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
    console.log('[acolyte] EmailJS →', why);        
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
  
  const allowedBrut = env('ALLOWED_ORIGIN') || '*';
  const allowedList = allowedBrut.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const allowed = allowedList[0] || '*';
  const okOrigin = allowedBrut === '*'
    || allowedList.includes(origin)
    || origin.startsWith('http://localhost');
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

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

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

  const STAT_CLES = new Set([
    'arrivee', 'inscription', 'connexion',
    'questions_finies', 'questions_passees',
    'voyage_genere', 'voyage_ouvert', 'carte_ouverte', 'blog_ouvert',
    'assistant_utilise', 'assistant_annule', 'horaires_verifies', 'install',
    
    'questionnaire_commence', 'ia_echec', 'hors_ligne', 'jour_j',
    'reservation_clic', 'papiers_ouvert', 'postcard_cree', 'ics_telecharge', 'partage'
  ]);
  async function statTable() {
    await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_stats(
      jour TEXT NOT NULL, cle TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(jour, cle))`);
  }
  
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
    } catch (e) {  }
    return json({ ok: true });
  }

  const SANS_ORIGINE = new Set(['/ping', '/promo/stop', '/blog/tick', '/blog']);
  if (!okOrigin && !SANS_ORIGINE.has(path)) return json({ error: 'Origine non autorisée' }, 403);

  try {
    
    const BLOG_CATS = { nature:'Merveille naturelle', bati:'Merveille bâtie', ville:'Grande ville' };
    
    const slugify = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);

    async function blogTable() {
      await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_posts(
        slug TEXT PRIMARY KEY, sujet TEXT NOT NULL, categorie TEXT NOT NULL,
        titre TEXT NOT NULL, sous_titre TEXT, resume TEXT, lecture TEXT,
        corps TEXT NOT NULL, image TEXT, credit TEXT,
        statut TEXT NOT NULL DEFAULT 'brouillon', created_at INTEGER NOT NULL)`);
    }

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
      
      let src = await wikiResume('fr', propre);
      
      if (!src) {
        const vrai = await wikiCherche('fr', propre);
        if (vrai && vrai.toLowerCase() !== propre.toLowerCase()) src = await wikiResume('fr', vrai);
      }
      
      if (!src) {
        const en = await wikiCherche('en', propre);
        if (en) src = await wikiResume('en', en);
      }
      if (!src) return { url: '', credit: '' };
      
      return { url: src.replace(/\/\d+px-/, '/960px-'), credit: 'Wikipédia' };
    }

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

    const BLOG_INTERVALLE_DEFAUT = 1;      
    
    const BLOG_RETRI_MINUTES = 6;
    
    const BLOG_AMORCE = [
      ['Mont Fuji','nature'], ['Grand Canyon','nature'], ['Aurores boréales','nature'],
      ['Chutes Victoria','nature'], ['Baie d’Halong','nature'], ['Fjords de Norvège','nature'],
      ['Salar d’Uyuni','nature'], ['Great Barrier Reef','nature'], ['Cappadoce','nature'],
      ['Colisée','bati'], ['Taj Mahal','bati'], ['Machu Picchu','bati'],
      ['Sagrada Família','bati'], ['Angkor Vat','bati'], ['Petra','bati'],
      ['Grande Muraille','bati'], ['Mont Saint-Michel','bati'], ['Alhambra','bati'],
      
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
        
        for (const [nom, n] of [...vus.entries()].sort((x, y) => y[1] - x[1])) {
          if (n < SEUIL_PARTAGE) continue;
          if (!pris.has(slugify(nom))) { aAjouter.push([nom, 'ville']); pris.add(slugify(nom)); }
        }
      } catch (e) {}
      
      for (const [nom, cat] of BLOG_AMORCE) {
        if (!pris.has(slugify(nom))) { aAjouter.push([nom, cat]); pris.add(slugify(nom)); }
      }

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
          
          if (!v?.titre || !Array.isArray(v.sections)) return null;
          if (v.sections.length !== art.sections.length) return null;
          const avant = art.sections.reduce((n, s) => n + String(s.texte || '').length, 0);
          const apres = v.sections.reduce((n, s) => n + String(s.texte || '').length, 0);
          if (apres < avant * 0.75) return null;      
          return v;
        } catch (e) { return null; }
      }
      const mieux = await relire(data);
      if (mieux) {
        data = { ...data, titre: mieux.titre, sous_titre: mieux.sous_titre || data.sous_titre,
                 resume: mieux.resume || data.resume, sections: mieux.sections, _relu: 1 };
      }

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

    if (path === '/blog/tick') {
      const actif = (await conf('blog_auto', '1')) === '1';
      if (!actif) return json({ fait: false, raison: 'automatisme en pause' });
      const intervalle = Math.max(1, parseInt(await conf('blog_intervalle', String(BLOG_INTERVALLE_DEFAUT)), 10) || BLOG_INTERVALLE_DEFAUT);
      const dernier = parseInt(await conf('blog_dernier', '0'), 10) || 0;
      const reste = dernier + intervalle * 3600e3 - Date.now();
      if (reste > 0) return json({ fait: false, raison: 'pas encore l’heure', dans_minutes: Math.ceil(reste / 60e3) });

      await setConf('blog_dernier', String(Date.now()));

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
      if (!q.rows[0]) {                       
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
        
        r = { ok: false, erreur: String(e && e.message || e).slice(0, 200) };
      }
      await sqlite.execute({ sql: `UPDATE aco_queue SET statut = ? WHERE sujet = ?`,
                             args: [r.ok ? 'ecrit' : 'echec', sujet] });
      if (!r.ok) {
        await replier();
        await compte('blog_echecs');
        return json({ fait: false, sujet, erreur: r.erreur, retente_dans_minutes: BLOG_RETRI_MINUTES });
      }
      
      await setConf('blog_dernier_ok', String(Date.now()));
      await compte('blog_ecrits');
      return json({ fait: true, sujet, slug: r.slug, titre: r.titre, prochain_dans_h: intervalle });
    }

    async function promoTable() {
      await blogConfTable();
      
      try {
        await sqlite.execute(`ALTER TABLE aco_users ADD COLUMN promo_ok INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {}
    }
    
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

    if (path === '/promo/stop') {
      await promoTable();
      const email = String(url.searchParams.get('e') || '').trim().toLowerCase().slice(0, 160);
      const jeton = String(url.searchParams.get('t') || '');
      if (!email || !jeton) return json({ error: 'lien incomplet' }, 400);
      const attendu = await promoJeton(email);
      
      if (!safeEqual(jeton, attendu)) return json({ error: 'lien invalide' }, 403);
      await sqlite.execute({ sql: `UPDATE aco_users SET promo_ok = 0 WHERE email = ?`, args: [email] });
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Désinscription</title>'
        + '<body style="font:16px/1.6 system-ui;background:#121212;color:#F2F1EC;padding:40px">'
        + '<h1 style="font-size:1.3rem">C’est fait.</h1>'
        + '<p>Tu ne recevras plus d’offres de voyage d’Acolyte. Ton compte et tes voyages ne sont pas touchés.</p>',
        { status: 200, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
    }

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
          
          if ((await conf('promo_actif', '0')) !== '1')
            return json({ error: 'La lettre est désactivée. Active-la d’abord, en connaissance de cause.' }, 409);
          if (!mailReady(env))
            return json({ error: 'Les variables EMAILJS_* ne sont pas configurées.' }, 409);

          const sujet = String(b.sujet || '').trim().slice(0, 120);
          const message = String(b.message || '').trim().slice(0, 4000);
          if (sujet.length < 3 || message.length < 20)
            return json({ error: 'Il faut un objet et un message.' }, 400);

          const cibles = (await sqlite.execute(
            `SELECT email FROM aco_users WHERE promo_ok = 1 AND verified = 1 LIMIT 2000`
          )).rows || [];
          const liste = cibles.map(r => String(r.email ?? r[0]));

          if (!b.pour_de_vrai)
            return json({ simulation: true, destinataires: liste.length,
                          note: 'Rien n’a été envoyé. Rappelle avec pour_de_vrai:true pour expédier.' });

          let ok = 0, ko = 0;
          for (const email of liste) {
            
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

    if (path === '/admin/blog/auto') {
      const adm = env('ADMIN_EMAIL').trim().toLowerCase();
      const who = await sessionEmail(request);
      if (!adm || !who || !safeEqual(who, adm)) return json({ error: 'Accès refusé' }, 403);
      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (typeof b.actif !== 'undefined') await setConf('blog_auto', b.actif ? '1' : '0');
        if (b.intervalle) await setConf('blog_intervalle', String(Math.max(1, Math.min(168, parseInt(b.intervalle, 10) || BLOG_INTERVALLE_DEFAUT))));
        if (b.regarnir) await blogRegarnit();
        
        if (b.maintenant) await setConf('blog_dernier', '0');
      }
      await blogConfTable();
      const attente = await sqlite.execute(`SELECT COUNT(*) AS n FROM aco_queue WHERE statut = 'attente'`);
      const suivants = await sqlite.execute(`SELECT sujet FROM aco_queue WHERE statut = 'attente' ORDER BY ajoute_le ASC LIMIT 5`);
      const dernier = parseInt(await conf('blog_dernier', '0'), 10) || 0;
      const intervalle = parseInt(await conf('blog_intervalle', String(BLOG_INTERVALLE_DEFAUT)), 10) || BLOG_INTERVALLE_DEFAUT;
      
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

      const r = await blogRedige(sujet, categorie, String(b.ton || 'vivant'), 'brouillon');
      if (r.erreur) return json({ error: r.erreur }, r.code || 502);
      return json({ ok: true, slug: r.slug, titre: r.titre, sections: r.sections, image: r.image });
    }

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

    if (path === '/maildiag') {
      
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

    const newSession = async (email) => {
      const token = randomHex(32);
      await sqlite.execute({
        sql: 'INSERT INTO aco_sessions(token_h, email, expires_at) VALUES(?,?,?)',
        args: [await sha256(token), email, Date.now() + SESS_TTL],
      });
      
      try {
        await sqlite.execute({
          sql: `DELETE FROM aco_sessions WHERE email = ? AND token_h NOT IN (
                  SELECT token_h FROM aco_sessions WHERE email = ?
                  ORDER BY expires_at DESC LIMIT ?)`,
          args: [email, email, SESS_MAX],
        });
      } catch (e) {  }
      return token;
    };
    
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
      
      await sqlite.execute({
        sql: `INSERT INTO aco_users(email, pass_h, salt, verified, created_at) VALUES(?,?,?,0,?)
              ON CONFLICT(email) DO UPDATE SET pass_h=excluded.pass_h, salt=excluded.salt`,
        args: [email, await hashPass(pass, salt), salt, Date.now()],
      });
      const r = await issueCode(email);
      if (r.err) return json({ error: r.err }, r.status);
      return json({ ok: true, etape: 'verification' });
    }

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

    if (path === '/auth/forgot' && request.method === 'POST') {
      const email = cleanEmail((await request.json().catch(() => ({}))).email);
      if (!email) return json({ error: 'Adresse email invalide' }, 400);
      await db();
      const ex = await sqlite.execute({ sql: 'SELECT email FROM aco_users WHERE email = ?', args: [email] });
      
      if (ex.rows[0]) await issueCode(email);
      return json({ ok: true });
    }

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
      
      await sqlite.execute({ sql: 'DELETE FROM aco_sessions WHERE email = ?', args: [email] });
      await sqlite.execute({ sql: 'DELETE FROM aco_logins WHERE email = ?', args: [email] });
      purge();                       
      return json({ token: await newSession(email), email });
    }

    if (path === '/auth/logout' && request.method === 'POST') {
      const h = request.headers.get('Authorization') || '';
      const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      if (tok) {
        await db();
        await sqlite.execute({ sql: 'DELETE FROM aco_sessions WHERE token_h = ?', args: [await sha256(tok)] });
      }
      return json({ ok: true });
    }

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
        
        await sqlite.execute({
          sql: `INSERT INTO aco_trips(email, payload, updated_at) VALUES(?,?,?)
                ON CONFLICT(email) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
          args: [email, txt, now],
        });
        return json({ ok: true, updated_at: now });
      }
    }

    if (path === '/account' && request.method === 'DELETE') {
      const email = await sessionEmail(request);
      if (!email) return json({ error: 'Session expirée — reconnecte-toi' }, 401);
      
      for (const t of ['aco_trips', 'aco_sessions', 'aco_codes', 'aco_logins', 'aco_users', 'aco_scores', 'aco_ai']) {
        
        try { await sqlite.execute({ sql: `DELETE FROM ${t} WHERE email = ?`, args: [email] }); }
        catch (e) {}
      }
      return json({ ok: true });
    }

    if (path === '/game/score' && request.method === 'POST') {
      const email = await sessionEmail(request);
      if (!email) return json({ error: 'Connecte-toi pour enregistrer ton score' }, 401);
      const body = await request.json().catch(() => ({}));
      const score = Math.max(0, Math.min(1_000_000, parseInt(body.score, 10) || 0));
      const name = String(body.name || 'Voyageur').trim().slice(0, 20) || 'Voyageur';
      await sqlite.execute(`CREATE TABLE IF NOT EXISTS aco_scores(
        email TEXT PRIMARY KEY, name TEXT NOT NULL, score INTEGER NOT NULL, at INTEGER NOT NULL)`);
      
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

    if (path === '/admin/stats') {
      const admin = env('ADMIN_EMAIL').trim().toLowerCase();
      const email = await sessionEmail(request);
      
      if (!admin || !email || !safeEqual(email, admin)) return json({ error: 'Accès refusé' }, 403);

      const K = 5;                       
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

      const dest = new Map(), pays = new Map();
      const modes = { avion: 0, train: 0, voiture: 0, autre: 0 };
      const budget = { petit: 0, moyen: 0, confort: 0, eleve: 0, inconnu: 0 };
      const duree  = { weekend: 0, semaine: 0, deuxSemaines: 0, plus: 0, inconnu: 0 };
      const avecQui = { solo: 0, couple: 0, amis: 0, famille: 0, collegues: 0, inconnu: 0 };
      const sejour = { hotel: 0, appartement: 0, auberge: 0, luxe: 0, inconnu: 0 };
      const mois = new Array(12).fill(0);
      let voyagesTotal = 0, avecPlan = 0, actifs7j = 0, actifs30j = 0, multiBase = 0;

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
            
            const dep = String(pr.depart || '');
            const mm = dep.match(/^\d{4}-(\d{2})/);
            if (mm) { const i = +mm[1] - 1; if (i >= 0 && i < 12) mois[i]++; }
          } catch (e) {  }
        }
      } catch (e) {  }

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

      const assezDeMonde = voyagesTotal >= K;

      let jeu = [], joueurs = 0;
      try {
        const r = await sqlite.execute(`SELECT name, score FROM aco_scores ORDER BY score DESC LIMIT 10`);
        jeu = (r.rows || []).map(x => ({ name: String(x.name ?? x[0]).slice(0, 20), score: Number(x.score ?? x[1]) }));
        joueurs = await cnt(`SELECT COUNT(*) AS n FROM aco_scores`);
      } catch (e) {}

      let appareils = 0, iaHeure = 0, iaComptes = 0;
      try { appareils = await cnt(`SELECT COUNT(*) AS n FROM aco_sessions WHERE expires_at > ?`, [now]); } catch (e) {}
      try {
        iaHeure = await cnt(`SELECT COALESCE(SUM(n),0) AS n FROM aco_ai WHERE window_start > ?`, [now - 3600 * 1000]);
        iaComptes = await cnt(`SELECT COUNT(*) AS n FROM aco_ai WHERE window_start > ?`, [now - 3600 * 1000]);
      } catch (e) {}

      await statTable();
      const statDepuis = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const statRows = (await sqlite.execute({
        sql: `SELECT jour, cle, n FROM aco_stats WHERE jour >= ? ORDER BY jour DESC`,
        args: [statDepuis] })).rows || [];
      const jours = {}, totaux = {};
      for (const r of statRows) {
        const j = String(r.jour ?? r[0]), c = String(r.cle ?? r[1]), n = Number(r.n ?? r[2]) || 0;
        (jours[j] = jours[j] || {})[c] = n;
        totaux[c] = (totaux[c] || 0) + n;
      }
      const statPc = (a, b) => b ? Math.round((a / b) * 100) : null;
      const entonnoir = {
        arrivees: totaux.arrivee || 0,
        inscrits: totaux.inscription || 0,
        taux_inscription: statPc(totaux.inscription, totaux.arrivee),
        questions_au_bout: totaux.questions_finies || 0,
        questions_passees: totaux.questions_passees || 0,
        voyages_generes: totaux.voyage_genere || 0,
        taux_voyage: statPc(totaux.voyage_genere, totaux.inscription)
      };

      return json({
        jours, totaux, entonnoir,
        comptes,
        
        voyages: { total: voyagesTotal, avecPlan, actifs7j, actifs30j,
                   multiBase: assezDeMonde ? multiBase : null },
        courbe,
        destinations: D.vus,
        destinationsMasquees: D.masq,
        pays: P.vus,
        paysMasques: P.masq,
        
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

    if (path === '/gemini/models') {
      const g = await aiGuard(request);
      if (g.err) return json({ error: g.err }, g.status);
      if (!env('GEMINI_KEY')) return json({ error: 'GEMINI_KEY non configurée' }, 501);
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env('GEMINI_KEY')}&pageSize=100`);
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

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

    const target = url.searchParams.get('url');
    if (target) {
      
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
