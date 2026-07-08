import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const apiDir = path.resolve(__dirname, '../../api');

// Reflète le mapping de vercel.json pour les endpoints utilisés en dev local.
// Étendre cette table si un nouvel outil a besoin d'un autre endpoint /api/*.
const ROUTES = {
  '/api/rapid-api-requests': 'rapid-api-requests.js',
  '/api/leboncoin': 'lbc-piloterr-requests.js',
  '/api/lbc-finitions': 'lbc-finitions-requests.js',
  '/api/lbc-marques-codes': 'lbc-marques-codes.js',
  '/api/estimation-usage': 'estimation-usage.js',
};

export default function vercelApiDev() {
  loadEnv({ path: path.resolve(__dirname, '../../.env') });

  return {
    name: 'vercel-api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        const file = ROUTES[url.pathname];
        if (!file) return next();

        req.query = Object.fromEntries(url.searchParams);
        res.status = code => { res.statusCode = code; return res; };
        res.json = body => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };

        try {
          const filePath = path.join(apiDir, file);
          delete require.cache[require.resolve(filePath)];
          const handler = require(filePath);
          await handler(req, res);
        } catch (e) {
          console.error(`[api-dev] ${file}:`, e);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}
