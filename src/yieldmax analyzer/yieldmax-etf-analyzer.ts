// yieldmax-all-etfs-analysis.ts
// Run: npx ts-node yieldmax-all-etfs-analysis.ts
// Requires: npm i axios cheerio
// Node >= 18.17

import axios from 'axios';
import * as cheerio from 'cheerio';

type Frequency = 'Weekly' | 'Monthly';
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface DistributionRow {
  exDateISO: string;
  amount: number;
}

interface EtfPage {
  tickerGuess: string;
  url: string;
}

interface EtfResult {
  ticker: string;
  frequency: Frequency;
  rows: DistributionRow[]; // full parsed rows (ascending by date)
  windowRows: DistributionRow[]; // last 8 (weekly) or last 3 (monthly)
  dollarChange: number;
  percentChange: number;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; YieldMaxETFAnalyzer/1.0)';
const REQUEST_TIMEOUT_MS = 25000;
const SLEEP_BETWEEN_REQ_MS = 500;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T = never>(error: string): Result<T> => ({ ok: false, error });

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
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

function formatPercent(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

async function getHtml(url: string): Promise<Result<string>> {
  try {
    const res = await axios.get<string>(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: r => r
    });
    if (!res.data) return err('Empty body');
    return ok(res.data);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error');
  }
}

// --- Discovery: ALL ETF detail pages under Our ETFs ---
async function discoverAllEtfs(): Promise<Result<EtfPage[]>> {
  const root = 'https://www.yieldmaxetfs.com/our-etfs/';
  const page = await getHtml(root);
  if (!page.ok) return err(`Failed to load Our ETFs page: ${page.error}`);
  
  const $ = cheerio.load(page.value);
  const links = new Set<string>();
  
  $('a[href]').each((_, el) => {
    const hrefRaw = ($(el).attr('href') || '').trim();
    if (!hrefRaw) return;
    let href = hrefRaw;
    if (href.startsWith('/')) href = `https://www.yieldmaxetfs.com${href}`;
    if (!/^https?:\/\/www\.yieldmaxetfs\.com\/our-etfs\//i.test(href)) return;
    // Normalize trailing slash
    const normalized = href.endsWith('/') ? href : `${href}/`;
    // Exclude root index itself
    if (/\/our-etfs\/$/i.test(normalized)) return;
    links.add(normalized);
  });
  
  // Convert to list with a crude ticker guess from slug (final ticker parsed from page later)
  const etfs: EtfPage[] = [];
  for (const url of Array.from(links).sort()) {
    const parts = url.split('/').filter(Boolean);
    const slug = parts[parts.length - 1]!;
    const guess = slug.replace(/[^a-z0-9]/gi, '').toUpperCase();
    etfs.push({ tickerGuess: guess, url });
  }
  
  if (etfs.length === 0) return err('No ETF detail candidates found');
  return ok(etfs);
}

// --- Parsing helpers ---
function findDistributionTable($: cheerio.CheerioAPI): cheerio.Cheerio<any> | null {
  let table: cheerio.Cheerio<any> | null = null;
  
  // Prefer table following headings like "Distribution Details"
  $('h1, h2, h3, h4, h5').each((_, el) => {
    const t = ($(el).text() || '').trim().toLowerCase();
    if (t.includes('distribution') && (t.includes('details') || t.includes('history') || t.includes('summary'))) {
      const nextTable = $(el).nextAll('table').first();
      if (nextTable && nextTable.find('th,td').length > 0) table = nextTable;
    }
  });
  if (table) return table;
  
  // Fallback: scan all tables for headers we care about
  const tables = $('table').toArray();
  for (const el of tables) {
    const $el = $(el);
    const headers = $el.find('th').toArray().map(th => normalizeHeader($(th).text()));
    const hasAmount = headers.some(h => h.includes('distribution per share') || h.includes('amount') || h.includes('dividend'));
    const hasEx = headers.some(h => h.includes('ex'));
    if (hasAmount && hasEx) return $el;
  }
  return null;
}

function headerIndex(headers: string[], needle: string): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (headers[i]?.includes(needle)) return i;
  }
  return null;
}

function parseDistributionRows($: cheerio.CheerioAPI): Result<DistributionRow[]> {
  const $table = findDistributionTable($);
  if (!$table) return err('Distribution table not found');
  
  let headerCells = $table.find('thead th, thead td').toArray();
  if (headerCells.length === 0) {
    const firstRow = $table.find('tr').first();
    headerCells = firstRow.find('th, td').toArray();
  }
  const headers = headerCells.map(h => normalizeHeader($(h).text()));
  const exIdx = headerIndex(headers, 'ex');
  // Accept multiple variants for the amount column
  const amtIdx =
    headerIndex(headers, 'distribution per share') ??
    headerIndex(headers, 'distribution') ??
    headerIndex(headers, 'amount') ??
    headerIndex(headers, 'dividend');
  
  if (exIdx === null || amtIdx === null) {
    return err(`Required headers not found: ${headers.join(', ')}`);
  }
  
  let rows = $table.find('tbody tr').toArray();
  if (rows.length === 0) rows = $table.find('tr').toArray().slice(1);
  
  const out: DistributionRow[] = [];
  for (const tr of rows) {
    const cells = $(tr).find('td').toArray();
    if (cells.length === 0) continue;
    const exISO = parseToISODate($(cells[exIdx!]!).text());
    const amount = parseCurrencyToNumber($(cells[amtIdx!]!).text());
    if (exISO && amount !== null) out.push({ exDateISO: exISO, amount });
  }
  if (out.length === 0) return err('No valid distribution rows parsed');
  
  // Sort ascending by date
  out.sort((a, b) => a.exDateISO.localeCompare(b.exDateISO));
  return ok(out);
}

function parseTickerFromPage($: cheerio.CheerioAPI, url: string, guess: string): string {
  // 1) Try og:title / title / h1 with ticker in parentheses
  const candidates: string[] = [];
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const title = $('title').text() || '';
  const h1 = $('h1').first().text() || '';
  if (ogTitle) candidates.push(ogTitle);
  if (title) candidates.push(title);
  if (h1) candidates.push(h1);
  
  for (const text of candidates) {
    const mParen = text.match(/\(([A-Z]{2,6})\)/);
    if (mParen?.[1]) return mParen[1]!;
    const mColon = text.match(/(?:NYSE|NYSE Arca|NASDAQ|AMEX):\s*([A-Z.-]{2,6})/i);
    if (mColon?.[1]) return mColon[1]!.toUpperCase();
  }
  
  // 2) Look for visible "Ticker" label
  let found: string | null = null;
  $('*').each((_, el) => {
    const t = ($(el).text() || '').trim();
    if (/^ticker[:\s]/i.test(t)) {
      const m = t.match(/ticker[:\s]+([A-Z.-]{2,6})/i);
      if (m?.[1]) {
        found = m[1]!.toUpperCase();
        return false;
      }
    }
    return undefined;
  });
  if (found) return found;
  
  // 3) Fallback to URL slug guess
  // Reject obvious category words
  if (!/^(COVEREDCALL|INCOME|BONDS?|EQUITY|OPTIONS?|LEVERAGED|INDEX|SECTOR|THEMES?)$/.test(guess)) {
    if (/^[A-Z.-]{2,8}$/.test(guess)) return guess;
  }
  
  // 4) Last resort: short uppercase token anywhere on page that looks like a ticker
  const bodyText = $('body').text() || '';
  const mAny = bodyText.match(/\(([A-Z]{2,6})\)/);
  if (mAny?.[1]) return mAny[1]!.toUpperCase();
  
  // Give up: label as UNKNOWN-<slug>
  const parts = url.split('/').filter(Boolean);
  return `UNKNOWN-${(parts[parts.length - 1] || 'ETF').toUpperCase()}`;
}

// --- Frequency & windows ---
function inferFrequency(rows: DistributionRow[]): Frequency | null {
  if (rows.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const d1 = new Date(rows[i - 1]!.exDateISO).getTime();
    const d2 = new Date(rows[i]!.exDateISO).getTime();
    gaps.push(Math.abs((d2 - d1) / (1000 * 60 * 60 * 24)));
  }
  const med = median(gaps);
  if (med === null) return null;
  if (med <= 10) return 'Weekly';
  if (med >= 20) return 'Monthly';
  // Ambiguous: choose Monthly by default (more conservative)
  return 'Monthly';
}

function pickWindow(rows: DistributionRow[], freq: Frequency): DistributionRow[] {
  const need = freq === 'Weekly' ? 2 : 2;
  if (rows.length < need) return [];
  return rows.slice(-need);
}

function computeChange(windowRows: DistributionRow[]): { dollar: number; percent: number } | null {
  if (windowRows.length < 2) return null;
  const first = windowRows[0]!.amount;
  const last = windowRows[windowRows.length - 1]!.amount;
  if (first === 0) return null;
  const dollar = last - first;
  const percent = ((last / first) - 1) * 100;
  return { dollar, percent };
}

// --- Rendering ---
function renderMarkdownTable(results: EtfResult[]): string {
  const header = [
    '| Ticker | Freq | Window dates | Sequence | Δ $ | Δ % |',
    '|-|-|-|-|-|-|'
  ].join('\n');
  
  const lines = results.map(r => {
    const dates = r.windowRows.map(x => x.exDateISO).join('<br>');
    const seq = r.windowRows.map(x => formatMoney(x.amount)).join('<br>');
    const dDollar = formatMoney(r.dollarChange);
    const dPct = formatPercent(r.percentChange);
    return `| ${r.ticker} | ${r.frequency} | ${dates} | ${seq} | ${dDollar} | ${dPct} |`;
  });
  
  return [header, ...lines].join('\n');
}

// --- Main ---
async function main() {
  const discovered = await discoverAllEtfs();
  if (!discovered.ok) {
    console.error(discovered.error);
    process.exit(1);
  }
  
  const pages = discovered.value;
  const results: EtfResult[] = [];
  const skipped: { url: string; reason: string }[] = [];
  
  for (let i = 0; i < pages.length; i++) {
    const { url, tickerGuess } = pages[i]!;
    const html = await getHtml(url);
    if (!html.ok) {
      skipped.push({ url, reason: `fetch: ${html.error}` });
      await sleep(SLEEP_BETWEEN_REQ_MS);
      continue;
    }
    
    const $ = cheerio.load(html.value);
    const ticker = parseTickerFromPage($, url, tickerGuess);
    
    const parsed = parseDistributionRows($);
    if (!parsed.ok) {
      skipped.push({ url, reason: `parse: ${parsed.error}` });
      await sleep(SLEEP_BETWEEN_REQ_MS);
      continue;
    }
    
    const rows = parsed.value;
    const freq = inferFrequency(rows);
    if (!freq) {
      skipped.push({ url, reason: 'freq: unable to infer' });
      await sleep(SLEEP_BETWEEN_REQ_MS);
      continue;
    }
    
    const windowRows = pickWindow(rows, freq);
    if (windowRows.length === 0) {
      skipped.push({ url, reason: `window: insufficient rows for ${freq}` });
      await sleep(SLEEP_BETWEEN_REQ_MS);
      continue;
    }
    
    const seq = windowRows.map(r => r.amount);
    if (!strictlyIncreasing(seq)) {
      // Not part of the "increasing dividend" scanner
      await sleep(SLEEP_BETWEEN_REQ_MS);
      continue;
    }
    
    const delta = computeChange(windowRows);
    if (!delta) {
      skipped.push({ url, reason: 'delta: could not compute change' });
      await sleep(SLEEP_BETWEEN_REQ_MS);
      continue;
    }
    
    results.push({
      ticker,
      frequency: freq,
      rows,
      windowRows,
      dollarChange: delta.dollar,
      percentChange: delta.percent
    });
    
    await sleep(SLEEP_BETWEEN_REQ_MS);
  }
  
  // Sort results by percent change descending for quick scan
  results.sort((a, b) => b.percentChange - a.percentChange);
  
  const md = renderMarkdownTable(results);
  console.log('\n# Increasing distribution sequences across all YieldMax “Our ETFs”\n');
  console.log(md);
  
  console.log('\n---\n');
  console.log(`Found increasing sequences: ${results.length}`);
  if (skipped.length > 0) {
    console.log(`Skipped: ${skipped.length}`);
    // Print a compact list of skip reasons (deduped) for debugging
    const byReason = new Map<string, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
    for (const [reason, count] of byReason.entries()) {
      console.log(`- ${reason}: ${count}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
