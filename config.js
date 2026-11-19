/*
 * Réglages par défaut de Zéro Blabla Cuisine, communs à tous ceux qui ouvrent l'appli.
 * ⚠️ Ce fichier est public (n'importe qui peut le lire) : n'y mettez jamais de clé d'API.
 * Les Réglages de l'appli (engrenage) restent prioritaires s'ils sont remplis.
 */
window.ZBC_CONFIG = {
  // Adresse de votre relais Cloudflare (celle qui se termine par .workers.dev)
  WORKER_URL: "https://green-tooth-f612.guillaume-claudel.workers.dev",

  // Code d'accès du relais. Laissez "" si vous avez supprimé ACCESS_CODE sur Cloudflare.
  // S'il est rempli ici, il devient visible de tous : ce n'est plus vraiment un secret.
  ACCESS_CODE: "",
};
