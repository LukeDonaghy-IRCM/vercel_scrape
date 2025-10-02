Company Aggregator Scraper (Vercel + Puppeteer)
===============================================

Serverless scrapers that aggregate company data from **Wikipedia**, **Wikidata**, optional **finance** sources, **OpenCorporates**, and **social links** discovered on the company’s own website.

Two HTTP endpoints:

1.  `GET /api/company?q=<Company Name>`
    
2.  `GET /api/company-by-domain?domain=<example.com>`
    

Both return normalized JSON (see schema below), including:

*   `name`, `website`, `type`
    
*   `industry` (array)
    
*   `specialties` (array, best-effort from Wikipedia)
    
*   `employees` as `{ count, as_of }`
    
*   `headquarters` as `{ raw, place, city, region, country, coordinates }`
    
*   `financials` (ticker, price, market cap) — optional
    
*   `open_corporates` (jurisdiction, company\_number) — optional
    
*   `social` (links discovered on the corporate website: X/Twitter, LinkedIn, YouTube, Instagram, Facebook, GitHub, TikTok, etc.)
    

* * *

Quick Start
-----------

### 1) Install

bash

Copy code

`git clone https://github.com/<you>/vercel-puppeteer-scraper.git cd vercel-puppeteer-scraper npm install`

> This project is designed for **Node 20+**.

### 2) Run locally

bash

Copy code

`npm run dev`

Open:

*   `http://localhost:3000/api/company?q=Google`
    
*   `http://localhost:3000/api/company-by-domain?domain=google.com`
    

### 3) Deploy on Vercel

*   Import the repo in Vercel → **Add New Project**
    
*   In **Settings → Build & Development**:
    
    *   **Install Command**: `npm ci --omit=dev`
        
*   In **Settings → Environment Variables** (Build or All):
    
    *   `PUPPETEER_SKIP_DOWNLOAD=1`  
        (prevents the dev Puppeteer bundle from downloading Chrome during builds)
        

Optional keys:

*   `FINNHUB_API_KEY` (live quotes; otherwise Yahoo fallback)
    
*   `OPENCORPORATES_API_TOKEN` (better hit rate / limits)
    

### 4) `vercel.json` (already included)

json

Copy code

`{   "functions": {     "api/company.js": {       "runtime": "nodejs20.x",       "memory": 1024,       "maxDuration": 20     },     "api/company-by-domain.js": {       "runtime": "nodejs20.x",       "memory": 1024,       "maxDuration": 20     }   } }`

* * *

Endpoints
---------

### 1) `/api/company`

**Query:** `q` — company name or common brand (string)

**Example:**

bash

Copy code

`curl "http://localhost:3000/api/company?q=Google"`

**What it does:**

1.  Finds the best-matching Wikipedia page via the Wikipedia Search API.
    
2.  Scrapes the infobox with Puppeteer (name, website, industries, HQ, type, specialties, employees _string_).
    
3.  Pulls the matching Wikidata entity to enrich:
    
    *   employees (most recent) → `{ count, as_of }`
        
    *   industries, headquarters (structured), type, website, tickers
        
4.  Fetches **finance** (Finnhub if key provided, else Yahoo best-effort).
    
5.  Looks up **OpenCorporates** (optional).
    
6.  Fetches **social links** from the official website homepage.
    

* * *

### 2) `/api/company-by-domain`

**Query:** `domain` — company website domain or URL (e.g., `google.com` or `https://google.com`)

**Example:**

bash

Copy code

`curl "http://localhost:3000/api/company-by-domain?domain=google.com"`

**What it does:**

1.  Normalizes the domain → `https://domain/`.
    
2.  Uses a **Wikidata SPARQL** query to find the entity by **official website (P856)**.
    
3.  If the entity has an English Wikipedia sitelink, scrapes that page (same fields as above).
    
4.  Enriches from Wikidata (employees structured, industry labels, HQ structured, type, tickers).
    
5.  Finance (Finnhub/Yahoo), OpenCorporates (optional).
    
6.  Extracts **social links** directly from the provided website domain.
    

* * *

Response Schema (typical)
-------------------------

json

Copy code

`{   "ok": true,   "query": "Google",   "source": {     "wikipedia": "https://en.wikipedia.org/wiki/Google",     "wikidata": "Q95",     "finance": "Finnhub | YahooFinance | null",     "open_corporates": true,     "socials_from": "https://www.google.com/"   },   "scrapedAt": "2025-10-02T12:34:56.000Z",   "data": {     "name": "Google",     "website": "https://www.google.com/",     "employees": { "count": 187000, "as_of": "2025-06-30" },     "industry": ["Information technology", "Cloud computing", "Artificial intelligence"],     "headquarters": {       "raw": "Mountain View, California, United States",       "place": "Mountain View, California, United States",       "city": "Mountain View",       "region": "California",       "country": "United States",       "coordinates": { "lat": 37.422, "lon": -122.084 }     },     "type": "Subsidiary, Technology company",     "specialties": ["Search","Ads","YouTube","Android","Chrome","Cloud","AI"],     "financials": { "ticker": "GOOGL", "market_cap": "2.15T", "stock_price": 168.42 },     "open_corporates": { "jurisdiction": "us_de", "company_number": "3582691" },     "social": {       "x": "https://x.com/Google",       "youtube": "https://youtube.com/@Google",       "linkedin": "https://www.linkedin.com/company/google/",       "instagram": "https://www.instagram.com/google/",       "facebook": "https://www.facebook.com/Google/",       "github": "https://github.com/google"     }   },   "tickers": [     { "symbol": "GOOGL", "exchange": "NASDAQ" },     { "symbol": "GOOG", "exchange": "NASDAQ" }   ] }`

Notes:

*   Some fields may be `null` or empty arrays depending on the company’s public data.
    
*   `tickers` is included for debugging; remove in production if you don’t want it exposed.
    

* * *

Repo Structure
--------------

pgsql

Copy code

`api/   company.js             # Name-first aggregator   company-by-domain.js   # Domain-first aggregator vercel.json              # Function config (Node.js 20, memory/time) package.json README.md`

* * *

Social Link Discovery
---------------------

We **do not** scrape social networks directly. We only request the company’s website homepage and extract links pointing to known platforms:

*   X/Twitter, LinkedIn, Facebook, Instagram, YouTube, TikTok, GitHub, Medium, Reddit, Threads, Bluesky, Mastodon (incl. `rel="me"`), Pinterest
    

Add or edit domains in `SOCIAL_DOMAINS` in the source as needed.

* * *

Employees Field
---------------

*   **Wikidata**: pick the most recent **number of employees** statement (P1128) by `point in time` (P585), producing:
    
    json
    
    Copy code
    
    `{ "count": <number|null>, "as_of": "YYYY-MM-DD|null" }`
    
*   **Wikipedia**: parse the infobox “Employees” string (e.g., `182,502 (June 2024)`) into the same structure when Wikidata doesn't provide one.
    

* * *

Headquarters Field
------------------

When possible, we build structured HQ using the Wikidata `headquarters location` (P159):

json

Copy code

`{   "raw": "...",   "place": "...",   "city": "...",   "region": "...",   "country": "...",   "coordinates": { "lat": ..., "lon": ... } }`

If Wikidata is missing, we fall back to parsing Wikipedia’s infobox text.

* * *

Finance Sources
---------------

*   **Finnhub** (preferred, requires `FINNHUB_API_KEY`)
    
*   **Yahoo Finance** (no key; unofficial endpoint, may change)  
    We prefer NASDAQ/NYSE tickers when multiple symbols exist.
    

* * *

OpenCorporates
--------------

Optional call to `api.opencorporates.com/companies/search` with `OPENCORPORATES_API_TOKEN` if provided. Returns:

json

Copy code

`{ "jurisdiction": "us_de", "company_number": "3582691" }`

(if found)

* * *

Vercel Setup Checklist
----------------------

*   **Runtime**: Node functions (not Edge)
    
*   **`vercel.json`**: memory/time set as above
    
*   **Install command**: `npm ci --omit=dev`
    
*   **Env Vars**:
    
    *   `PUPPETEER_SKIP_DOWNLOAD=1`
        
    *   `FINNHUB_API_KEY` (optional)
        
    *   `OPENCORPORATES_API_TOKEN` (optional)
        

* * *

Troubleshooting
---------------

*   \*\*Build Failed: `npm install` exited with 1`** Use` npm ci --omit=dev`and`PUPPETEER\_SKIP\_DOWNLOAD=1\`.
    
*   **Chromium missing libraries (e.g., `libnspr4.so`)**  
    Ensure you’re using `@sparticuz/chromium` with `puppeteer-core` and launch with:
    
    *   `executablePath: await chromium.executablePath()`
        
    *   `args: chromium.args`
        
    *   `headless: "shell"`
        
    *   Runtime set to **Node.js** (not Edge).
        
*   **Empty fields**  
    Some companies lack infobox rows or Wikidata statements. That’s expected; the API will still return a consistent shape with `null`/empty values.
    

* * *

Ethics & Acceptable Use
-----------------------

*   Only scrape **public, ToS-compliant** sources.
    
*   We **do not** hit LinkedIn or Glassdoor (they prohibit scraping).
    
*   Respect rate limits, add caching if you scale this (e.g., Upstash Redis keyed by `q` or `domain`).
    

* * *

License
-------

MIT — feel free to use, modify, and share.
