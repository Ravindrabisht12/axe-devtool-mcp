import { chromium, type Browser, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import type { AxeResults, Result as AxeResult, ImpactValue } from "axe-core";

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
