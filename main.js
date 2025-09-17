// Standalone Playwright script: Auction.com CWCOT detector
import { chromium } from 'playwright';
import fs from 'fs/promises';

// Small helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ERR_RE = /(detached frame|frame was detached|Execution context was destroyed|Cannot find context|Target closed|Navigation failed|Connection closed)/i;

// State abbreviation mapping
const STATE_CODES = {
  'AL': 'alabama', 'AK': 'alaska', 'AZ': 'arizona', 'AR': 'arkansas', 'CA': 'california',
  'CO': 'colorado', 'CT': 'connecticut', 'DE': 'delaware', 'FL': 'florida', 'GA': 'georgia',
  'HI': 'hawaii', 'ID': 'idaho', 'IL': 'illinois', 'IN': 'indiana', 'IA': 'iowa',
  'KS': 'kansas', 'KY': 'kentucky', 'LA': 'louisiana', 'ME': 'maine', 'MD': 'maryland',
  'MA': 'massachusetts', 'MI': 'michigan', 'MN': 'minnesota', 'MS': 'mississippi', 'MO': 'missouri',
  'MT': 'montana', 'NE': 'nebraska', 'NV': 'nevada', 'NH': 'new-hampshire', 'NJ': 'new-jersey',
  'NM': 'new-mexico', 'NY': 'new-york', 'NC': 'north-carolina', 'ND': 'north-dakota', 'OH': 'ohio',
  'OK': 'oklahoma', 'OR': 'oregon', 'PA': 'pennsylvania', 'RI': 'rhode-island', 'SC': 'south-carolina',
  'SD': 'south-dakota', 'TN': 'tennessee', 'TX': 'texas', 'UT': 'utah', 'VT': 'vermont',
  'VA': 'virginia', 'WA': 'washington', 'WV': 'west-virginia', 'WI': 'wisconsin', 'WY': 'wyoming'
};
async function safe(fn, tries = 5, wait = 450) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (String(e).includes('Page is closed')) throw e; // Don't retry if page is explicitly closed
      if (!ERR_RE.test(String(e)) || i === tries - 1) throw e;
      await sleep(wait * (i + 1));
    }
  }
  throw last;
}

function toAbs(href, base = 'https://www.auction.com') {
  try { if (!href) return ''; if (/^https?:\/\//i.test(href)) return href; if (href.startsWith('//')) return 'https:' + href; if (href.startsWith('/')) return base.replace(/\/+$/, '') + href; return base.replace(/\/+$/, '') + '/' + href.replace(/^\.?\//, ''); } catch { return href || ''; }
}

function isPdfUrl(u){
  try{
    if(!u) return false;
    const s=String(u);
    if(/\.pdf(\?|$)/i.test(s)) return true;
    if(/imgix\.net\/resi\/globalDocuments\//i.test(s)) return true;
    return false;
  }catch{ return false; }
}

function cookiesFromHeader(header) {
  if (!header) return []; return header.split(/; */).map(kv => { const i = kv.indexOf('='); if (i < 0) return null; return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim(), domain: '.auction.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' }; }).filter(Boolean);
}

// (State support removed during revert)

async function loadConfig() {
  const arg = process.argv.find(a => a.startsWith('--input='));
  const inputPath = arg ? arg.split('=')[1] : 'input.json';
  const raw = await fs.readFile(inputPath, 'utf-8');
  let cfg = JSON.parse(raw); if (Array.isArray(cfg)) cfg = cfg[0] || {};
  return {
    cookieHeader: cfg.cookieHeader || '',
    zip: cfg.zip ? String(cfg.zip) : '',
    state: cfg.state ? String(cfg.state).toUpperCase() : '',
    detailUrls: Array.isArray(cfg.detailUrls) ? cfg.detailUrls.filter(Boolean) : (cfg.detailUrls ? [cfg.detailUrls] : []),
    maxProperties: Number(cfg.maxProperties ?? ((Array.isArray(cfg.detailUrls) ? cfg.detailUrls.length : 1) || 1)),
    debug: !!cfg.debug,
    validateCookies: !!cfg.validateCookies,
    headless: cfg.headless !== undefined ? !!cfg.headless : true,
    username: cfg.username || process.env.AUCTION_USERNAME || '',
    password: cfg.password || process.env.AUCTION_PASSWORD || '',
    output: cfg.output || 'report.json',
    detectTimeoutMs: Number(cfg.detectTimeoutMs ?? 5000)
  };
}

async function setTimeouts(page){ try{ page.setDefaultNavigationTimeout(90000); }catch{} try{ page.setDefaultTimeout(35000); }catch{} }
async function lighten(page){ if(page.__lightenApplied) return; page.__lightenApplied=true; try{ await page.route('**/*', (route)=>{ try{ const req=route.request(); const url=req.url()||''; const type=req.resourceType(); if(/imgix\.net\/.*\.pdf/i.test(url)) return route.continue(); if(['document','script','xhr','fetch','stylesheet'].includes(type)) return route.continue(); if(['image','media','font'].includes(type)) return route.abort(); if(/googletagmanager|google-analytics|doubleclick|facebook|hotjar|datadog|sentry|segment|optimizely/i.test(url)) return route.abort(); return route.continue(); }catch{ return route.continue(); } }); }catch{} }
async function waitSettle(page, debug){ 
  if (!page || page.isClosed?.()) {
    debug?.log('wait_settle_skip', { reason: 'page_closed' });
    return;
  }
  try {
    debug?.log('wait_settle_start', {});
    await page.waitForSelector('body', {timeout:20000}).catch((e) => {
      debug?.log('wait_settle_selector_error', { error: e.message });
    });
    if (!page.isClosed?.()) {
      debug?.log('wait_settle_sleep', {});
      await sleep(600);
    } else {
      debug?.log('wait_settle_skip_sleep', { reason: 'page_closed' });
    }
  } catch (e) {
    debug?.log('wait_settle_error', { error: e.message });
  }
}
async function dismiss(page){
  await safe(()=>page.evaluate(()=>{
    // Avoid clicking generic "OK" links that could navigate (e.g., to state pages)
    const R=/accept|agree|got it|close|understand/i; // avoid 'continue' to prevent unintended navigation
    const els=[...document.querySelectorAll('button,[role="button"]')]; // avoid anchors
    const b=els.find(e=>R.test((e.innerText||e.textContent||'').trim()));
    if(b) b.click();
  })).catch(()=>{});
}

function normText(s){ return String(s||'').replace(/\u00AD/g,'').replace(/[\u2010-\u2015]/g,'-').replace(/[^\S\r\n]+/g,' ').trim(); }
function detectCWCOTInText(rawText, filename){ const t=normText(rawText).toLowerCase(); const hits=[]; const RULES=[ {re:/\bcwcot\b/,k:'CWCOT'}, {re:/claims?\s+without\s+conveyance\s+of\s+title/,k:'CWCoT spelled out'}, {re:/real\s+estate\s+purchase\s+addendum\s*\(cwcot\s*property\)/,k:'Title: CWCOT Property'}, {re:/\bsecond\s*[- ]?\s*chance\b/,k:'Second Chance'}, {re:/post\s*[- ]?\s*foreclosure\s+sale/,k:'Post-Foreclosure Sale'} ]; for(const r of RULES) if(r.re.test(t)) hits.push(r.k); if(filename&&/cwcot/i.test(filename)) hits.push('filename:CWCOT'); const revMatch=t.match(/rev\.?\s*([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{2,4})/); const cwcot_rev=revMatch?revMatch[1]:''; return {isCWCOT:hits.length>0,hits,cwcot_rev}; }

const makeDebug = (enabled)=>({
  enabled: true, // Always enable debugging for now
  __history: [],
  log(stage,data){
    const entry={ts:new Date().toISOString(),stage,data};
    this.__history.push(entry);
    try{
      console.log(`[${entry.ts}] ${stage}:`, JSON.stringify(data));
    }catch(e){
      console.log(`[${entry.ts}] ${stage}: [Error stringifying data]`, String(e));
    }
  },
  async screenshot(page,name){
    if(!this.enabled) return null;
    try{
      const img=await page.screenshot({encoding:'base64',fullPage:true});
      this.log(`screenshot_${name}`,{name,size:img.length});
      return img;
    }catch(e){
      this.log('screenshot_error',{name,error:e.message});
      return null;
    }
  }
});

// --- Basics extractors & document helpers ---
async function textSelect(page, sels, max = 200) {
  for (const s of sels) {
    const t = await safe(() => page.evaluate(sel => { const n = document.querySelector(sel); return n ? (n.textContent || '').trim() : ''; }, s)).catch(() => '');
    if (t) return t.replace(/\s+/g, ' ').trim().slice(0, max);
  } return '';
}

async function getBasics(page) {
  // Nudge the viewport near the Property Details grid to trigger any lazy content
  try {
    await safe(() => page.evaluate(() => {
      const pick = (s)=>document.querySelector(s);
      const root = pick('[data-elm-id="opening_bid_value"]') || pick('[data-elm-id="arv_value"]') || pick('[data-elm-id="total_bedrooms_label"]') || pick('[data-elm-id="interior_square_footage_label"]') || pick('[data-elm-id="property_type_label"]') || pick('[data-elm-id="year_built_label"]');
      if (root && root.scrollIntoView) root.scrollIntoView({ block: 'center' });
      else if (window && document && document.body) window.scrollBy(0, Math.min(800, Math.max(200, (document.body.scrollHeight||200)/4)));
    }));
  } catch {}
  await sleep(150);
  const address = (await textSelect(page, ['[data-qa="property-address"]', '.asset-address', 'h1', '[class*="Address"]'], 220)) || '';
  let cityStateZip = (await textSelect(page, ['[data-qa="property-city-state-zip"]', '[class*="CityStateZip"]'], 160)) || '';
  // Prefer explicit opening bid element when present
  let price = (await textSelect(page, ['[data-elm-id="opening_bid_value"]','[data-elm-id="current_bid_value"]','[data-qa="current-bid"]', '[data-qa="starting-bid"]', '[class*="Bid"]', '[class*="Price"]'], 80)) || '';
  const estResaleValue = (await textSelect(page, ['[data-elm-id="arv_value"]'], 80)) || '';
  let saleWindow = (await textSelect(page, ['[data-qa="auction-dates"]', '[class*="AuctionDates"]', 'time'], 140)) || '';

  const facts = await safe(() => page.evaluate(() => {
    const text = (document.body && (document.body.innerText || '')) || '';
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const pick = (re) => { try { const m = text.match(re); return m ? norm(m[1]) : ''; } catch { return ''; } };

    // Direct data-elm-id mapping from Property Details grid
    const g = (id) => { try { const n = document.querySelector(`[data-elm-id="${id}"]`); return n ? norm(n.innerText || n.textContent || '') : ''; } catch { return ''; } };

    let bedsId = g('total_bedrooms_value');
    let bathsId = g('total_bathrooms_value');
    let sqftId = g('interior_square_footage_value');
    let lotId = g('exterior_acerage_value'); // note: site uses "acerage"
    let typeId = g('property_type_value');
    let yearId = g('year_built_value');

    // Label-based fallbacks if elm-ids are missing
    const byLabel = (labelRe) => {
      try {
        const R = new RegExp(labelRe, 'i');
        const nodes = Array.from(document.querySelectorAll('section,div,li,span,p,dt,dd,th,td,label,h2,h3,h4'));
        const lab = nodes.find(n => R.test(norm(n.innerText || n.textContent || '')));
        if (!lab) return '';
        const sib = lab.nextElementSibling && norm(lab.nextElementSibling.innerText || lab.nextElementSibling.textContent || '');
        if (sib) return sib;
        const parent = lab.parentElement;
        if (parent) {
          const candidates = Array.from(parent.children).filter(x => x !== lab);
          const v = candidates.map(c => norm(c.innerText || c.textContent || '')).filter(Boolean)[0];
          if (v) return v;
        }
        return pick(new RegExp(labelRe + '\\s*:?\\s*([^\n]+)'));
      } catch { return ''; }
    };

    const bedsLbl = bedsId || byLabel('^\\s*Beds\\s*$') || pick(/Beds?\s*:?[\s\u00A0]*([\d]+(?:\.\d+)?)/i) || pick(/([\d]+(?:\.\d+)?)\s*bd\b/i);
    const bathsLbl = bathsId || byLabel('^\\s*Baths\\s*$') || pick(/Baths?\s*:?[\s\u00A0]*([\d]+(?:\.\d+)?)/i) || pick(/([\d]+(?:\.\d+)?)\s*ba\b/i);
    const sqftLbl = sqftId || byLabel('^\\s*Square\\s*Footage\\s*$') || pick(/Square\s*Footage\s*:?[\s\u00A0]*([\d,]+)/i) || pick(/([\d,]+)\s*(?:sq\.?\s*ft|square\s*feet)/i);
    const typeLbl = typeId || byLabel('^\\s*Property\\s*Type\\s*$') || pick(/Property\s*Type\s*:?[\s\u00A0]*([A-Za-z][A-Za-z\s\-]+)/i) || pick(/(Single\s*Family\s*Home|Condo|Townhome|Multi[-\s]?Family|Duplex|Triplex|Quadplex)/i);
    const lotSize = lotId || byLabel('^\\s*Lot\\s*Size.*$') || pick(/Lot\s*Size(?:\s*\(Acres\))?\s*:?[\s\u00A0]*([\d,.]+)/i);
    const yearBuilt = yearId || byLabel('^\\s*Year\\s*Built\\s*$') || pick(/Year\s*Built\s*:?[\s\u00A0]*(\d{4})/i);

    // Right rail details
    const interiorAccess = byLabel('^\\s*Interior\\s*Access\\s*$') || pick(/Interior\s*Access\s*:?[\s\u00A0]*([A-Za-z ]+)/i);
    const cashOnly = byLabel('^\\s*Cash\\s*Only\\s*$') || pick(/Cash\s*Only\s*:?[\s\u00A0]*([A-Za-z ]+)/i);
    const brokerCoop = byLabel('^\\s*Broker\\s*Co-?op\\s*$') || pick(/Broker\s*Co-?op\s*:?[\s\u00A0]*([A-Za-z ]+)/i);
    const occupiedStatus = pick(/\bOccupied\b\s*:?[\s\u00A0]*([A-Za-z ]+)/i) || (/(\bOccupied\b)/i.test(text) ? 'Occupied' : '');
    const titleAndLiens = pick(/Title\s*and\s*Liens\s*:?[\s\u00A0]*([A-Za-z ,\-]+)/i);

    // Fallbacks for price and sale window
    const priceText = pick(/(?:Current|Starting)\s*Bid[^$\n]{0,40}(\$\s?[\d,]+(?:\.\d{2})?)/i) || pick(/\$\s?[\d,]+(?:\.\d{2})?/);
    let saleWin = pick(/Duration\s*:?[\s\u00A0]*([^\n]{5,120})/i);
    if(!saleWin){
      try{
        const el = Array.from(document.querySelectorAll('div,section,li,span,p,dd,td')).find(e=>/\bDuration\b/i.test(e.textContent||''));
        if(el){ saleWin = norm((el.textContent||'').replace(/\s*Add to calendar.*/i,'').replace(/\bDuration\b\s*/i,'').trim()); }
      }catch{}
    }

    // City/State/ZIP fallback from body text
    const csz = pick(/\b([A-Za-z][A-Za-z .]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)\b/);

    return { beds: bedsLbl, baths: bathsLbl, sqft: sqftLbl, type: typeLbl, lotSize, yearBuilt, interiorAccess, cashOnly, brokerCoop, occupiedStatus, titleAndLiens, priceText, saleWin, csz };
  })).catch(() => ({ beds: '', baths: '', sqft: '', type: '', lotSize:'', yearBuilt:'', interiorAccess:'', cashOnly:'', brokerCoop:'', occupiedStatus:'', titleAndLiens:'', priceText:'', saleWin:'', csz:'' }));

  // Apply fallbacks computed in page context
  if (!cityStateZip) {
    const fromAddr = (address && address.match(/([A-Za-z][A-Za-z .]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)/))?.[1] || '';
    cityStateZip = fromAddr || facts.csz || '';
  }
  if (!price) price = facts.priceText || '';
  if (!saleWindow) saleWindow = facts.saleWin || '';

  return {
    address,
    cityStateZip,
    price,
    saleWindow,
    beds: facts.beds || '',
    baths: facts.baths || '',
    sqft: facts.sqft || '',
    propertyType: facts.type || '',
    lotSizeAcres: facts.lotSize || '',
    yearBuilt: facts.yearBuilt || '',
    interiorAccess: facts.interiorAccess || '',
    cashOnly: facts.cashOnly || '',
    brokerCoop: facts.brokerCoop || '',
    occupiedStatus: facts.occupiedStatus || '',
    titleAndLiens: facts.titleAndLiens || '',
    estResaleValue
  };
}

async function docDebugSnapshot(page, limit = 20) {
  return await safe(() => page.evaluate((lim) => {
    const take = (n) => ({ text: (n.innerText || n.textContent || '').trim().slice(0, 180), data_elm_id: n.getAttribute('data-elm-id') || '', data_qa: n.getAttribute('data-qa') || '', href: (n.getAttribute('href') || '') });
    const nodes = [...document.querySelectorAll('[data-elm-id*="doc" i], [data-qa*="doc" i], a[href], [data-elm-id="documents"], [data-elm-id="documents_content"], [data-elm-id="documents_title"]')].slice(0, lim);
    return nodes.map(take);
  }, limit)).catch(() => []);
}

async function patchPdfSniffer(page) {
  try { page.removeAllListeners && page.removeAllListeners('response'); } catch {}
  try {
    page.__pdf_hits = [];
    page.on('response', (res) => {
      try {
        const url = res.url() || '';
        const headers = res.headers ? res.headers() : {};
        const ct = (headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/pdf') || /\.pdf(\?|$)/i.test(url) || /imgix\.net\/resi\/globalDocuments\/.+\.pdf/i.test(url)) (page.__pdf_hits ||= []).push(url);
      } catch {}
    });
  } catch {}
}
function getNewPdfHits(page, fromIndex) { try { return (page.__pdf_hits || []).slice(fromIndex || 0); } catch { return []; } }

async function setupCDPNetworkMonitoring(page) {
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    page.__cdp_pdf_urls = [];
    client.on('Network.responseReceived', (params) => {
      try { const r = params?.response || {}; const url = r.url || ''; const mime = (r.mimeType || '').toLowerCase(); if (mime === 'application/pdf' || /\.pdf(\?|$)/i.test(url)) (page.__cdp_pdf_urls ||= []).push(url); } catch {}
    });
    page.__cdp_client = client;
  } catch {}
}

async function patchClickCapture(page) {
  await safe(() => page.evaluate(() => {
    try {
      window.__capture = { openUrl: '', anchorHref: '', blobUrls: [] };
      const origOpen = window.open; window.open = function (u, n, f) { try { window.__capture.openUrl = u || ''; } catch { } return origOpen ? origOpen.apply(this, arguments) : null; };
      const A = HTMLAnchorElement && HTMLAnchorElement.prototype && HTMLAnchorElement.prototype.click;
      if (A) { const origClick = A; HTMLAnchorElement.prototype.click = function () { try { if (this.href) window.__capture.anchorHref = this.href; } catch { } return origClick.apply(this, arguments); }; }
      if (URL && URL.createObjectURL) { const origCreate = URL.createObjectURL; URL.createObjectURL = function (blob) { const u = origCreate.call(this, blob); try { if (blob && blob.type && /pdf/i.test(blob.type)) (window.__capture.blobUrls || []).push(u); } catch { } return u; }; }
    } catch {}
  }));
}
async function readCapture(page) { return await safe(() => page.evaluate(() => window.__capture || { openUrl: '', anchorHref: '', blobUrls: [] })).catch(() => ({ openUrl: '', anchorHref: '', blobUrls: [] })); }

async function ensureDocumentsOpen(page) {
  await safe(() => page.evaluate(() => {
    const clickText = (re) => {
      const R = new RegExp(re, 'i');
      const roots = [
        document.querySelector('[data-elm-id="documents_content"]'),
        document.querySelector('.adc__documents'),
        document.querySelector('[data-elm-id="documents"]'),
        document.querySelector('[role="tabpanel"]')
      ].filter(Boolean);
      const scopes = roots.length ? roots : [document];
      const isBad = (el) => {
        try {
          const href = (el.getAttribute && el.getAttribute('href')) || '';
          if (/\/lp\/legal|licensing|disclosures/i.test(href)) return true;
          if (el.closest && el.closest('footer, [class*="footer" i]')) return true;
        } catch {}
        return false;
      };
      for (const scope of scopes) {
        const els = [...scope.querySelectorAll('button,[role="button"],[role="tab"]')];
        const t = els.find(e => R.test((e.innerText || e.textContent || e.getAttribute?.('aria-label') || '').trim()) && !isBad(e));
        if (t) { t.scrollIntoView({ block: 'center' }); t.click(); return true; }
      }
      return false;
    };
    // Prefer opening the Due Diligence tab, then the documents sections inside it
    clickText('^\\s*Due\\s*Diligence\\s*$');
    clickText('^\\s*(Purchase\\s*Documents|Purchase\\s*Docs|Addenda|Addendum|Additional\\s*Documents|View\\s*All\\s*Documents|Download\\s*Documents)\\s*$|Addenda|Addendum');
    const showAll = [...document.querySelectorAll('button,[role="button"]')].find(e => /^\s*show\s*all\s*$/i.test((e.innerText || e.textContent || '').trim())); if (showAll) { showAll.scrollIntoView({ block: 'center' }); showAll.click(); }
    const tabLabels = ['Purchase Documents','Purchase Docs','Addenda','Addendum','Additional Documents','All Documents'];
    for (const lbl of tabLabels) { clickText(`^\\s*${lbl}\\s*$|${lbl}`); }
  })).catch(() => {});
  await sleep(900);
  await waitForDocumentTiles(page, 12000).catch(() => {});
}

async function waitForDocumentTiles(page, timeout = 10000) { return await safe(async () => { await page.waitForFunction(() => { const tiles = document.querySelectorAll('[data-elm-id="document_section_doc_doc"]'); const hasContent = tiles.length > 0 && Array.from(tiles).some(t => (t.textContent || '').trim().length > 0); return hasContent; }, { timeout }); }).catch(() => false); }

async function cookieHealth(page) { const t = await safe(() => page.evaluate(() => document.body?.innerText || '')).catch(() => ''); const hasDocsWord = /Additional Documents|Review Purchase Agreement|Purchase Agreement Addendum/i.test(t); const showsLogin = /Log\s*In|Sign\s*Up/i.test(t); return { healthy: hasDocsWord && !showsLogin, showsLogin, hasDocsWord, sample: t.slice(0, 220) }; }

// --- PDF reader (pdf.js) ---
let __pdfReader = null;
async function getPdfReader(context) { if (__pdfReader && !__pdfReader.isClosed?.()) return __pdfReader; __pdfReader = await context.newPage(); await setTimeouts(__pdfReader); await lighten(__pdfReader); await safe(() => __pdfReader.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 30000 })); await safe(() => __pdfReader.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' })); await safe(() => __pdfReader.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js' })); return __pdfReader; }
async function analyzeAddendumPdf(context, baseUrl, addendumUrl){ const reader=await getPdfReader(context); try{ const pdfText=await safe(()=>reader.evaluate(async (pdfUrl)=>{ const { pdfjsLib }=window; pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; const loadingTask=pdfjsLib.getDocument({url:pdfUrl,withCredentials:false}); const doc=await loadingTask.promise; const maxPages=Math.min(doc.numPages||1,4); const chunks=[]; for(let p=1;p<=maxPages;p++){ const pg=await doc.getPage(p); const tc=await pg.getTextContent(); const s=tc.items.map(it=>typeof it.str==='string'?it.str:'').join(' '); chunks.push(s);} return chunks.join('\n'); }, addendumUrl)); const filename=(()=>{ try{ const u=new URL(addendumUrl,baseUrl); return decodeURIComponent((u.pathname||'').split('/').pop()||''); }catch{ return ''; } })(); const textForDetect=normText(pdfText||''); const det=detectCWCOTInText(textForDetect, filename); return { isCWCOT:det.isCWCOT, cwcot_hits:det.hits, cwcot_rev:det.cwcot_rev, pdf_text_sample:textForDetect.slice(0,600), detection_source:'pdfjs', filename }; }catch(e){ try{ if(reader.isClosed?.()||/Target closed|Connection closed/i.test(String(e))) __pdfReader=null; }catch{} throw e; } }

// --- Document tiles & picking ---
function isPurchaseAgreementAddendumLabel(label){
  const L = (label||'').toLowerCase().replace(/\s+/g,' ').trim();
  if (!L) return false;
  if (/prohibited\s+sales\s+addendum/.test(L)) return false;
  // Strict match for Purchase Agreement Addendum variants
  return /purchase\s*agreement\s*addendum\b/.test(L) || /addendum\s*to\s*purchase\s*agreement\b/.test(L);
}
function labelType(label){ const L=(label||'').toLowerCase(); if(/prohibited\s+sales\s+addendum/.test(L)) return 'prohibited'; if(/\bas[\s-]*is\b.*addendum/.test(L)||/as-?is\s+addendum\s+to\s+psa/.test(L)) return 'asis'; if(isPurchaseAgreementAddendumLabel(label)) return 'paa'; if(/\baddendum\b/.test(L)) return 'generic'; if(/\breview\s+purchase\s+agreement\b|\bfreddie\s+mac\s+occupied\s+psa\b|\bpurchase\s+and\s+sale\s+agreement\b|\bauction\s+purchase\s+agreement\b|\bpsa\b/.test(L)) return 'psa'; return 'other'; }
async function listDocumentTiles(page) {
  return await safe(() => page.evaluate(() => {
    const tiles = [];
    const roots = [document.querySelector('[data-elm-id="documents_content"]'), ...document.querySelectorAll('.adc__documents, [data-elm-id="documents"]')].filter(Boolean);
    const scopes = roots.length ? roots : [document];
    const selectors = ['[data-elm-id="document_section_doc_doc"]', '.adc__documents a, .adc__documents [role="link"], .adc__documents [role="button"]', 'a[href$=".pdf"]', 'a:has(img[src*="pdf"])', 'li a[href], .document, .document-row, .document-tile'];
    const seenNodes = new Set();
    const labelCounts = new Map();
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const pushTile = (node) => {
      if (!node || seenNodes.has(node)) return;
      seenNodes.add(node);
      const label = norm(node.innerText || node.textContent || '');
      if (!label) return;
      const target = node.querySelector('a,button,[role="button"],[role="link"]') || node;
      let href = '';
      try { href = target.getAttribute('href') || target.href || ''; } catch {}
      const labelKey = label.toLowerCase();
      const ordinal = labelCounts.get(labelKey) || 0;
      labelCounts.set(labelKey, ordinal + 1);
      const dataId = (node.getAttribute && node.getAttribute('data-elm-id')) || (target.getAttribute && target.getAttribute('data-elm-id')) || '';
      tiles.push({ label, href, ordinal, dataId });
    };

    for (const scope of scopes) {
      for (const sel of selectors) {
        scope.querySelectorAll(sel).forEach(pushTile);
      }
    }
    return tiles;
  })).catch(() => []);
}
async function getClickableTileData(page){ return await page.evaluate(()=>{ const tiles=[]; document.querySelectorAll('[data-elm-id*="doc"]').forEach((el,index)=>{ tiles.push({index, selector:`[data-elm-id="${el.getAttribute('data-elm-id')}"]`, text:(el.textContent||'').trim()}); }); return tiles; }); }
async function clickTileByData(page,tileData){ await page.evaluate((data)=>{ const el=document.querySelector(data.selector); if(el) el.click(); }, tileData); }
async function clickTileAndSniffPdf(page,tile){
  if(tile.href && isPdfUrl(tile.href)) return toAbs(tile.href,'https://www.auction.com');
  try{ page.removeAllListeners&&page.removeAllListeners('response'); }catch{}
  page.__pdf_hits=[];
  page.on('response',(res)=>{ try{ const url=res.url()||''; const headers=res.headers?res.headers():{}; const ct=(headers['content-type']||'').toLowerCase(); if(ct.includes('application/pdf')||/\.pdf(\?|$)/i.test(url)||/imgix\.net\/resi\/globalDocuments\/.+\.pdf/i.test(url)) (page.__pdf_hits ||= []).push(url); }catch{} });
  await setupCDPNetworkMonitoring(page).catch(()=>{});
  const popupWait=page.waitForEvent('popup',{timeout:7000}).then(async pop=>{ let u=''; try{ await pop.waitForLoadState('domcontentloaded',{timeout:7000}).catch(()=>{}); u = pop.url()||''; }catch{} try{ await pop.close().catch(()=>{}); }catch{} return u; }).catch(()=> '');
  await safe(()=>page.evaluate((info)=>{
    const normalize=(s)=>(s||'').replace(/\s+/g,' ').trim();
    const root=document.querySelector('[data-elm-id="documents_content"]')||document.querySelector('.adc__documents')||document.querySelector('[data-elm-id="documents"]');
    if(!root) return;
    const els=[...root.querySelectorAll('a,button,[role="button"],[role="link"]')];
    const matches=els.filter(e=>normalize(e.innerText||e.textContent||'')===normalize(info.label));
    let el=matches[info.ordinal]||matches[0]||null;
    if(!el && info.dataId){
      el=els.find(e=>(e.getAttribute&&e.getAttribute('data-elm-id'))===info.dataId);
    }
    if(!el){
      const fallback=els.filter(e=>/purchase\s*agreement\s*addendum/i.test(normalize(e.innerText||e.textContent||'')));
      el=fallback[info.ordinal]||fallback[0]||null;
    }
    if(!el) return;
    try{ el.removeAttribute&&el.removeAttribute('target'); }catch{}
    el.scrollIntoView({block:'center'});
    el.click();
    el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  }, { label: tile.label, ordinal: tile.ordinal||0, dataId: tile.dataId||'' })).catch(async ()=>{
    const td=await getClickableTileData(page).catch(()=>[]);
    const normalize=(s)=>(s||'').replace(/\s+/g,' ').trim();
    const matches=(td||[]).filter(t=>normalize(t.text||'')===normalize(tile.label||''));
    const pick=matches[tile.ordinal||0]||matches[0];
    if(pick) await clickTileByData(page, pick);
  });
  await sleep(900);
  const now=await safe(()=>page.url()).catch(()=> '');
  if(isPdfUrl(now)) return now;
  const pu=await popupWait;
  if(isPdfUrl(pu)) return pu;
  if((page.__pdf_hits||[])[0] && isPdfUrl((page.__pdf_hits||[])[0])) return (page.__pdf_hits||[])[0];
  if((page.__cdp_pdf_urls||[])[0] && isPdfUrl((page.__cdp_pdf_urls||[])[0])) return (page.__cdp_pdf_urls||[])[0];
  for(let i=0;i<6;i++){
    const perf=await safe(()=>page.evaluate(()=>{
      try{
        const es=performance.getEntriesByType('resource')||[];
        const m=es.find(e=>/imgix\.net\/resi\/globalDocuments\/.+\.pdf/i.test(e.name||''));
        return m?m.name:'';
      }catch{
        return '';
      }
    })).catch(()=> '');
    if(isPdfUrl(perf)) return perf;
    await sleep(250);
  }
  const cap=await readCapture(page);
  if(isPdfUrl(cap.openUrl)) return toAbs(cap.openUrl, now||'https://www.auction.com');
  if(isPdfUrl(cap.anchorHref)) return toAbs(cap.anchorHref, now||'https://www.auction.com');
  if((cap.blobUrls||[])[0] && isPdfUrl((cap.blobUrls||[])[0])) return cap.blobUrls[0];
  return '';
}


// --- Results page helpers (ZIP flow) ---
async function collectDetailLinksFromHTML(page) {
  // Wait a bit longer for the page to load and stabilize
  await sleep(2000);
  
  // Try to get links directly from property cards first
  const cardLinks = await safe(() => page.evaluate(() => {
    const cards = document.querySelectorAll('[data-elm-id="asset_list_content"] a, .asset-card a, [data-testid="property-card"] a');
    return [...cards].map(a => a.href).filter(href => href.includes('/details/'));
  })).catch(() => []);

  if (cardLinks.length) {
    return [...new Set(cardLinks)];
  }

  // Fallback to HTML parsing if no cards found
  const html = await safe(() => page.content()).catch(() => '');
  const urls = new Set();
  
  if (html) {
    // Match full URLs
    for (const m of html.matchAll(/https?:\/\/www\.auction\.com\/details\/[A-Za-z0-9\-._/%?=&#]+/g)) {
      urls.add(m[0]);
    }
    
    // Match relative URLs
    for (const m of html.matchAll(/["'](\/details\/[A-Za-z0-9\-._/%?=&#]+)["']/g)) {
      urls.add(toAbs(m[1], 'https://www.auction.com'));
    }
    
    // Match data attributes that might contain URLs
    for (const m of html.matchAll(/data-url=["'](\/details\/[^"']+)["']/g)) {
      urls.add(toAbs(m[1], 'https://www.auction.com'));
    }
  }
  
  return [...urls];
}

async function waitForAnyDetails(page, maxMs=15000){
  const start=Date.now();
  while(Date.now()-start < maxMs){
    try{
      const ok = await safe(()=>page.evaluate(()=>!!document.querySelector('a[href*="/details/"]'))).catch(()=>false);
      if(ok) return true;
    }catch{}
    await sleep(500);
  }
  return false;
}

async function ensureFilterOn(page, labelRx){ await safe(()=>page.evaluate((reStr)=>{ const R=new RegExp(reStr,'i'); const els=[...document.querySelectorAll('button,[role="button"],a,label,span,div')]; const cand=els.find(e=>R.test((e.innerText||e.textContent||e.getAttribute?.('aria-label')||'').trim())); if(!cand) return false; cand.scrollIntoView({block:'center'}); cand.click(); return true; }, String(labelRx))).catch(()=>{}); await sleep(500); }
async function verifyZipOnPage(page, zip){ const t=await safe(()=>page.evaluate(()=>document.body?.innerText||'')).catch(()=> ''); return new RegExp(String(zip).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).test(t); }
async function typeIntoSearch(page, zip, debug){
  if (!page || page.isClosed?.()) throw new Error('Page is closed before typing search');
  
  debug?.log('search_start', { url: await page.url() });
  
  // Wait for the search input to be present
  try {
    const input = await page.waitForSelector(
      'input[placeholder*="ZIP" i], input[placeholder*="City" i], input[aria-label*="ZIP" i], input[name*="search" i]',
      { state: 'visible', timeout: 10000 }
    );
    debug?.log('search_input_found', { element: await input.evaluate(el => ({ 
      placeholder: el.placeholder,
      type: el.type,
      id: el.id
    }))});
  } catch (e) {
    debug?.log('search_input_not_found', { error: e.message });
    throw e;
  }

  // Click into the search field first
  await page.click('input[placeholder*="ZIP" i], input[placeholder*="City" i], input[aria-label*="ZIP" i], input[name*="search" i]');
  await sleep(200);

  // Clear any existing value and type the ZIP
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(zip), {delay: 100});
  await sleep(1000); // Wait for suggestions to appear
  
  debug?.log('typed_zip', { zip });
  
  // Look for and click the suggestion with the highlighted ZIP
  try {
    const highlightedZipSelector = `span[class*="highlighted"]`;
    await page.waitForSelector(highlightedZipSelector, { timeout: 5000 });
    
    const clicked = await page.evaluate((zipValue, selector) => {
      const highlights = [...document.querySelectorAll(selector)];
      const match = highlights.find(el => el.textContent.trim() === zipValue);
      if (match) {
        // Click the parent element that contains the highlight
        let clickTarget = match;
        while (clickTarget && !clickTarget.classList.toString().includes('suggestion')) {
          clickTarget = clickTarget.parentElement;
        }
        if (clickTarget) {
          clickTarget.click();
          return true;
        }
      }
      return false;
    }, String(zip), highlightedZipSelector);
    
    debug?.log('suggestion_click', { clicked });
    
    if (!clicked) {
      throw new Error('Could not click the matching suggestion');
    }
  } catch (e) {
    debug?.log('suggestion_click_failed', { error: e.message });
    throw e;
  }

  // Wait and verify the navigation
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    const finalUrl = await page.url();
    debug?.log('final_navigation', { url: finalUrl });
    
    // Verify we're on a results page with the correct ZIP format
    const isCorrectUrl = finalUrl.includes(`${zip}_zp`);
    const content = await page.evaluate(() => document.body.innerText);
    const hasResults = content.includes('Search Results') || content.includes('Properties Found');
    debug?.log('results_verification', { hasResults, isCorrectUrl });
    
    if (!isCorrectUrl) {
      // If we're not on the correct URL format, try to redirect
      await page.goto(`https://www.auction.com/residential/${zip}_zp/`, { waitUntil: 'domcontentloaded' });
      debug?.log('redirect_attempt', { to: `https://www.auction.com/residential/${zip}_zp/` });
    }
    
    // Final verification
    const newUrl = await page.url();
    if (!newUrl.includes(`${zip}_zp`)) {
      throw new Error('Could not reach the correct ZIP-specific search page');
    }
  } catch (e) {
    debug?.log('navigation_error', { error: e.message });
    throw e;
  }
}
async function goToZipResults(context, location, debug){
  const isState = location.length === 2 && STATE_CODES[location.toUpperCase()];
  debug?.log('search_start', { location, searchType: isState ? 'state' : 'zip' });
  
  if (!await isContextValid(context)) {
    debug?.log('context_invalid_at_start', {});
    throw new Error('Browser context is no longer valid');
  }

  let root = null;
  try {
    debug?.log('search_start', {});
    root = await createNewPage(context, 3, debug);
    debug?.log('search_page_created', { closed: root.isClosed?.() });
    
    await setTimeouts(root);
    await lighten(root);
    
    let searchUrl;
    if (isState) {
      // State search URL format for bank owned & newly foreclosed properties
      const stateCode = location.toLowerCase();
      searchUrl = `https://www.auction.com/residential/${stateCode}/active_lt/auction_date_order,resi_sort_v2_st/y_nbs/bank-owned,newly-foreclosed_at`;
      debug?.log('navigate_to_state_results', { state: stateCode });
    } else {
      // ZIP search URL format
      searchUrl = `https://www.auction.com/residential/${location}_zp/`;
      debug?.log('navigate_to_zip_results', { zip: location });
    }
    
    await safeNavigate(root, searchUrl);
    
    if (!await isContextValid(context) || root.isClosed?.()) {
      debug?.log('context_or_page_invalid', { contextValid: await isContextValid(context), pageClosed: root.isClosed?.() });
      throw new Error('Browser context or page became invalid after navigation');
    }
    
    debug?.log('waiting_for_results', {});
    await waitSettle(root);
    
    // Wait for property cards to be visible
    try {
      await root.waitForSelector('[data-elm-id="asset_list_content"], .asset-card, [data-testid="property-card"]', 
        { state: 'visible', timeout: 5000 }
      );
      debug?.log('property_cards_found', {});
    } catch (e) {
      debug?.log('property_cards_not_found', { error: e.message });
      // Even if we don't see cards, continue as long as we're on the right URL
    }
    
    await dismiss(root);
    
    if (root.isClosed?.()) {
      debug?.log('page_closed_after_dismiss', {});
      throw new Error('Page was closed after dismiss');
    }
    
    debug?.log('applying_filters', {});
    await ensureFilterOn(root, '^\s*Bank\s*Owned\s*$|Bank\s*Owned');
    await ensureFilterOn(root, '^\s*Newly\s*Foreclosed\s*$|Newly\s*Foreclosed');
    await waitSettle(root);
    
    debug?.log('verifying_results', {});
    let ok;
    if (isState) {
      // For state searches, verify we're on a state results page with bank owned properties
      const currentUrl = await root.url();
      ok = currentUrl.includes(`/${location.toLowerCase()}/`) && 
           currentUrl.includes('bank-owned,newly-foreclosed_at');
    } else {
      // For ZIP searches, verify the ZIP is on the page
      ok = await verifyZipOnPage(root, location);
    }
    debug?.log('search_complete', { success: ok, searchType: isState ? 'state' : 'zip' });
    
    return { root, ok };
  } catch (e) {
    debug?.log('search_failed', { error: e.message });
    await safeClosePage(root);
    throw new Error(`Failed to load ZIP results: ${e.message}`);
  }
}
async function verifyStateOnPage(page, abbr){ try{ const url=await page.url(); const ab=String(abbr||'').toLowerCase(); return /\/residential\//i.test(url) && new RegExp(`/residential/${ab}/`, 'i').test(url); }catch{ return false; } }
async function goToStateResults(context, abbr){
  const ab = String(abbr||'').toUpperCase();
  const name = STATE_NAME_BY_ABBR[ab] || '';
  const label = name ? `${name} Foreclosures` : '';
  let root=await context.newPage();
  await setTimeouts(root); await lighten(root);
  const canonical = `https://www.auction.com/residential/${ab.toLowerCase()}/active_lt/resi_sort_v2_st/y_nbs/foreclosures_at/`;
  await safeNavigate(root, canonical).catch(()=>{});
  let ok = await verifyStateOnPage(root, ab).catch(()=>false);
  if(!ok){
    await safeClosePage(root);
    root = await context.newPage(); await setTimeouts(root); await lighten(root);
    await safeNavigate(root, 'https://www.auction.com/');
    await waitSettle(root); await dismiss(root);
    await safe(()=>root.evaluate(()=>{
      const el=[...document.querySelectorAll('div,section,header,main,aside')].find(e=>/Foreclosures\s+By\s+State/i.test(e.innerText||''));
      if(el){ el.scrollIntoView({block:'center'}); }
    })).catch(()=>{});
    await sleep(400);
    let clicked=false;
    try{ await root.locator(`a[href^="/residential/${ab.toLowerCase()}/"]`).first().click({timeout:2500}); clicked=true; }catch{}
    if(!clicked && label){ try{ await root.locator(`a:has-text("${label}")`).first().click({timeout:2500}); clicked=true; }catch{} }
    if(!clicked){ await safe(()=>root.evaluate((ab, label)=>{ const tryClick=(sel, pred)=>{ const els=[...document.querySelectorAll(sel)]; const it=els.find(pred); if(it){ it.scrollIntoView({block:'center'}); it.click(); return true; } return false; }; const abLc=String(ab||'').toLowerCase(); if(tryClick('a[href]', a=>a.getAttribute('href')?.startsWith(`/residential/${abLc}/`))) return true; if(label && tryClick('a', a=>new RegExp('^\\s*'+label.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')+'\\s*$', 'i').test((a.innerText||'').trim()))) return true; return false; }, ab, label)).catch(()=>{}); }
    await root.waitForLoadState('domcontentloaded').catch(()=>{});
    await waitSettle(root);
    await ensureFilterOn(root, '^\\s*Bank\\s*Owned\\s*$|Bank\\s*Owned');
    await ensureFilterOn(root, '^\\s*Newly\\s*Foreclosed\\s*$|Newly\\s*Foreclosed');
    await waitSettle(root);
    ok = await verifyStateOnPage(root, ab).catch(()=>false);
  }
  return { root, ok };
}
async function safeNavigate(page, url, maxRetries=3){
  for(let i=0;i<maxRetries;i++){
    try{
      if (!page || page.isClosed?.()) throw new Error('Page is closed before navigation');
      const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
      const currentUrl=page.url();
      if(!/\.auction\.com\b/i.test(currentUrl)&&!/^about:blank$/i.test(currentUrl)) throw new Error('Redirected away from auction.com');
      return response;
    }catch(e){
      if(i===maxRetries-1) throw e;
      await sleep(1500*(i+1));
    }
  }
}
async function safeClosePage(page){ try{ if(!page||page.isClosed?.()) return; try{ if(page.__cdp_client&&page.__cdp_client.detach) await page.__cdp_client.detach(); }catch{} try{ page.removeAllListeners?.(); }catch{} try{ await page.evaluate(()=>{ const highestId=setTimeout(()=>{},0); for(let i=0;i<=highestId;i++){ clearTimeout(i); clearInterval(i); } }).catch(()=>{}); }catch{} await page.close().catch(()=>{}); }catch{} }
async function closeExtraPages(context, keepPages){
  try{
    const keep = new Set(keepPages||[]);
    for(const pg of context.pages?.()||[]){
      try{
        if(keep.has(pg)) continue;
        if(typeof __pdfReader !== 'undefined' && __pdfReader && pg===__pdfReader) continue;
        if(pg.isClosed?.()) continue;
        await safeClosePage(pg);
      }catch{}
    }
  }catch{}
}
async function addCookies(context, cookieHeader){ const cookies=cookiesFromHeader(cookieHeader); if(!cookies.length) return; await context.addCookies(cookies).catch(()=>{}); }
async function attachAutoClosePopups(context){
  try{
    if(context.__autoPopupHooked) return; 
    context.__autoPopupHooked=true;
    context.on('page', async (pg)=>{
      try{
        const opener = pg.opener ? pg.opener() : null;
        if(opener){
          // Only close popups that aren't our main search page
          const url = await pg.url().catch(() => '');
          const isMainPage = url.includes('auction.com');
          if (!isMainPage) {
            setTimeout(()=>{ try{ pg.close().catch(()=>{}); }catch{} }, 2000);
          }
        }
      }catch{}
    });
  }catch{}
}
async function loginIfNeeded(context, creds){ if(!creds?.username||!creds?.password) return false; const page=await context.newPage(); await setTimeouts(page); await lighten(page); await safeNavigate(page,'https://www.auction.com/'); await waitSettle(page); await dismiss(page); try{ const sel='a:has-text("Sign In"), a:has-text("Log In"), button:has-text("Sign In"), button:has-text("Log In")'; await page.locator(sel).first().click({timeout:5000}).catch(()=>{}); }catch{} await page.waitForLoadState('domcontentloaded').catch(()=>{}); await sleep(800); const emailSel='input[type="email"], input[name*="email" i], input[placeholder*="email" i], input[name="username" i]'; const passSel='input[type="password"], input[name*="password" i], input[placeholder*="password" i]'; try{ await page.locator(emailSel).first().fill(creds.username,{timeout:7000}); }catch{} try{ await page.locator(passSel).first().fill(creds.password,{timeout:7000}); }catch{} try{ await page.locator('button:has-text("Sign In"), button:has-text("Log In"), [type="submit"]').first().click({timeout:7000}); }catch{} await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{}); await waitSettle(page); const body=await page.content(); const logged=!/Log\s*In|Sign\s*Up/i.test(body); await safeClosePage(page); return logged; }

// Browser context validation helper
async function isContextValid(context) {
  try {
    await context.pages();
    return true;
  } catch (e) {
    return false;
  }
}

async function createNewPage(context, retries = 3, debug) {
  for (let i = 0; i < retries; i++) {
    try {
      debug?.log('create_page_attempt', { attempt: i + 1 });
      
      if (!await isContextValid(context)) {
        debug?.log('context_invalid', { attempt: i + 1 });
        throw new Error('Browser context is no longer valid');
      }

      const page = await context.newPage();
      debug?.log('page_created', { closed: page.isClosed?.() });

      if (!page) {
        debug?.log('page_creation_failed', { attempt: i + 1 });
        throw new Error('Failed to create page');
      }

      if (page.isClosed?.()) {
        debug?.log('page_closed_immediately', { attempt: i + 1 });
        throw new Error('Page was closed immediately after creation');
      }

      // Listen for page close events
      page.once('close', () => {
        debug?.log('page_closed_event', { url: page.url() });
      });

      return page;
    } catch (e) {
      debug?.log('create_page_error', { attempt: i + 1, error: e.message });
      if (i === retries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
  throw new Error('Failed to create new page after multiple attempts');
}

// --- Main ---
(async () => {
  const cfg = await loadConfig();
  const debug = makeDebug(cfg.debug);
  
  const browser = await chromium.launch({
    headless: cfg.headless,
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  
  await attachAutoClosePopups(context);

  if (cfg.cookieHeader) await addCookies(context, cfg.cookieHeader);
  if (!cfg.cookieHeader && cfg.username && cfg.password) { await loginIfNeeded(context, { username: cfg.username, password: cfg.password }).catch(()=>{}); }

  let detailUrls = cfg.detailUrls.slice();
  let availableCount = detailUrls.length;
  const out = [];



  if (!detailUrls.length && (cfg.zip || cfg.state)) {
    const searchLocation = cfg.state || cfg.zip;
    const { root, ok } = await goToZipResults(context, searchLocation, debug);
    try {
      debug.log('search_results_ok', { ok, url: await root.url(), searchType: cfg.state ? 'state' : 'zip' });

      await waitSettle(root);
      for (let i=0;i<6;i++){ await safe(()=>root.evaluate(()=>{ window.scrollBy(0, document.body.scrollHeight); })).catch(()=>{}); await sleep(350); }
      await waitSettle(root);
      
      let links = await collectDetailLinksFromHTML(root);
      if (links && links.length) {
        detailUrls = links;
        availableCount = links.length;
      } else {
        debug.log('no_property_links_found', { searchLocation });
      }

  if (!links.length) { await waitForAnyDetails(root, 8000).catch(()=>{}); await waitSettle(root); links = await collectDetailLinksFromHTML(root); }

  for (let i=0;i<6;i++){ await safe(()=>root.evaluate(()=>{ window.scrollBy(0, document.body.scrollHeight); })).catch(()=>{}); await sleep(350); }
  await waitSettle(root);
  links = await collectDetailLinksFromHTML(root);

      if (!links.length) {
        const hint = await safe(()=>root.evaluate(()=>document.body?.innerText||'')).catch(()=> '');
        await safeClosePage(root);
        console.log(JSON.stringify([{ note:`No /details/ links for ZIP ${cfg.zip}`, source: await root.url(), page_hint: (hint||'').slice(0,300) }], null, 2));
        process.exit(0);

      } else {

      }

      const allCount = links.length;
      availableCount = allCount;
      if (links.length > cfg.maxProperties) links = links.slice(0, cfg.maxProperties);
      detailUrls = links;
    } finally { await safeClosePage(root); }
  }


  // (Removed earlyReport handling on revert)

  if (!detailUrls.length) {
    if (!cfg.zip && !cfg.state) {
      throw new Error('No search criteria provided - please provide either a ZIP code, state abbreviation, or detailUrls.');
    }
    throw new Error(`No properties found for ${cfg.state ? 'state ' + cfg.state : 'ZIP ' + cfg.zip}`);
  }

  if (!detailUrls.length) throw new Error('detailUrls is empty - provide ZIP, state, or detailUrls.');

  if (!detailUrls.length) throw new Error('detailUrls is empty ??? provide ZIP or detailUrls.');


  for (const url of detailUrls.slice(0, cfg.maxProperties)) {
    let p = await context.newPage();
    try {
      await setTimeouts(p); await lighten(p);
      await safeNavigate(p, url); await waitSettle(p); await dismiss(p);
      const health = await cookieHealth(p);
      const doc_before = cfg.debug ? await docDebugSnapshot(p, 25) : [];
      const basics = await getBasics(p);
      // Skip pre-opening documents here to avoid extra waits; detection handles it.
      const detectPromise = getBestAddendumAndDetect(p, url, debug);
      const detectTimeout = Math.max(4000, Number(cfg.detectTimeoutMs) || 5000);
      const defaultDetectResult = { selection_reason:'timeout_no_paa', url:'', isCWCOT:false, cwcot_hits:[], cwcot_rev:'', detection_source:'', filename:'', pdf_text_sample:'', label:'', tiles_seen:undefined, tiles_labels:undefined };
      let picked = await Promise.race([
        detectPromise,
        sleep(detectTimeout).then(()=>null)
      ]);
      if (picked === null) {
        const late = await Promise.race([
          detectPromise.catch(()=>null),
          sleep(Math.max(5000, detectTimeout)).then(()=>null)
        ]);
        if (late) {
          if (!late.selection_reason) late.selection_reason = 'paa_slow';
          picked = late;
        } else {
          picked = defaultDetectResult;
        }
      }
      detectPromise.catch(()=>{});
      const doc_after = cfg.debug ? await docDebugSnapshot(p, 25) : [];
      const isCWCOT = picked && picked.isCWCOT ? true : false;
      const row = { scraped_at:new Date().toISOString(), url, addendum_url:picked.url||'', isCWCOT, cwcot_hits:picked.cwcot_hits||[], cwcot_rev:picked.cwcot_rev||'', detection_source:picked.detection_source||'', filename:picked.filename||'', pdf_text_sample:picked.pdf_text_sample||'', selection_reason:picked.selection_reason||'', clicked_label:picked.label||'', tiles_seen:picked.tiles_seen??undefined, tiles_labels:picked.tiles_labels??undefined, address:basics.address, cityStateZip:basics.cityStateZip, price:basics.price, saleWindow:basics.saleWindow, beds:basics.beds, baths:basics.baths, sqft:basics.sqft, propertyType:basics.propertyType, lotSizeAcres: basics.lotSizeAcres, yearBuilt: basics.yearBuilt, interiorAccess: basics.interiorAccess, cashOnly: basics.cashOnly, brokerCoop: basics.brokerCoop, occupiedStatus: basics.occupiedStatus, titleAndLiens: basics.titleAndLiens, estResaleValue: basics.estResaleValue, cookie_healthy:health.healthy, cookie_hint: health.healthy ? '' : (health.showsLogin ? 'Login text visible; cookies likely stale' : 'Docs keywords not visible'), error:'' };
      if (cfg.debug) { row.doc_debug_before = doc_before; row.doc_debug_after = doc_after; row._debug = debug.__history || []; }
      out.push(row);
    } catch (e) {
      out.push({ scraped_at:new Date().toISOString(), url, addendum_url:'', isCWCOT:false, cwcot_hits:[], cwcot_rev:'', detection_source:'', filename:'', pdf_text_sample:'', selection_reason:'', clicked_label:'', address:'', cityStateZip:'', price:'', saleWindow:'', beds:'', baths:'', sqft:'', propertyType:'', cookie_healthy:false, cookie_hint:'', error:String(e) });
    } finally { await safeClosePage(p); await closeExtraPages(context, []); }
  }

  try{ if(__pdfReader) await safeClosePage(__pdfReader); }catch{}
  await fs.writeFile(cfg.output, JSON.stringify(out, null, 2), 'utf-8');
  const total = out.length; const ok = out.filter(r=>!r.error).length; const cwcot = out.filter(r=>r.isCWCOT).length; const withPdf = out.filter(r=>(r.addendum_url||'').length>0).length; const attempted = Math.min(availableCount, cfg.maxProperties);
  const scrapedAllAvailable = total >= attempted;
  const summary = { total, ok, withAddendum: withPdf, cwcot, maxRequested: cfg.maxProperties, available: availableCount, attempted, scrapedAllAvailable };
  const summaryPath = cfg.output.toLowerCase().endsWith('.json') ? cfg.output.replace(/\.json$/i, '.summary.json') : (cfg.output + '.summary.json');
  try { await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8'); } catch {}
  console.log(`Scrape summary: ${ok}/${total} ok; ${withPdf} with addendum; ${cwcot} CWCOT; attempted ${attempted} of ${availableCount}; scrapedAllAvailable=${scrapedAllAvailable}`);
  console.log(JSON.stringify(summary));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  process.exit(0);
})().catch(async (e)=>{ console.error('Fatal error:', e); process.exit(1); });

async function openPSAIfPresent(page){
  const candidates=[/review\s+purchase\s+agreement/i,/purchase\s+and\s+sale\s+agreement/i,/auction\s+purchase\s+agreement/i,/freddie\s+mac\s+occupied\s+psa/i];
  const popupWait=page.waitForEvent('popup',{timeout:5000}).then(async pop=>{ let u=''; try{ await pop.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{}); u=pop.url()||''; }catch{} try{ await pop.close().catch(()=>{});}catch{} return u; }).catch(()=> '');
  const hit=await safe(()=>page.evaluate((patterns)=>{ const els=[...document.querySelectorAll('a,button,[role="button"],[role="link"]')]; const match=(txt)=>patterns.some(p=>new RegExp(p.source,'i').test(txt)); const el=els.find(e=>match((e.innerText||e.textContent||'').trim())); if(!el) return null; el.scrollIntoView({block:'center'}); el.removeAttribute&&el.removeAttribute('target'); el.click(); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); return true; }, candidates)).catch(()=>null);
  if(!hit) return '';
  await sleep(1200);
  const now=await safe(()=>page.url()).catch(()=> ''); if(/\.pdf(\?|$)/i.test(now)||/imgix\.net\/resi\/globalDocuments\/.+\.pdf/i.test(now)) return now;
  const pop=await popupWait; if(pop) return pop;
  let url=''; try{ for(let i=0;i<10;i++){ const perf=await safe(()=>page.evaluate(()=>{ try{ const es=performance.getEntriesByType('resource')||[]; const m=es.find(e=>/imgix\.net\/resi\/globalDocuments\/.+\.pdf/i.test(e.name||'')); return m?m.name:''; }catch{ return ''; } })).catch(()=> ''); if(perf){ url=perf; break; } await sleep(300);} }catch{} return url||'';
}

async function parseHydrationLinksFromHTML(page){ const html=await safe(()=>page.content()).catch(()=> ''); const urls=new Set(); if(!html) return []; const rx=/https?:\/\/[^"'\s]+imgix\.net\/resi\/globalDocuments\/[^"'\s]+?\.pdf/ig; for(const m of html.matchAll(rx)) urls.add(m[0]); return [...urls]; }

async function getBestAddendumAndDetect(page, baseUrl, debug){
  for(let attempt=0; attempt<3; attempt++){
    try{
      await ensureDocumentsOpen(page);
      const tiles=await listDocumentTiles(page);
      debug&&debug.log('tiles_listed',{count:tiles.length,labels:tiles.map(t=>t.label).slice(0,20)});

      const isPAA = (t)=> isPurchaseAgreementAddendumLabel(t.label) || /purchase[\s_-]*agreement[\s_-]*addendum/i.test(t.label||'') || /addendum[\s_-]*to[\s_-]*purchase[\s_-]*agreement/i.test(t.label||'') || /purchase.*agreement.*addendum/i.test(t.href||'');
      const paaTiles = tiles.filter(isPAA);
      const results = [];
      const seen = new Set();
      for(const t of paaTiles){
        const pdfUrl = await clickTileAndSniffPdf(page, t);
        await ensureDocumentsOpen(page);
        if(!pdfUrl || seen.has(pdfUrl)) continue;
        seen.add(pdfUrl);
        const det = await analyzeAddendumPdf(page.context(), baseUrl, pdfUrl);
        results.push({ label:t.label, url:pdfUrl, ...det });
      }

      if(results.length){
        const hit = results.find(r=>r.isCWCOT);
        if(hit) return { selection_reason:'paa_cwcot_hit', ...hit, tiles_seen: tiles.length, tiles_labels: tiles.map(x=>x.label) };
        return { selection_reason:'paa_no_cwcot', ...results[0], tiles_seen: tiles.length, tiles_labels: tiles.map(x=>x.label) };
      }

      // Hydration fallback restricted to PAA-like URLs only
      const hiddenLinks = await parseHydrationLinksFromHTML(page);
      const paaHidden = hiddenLinks.find(u=>/purchase.*agreement.*addendum/i.test(u) || /addendum.*to.*purchase.*agreement/i.test(u));
      if(paaHidden){
        const det = await analyzeAddendumPdf(page.context(), baseUrl, paaHidden);
        return { selection_reason:'hydration_paa', label:'(hidden PAA)', url: paaHidden, ...det, tiles_seen: tiles.length, tiles_labels: tiles.map(x=>x.label) };
      }

      // Legacy restricted to PAA
      const legacy = await getAddendumUrl(page, baseUrl);
      if(legacy){
        const det = await analyzeAddendumPdf(page.context(), baseUrl, legacy);
        return { selection_reason:'legacy_paa', label:'(legacy PAA)', url: legacy, ...det, tiles_seen: tiles.length, tiles_labels: tiles.map(x=>x.label) };
      }

      return { selection_reason:'paa_not_found', url:'', isCWCOT:false, cwcot_hits:[], cwcot_rev:'', detection_source:'', filename:'', pdf_text_sample:'', label:'', tiles_seen: tiles.length, tiles_labels: tiles.map(x=>x.label) };
    }catch(e){ if(!/detached frame|Execution context was destroyed|Cannot find context/i.test(String(e))||attempt===2) throw e; await safe(()=>page.goto(page.url(),{waitUntil:'domcontentloaded',timeout:60000})).catch(()=>{}); await waitSettle(page); }
  }
}

async function getAddendumUrl(page, baseUrl){
  await patchPdfSniffer(page); await patchClickCapture(page); await ensureDocumentsOpen(page);
  const direct=await safe(()=>page.evaluate(()=>{ const want=/(purchase\s*agreement\s*addendum|addendum\s*to\s*purchase\s*agreement)/i; const bad=/prohibited\s+sales\s+addendum/i; const root=document.querySelector('[data-elm-id="documents_content"]')||document.querySelector('.adc__documents')||document.querySelector('[data-elm-id="documents"]'); const a=root?[...root.querySelectorAll('a[href]')]:[]; const el=a.find(n=>{ const t=(n.innerText||n.textContent||'').trim(); const h=(n.getAttribute('href')||n.href||''); return want.test(t)&&!bad.test(t)&&/\.pdf(\?|$)/i.test(h); }); return el ? (el.getAttribute('href')||el.href||'') : ''; })).catch(()=> '');
  if(direct) return toAbs(direct, baseUrl);
  const preHits=(page.__pdf_hits||[]).length;
  const popupWait=page.waitForEvent('popup',{timeout:9000}).then(async p=>{ let u=''; try{ await p.waitForLoadState('domcontentloaded',{timeout:7000}).catch(()=>{}); u=p.url()||''; }catch{} try{ await p.close().catch(()=>{}); }catch{} return u; }).catch(()=> '');
  await safe(()=>page.evaluate(()=>{ const want=/(purchase\s*agreement\s*addendum|addendum\s*to\s*purchase\s*agreement)/i; const bad=/prohibited\s+sales\s+addendum/i; const root=document.querySelector('[data-elm-id="documents_content"]')||document.querySelector('.adc__documents')||document.querySelector('[data-elm-id="documents"]'); const cands=root?[...root.querySelectorAll('[data-elm-id="document_section_doc_doc"], a, button, [role="link"], [role="button"]')]:[]; const el=cands.find(n=>{ const t=(n.innerText||n.textContent||'').trim(); return want.test(t)&&!bad.test(t); }); if(el){ let target=el.querySelector&&el.querySelector('a,button,[role="button"],[role="link"]'); if(!target) target=el; try{ target.removeAttribute&&target.removeAttribute('target'); }catch{} target.scrollIntoView({block:'center'}); target.click(); target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); } })).catch(()=>{});
  await sleep(1200);
  const nowUrl=await safe(()=>page.url()).catch(()=> ''); if(/\.pdf(\?|$)/i.test(nowUrl)||/imgix\.net\/resi\/globalDocuments\/.+\.pdf/i.test(nowUrl)) return nowUrl;
  const popupUrl=await popupWait; if(popupUrl) return popupUrl;
  const hits=getNewPdfHits(page, preHits); if(hits[0]) return toAbs(hits[0], baseUrl);
  for(let i=0;i<8;i++){ const perfHit=await safe(()=>page.evaluate(()=>{ try{ const entries=performance.getEntriesByType('resource')||[]; const m=entries.find(e=>/imgix\.net\/resi\/globalDocuments\/.+\.pdf/i.test(e.name||'')); return m?m.name:''; }catch{ return ''; } })).catch(()=> ''); if(perfHit) return toAbs(perfHit, baseUrl); await sleep(400); }
  const html=await safe(()=>page.content()).catch(()=> ''); const m=html&&html.match(/https?:\/\/[^"']+imgix\.net\/resi\/globalDocuments\/[^"']+\.pdf/gi); if(m&&m.length) return m[0];
  const cap=await readCapture(page); if(cap.openUrl) return toAbs(cap.openUrl, baseUrl); if(cap.anchorHref) return toAbs(cap.anchorHref, baseUrl); if((cap.blobUrls||[])[0]) return cap.blobUrls[0];
  return '';
}









