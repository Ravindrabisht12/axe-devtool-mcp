# axe-devtools-mcp

An [MCP](https://modelcontextprotocol.io) server that runs [axe-core](https://www.npmjs.com/package/axe-core) accessibility audits and returns the results to any MCP client — including **Claude Code**, Claude Desktop, and Cursor.

It renders pages in headless Chromium (via Playwright), injects axe-core, and reports WCAG violations with impact levels, affected elements, and fix guidance.

## Tools

| Tool | Description |
| --- | --- |
| `scan_url` | Load a URL (live site or local dev server) in headless Chromium and run an axe-core audit. |
| `scan_html` | Run an axe-core audit against a raw HTML string. |

Both tools accept:

- `tags` — WCAG / rule tags to run, e.g. `["wcag2a", "wcag2aa", "wcag21aa", "best-practice"]`
- `rules` — only run these axe rule ids, e.g. `["color-contrast", "image-alt"]`
- `excludeRules` — axe rule ids to skip
- `detail` — `"full"` (default; lists offending elements + fixes) or `"summary"` (rule + counts only)
- `maxNodes` — max offending elements to list per rule when `detail="full"` (default `5`)

`scan_url` also accepts `include` (CSS selector to scope the scan) and `timeoutMs` (navigation timeout).

## Requirements

- Node.js >= 18
- A Chromium browser managed by Playwright. `npm install` runs `npx playwright install chromium` automatically; if that was skipped, run it manually:
  ```bash
  npx playwright install chromium
  ```

## Use with Claude Code

Register the server with the Claude Code CLI:

```bash
# From npm (once published)
claude mcp add axe-devtools -- npx -y axe-devtools-mcp

# Or from a local clone
claude mcp add axe-devtools -- node /absolute/path/to/axe-devtool-mcp/dist/index.js
```

Then in Claude Code:

> Scan https://example.com for accessibility issues.

## Use with Claude Desktop / Cursor

Add to your MCP config (`claude_desktop_config.json` or Cursor's `mcp.json`):

```json
{
  "mcpServers": {
    "axe-devtools": {
      "command": "npx",
      "args": ["-y", "axe-devtools-mcp"]
    }
  }
}
```

## Run from source

```bash
git clone https://github.com/<you>/axe-devtools-mcp.git
cd axe-devtools-mcp
npm install
npm run build
node dist/index.js   # speaks MCP over stdio
```

## Publish to npm

```bash
npm login
npm publish --access public
```

After publishing, anyone can run it with `npx -y axe-devtools-mcp` — no clone required.

## How it works

```
MCP client (Claude Code)
   │  stdio (JSON-RPC)
   ▼
axe-devtools-mcp  ──►  Playwright (headless Chromium)  ──►  axe-core injected into the page
   ▲                                                              │
   └──────────────  formatted violations + fixes  ◄──────────────┘
```

## License

MIT
