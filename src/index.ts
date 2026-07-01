#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  scanUrl,
  scanHtml,
  formatResults,
  closeBrowser,
  type ScanOptions,
} from "./scanner.js";

const server = new McpServer({
  name: "axe-devtools-mcp",
  version: "0.1.0",
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
  async ({ url, detail, maxNodes, ...rest }) => {
    try {
      const results = await scanUrl(url, toScanOptions(rest));
      return {
        content: [
          { type: "text", text: formatResults(results, url, { detail, maxNodes }) },
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
  async ({ html, detail, maxNodes, ...rest }) => {
    try {
      const results = await scanHtml(html, toScanOptions(rest));
      return {
        content: [
          {
            type: "text",
            text: formatResults(results, "HTML snippet", { detail, maxNodes }),
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
