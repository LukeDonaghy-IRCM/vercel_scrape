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
    else if (!region) region = admin2.labels?.en?.value;
  }

  const coords = getClaimVal(hq, "P625");
  const coordinates = coords && (typeof coords.latitude === "number" && typeof coords.longitude === "number")
    ? { lat: coords.latitude, lon: coords.longitude }
    : null;

  if (!city || !country) {
    const parsed = (label || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!city && parsed.length >= 2) city = parsed[0];
    if (!region && parsed.length >= 3) region = parsed[1];
    if (!country && parsed.length) country = parsed[parsed.length - 1];
  }

  return {
    raw: label,
    place: label,
    city: city || null,
    region: region || null,
    country: country || null,
    coordinates
  };
}

/* ------------------------------ Employees (Wiki) ----------------------------- */
function parseEmployeesString(raw) {
  if (!raw) return null;
  const numMatch = raw.replace(/[,.\s]/g, '').match(/\d{3,}/);
  const count = numMatch ? Number(numMatch[0]) : null;

  const paren = raw.match(/\(([^)]+)\)/);
  const chunk = (paren ? paren[1] : raw);

  const dmy = chunk.match(/(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/);
  const mdy = chunk.match(/([A-Za-z]{3,}\s+\d{1,2},?\s+\d{4})/);
  const iso = chunk.match(/(\d{4}-\d{2}-\d{2})/);
  const ym  = chunk.match(/([A-Za-z]{3,}\s+\d{4})/);
  const yr  = chunk.match(/(\d{4})/);

  const pick = (m) => (m && m[1]) ? m[1] : null;
  const found = pick(iso) || pick(dmy) || pick(mdy) || pick(ym) || pick(yr);

  let as_of = null;
  if (found) {
    try {
      if (/^\d{4}$/.test(found)) as_of = `${found}-01-01`;
      else {
        const dt = new Date(found);
        if (!isNaN(dt)) {
          const y = dt.getUTCFullYear();
          const m = String(dt.getUTCMonth()+1).padStart(2, '0');
          const d = String(dt.getUTCDate()).padStart(2, '0');
          as_of = `${y}-${m}-${d}`;
        }
      }
    } catch {}
  }

  if (Number.isFinite(count) || as_of) return { count: Number.isFinite(count) ? count : null, as_of: as_of || null };
  return null;
}

/* --------------------------------- Finance ---------------------------------- */
async function fetchFinnhubQuote(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !symbol) return null;
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  if (!j || typeof j.c !== "number") return null;
  return { stock_price: j.c };
}
async function fetchYahooFinance(symbol) {
  if (!symbol) return null;
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price,summaryDetail,defaultKeyStatistics`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  const j = await res.json();
  const r = j?.quoteSummary?.result?.[0];
  if (!r) return null;
  const price = r.price?.regularMarketPrice?.raw ?? r.price?.postMarketPrice?.raw ?? null;
  const mc = r.price?.marketCap?.raw
          ?? r.summaryDetail?.marketCap?.raw
          ?? r.defaultKeyStatistics?.enterpriseValue?.raw
          ?? null;
  return { stock_price: typeof price === "number" ? price : null, market_cap: typeof mc === "number" ? mc : null };
}

/* ------------------------------ OpenCorporates ------------------------------- */
async function fetchOpenCorporates(query) {
  const token = process.env.OPENCORPORATES_API_TOKEN;
  const url = `https://api.opencorporates.com/companies/search?q=${encodeURIComponent(query)}${token ? `&api_token=${token}` : ""}&per_page=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  const first = j?.results?.companies?.[0]?.company;
  if (!first) return null;
  return {
    jurisdiction: first.jurisdiction_code || null,
    company_number: first.company_number || null
  };
}

/* ----------------------- Social links from company site ---------------------- */
const SOCIAL_DOMAINS = {
  x: ["x.com","twitter.com"],
  facebook: ["facebook.com"],
  instagram: ["instagram.com"],
  youtube: ["youtube.com","youtu.be"],
  linkedin: ["linkedin.com"],
  tiktok: ["tiktok.com"],
  github: ["github.com"],
  medium: ["medium.com"],
  reddit: ["reddit.com"],
  threads: ["threads.net"],
  bluesky: ["bsky.app"],
  mastodon: ["mastodon.social","fosstodon.org","hachyderm.io"], // extend as needed
  pinterest: ["pinterest.com"]
};
function classifySocial(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const [key, domains] of Object.entries(SOCIAL_DOMAINS)) {
      if (domains.some(d => host === d || host.endsWith(`.${d}`))) return key;
    }
    return null;
  } catch { return null; }
}
async function fetchCompanySocials(website) {
  if (!website) return null;
  try {
    const url = website.startsWith("http") ? website : `https://${website}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const html = await res.text();

    const hrefs = Array.from(html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)).map(m => m[1]);
    const relMe = Array.from(html.matchAll(/<a[^>]+rel=["'][^"']*?\bme\b[^"']*?["'][^>]*href=["']([^"']+)["']/gi)).map(m => m[1]);

    const links = unique([...hrefs, ...relMe].filter(h => /^https?:\/\//i.test(h)));
    const result = {};
    for (const link of links) {
      const key = classifySocial(link);
      if (key && !result[key]) result[key] = link;
    }
    return Object.keys(result).length ? result : null;
  } catch {
    return null;
  }
}

/* ----------------------- Puppeteer: Wikipedia infobox ------------------------ */
async function scrapeWikipediaInfobox(browser, wikiUrl) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  await page.goto(wikiUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#firstHeading", { timeout: 15000 }).catch(() => {});
  await page.waitForSelector(".infobox", { timeout: 8000 }).catch(() => {});

  const data = await page.evaluate(() => {
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const norm = (s) => (s || "").replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
    const txt = (el) => (el ? norm(el.textContent || "") : null);
    const infobox = $(".infobox") || $(".infobox.vcard");
    const findRow = (labels) => {
      if (!infobox) return null;
      const rows = $$("tr", infobox);
      const m = rows.find((tr) => {
        const th = $("th", tr);
        const label = norm(th?.innerText || "").toLowerCase();
        return labels.some(t => label === t.toLowerCase() || label.includes(t.toLowerCase()));
      });
      return m ? $("td", m) : null;
    };
    const cellToArray = (td) => {
      if (!td) return null;
      const lis = $$("li", td).map(li => txt(li)).filter(Boolean);
      if (lis.length) return Array.from(new Set(lis));
      const raw = txt(td);
      if (!raw) return null;
      const parts = raw.split(/\n|•|·|,|;/).map(s => norm(s)).filter(Boolean);
      return Array.from(new Set(parts));
    };

    const name = txt($("#firstHeading"));
    const websiteTD = findRow(["Website"]);
    const website = $("a.url", websiteTD || infobox)?.href || $("a.external", websiteTD || infobox)?.href || null;
    const company_size = txt(findRow(["Number of employees", "Employees", "No. of employees"]));
    const industry = cellToArray(findRow(["Industry"]));
    const headquarters = txt(findRow(["Headquarters", "Headquarters location"]));
    const type = txt(findRow(["Type", "Company type"]));
    const specialties = cellToArray(findRow(["Products and services"]) || findRow(["Products"]) || findRow(["Services"]));

    return { name, website, company_size, industry, headquarters, type, specialties };
  });

  await page.close().catch(() => {});
  return data;
}

/* -------------------------------- Main handler ------------------------------- */
module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const domainRaw = (req.query?.domain || req.body?.domain || "").trim();
  const domain = normalizeDomainInput(domainRaw);
  if (!domain) {
    res.status(400).json({ error: 'Provide a domain via ?domain=example.com (or full URL).' });
    return;
  }

  const websiteUrl = domainToUrl(domain);
  const isLocal = !process.env.VERCEL;
  let browser;

  try {
    // 1) Identify Wikidata entity from website
    const qid = await findWikidataByWebsite(websiteUrl);

    // 2) Gather from Wikidata (labels, sitelinks, claims)
    let wikipediaUrl = null;
    let baseName = null;
    let enriched = {};
    let tickers = [];
    let hqStruct = null;

    if (qid) {
      const entities = await getWikidataEntities([qid]);
      const main = entities?.[qid] || null;

      const {
        website: wdWebsite,
        employees: wdEmployees,
        industryIds, headquartersId, typeIds,
        tickers: tickerPairs,
        enwiki,
        name
      } = extractFromWikidata(main);

      baseName = name || null;
      wikipediaUrl = enwiki ? wikipediaUrlForTitle(enwiki) : null;

      // Resolve labels for industry/HQ/type and exchanges
      const idsToResolve = unique([ ...(industryIds||[]), headquartersId, ...(typeIds||[]), ...(tickerPairs||[]).map(t => t.exchangeId).filter(Boolean) ]);
      const labelEntities = idsToResolve.length ? await getWikidataEntities(idsToResolve) : null;

      const industries = resolveLabels(labelEntities, industryIds || []);
      const types = resolveLabels(labelEntities, typeIds || []);

      // HQ structured
      if (headquartersId) {
        const extended = { ...(labelEntities || {}), ...(entities || {}) };
        hqStruct = await buildHeadquarters(extended, headquartersId);
      }

      // Tickers
      tickers = (tickerPairs || []).map(t => ({
        symbol: t.symbol,
        exchange: t.exchangeId ? (resolveLabels(labelEntities, [t.exchangeId])[0] || null) : null
      }));

      enriched = {
        website: wdWebsite || websiteUrl,
        employees: wdEmployees || null,
        industry: industries.length ? industries : null,
        type: types.length ? types.join(", ") : null
      };
    }

    // 3) If we have a Wikipedia URL, scrape its infobox
    if (!wikipediaUrl && baseName) {
      // If no enwiki sitelink, we can skip scraping; alternatively you could
      // add a fallback search by the baseName, but to stay tied to the domain
      // we keep it strict. Uncomment for fallback:
      // const title = await wikipediaSearchTitle(baseName);
      // wikipediaUrl = title ? wikipediaUrlForTitle(title) : null;
    }

    // Launch browser if needed
    if (wikipediaUrl) {
      if (isLocal && localPuppeteer) {
        browser = await localPuppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      } else {
        browser = await puppeteerCore.launch({
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(),
          headless: "shell"
        });
      }
    }

    let wiki = { name: baseName || null, website: enriched.website || websiteUrl, company_size: null, industry: null, headquarters: null, type: null, specialties: null };
    if (wikipediaUrl && browser) {
      wiki = await scrapeWikipediaInfobox(browser, wikipediaUrl);
      // Make sure we keep a fallback website
      if (!wiki.website) wiki.website = enriched.website || websiteUrl;
    }

    // 4) Employees: prefer Wikidata structured; else parse Wikipedia string
    const wikiEmployeesParsed = parseEmployeesString(wiki.company_size);
    const employees = enriched.employees || wikiEmployeesParsed || null;

    // 5) Choose primary ticker
    const choosePrimaryTicker = (arr) => {
      if (!arr?.length) return null;
      for (const pref of EXCHANGE_PREFERENCE) {
        const hit = arr.find(t => (t.exchange || "").toUpperCase().includes(pref));
        if (hit) return hit.symbol;
      }
      return arr[0].symbol;
    };
    const primaryTicker = choosePrimaryTicker(tickers);

    // 6) Finance
    let financials = null;
    if (primaryTicker) {
      financials = await fetchFinnhubQuote(primaryTicker) || await fetchYahooFinance(primaryTicker);
      if (financials) {
        financials.ticker = primaryTicker;
        if (typeof financials.market_cap === "number") {
          const cap = financials.market_cap;
          const fmt = cap >= 1e12 ? `${(cap/1e12).toFixed(2)}T`
                    : cap >= 1e9  ? `${(cap/1e9).toFixed(2)}B`
                    : cap >= 1e6  ? `${(cap/1e6).toFixed(2)}M`
                    : cap.toString();
          financials.market_cap = fmt;
        }
      }
    }

    // 7) OpenCorporates (optional)
    const openCorporates = await fetchOpenCorporates(domain);

    // 8) Socials from the provided website
    const socials = await fetchCompanySocials(websiteUrl);

    // 9) Merge
    const merged = {
      name: wiki.name || baseName || domain,
      website: enriched.website || wiki.website || websiteUrl,
      employees, // { count, as_of } or null
      industry: unique([...(wiki.industry || []), ...(enriched.industry || [])]),
      headquarters: hqStruct || (wiki.headquarters ? {
        raw: wiki.headquarters,
        place: wiki.headquarters.split(",")[0]?.trim() || null,
        city: wiki.headquarters.split(",")[1]?.trim() || null,
        region: wiki.headquarters.split(",")[2]?.trim() || null,
        country: wiki.headquarters.split(",").slice(-1)[0]?.trim() || null,
        coordinates: null
      } : null),
      type: enriched.type || wiki.type || null,
      specialties: unique(wiki.specialties || [])
    };

    const payload = {
      ...merged,
      financials: financials ? { ticker: financials.ticker, market_cap: financials.market_cap || null, stock_price: financials.stock_price || null } : null,
      open_corporates: openCorporates || null,
      social: socials || null
    };

    res.status(200).json({
      ok: true,
      domain,
      source: {
        wikidata: qid || null,
        wikipedia: wikipediaUrl || null,
        finance: financials ? (process.env.FINNHUB_API_KEY ? "Finnhub" : "YahooFinance") : null,
        open_corporates: !!openCorporates,
        socials_from: websiteUrl
      },
      scrapedAt: new Date().toISOString(),
      data: payload,
      tickers // keep for debug; remove if you want
    });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
};
