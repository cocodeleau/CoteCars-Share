const Stripe = require("stripe");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch (err) { return res.status(400).send("Cannot read body"); }

  const sig = req.headers["stripe-signature"];
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhook] Signature invalide :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { companyId, tokens } = session.metadata || {};
    const tokensToAdd = parseInt(tokens) || 0;

    if (companyId && tokensToAdd > 0) {
      const db = admin.firestore();
      const companyRef = db.collection("companies").doc(companyId);
      await db.runTransaction(async (t) => {
        const doc = await t.get(companyRef);
        const current = doc.data()?.tokens || 0;
        t.update(companyRef, {
          tokens: current + tokensToAdd,
          lastRecharge: new Date().toISOString(),
        });
      });
      console.log(`[webhook] +${tokensToAdd} jetons → ${companyId}`);
    }
  }

  res.json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
