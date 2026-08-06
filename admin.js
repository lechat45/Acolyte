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
  /* ⚠️ kpi() passe sa valeur par nb(), qui force un Number : « 78 % » devenait
     donc 0, et le taux le plus important du panneau s'affichait à zéro. Cette
     variante laisse la valeur telle quelle — pour les pourcentages et tout ce
     qui porte une unité. */
  function kpiTxt(k, v, d) {
    return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v)) + '</div>'
         + (d ? '<div class="d">' + esc(d) + '</div>' : '') + '</div>';
  }
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

  /* ---------- Courbes d'utilisation : une ligne par événement ----------
     La question à laquelle ce graphique répond : « qu'est-ce qui est utilisé,
     et est-ce que ça monte ou ça descend ? » Les colonnes ci-dessus montrent
     UNE série ; ici il en faut plusieurs superposées, sinon on ne peut pas
     comparer les arrivées aux voyages générés.

     ⚠️ Aucune bibliothèque. Un graphique en courbes, c'est une polyligne et
     deux axes : une dépendance de 300 Ko pour ça ne se justifie pas, et la CSP
     du panneau n'autorise de toute façon pas de script externe.

     ⚠️ Les jours SANS aucune donnée doivent quand même exister sur l'axe,
     sinon deux jours d'écart et un jour d'écart se ressemblent, et la courbe
     ment sur le rythme. On reconstruit donc la suite complète des dates. */
  var SERIES = [
    { cle: 'arrivee',           nom: 'Arrivées',        c: 'var(--s1)' },
    { cle: 'inscription',       nom: 'Inscriptions',    c: 'var(--s2)' },
    { cle: 'questions_finies',  nom: 'Questions finies',c: 'var(--s3)' },
    { cle: 'voyage_genere',     nom: 'Voyages générés', c: 'var(--s4)' },
    { cle: 'assistant_utilise', nom: 'Assistant',       c: 'var(--s5)' },
    { cle: 'blog_ouvert',       nom: 'Blog',            c: 'var(--s6)' }
  ];
  /* Ces événements ne méritent pas une courbe — ils sont rares ou binaires, et
     six lignes suffisent déjà à saturer un graphique. Mais leur TOTAL répond à
     des questions précises, alors ils vont dans un tableau à côté. */
  var APART = [
    { cle: 'questionnaire_commence', nom: 'Questionnaires commencés' },
    { cle: 'questions_passees',      nom: 'Questions passées' },
    { cle: 'assistant_annule',       nom: 'Propositions de l’IA refusées' },
    { cle: 'ia_echec',               nom: 'Pannes de l’IA' },
    { cle: 'horaires_verifies',      nom: 'Vérifications d’horaires' },
    { cle: 'reservation_clic',       nom: 'Départs vers un partenaire' },
    { cle: 'hors_ligne',             nom: 'Ouvertures hors ligne' },
    { cle: 'jour_j',                 nom: 'Mode Jour J' },
    { cle: 'papiers_ouvert',         nom: 'Onglet Papiers' },
    { cle: 'carte_ouverte',          nom: 'Carte' },
    { cle: 'install',                nom: 'Installations' }
  ];
  function joursSuite(jours) {
    var cles = Object.keys(jours || {}).sort();
    if (!cles.length) return [];
    var d = new Date(cles[0] + 'T00:00:00Z'), fin = new Date(cles[cles.length - 1] + 'T00:00:00Z');
    var out = [], garde = 0;
    while (d <= fin && garde++ < 400) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }
  /* Le tableau des événements secondaires, avec deux TAUX calculés — c'est eux
     qui portent l'information, pas les totaux bruts :
       · abandon du questionnaire = commencés qui n'ont pas produit de voyage ;
       · rejet de l'IA = propositions annulées sur propositions faites.
     Un total seul ne dit pas si 40 refus sur 1000 est bon ou catastrophique. */
  function apartHTML(totaux) {
    var t = totaux || {};
    var lignes = APART.filter(function (a) { return t[a.cle]; })
      .map(function (a) { return { nom: a.nom, n: t[a.cle] }; });
    var out = '';
    var com = t.questionnaire_commence || 0, gen = t.voyage_genere || 0;
    var uti = t.assistant_utilise || 0, ann = t.assistant_annule || 0;
    if (com || uti) {
      out += '<div class="kpis">';
      if (com) out += kpiTxt('Abandon du questionnaire',
        (com > gen ? Math.round(((com - gen) / com) * 100) : 0) + ' %',
        nb(com) + ' commencé(s) · ' + nb(gen) + ' abouti(s)');
      if (uti) out += kpiTxt('Rejet des propositions IA',
        Math.round((ann / uti) * 100) + ' %',
        nb(ann) + ' annulée(s) sur ' + nb(uti));
      if (t.ia_echec) out += kpi('Pannes de l’IA', nb(t.ia_echec), 'sur la période');
      out += '</div>';
    }
    if (!lignes.length) return out + '<p class="lede">Aucun de ces événements n’a encore été enregistré.</p>';
    return out + tableau('🔎 Le détail', lignes);
  }

  function courbes(jours) {
    var dates = joursSuite(jours);
    if (dates.length < 2) return '<p class="lede">Il faut au moins deux jours de mesure pour tracer une courbe.</p>';
    /* on ne garde que les séries réellement présentes : une légende de six
       entrées dont quatre à zéro n'apprend rien */
    var actives = SERIES.filter(function (se) {
      return dates.some(function (j) { return (jours[j] || {})[se.cle]; });
    });
    if (!actives.length) return '<p class="lede">Aucune utilisation enregistrée sur la période.</p>';
    var W = 640, H = 220, PB = 26, PL = 34, PT = 10;
    var max = 1;
    actives.forEach(function (se) {
      dates.forEach(function (j) { max = Math.max(max, (jours[j] || {})[se.cle] || 0); });
    });
    var plot = H - PB, hauteur = plot - PT;
    var x = function (i) { return PL + (i * (W - PL - 6)) / (dates.length - 1); };
    var y = function (v) { return plot - (v / max) * hauteur; };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Utilisation par jour, une courbe par événement">';
    [0, .5, 1].forEach(function (f) {
      var yy = y(f * max);
      s += '<line x1="' + PL + '" y1="' + yy + '" x2="' + W + '" y2="' + yy + '" stroke="var(--grid)" stroke-width="1"/>';
      s += '<text class="axis" x="' + (PL - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' + Math.round(f * max) + '</text>';
    });
    actives.forEach(function (se) {
      var pts = dates.map(function (j, i) { return x(i).toFixed(1) + ',' + y((jours[j] || {})[se.cle] || 0).toFixed(1); }).join(' ');
      s += '<polyline points="' + pts + '" fill="none" stroke="' + se.c + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
      /* un point par jour SEULEMENT si la place le permet : au-delà, les
         disques se touchent et la courbe devient une chenille */
      if (dates.length <= 32) {
        dates.forEach(function (j, i) {
          var v = (jours[j] || {})[se.cle] || 0;
          if (v) s += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.6" fill="' + se.c + '"/>';
        });
      }
    });
    dates.forEach(function (j, i) {
      if (i % Math.ceil(dates.length / 6) === 0 || i === dates.length - 1) {
        s += '<text class="axis" x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">'
           + esc(j.slice(8) + '/' + j.slice(5, 7)) + '</text>';
      }
    });
    s += '<line x1="' + PL + '" y1="' + plot + '" x2="' + W + '" y2="' + plot + '" stroke="var(--ink)" stroke-width="2"/>';
    s += '</svg>';
    /* La légende est INDISPENSABLE : six courbes sans noms sont un décor.
       Nom ET total, pour qu'on sache laquelle compte. */
    s += '<div class="lg">' + actives.map(function (se) {
      var tot = dates.reduce(function (a, j) { return a + ((jours[j] || {})[se.cle] || 0); }, 0);
      return '<span class="lg-i"><i style="background:' + se.c + '"></i>' + esc(se.nom)
           + ' <b>' + tot + '</b></span>';
    }).join('') + '</div>';
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

      /* Les courbes d'utilisation. Placées juste après les inscriptions parce
         qu'elles répondent à la question suivante : ceux qui arrivent,
         qu'est-ce qu'ils font ? */
      html += '<div class="card wide"><h2>📉 Utilisation par jour</h2>'
        + '<p class="lede">Une courbe par événement, sur 60 jours. Compare les arrivées aux voyages réellement générés : l’écart entre les deux, c’est ce qu’il reste à gagner.</p>'
        + courbes(d.jours) + '</div>';

      html += '<div class="card wide"><h2>🔎 Ce qui est utilisé, et ce qui bloque</h2>'
        + '<p class="lede">Les taux d’abandon et de rejet sont calculés : un total seul ne dit pas si 40 refus sur 1000 est bon ou catastrophique.</p>'
        + apartHTML(d.totaux) + '</div>';

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

    html += blogPanelHTML();
    html += promoPanelHTML();
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
    /* le panneau est réécrit à chaque rendu : on rebranche ses boutons */
    brancheBlog();
  }

  function seuilNote(d, masq) {
    var s = '<p class="note">🔒 Un lieu comptant moins de ' + (d.seuil || 5)
          + ' voyages n’est jamais nommé : avec peu d’utilisateurs, il désignerait quelqu’un.';
    if (masq && masq.lieux) {
      s += '<br>' + nb(masq.lieux) + ' lieu(x) masqué(s), soit ' + nb(masq.voyages) + ' voyage(s).';
    }
    return s + '</p>';
  }


  /* ============================================================
     GÉNÉRATEUR D'ARTICLES — le pilotage vit ICI, dans le panel admin
     ------------------------------------------------------------
     Le générateur d'origine avait sa propre application React. Elle a été
     retirée : garder deux interfaces pour la même chose, c'est deux
     interfaces à maintenir. Le pilotage est donc dans le panel, où sont déjà
     les autres commandes réservées à l'administrateur.
     Le serveur fait tout le travail (rédaction, image, stockage) : ici on ne
     fait qu'envoyer une demande et afficher le résultat.
  ============================================================ */
  var BLOG_CATS = { nature:'Merveille naturelle', bati:'Merveille bâtie', ville:'Grande ville' };
  var _posts = null;

  /* ============================================================
     LETTRE AUX CLIENTS — LIVRÉE DÉSACTIVÉE
     ------------------------------------------------------------
     ⚠️ Ce panneau ne fait qu'AFFICHER l'état. Les vrais verrous sont dans
     valtown-backend.js : l'interrupteur, le consentement et le lien de retrait
     y sont vérifiés à chaque appel. Griser un bouton ici ne protégerait rien —
     n'importe qui pourrait appeler la route à la main.
     Le bouton d'envoi commence par une SIMULATION : il dit combien de personnes
     seraient touchées, sans rien expédier.
  ============================================================ */
  function promoPanelHTML() {
    return '<div class="card wide" id="promoPanel">'
      + '<h2>✉️ Lettre aux clients</h2>'
      + '<p class="lede">Écrire une fois à tous ceux qui l’ont accepté — une offre de voyage, '
      + 'une nouveauté. <strong>Livré désactivé, et volontairement.</strong></p>'
      + '<div class="bg-auto" id="promoEtat">'
      +   '<div class="ba-etat"><span class="ba-pastille off" id="prPast">Désactivé</span>'
      +     '<span class="ba-txt" id="prTxt">Lecture de l’état…</span></div>'
      +   '<div class="ba-cmd">'
      +     '<button id="prToggle">▶ Activer</button>'
      +     '<button id="prTest">🧪 Simuler (n’envoie rien)</button>'
      +   '</div>'
      + '</div>'
      + '<div class="pr-form">'
      +   '<label for="prSujet">Objet</label>'
      +   '<input id="prSujet" maxlength="120" placeholder="Ex : trois idées de voyage pour septembre">'
      +   '<label for="prMsg">Message</label>'
      +   '<textarea id="prMsg" rows="6" maxlength="4000" placeholder="Écris comme à quelqu’un, pas comme à une liste."></textarea>'
      +   '<button id="prSend" class="pr-danger">✉️ Envoyer pour de vrai</button>'
      +   '<p class="bg-etat" id="prMsgEtat"></p>'
      + '</div>'
      + '<p class="note"><strong>Ce que le serveur impose, quoi qu’on fasse ici :</strong> '
      + 'personne n’est inscrit d’office — le consentement vaut 0 pour tout le monde à la livraison, '
      + 'donc la première simulation annoncera <strong>0 destinataire</strong>, et c’est normal. '
      + 'Un lien de désinscription est ajouté par le code à chaque message, impossible à oublier ; '
      + 'il est signé et ne demande pas de se connecter. '
      + 'Tant que l’interrupteur est sur « Désactivé », la route d’envoi refuse, même avec cette session.</p>'
      + '</div>';
  }

  var _promo = null;
  function promoPeint() {
    var p = $('#prPast'), t = $('#prTxt'), tg = $('#prToggle'), send = $('#prSend');
    if (!p || !_promo) return;
    var on = !!_promo.actif;
    p.textContent = on ? 'Activé' : 'Désactivé';
    p.className = 'ba-pastille' + (on ? ' on' : ' off');
    var phrase = on
      ? 'Active. ' + _promo.consentants + ' client(s) sur ' + _promo.clients_verifies + ' ont accepté de recevoir des offres.'
      : 'Désactivée : la route d’envoi refuse, même depuis cette page. '
        + _promo.consentants + ' client(s) sur ' + _promo.clients_verifies + ' ont accepté.';
    if (!_promo.mail_pret) phrase += ' ⚠️ Les variables EMAILJS_* ne sont pas configurées : rien ne partirait.';
    if (_promo.consentants === 0) phrase += ' Aucun destinataire pour l’instant — personne n’est inscrit d’office.';
    t.textContent = phrase;
    if (tg) tg.textContent = on ? '⏸ Désactiver' : '▶ Activer';
    /* le bouton rouge ne s'allume que si TOUT est réuni */
    if (send) send.disabled = !(on && _promo.mail_pret && _promo.consentants > 0);
  }
  function promoCharge(corps) {
    return srv('/admin/promo', corps ? { method:'POST', body: JSON.stringify(corps) } : {})
      .then(function (r) {
        if (r.status === 404) { prEtat('Serveur non à jour : recolle valtown-backend.js dans Val Town.', true); return null; }
        if (!r.ok) { prEtat(r.data && r.data.error ? r.data.error : 'Lecture impossible.', true); return null; }
        if (typeof r.data.actif !== 'undefined') { _promo = r.data; promoPeint(); }
        return r.data;
      })
      .catch(function () { prEtat('Serveur non à jour : recolle valtown-backend.js dans Val Town.', true); return null; });
  }
  function prEtat(txt, err) {
    var e = $('#prMsgEtat'); if (!e) return;
    e.textContent = txt || '';
    e.className = 'bg-etat' + (err ? ' err' : '');
  }

  function blogPanelHTML() {
    return '<div class="card wide" id="blogPanel">'
      + '<h2>📰 Générateur d’articles</h2>'
      + '<p class="lede">Un sujet, et Acolyte rédige l’article : histoire, géographie, faits chiffrés, '
      + 'conseils. L’illustration vient de Wikipédia. L’article est enregistré en <strong>brouillon</strong> — '
      + 'il n’apparaît dans l’onglet Blog qu’une fois publié.</p>'
      + '<div class="bg-auto" id="bgAuto">'
      +   '<div class="ba-etat"><span class="ba-pastille" id="baPast">…</span>'
      +     '<span class="ba-txt" id="baTxt">Lecture de l’état…</span></div>'
      +   '<div class="ba-cmd">'
      +     '<label>Un article toutes les<select id="baInt">'
      +       '<option value="1">1 h — un par heure</option>'
      +       '<option value="2">2 h</option>'
      +       '<option value="3">3 h</option><option value="6">6 h</option>'
      +       '<option value="12">12 h</option><option value="24">24 h</option>'
      +       '<option value="72">3 jours</option><option value="168">7 jours</option>'
      +     '</select></label>'
      +     '<button id="baToggle">⏸ Mettre en pause</button>'
      +     '<button id="baNow">⚡ Écrire maintenant</button>'
      +     '<button id="baFill">↻ Regarnir la file</button>'
      +   '</div>'
      + '</div>'
      + '<div class="bg-form">'
      +   '<label>Sujet<input type="text" id="bgSujet" placeholder="ex : Mont Fuji, Lisbonne, Grand Canyon" maxlength="80"></label>'
      +   '<label>Catégorie<select id="bgCat">'
      +     '<option value="nature">Merveille naturelle</option>'
      +     '<option value="bati">Merveille bâtie</option>'
      +     '<option value="ville">Grande ville</option>'
      +   '</select></label>'
      +   '<label>Ton<select id="bgTon">'
      +     '<option value="vivant">Vivant</option>'
      +     '<option value="sobre">Sobre</option>'
      +     '<option value="poetique">Poétique</option>'
      +     '<option value="concis">Concis</option>'
      +   '</select></label>'
      +   '<button id="bgGo">✍️ Rédiger</button>'
      + '</div>'
      + '<p class="bg-etat" id="bgEtat"></p>'
      + '<div class="scroll"><table id="bgTable"><thead><tr>'
      +   '<th>Article</th><th>Catégorie</th><th>État</th><th class="num">Actions</th>'
      + '</tr></thead><tbody id="bgRows"></tbody></table></div>'
      + '</div>';
  }

  function bgEtat(msg, err) {
    var el = $('#bgEtat');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'bg-etat' + (err ? ' err' : '');
  }

  function renderPosts() {
    var tb = $('#bgRows');
    if (!tb) return;
    if (!_posts || !_posts.length) {
      tb.innerHTML = '<tr><td colspan="4">Aucun article pour le moment.</td></tr>';
      return;
    }
    tb.innerHTML = _posts.map(function (p) {
      var publie = p.statut === 'publie';
      return '<tr>'
        + '<td><b>' + esc(p.titre) + '</b><br><span class="bg-sujet">' + esc(p.sujet)
        +   (p.image ? '' : ' · <em>sans image</em>') + '</span></td>'
        + '<td>' + esc(BLOG_CATS[p.categorie] || p.categorie) + '</td>'
        + '<td><span class="bg-pastille' + (publie ? ' on' : '') + '">'
        +   (publie ? 'Publié' : 'Brouillon') + '</span></td>'
        + '<td class="num bg-acts">'
        +   '<button data-bgstatut="' + esc(p.slug) + '" data-vers="' + (publie ? 'brouillon' : 'publie') + '">'
        +     (publie ? '↩ Dépublier' : '✅ Publier') + '</button>'
        +   '<button class="bg-del" data-bgdel="' + esc(p.slug) + '">🗑️</button>'
        + '</td></tr>';
    }).join('');
  }

  function srv(chemin, opts) {
    var base = ((window.ACOLITE_KEYS && window.ACOLITE_KEYS.proxy) || '').replace(/\/+$/, '');
    opts = opts || {};
    opts.headers = { Authorization: 'Bearer ' + token() };
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    return fetch(base + chemin, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: r.ok, status: r.status, data: d };
      });
    });
  }

  function chargePosts() {
    return srv('/admin/blog/list').then(function (r) {
      if (r.status === 404) { bgEtat('Serveur non à jour : recolle valtown-backend.js dans Val Town.', true); return; }
      if (!r.ok) { bgEtat(r.data.error || 'Liste indisponible.', true); return; }
      _posts = r.data.articles || [];
      renderPosts();
    });
  }

  var _auto = null;

  /* L'état de l'automatisme, en une phrase lisible : ce que fait le programme
     en ce moment, et quand il écrira le prochain article. */
  function renderAuto() {
    var p = $('#baPast'), t = $('#baTxt'), tg = $('#baToggle'), sel = $('#baInt');
    if (!p || !_auto) return;
    var on = !!_auto.actif;
    p.textContent = on ? 'En marche' : 'En pause';
    p.className = 'ba-pastille' + (on ? ' on' : ' off');
    var phrase;
    if (!on) phrase = 'Le programme n’écrit plus. Remets-le en marche pour reprendre.';
    else if (!_auto.dernier) phrase = 'Prêt : le prochain passage écrira un article.';
    else if (_auto.prochain_dans_minutes > 0)
      phrase = 'Prochain article dans ' + (_auto.prochain_dans_minutes >= 60
        ? Math.round(_auto.prochain_dans_minutes / 60) + ' h' : _auto.prochain_dans_minutes + ' min') + '.';
    else phrase = 'L’heure est venue : le prochain passage écrira un article.';
    phrase += ' ' + _auto.en_attente + ' sujet(s) en file';
    if ((_auto.suivants || []).length) phrase += ' — à venir : ' + _auto.suivants.slice(0, 3).join(', ');
    phrase += '.';
    /* ⚠️ « En marche » ne veut pas dire « ça produit ». Sans Cron côté Val Town,
       /blog/tick n'est appelé que par les visiteurs : une nuit sans visite = pas
       d'article, et rien ne le disait. On affiche donc ce que le serveur produit
       RÉELLEMENT, et on nomme la cause quand il prend du retard. */
    if (on && _auto.en_retard)
      phrase += ' ⚠️ Aucun article depuis ' + _auto.heures_depuis_dernier
              + ' h : il manque probablement le Cron dans Val Town (voir valtown-cron-blog.js).';
    if (typeof _auto.ecrits === 'number')
      phrase += ' Bilan : ' + _auto.ecrits + ' écrit(s)'
              + (_auto.echecs ? ', ' + _auto.echecs + ' échec(s)' : '') + '.';
    t.textContent = phrase;
    if (tg) tg.textContent = on ? '⏸ Mettre en pause' : '▶ Remettre en marche';
    if (sel) sel.value = String(_auto.intervalle || 1);
  }
  function chargeAuto(corps) {
    return srv('/admin/blog/auto', corps ? { method:'POST', body: JSON.stringify(corps) } : {})
      .then(function (r) {
        if (r.status === 404) { bgEtat('Serveur non à jour : recolle valtown-backend.js dans Val Town.', true); return; }
        if (!r.ok) { bgEtat(r.data.error || 'État de l’automatisme indisponible.', true); return; }
        _auto = r.data; renderAuto();
      });
  }
  /* « Écrire maintenant » : on remet le compteur à zéro, puis on appelle le
     déclencheur. La rédaction prend 30 à 60 s — on le dit, sinon on croit
     que rien ne se passe. */
  function ecrisMaintenant() {
    var b = $('#baNow');
    if (b) b.disabled = true;
    bgEtat('Rédaction automatique lancée… (30 à 60 s)');
    chargeAuto({ maintenant: true })
      .then(function () { return srv('/blog/tick'); })
      .then(function (r) {
        if (b) b.disabled = false;
        if (!r.ok) { bgEtat('Le déclencheur a échoué.', true); return; }
        if (r.data.fait) bgEtat('✅ « ' + (r.data.titre || r.data.sujet) + ' » écrit et publié.');
        else bgEtat('Rien à écrire : ' + (r.data.erreur || r.data.raison || 'file vide') + '.', !!r.data.erreur);
        chargePosts(); chargeAuto();
      })
      .catch(function () { if (b) b.disabled = false; bgEtat('Serveur non à jour : recolle valtown-backend.js dans Val Town, puis réessaie.', true); });
  }

  function brancheBlog() {
    var go = $('#bgGo');
    if (go) go.onclick = function () {
      var sujet = ($('#bgSujet').value || '').trim();
      if (sujet.length < 3) { bgEtat('Écris un sujet.', true); return; }
      go.disabled = true;
      bgEtat('Rédaction en cours… (30 à 60 s, l’article est long)');
      srv('/admin/blog/generate', {
        method: 'POST',
        body: JSON.stringify({ sujet: sujet, categorie: $('#bgCat').value, ton: $('#bgTon').value }),
      }).then(function (r) {
        go.disabled = false;
        if (r.status === 409) { bgEtat('Un article existe déjà sur ce sujet.', true); return; }
        if (r.status === 404) { bgEtat('Serveur non à jour : recolle valtown-backend.js dans Val Town, puis réessaie.', true); return; }
        if (!r.ok) { bgEtat(r.data.error || 'La rédaction a échoué.', true); return; }
        bgEtat('✅ « ' + (r.data.titre || sujet) +' » rédigé — ' + (r.data.sections || 0)
               + ' sections' + (r.data.image ? ', avec image' : ', sans image')
               + '. Il reste à le publier.');
        $('#bgSujet').value = '';
        chargePosts();
      }).catch(function () { go.disabled = false; bgEtat('Serveur non à jour : recolle valtown-backend.js dans Val Town, puis réessaie.', true); });
    };
    /* publier / dépublier / supprimer : un seul écouteur, la table est redessinée */
    var panel = $('#blogPanel');
    if (panel) panel.onclick = function (e) {
      var st = e.target.closest('[data-bgstatut]');
      if (st) {
        srv('/admin/blog/statut', { method:'POST',
          body: JSON.stringify({ slug: st.dataset.bgstatut, statut: st.dataset.vers }) })
          .then(chargePosts);
        return;
      }
      var del = e.target.closest('[data-bgdel]');
      if (del) {
        if (!confirm('Supprimer cet article définitivement ?')) return;
        srv('/admin/blog?slug=' + encodeURIComponent(del.dataset.bgdel), { method:'DELETE' })
          .then(chargePosts);
      }
    };
    var tg = $('#baToggle');
    if (tg) tg.onclick = function () { chargeAuto({ actif: !(_auto && _auto.actif) }); };
    var sel = $('#baInt');
    if (sel) sel.onchange = function () { chargeAuto({ intervalle: sel.value }); };
    var now = $('#baNow');
    if (now) now.onclick = ecrisMaintenant;
    var fill = $('#baFill');
    if (fill) fill.onclick = function () {
      bgEtat('Regarnissage de la file…');
      chargeAuto({ regarnir: true }).then(function () { bgEtat('File regarnie.'); });
    };
    var prT = $('#prToggle');
    if (prT) prT.onclick = function () {
      var on = _promo && _promo.actif;
      /* On demande confirmation à l'ACTIVATION seulement : désactiver n'a aucun
         risque, activer ouvre la porte à un envoi de masse. */
      if (!on && !confirm('Activer la lettre aux clients ?\n\nAucun message ne partira tant que tu n’auras pas cliqué « Envoyer pour de vrai », et seuls ceux qui ont donné leur accord seront touchés.')) return;
      promoCharge({ actif: !on });
    };
    var prTest = $('#prTest');
    if (prTest) prTest.onclick = function () {
      prEtat('Simulation…');
      promoCharge({ envoyer: true, sujet: ($('#prSujet') || {}).value || 'Test',
                    message: ($('#prMsg') || {}).value || 'Message de simulation, vingt caractères au moins.' })
        .then(function (d) {
          if (!d) return;
          if (d.error) { prEtat(d.error, true); return; }
          prEtat(d.simulation
            ? 'Simulation : ' + d.destinataires + ' destinataire(s). Rien n’a été envoyé.'
            : 'Réponse inattendue.', false);
        });
    };
    var prS = $('#prSend');
    if (prS) prS.onclick = function () {
      var s = ($('#prSujet') || {}).value || '', m = ($('#prMsg') || {}).value || '';
      if (s.trim().length < 3 || m.trim().length < 20) { prEtat('Il faut un objet et un message.', true); return; }
      if (!confirm('Envoyer ce message à ' + ((_promo && _promo.consentants) || 0) + ' client(s) ?\n\nC’est irréversible : un courriel parti ne se rappelle pas.')) return;
      prS.disabled = true; prEtat('Envoi en cours…');
      promoCharge({ envoyer: true, pour_de_vrai: true, sujet: s, message: m }).then(function (d) {
        prS.disabled = false;
        if (!d) return;
        if (d.error) { prEtat(d.error, true); return; }
        prEtat('Envoyé à ' + d.envoye + ' client(s)' + (d.echecs ? ', ' + d.echecs + ' échec(s)' : '') + '.');
        promoCharge();
      });
    };
    chargePosts(); chargeAuto(); promoCharge();
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
