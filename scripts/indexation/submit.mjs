// Après publication d'articles : envoie leurs URL à IndexNow (Bing) et demande à
// Google Search Console de relire le sitemap. Appelé par le workflow avec
// NOUVELLES_URLS (une URL par ligne). Sans URL, ne fait rien.
//
// Secrets utilisés pour Google (facultatifs : sans eux, seule IndexNow est faite) :
//   GSC_SERVICE_ACCOUNT_JSON  JSON complet du compte de service (propriétaire de la propriété GSC)
//   GSC_SITE_URL              "https://techcars.fr/" ou "sc-domain:techcars.fr"

import { createSign } from "node:crypto";

const SITE = "https://techcars.fr";
const HOTE = "techcars.fr";
const CLE = "f67b8b1993a0445f9dfd2caa7ecd9b47"; // fichier public/<clé>.txt
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const urls = (process.env.NOUVELLES_URLS || "").split("\n").map((u) => u.trim()).filter(Boolean);
if (urls.length === 0) {
  console.log("Aucune nouvelle URL à signaler.");
  process.exit(0);
}

// Laisse à Vercel le temps de déployer avant de signaler les URL.
const attente = Number(process.env.ATTENTE_DEPLOIEMENT ?? 180);
await new Promise((r) => setTimeout(r, attente * 1000));

// ---- IndexNow (Bing et partenaires)
try {
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOTE, key: CLE, keyLocation: `${SITE}/${CLE}.txt`, urlList: urls }),
  });
  console.log(`IndexNow : ${res.status} pour ${urls.length} URL`);
} catch (e) {
  console.warn(`IndexNow : échec (${e.message})`);
}

// ---- Google Search Console : re-soumission du sitemap
function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

async function jetonGoogle(compte) {
  const maintenant = Math.floor(Date.now() / 1000);
  const entete = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const charge = base64url(
    JSON.stringify({
      iss: compte.client_email,
      scope: "https://www.googleapis.com/auth/webmasters",
      aud: TOKEN_URL,
      iat: maintenant,
      exp: maintenant + 3600,
    })
  );
  const signature = createSign("RSA-SHA256").update(`${entete}.${charge}`).sign(compte.private_key, "base64url");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${entete}.${charge}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`jeton Google refusé (${res.status})`);
  return (await res.json()).access_token;
}

const brut = process.env.GSC_SERVICE_ACCOUNT_JSON;
const propriete = process.env.GSC_SITE_URL;
if (!brut || !propriete) {
  console.log("Google Search Console : secrets absents, sitemap non soumis.");
} else {
  try {
    const jeton = await jetonGoogle(JSON.parse(brut));
    const feedpath = `${SITE}/sitemap.xml`;
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(propriete)}/sitemaps/${encodeURIComponent(feedpath)}`;
    const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${jeton}` } });
    console.log(res.ok ? "Google Search Console : sitemap soumis." : `Google Search Console : refusé (${res.status}).`);
  } catch (e) {
    console.warn(`Google Search Console : échec (${e.message})`);
  }
}
