// api/scrape.js
// Search by company name -> aggregate from Wikipedia + Wikidata
// Works on Vercel (Serverless) with puppeteer-core + @sparticuz/chromium, and locally with puppeteer.

const chromium = require("@sparticuz/chromium");
const puppeteerCore = require("puppeteer-core");

let localPuppeteer;
try { localPuppeteer = require("puppeteer"); } catch {}

function unique(arr) {
  return Array.from(new Set((arr || []).filter(Boolean).map(s => s.trim()).filter(Boolean)));
}

function normalizeText(s) {
  return (s || "").replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
}

async function wikipediaSearchTitle(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    query
  )}&srlimit=1&format=json&utf8=1&srwhat=text&srinfo=suggestion`;
  const res = await fetch(url, { headers: { "User-Agent": "vercel-puppeteer-scraper/1.0" } });
  if (!res.ok) throw new Error(`Wikipedia search failed: ${res.status}`);
  const json = await res.json();
  const hit = json?.query?.search?.[0];
  return hit?.title || null;
}

async function wikipediaPageUrlFor(query) {
  const title = await wikipediaSearchTitle(query);
  if (!title) return null;
  // Normalize spaces -> underscores
  return `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}`;
}

async function getWikidataIdForTitle(title) {
  // Ask Wikipedia for the wikibase item (Q-id)
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&titles=${encodeURIComponent(
    title
  )}&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const pages = json?.query?.pages || {};
  const first = Object.values(pages)[0];
  return first?.pageprops?.wikibase_item || null;
}

async function getWikidataEntities(ids) {
  if (!ids?.length) return null;
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${ids.join("|")}.json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json?.entities || null;
}

function extractWikidataValueSnippets(entity) {
  if (!entity?.claims) return {};
  const claims = entity.claims;

  const pickLatestTimeSnak = (arr) => {
    // Choose the statement with the most recent P585 (point in time); else first
    if (!Array.isArray(arr) || !arr.length) return null;
    const scored = arr.map(st => {
      const qualifiers = st.qualifiers || {};
      const p585 = qualifiers.P585?.[0]?.datavalue?.value?.time; // e.g., +2024-00-00T00:00:00Z
      const t = p585 ? Number(p585.replace(/[^\d]/g, "").slice(0, 8)) : 0;
      return { st, t };
    });
    scored.sort((a,b) => b.t - a.t);
    return scored[0].st;
  };

  // Official website P856 (URL)
  const website =
    claims.P856?.[0]?.mainsnak?.datavalue?.value ||
    null;

  // Number of employees P1128 (Quantity)
  let company_size = null;
  const empStmt = pickLatestTimeSnak(claims.P1128);
  if (empStmt?.mainsnak?.datavalue?.value) {
    const v = empStmt.mainsnak.datavalue.value; // { amount: "+123", unit: "1" }
    const raw = (v.amount || "").replace(/^\+/, "");
    const pointInTime = empStmt.qualifiers?.P585?.[0]?.datavalue?.value?.time || null;
    const asOf = pointInTime ? pointInTime.replace(/[+T].*$/, "") : null;
    company_size = raw ? `${Number(raw).toLocaleString()}${asOf ? ` (as of ${asOf})` : ""}` : null;
  }

  // Industries P452 -> array of Q-ids
  const industryIds = (claims.P452 || [])
    .map(st => st.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);

  // Headquarters location P159 -> first Q-id
  const headquartersId = claims.P159?.[0]?.mainsnak?.datavalue?.value?.id || null;

  // Type (instance of) P31 -> array of Q-ids (e.g., "public company", "technology company")
  const typeIds = (claims.P31 || [])
    .map(st => st.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);

  return { website, company_size, industryIds, headquartersId, typeIds };
}

function labelsFromEntities(entities, ids) {
  if (!entities || !ids?.length) return [];
  return ids
    .map(id => entities[id]?.labels?.en?.value || entities[id]?.labels?.en?.value || null)
    .filter(Boolean);
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const q = req.query?.q || req.body?.q;
  if (!q || typeof q !== "string") {
    res.status(400).json({ error: 'Provide a company name via ?q=Google' });
    return;
  }

  const isLocal = !process.env.VERCEL;
  let browser;

  try {
    // 1) Resolve a Wikipedia page URL from the query
    const wikiUrl = await wikipediaPageUrlFor(q);
    if (!wikiUrl) {
      res.status(404).json({ ok: false, error: `No Wikipedia result for "${q}"` });
      return;
    }

    // For enrichment, also resolve the page title (for Wikidata lookup)
    const pageTitle = decodeURIComponent(wikiUrl.split("/wiki/")[1] || "").replace(/_/g, " ");
    const wikidataId = await getWikidataIdForTitle(pageTitle);

    // 2) Launch browser (local vs Vercel)
    if (isLocal && localPuppeteer) {
      browser = await localPuppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
    } else {
      browser = await puppeteerCore.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: "shell"
      });
    }

    // 3) Scrape the infobox from the resolved Wikipedia page
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    await page.goto(wikiUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("#firstHeading", { timeout: 15000 }).catch(() => {});
    await page.waitForSelector(".infobox", { timeout: 8000 }).catch(() => {});

    const wikiData = await page.evaluate(() => {
      const $ = (sel, root = document) => root.querySelector(sel);
      const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
      const normalize = (s) => (s || "").replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
      const txt = (el) => (el ? normalize(el.textContent || "") : null);

      const infobox = $(".infobox") || $(".infobox.vcard");

      const findRow = (labels) => {
        if (!infobox) return null;
        const rows = $$("tr", infobox);
        const m = rows.find((tr) => {
          const th = $("th", tr);
          const label = normalize(th?.innerText || "").toLowerCase();
          return labels.some((target) =>
            label === target.toLowerCase() || label.includes(target.toLowerCase())
          );
        });
        return m ? $("td", m) : null;
      };

      const cellToArray = (td) => {
        if (!td) return null;
        const lis = $$("li", td).map((li) => txt(li)).filter(Boolean);
        if (lis.length) return Array.from(new Set(lis));
        const raw = txt(td);
        if (!raw) return null;
        const parts = raw.split(/\n|•|·|,|;/).map((s) => normalize(s)).filter(Boolean);
        return Array.from(new Set(parts));
      };

      const websiteTD = findRow(["Website"]);
      const website = $("a.url", websiteTD || infobox)?.href ||
                      $("a.external", websiteTD || infobox)?.href || null;

      const name = txt(document.querySelector("#firstHeading"));
      const company_size = txt(findRow(["Number of employees", "Employees", "No. of employees"]));
      const industry = cellToArray(findRow(["Industry"]));
      const headquarters = txt(findRow(["Headquarters", "Headquarters location"]));
      const type = txt(findRow(["Type", "Company type"]));
      const specialties = cellToArray(
        findRow(["Products and services"]) || findRow(["Products"]) || findRow(["Services"])
      );

      return {
        name, website, company_size, industry, headquarters, type, specialties
      };
    });

    // 4) Enrich with Wikidata (if available)
    let enriched = {};
    if (wikidataId) {
      const entities = await getWikidataEntities([wikidataId]);
      const main = entities?.[wikidataId] || null;
      const { website: wdWebsite, company_size: wdEmployees, industryIds, headquartersId, typeIds } =
        extractWikidataValueSnippets(main);

      // Resolve labels for industry/HQ/type
      const toResolve = unique([...(industryIds || []), headquartersId, ...(typeIds || [])]);
      let resolvedLabels = {};
      if (toResolve.length) {
        const extra = await getWikidataEntities(toResolve);
        resolvedLabels = extra || {};
      }

      const industries = labelsFromEntities(resolvedLabels, industryIds || []);
      const headquartersLabel = labelsFromEntities(resolvedLabels, headquartersId ? [headquartersId] : [])[0] || null;
      const types = labelsFromEntities(resolvedLabels, typeIds || []);

      enriched = {
        website: wdWebsite || null,
        company_size: wdEmployees || null,
        industry: industries.length ? industries : null,
        headquarters: headquartersLabel || null,
        type: types.length ? types.join(", ") : null
      };
    }

    // 5) Merge + clean
    const merged = {
      name: wikiData.name || q,
      website: enriched.website || wikiData.website || null,
      company_size: enriched.company_size || wikiData.company_size || null,
      industry: unique([...(wikiData.industry || []), ...(enriched.industry || [])]),
      headquarters: enriched.headquarters || wikiData.headquarters || null,
      type: enriched.type || wikiData.type || null,
      specialties: unique(wikiData.specialties || [])
    };

    res.status(200).json({
      ok: true,
      query: q,
      source: { wikipedia: wikiUrl, wikidata: wikidataId || null },
      scrapedAt: new Date().toISOString(),
      data: merged
    });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
};
