const fetch = require("node-fetch");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { commercialName, vehicleName, sessionDate, description, selectedPhotos, allPhotos } = req.body;

    if (!description?.trim()) return res.status(400).json({ error: "Description manquante" });

    // Construction du HTML des photos sélectionnées
    const photosHtml = (selectedPhotos || []).map((url, i) => `
      <div style="margin-bottom:12px;">
        <p style="margin:0 0 6px;font-size:12px;color:#6b7280;">Photo signalée n°${i + 1}</p>
        <a href="${url}" target="_blank">
          <img src="${url}" alt="Photo ${i+1}" style="max-width:300px;border-radius:8px;border:2px solid #ef4444;" />
        </a>
        <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;">
          <a href="${url}" style="color:#3b82f6;">Ouvrir en plein écran →</a>
        </p>
      </div>
    `).join("");

    // Toutes les photos de la session pour contexte
    const allPhotosHtml = (allPhotos || []).map((url, i) => `
      <a href="${url}" target="_blank" style="display:inline-block;margin:4px;">
        <img src="${url}" alt="Photo ${i+1}" style="width:100px;height:75px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;" />
      </a>
    `).join("");

    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:'DM Sans',-apple-system,sans-serif;background:#f5f5f7;margin:0;padding:20px;">
  <div style="max-width:600px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#1a1a2e;padding:20px 28px;border-bottom:3px solid #f59e0b;">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:36px;height:36px;border-radius:8px;background:#8dc63f;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:#1a1a2e;">AE</div>
        <div>
          <div style="font-size:16px;font-weight:700;color:white;">AutoEasy Studio</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);">Réclamation partenaire</div>
        </div>
      </div>
    </div>

    <!-- Alerte -->
    <div style="background:#fff7ed;border-bottom:1px solid #fed7aa;padding:14px 28px;display:flex;align-items:center;gap:10px;">
      <span style="font-size:20px;">⚠️</span>
      <div>
        <div style="font-size:14px;font-weight:700;color:#92400e;">Nouvelle réclamation signalée</div>
        <div style="font-size:12px;color:#b45309;">Un commercial a détecté une erreur sur une session.</div>
      </div>
    </div>

    <!-- Infos session -->
    <div style="padding:24px 28px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:12px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;width:40%;">Commercial</td>
          <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:13px;font-weight:700;color:#111;">${commercialName || "Non renseigné"}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:12px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Véhicule</td>
          <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:13px;font-weight:700;color:#111;">${vehicleName || "Non renseigné"}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:12px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Date session</td>
          <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151;">${sessionDate || "—"}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:12px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Photos signalées</td>
          <td style="padding:8px 0;font-size:13px;color:#374151;">${(selectedPhotos || []).length} photo${(selectedPhotos || []).length > 1 ? "s" : ""}</td>
        </tr>
      </table>

      <!-- Description -->
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;margin-bottom:24px;">
        <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:8px;">Description de l'erreur</div>
        <div style="font-size:14px;color:#111;line-height:1.6;">${description.replace(/\n/g, "<br>")}</div>
      </div>

      <!-- Photos signalées -->
      ${selectedPhotos?.length > 0 ? `
      <div style="margin-bottom:24px;">
        <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:12px;">📸 Photos signalées en erreur</div>
        ${photosHtml}
      </div>
      ` : ""}

      <!-- Toutes les photos -->
      ${allPhotos?.length > 0 ? `
      <div>
        <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:10px;">Toutes les photos de la session</div>
        <div>${allPhotosHtml}</div>
      </div>
      ` : ""}
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;padding:14px 28px;border-top:1px solid #e2e8f0;text-align:center;">
      <p style="margin:0;font-size:11px;color:#9ca3af;">AutoEasy Studio · Réclamation automatique · contact@cotecars.fr</p>
    </div>
  </div>
</body>
</html>`;

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: "AutoEasy Studio", email: "contact@cotecars.com" },
        to: [{ email: "contact@cotecars.fr", name: "AutoEasy" }],
        subject: `⚠️ Réclamation — ${vehicleName || "Véhicule"} — ${commercialName || "Commercial"}`,
        htmlContent: emailHtml,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error("Brevo error: " + err);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[partner-claim]", err);
    res.status(500).json({ error: err.message });
  }
};
