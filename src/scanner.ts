import { chromium, type Browser, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import type { AxeResults, Result as AxeResult, ImpactValue } from "axe-core";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export interface ScanOptions {
  /** WCAG / rule tags to run, e.g. ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"]. */
  tags?: string[];
  /** Only run these specific rule ids. */
  rules?: string[];
  /** Exclude these specific rule ids. */
  excludeRules?: string[];
  /** CSS selector to scope the scan to a region of the page. */
  include?: string;
  /** Milliseconds to wait for navigation / network idle before scanning. */
  timeoutMs?: number;
}

let sharedBrowser: Browser | null = null;

/** Reuse a single headless Chromium instance across scans. */
async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  try {
    sharedBrowser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `Failed to launch Chromium. Make sure the browser is installed with:\n\n    npx playwright install chromium\n\nOriginal error: ${(err as Error).message}`
    );
  }
  return sharedBrowser;
}

export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
}

function buildAxe(page: Page, opts: ScanOptions): AxeBuilder {
  let builder = new AxeBuilder({ page });
  if (opts.tags && opts.tags.length > 0) builder = builder.withTags(opts.tags);
  if (opts.rules && opts.rules.length > 0) builder = builder.withRules(opts.rules);
  if (opts.excludeRules && opts.excludeRules.length > 0)
    builder = builder.disableRules(opts.excludeRules);
  if (opts.include) builder = builder.include(opts.include);
  return builder;
}

export async function scanUrl(url: string, opts: ScanOptions = {}): Promise<AxeResults> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(url, {
      waitUntil: "load",
      timeout: opts.timeoutMs ?? 30_000,
    });
    // Give client-rendered apps a moment to settle.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    return await buildAxe(page, opts).analyze();
  } finally {
    await context.close().catch(() => {});
  }
}

export async function scanHtml(html: string, opts: ScanOptions = {}): Promise<AxeResults> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(html, {
      waitUntil: "load",
      timeout: opts.timeoutMs ?? 30_000,
    });
    return await buildAxe(page, opts).analyze();
  } finally {
    await context.close().catch(() => {});
  }
}

/** Scan a local HTML file on disk (loaded via file:// so linked CSS/assets resolve). */
export async function scanFile(filePath: string, opts: ScanOptions = {}): Promise<AxeResults> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const fileUrl = pathToFileURL(abs).toString();
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(fileUrl, { waitUntil: "load", timeout: opts.timeoutMs ?? 30_000 });
    return await buildAxe(page, opts).analyze();
  } finally {
    await context.close().catch(() => {});
  }
}

export interface CrawlOptions extends ScanOptions {
  /** Maximum number of pages to scan (default 5). */
  maxPages?: number;
  /** Only follow links on the same origin as the start URL (default true). */
  sameOriginOnly?: boolean;
}

export interface PageScan {
  url: string;
  results?: AxeResults;
  error?: string;
}

/** Strip the hash from a URL for dedup; return null for non-http(s) or unparseable URLs. */
function normalizeUrl(u: string): string | null {
  try {
    const x = new URL(u);
    if (x.protocol !== "http:" && x.protocol !== "https:") return null;
    x.hash = "";
    return x.toString();
  } catch {
    return null;
  }
}

const NON_PAGE_EXT =
  /\.(pdf|zip|png|jpe?g|gif|svg|webp|ico|css|js|json|xml|mp4|mp3|woff2?|ttf|eot|dmg|exe)(\?|$)/i;

/**
 * Crawl a running site starting from `startUrl`, breadth-first, following
 * same-origin links, and run an axe-core audit on each page (up to maxPages).
 */
export async function scanSite(startUrl: string, opts: CrawlOptions = {}): Promise<PageScan[]> {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error(`Invalid start URL: ${startUrl}`);
  const origin = new URL(start).origin;
  const maxPages = Math.max(1, opts.maxPages ?? 5);
  const sameOriginOnly = opts.sameOriginOnly !== false;

  const queue: string[] = [start];
  const seen = new Set<string>(queue);
  const out: PageScan[] = [];

  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    while (queue.length > 0 && out.length < maxPages) {
      const url = queue.shift()!;
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs ?? 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        const results = await buildAxe(page, opts).analyze();
        out.push({ url, results });

        // Only bother collecting more links if we still have budget.
        if (out.length + queue.length < maxPages) {
          const hrefs = await page
            .$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href))
            .catch(() => [] as string[]);
          for (const href of hrefs) {
            const n = normalizeUrl(href);
            if (!n || seen.has(n) || NON_PAGE_EXT.test(n)) continue;
            if (sameOriginOnly && new URL(n).origin !== origin) continue;
            seen.add(n);
            queue.push(n);
          }
        }
      } catch (err) {
        out.push({ url, error: (err as Error).message });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  return out;
}

const IMPACT_ORDER: Record<string, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

function sortByImpact(a: AxeResult, b: AxeResult): number {
  const ai = IMPACT_ORDER[a.impact ?? "minor"] ?? 4;
  const bi = IMPACT_ORDER[b.impact ?? "minor"] ?? 4;
  return ai - bi;
}

export interface FormatOptions {
  detail: "summary" | "full";
  maxNodes: number;
  /** Also report axe "incomplete" items — checks that need manual review. */
  includeIncomplete?: boolean;
}

/** Render one axe result (violation or incomplete item) into markdown lines. */
function renderRule(
  r: AxeResult,
  { detail, maxNodes }: Pick<FormatOptions, "detail" | "maxNodes">,
  lines: string[]
): void {
  lines.push(`## [${(r.impact ?? "n/a").toUpperCase()}] ${r.id} — ${r.help}`);
  lines.push(r.description);
  lines.push(`Affected elements: ${r.nodes.length} · Learn more: ${r.helpUrl}`);
  if (r.tags.length > 0) lines.push(`Tags: ${r.tags.join(", ")}`);

  if (detail === "full") {
    const shown = r.nodes.slice(0, maxNodes);
    for (const node of shown) {
      lines.push("");
      lines.push("```html");
      lines.push(node.html);
      lines.push("```");
      lines.push(`- Selector: \`${node.target.join(" ")}\``);
      const summary = node.failureSummary;
      if (summary) {
        lines.push(`- Fix: ${summary.replace(/\n/g, "\n  ")}`);
      }
    }
    if (r.nodes.length > shown.length) {
      lines.push("");
      lines.push(`…and ${r.nodes.length - shown.length} more element(s).`);
    }
  }
  lines.push("");
}

/** Render axe results into a compact, LLM-friendly markdown report. */
export function formatResults(
  results: AxeResults,
  target: string,
  { detail, maxNodes, includeIncomplete = false }: FormatOptions
): string {
  const violations = [...results.violations].sort(sortByImpact);
  const counts: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) {
    const impact = (v.impact as ImpactValue | null) ?? "minor";
    counts[impact] = (counts[impact] ?? 0) + v.nodes.length;
  }

  const lines: string[] = [];
  lines.push(`# Accessibility scan: ${target}`);
  lines.push("");
  lines.push(
    `**${violations.length} violation rule(s)** — ` +
      `critical: ${counts.critical}, serious: ${counts.serious}, ` +
      `moderate: ${counts.moderate}, minor: ${counts.minor}`
  );
  lines.push(
    `passes: ${results.passes.length} · incomplete (needs review): ${results.incomplete.length} · ` +
      `inapplicable: ${results.inapplicable.length}`
  );
  lines.push("");

  const incomplete = includeIncomplete ? [...results.incomplete].sort(sortByImpact) : [];

  if (violations.length === 0) {
    lines.push("✅ No violations found for the selected rules/tags.");
    if (results.incomplete.length > 0 && !includeIncomplete) {
      lines.push("");
      lines.push(
        `⚠️ ${results.incomplete.length} item(s) need manual review. Re-run with includeIncomplete=true to see them.`
      );
    }
  }

  if (violations.length > 0) {
    lines.push("## Violations");
    lines.push("");
    for (const v of violations) renderRule(v, { detail, maxNodes }, lines);
  }

  if (includeIncomplete && incomplete.length > 0) {
    lines.push("# Needs manual review (incomplete)");
    lines.push(
      "axe could not decide these automatically — a human must confirm. Often true positives."
    );
    lines.push("");
    for (const i of incomplete) renderRule(i, { detail, maxNodes }, lines);
  }

  return lines.join("\n").trim();
}

/** Render a multi-page crawl into an aggregated site report. */
export function formatSiteResults(
  pages: PageScan[],
  startUrl: string,
  { detail, maxNodes, includeIncomplete = false }: FormatOptions
): string {
  const scanned = pages.filter((p) => p.results);
  const failed = pages.filter((p) => p.error);

  // Aggregate each violated rule across all pages.
  interface Agg {
    id: string;
    impact: string;
    help: string;
    totalNodes: number;
    pages: Set<string>;
  }
  const agg = new Map<string, Agg>();
  let totalViolations = 0;
  for (const p of scanned) {
    for (const v of p.results!.violations) {
      totalViolations += v.nodes.length;
      const existing = agg.get(v.id);
      if (existing) {
        existing.totalNodes += v.nodes.length;
        existing.pages.add(p.url);
      } else {
        agg.set(v.id, {
          id: v.id,
          impact: v.impact ?? "n/a",
          help: v.help,
          totalNodes: v.nodes.length,
          pages: new Set([p.url]),
        });
      }
    }
  }
  const ranked = [...agg.values()].sort(
    (a, b) => (IMPACT_ORDER[a.impact] ?? 4) - (IMPACT_ORDER[b.impact] ?? 4)
  );

  const lines: string[] = [];
  lines.push(`# Site accessibility scan: ${startUrl}`);
  lines.push("");
  lines.push(
    `Crawled **${scanned.length} page(s)**` +
      (failed.length ? ` (${failed.length} failed to load)` : "") +
      ` · **${totalViolations} total violation instance(s)** across ${ranked.length} distinct rule(s).`
  );
  lines.push("");

  if (ranked.length > 0) {
    lines.push("## Violations across the site (most severe first)");
    lines.push("");
    lines.push("| Rule | Impact | Instances | Pages affected |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of ranked) {
      lines.push(
        `| ${r.id} — ${r.help} | ${r.impact} | ${r.totalNodes} | ${r.pages.size} |`
      );
    }
    lines.push("");
  } else {
    lines.push("✅ No violations found on any crawled page for the selected rules/tags.");
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("## Pages that failed to load");
    for (const f of failed) lines.push(`- ${f.url} — ${f.error}`);
    lines.push("");
  }

  // Per-page detail reuses the single-page formatter.
  lines.push("## Per-page detail");
  lines.push("");
  for (const p of scanned) {
    lines.push("---");
    lines.push(formatResults(p.results!, p.url, { detail, maxNodes, includeIncomplete }));
    lines.push("");
  }

  return lines.join("\n").trim();
}
