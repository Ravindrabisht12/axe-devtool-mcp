#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  scanUrl,
  scanHtml,
  scanFile,
  scanSite,
  formatResults,
  formatSiteResults,
  closeBrowser,
  type ScanOptions,
} from "./scanner.js";

const server = new McpServer({
  name: "axe-devtools-mcp",
  version: "0.3.0",
});

const commonShape = {
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'WCAG / rule tags to run, e.g. ["wcag2a","wcag2aa","wcag21aa","best-practice"]. Omit to run the default rule set.'
    ),
  rules: z
    .array(z.string())
    .optional()
    .describe('Only run these axe rule ids, e.g. ["color-contrast","image-alt"].'),
  excludeRules: z
    .array(z.string())
    .optional()
    .describe("Axe rule ids to skip."),
  detail: z
    .enum(["summary", "full"])
    .optional()
    .default("full")
    .describe(
      '"summary" lists violated rules and counts only; "full" (default) also lists offending elements and fix guidance.'
    ),
  includeIncomplete: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Also report axe "incomplete" items — checks that need manual review (e.g. color-contrast over images, aria-hidden focus). Off by default; set true to surface likely issues automated rules could not confirm.'
    ),
  maxNodes: z
    .number()
    .int()
    .positive()
    .optional()
    .default(5)
    .describe("Max offending elements to list per rule when detail=full."),
};

function toScanOptions(input: {
  tags?: string[];
  rules?: string[];
  excludeRules?: string[];
  include?: string;
  timeoutMs?: number;
}): ScanOptions {
  return {
    tags: input.tags,
    rules: input.rules,
    excludeRules: input.excludeRules,
    include: input.include,
    timeoutMs: input.timeoutMs,
  };
}

server.registerTool(
  "scan_url",
  {
    title: "Scan a URL for accessibility issues",
    description:
      "Loads a URL in headless Chromium, runs an axe-core accessibility audit, and returns WCAG violations with fix guidance. Use for live pages (http/https) or local dev servers.",
    inputSchema: {
      url: z.string().url().describe("The URL to scan (http:// or https://)."),
      include: z
        .string()
        .optional()
        .describe("Optional CSS selector to scope the scan to one region of the page."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Navigation timeout in milliseconds (default 30000)."),
      ...commonShape,
    },
  },
  async ({ url, detail, maxNodes, includeIncomplete, ...rest }) => {
    try {
      const results = await scanUrl(url, toScanOptions(rest));
      return {
        content: [
          {
            type: "text",
            text: formatResults(results, url, { detail, maxNodes, includeIncomplete }),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Scan failed: ${(err as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "scan_html",
  {
    title: "Scan raw HTML for accessibility issues",
    description:
      "Runs an axe-core accessibility audit against a raw HTML string (rendered in headless Chromium). Use for markup snippets or generated HTML that isn't served at a URL.",
    inputSchema: {
      html: z.string().min(1).describe("The HTML markup to scan."),
      ...commonShape,
    },
  },
  async ({ html, detail, maxNodes, includeIncomplete, ...rest }) => {
    try {
      const results = await scanHtml(html, toScanOptions(rest));
      return {
        content: [
          {
            type: "text",
            text: formatResults(results, "HTML snippet", {
              detail,
              maxNodes,
              includeIncomplete,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Scan failed: ${(err as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "scan_file",
  {
    title: "Scan a local HTML file for accessibility issues",
    description:
      "Runs an axe-core accessibility audit against a local .html file on disk (loaded via file:// so linked CSS/assets resolve). Use for static-site build output. Note: single-page-app build files are usually empty shells hydrated by JS — scan the running dev server with scan_url instead.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Path to a local .html file (absolute, or relative to the server's cwd)."),
      include: z
        .string()
        .optional()
        .describe("Optional CSS selector to scope the scan to one region of the page."),
      timeoutMs: z.number().int().positive().optional().describe("Load timeout in ms (default 30000)."),
      ...commonShape,
    },
  },
  async ({ path: filePath, detail, maxNodes, includeIncomplete, ...rest }) => {
    try {
      const results = await scanFile(filePath, toScanOptions(rest));
      return {
        content: [
          {
            type: "text",
            text: formatResults(results, filePath, { detail, maxNodes, includeIncomplete }),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Scan failed: ${(err as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "scan_site",
  {
    title: "Crawl a running site and scan multiple pages",
    description:
      "Crawls a running site breadth-first starting from a URL, following same-origin links, and runs an axe-core audit on each page (up to maxPages). Returns an aggregated report plus per-page detail. Use to audit a whole site/app in one call instead of scanning routes one by one.",
    inputSchema: {
      url: z.string().url().describe("The start URL to crawl from (http:// or https://)."),
      maxPages: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .default(5)
        .describe("Maximum number of pages to crawl and scan (default 5, max 50)."),
      sameOriginOnly: z
        .boolean()
        .optional()
        .default(true)
        .describe("Only follow links on the same origin as the start URL (default true)."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Per-page navigation timeout in ms (default 30000)."),
      ...commonShape,
    },
  },
  async ({ url, maxPages, sameOriginOnly, detail, maxNodes, includeIncomplete, ...rest }) => {
    try {
      const pages = await scanSite(url, {
        ...toScanOptions(rest),
        maxPages,
        sameOriginOnly,
      });
      return {
        content: [
          {
            type: "text",
            text: formatSiteResults(pages, url, { detail, maxNodes, includeIncomplete }),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Scan failed: ${(err as Error).message}` }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logging on stdio transport (stdout is the protocol channel).
  console.error("axe-devtools-mcp running on stdio");
}

async function shutdown() {
  await closeBrowser();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
