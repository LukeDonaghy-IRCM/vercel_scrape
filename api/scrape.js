// api/scrape.js
// Serverless Puppeteer scraper for Wikipedia company pages
// Local: uses full "puppeteer". On Vercel: uses "puppeteer-core" + "@sparticuz/chromium".

const chromium = require("@sparticuz/chromium");
const puppeteerCore = require("puppeteer-core");

let localPuppeteer;
try {
  localPuppeteer = require("puppeteer");
} catch (_) {}

function isWikipediaUrl(str) {
  try {
    const u = new URL(str);
    return (
      (u.hostname.endsWith("wikipedia.org") || u.hostname.endsWith("wikipedia.com")) &&
      (u.protocol === "http:" || u.protocol === "https:")
    );
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const url = req.query?.url || req.body?.url;
  if (!url || !isWikipediaUrl(url)) {
    res.status(400).json({
      error:
        "Provide a valid Wikipedia URL, e.g. ?url=https://en.wikipedia.org/wiki/Google",
    });
    return;
  }

  const isLocal = !process.env.VERCEL;
  let browser;

  try {
    if (isLocal && localPuppeteer) {
      browser = await localPuppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } else {
      const executablePath = await chromium.executablePath();
      browser = await puppeteerCore.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: chromium.headless,
      });
    }

    const page = await browser.newPage();

    // Reasonable headers to avoid trivial bot blocks and get full HTML
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    // Navigate & wait for the infobox/content to be present
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("#firstHeading", { timeout: 15000 }).catch(() => {});
    await page.waitForSelector(".infobox", { timeout: 8000 }).catch(() => {});

    const data = await page.evaluate(() => {
      // Helpers inside the page context
      const $ = (sel, root = document) => root.querySelector(sel);
      const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

      const normalize = (s) =>
        (s || "")
          .replace(/\[\d+\]/g, "") // remove citation markers like [1], [2]
          .replace(/\s+/g, " ")
          .trim();

      const textContent = (el) => (el ? normalize(el.textContent || "") : null);

      const infobox =
        $(".infobox") ||
        $(".infobox.vcard") ||
        $(".infobox.geography") ||
        $(".infobox.hproduct");

      // Find a row in the infobox matching any of the label candidates
      const findRow = (labels) => {
        if (!infobox) return null;
        const rows = $$("tr", infobox);
        const match = rows.find((tr) => {
          const th = $("th", tr);
          const label = normalize(th?.innerText || "").toLowerCase();
          return labels.some((target) =>
            label === target.toLowerCase() ||
            label.includes(target.toLowerCase())
          );
        });
        return match ? $("td", match) : null;
      };

      // Get array values from a cell (handles lists or comma-separated)
      const cellToArray = (td) => {
        if (!td) return null;
        // Prefer list items if present
        const lis = $$("li", td).map((li) => textContent(li)).filter(Boolean);
        if (lis.length) return lis;

        // Otherwise split by common separators
        const raw = textContent(td);
        if (!raw) return null;

        // Split on newlines, bullets, middots, or commas (but keep phrases intact)
        const parts = raw
          .split(/\n|•|·|,|;/)
          .map((s) => normalize(s))
          .filter(Boolean);

        // Dedup while preserving order
        const seen = new Set();
        const out = [];
        for (const p of parts) {
          if (!seen.has(p)) {
            seen.add(p);
            out.push(p);
          }
        }
        return out.length ? out : null;
      };

      // Website: sometimes in a dedicated "Website" row; sometimes anchor with class "url"
      const websiteFromInfobox = () => {
        // 1) Try a row labeled Website
        const websiteTD = findRow(["Website"]);
        let href =
          $("a.url", websiteTD || infobox)?.href ||
          $("a.external", websiteTD || infobox)?.href ||
          null;

        // 2) Fallback: any external link with rel=external in infobox
        if (!href && infobox) {
          const ext = $("a[rel='external']", infobox);
          if (ext) href = ext.href;
        }
        return href || null;
      };

      // Company size: typically "Number of employees" or "Employees"
      const companySize = () => {
        const td =
          findRow(["Number of employees", "Employees"]) ||
          findRow(["No. of employees"]);
        return textContent(td);
      };

      // Industry
      const industry = cellToArray(findRow(["Industry"]));

      // Headquarters: sometimes "Headquarters", sometimes "Headquarters location"
      const headquartersTD =
        findRow(["Headquarters"]) || findRow(["Headquarters location"]);
      const headquarters = textContent(headquartersTD);

      // Type: "Type", sometimes "Company type"
      const type = textContent(findRow(["Type", "Company type"]));

      // Specialties: Wikipedia doesn't always list "Specialties".
      // We'll interpret specialties as "Products", "Products and services", or "Services".
      const specialtiesTD =
        findRow(["Products and services"]) ||
        findRow(["Products"]) ||
        findRow(["Services"]);
      const specialties = cellToArray(specialtiesTD);

      // Name: page title
      const name = textContent(document.querySelector("#firstHeading"));

      // Website
      const website = websiteFromInfobox();

      return {
        name: name || null,
        website: website || null,
        company_size: companySize() || null,
        industry: industry || null,
        headquarters: headquarters || null,
        type: type || null,
        specialties: specialties || null,
      };
    });

    res.status(200).json({
      ok: true,
      url,
      scrapedAt: new Date().toISOString(),
      data,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
};
