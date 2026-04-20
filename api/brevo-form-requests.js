const { KEYS, URLS, CORS_HEADERS, BREVO_SENDER, BREVO_TO } = require("./utils/constants.js");

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { nom, tel, email, plaque, marque, modele, annee, km, erreur } = req.body;
  const rows = [
    ["Plaque", plaque], ["Nom", nom], ["Téléphone", tel || "—"],
    ["Email", email || "—"], ["Marque", marque], ["Modèle", modele || "—"],
    ["Année", annee], ["Kilométrage", km ? `${km} km` : "—"], ["Erreur", erreur],
  ];
  const tableRows = rows.map(([label, val]) =>
    `<tr><td style="padding:8px;border:1px solid #e5e7eb"><strong>${label}</strong></td><td style="padding:8px;border:1px solid #e5e7eb">${val}</td></tr>`
  ).join("");

  try {
    await fetch(URLS.brevo, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": KEYS.brevo },
      body: JSON.stringify({
        sender: BREVO_SENDER, to: BREVO_TO,
        subject: `🚗 Nouvelle demande d'estimation — ${plaque}`,
        htmlContent: `<h2>Nouvelle demande CoteCars</h2><table style="border-collapse:collapse;width:100%">${tableRows}</table>`,
      }),
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
