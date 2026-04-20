const KEYS = {
  rapidApi: process.env.RAPID_API_KEY,
  piloterr: process.env.PILOTERR_API_KEY,
  brevo:    process.env.BREVO_API_KEY,
  gemini:   process.env.GEMINI_API_KEY,
  lbc:      process.env.LBC_API_KEY,
};

const URLS = {
  rapidApi:  "https://france-license-plate-api-siv-lite2.p.rapidapi.com",
  piloterr:  "https://piloterr.com/api/v2/leboncoin/search",
  brevo:     "https://api.brevo.com/v3/smtp/email",
  gemini:    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  lbc:       "https://api.leboncoin.fr/api/crit/v1/values",
  lbcSearch: "https://api.leboncoin.fr/finder/search/v2/suggest/cars",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const LBC_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Accept":          "application/json",
  "Accept-Language": "fr-FR,fr;q=0.9",
  "api_key":         process.env.LBC_API_KEY || "ba0c2dad52b3ec",
  "Referer":         "https://www.leboncoin.fr/",
};

const BREVO_SENDER = { name: "CoteCars", email: "noreply@cotecars.fr" };
const BREVO_TO     = [{ email: "corentin.millet974@gmail.com", name: "Corentin" }];

module.exports = { KEYS, URLS, CORS_HEADERS, LBC_HEADERS, BREVO_SENDER, BREVO_TO };
