# CoteCars — Handoff / Contexte complet pour reprise

> Ce document résume l'intégralité des décisions et discussions prises lors de la session de planning précédente.
> Tu reprends ici comme si tu avais été dans le chat depuis le début.

---

## Le projet — CoteCars

**URL prod** : https://cotecars.fr  
**Repo** : https://github.com/cocodeleau/CoteCars-Share.git  
**Déployé sur** : Vercel  
**Stack actuelle** : HTML + React 18 (CDN UMD) + Babel standalone + Vercel serverless functions (Node.js + 1 Python) + Firebase (Auth + Firestore + Storage) + Stripe

---

## Ce que fait le produit

**CoteCars** = estimation du prix marché d'un véhicule d'occasion via plaque d'immatriculation, basé sur les annonces LeBonCoin réelles.

**Features actuelles :**
- Décodage plaque → marque/modèle/année/énergie/puissance (API SIV via RapidAPI)
- Scraping LeBonCoin via Piloterr → annonces similaires → fourchette de prix
- Suppression de fond photo véhicule (remove background)
- Cache plaque personnalisé (logo garage / texte / flou)
- Auth Firebase (email + Google)
- Historique des recherches
- Dashboard B2B partenaires (`partner.html`) avec gestion jetons Stripe
- Génération description annonce via Gemini 2.5 Flash

---

## Architecture actuelle — fichiers clés

```
/
├── index.html              ← App principale particuliers (634KB — monolithique)
├── partner.html            ← Dashboard B2B actuel (AutoEasy)
├── landing-particuliers.html
├── landing-pros.html
├── shop.html               ← Achat jetons Stripe
├── style.css               ← CSS global minimal (50 lignes)
├── api/
│   ├── rapid-api-requests.js     ← Décodage plaque SIV
│   ├── lbc-piloterr-requests.js  ← Scraping LBC via Piloterr
│   ├── gemini.js                 ← Génération texte IA
│   ├── partner-photo.js          ← Remove BG + cache plaque (EN PROD, clients actifs)
│   ├── firebase-config.js        ← Sert config Firebase au frontend
│   ├── brevo-form-requests.js    ← Emails via Brevo
│   ├── stripe-checkout.js        ← Création session Stripe
│   ├── stripe-webhook.js         ← Webhook → crédite Firestore
│   ├── warp-plate.py             ← OCR plaque (Python)
│   └── utils/
│       ├── constants.js          ← Toutes les clés API (via env Vercel)
│       ├── lbc-url-builder.js    ← Construction URLs recherche LBC
│       ├── lbc-marques-models-codes.js
│       └── normalizers.js
├── vercel.json             ← Routes serverless + rewrites
├── seo-villes/             ← 20+ pages SEO statiques → À SUPPRIMER
└── seo-pages/              ← 20+ pages SEO statiques → À SUPPRIMER
```

---

## Problèmes identifiés — pourquoi on rebuild

1. **Fichiers monolithiques** : `index.html` 634KB, `landing-pros.html` 753KB — React + Babel + logique + données + styles tout dans un fichier. Chargement lent, impossible à maintenir.

2. **Dictionnaire FINITIONS** : 800+ lignes de données statiques (marques/finitions) codées en dur dans `index.html`. Doit devenir un `finitions.json` externe.

3. **CSS dupliqué** : chaque fichier HTML a ses propres centaines de lignes de CSS inline. Zéro réutilisabilité.

4. **Code mort** : fonctions, composants React et states inutilisés accumulés au fil des évolutions.

5. **Architecture B2B/B2C floue** : deux produits (AutoEasy + CoteCars) mélangés dans les mêmes fichiers. Confusion pour les utilisateurs et double maintenance pour les devs.

6. **`partner.html` isolé** : dashboard B2B construit en parallèle sans architecture commune → auth dupliquée, CSS dupliqué, logique métier dupliquée.

---

## Décisions prises

### Stack
**Migration vers Vite + React.** Option C choisie : migrer ET restructurer simultanément. On ne porte pas le code existant — on réécrit composant par composant en ne portant que l'utile. Le code mort ne passe pas.

### Les APIs `/api/` → ON NE TOUCHE PAS
Les serverless functions Vercel restent exactement où elles sont. Elles fonctionnent indépendamment du frontend. Des clients utilisent le remove bg en prod (`partner-photo.js`) — aucune interruption.

### Deux produits distincts, une seule infra
- **B2B (Pros/Agences)** : dashboard pro avec toutes les features
- **B2C (Particuliers)** : dashboard simplifié, accès direct aux outils
- **Firebase partagée** : on garde une seule base, on segmente avec un champ `type: "pro" | "particulier"` sur le document utilisateur Firestore
- **Deux landings** sur le même domaine

### Pages SEO → SUPPRIMÉES
`seo-villes/` et `seo-pages/` supprimées. Le SEO sera retravaillé différemment plus tard. Nettoyer aussi `sitemap.xml` et les routes dans `vercel.json`.

### Démo 1/jour
- 1 utilisation gratuite par jour pour les deux features (estimation + remove bg)
- **Compteur côté serveur uniquement** (IP-based dans l'API) — pas localStorage (bloqué dans iframe sur Safari/Firefox)
- Les landings embarquent la démo via **iframe** pointant vers route `/demo`
- La démo iframe = sans auth, sans chrome, juste l'outil

---

## Structure cible du projet Vite

```
/
├── src/
│   ├── pages/
│   │   ├── LandingParticulier.jsx    → route /
│   │   ├── LandingPro.jsx            → route /pros
│   │   ├── DashboardParticulier.jsx  → route /dashboard (auth required)
│   │   └── DashboardPro.jsx          → route /pro/dashboard (auth required, pro)
│   │
│   ├── tools/                        ← features métier réutilisables
│   │   ├── Estimation/               (B2B + B2C + démo)
│   │   ├── RemoveBG/                 (B2B + démo)
│   │   └── CachePlaque/              (B2B uniquement)
│   │
│   ├── demo/
│   │   └── DemoTool.jsx              ← route /demo, page légère sans nav
│   │                                    utilisée dans les iframes des landings
│   │
│   ├── components/
│   │   ├── shared/                   (Nav, Auth, boutons, modals)
│   │   ├── pro/                      (composants spécifiques dashboard B2B)
│   │   └── particulier/              (composants spécifiques dashboard B2C)
│   │
│   ├── data/
│   │   └── finitions.json            ← extrait de index.html
│   │
│   ├── hooks/
│   │   ├── useAuth.js
│   │   └── useRateLimit.js
│   │
│   └── services/
│       ├── api.js                    → appels vers /api/*
│       ├── firebase.js
│       └── stripe.js
│
├── api/                              ← INCHANGÉ (Vercel serverless)
├── public/
└── vercel.json                       ← À nettoyer (supprimer routes SEO)
```

---

## Périmètre par produit

### Dashboard B2B Pro (PRIORITÉ 1)
- Estimation véhicule (plaque → prix marché)
- Suppression de fond photo
- Cache plaque personnalisé (logo / texte / flou)
- Génération description annonce IA
- Personnalisation logo & fond de marque
- Gestion abonnement / jetons Stripe
- Auth Firebase (compte pro)

### Dashboard B2C Particulier (PRIORITÉ 2)
- Estimation véhicule (plaque → prix marché)
- Historique des recherches
- Auth Firebase (compte particulier)
- Hub d'annonces → **V2, ne pas builder maintenant**

### Landings (dans Vite, routes dédiées)
- `/` → LandingParticulier
- `/pros` → LandingPro
- Arguments de vente (copywriting pro-to-pro pour `/pros`)
- Iframe démo `/demo` intégrée dans les deux landings
- Section pricing (plans pas encore définis — placeholder)
- Pas de vidéo pour l'instant (à tourner plus tard, placeholder)

---

## Ce qui reste à décider (pas encore tranché)

- **Pricing B2B** : plans et montants pas encore définis
- **Nom du produit B2B** : CoteCars Pro ou AutoEasy ? (question ouverte)
- **Dashboard particulier** : périmètre exact à préciser (estimation + historique confirmés, reste à voir)
- **Video preview dashboard** : 15s clic follow à tourner, pas encore disponible

---

## Règles de travail importantes

- **Ne jamais push sans autorisation explicite** du product owner (Corentin)
- **Demander confirmation** avant tout changement local également
- **Pas de code mort** : si on ne sait pas à quoi ça sert, on ne le porte pas
- **APIs `/api/` intouchables** sauf besoin explicite
- Travail en **branches Git séparées**, merge via PR

---

## Pour démarrer

```bash
git clone https://github.com/cocodeleau/CoteCars-Share.git
cd CoteCars-Share
```

**Première tâche : setup le projet Vite + React dans ce repo.**

Crée le projet Vite dans un sous-dossier `/app` (pour garder `/api/` à la racine compatible Vercel), configure React Router pour les routes définies ci-dessus, et pose la structure de dossiers telle que décrite.

Ne pas encore porter de logique métier — juste la structure, le routing, et une page placeholder par route.
