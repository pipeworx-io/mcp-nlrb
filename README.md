# @pipeworx/nlrb

US National Labor Relations Board case search — unfair labor practice charges
and union representation/election petitions (~516,000 cases), read live from
the NLRB's public case search on nlrb.gov.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `nlrb_search(query, case_type?, status?, filed_since?, filed_before?, region?, sort?, limit?, page?)` —
  finds cases by employer name, union name, or case number. Returns case
  number, case name, date filed, open/closed status, city and NLRB region, plus
  the total number of matching cases. Answers "is Starbucks facing an NLRB
  charge", "union election petitions at Trader Joe's".
- `nlrb_case(case_number)` — the full docket for one case: allegations charged
  under the National Labor Relations Act, status, location, region,
  participants (charged party, charging party, employer, union, and their legal
  representatives), the docket activity log, and — for representation cases
  that reached a count — the election tally (eligible voters, ballots counted,
  votes for and against the union).
- `nlrb_recent_filings(days?, case_type?, status?, region?, limit?)` — newest
  filings nationally over a recent window, newest first, with the total filed in
  that window.

## Auth

Keyless. No account, no registration, no key.

## Data sources

- <https://www.nlrb.gov/get-search-data/{term}/cases?sort=&rows=&page=> — the
  case search. A Drupal AJAX endpoint: it returns a command array whose `data`
  fields carry the rendered result HTML and whose trailing `invoke` command
  carries the total match count in `args[4]`.
- <https://www.nlrb.gov/case/{case-number}> — the server-rendered case docket.

### Things worth knowing before you touch this pack

- **The tab segment must be `cases`, plural.** `/get-search-data/{term}/case`
  is refused by the site's WAF with an HTTP **200** carrying a "Request
  Rejected" HTML page — a rejection that reads as a success unless you inspect
  the body. The pack checks for that page and returns
  `{ found: false, reason: 'blocked' }`.
- **The search term is a path segment**, so a `/` in it silently changes which
  endpoint you hit. Slashes are stripped and the term is URL-encoded.
- **Query parameters on `/search/case` are ignored.** The visible search form
  POSTs; `?search_term=Starbucks` returns the unfiltered 516k listing with the
  header still reading "for all". Only `/get-search-data/...` honours a term.
- **Filters ride as bracketed params**: `f[0]=case_type:C` (or `case_type:R`, or
  `(case_type:C OR case_type:R)`), `s[n]=Open|Closed|Open - Blocked`,
  `r[n]=<region>`, `state[n]=<XX>`, and `date_start`/`date_end` in **MM/DD/YYYY**
  — ISO dates are ignored rather than rejected, so the pack converts.
- **Sort** accepts `desc` (newest), `asc` (oldest) and `relevance`; `rows` and a
  zero-based `page` both work, confirmed to `rows=50`.
- **Case numbers are region-type-serial** (`10-CB-393760`): 2-digit region, case
  type (CA/CB against an employer/union, RC/RD/RM for representation), serial.
  The pack uppercases and zero-pads a single-digit region.
- Election tallies exist only on R cases that reached a count, and render as a
  second label/value block on the case page, so a generic label scrape mixes
  them into the case header unless they are separated by label name.
- The docket activity table on a case page shows only the most recent entries
  and, per NLRB's own footnote, does not reflect all actions in the case.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nlrb": {
      "url": "https://gateway.pipeworx.io/nlrb/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/nlrb/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nlrb_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Starbucks Corporation","limit":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nlrb_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "nlrb": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-nlrb"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-nlrb
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Nlrb data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
