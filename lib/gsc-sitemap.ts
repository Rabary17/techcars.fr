// Re-soumission du sitemap à Google Search Console (API sites.sitemaps.submit),
// appelée à chaque publication/dépublication/mise à jour, en complément
// d'IndexNow (Bing).
//
// On n'utilise PAS l'Indexing API de Google : elle est réservée aux offres
// d'emploi et aux événements en direct, pas aux articles. La re-soumission du
// sitemap est le canal officiel pour signaler des URL nouvelles ou modifiées.
//
// Configuration (variables d'env Vercel, jamais commitées) :
// - GSC_SERVICE_ACCOUNT_JSON : JSON complet du compte de service Google Cloud,
//   dont l'e-mail est ajouté comme « Propriétaire » de la propriété dans la
//   Search Console.
// - GSC_SITE_URL : identifiant de la propriété, ex. "https://techcars.fr/"
//   ou "sc-domain:techcars.fr".
// Sans l'une des deux variables, la fonction ne fait rien (et le logue).

import { createSign } from "crypto";
import { SITE_URL } from "./site";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/webmasters";

type ServiceAccount = { client_email: string; private_key: string };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

async function obtenirJeton(compte: ServiceAccount): Promise<string> {
  const maintenant = Math.floor(Date.now() / 1000);
  const entete = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const charge = base64url(
    JSON.stringify({
      iss: compte.client_email,
      scope: SCOPE,
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
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

export async function soumettreSitemapGoogle(): Promise<void> {
  const brut = process.env.GSC_SERVICE_ACCOUNT_JSON;
  const propriete = process.env.GSC_SITE_URL;
  if (!brut || !propriete) return;

  try {
    const compte = JSON.parse(brut) as ServiceAccount;
    const jeton = await obtenirJeton(compte);
    const feedpath = `${SITE_URL}/sitemap.xml`;
    const url =
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(propriete)}` +
      `/sitemaps/${encodeURIComponent(feedpath)}`;

    const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${jeton}` } });
    if (!res.ok) {
      console.warn(`[gsc-sitemap] soumission refusée : ${res.status}`);
    }
  } catch (e) {
    console.warn(`[gsc-sitemap] échec de soumission : ${e}`);
  }
}
