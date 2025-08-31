// yieldmax-covered-call-analysis.ts
// Run with: npx ts-node yieldmax-covered-call-analysis.ts
// Requires: npm i axios cheerio
// Node: >= 18.17

const NUM_WEEKS = 8; // last 8 weeks
const NUM_MONTHS = 3; // last 3 months

import axios from 'axios';
import * as cheerio from 'cheerio';

type Frequency = 'Weekly' | 'Monthly';
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface DistributionRow {
  exDateISO: string;
  amount: number;
}

interface EtfPage {
  ticker: string;
  url: string;
}

interface EtfResult {
  ticker: string;
  frequency: Frequency;
  rows: DistributionRow[];
  dollarChange: number;
  percentChange: number;
}

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
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]!!) / 2;
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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YieldMaxCoveredCallAnalyzer/1.0)' },
      timeout: 25000,
      responseType: 'text',
      transformResponse: r => r
    });
    if (!res.data) return err('Empty body');
    return ok(res.data);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error');
  }
}

async function discoverCoveredCallEtfs(): Promise<Result<EtfPage[]>> {
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
    const m = href.match(/^https?:\/\/www\.yieldmaxetfs\.com\/our-etfs\/([a-z0-9-]+)\/?$/i);
    if (m) links.add(href.endsWith('/') ? href : `${href}/`);
  });
  
  const candidates = Array.from(links).sort();
  if (candidates.length === 0) return err('No ETF links discovered');
  
  const covered: EtfPage[] = [];
  for (const url of candidates) {
    await sleep(300);
    const html = await getHtml(url);
    if (!html.ok) continue;
    const $$ = cheerio.load(html.value);
    if (!$$.text().toLowerCase().includes('covered call etf')) continue;
    const tickerMatch = url.match(/our-etfs\/([a-z0-9-]+)\//i);
    const ticker = tickerMatch ? tickerMatch[1]!.toUpperCase() : null;
    if (!ticker) continue;
    covered.push({ ticker, url });
  }
  if (covered.length === 0) return err('No Covered Call ETF pages found');
  return ok(covered);
}

function findDistributionTable($: cheerio.CheerioAPI): cheerio.Cheerio<any> | null {
  let table: cheerio.Cheerio<any> | null = null;
  $('h2, h3, h4').each((_, el) => {
    const t = ($(el).text() || '').trim().toLowerCase();
    if (t.includes('distribution details')) {
      const nextTable = $(el).nextAll('table').first();
      if (nextTable && nextTable.find('th,td').length > 0) table = nextTable;
    }
  });
  if (table) return table;
  const tables = $('table').toArray();
  for (const el of tables) {
    const $el = $(el);
    const headers = $el.find('th').toArray().map(th => normalizeHeader($(th).text()));
    if (headers.some(h => h.includes('distribution per share')) && headers.some(h => h.includes('ex'))) return $el;
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
  if (!$table) return err('Distribution Details table not found');
  
  let headerCells = $table.find('thead th, thead td').toArray();
  if (headerCells.length === 0) {
    const firstRow = $table.find('tr').first();
    headerCells = firstRow.find('th, td').toArray();
  }
  const headers = headerCells.map(h => normalizeHeader($(h).text()));
  const exIdx = headerIndex(headers, 'ex');
  const amtIdx = headerIndex(headers, 'distribution per share');
  if (exIdx === null || amtIdx === null) return err(`Required headers not found: ${headers.join(', ')}`);
  
  let rows = $table.find('tbody tr').toArray();
  if (rows.length === 0) rows = $table.find('tr').toArray().slice(1);
  
  const out: DistributionRow[] = [];
  for (const tr of rows) {
    const cells = $(tr).find('td').toArray();
    if (cells.length === 0) continue;
    const exISO = parseToISODate($(cells[exIdx]).text());
    const amount = parseCurrencyToNumber($(cells[amtIdx]).text());
    if (exISO && amount !== null) out.push({ exDateISO: exISO, amount });
  }
  if (out.length === 0) return err('No valid distribution rows parsed');
  
  out.sort((a, b) => a.exDateISO.localeCompare(b.exDateISO));
  return ok(out);
}

function inferFrequency(rows: DistributionRow[]): Frequency | null {
  if (rows.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const d1 = new Date(rows[i - 1]!.exDateISO).getTime();
    const d2 = new Date(rows[i]!.exDateISO).getTime();
    gaps.push(Math.abs((d2 - d1) / (1000 * 60 * 60 * 24)));
  }
  const med = median(gaps);
  if (med === null) return null;
  return med <= 10 ? 'Weekly' : 'Monthly';
}

function windowForWeekly(rows: DistributionRow[]): DistributionRow[] {
  return rows.slice(-NUM_WEEKS);
}

function windowForMonthly(rows: DistributionRow[]): DistributionRow[] {
  if (rows.length === 0) return [];
  const yms: string[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const ym = rows[i]!.exDateISO.slice(0, 7); // YYYY-MM
    if (!yms.includes(ym)) yms.push(ym);
    if (yms.length === NUM_MONTHS) break;
  }
  const keep = new Set(yms);
  return rows.filter(r => keep.has(r.exDateISO.slice(0, 7)));
}

function computeChange(windowRows: DistributionRow[]): { dollar: number; percent: number } | null {
  if (windowRows.length < 2) return null;
  const first = windowRows[0]!.amount;
  const last = windowRows[windowRows.length - 1]!.amount;
  const dollar = last - first;
  const percent = first === 0 ? 0 : (last / first - 1) * 100;
  return { dollar, percent };
}

function formatCellLines(values: string[]): string {
  // GitHub-flavored Markdown line breaks inside tables via <br>
  return values.join('<br>');
}

async function analyzeEtf(page: EtfPage): Promise<Result<EtfResult | null>> {
  const res = await getHtml(page.url);
  if (!res.ok) return err(`Failed ${page.ticker}: ${res.error}`);
  
  const $ = cheerio.load(res.value);
  const parsed = parseDistributionRows($);
  if (!parsed.ok) return err(`Parse ${page.ticker}: ${parsed.error}`);
  
  const freq = inferFrequency(parsed.value);
  if (!freq) return ok(null);
  
  const windowRows = freq === 'Weekly' ? windowForWeekly(parsed.value) : windowForMonthly(parsed.value);
  if (windowRows.length < 2) return ok(null);
  
  const amounts = windowRows.map(r => r.amount);
  if (!strictlyIncreasing(amounts)) return ok(null);
  
  const change = computeChange(windowRows);
  if (!change) return ok(null);
  
  return ok({
    ticker: page.ticker,
    frequency: freq,
    rows: windowRows,
    dollarChange: change.dollar,
    percentChange: change.percent
  });
}

function printMarkdownTable(results: EtfResult[]) {
  if (results.length === 0) {
    console.log('No ETFs met the criteria.');
    return;
  }
  
  console.log('| Ticker | Frequency | Ex-Dates | Distributions | Start | End | $ Change | % Change |');
  console.log('|---|---|---|---|---:|---:|---:|---:|');
  
  for (const r of results) {
    const exDates = formatCellLines(r.rows.map(x => x.exDateISO));
    const dists = formatCellLines(r.rows.map(x => formatMoney(x.amount)));
    const start = formatMoney(r.rows[0]!.amount);
    const end = formatMoney(r.rows[r.rows.length - 1]!.amount);
    const dChange = formatMoney(r.dollarChange);
    const pChange = formatPercent(r.percentChange);
    
    console.log(`| ${r.ticker} | ${r.frequency} | ${exDates} | ${dists} | ${start} | ${end} | ${dChange} | ${pChange} |`);
  }
}

async function main() {
  const discovered = await discoverCoveredCallEtfs();
  if (!discovered.ok) {
    console.error(discovered.error);
    process.exit(1);
  }
  
  const pages = discovered.value;
  
  const results: EtfResult[] = [];
  for (const page of pages) {
    await sleep(400);
    const r = await analyzeEtf(page);
    if (!r.ok) {
      console.warn(r.error);
      continue;
    }
    if (r.value) results.push(r.value);
  }
  
  results.sort((a, b) => b.percentChange - a.percentChange);
  printMarkdownTable(results);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
