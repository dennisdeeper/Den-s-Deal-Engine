let ebayTokenCache = { token: null, expiresAt: 0 };

const VERSION = '8.1-live-market';
const DEFAULT_PUBLIC_FEED =
  'https://dennisdeeper.github.io/Den-s-Deal-Engine/data/live-market.json';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

function json(body, status = 200, extraHeaders = {}) {
  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

function safeError(e) {
  return String(e && e.message ? e.message : e).slice(0, 180);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clean(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

function validHttps(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

function dateMs(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function isUnavailable(value) {
  return /sold out|out of stock|unavailable|ended|expired|cancelled/i.test(
    String(value || '')
  );
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function marketStorage(env) {
  if (env.MDE_MARKET_KV && typeof env.MDE_MARKET_KV.get === 'function') return 'kv';
  if (env.MDE_LIVE_MARKET_JSON) return 'env-json';
  if (env.MDE_LIVE_MARKET_URL) return 'remote';
  return 'public-feed';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === '/image' && request.method === 'GET') {
      return proxyImage(url);
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({
        ok: true,
        service: 'Media Deal Engine API',
        version: VERSION,
        ebayConfigured: !!(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET),
        artworkProxy: true,
        liveMarket: true,
        marketStorage: marketStorage(env),
        marketAdminConfigured: !!(
          env.MDE_ADMIN_TOKEN &&
          env.MDE_MARKET_KV &&
          typeof env.MDE_MARKET_KV.put === 'function'
        )
      }, 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/live-market' && request.method === 'GET') {
      return publicLiveMarket(request, env);
    }

    if (url.pathname === '/live-market/status' && request.method === 'GET') {
      return json({
        ok: true,
        version: VERSION,
        storage: marketStorage(env),
        publicFeedFallback: DEFAULT_PUBLIC_FEED,
        adminWriteReady: !!(
          env.MDE_ADMIN_TOKEN &&
          env.MDE_MARKET_KV &&
          typeof env.MDE_MARKET_KV.put === 'function'
        )
      }, 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/admin/live-market' && request.method === 'POST') {
      return updateLiveMarket(request, env);
    }

    if (url.pathname === '/lookup' && request.method === 'GET') {
      return lookupProduct(request, env);
    }

    return json({ error: 'Not found' }, 404);
  }
};


/* =========================================================
   LIVE MARKET
========================================================= */

async function readMarketFeed(env) {
  if (env.MDE_MARKET_KV && typeof env.MDE_MARKET_KV.get === 'function') {
    const raw = await env.MDE_MARKET_KV.get('live-market-feed');
    if (raw) return { data: JSON.parse(raw), source: 'kv' };
  }

  if (env.MDE_LIVE_MARKET_JSON) {
    return {
      data: JSON.parse(String(env.MDE_LIVE_MARKET_JSON)),
      source: 'env-json'
    };
  }

  const feedUrl = validHttps(env.MDE_LIVE_MARKET_URL) || DEFAULT_PUBLIC_FEED;

  try {
    const response = await fetch(feedUrl, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 60, cacheEverything: true }
    });

    if (response.ok) {
      return { data: await response.json(), source: 'remote' };
    }
  } catch (_) {}

  return {
    data: {
      generatedAt: new Date().toISOString(),
      items: []
    },
    source: 'empty'
  };
}

function calculateEconomics(item, env) {
  const price = num(item.publicPrice ?? item.price);
  const landed =
    num(item.landedCost) ??
    (() => {
      const cost = num(item.acquisitionCost);
      if (cost === null) return null;
      return (
        cost +
        (num(item.sourceShipping) || 0) +
        (num(item.importCost) || 0) +
        (num(item.otherCosts) || 0)
      );
    })();

  if (price === null || landed === null || landed <= 0) {
    return {
      price,
      landedCost: landed,
      netProfit: num(item.netProfit),
      roi: num(item.roi)
    };
  }

  const feeRate = num(item.feeRate) ?? num(env.MDE_DEFAULT_FEE_RATE) ?? 0.13;
  const feeFixed = num(item.feeFixed) ?? 0;
  const sellingFees = num(item.sellingFees) ?? ((price * feeRate) + feeFixed);
  const outboundShipping = num(item.outboundShipping) || 0;
  const netProfit = price - landed - sellingFees - outboundShipping;
  const roi = (netProfit / landed) * 100;

  return { price, landedCost: landed, netProfit, roi };
}

function eligibleMarketItem(item, env) {
  if (!item || String(item.status || '').toLowerCase() !== 'live') return false;

  const now = Date.now();
  const verified = dateMs(item.verifiedAt);
  const maxAgeHours = Math.min(
    Math.max(num(item.maxVerificationAgeHours) ?? 12, 1),
    48
  );

  if (!verified) return false;
  if (verified > now + 5 * 60 * 1000) return false;
  if (now - verified > maxAgeHours * 3600000) return false;

  if (isUnavailable(item.availability) || isUnavailable(item.sourceAvailability)) {
    return false;
  }

  const internalExpiry = dateMs(item.sourceExpiresAt || item.expiresAt);
  if (internalExpiry && internalExpiry <= now) return false;

  const channel = String(item.channel || '').toLowerCase();
  const dealType = String(item.dealType || '').toLowerCase();

  if (channel === 'affiliate') {
    if (item.affiliateApproved !== true) return false;

    const partnerStatus = String(item.partnerStatus || '').toLowerCase();
    if (
      partnerStatus &&
      !['approved', 'joined', 'active', 'enabled'].includes(partnerStatus)
    ) {
      return false;
    }

    if (!validHttps(item.partnerUrl || item.publicUrl || item.url)) return false;
  }

  const economics = calculateEconomics(item, env);
  const minRoi = num(item.minRoi) ?? num(env.MDE_MIN_IMMEDIATE_ROI) ?? 50;

  if (item.marginSafe === false) return false;

  if (['owned', 'dropship'].includes(channel) && dealType === 'immediate') {
    if (economics.roi !== null) {
      if (economics.roi < minRoi) return false;
    } else if (item.marginSafe !== true) {
      return false;
    }
  }

  if (channel === 'dropship' && item.sourceVerified !== true) return false;

  return true;
}

function publicMarketItem(item, requestUrl, env) {
  const channel = String(item.channel || '').toLowerCase();
  const economics = calculateEconomics(item, env);

  let publicUrl = '';
  if (channel === 'affiliate') {
    publicUrl = validHttps(item.partnerUrl || item.publicUrl || item.url);
  } else {
    publicUrl = validHttps(item.publicUrl);
  }

  const rawImage = validHttps(item.image);
  const image = rawImage ? proxyUrlFor(requestUrl, rawImage) : '';

  // A countdown is emitted only when the feed explicitly says the
  // source expiry was verified. Otherwise the browser shows
  // "subject to availability".
  const expiresAt =
    item.expiryVerified === true
      ? clean(item.sourceExpiresAt || item.expiresAt, 80)
      : '';

  const marketLow = num(item.marketLow);
  const marketHigh = num(item.marketHigh);

  return {
    id: clean(item.id, 120),
    title: clean(item.title, 240),
    price: economics.price,
    marketLow,
    marketHigh,
    format: clean(item.format, 80),
    label: clean(item.label, 120),
    region: clean(item.region, 80),
    image,
    url: publicUrl,
    channel,
    publicSeller:
      clean(item.publicSeller, 100) ||
      (channel === 'affiliate'
        ? clean(item.retailer, 100)
        : 'Media Deal Engine'),
    retailer:
      channel === 'affiliate'
        ? clean(item.retailer, 100)
        : '',
    status: 'live',
    availability: clean(item.availability, 120),
    dealType: clean(item.dealType, 40).toLowerCase(),
    tags: Array.isArray(item.tags)
      ? item.tags.slice(0, 12).map(v => clean(v, 40).toLowerCase())
      : [],
    signal: clean(item.signal, 80),
    reason: clean(item.reason, 320),
    roi: economics.roi,
    netProfit: economics.netProfit,
    marginSafe: true,
    verifiedAt: clean(item.verifiedAt, 80),
    maxVerificationAgeHours:
      Math.min(Math.max(num(item.maxVerificationAgeHours) ?? 12, 1), 48),
    expiresAt
  };
}

async function publicLiveMarket(request, env) {
  try {
    const feed = await readMarketFeed(env);
    const data = feed.data || {};
    const rawItems = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);

    const items = rawItems
      .filter(item => eligibleMarketItem(item, env))
      .map(item => publicMarketItem(item, request.url, env))
      .filter(item => item.id && item.title);

    const latestVerification = items
      .map(item => dateMs(item.verifiedAt))
      .filter(Boolean)
      .sort((a, b) => b - a)[0];

    return json({
      generatedAt: new Date().toISOString(),
      verifiedAt: latestVerification
        ? new Date(latestVerification).toISOString()
        : null,
      count: items.length,
      items
    }, 200, {
      'Cache-Control': 'public, max-age=30, s-maxage=60'
    });
  } catch (e) {
    return json({
      generatedAt: new Date().toISOString(),
      verifiedAt: null,
      count: 0,
      items: [],
      error: 'Live market feed temporarily unavailable'
    }, 200, {
      'Cache-Control': 'no-store'
    });
  }
}

async function updateLiveMarket(request, env) {
  if (!env.MDE_ADMIN_TOKEN) {
    return json({ error: 'Admin market updates are not configured' }, 503);
  }

  if (!env.MDE_MARKET_KV || typeof env.MDE_MARKET_KV.put !== 'function') {
    return json({ error: 'MDE_MARKET_KV binding is required for admin updates' }, 503);
  }

  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.MDE_ADMIN_TOKEN}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Valid JSON required' }, 400);
  }

  const items = Array.isArray(body) ? body : body.items;
  if (!Array.isArray(items)) {
    return json({ error: 'items array required' }, 400);
  }

  if (items.length > 250) {
    return json({ error: 'Maximum 250 market items per update' }, 400);
  }

  const cleaned = items.map((item, index) => ({
    ...item,
    id: clean(item.id || `item-${index + 1}`, 120),
    title: clean(item.title, 240),
    updatedAt: new Date().toISOString()
  }));

  const payload = {
    generatedAt: new Date().toISOString(),
    items: cleaned
  };

  await env.MDE_MARKET_KV.put(
    'live-market-feed',
    JSON.stringify(payload)
  );

  return json({
    ok: true,
    stored: cleaned.length,
    generatedAt: payload.generatedAt
  }, 200, { 'Cache-Control': 'no-store' });
}


/* =========================================================
   PRODUCT LOOKUP
========================================================= */

async function lookupProduct(request, env) {
  const url = new URL(request.url);
  const barcode = (url.searchParams.get('barcode') || '').replace(/\D/g, '');

  if (!/^\d{8,14}$/.test(barcode)) {
    return json({ error: 'Valid 8-14 digit barcode required' }, 400);
  }

  const evidence = [];
  let upcItem = null;
  let ebayItem = null;
  let cexItem = null;

  try {
    upcItem = await lookupUpc(barcode, env);
    evidence.push({ source: 'UPCitemdb', ok: !!upcItem });
  } catch (e) {
    evidence.push({ source: 'UPCitemdb', ok: false, error: safeError(e) });
  }

  try {
    cexItem = await lookupCex(barcode);
    evidence.push({ source: 'CeX UK', ok: !!cexItem });
  } catch (e) {
    evidence.push({ source: 'CeX UK', ok: false, error: safeError(e) });
  }

  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    try {
      ebayItem = await lookupEbay(barcode, env);
      evidence.push({ source: 'eBay Browse', ok: !!ebayItem });
    } catch (e) {
      evidence.push({ source: 'eBay Browse', ok: false, error: safeError(e) });
    }
  } else {
    evidence.push({
      source: 'eBay Browse',
      ok: false,
      error: 'Credentials not configured'
    });
  }

  const merged = mergeItems(upcItem, ebayItem, cexItem);

  if (!merged) {
    return json({
      barcode,
      item: null,
      source: null,
      evidence,
      confidence: 0,
      artworkConfidence: 0,
      decision: 'UNRESOLVED',
      exactMatch: false
    }, 404);
  }

  merged.images = unique((merged.images || [])
    .map(normaliseExternalImageUrl)
    .filter(Boolean))
    .map(src => proxyUrlFor(request.url, src))
    .filter(Boolean);

  if (merged.cexReferenceImage) {
    const cleanImage = normaliseExternalImageUrl(merged.cexReferenceImage);
    merged.cexReferenceImage = cleanImage
      ? proxyUrlFor(request.url, cleanImage)
      : '';
  }

  const sourceNames = [
    cexItem && 'CeX UK',
    upcItem && 'UPCitemdb',
    ebayItem && 'eBay Browse'
  ].filter(Boolean);

  const sourceCount = sourceNames.length;
  const exactMatch = sourceCount >= 2 || !!cexItem || !!ebayItem;
  const confidence = Math.min(
    98,
    (merged.title ? 45 : 0) +
    (merged.model ? 15 : 0) +
    (sourceCount * 15) +
    (merged.images?.length ? 8 : 0)
  );
  const artworkConfidence = merged.images?.length
    ? Math.min(95, 65 + (sourceCount * 10))
    : 0;

  return json({
    barcode,
    item: merged,
    source: sourceNames.join(' + '),
    evidence,
    confidence,
    artworkConfidence,
    decision: exactMatch ? 'IDENTIFIED' : 'REVIEW',
    exactMatch
  });
}


/* =========================================================
   IMAGE PROXY
========================================================= */

function normaliseExternalImageUrl(value) {
  let src = clean(value, 2000);
  if (!src) return '';
  if (src.startsWith('//')) src = 'https:' + src;
  src = src.replace(/^http:/i, 'https:');
  return validHttps(src);
}

function proxyUrlFor(requestUrl, src) {
  const cleanUrl = normaliseExternalImageUrl(src);
  if (!cleanUrl) return '';
  const base = new URL(requestUrl);
  return base.origin + '/image?url=' + encodeURIComponent(cleanUrl);
}

function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) return true;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  if (
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:')
  ) return true;

  return false;
}

async function proxyImage(url) {
  const cleanUrl = normaliseExternalImageUrl(url.searchParams.get('url') || '');
  if (!cleanUrl) return new Response('Bad image URL', { status: 400, headers: corsHeaders });

  const target = new URL(cleanUrl);
  if (isBlockedHost(target.hostname)) {
    return new Response('Image host blocked', { status: 403, headers: corsHeaders });
  }

  try {
    const response = await fetch(target.toString(), {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; MediaDealEngine/8.1)',
        Referer: target.origin + '/'
      },
      redirect: 'follow',
      cf: { cacheEverything: true, cacheTtl: 86400 }
    });

    if (!response.ok) {
      return new Response('Image fetch failed', {
        status: response.status,
        headers: corsHeaders
      });
    }

    let contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      const path = target.pathname.toLowerCase();
      if (/\.(jpg|jpeg)$/.test(path)) contentType = 'image/jpeg';
      else if (/\.png$/.test(path)) contentType = 'image/png';
      else if (/\.webp$/.test(path)) contentType = 'image/webp';
      else if (/\.gif$/.test(path)) contentType = 'image/gif';
      else {
        return new Response('Not an image', { status: 415, headers: corsHeaders });
      }
    }

    const headers = new Headers(corsHeaders);
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    headers.set('X-Content-Type-Options', 'nosniff');

    return new Response(response.body, { status: 200, headers });
  } catch (e) {
    return new Response('Image proxy error: ' + safeError(e), {
      status: 502,
      headers: corsHeaders
    });
  }
}


/* =========================================================
   UPC ITEM DB
========================================================= */

async function lookupUpc(barcode, env) {
  const paid = env.UPCITEMDB_USER_KEY;
  const endpoint = paid
    ? 'https://api.upcitemdb.com/prod/v1/lookup'
    : 'https://api.upcitemdb.com/prod/trial/lookup';

  const headers = { Accept: 'application/json' };
  if (paid) {
    headers.user_key = env.UPCITEMDB_USER_KEY;
    headers.key_type = env.UPCITEMDB_KEY_TYPE || '3scale';
  }

  const response = await fetch(
    endpoint + '?upc=' + encodeURIComponent(barcode),
    { headers }
  );

  if (!response.ok) throw new Error('UPC lookup HTTP ' + response.status);

  const data = await response.json();
  const x = data.items && data.items[0];
  if (!x) return null;

  return {
    title: x.title || '',
    platform: '',
    brand: x.brand || '',
    category: x.category || '',
    model: x.model || '',
    description: x.description || '',
    images: Array.isArray(x.images) ? x.images : [],
    sourceUrl: ''
  };
}


/* =========================================================
   CEX UK
========================================================= */

async function lookupCex(barcode) {
  const response = await fetch(
    'https://wss2.cex.uk.webuy.io/v3/boxes/' +
      encodeURIComponent(barcode) +
      '/detail',
    { headers: { Accept: 'application/json' } }
  );

  if (!response.ok) throw new Error('CeX lookup HTTP ' + response.status);

  const data = await response.json();
  const x = data && data.boxDetails && data.boxDetails[0];
  if (!x) return null;

  const urls = x.imageUrls || {};
  const image = normaliseExternalImageUrl(
    urls.large || urls.medium || urls.small || ''
  );

  return {
    title: x.boxName || '',
    platform: '',
    brand: x.publisher || x.manufacturer || '',
    category: x.categoryName || x.categoryFriendlyName || '',
    model: x.boxId || barcode,
    description: [x.categoryFriendlyName, x.superCatFriendlyName]
      .filter(Boolean)
      .join(' · '),
    images: image ? [image] : [],
    cexReferenceImage: image,
    sourceUrl:
      'https://uk.webuy.com/product-detail/?id=' +
      encodeURIComponent(x.boxId || barcode),
    cex: {
      sellPrice: num(x.sellPrice),
      cashPrice: num(x.cashPrice),
      exchangePrice: num(x.exchangePrice),
      boxId: x.boxId || barcode
    }
  };
}


/* =========================================================
   EBAY
========================================================= */

async function getEbayToken(env) {
  const now = Date.now();

  if (
    ebayTokenCache.token &&
    ebayTokenCache.expiresAt > now + 60000
  ) return ebayTokenCache.token;

  const basic = btoa(env.EBAY_CLIENT_ID + ':' + env.EBAY_CLIENT_SECRET);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope'
  });

  const response = await fetch(
    'https://api.ebay.com/identity/v1/oauth2/token',
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + basic,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    }
  );

  if (!response.ok) throw new Error('eBay OAuth HTTP ' + response.status);

  const data = await response.json();
  ebayTokenCache = {
    token: data.access_token,
    expiresAt: now + ((data.expires_in || 7200) * 1000)
  };

  return ebayTokenCache.token;
}

async function lookupEbay(barcode, env) {
  const token = await getEbayToken(env);
  const market = env.EBAY_MARKETPLACE_ID || 'EBAY_GB';

  const url = new URL(
    'https://api.ebay.com/buy/browse/v1/item_summary/search'
  );
  url.searchParams.set('gtin', barcode);
  url.searchParams.set('limit', '20');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: 'Bearer ' + token,
      'X-EBAY-C-MARKETPLACE-ID': market,
      Accept: 'application/json'
    }
  });

  if (!response.ok) throw new Error('eBay Browse HTTP ' + response.status);

  const data = await response.json();
  const items = data.itemSummaries || [];
  if (!items.length) return null;

  const x = items[0];
  const images = [];

  for (const item of items.slice(0, 8)) {
    if (item.image && item.image.imageUrl) images.push(item.image.imageUrl);
    for (const img of (item.additionalImages || [])) {
      if (img && img.imageUrl) images.push(img.imageUrl);
    }
  }

  const aspects = x.localizedAspects || [];
  const getAspect = name => {
    const a = aspects.find(v =>
      String(v.name || '').toLowerCase() === name.toLowerCase()
    );
    return a ? a.value || '' : '';
  };

  return {
    title: x.title || '',
    platform: getAspect('Platform') || '',
    brand: getAspect('Brand') || '',
    category:
      (x.categories && x.categories[0] && x.categories[0].categoryName) || '',
    model: getAspect('Model') || getAspect('Edition') || '',
    description: [
      x.condition,
      getAspect('Platform'),
      getAspect('Format')
    ].filter(Boolean).join(' · '),
    images: unique(images.map(normaliseExternalImageUrl).filter(Boolean)),
    sourceUrl: x.itemWebUrl || '',
    activePrice: x.price
      ? {
          value: num(x.price.value),
          currency: x.price.currency
        }
      : null
  };
}


/* =========================================================
   MERGE LOOKUP SOURCES
========================================================= */

function mergeItems(primary, ebay, cex) {
  if (!primary && !ebay && !cex) return null;

  const a = primary || {};
  const b = ebay || {};
  const c = cex || {};

  const images = unique([
    ...(b.images || []),
    ...(a.images || []),
    ...(c.images || []),
    c.cexReferenceImage || ''
  ].map(normaliseExternalImageUrl).filter(Boolean));

  return {
    title: c.title || a.title || b.title || '',
    platform: b.platform || a.platform || c.platform || '',
    brand: a.brand || b.brand || c.brand || '',
    category: c.category || a.category || b.category || '',
    model: a.model || b.model || c.model || '',
    description: a.description || c.description || b.description || '',
    images,
    cexReferenceImage: normaliseExternalImageUrl(c.cexReferenceImage || ''),
    sourceUrl: b.sourceUrl || c.sourceUrl || a.sourceUrl || '',
    activePrice: b.activePrice || null,
    cex: c.cex || null
  };
}
