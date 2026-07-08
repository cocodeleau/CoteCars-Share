// api/estimation-usage.js
//
// Limite l'outil d'estimation gratuit : 3 essais offerts dès la première
// visite, puis 1 essai par jour ensuite. Compteur stocké côté serveur
// (Firestore) par IP — jamais localStorage, pour empêcher le contournement
// par simple effacement du cache navigateur.

function getDb() {
  try {
    const admin = require("firebase-admin");
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").includes("\\n")
            ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
            : process.env.FIREBASE_PRIVATE_KEY,
        }),
      });
    }
    return admin.firestore();
  } catch (e) {
    console.warn("[estimation-usage] Firestore indisponible, on laisse passer :", e.message);
    return null;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const WELCOME_CREDITS = 3;
const DAILY_LIMIT = 1;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function computeRemaining(data, today) {
  const total = data?.totalCount || 0;
  if (total < WELCOME_CREDITS) return WELCOME_CREDITS - total;
  const usedToday = data?.lastUsedDate === today ? (data?.todayCount || 0) : 0;
  return Math.max(0, DAILY_LIMIT - usedToday);
}

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDb();
  if (!db) return res.status(200).json({ allowed: true, remaining: WELCOME_CREDITS, degraded: true });

  const ip = getClientIp(req);
  const today = todayKey();
  const ref = db.collection("estimationUsage").doc(ip);

  try {
    if (req.method === "GET") {
      const doc = await ref.get();
      return res.status(200).json({ remaining: computeRemaining(doc.data(), today) });
    }

    if (req.method === "POST") {
      const result = await db.runTransaction(async (t) => {
        const doc = await t.get(ref);
        const data = doc.data();
        const remaining = computeRemaining(data, today);
        if (remaining <= 0) return { allowed: false, remaining: 0 };

        const total = data?.totalCount || 0;
        const usedToday = data?.lastUsedDate === today ? (data?.todayCount || 0) : 0;
        t.set(ref, {
          ip,
          totalCount: total + 1,
          lastUsedDate: today,
          todayCount: usedToday + 1,
        }, { merge: true });

        return { allowed: true, remaining: remaining - 1 };
      });
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: "Méthode non supportée" });
  } catch (e) {
    // En cas de panne Firestore, on laisse passer plutôt que de bloquer un utilisateur légitime.
    console.error("[estimation-usage] Erreur :", e.message);
    return res.status(200).json({ allowed: true, remaining: WELCOME_CREDITS, degraded: true });
  }
};
