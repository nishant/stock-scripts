// yieldmax-covered-call-analysis.ts
// Run with: npx ts-node yieldmax-covered-call-analysis.ts
// Requires: npm i axios cheerio
// Node: >= 18.17

import axios from 'axios';
import * as cheerio from 'cheerio';

// -----------------------------
// Types
// -----------------------------
type Frequency = 'Weekly' | 'Monthly';
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface DistributionRow {
  exDateISO: string;   // YYYY-MM-DD
  amount: number;      // Distribution per Share
}

interface EtfPage {
  ticker: string;
  url: string;
}

interface EtfResult {
  ticker: string;
  frequency: Frequency;
  rows: DistributionRow[]; // windowed rows in chronological order (oldest -> newest)
  dollarChange: number;
  percentChange: number;
}

// -----------------------------
// Result helpers
// -----------------------------
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T = never>(error: string): Result<T> => ({ ok: false, error });

// -----------------------------
// Utils
// -----------------------------
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

function parseCurrencyToNumber(text: string): number | null {
  const cleaned = text.replace(/\$/g, '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseToISODate(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  
  // Try common formats quickly
  // Example: "Aug 15, 2025" | "August 15, 2025" | "8/15/2025" | "2025-08-15"
  const tryParse = (dstr: string): string | null => {
    const d = new Date(dstr);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  
  // Direct attempt
  const direct = tryParse(s);
  if (direct) return direct;
  
  // Replace ordinal suffixes if any (e.g., "Aug 15th, 2025")
  const noOrd = s.replace(/\b(\d+)(st|nd|rd|th)\b/i, '$1');
  if (noOrd !== s) {
    const p = tryParse(noOrd);
    if (p) return p;
  }
  
  // Fallback: return null if not parsable
  return null;
}

function normalizeHeader(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function strictlyIncreasing(nums: number[]): boolean {
  if (nums.length < 2) return false;
  for (let i = 1; i < nums.length; i++) {
    if (!(nums[i]! > nums[i - 1]!)) return false;
  }
  return true;
}

function formatMoney(n: number): string {
  return `$${n.toFixed(4)}`;
}

// -----------------------------
// HTTP
// -----------------------------
async function getHtml(url: string): Promise<Result<string>> {
  try {
    const res = await axios.get<string>(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; YieldMaxCoveredCallAnalyzer/1.0)'
      },
      timeout: 25000,
      responseType: 'text',
      transformResponse: r => r // keep as string
    });
    if (!res.data) return err('Empty body');
    return ok(res.data);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error');
  }
}

// -----------------------------
// Discovery
// -----------------------------
async function discoverCoveredCallEtfs(): Promise<Result<EtfPage[]>> {
  // Crawl the "Our ETFs" page and extract ETF detail links under /our-etfs/{slug}/
  const root = 'https://www.yieldmaxetfs.com/our-etfs/';
  const page = await getHtml(root);
  if (!page.ok) return err(`Failed to load Our ETFs page: ${page.error}`);
  
  const $ = cheerio.load(page.value);
  const links = new Set<string>();
  
  $('a[href]').each((_, el) => {
    const hrefRaw = ($(el).attr('href') || '').trim();
    if (!hrefRaw) return;
    // Normalize relative URLs
    let href = hrefRaw;
    if (href.startsWith('/')) href = `https://www.yieldmaxetfs.com${href}`;
    if (!/^https?:\/\/www\.yieldmaxetfs\.com\/our-etfs\//i.test(href)) return;
    
    // We want detail pages like .../our-etfs/tsly/ (allow trailing slash optional)
    const m = href.match(/^https?:\/\/www\.yieldmaxetfs\.com\/our-etfs\/([a-z0-9-]+)\/?$/i);
    if (m) links.add(href.endsWith('/') ? href : `${href}/`);
  });
  
  const candidates = Array.from(links).sort();
  if (candidates.length === 0) return err('No ETF links discovered on Our ETFs page');
  
  const covered: EtfPage[] = [];
  
  for (const url of candidates) {
    await sleep(300);
    const html = await getHtml(url);
    if (!html.ok) continue;
    
    const $$ = cheerio.load(html.value);
    const bodyText = $$.text().toLowerCase();
    
    // Heuristic: ensure page is for a Covered Call ETF
    if (!bodyText.includes('covered call etf')) continue;
    
    const tickerMatch = url.match(/our-etfs\/([a-z0-9-]+)\//i);
    const ticker = tickerMatch ? tickerMatch[1]!.toUpperCase() : null;
    if (!ticker) continue;
    
    covered.push({ ticker, url });
  }
  
  if (covered.length === 0) return err('No Covered Call ETF pages found');
  return ok(covered);
}

// -----------------------------
// Parsing "Distribution Details" table
// -----------------------------
function findDistributionTable($: cheerio.CheerioAPI): any | null {
  // Prefer a table near a heading containing "Distribution Details"
  let table: any = null;
  
  $('h2, h3, h4').each((_, el) => {
    const t = ($(el).text() || '').trim().toLowerCase();
    if (t.includes('distribution details')) {
      const nextTable = $(el).nextAll('table').first();
      if (nextTable && nextTable.find('th,td').length > 0) table = nextTable;
    }
  });
  
  if (table) return table;
  
  // Fallback: any table whose headers include "Distribution per Share" and some "Ex" column
  const tables = $('table').toArray();
  for (const el of tables) {
    const $el = $(el);
    const headers = $el.find('th').toArray().map(th => normalizeHeader($(th).text()));
    const hasDist = headers.some(h => h.includes('distribution per share'));
    const hasEx = headers.some(h => h.includes('ex'));
    if (hasDist && hasEx) return $el;
  }
  
  return null;
}

function headerIndex(headers: string[], needleIncludes: string | RegExp): number | null {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    if (typeof needleIncludes === 'string') {
      if (h.includes(needleIncludes)) return i;
    } else {
      if (needleIncludes.test(h)) return i;
    }
  }
  return null;
}

function parseDistributionRows($: cheerio.CheerioAPI): Result<DistributionRow[]> {
  const $table = findDistributionTable($);
  if (!$table) return err('Distribution Details table not found');
  
  // Get headers from thead; fallback to first row if thead missing
  let headerCells = $table.find('thead th, thead td').toArray();
  if (headerCells.length === 0) {
    const firstRow = $table.find('tr').first();
    headerCells = firstRow.find('th, td').toArray();
  }
  const headers = headerCells.map(h => normalizeHeader($(h).text()));
  
  const exIdx = headerIndex(headers, 'ex');
  const amtIdx = headerIndex(headers, 'distribution per share');
  
  if (exIdx === null || amtIdx === null) {
    return err(`Required headers not found. Got: [${headers.join(' | ')}]`);
  }
  
  // Prefer tbody; fallback to all rows after the header row
  let rows = $table.find('tbody tr').toArray();
  if (rows.length === 0) {
    rows = $table.find('tr').toArray().slice(1);
  }
  
  const out: DistributionRow[] = [];
  for (const tr of rows) {
    const cells = $(tr).find('td').toArray();
    if (cells.length === 0) continue;
    
    const exCell = cells[exIdx];
    const amtCell = cells[amtIdx];
    if (!exCell || !amtCell) continue;
    
    const exText = ($(exCell).text() || '').trim();
    const amtText = ($(amtCell).text() || '').trim();
    
    const exISO = parseToISODate(exText);
    const amount = parseCurrencyToNumber(amtText);
    
    if (exISO && amount !== null) {
      out.push({ exDateISO: exISO, amount });
    }
  }
  
  if (out.length === 0) return err('No valid distribution rows parsed');
  // Sort chronologically
  out.sort((a, b) => a.exDateISO.localeCompare(b.exDateISO));
  return ok(out);
}

// -----------------------------
// Frequency inference and windowing
// -----------------------------
function inferFrequency(rows: DistributionRow[]): Frequency | null {
  if (rows.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const d1 = new Date(rows[i - 1]!.exDateISO).getTime();
    const d2 = new Date(rows[i]!.exDateISO).getTime();
    const days = Math.abs((d2 - d1) / (1000 * 60 * 60 * 24));
    gaps.push(days);
  }
  const med = median(gaps);
  if (med === null) return null;
  return med <= 10 ? 'Weekly' : 'Monthly';
}

function windowForWeekly(rows: DistributionRow[]): DistributionRow[] {
  // Take the last 5 distributions (chronological result)
  const last5 = rows.slice(-5);
  return last5.length === 5 ? last5 : [];
}

function windowForMonthly(rows: DistributionRow[]): DistributionRow[] {
  // Take the most recent 2 ex-dates from distinct months, returned in chronological order
  const picked: DistributionRow[] = [];
  const seenMonths = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const ym = r!.exDateISO.slice(0, 7); // YYYY-MM
    if (!seenMonths.has(ym)) {
      picked.push(r!);
      seenMonths.add(ym);
    }
    if (picked.length >= 2) break;
  }
  if (picked.length < 2) return [];
  return picked.reverse();
}

// -----------------------------
// Analysis per ETF
// -----------------------------
async function analyzeEtf(etf: EtfPage): Promise<Result<EtfResult | null>> {
  const page = await getHtml(etf.url);
  if (!page.ok) return err(`Fetch ${etf.ticker}: ${page.error}`);
  
  const $ = cheerio.load(page.value);
  const parsed = parseDistributionRows($);
  if (!parsed.ok) return err(`Parse ${etf.ticker}: ${parsed.error}`);
  
  const allRows = parsed.value;
  if (allRows.length < 2) return ok(null);
  
  const freq = inferFrequency(allRows);
  if (!freq) return ok(null);
  
  const windowed = freq === 'Weekly' ? windowForWeekly(allRows) : windowForMonthly(allRows);
  if (windowed.length < (freq === 'Weekly' ? 8 : 3)) return ok(null);
  
  const amounts = windowed.map(r => r.amount);
  if (!strictlyIncreasing(amounts)) return ok(null);
  
  const first = amounts[0];
  const last = amounts[amounts.length - 1];
  if (!(first! > 0)) return ok(null);
  
  const dollarChange = Number((last! - first!).toFixed(6));
  const percentChange = Number(((dollarChange / first!) * 100).toFixed(4));
  
  return ok({
    ticker: etf.ticker,
    frequency: freq,
    rows: windowed,
    dollarChange,
    percentChange
  });
}

// -----------------------------
// Output
// -----------------------------
function toMarkdownTable(results: EtfResult[]): string {
  const header = [
    '| Ticker | Frequency | Distribution per Share | Ex Dates | Dollar Change | Percent Change |',
    '|---|---|---|---|---:|---:|'
  ].join('\n');
  
  const lines = results.map(r => {
    const amounts = r.rows.map(x => formatMoney(x.amount)).join(', ');
    const dates = r.rows.map(x => x.exDateISO).join(', ');
    return `| ${r.ticker} | ${r.frequency} | ${amounts} | ${dates} | ${formatMoney(r.dollarChange)} | ${r.percentChange.toFixed(2)}% |`;
  });
  
  return [header, ...lines].join('\n');
}

// -----------------------------
// Main
// -----------------------------
(async () => {
  try {
    // Discover all Covered Call ETF pages from the canonical path:
    // https://www.yieldmaxetfs.com/our-etfs/{ticker}/
    const discovered = await discoverCoveredCallEtfs();
    if (!discovered.ok) {
      console.error(discovered.error);
      process.exitCode = 1;
      return;
    }
    
    const etfs = discovered.value;
    
    const results: EtfResult[] = [];
    for (const etf of etfs) {
      await sleep(350); // Be polite
      const res = await analyzeEtf(etf);
      if (!res.ok) {
        // Log parse/fetch errors per ticker, continue
        console.error(res.error);
        continue;
      }
      if (res.value) results.push(res.value);
    }
    
    // Sort by Percent Change desc
    results.sort((a, b) => b.percentChange - a.percentChange);
    
    if (results.length === 0) {
      console.log('No Covered Call ETFs with strictly increasing distributions over the requested window were found.');
      return;
    }
    
    console.log(toMarkdownTable(results));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
})();
