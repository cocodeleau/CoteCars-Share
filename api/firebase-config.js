// api/firebase-config.js
//
// Sert la configuration Firebase publique au frontend via une route sécurisée.
// Les valeurs sont lues depuis les variables d'environnement Vercel.
// Ainsi, aucune clé n'est écrite en dur dans index.html ou partner.html.
//
// Variables d'env Vercel requises :
//   FIREBASE_API_KEY
//   FIREBASE_AUTH_DOMAIN
//   FIREBASE_PROJECT_ID
//   FIREBASE_STORAGE_BUCKET
//   FIREBASE_MESSAGING_SENDER_ID
//   FIREBASE_APP_ID

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();

  // Vérification que toutes les variables sont bien définies
  const required = [
    "FIREBASE_API_KEY",
    "FIREBASE_AUTH_DOMAIN",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_STORAGE_BUCKET",
    "FIREBASE_MESSAGING_SENDER_ID",
    "FIREBASE_APP_ID",
  ];

  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error("[firebase-config] Variables manquantes :", missing.join(", "));
    return res.status(500).json({ error: "Configuration Firebase incomplète." });
  }

  return res.status(200).json({
    apiKey:            process.env.FIREBASE_API_KEY,
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
    projectId:         process.env.FIREBASE_PROJECT_ID,
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId:             process.env.FIREBASE_APP_ID,
  });
};
