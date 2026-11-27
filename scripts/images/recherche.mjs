// Recherche d'images libres : Unsplash, puis Pexels, puis Pixabay.
// Renvoie tous les résultats dans cet ordre ; la règle d'unicité (une photo par
// site) est appliquée par unicite.mjs, jamais ici.

async function appel(url, options) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function chercherUnsplash(requete) {
  const cle = process.env.UNSPLASH_ACCESS_KEY;
  if (!cle) return [];
  const json = await appel(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(requete)}&per_page=10&orientation=landscape`, {
    headers: { Authorization: `Client-ID ${cle}` },
  });
  return (json?.results || []).map((r) => ({ url: r.urls.regular, alt: r.alt_description || "" }));
}

async function chercherPexels(requete) {
  const cle = process.env.PEXELS_API_KEY;
  if (!cle) return [];
  const json = await appel(`https://api.pexels.com/v1/search?query=${encodeURIComponent(requete)}&per_page=10&orientation=landscape`, {
    headers: { Authorization: cle },
  });
  return (json?.photos || []).map((p) => ({ url: p.src.large, alt: p.alt || "" }));
}

async function chercherPixabay(requete) {
  const cle = process.env.PIXABAY_API_KEY;
  if (!cle) return [];
  const json = await appel(`https://pixabay.com/api/?key=${encodeURIComponent(cle)}&q=${encodeURIComponent(requete)}&image_type=photo&orientation=horizontal&per_page=10&safesearch=true`);
  return (json?.hits || []).map((h) => ({ url: h.largeImageURL, alt: h.tags || "" }));
}

export async function rechercherImage(requete) {
  return [...(await chercherUnsplash(requete)), ...(await chercherPexels(requete)), ...(await chercherPixabay(requete))];
}
