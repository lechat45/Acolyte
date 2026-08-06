# Où est-ce ? — le jeu des merveilles du monde

Une photo, une carte. Situe la merveille, puis nomme-la. Cinq manches, un score,
un classement — et deux portes pour partir vraiment.

**Projet autonome.** Il ne partage aucun fichier avec Acolyte et doit vivre dans
son propre dépôt. Le seul lien entre les deux, ce sont les deux boutons de fin de
manche, qui ouvrent Acolyte par son adresse publique.

---

## Déployer

Tout tient dans `index.html` : aucune compilation, aucune dépendance, aucun
paquet à mettre à jour.

1. Créer un dépôt GitHub **public**, par exemple `ou-est-ce`.
2. Y déposer `index.html` (et ce fichier, si tu veux).
3. **Settings → Pages** → Source : « Deploy from a branch », branche `main`,
   dossier `/root`.
4. Une à deux minutes plus tard, le jeu est en ligne.

Un dépôt public est nécessaire pour que GitHub Pages soit gratuit.

---

## Ce qu'il faut savoir avant d'y toucher

### Le double-clic n'est pas un caprice

Sur une carte qu'on déplace, le **simple clic est ambigu** : tout glissement se
termine par un clic, et le joueur posait son point par accident sans comprendre
pourquoi. Le double-clic est un geste franc, qu'on ne fait pas sans le vouloir.
`dblclick` couvre la souris **et** le double-tap tactile — inutile de compter les
touches à la main.

### Le classement est LOCAL, et il doit le rester pour l'instant

Il compare tes dix meilleures parties, pas celles des autres joueurs. Ce n'est
pas un raccourci de paresse : un classement partagé demanderait que le backend
d'Acolyte accepte l'origine de **ce** site, or il n'autorise aujourd'hui que
l'adresse du site principal (`ALLOWED_ORIGIN`).

Pour ouvrir un classement mondial, il faudrait :

1. faire accepter plusieurs origines par le backend (aujourd'hui une seule) ;
2. y ajouter l'adresse de ce jeu ;
3. brancher les routes `/game/score` et `/game/top` qui existent déjà.

Tant que ce n'est pas fait, se mesurer à soi-même est honnête et immédiatement
lisible. Ne prétends pas le contraire dans l'interface.

### Les deux liens vers Acolyte

| Bouton | Adresse | Remarque |
|---|---|---|
| 📰 Lire l'article | `?a=<slug>` | Le slug est fabriqué par la **même** fonction que le backend d'Acolyte. Si elle change là-bas, elle doit changer ici, sinon les liens pointent à côté. |
| ✈️ Y aller pour de vrai | `?lieu=<ville>` | On envoie la **ville**, pas le monument : « Grande Muraille » n'est pas une destination qu'un planificateur sait traiter, « Pékin » si. |

Le bouton « Lire l'article » **ne s'affiche que si l'article existe**. Le jeu
demande la liste au backend d'Acolyte au chargement (`/blog`), une seule fois.

⚠️ Cet appel est **facultatif par construction**. S'il échoue — backend éteint,
hors ligne, origine refusée — le jeu retombe sur l'ancien comportement et
affiche le bouton dans tous les cas. **Le jeu ne doit jamais dépendre d'Acolyte
pour fonctionner** : ce sont deux projets séparés. Si tu touches à
`chargeIndexArticles`, garde ce repli.

⚠️ La politique de sécurité (`connect-src`) doit autoriser le backend. Elle
valait `'none'`, ce qui bloquait l'appel **en silence** : le jeu marchait, mais
la vérification n'aboutissait jamais.

### La photo fait 1280 px, et pas 960

La photo est l'énoncé du jeu : elle occupe la plus grande part de l'écran, et une
source trop petite s'afficherait floue. ⚠️ Wikimédia **refuse** beaucoup de
largeurs de vignette — 1280 passe pour tous les fichiers de la liste, 1024 non.
Vérifie qu'une image se charge avant d'ajouter une merveille.

### La carte n'utilise aucune bibliothèque

Le jeu n'a besoin que de quatre choses : afficher le monde, se laisser déplacer,
poser deux marqueurs, tracer un trait. Une bibliothèque de carte pèse plus que
tout ce fichier. Le moteur fait ~120 lignes (projection Web Mercator + tuiles
OpenStreetMap en `<img>`).

⚠️ Les tuiles hors champ sont **retirées** à chaque rendu. Les garder « au cas
où » sans les repositionner produit des fragments de carte au mauvais endroit —
l'erreur est facile à réintroduire.

---

## Ajouter une merveille

Une entrée dans le tableau `LIEUX` :

```js
{ nom:'Pétra', ville:'Pétra', lat:30.3292, lon:35.4436, img:'2/23/View_of_Petra.jpg' }
```

* `nom` — ce que le joueur doit reconnaître, et ce qui sert au slug de l'article.
* `ville` — la destination envoyée à Acolyte. Souvent différente du monument.
* `img` — le chemin Wikimédia après `/commons/thumb/`, sans la largeur.

---

## Ce qu'il n'y a pas, volontairement

* **Aucun compte, aucun traceur, aucune mesure d'audience.** Le seul stockage
  local est ton record et tes dix dernières parties.
* **Aucun appel réseau de données.** La politique de sécurité déclare
  `connect-src 'none'` : une fois la page chargée, le jeu tourne sans réseau,
  hors les images.

## Crédits

Cartes © [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL).
Photographies : Wikimédia Commons, licences respectives de leurs auteurs.
