export default async function handler(req, res) {
  // Reconstruire l'URL complète pour éviter la troncature sur les & de Firebase
  const raw = req.url; // ex: /api/download-photo?url=https%3A%2F%2F...%26token%3D...
  const qIdx = raw.indexOf("?url=");
  if (qIdx === -1) return res.status(400).json({ error: "missing url" });

  const encoded = raw.slice(qIdx + 5); // tout ce qui suit ?url=
  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return res.status(400).json({ error: "invalid url" });
  }

  if (!decoded.startsWith("https://firebasestorage.googleapis.com/")) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const upstream = await fetch(decoded);
    if (!upstream.ok) return res.status(upstream.status).json({ error: "upstream error" });

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buffer = await upstream.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.status(200).send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: "fetch failed", detail: e.message });
  }
}