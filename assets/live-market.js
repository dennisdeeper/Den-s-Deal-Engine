(() => {
  'use strict';

  const API = 'https://deal-engine-api.dennis-deeper.workers.dev';
  const STATIC_FEED = 'data/live-market.json';

  const grid = document.getElementById('marketGrid');
  const empty = document.getElementById('emptyState');
  const feedStatus = document.getElementById('feedStatus');
  const feedTime = document.getElementById('feedTime');
  const filters = [...document.querySelectorAll('.filter')];

  let items = [];
  let activeFilter = 'all';

  const esc = (v='') => String(v).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[c]));

  const money = v =>
    Number.isFinite(Number(v)) ? '£' + Number(v).toFixed(2) : '—';

  function parseDate(v){
    if(!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function isFresh(v, maxHours=12){
    const d = parseDate(v);
    if(!d) return false;
    const age = Date.now() - d.getTime();
    return age >= 0 && age <= maxHours * 3600000;
  }

  function isLive(item){
    if(!item || String(item.status || '').toLowerCase() !== 'live') return false;
    if(!isFresh(item.verifiedAt, Number(item.maxVerificationAgeHours || 12))) return false;

    const expiry = parseDate(item.expiresAt);
    if(expiry && expiry.getTime() <= Date.now()) return false;

    if(item.availability && /sold out|out of stock|unavailable|ended|expired/i.test(item.availability)) {
      return false;
    }

    if(item.marginSafe === false) return false;
    return true;
  }

  function filterMatch(item){
    if(activeFilter === 'all') return true;
    const channel = String(item.channel || '').toLowerCase();
    if(activeFilter === 'discovery') return channel === 'discovery';

    const type = String(item.dealType || '').toLowerCase();
    const tags = Array.isArray(item.tags)
      ? item.tags.map(x => String(x).toLowerCase())
      : [];
    return type === activeFilter || tags.includes(activeFilter);
  }

  function countdown(expiresAt){
    const d = parseDate(expiresAt);
    if(!d) return '';
    const diff = d.getTime() - Date.now();
    if(diff <= 0) return 'ENDED';

    const mins = Math.floor(diff / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;

    if(days > 0) return `${days}d ${hours}h`;
    return `${String(hours).padStart(2,'0')}h ${String(minutes).padStart(2,'0')}m`;
  }

  function publicSeller(item){
    if(item.publicSeller) return item.publicSeller;
    const channel = String(item.channel || '').toLowerCase();
    if(['affiliate', 'discovery'].includes(channel) && item.retailer) {
      return item.retailer;
    }
    return 'Media Deal Engine';
  }

  function card(item){
    const channel = String(item.channel || '').toLowerCase();
    const isDiscovery = channel === 'discovery';

    const roi = Number(item.roi);
    const roiClass = Number.isFinite(roi) && roi >= 50 ? 'good' : 'watch';
    const savingPct = Number(item.savingPct);
    const timer = item.expiresAt ? countdown(item.expiresAt) : '';
    const verified = parseDate(item.verifiedAt);
    const verifiedText = verified
      ? verified.toLocaleString('en-GB', {dateStyle:'short', timeStyle:'short'})
      : '—';

    const middleLabel = isDiscovery ? 'RRP' : 'MARKET';
    const middleValue = isDiscovery
      ? money(item.referencePrice)
      : (
          Number.isFinite(Number(item.marketLow)) ||
          Number.isFinite(Number(item.marketHigh))
            ? `${money(item.marketLow)}–${money(item.marketHigh)}`
            : '—'
        );

    const thirdLabel = isDiscovery ? 'SAVE' : 'ROI';
    const thirdValue = isDiscovery
      ? (Number.isFinite(savingPct) ? Math.round(savingPct) + '%' : '—')
      : (Number.isFinite(roi) ? Math.round(roi) + '%' : '—');

    const ctaLabel =
      channel === 'affiliate'
        ? 'VIEW PARTNER OFFER'
        : isDiscovery
          ? 'VIEW RETAILER'
          : 'VIEW OFFER';

    return `
      <article class="deal" data-id="${esc(item.id || '')}">
        <div class="media">
          ${item.image
            ? `<img src="${esc(item.image)}" alt="${esc(item.title || 'Product artwork')}" loading="lazy">`
            : `<div class="noimg">EXACT ARTWORK PENDING</div>`}
        </div>
        <div class="body">
          <div class="eyebrow">
            <span class="signal">${esc(item.signal || item.dealType || 'VERIFIED')}</span>
            <span class="timer" data-expiry="${esc(item.expiresAt || '')}">
              ${timer ? `ENDS ${esc(timer)}` : 'SUBJECT TO AVAILABILITY'}
            </span>
          </div>
          <h3>${esc(item.title || 'Untitled product')}</h3>
          <div class="meta">
            ${esc([item.format, item.label, item.region, publicSeller(item)]
              .filter(Boolean).join(' · '))}
          </div>

          <div class="prices">
            <div class="metric">
              <small>${isDiscovery ? 'RETAIL PRICE' : 'MDE PRICE'}</small>
              <b>${money(item.price)}</b>
            </div>
            <div class="metric">
              <small>${middleLabel}</small>
              <b>${middleValue}</b>
            </div>
            <div class="metric">
              <small>${thirdLabel}</small>
              <b class="roi ${isDiscovery ? 'good' : roiClass}">${thirdValue}</b>
            </div>
          </div>

          ${item.offerText
            ? `<div class="reason"><strong>${esc(item.offerText)}</strong></div>`
            : ''}

          <div class="reason">${esc(item.reason || 'Verified MDE opportunity.')}</div>
          <div class="availability">
            ${esc(item.availability || 'Availability verified')}
            · Verified ${esc(verifiedText)}
          </div>

          ${item.url
            ? `<a class="cta" href="${esc(item.url)}" rel="${channel === 'affiliate' ? 'nofollow sponsored noopener' : 'nofollow noopener'}" target="_blank">${ctaLabel}</a>`
            : ''}

          ${channel === 'affiliate'
            ? `<div class="disclosure">Affiliate link: MDE may earn a commission if you purchase. This does not affect MDE scoring.</div>`
            : ''}

          ${isDiscovery
            ? `<div class="disclosure">Retail discovery link. No affiliate relationship is assumed by this card.</div>`
            : ''}
        </div>
      </article>`;
  }

  function render(){
    const visible = items.filter(isLive).filter(filterMatch);
    grid.innerHTML = visible.map(card).join('');
    empty.hidden = visible.length !== 0;
  }

  async function fetchJson(url){
    const r = await fetch(url, {cache:'no-store'});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function load(){
    let data = null;
    let sourceLabel = 'MDE API';

    try{
      data = await fetchJson(API + '/live-market');
    }catch(apiError){
      sourceLabel = 'safe fallback feed';
      try{
        data = await fetchJson(STATIC_FEED);
      }catch(staticError){
        data = {items:[]};
        sourceLabel = 'offline-safe mode';
      }
    }

    const list = Array.isArray(data)
      ? data
      : Array.isArray(data.items)
        ? data.items
        : [];

    items = list;
    const liveCount = items.filter(isLive).length;

    if(sourceLabel === 'offline-safe mode'){
      feedStatus.textContent = 'Live feed unavailable · no unverified deals shown';
      feedStatus.className = 'warn';
    }else{
      feedStatus.textContent = liveCount
        ? `${liveCount} verified live opportunit${liveCount === 1 ? 'y' : 'ies'} · ${sourceLabel}`
        : `Feed connected · no verified live opportunities · ${sourceLabel}`;
      feedStatus.className = liveCount ? 'live' : '';
    }

    const stamp = parseDate(data.verifiedAt || data.generatedAt);
    feedTime.textContent = 'Last verified: ' + (
      stamp
        ? stamp.toLocaleString('en-GB', {dateStyle:'short', timeStyle:'short'})
        : 'per-item verification'
    );

    render();
  }

  filters.forEach(btn => btn.addEventListener('click', () => {
    filters.forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter || 'all';
    render();
  }));

  setInterval(() => {
    document.querySelectorAll('[data-expiry]').forEach(el => {
      const expiry = el.getAttribute('data-expiry');
      if(!expiry) return;
      const text = countdown(expiry);
      el.textContent = text === 'ENDED' ? 'ENDED' : `ENDS ${text}`;
    });

    render();
  }, 30000);

  load();
  setInterval(load, 5 * 60 * 1000);
})();
