// api/company.js
// Multi-source aggregator for company info.
// Sources: Wikipedia (scrape), Wikidata (API), Finnhub or Yahoo Finance (optional),
// OpenCorporates (optional), Google News RSS (no key), GitHub org (best-effort).
//
// Requires: @sparticuz/chromium, puppeteer-core
// Local dev: puppeteer (devDependency)

const chromium = require("@sparticuz/chromium");
const puppeteerCore = require("puppeteer-core");
let localPuppeteer; try { localPuppeteer = require("puppeteer"); } catch {}

// ---------- small utils ----------
const unique = (arr) => Array.from(new Set((arr || []).filter(Boolean).map(s => String(s).trim()).filter(Boolean)));
const cleanText = (s) => (s || "").replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? null]));

const RE_QID = /^Q\d+$/i;

// Prefer US exchange tickers when multiple are present
const EXCHANGE_PREFERENCE = [
  "NASDAQ", "NYSE", "NYSE ARCA", "NYSE American",
  "LSE", "TSE", "HKEX"
];

// ---------- Wikipedia helpers ----------
async function wikipediaSearchTitle(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&utf8=1&srwhat=text&srinfo=suggestion`;
  const res = await fetch(url, { headers: { "User-Agent": "vercel-puppeteer-company/1.0" } });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.query?.search?.[0]?.title || null;
}
const wikipediaUrlForTitle = (title) => title ? `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}` : null;

async function getWikidataIdForTitle(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&titles=${encodeURIComponent(title)}&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const pages = json?.query?.pages || {};
  const first = Object.values(pages)[0];
  return first?.pageprops?.wikibase_item || null;
}

// ---------- Wikidata helpers ----------
async function getWikidataEntities(ids) {
  const qids = (ids || []).filter(id => RE_QID.test(id));
  if (!qids.length) return null;
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${qids.join("|")}.json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json?.entities || null;
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

  // Employees (P1128)
  let employees = null;
  const emp = latestByP585(claims.P1128);
  if (emp?.mainsnak?.datavalue?.value) {
    const v = emp.mainsnak.datavalue.value; // { amount:"+12345" }
    const raw = (v.amount || "").replace(/^\+/, "");
    const date = emp.qualifiers?.P585?.[0]?.datavalue?.value?.time?.replace(/[+T].*$/,"") || null;
    employees = raw ? `${Number(raw).toLocaleString()}${date ? ` (as of ${date})` : ""}` : null;
  }

  // Industries (P452) -> Qids
  const industryIds = (claims.P452 || []).map(x => x.mainsnak?.datavalue?.value?.id).filter(Boolean);

  // HQ location (P159) -> Qid
  const headquartersId = claims.P159?.[0]?.mainsnak?.datavalue?.value?.id || null;

  // Type (P31) -> array of Qids
  const typeIds = (claims.P31 || []).map(x => x.mainsnak?.datavalue?.value?.id).filter(Boolean);

  // Stock ticker(s) (P249) + Exchange (P414)
  const tickerStmts = (claims.P249 || []);
  const tickers = tickerStmts.map(st => {
    const symbol = st.mainsnak?.datavalue?.value || null;
    const exchangeId = st.qualifiers?.P414?.[0]?.datavalue?.value?.id || null;
    return symbol && exchangeId ? { symbol, exchangeId } : (symbol ? { symbol, exchangeId: null } : null);
  }).filter(Boolean);

  return { website, employees, industryIds, headquartersId, typeIds, tickers };
}

function resolveLabels(entities, ids) {
  return (ids || []).map(id => entities?.[id]?.labels?.en?.value || null).filter(Boolean);
}

// ---------- Finance ----------
async function fetchFinnhubQuote(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !symbol) return null;
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json(); // { c: price, ... }
  if (!j || typeof j.c !== "number") return null;
  return { stock_price: j.c };
}

// Unofficial Yahoo Finance fallback (no API key). May change without notice.
async function fetchYahooFinance(symbol) {
  if (!symbol) return null;
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price,summaryDetail,defaultKeyStatistics`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  const j = await res.json();
  const r = j?.quoteSummary?.result?.[0];
  if (!r) return null;
  const price = r.price?.regularMarketPrice?.raw ?? r.price?.postMarketPrice?.raw ?? null;

  // Market cap may be in price or defaultKeyStatistics/summaryDetail
  const mc = r.price?.marketCap?.raw
    ?? r.summaryDetail?.marketCap?.raw
    ?? r.defaultKeyStatistics?.enterpriseValue?.raw
    ?? null;

  return {
    stock_price: typeof price === "number" ? price : null,
    market_cap: typeof mc === "number" ? mc : null
  };
}

// ---------- OpenCorporates ----------
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

// ---------- News (Google News RSS) ----------
async function fetchNews(query, maxItems = 5) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [];
  // naive RSS parse – good enough for top few items
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) && items.length < maxItems) {
    const block = m[1];
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1]
               || (block.match(/<title>(.*?)<\/title>/) || [])[1] || null;
    const link  = (block.match(/<link>(.*?)<\/link>/) || [])[1] || null;
    const pub   = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || null;
    const source= (block.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || null;
    items.push({ title, url: link, source, date: pub });
  }
  return items;
}

// ---------- GitHub org (best-effort) ----------
async function fetchGithubOrg(query) {
  // Try to find an org matching the company name
  const url = `https://api.github.com/search/users?q=${encodeURIComponent(query)}+type:org&per_page=1`;
  const res = await fetch(url, { headers: { "User-Agent": "vercel-puppeteer-company/1.0" } });
  if (!res.ok) return null;
  const j = await res.json();
  const org = j?.items?.[0];
  if (!org) return null;
  return org.login || null; // e.g., "google"
}

// ---------- Puppeteer: scrape Wikipedia infobox ----------
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

// ---------- Main handler ----------
module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const q = (req.query?.q || req.body?.q || "").trim();
  if (!q) {
    res.status(400).json({ error: 'Provide a company name via ?q=Google' });
    return;
  }

  const isLocal = !process.env.VERCEL;
  let browser;

  try {
    // Resolve Wikipedia title + URL
    const title = await wikipediaSearchTitle(q);
    if (!title) {
      res.status(404).json({ ok: false, error: `No Wikipedia result for "${q}"` });
      return;
    }
    const wikipedia = wikipediaUrlForTitle(title);
    const wikidataId = await getWikidataIdForTitle(title);

    // Launch browser
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

    // Scrape Wikipedia infobox
    const wiki = await scrapeWikipediaInfobox(browser, wikipedia);

    // Pull from Wikidata
    let enriched = {};
    let tickers = [];
    if (wikidataId) {
      const entities = await getWikidataEntities([wikidataId]);
      const main = entities?.[wikidataId] || null;
      const {
        website: wdWebsite,
        employees: wdEmployees,
        industryIds, headquartersId, typeIds,
        tickers: tickerPairs
      } = extractFromWikidata(main);

      // Resolve labels for industry/HQ/type, and exchanges for tickers
      const idsToResolve = unique([ ...(industryIds||[]), headquartersId, ...(typeIds||[]), ...(tickerPairs||[]).map(t => t.exchangeId).filter(Boolean) ]);
      const labelEntities = idsToResolve.length ? await getWikidataEntities(idsToResolve) : null;

      const industries = resolveLabels(labelEntities, industryIds || []);
      const headquartersLabel = resolveLabels(labelEntities, headquartersId ? [headquartersId] : [])[0] || null;
      const types = resolveLabels(labelEntities, typeIds || []);

      // Build ticker list with exchange names
      tickers = (tickerPairs || []).map(t => ({
        symbol: t.symbol,
        exchange: t.exchangeId ? (resolveLabels(labelEntities, [t.exchangeId])[0] || null) : null
      }));

      enriched = {
        website: wdWebsite || null,
        company_size: wdEmployees || null,
        industry: industries.length ? industries : null,
        headquarters: headquartersLabel || null,
        type: types.length ? types.join(", ") : null
      };
    }

    // Choose a primary ticker if any
    const choosePrimaryTicker = (arr) => {
      if (!arr?.length) return null;
      // Prefer NASDAQ/NYSE, else first
      for (const pref of EXCHANGE_PREFERENCE) {
        const hit = arr.find(t => (t.exchange || "").toUpperCase().includes(pref));
        if (hit) return hit.symbol;
      }
      return arr[0].symbol;
    };
    const primaryTicker = choosePrimaryTicker(tickers);

    // Finance: try Finnhub (if key), else Yahoo as a best-effort fallback
    let financials = null;
    if (primaryTicker) {
      financials = await fetchFinnhubQuote(primaryTicker) || await fetchYahooFinance(primaryTicker);
      if (financials) {
        financials.ticker = primaryTicker;
        // Pretty-print market cap if present
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

    // OpenCorporates (optional, with or without token, but token avoids hard rate limits)
    const openCorporates = await fetchOpenCorporates(q);

    // News (top 5)
    const news = await fetchNews(q, 5);

    // GitHub org (best-effort)
    const githubOrg = await fetchGithubOrg(q);

    // Merge baseline + enriched
    const merged = {
      name: wiki.name || q,
      website: enriched.website || wiki.website || null,
      employees: enriched.company_size || wiki.company_size || null,
      industry: unique([...(wiki.industry || []), ...(enriched.industry || [])]),
      headquarters: enriched.headquarters || wiki.headquarters || null,
      type: enriched.type || wiki.type || null,
      specialties: unique(wiki.specialties || [])
    };

    const payload = {
      ...merged,
      financials: financials ? pick(financials, ["ticker","market_cap","stock_price"]) : null,
      open_corporates: openCorporates || null,
      news,
      social: {
        github_org: githubOrg || null
      }
    };

    res.status(200).json({
      ok: true,
      query: q,
      source: {
        wikipedia,
        wikidata: wikidataId || null,
        finance: financials ? (process.env.FINNHUB_API_KEY ? "Finnhub" : "YahooFinance") : null,
        open_corporates: !!openCorporates,
        news: "GoogleNewsRSS",
        github: !!githubOrg
      },
      scrapedAt: new Date().toISOString(),
      data: payload,
      tickers // exposed for debugging; remove if you like
    });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
};
