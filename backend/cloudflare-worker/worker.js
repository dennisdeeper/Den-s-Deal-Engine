let ebayTokenCache = {
  token: null,
  expiresAt: 0
};


/* =========================================================
   CORS / COMMON HEADERS
========================================================= */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};


function json(body, status = 200) {

  const headers =
    new Headers(corsHeaders);

  headers.set(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  return new Response(
    JSON.stringify(body),
    {
      status,
      headers
    }
  );
}


function safeError(e) {

  return String(
    e && e.message
      ? e.message
      : e
  ).slice(0, 180);

}



/* =========================================================
   MAIN WORKER
========================================================= */

export default {

  async fetch(request, env) {

    if (request.method === 'OPTIONS') {

      return new Response(
        null,
        {
          headers: corsHeaders
        }
      );

    }


    const url =
      new URL(request.url);


    /* -----------------------------------------
       IMAGE PROXY
    ----------------------------------------- */

    if (url.pathname === '/image') {

      return proxyImage(
        url,
        request
      );

    }


    /* -----------------------------------------
       HEALTH CHECK
    ----------------------------------------- */

    if (url.pathname === '/health') {

      return json({

        ok: true,

        service:
          "Den's Deal Engine lookup",

        ebayConfigured:
          !!(
            env.EBAY_CLIENT_ID &&
            env.EBAY_CLIENT_SECRET
          ),

        artworkProxy:
          true,

        version:
          '7.8-artwork-fix'

      });

    }


    /* -----------------------------------------
       LOOKUP ONLY
    ----------------------------------------- */

    if (url.pathname !== '/lookup') {

      return json(
        {
          error: 'Not found'
        },
        404
      );

    }


    const barcode =
      (
        url.searchParams.get(
          'barcode'
        ) || ''
      )
      .replace(
        /\D/g,
        ''
      );


    if (
      !/^\d{8,14}$/
      .test(barcode)
    ) {

      return json(
        {
          error:
            'Valid 8-14 digit barcode required'
        },
        400
      );

    }


    const evidence = [];

    let upcItem = null;

    let ebayItem = null;

    let cexItem = null;



    /* -----------------------------------------
       UPC ITEM DB
    ----------------------------------------- */

    try {

      upcItem =
        await lookupUpc(
          barcode,
          env
        );


      evidence.push({

        source:
          'UPCitemdb',

        ok:
          !!upcItem

      });

    }
    catch (e) {

      evidence.push({

        source:
          'UPCitemdb',

        ok:
          false,

        error:
          safeError(e)

      });

    }



    /* -----------------------------------------
       CEX
    ----------------------------------------- */

    try {

      cexItem =
        await lookupCex(
          barcode
        );


      evidence.push({

        source:
          'CeX UK',

        ok:
          !!cexItem

      });

    }
    catch (e) {

      evidence.push({

        source:
          'CeX UK',

        ok:
          false,

        error:
          safeError(e)

      });

    }



    /* -----------------------------------------
       EBAY
    ----------------------------------------- */

    if (
      env.EBAY_CLIENT_ID &&
      env.EBAY_CLIENT_SECRET
    ) {

      try {

        ebayItem =
          await lookupEbay(
            barcode,
            env
          );


        evidence.push({

          source:
            'eBay Browse',

          ok:
            !!ebayItem

        });

      }
      catch (e) {

        evidence.push({

          source:
            'eBay Browse',

          ok:
            false,

          error:
            safeError(e)

        });

      }

    }
    else {

      evidence.push({

        source:
          'eBay Browse',

        ok:
          false,

        error:
          'Credentials not configured'

      });

    }



    /* -----------------------------------------
       MERGE IDENTITY
    ----------------------------------------- */

    const merged =
      mergeItems(
        upcItem,
        ebayItem,
        cexItem
      );


    if (!merged) {

      return json(
        {
          barcode,
          item: null,
          source: null,
          evidence
        },
        404
      );

    }



    /* -----------------------------------------
       ARTWORK URL NORMALISATION

       Important:
       All artwork is normalised BEFORE
       being sent through /image.

       This fixes:
       //host/image.jpg
       http://host/image.jpg
       malformed / empty URLs
    ----------------------------------------- */

    merged.images =
      [
        ...new Set(
          (
            merged.images || []
          )
          .map(
            src =>
              normaliseExternalImageUrl(
                src
              )
          )
          .filter(Boolean)
        )
      ]
      .map(
        src =>
          proxyUrlFor(
            request.url,
            src
          )
      )
      .filter(Boolean);


    if (
      merged.cexReferenceImage
    ) {

      const cleanCexImage =
        normaliseExternalImageUrl(
          merged.cexReferenceImage
        );


      merged.cexReferenceImage =
        cleanCexImage
          ? proxyUrlFor(
              request.url,
              cleanCexImage
            )
          : '';

    }


    return json({

      barcode,

      item:
        merged,

      source:
        [
          cexItem &&
          'CeX UK',

          upcItem &&
          'UPCitemdb',

          ebayItem &&
          'eBay Browse'
        ]
        .filter(Boolean)
        .join(' + '),

      evidence

    });

  }

};



/* =========================================================
   IMAGE URL NORMALISATION
========================================================= */

function normaliseExternalImageUrl(value) {

  let src =
    String(
      value || ''
    )
    .trim();


  if (!src) {

    return '';

  }


  /*
    Fix protocol-relative URLs:
    //example.com/image.jpg
  */

  if (
    src.startsWith('//')
  ) {

    src =
      'https:' +
      src;

  }


  /*
    Upgrade old http image links.
  */

  src =
    src.replace(
      /^http:/i,
      'https:'
    );


  let parsed;


  try {

    parsed =
      new URL(src);

  }
  catch {

    return '';

  }


  if (
    parsed.protocol !==
    'https:'
  ) {

    return '';

  }


  return parsed.toString();

}



/* =========================================================
   IMAGE PROXY URL
========================================================= */

function proxyUrlFor(
  requestUrl,
  src
) {

  const clean =
    normaliseExternalImageUrl(
      src
    );


  if (!clean) {

    return '';

  }


  const base =
    new URL(
      requestUrl
    );


  return (
    base.origin +
    '/image?url=' +
    encodeURIComponent(
      clean
    )
  );

}



/* =========================================================
   IMAGE SECURITY
========================================================= */

function isBlockedHost(hostname) {

  const host =
    String(
      hostname || ''
    )
    .toLowerCase();


  if (!host) {

    return true;

  }


  /*
    Never allow internal / local addresses
    through the public image proxy.
  */

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {

    return true;

  }


  /*
    IPv4 checks
  */

  if (
    /^\d+\.\d+\.\d+\.\d+$/
    .test(host)
  ) {

    const parts =
      host
      .split('.')
      .map(Number);


    const [
      a,
      b
    ] =
      parts;


    if (
      a === 10 ||
      a === 127 ||
      a === 0
    ) {

      return true;

    }


    if (
      a === 169 &&
      b === 254
    ) {

      return true;

    }


    if (
      a === 172 &&
      b >= 16 &&
      b <= 31
    ) {

      return true;

    }


    if (
      a === 192 &&
      b === 168
    ) {

      return true;

    }

  }


  /*
    Basic IPv6 local ranges
  */

  if (
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:')
  ) {

    return true;

  }


  return false;

}



/* =========================================================
   IMAGE PROXY

   V7.8:
   Instead of rejecting most legitimate catalogue
   image hosts, accept public HTTPS image URLs while
   blocking local/private network destinations.

   This is important because UPCitemdb can return
   images from many retailer/CDN domains.
========================================================= */

async function proxyImage(
  url,
  request
) {

  const raw =
    url.searchParams.get(
      'url'
    ) || '';


  const clean =
    normaliseExternalImageUrl(
      raw
    );


  if (!clean) {

    return new Response(
      'Bad image URL',
      {
        status: 400,
        headers:
          corsHeaders
      }
    );

  }


  let target;


  try {

    target =
      new URL(clean);

  }
  catch {

    return new Response(
      'Bad image URL',
      {
        status: 400,
        headers:
          corsHeaders
      }
    );

  }


  if (
    isBlockedHost(
      target.hostname
    )
  ) {

    return new Response(
      'Image host blocked',
      {
        status: 403,
        headers:
          corsHeaders
      }
    );

  }


  try {

    const response =
      await fetch(
        target.toString(),
        {

          headers: {

            'Accept':
              'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',

            'User-Agent':
              'Mozilla/5.0 (compatible; DensDealEngine/7.8)',

            'Referer':
              target.origin + '/'

          },

          redirect:
            'follow',

          cf: {

            cacheEverything:
              true,

            cacheTtl:
              86400

          }

        }
      );


    if (!response.ok) {

      return new Response(
        'Image fetch failed',
        {
          status:
            response.status,

          headers:
            corsHeaders
        }
      );

    }


    const contentType =
      response.headers
      .get(
        'content-type'
      ) || '';


    /*
      Some CDNs omit the correct content type.
      Accept known image responses and fall back
      to JPEG where appropriate.
    */

    let finalContentType =
      contentType;


    if (
      !finalContentType
      .toLowerCase()
      .startsWith(
        'image/'
      )
    ) {

      const path =
        target.pathname
        .toLowerCase();


      if (
        /\.(jpg|jpeg)$/
        .test(path)
      ) {

        finalContentType =
          'image/jpeg';

      }
      else if (
        /\.png$/
        .test(path)
      ) {

        finalContentType =
          'image/png';

      }
      else if (
        /\.webp$/
        .test(path)
      ) {

        finalContentType =
          'image/webp';

      }
      else if (
        /\.gif$/
        .test(path)
      ) {

        finalContentType =
          'image/gif';

      }
      else {

        return new Response(
          'Not an image',
          {
            status: 415,
            headers:
              corsHeaders
          }
        );

      }

    }


    const headers =
      new Headers(
        corsHeaders
      );


    headers.set(
      'Content-Type',
      finalContentType
    );


    headers.set(
      'Cache-Control',
      'public, max-age=86400, s-maxage=86400'
    );


    headers.set(
      'X-Content-Type-Options',
      'nosniff'
    );


    return new Response(
      response.body,
      {
        status: 200,
        headers
      }
    );

  }
  catch (e) {

    return new Response(
      'Image proxy error: ' +
      safeError(e),
      {
        status: 502,
        headers:
          corsHeaders
      }
    );

  }

}



/* =========================================================
   UPC ITEM DB
========================================================= */

async function lookupUpc(
  barcode,
  env
) {

  const paid =
    env.UPCITEMDB_USER_KEY;


  const endpoint =
    paid
      ? 'https://api.upcitemdb.com/prod/v1/lookup'
      : 'https://api.upcitemdb.com/prod/trial/lookup';


  const headers = {

    Accept:
      'application/json'

  };


  if (paid) {

    headers.user_key =
      env.UPCITEMDB_USER_KEY;


    headers.key_type =
      env.UPCITEMDB_KEY_TYPE ||
      '3scale';

  }


  const response =
    await fetch(

      endpoint +
      '?upc=' +
      encodeURIComponent(
        barcode
      ),

      {
        headers
      }

    );


  if (!response.ok) {

    throw new Error(
      'UPC lookup HTTP ' +
      response.status
    );

  }


  const data =
    await response.json();


  const x =
    data.items &&
    data.items[0];


  if (!x) {

    return null;

  }


  return {

    title:
      x.title || '',

    brand:
      x.brand || '',

    category:
      x.category || '',

    model:
      x.model || '',

    description:
      x.description || '',

    images:
      Array.isArray(
        x.images
      )
        ? x.images
        : [],

    sourceUrl:
      ''

  };

}



/* =========================================================
   CEX UK
========================================================= */

async function lookupCex(
  barcode
) {

  const response =
    await fetch(

      'https://wss2.cex.uk.webuy.io/v3/boxes/' +
      encodeURIComponent(
        barcode
      ) +
      '/detail',

      {

        headers: {

          'Accept':
            'application/json'

        }

      }

    );


  if (!response.ok) {

    throw new Error(
      'CeX lookup HTTP ' +
      response.status
    );

  }


  const data =
    await response.json();


  const x =
    data &&
    data.boxDetails &&
    data.boxDetails[0];


  if (!x) {

    return null;

  }


  const urls =
    x.imageUrls ||
    {};


  const rawImage =
    urls.large ||
    urls.medium ||
    urls.small ||
    '';


  const image =
    normaliseExternalImageUrl(
      rawImage
    );


  return {

    title:
      x.boxName || '',

    brand:
      x.publisher ||
      x.manufacturer ||
      '',

    category:
      x.categoryName ||
      x.categoryFriendlyName ||
      '',

    model:
      x.boxId ||
      barcode,

    description:
      [
        x.categoryFriendlyName,
        x.superCatFriendlyName
      ]
      .filter(Boolean)
      .join(' · '),

    images:
      image
        ? [image]
        : [],

    cexReferenceImage:
      image,

    sourceUrl:
      'https://uk.webuy.com/product-detail/?id=' +
      encodeURIComponent(
        x.boxId ||
        barcode
      ),

    cex: {

      sellPrice:
        Number(
          x.sellPrice
        ),

      cashPrice:
        Number(
          x.cashPrice
        ),

      exchangePrice:
        Number(
          x.exchangePrice
        ),

      boxId:
        x.boxId ||
        barcode

    }

  };

}



/* =========================================================
   EBAY OAUTH
========================================================= */

async function getEbayToken(
  env
) {

  const now =
    Date.now();


  if (
    ebayTokenCache.token &&
    ebayTokenCache.expiresAt >
      now + 60000
  ) {

    return ebayTokenCache.token;

  }


  const basic =
    btoa(
      env.EBAY_CLIENT_ID +
      ':' +
      env.EBAY_CLIENT_SECRET
    );


  const body =
    new URLSearchParams({

      grant_type:
        'client_credentials',

      scope:
        'https://api.ebay.com/oauth/api_scope'

    });


  const response =
    await fetch(

      'https://api.ebay.com/identity/v1/oauth2/token',

      {

        method:
          'POST',

        headers: {

          'Authorization':
            'Basic ' +
            basic,

          'Content-Type':
            'application/x-www-form-urlencoded'

        },

        body

      }

    );


  if (!response.ok) {

    throw new Error(
      'eBay OAuth HTTP ' +
      response.status
    );

  }


  const data =
    await response.json();


  ebayTokenCache = {

    token:
      data.access_token,

    expiresAt:
      now +
      (
        (
          data.expires_in ||
          7200
        ) *
        1000
      )

  };


  return ebayTokenCache.token;

}



/* =========================================================
   EBAY LOOKUP
========================================================= */

async function lookupEbay(
  barcode,
  env
) {

  const token =
    await getEbayToken(
      env
    );


  const market =
    env.EBAY_MARKETPLACE_ID ||
    'EBAY_GB';


  const url =
    new URL(
      'https://api.ebay.com/buy/browse/v1/item_summary/search'
    );


  url.searchParams.set(
    'gtin',
    barcode
  );


  url.searchParams.set(
    'limit',
    '20'
  );


  const response =
    await fetch(

      url.toString(),

      {

        headers: {

          'Authorization':
            'Bearer ' +
            token,

          'X-EBAY-C-MARKETPLACE-ID':
            market,

          'Accept':
            'application/json'

        }

      }

    );


  if (!response.ok) {

    throw new Error(
      'eBay Browse HTTP ' +
      response.status
    );

  }


  const data =
    await response.json();


  const items =
    data.itemSummaries ||
    [];


  if (!items.length) {

    return null;

  }


  const x =
    items[0];


  /*
    Preserve multiple GTIN-linked artwork
    candidates so the browser can recover
    if one CDN URL is unavailable.
  */

  const exactImages =
    [];


  for (
    const item
    of items.slice(0, 8)
  ) {

    if (
      item.image &&
      item.image.imageUrl
    ) {

      exactImages.push(
        item.image.imageUrl
      );

    }


    for (
      const img
      of (
        item.additionalImages ||
        []
      )
    ) {

      if (
        img &&
        img.imageUrl
      ) {

        exactImages.push(
          img.imageUrl
        );

      }

    }

  }


  const aspects =
    x.localizedAspects ||
    [];


  const getAspect =
    name => {

      const a =
        aspects.find(

          v =>
            (
              v.name ||
              ''
            )
            .toLowerCase() ===
            name.toLowerCase()

        );


      return a
        ? a.value || ''
        : '';

    };


  const cleanedImages =
    [
      ...new Set(
        exactImages
        .map(
          normaliseExternalImageUrl
        )
        .filter(Boolean)
      )
    ];


  return {

    title:
      x.title || '',

    brand:
      getAspect(
        'Brand'
      ) || '',

    category:
      (
        x.categories &&
        x.categories[0] &&
        x.categories[0]
        .categoryName
      ) ||
      '',

    model:
      getAspect(
        'Model'
      ) ||
      getAspect(
        'Edition'
      ) ||
      '',

    description:
      [
        x.condition,
        getAspect(
          'Platform'
        ),
        getAspect(
          'Format'
        )
      ]
      .filter(Boolean)
      .join(' · '),

    images:
      cleanedImages,

    sourceUrl:
      x.itemWebUrl ||
      '',

    activePrice:
      x.price
        ? {
            value:
              Number(
                x.price.value
              ),

            currency:
              x.price.currency
          }
        : null

  };

}



/* =========================================================
   MERGE SOURCES
========================================================= */

function mergeItems(
  primary,
  ebay,
  cex
) {

  if (
    !primary &&
    !ebay &&
    !cex
  ) {

    return null;

  }


  const a =
    primary || {};


  const b =
    ebay || {};


  const c =
    cex || {};


  const images =
    [
      ...(
        b.images ||
        []
      ),

      ...(
        a.images ||
        []
      ),

      ...(
        c.images ||
        []
      ),

      c.cexReferenceImage ||
      ''
    ]
    .map(
      normaliseExternalImageUrl
    )
    .filter(Boolean);


  return {

    title:
      c.title ||
      a.title ||
      b.title ||
      '',

    brand:
      a.brand ||
      b.brand ||
      c.brand ||
      '',

    category:
      c.category ||
      a.category ||
      b.category ||
      '',

    model:
      a.model ||
      b.model ||
      c.model ||
      '',

    description:
      a.description ||
      c.description ||
      b.description ||
      '',

    images:
      [
        ...new Set(
          images
        )
      ],

    cexReferenceImage:
      normaliseExternalImageUrl(
        c.cexReferenceImage ||
        ''
      ),

    sourceUrl:
      b.sourceUrl ||
      c.sourceUrl ||
      a.sourceUrl ||
      '',

    activePrice:
      b.activePrice ||
      null,

    cex:
      c.cex ||
      null

  };

}
