/**
 * lookup.js - the only part of Victu that touches the network.
 *
 * Verified behaviour of Open Food Facts, tested from a real browser:
 *   - Barcode lookup works cross-origin, no key, and Indian packs are in there
 *     with their actual sizes. This is the path worth building.
 *   - Name search is throttled for anonymous callers and fails cross-origin.
 *     So the bundled catalogue stays primary and search never goes online.
 *
 * Anything found here is cached locally forever, which means the app gets
 * better the more you scan and never asks twice.
 */

const BASE = 'https://in.openfoodfacts.org/api/v2/product';
const TIMEOUT_MS = 8000;

/**
 * Look up one barcode. Returns a food in Victu's own schema, or null.
 * Never throws - the caller is usually mid-scan and wants a usable answer.
 */
export async function lookupBarcode(code) {
  const clean = String(code).replace(/\D/g, '');
  if (clean.length < 8) return { ok: false, reason: 'That does not look like a barcode.' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const url = `${BASE}/${clean}.json?fields=product_name,brands,quantity,serving_size,nutriments,nova_group,categories_tags`;
    const res = await fetch(url, { signal: ctrl.signal, mode: 'cors' });
    if (!res.ok) return { ok: false, reason: `Open Food Facts returned ${res.status}.` };

    const json = await res.json();
    const p = json.product;
    if (!p || !p.product_name) {
      return {
        ok: false,
        notFound: true,
        reason: 'That barcode is not in Open Food Facts yet. Log it by weight instead, or add it to the database at openfoodfacts.org so the next person finds it.',
      };
    }

    const n = p.nutriments ?? {};
    const kcal = n['energy-kcal_100g'];
    if (kcal == null) {
      return { ok: false, reason: `Found "${p.product_name}" but it has no nutrition data on file.` };
    }

    const packG = parseQuantity(p.quantity) ?? parseQuantity(p.serving_size);
    const liquid = /\b(ml|l)\b/i.test(p.quantity ?? '') || isDrink(p.categories_tags);

    return {
      ok: true,
      food: {
        id: `scan_${clean}`,
        name: p.product_name.trim(),
        brand: (p.brands ?? '').split(',')[0].trim() || 'scanned',
        cat: 'packaged',
        sub: 'scanned',
        veg: true,              // Unknown from OFF; the user can correct it.
        vegUnknown: true,
        nova: p.nova_group ?? null,
        liquid,
        barcode: clean,
        price: 0,               // Unknown until the user types what they paid.
        priceUnknown: true,
        packs: packG
          ? [{ label: `pack (${fmtPack(packG, liquid)})`, g: packG }]
          : [{ label: liquid ? '100 ml' : '100 g', g: 100 }],
        per100g: {
          kcal: round1(kcal),
          p: round1(n.proteins_100g ?? 0),
          c: round1(n.carbohydrates_100g ?? 0),
          f: round1(n.fat_100g ?? 0),
          fiber: round1(n.fiber_100g ?? 0),
          sugar: round1(n.sugars_100g ?? 0),
          salt: round1(n.salt_100g ?? 0),
        },
        source: `Open Food Facts ${clean}`,
        scannedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, offline: true, reason: 'Lookup timed out. Log it by weight for now — the catalogue works offline.' };
    }
    return { ok: false, offline: true, reason: 'No connection. The bundled catalogue still works offline.' };
  } finally {
    clearTimeout(timer);
  }
}

function parseQuantity(q) {
  if (!q) return null;
  const m = String(q).match(/([\d.]+)\s*(kg|g|ml|l|cl)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(v)) return null;
  if (unit === 'kg' || unit === 'l') return Math.round(v * 1000);
  if (unit === 'cl') return Math.round(v * 10);
  return Math.round(v);
}

function fmtPack(g, liquid) {
  if (liquid) return g >= 1000 ? `${g / 1000} l` : `${g} ml`;
  return g >= 1000 ? `${g / 1000} kg` : `${g} g`;
}

function isDrink(tags) {
  return (tags ?? []).some((t) => /beverage|drink|soda|juice|water/i.test(t));
}

function round1(v) {
  return Math.round((Number(v) || 0) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Camera scanning
// ---------------------------------------------------------------------------

/**
 * Uses the browser's own BarcodeDetector where it exists - Chrome on Android
 * has it, which is the target. Everywhere else, the caller falls back to
 * typing the digits, which is slower but always works.
 */
export function canScan() {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window &&
         navigator.mediaDevices?.getUserMedia != null;
}

export async function scanFromCamera(videoEl, { onError } = {}) {
  if (!canScan()) {
    onError?.('This browser cannot scan. Type the digits under the barcode instead.');
    return null;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
  } catch {
    onError?.('Camera access was refused. Type the digits under the barcode instead.');
    return null;
  }

  videoEl.srcObject = stream;
  await videoEl.play().catch(() => {});

  const detector = new window.BarcodeDetector({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
  });

  const stop = () => stream.getTracks().forEach((t) => t.stop());

  return new Promise((resolve) => {
    let done = false;
    const give = (v) => { if (!done) { done = true; stop(); resolve(v); } };

    const tick = async () => {
      if (done) return;
      try {
        const codes = await detector.detect(videoEl);
        if (codes.length) return give(codes[0].rawValue);
      } catch { /* a frame failed to decode; try the next one */ }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Give up after 30 seconds rather than holding the camera open forever.
    setTimeout(() => { if (!done) { onError?.('Could not read a barcode. Type the digits instead.'); give(null); } }, 30000);
    videoEl._stopScan = () => give(null);
  });
}
