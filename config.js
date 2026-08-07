/* ============================================================
   ACOLYTE — config.js
   ============================================================
   DEUX MODES :

   ▸ MODE SÉCURISÉ (recommandé si ton site est public)
     Déploie worker.js sur Cloudflare (gratuit), mets tes clés
     DANS LE WORKER (Settings → Variables and Secrets), puis :
        proxy: 'https://acolyte.ton-compte.workers.dev'
     et LAISSE LES CLÉS VIDES ci-dessous.
     → Aucune clé ne quitte le navigateur. Personne ne peut les voler.

   ▸ MODE TEST (rapide, mais les clés sont lisibles publiquement)
     Laisse proxy vide et colle tes clés ici.
     ⚠️ N'importe qui peut les récupérer via les outils du navigateur
        (F12 → Sources) et épuiser tes quotas. À réserver au local.
============================================================ */
window.ACOLITE_KEYS = {

  /* ▸ MODE SÉCURISÉ : backend Val Town — les clés sont dans ses
     variables d'environnement (val.town → Env vars), jamais ici */
  proxy: 'https://lechat45--2ec0f9a6860b11f183cf1607ee4eb77e.web.val.run',

  /* ▸ MODE TEST uniquement : à VIDER dès que le proxy est en place */
  gemini: '',
  groq: '',
  travelpayouts: '',

  /* Envoi réel du mail de vérification (gratuit, 200 mails/mois) :
     1. Crée un compte sur https://www.emailjs.com
     2. Ajoute un service Gmail → copie le Service ID
     3. Crée un template avec {{to_email}} et {{code}} → copie le Template ID
     4. Récupère ta Public Key (Account → API keys)
     Tant que c'est vide → mode démo : le code s'affiche à l'écran.
     (La clé publique EmailJS est conçue pour être exposée : pas de risque.) */
  emailjs: {
    publicKey: 'iZ2Y1SA61PxmXDCT5CzeV',
    serviceId: 'service_wiq1wzj',
    templateId: 'template_szov0of'
  },

  /* ▸ AFFILIATION — la seule source de revenu du projet.
     Acolyte envoie DÉJÀ ses visiteurs chez ces trois-là, avec la destination,
     les dates et le nombre de voyageurs pré-remplis (14 liens dans app.js).
     Sans identifiant ici, ces clics ne rapportent rien : le travail de
     recommandation est fait, la rémunération est simplement débranchée.

     Les trois inscriptions sont GRATUITES :
       booking → https://www.booking.com/affiliate-program/v2/index.html
                 (récupère ton « AID », un nombre)
       gyg     → https://partner.getyourguide.com
                 (récupère ton « partner_id »)
       tp      → https://www.travelpayouts.com
                 (récupère ton « marker » — il couvre Aviasales ET Omio)

     ⚠️ Tant qu'un champ est vide, le lien correspondant part inchangé. Rien ne
        casse si tu ne t'inscris jamais, et rien n'attend d'être « activé ».
     ⚠️ Ces identifiants sont PUBLICS par nature — ils servent à te reconnaître,
        pas à t'authentifier. Les mettre ici est sans risque, contrairement aux
        clés d'API plus haut. */
  affiliation: {
    booking: '',
    gyg: '',
    tp: ''
  },

  /* ▸ SERVEUR DISCORD — l'adresse d'invitation.
     Tant que ce champ est vide, la ligne « Rejoindre la communauté » ne
     s'affiche PAS dans le profil : proposer un lien mort est pire que ne rien
     proposer.
     ⚠️ Prends une invitation PERMANENTE (Discord → Inviter → Modifier le lien
     → « Jamais » expirer, aucune limite d'utilisations). Un lien expiré dans un
     vieux message, c'est un membre perdu sans qu'on le sache jamais.
     Cette adresse est publique par nature : elle sert à faire entrer les gens. */
  discord: ''
};
