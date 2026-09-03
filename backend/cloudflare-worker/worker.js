let ebayTokenCache = { token: null, expiresAt: 0 };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ ok: true, service: "Den's Deal Engine lookup", ebayConfigured: !!(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) });
    }
    if (url.pathname !== '/lookup') return json({ error: 'Not found' }, 404);

    const barcode = (url.searchParams.get('barcode') || '').replace(/\D/g, '');
    if (!/^\d{8,14}$/.test(barcode)) return json({ error: 'Valid 8–14 digit barcode required' }, 400);

    const evidence = [];
    let upcItem = null;
    let ebayItem = null;

    try {
      upcItem = await lookupUpc(barcode, env);
      evidence.push({ source: 'UPCitemdb', ok: !!upcItem });
    } catch (e) {
      evidence.push({ source: 'UPCitemdb', ok: false, error: safeError(e) });
    }

    if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
      try {
        ebayItem = await lookupEbay(barcode, env);
        evidence.push({ source: 'eBay Browse', ok: !!ebayItem });
      } catch (e) {
        evidence.push({ source: 'eBay Browse', ok: false, error: safeError(e) });
      }
    } else {
      evidence.push({ source: 'eBay Browse', ok: false, error: 'Credentials not configured' });
    }

    const merged = mergeItems(upcItem, ebayItem);
    if (!merged) return json({ barcode, item: null, source: null, evidence }, 404);

    return json({
      barcode,
      item: merged,
      source: [upcItem && 'UPCitemdb', ebayItem && 'eBay Browse'].filter(Boolean).join(' + '),
      evidence
    });
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function safeError(e) {
  return String(e && e.message ? e.message : e).slice(0, 180);
}

async function lookupUpc(barcode, env) {
  const paid = env.UPCITEMDB_USER_KEY;
  const endpoint = paid ? 'https://api.upcitemdb.com/prod/v1/lookup' : 'https://api.upcitemdb.com/prod/trial/lookup';
  const headers = { Accept: 'application/json' };
  if (paid) {
    headers.user_key = env.UPCITEMDB_USER_KEY;
    headers.key_type = env.UPCITEMDB_KEY_TYPE || '3scale';
  }
  const r = await fetch(endpoint + '?upc=' + encodeURIComponent(barcode), { headers });
  if (!r.ok) throw new Error('UPC lookup HTTP ' + r.status);
  const d = await r.json();
  const x = d.items && d.items[0];
  if (!x) return null;
  return {
    title: x.title || '', brand: x.brand || '', category: x.category || '', model: x.model || '',
    description: x.description || '', images: Array.isArray(x.images) ? x.images : [],
    sourceUrl: ''
  };
}

async function getEbayToken(env) {
  const now = Date.now();
  if (ebayTokenCache.token && ebayTokenCache.expiresAt > now + 60000) return ebayTokenCache.token;
  const basic = btoa(env.EBAY_CLIENT_ID + ':' + env.EBAY_CLIENT_SECRET);
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' });
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error('eBay OAuth HTTP ' + r.status);
  const d = await r.json();
  ebayTokenCache = { token: d.access_token, expiresAt: now + ((d.expires_in || 7200) * 1000) };
  return ebayTokenCache.token;
}

async function lookupEbay(barcode, env) {
  const token = await getEbayToken(env);
  const market = env.EBAY_MARKETPLACE_ID || 'EBAY_GB';
  const u = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  u.searchParams.set('gtin', barcode);
  u.searchParams.set('limit', '20');
  const r = await fetch(u.toString(), {
    headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': market, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error('eBay Browse HTTP ' + r.status);
  const d = await r.json();
  const items = d.itemSummaries || [];
  if (!items.length) return null;
  // The Browse search itself is constrained by gtin=barcode. Keep artwork only
  // from these exact GTIN-matched results and preserve several candidates so
  // the front end can recover cleanly if one marketplace image URL expires.
  const x = items[0];
  const exactImages = [];
  for (const item of items.slice(0, 8)) {
    if (item.image && item.image.imageUrl) exactImages.push(item.image.imageUrl);
    for (const img of (item.additionalImages || [])) if (img && img.imageUrl) exactImages.push(img.imageUrl);
  }
  const aspects = x.localizedAspects || [];
  const getAspect = name => {
    const a = aspects.find(v => (v.name || '').toLowerCase() === name.toLowerCase());
    return a ? a.value || '' : '';
  };
  return {
    title: x.title || '',
    brand: getAspect('Brand') || '',
    category: (x.categories && x.categories[0] && x.categories[0].categoryName) || '',
    model: getAspect('Model') || getAspect('Edition') || '',
    description: [x.condition, getAspect('Platform'), getAspect('Format')].filter(Boolean).join(' · '),
    images: [...new Set(exactImages.filter(Boolean))],
    sourceUrl: x.itemWebUrl || '',
    activePrice: x.price ? { value: Number(x.price.value), currency: x.price.currency } : null
  };
}

function mergeItems(primary, ebay) {
  if (!primary && !ebay) return null;
  const a = primary || {};
  const b = ebay || {};
  return {
    title: a.title || b.title || '',
    brand: a.brand || b.brand || '',
    category: a.category || b.category || '',
    model: a.model || b.model || '',
    description: a.description || b.description || '',
    images: [...new Set([...(b.images || []), ...(a.images || [])].filter(Boolean))],
    sourceUrl: b.sourceUrl || a.sourceUrl || '',
    activePrice: b.activePrice || null
  };
}
