/* ============================================================
   Acolyte — Panel admin (page autonome, hors application).

   La sécurité NE REPOSE PAS sur ce fichier : il se contente d'afficher ce
   que le serveur veut bien lui donner. C'est le backend qui vérifie que la
   session correspond à ADMIN_EMAIL, et qui ne renvoie QUE des nombres déjà
   agrégés. Deviner l'adresse de cette page ne donne donc accès à rien.

   Script externe (et non en ligne) : la CSP du site interdit les scripts
   en ligne — on ne l'affaiblit pas pour un panel d'administration.

   ── Règles de lecture des graphiques ────────────────────────
   · Une magnitude (« combien ») se lit sur UNE seule teinte : plus foncé
     = plus grand. On ne colore pas chaque barre différemment, ça ferait
     croire à des catégories qui n'existent pas.
   · Des catégories distinctes prennent les teintes s1…s5, dans un ordre
     FIXE : la même catégorie garde sa couleur d'un graphique à l'autre.
   · Chaque part colorée porte AUSSI son nom et son nombre. La couleur ne
     doit jamais être la seule information — daltonisme, impression noir
     et blanc, écran mal réglé.
   · Aucun graphique n'a deux axes verticaux : c'est la première cause de
     lecture faussée.
============================================================ */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var nb = function (n) { return (Number(n) || 0).toLocaleString('fr-FR'); };
  var pct = function (n, tot) { return tot > 0 ? Math.round((n / tot) * 100) : 0; };

  /* les teintes vivent dans le CSS : un seul endroit à changer, et le mode
     sombre les remplace tout seul */
  var SER = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
  /* « Non précisé » n'est pas une catégorie, c'est une absence de réponse :
     elle prend un gris neutre et ne consomme pas une teinte de série. */
  var GRIS = 'var(--muted)';
  /* Une teinte n'est JAMAIS recyclée : au-delà de 5 catégories réelles, les
     couleurs redeviendraient identiques et deux parts seraient
     indistinguables. On replie donc la queue dans « Autres ». */
  function teinte(x, i) { return x.absent ? GRIS : SER[i]; }
  function plafonne(items) {
    var vrais = items.filter(function (x) { return !x.absent; });
    var absents = items.filter(function (x) { return x.absent; });
    if (vrais.length > SER.length) {
      var gardes = vrais.slice(0, SER.length - 1);
      var reste = vrais.slice(SER.length - 1).reduce(function (s, x) { return s + x.n; }, 0);
      if (reste) gardes.push({ nom: 'Autres', n: reste, absent: true });
      vrais = gardes;
    }
    return vrais.concat(absents);
  }

  var _data = null, _tables = false;

  function show(kind, titre, texte) {
    var el = $('#state');
    el.className = 'msg' + (kind === 'err' ? ' err' : '');
    el.innerHTML = '<h2>' + esc(titre) + '</h2><p>' + esc(texte) + '</p>';
    el.classList.remove('hidden');
    $('#panel').classList.add('hidden');
  }

  function token() {
    try { return localStorage.getItem('acolite_token') || ''; } catch (e) { return ''; }
  }

  /* ---------- Tuile de chiffre ---------- */
  function kpi(k, v, d) {
    return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v">' + nb(v) + '</div>'
         + (d ? '<div class="d">' + esc(d) + '</div>' : '') + '</div>';
  }

  /* ---------- Barres horizontales, une seule teinte (magnitude) ----------
     Chaque ligne porte son nom, sa barre, son nombre et sa part : la barre
     donne la comparaison d'un coup d'œil, les chiffres donnent la précision. */
  function bars(items, opts) {
    opts = opts || {};
    if (!items.length) return '<p class="lede">Aucune donnée pour le moment.</p>';
    if (opts.cat) items = plafonne(items);
    var max = items.reduce(function (m, x) { return Math.max(m, x.n); }, 0);
    var tot = items.reduce(function (s, x) { return s + x.n; }, 0);
    return '<div class="rows">' + items.map(function (x, i) {
      var w = max > 0 ? Math.max(2, Math.round((x.n / max) * 100)) : 0;
      /* opts.cat = vraies catégories → teintes fixes ; sinon teinte unique */
      var col = opts.cat ? teinte(x, i) : 'var(--seq)';
      return '<div class="r">'
        + '<span class="lbl" title="' + esc(x.detail || x.nom) + '">' + esc(x.nom) + '</span>'
        + '<span class="track"><i style="width:' + w + '%;background:' + col + '"></i></span>'
        + '<span class="n">' + nb(x.n)
        + (opts.pct === false ? '' : ' <span class="pct">' + pct(x.n, tot) + '%</span>')
        + '</span></div>';
    }).join('') + '</div>';
  }

  /* ---------- Colonnes : inscriptions jour par jour ----------
     Une seule série, donc pas de légende : le titre suffit à la nommer.
     Bouts arrondis de 4px posés sur la ligne de base, comme sur le site. */
  function colonnes(courbe) {
    if (!courbe || !courbe.length) return '<p class="lede">Pas encore d’historique.</p>';
    var W = 640, H = 150, PB = 22, PL = 26;
    var max = courbe.reduce(function (m, x) { return Math.max(m, x.n); }, 0) || 1;
    var n = courbe.length;
    var bw = (W - PL) / n;
    var barW = Math.max(3, bw - 3);
    var plot = H - PB;
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Inscriptions par jour sur 30 jours">';
    /* repères horizontaux : discrets, ils aident sans attirer l'œil */
    [0, .5, 1].forEach(function (f) {
      var y = plot - f * (plot - 12);
      s += '<line x1="' + PL + '" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="var(--grid)" stroke-width="1"/>';
      s += '<text class="axis" x="' + (PL - 5) + '" y="' + (y + 3) + '" text-anchor="end">' + Math.round(f * max) + '</text>';
    });
    courbe.forEach(function (d, i) {
      var h = d.n > 0 ? Math.max(3, Math.round((d.n / max) * (plot - 12))) : 0;
      var x = PL + i * bw + (bw - barW) / 2;
      if (h > 0) {
        s += '<rect x="' + x + '" y="' + (plot - h) + '" width="' + barW + '" height="' + h
           + '" rx="3" fill="var(--seq)" stroke="var(--ink)" stroke-width="1.5"/>';
        /* valeur affichée seulement sur les jours non nuls et si ça tient :
           un nombre sur chaque colonne rendrait le graphique illisible */
        if (barW >= 11) s += '<text class="vlabel" x="' + (x + barW / 2) + '" y="' + (plot - h - 4) + '" text-anchor="middle">' + d.n + '</text>';
      }
      /* une date sur cinq : sinon les étiquettes se chevauchent */
      if (i % 5 === 0 || i === n - 1) {
        s += '<text class="axis" x="' + (x + barW / 2) + '" y="' + (H - 7) + '" text-anchor="middle">'
           + esc(d.j.slice(8) + '/' + d.j.slice(5, 7)) + '</text>';
      }
    });
    s += '<line x1="' + PL + '" y1="' + plot + '" x2="' + W + '" y2="' + plot + '" stroke="var(--ink)" stroke-width="2"/>';
    s += '</svg>';
    return s;
  }

  /* ---------- Anneau : répartition part-à-tout ----------
     Un écart de 2px entre les parts (comme sur le site : les aplats ne se
     touchent jamais), et une légende nommée+chiffrée en dessous. */
  function anneau(items, tot) {
    var W = 220, R = 88, r = 52, C = W / 2;
    if (!tot) return '<p class="lede">Aucune donnée pour le moment.</p>';
    items = plafonne(items);
    var a0 = -Math.PI / 2;
    var s = '<svg viewBox="0 0 ' + W + ' ' + W + '" role="img" aria-label="Répartition">';
    items.forEach(function (x, i) {
      if (!x.n) return;
      var frac = x.n / tot;
      var a1 = a0 + frac * Math.PI * 2;
      /* une part unique remplirait le cercle : l'arc SVG ne sait pas le
         faire, on dessine deux anneaux concentriques à la place */
      if (frac > 0.999) {
        s += '<circle cx="' + C + '" cy="' + C + '" r="' + ((R + r) / 2) + '" fill="none" stroke="' + teinte(x, i)
           + '" stroke-width="' + (R - r) + '"/>';
        s += '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="none" stroke="var(--ink)" stroke-width="2"/>';
        s += '<circle cx="' + C + '" cy="' + C + '" r="' + r + '" fill="none" stroke="var(--ink)" stroke-width="2"/>';
        a0 = a1; return;
      }
      var gap = 0.014;                        /* l'écart de 2px, en radians */
      var b0 = a0 + gap, b1 = a1 - gap;
      if (b1 <= b0) { a0 = a1; return; }
      var grand = (b1 - b0) > Math.PI ? 1 : 0;
      var p = function (ang, rad) { return [(C + Math.cos(ang) * rad).toFixed(2), (C + Math.sin(ang) * rad).toFixed(2)]; };
      var A = p(b0, R), B = p(b1, R), D = p(b1, r), E = p(b0, r);
      s += '<path d="M' + A + ' A' + R + ',' + R + ' 0 ' + grand + ' 1 ' + B
         + ' L' + D + ' A' + r + ',' + r + ' 0 ' + grand + ' 0 ' + E + ' Z"'
         + ' fill="' + teinte(x, i) + '" stroke="var(--ink)" stroke-width="2"/>';
      a0 = a1;
    });
    s += '<text x="' + C + '" y="' + (C - 2) + '" text-anchor="middle" font-size="26" font-weight="900" fill="var(--ink)">' + nb(tot) + '</text>';
    s += '<text x="' + C + '" y="' + (C + 16) + '" text-anchor="middle" font-size="9" font-weight="800" fill="var(--muted)">TOTAL</text>';
    s += '</svg>';
    var leg = '<div class="legend">' + items.filter(function (x) { return x.n; }).map(function (x, i) {
      return '<span><i class="swatch" style="background:' + teinte(x, i) + '"></i>'
           + esc(x.nom) + ' — ' + nb(x.n) + ' (' + pct(x.n, tot) + '%)</span>';
    }).join('') + '</div>';
    return '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center">'
         + '<div style="flex:0 0 200px;max-width:200px">' + s + '</div>'
         + '<div style="flex:1;min-width:180px">' + leg + '</div></div>';
  }

  /* ---------- Entonnoir : ce que devient un visiteur inscrit ----------
     Chaque étage est un sous-ensemble du précédent, donc une seule teinte
     avec des largeurs décroissantes — pas des catégories. */
  function entonnoir(etapes) {
    var max = etapes[0] ? etapes[0].n : 0;
    if (!max) return '<p class="lede">Aucun compte pour le moment.</p>';
    return '<div class="rows">' + etapes.map(function (e, i) {
      var w = Math.max(2, Math.round((e.n / max) * 100));
      var perte = i > 0 && etapes[i - 1].n > 0 ? pct(e.n, etapes[i - 1].n) : 100;
      return '<div class="r">'
        + '<span class="lbl">' + esc(e.nom) + '</span>'
        + '<span class="track" style="height:18px"><i style="width:' + w + '%;background:var(--seq)"></i></span>'
        + '<span class="n">' + nb(e.n)
        + '<span class="pct"> ' + (i === 0 ? '100%' : perte + '% de l’étape avant') + '</span></span></div>';
    }).join('') + '</div>';
  }

  /* ---------- Vue tableau : même chiffres, autre forme ----------
     Obligatoire : un lecteur d'écran, une impression noir et blanc ou un
     contraste insuffisant doivent tous rester exploitables. */
  function tableau(titre, items, opts) {
    opts = opts || {};
    /* Un entonnoir n'est PAS une part-à-tout : ses étages s'emboîtent, donc
       additionner 148 comptes + 121 vérifiés + 96 voyages ne veut rien dire.
       Pour lui, la part se calcule sur le PREMIER étage. */
    var base = opts.imbrique
      ? (items[0] ? items[0].n : 0)
      : items.reduce(function (s, x) { return s + x.n; }, 0);
    var tot = base;
    return '<div class="card"><h2>' + esc(titre) + '</h2>'
      + (opts.imbrique ? '<p class="lede">Part calculée sur le premier étage : chaque ligne est un sous-ensemble du total.</p>' : '')
      + '<div class="scroll"><table>'
      + '<thead><tr><th>Catégorie</th><th class="num">Nombre</th><th class="num">Part</th></tr></thead><tbody>'
      + items.map(function (x) {
          /* en tableau, on écrit le libellé COMPLET : il n'y a plus de
             contrainte de largeur, autant donner le détail */
          return '<tr><td>' + esc(x.detail && x.detail !== x.nom ? x.nom + ' — ' + x.detail : x.nom)
               + '</td><td class="num">' + nb(x.n)
               + '</td><td class="num">' + pct(x.n, tot) + '%</td></tr>';
        }).join('')
      + '</tbody></table></div></div>';
  }

  /* Transforme un objet { cle: nombre } en liste nommée.
     Les libellés sont COURTS : dans une colonne étroite, un nom long est
     coupé par des points de suspension et devient illisible. Le détail
     complet part dans l'infobulle et dans le chapeau de la carte.
     « absent: true » marque une absence de réponse : gris, pas une teinte. */
  function liste(obj, noms) {
    if (!obj) return [];
    return Object.keys(noms).map(function (k) {
      var d = noms[k];
      return { nom: d.nom, detail: d.detail || d.nom, n: Number(obj[k]) || 0, absent: !!d.absent };
    }).filter(function (x) { return x.n > 0; });
  }
  var ABSENT = { nom: 'Non précisé', detail: 'Le voyageur n’a pas répondu', absent: true };

  var N_TRANSPORT = {
    avion: { nom: '✈️ Avion' }, train: { nom: '🚆 Train' },
    voiture: { nom: '🚗 Voiture' }, autre: { nom: '❓ Autre', absent: true }
  };
  var N_BUDGET = {
    petit:   { nom: '🪙 Petit',   detail: 'Moins de 500 € par personne' },
    moyen:   { nom: '💶 Moyen',   detail: '500 à 1 200 € par personne' },
    confort: { nom: '💳 Confort', detail: '1 200 à 2 500 € par personne' },
    eleve:   { nom: '💎 Élevé',   detail: 'Plus de 2 500 € par personne' },
    inconnu: ABSENT
  };
  var N_DUREE = {
    weekend:      { nom: '🌤️ Week-end',  detail: '2 à 3 jours' },
    semaine:      { nom: '🗓️ 1 semaine', detail: 'Environ 7 jours' },
    deuxSemaines: { nom: '🗓️ 2 semaines', detail: 'Environ 14 jours' },
    plus:         { nom: '🌍 3 sem. +',   detail: '3 semaines ou plus' },
    inconnu: ABSENT
  };
  var N_QUI = {
    solo:      { nom: '🧍 Solo' },
    couple:    { nom: '💞 En couple' },
    amis:      { nom: '👯 Entre amis' },
    famille:   { nom: '👨‍👩‍👧 En famille' },
    collegues: { nom: '💼 Collègues' },
    inconnu: ABSENT
  };
  var N_SEJOUR = {
    hotel:       { nom: '🏨 Hôtel' },
    appartement: { nom: '🏠 Appart.', detail: 'Appartement ou Airbnb' },
    auberge:     { nom: '🎒 Auberge', detail: 'Auberge de jeunesse ou éco' },
    luxe:        { nom: '✨ Luxe',    detail: 'Séjour de luxe' },
    inconnu: ABSENT
  };
  var MOIS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

  function render(d) {
    _data = d;
    var c = d.comptes || {}, v = d.voyages || {}, tech = d.technique || {};
    var html = '';

    /* ---- La ligne de chiffres qui répond à « où on en est ? » ---- */
    html += '<div class="kpis">'
      + kpi('Comptes', c.total, nb(c.verifies) + ' vérifiés (' + pct(c.verifies, c.total) + '%)')
      + kpi('Nouveaux · 7 j', c.nouveaux7j, nb(c.nouveaux30j) + ' sur 30 jours')
      + kpi('Voyages', v.total, nb(v.avecPlan) + ' avec un plan complet')
      + kpi('Actifs · 7 j', v.actifs7j, nb(v.actifs30j) + ' sur 30 jours')
      + kpi('Appareils connectés', tech.appareils, 'sessions valables')
      + kpi('Demandes IA · 1 h', tech.iaHeure, nb(tech.iaComptes) + ' compte(s) concerné(s)')
      + '</div>';

    if (_tables) {
      /* ---- Vue tableau ---- */
      html += tableau('🎯 Parcours', [
        { nom: 'Comptes créés', n: c.total || 0 },
        { nom: 'Adresses vérifiées', n: c.verifies || 0 },
        { nom: 'Voyages démarrés', n: v.total || 0 },
        { nom: 'Plans complets', n: v.avecPlan || 0 }
      ], { imbrique: true });
      if (d.courbe && d.courbe.length) {
        html += tableau('📈 Inscriptions par jour (30 j)', d.courbe.map(function (x) {
          return { nom: x.j, n: x.n };
        }).filter(function (x) { return x.n > 0; }));
      }
      if (d.destinations && d.destinations.length) html += tableau('🌍 Villes', d.destinations);
      if (d.pays && d.pays.length) html += tableau('🗺️ Pays', d.pays);
      if (d.transports) html += tableau('🚆 Transports', liste(d.transports, N_TRANSPORT));
      if (d.budget) html += tableau('💶 Budgets', liste(d.budget, N_BUDGET));
      if (d.duree) html += tableau('⏱️ Durées', liste(d.duree, N_DUREE));
      if (d.avecQui) html += tableau('👥 Compagnie', liste(d.avecQui, N_QUI));
      if (d.sejour) html += tableau('🛏️ Hébergement', liste(d.sejour, N_SEJOUR));
      if (d.mois) {
        html += tableau('📅 Mois de départ', d.mois.map(function (n, i) {
          return { nom: MOIS[i], n: n };
        }).filter(function (x) { return x.n > 0; }));
      }
    } else {
      /* ---- Vue graphiques ---- */
      html += '<div class="card wide"><h2>📈 Inscriptions par jour</h2>'
        + '<p class="lede">Sur les 30 derniers jours. Un creux le week-end est normal.</p>'
        + colonnes(d.courbe) + '</div>';

      html += '<div class="cols">';

      html += '<div class="card"><h2>🎯 Parcours</h2>'
        + '<p class="lede">Ce que devient un compte créé. Chaque étage est un sous-ensemble du précédent — c’est là qu’on voit où ça décroche.</p>'
        + entonnoir([
            { nom: 'Comptes créés', n: c.total || 0 },
            { nom: 'Adresse vérifiée', n: c.verifies || 0 },
            { nom: 'Voyage démarré', n: v.total || 0 },
            { nom: 'Plan complet', n: v.avecPlan || 0 }
          ])
        + '</div>';

      if (d.transports) {
        var tr = liste(d.transports, N_TRANSPORT);
        html += '<div class="card"><h2>🚆 Transports retenus</h2>'
          + '<p class="lede">Le mode que le plan a choisi, tous voyages confondus.</p>'
          + anneau(tr, tr.reduce(function (s, x) { return s + x.n; }, 0)) + '</div>';
      }

      if (d.destinations && d.destinations.length) {
        html += '<div class="card"><h2>🌍 Villes les plus choisies</h2>'
          + '<p class="lede">Seules celles qui atteignent le seuil d’anonymat.</p>'
          + bars(d.destinations) + seuilNote(d, d.destinationsMasquees) + '</div>';
      }
      if (d.pays && d.pays.length) {
        html += '<div class="card"><h2>🗺️ Pays les plus choisis</h2>'
          + '<p class="lede">Plus large qu’une ville, donc visible plus tôt.</p>'
          + bars(d.pays) + seuilNote(d, d.paysMasques) + '</div>';
      }

      if (d.budget) {
        html += '<div class="card"><h2>💶 Budgets demandés</h2>'
          + '<p class="lede">Une échelle ordonnée du plus petit au plus grand : une seule teinte, la longueur porte l’information.</p>'
          + bars(liste(d.budget, N_BUDGET)) + '</div>';
      }
      if (d.duree) {
        html += '<div class="card"><h2>⏱️ Durées demandées</h2>'
          + '<p class="lede">Combien de temps les voyageurs veulent partir.</p>'
          + bars(liste(d.duree, N_DUREE)) + '</div>';
      }
      if (d.avecQui) {
        var q = liste(d.avecQui, N_QUI);
        html += '<div class="card"><h2>👥 Avec qui</h2>'
          + '<p class="lede">Des catégories distinctes : chacune garde sa couleur, et porte son nom.</p>'
          + anneau(q, q.reduce(function (s, x) { return s + x.n; }, 0)) + '</div>';
      }
      if (d.sejour) {
        html += '<div class="card"><h2>🛏️ Type d’hébergement</h2>'
          + '<p class="lede">Le style demandé au questionnaire.</p>'
          + bars(liste(d.sejour, N_SEJOUR)) + '</div>';
      }
      if (d.mois) {
        var m = d.mois.map(function (n, i) { return { nom: MOIS[i], n: n }; });
        html += '<div class="card wide"><h2>📅 Mois de départ</h2>'
          + '<p class="lede">La saisonnalité des départs. Seul le mois est connu — jamais la date exacte d’un voyageur.</p>'
          + bars(m.filter(function (x) { return x.n > 0; }), { pct: false }) + '</div>';
      }

      /* même garde-fou que les autres répartitions : le serveur renvoie null
         quand l'échantillon est trop petit */
      if (d.assezDeMonde && v.multiBase) {
        html += '<div class="card"><h2>🧭 Voyages itinérants</h2>'
          + '<p class="lede">Ceux qui passent par plusieurs villes-étapes.</p>'
          + bars([
              { nom: 'Itinérants', n: v.multiBase },
              { nom: 'Une seule base', n: Math.max(0, (v.total || 0) - v.multiBase) }
            ], { cat: true }) + '</div>';
      }

      if (d.jeu && d.jeu.length) {
        html += '<div class="card"><h2>🏆 Classement du jeu</h2>'
          + '<p class="lede">' + nb(d.joueurs) + ' joueur(s) classé(s). Ces pseudos sont <strong>déjà publics</strong> : '
          + 'le classement s’affiche à tous les joueurs dans l’application. Rien de nouveau n’est révélé ici.</p>'
          + bars(d.jeu.map(function (s, i) {
              return { nom: (i + 1) + '. ' + s.name, n: s.score };
            }), { pct: false }) + '</div>';
      }

      html += '</div>';   /* .cols */
    }

    if (!d.assezDeMonde) {
      html += '<div class="card wide"><h2>🔒 Répartitions masquées</h2><div class="lock">'
        + 'Il y a moins de ' + (d.seuil || 5) + ' voyages enregistrés. Les répartitions (transport, budget, durée, '
        + 'compagnie, hébergement, saison) ne sont <strong>pas affichées</strong> : sur un si petit nombre, '
        + '« 1 voyage en train » suffirait à savoir ce qu’une personne précise a choisi. '
        + 'Elles apparaîtront d’elles-mêmes dès que la base sera assez large.</div></div>';
    }

    html += '<div class="card wide"><h2>🔒 Ce que cette page ne peut pas voir</h2><p class="note">'
      + 'Le serveur ne renvoie ici <strong>que des nombres déjà additionnés</strong>. Aucune adresse email, '
      + 'aucun contenu de voyage, aucune note personnelle, aucune date de départ précise ne transite par cette page — '
      + 'même avec cette session d’administrateur, ces données restent inaccessibles. '
      + 'Un lieu compté moins de ' + (d.seuil || 5) + ' fois n’est jamais nommé, et les répartitions se taisent '
      + 'tant que la base est trop petite pour qu’un chiffre puisse désigner quelqu’un.'
      + '</p></div>';

    $('#panel').innerHTML = html;
    $('#panel').classList.remove('hidden');
    $('#state').classList.add('hidden');
    $('#stamp').textContent = 'Généré le ' + new Date(d.genere || Date.now()).toLocaleString('fr-FR');
    $('#tables').textContent = _tables ? '📊 Graphiques' : '🔢 Tableaux';
  }

  function seuilNote(d, masq) {
    var s = '<p class="note">🔒 Un lieu comptant moins de ' + (d.seuil || 5)
          + ' voyages n’est jamais nommé : avec peu d’utilisateurs, il désignerait quelqu’un.';
    if (masq && masq.lieux) {
      s += '<br>' + nb(masq.lieux) + ' lieu(x) masqué(s), soit ' + nb(masq.voyages) + ' voyage(s).';
    }
    return s + '</p>';
  }

  function load() {
    var base = ((window.ACOLITE_KEYS && window.ACOLITE_KEYS.proxy) || '').replace(/\/+$/, '');
    if (!base) { show('err', 'Serveur non configuré', "L'adresse du serveur est absente de config.js."); return; }
    var tok = token();
    if (!tok) { show('err', 'Accès refusé', "Connecte-toi d'abord sur Acolyte avec le compte administrateur, puis reviens sur cette page."); return; }

    show('', 'Chargement…', 'Récupération des statistiques.');
    fetch(base + '/admin/stats', { headers: { Authorization: 'Bearer ' + tok } })
      .then(function (r) {
        if (r.status === 403) { show('err', 'Accès refusé', "Ce compte n'est pas administrateur."); return null; }
        if (r.status === 404) { show('err', 'Serveur non à jour', 'La route /admin/stats est absente : recolle valtown-backend.js dans Val Town.'); return null; }
        if (!r.ok) { show('err', 'Erreur', 'Le serveur a répondu ' + r.status + '.'); return null; }
        return r.json();
      })
      .then(function (d) { if (d) render(d); })
      .catch(function () { show('err', 'Serveur injoignable', 'Vérifie ta connexion.'); });
  }

  $('#refresh').onclick = load;
  /* bascule graphiques ↔ tableaux : on ne recharge pas le serveur pour ça */
  $('#tables').onclick = function () { _tables = !_tables; if (_data) render(_data); };
  load();
})();
