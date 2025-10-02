// api/company-by-domain.js
// Start from a company website domain (e.g., ?domain=google.com)
// Pipeline:
// 1) Normalize domain -> URL
// 2) Find Wikidata entity by official website (P856) via SPARQL
// 3) Resolve English Wikipedia sitelink and scrape infobox with Puppeteer
// 4) Enrich with Wikidata (employees structured, industries, HQ structured, types, tickers)
// 5) Finance (Finnhub or Yahoo fallback), OpenCorporates (optional)
// 6) Extract social links from the provided website
//
// Works on Vercel (Serverless) with puppeteer-core + @sparticuz/chromium,
// and locally with devDependency "puppeteer".

const chromium = require("@sparticuz/chromium");
const puppeteerCore = require("puppeteer-core");
let localPuppeteer; try { localPuppeteer = require("puppeteer"); } catch {}

const unique = (arr) => Array.from(new Set((arr || []).filter(Boolean).map(x => String(x).trim()).filter(Boolean)));
const RE_QID = /^Q\d+$/i;
const EXCHANGE_PREFERENCE = ["NASDAQ","NYSE","NYSE ARCA","NYSE AMERICAN","LSE","TSE","HKEX"];

/* ------------------------------ Domain helpers ------------------------------ */
function normalizeDomainInput(input) {
  if (!input) return null;
  let d = String(input).trim();
  // If they passed a URL, take the hostname
  try {
    if (/^https?:\/\//i.test(d)) {
      const u = new URL(d);
      d = u.hostname;
    }
  } catch {}
  // Drop leading www.
  d = d.replace(/^www\./i, "");
  return d.toLowerCase();
}

function domainToUrl(domain) {
  // Prefer https
  return `https://${domain}/`;
}

/* ------------------------------- Wikipedia ---------------------------------- */
const wikipediaUrlForTitle = (title) =>
  title ? `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}` : null;

/* -------------------------------- Wikidata ---------------------------------- */
async function getWikidataEntities(ids) {
  const qids = (ids || []).filter(id => RE_QID.test(id));
  if (!qids.length) return null;
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${qids.join("|")}.json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json?.entities || null;
}

// Find Q-id by official website (P856) using SPARQL.
// Tries https/http and with/without trailing slash.
async function findWikidataByWebsite(websiteUrl) {
  const variants = [];
  try {
    const u = new URL(websiteUrl);
    const host = u.hostname;
    const basePath = u.pathname === "/" ? "" : u.pathname;
    const paths = [ "", "/", basePath.endsWith("/") ? basePath : `${basePath}/` ];
    const schemes = ["https:", "http:"];

    for (const scheme of schemes) {
      for (const p of paths) {
        const v = `${scheme}//${host}${p}`;
        if (!variants.includes(v)) variants.push(v);
      }
    }
  } catch {
    return null;
  }

  // Build SPARQL: look for any item with wdt:P856 equal to one of our variants
  const ors = variants.map(v => `?w = <${v}>`).join(" || ");
  const query = `
    SELECT ?item WHERE {
      ?item wdt:P856 ?w .
      FILTER (${ors})
    } LIMIT 5
  `.trim();

  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": "vercel-puppeteer-company/1.0" } });
  if (!res.ok) return null;
  const json = await res.json();
  const bindings = json?.results?.bindings || [];
  const ids = bindings
    .map(b => b.item?.value)
    .map(uri => uri && uri.split("/").pop())
    .filter(id => RE_QID.test(id));
  return ids[0] || null;
}

function extractFromWikidata(entity) {
  if (!entity?.claims) return {};
  const claims = entity.claims;

  const latestByP585 = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const scored = arr.map(st => {
      const t = st.qualifiers?.P585?.[0]?.datavalue?.value?.time; // +2024-00-00T00:00:00Z
      const key = t ? Number(t.replace(/[^\d]/g, "").slice(0,8)) : 0;
      return { st, key };
    }).sort((a,b) => b.key - a.key);
    return scored[0].st;
  };

  // Website (P856)
  const website = claims.P856?.[0]?.mainsnak?.datavalue?.value || null;

  // Employees (P1128) -> structured
  let employees = null;
  const emp = latestByP585(claims.P1128);
  if (emp?.mainsnak?.datavalue?.value) {
    const v = emp.mainsnak.datavalue.value; // { amount:"+12345" }
    const raw = (v.amount || "").replace(/^\+/, "");
    const count = raw ? Number(raw) : null;

    const dateStr = emp.qualifiers?.P585?.[0]?.datavalue?.value?.time || null; // "+2024-06-30T00:00:00Z"
    const as_of = dateStr ? dateStr.replace(/^[+]/, "").replace(/T.*$/, "") : null; // "2024-06-30"

    if (Number.isFinite(count) || as_of) {
      employees = { count: Number.isFinite(count) ? count : null, as_of: as_of || null };
    }
  }

  // Industries (P452)
  const industryIds = (claims.P452 || []).map(x => x.mainsnak?.datavalue?.value?.id).filter(Boolean);

  // HQ location (P159)
  const headquartersId = claims.P159?.[0]?.mainsnak?.datavalue?.value?.id || null;

  // Type (P31)
  const typeIds = (claims.P31 || []).map(x => x.mainsnak?.datavalue?.value?.id).filter(Boolean);

  // Tickers (P249) + exchange (P414)
  const tickerStmts = (claims.P249 || []);
  const tickers = tickerStmts.map(st => {
    const symbol = st.mainsnak?.datavalue?.value || null;
    const exchangeId = st.qualifiers?.P414?.[0]?.datavalue?.value?.id || null;
    return symbol ? { symbol, exchangeId } : null;
  }).filter(Boolean);

  // English Wikipedia sitelink (if present)
  const enwiki = entity?.sitelinks?.enwiki?.title || null;

  // Fallback display label
  const name = entity?.labels?.en?.value || null;

  return { website, employees, industryIds, headquartersId, typeIds, tickers, enwiki, name };
}

function resolveLabels(entities, ids) {
  return (ids || []).map(id => entities?.[id]?.labels?.en?.value || null).filter(Boolean);
}

/* -------------------------- Structured Headquarters -------------------------- */
async function buildHeadquarters(entities, headquartersId) {
  if (!headquartersId || !entities?.[headquartersId]) return null;
  const hq = entities[headquartersId];

  const label = hq.labels?.en?.value || null;
  const getClaimId = (e, pid) => e?.claims?.[pid]?.[0]?.mainsnak?.datavalue?.value?.id || null;
  const getClaimVal = (e, pid) => e?.claims?.[pid]?.[0]?.mainsnak?.datavalue?.value || null;

  const countryId = getClaimId(hq, "P17");
  const admin1Id = getClaimId(hq, "P131");
  let admin2Id = null;

  const toFetch = unique([admin1Id, countryId].filter(Boolean));
  let more = {};
  if (toFetch.length) {
    more = await getWikidataEntities(toFetch) || {};
  }
  if (admin1Id && more[admin1Id]) {
    admin2Id = getClaimId(more[admin1Id], "P131") || null;
    if (admin2Id && !more[admin2Id]) {
      const more2 = await getWikidataEntities([admin2Id]) || {};
      more = { ...more, ...more2 };
    }
  }

  const country = countryId ? (entities[countryId]?.labels?.en?.value || more[countryId]?.labels?.en?.value || null) : null;

  const INSTANCE_OF = "P31";
  const Q_CITY = "Q515";
  const Q_HUMAN_SETTLEMENT = "Q486972";
  const looksLike = (e, qid) => (e?.claims?.[INSTANCE_OF] || []).some(st => st.mainsnak?.datavalue?.value?.id === qid);

  let city = null, region = null;
  const admin1 = admin1Id ? (entities[admin1Id] || more[admin1Id]) : null;
  const admin2 = admin2Id ? (entities[admin2Id] || more[admin2Id]) : null;

  if (admin1) {
    if (looksLike(admin1, Q_CITY) || looksLike(admin1, Q_HUMAN_SETTLEMENT)) city = admin1.labels?.en?.value;
    else region = admin1.labels?.en?.value;
  }
  if (!city && admin2) {
    if (looksLike(admin2, Q_CITY) || looksLike(admin2, Q_HUMAN_SETTLEMENT)) city = admin2.labels?.en?.value;
    else if (!region) region
