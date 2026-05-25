const Stripe = require("stripe");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { priceId, tokens, companyId } = req.body;
    if (!priceId || !tokens || !companyId) return res.status(400).json({ error: "Paramètres manquants" });

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const origin = req.headers.origin || "https://cotecars-test.vercel.app";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "payment",
      locale: "fr",
      success_url: `${origin}/shop.html?success=true&tokens=${tokens}&company=${companyId}`,
      cancel_url: `${origin}/shop.html?company=${companyId}`,
      metadata: { companyId, tokens: String(tokens) },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[stripe-checkout]", err);
    res.status(500).json({ error: err.message });
  }
};
