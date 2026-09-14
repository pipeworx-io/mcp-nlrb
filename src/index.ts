interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * NLRB MCP — US National Labor Relations Board case search: unfair labor
 * practice (C) charges and representation (R) election petitions, sourced live
 * from nlrb.gov's public case search (~516,000 cases, no key, no account).
 *
 * ACCESS PATH (verified live 2026-08-29, not from documentation):
 *   Search  GET https://www.nlrb.gov/get-search-data/<term>/cases?sort=&rows=&page=
 *           A Drupal AJAX endpoint returning a command array whose `data`
 *           fields carry the rendered result HTML, and whose trailing
 *           `invoke` command carries the TOTAL match count in args[4].
 *           Filters ride along as f[0]=case_type:C|R, s[n]=<status>,
 *           r[n]=<region>, state[n]=<XX>, date_start/date_end (MM/DD/YYYY).
 *   Detail  GET https://www.nlrb.gov/case/<case-number>  — server-rendered.
 *
 * Traps, all measured:
 * - The tab segment must be `cases`. `/get-search-data/<term>/case` (singular)
 *   is refused by the site's WAF with a 200-status "Request Rejected" HTML
 *   page — a rejection that looks like a success unless you check the body.
 *   Any WAF refusal is surfaced here as { found: false, reason: 'blocked' }
 *   rather than a parse error blamed on us.
 * - The term is a PATH segment, so a term containing "/" silently changes the
 *   endpoint. Slashes are stripped and the term is URL-encoded.
 * - GET query params on /search/case are ignored (the visible form POSTs);
 *   only the get-search-data path honours a search term.
 * - 516k cases: there is no useful unfiltered enumeration. Every tool filters.
 * - Election tallies exist only on R cases that have reached a count, and are
 *   rendered as a second label/value block on the case page.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'NLRB');
}

const BASE_URL = 'https://www.nlrb.gov';
const UA = 'pipeworx-mcp-nlrb/1.0 (+https://pipeworx.io)';

/** Labels that belong to the election-tally block rather than the case header. */
const TALLY_LABELS = new Set([
  'Tally Issued Date',
  'No. of Eligible Voters',
  'Void Ballots',
  'Total Ballots Counted',
  'Challenged Ballots',
  'Votes for Labor Union',
  'Tally Type',
  'Ballot Type',
  'Unit ID',
  'Votes Against',
  'Challenges Determinative',
]);

const tools: McpToolExport['tools'] = [
  {
    name: 'nlrb_search',
    description:
      'Search US National Labor Relations Board cases by employer, union, or case number — unfair labor practice charges (C cases: CA against an employer, CB against a union) and union representation/election petitions (R cases: RC, RD, RM). Returns case number, case name, date filed, open/closed status, city and NLRB region for each match, plus the total number of matching cases. Answers "is Starbucks facing an NLRB charge", "labor board complaints against Amazon", "union election petitions at Trader Joe\'s", "what NLRB cases involve Teamsters Local 705". Filter by case type, status, date filed, and NLRB region.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Employer name, union name, or a full case number such as "10-CB-393760". Matched full-text against case names; case-insensitive.',
        },
        case_type: {
          type: 'string',
          description:
            'Restrict to "C" (unfair labor practice charges) or "R" (representation/election petitions). Omit for both.',
        },
        status: {
          type: 'string',
          description: 'Restrict to "Open", "Closed", or "Open - Blocked".',
        },
        filed_since: {
          type: 'string',
          description: 'Only cases filed on or after this date (YYYY-MM-DD).',
        },
        filed_before: {
          type: 'string',
          description: 'Only cases filed on or before this date (YYYY-MM-DD).',
        },
        region: {
          type: 'string',
          description:
            'NLRB region number, e.g. "10" (Atlanta), "29" (Brooklyn). Two digits; single digits are zero-padded.',
        },
        sort: {
          type: 'string',
          description: '"newest" (default), "oldest", or "relevance".',
        },
        limit: {
          type: ['number', 'string'],
          description: 'Max cases to return (1-50, default 10).',
        },
        page: {
          type: ['number', 'string'],
          description: 'Zero-based page of results, for paging past the first `limit` cases.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'nlrb_case',
    description:
      'Full docket for one US National Labor Relations Board case by case number (e.g. "10-CB-393760", "31-RC-357638"): the allegations charged under the National Labor Relations Act (such as "8(a)(3) Discharge" or "8(b)(1)(A) Duty of Fair Representation"), status, date filed, location, assigned region, the participants (charged party, charging party, employer, union and their legal representatives), the docket activity log, and for representation cases the election tally — eligible voters, ballots counted, votes for and against the union. Answers "what is Starbucks charged with in this NLRB case", "how did the union election in case 31-RC-357638 turn out".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        case_number: {
          type: 'string',
          description:
            'NLRB case number in region-type-serial form, e.g. "10-CB-393760" or "31-rc-357638" (case-insensitive; surrounding whitespace ignored).',
        },
      },
      required: ['case_number'],
    },
  },
  {
    name: 'nlrb_recent_filings',
    description:
      'Newest US National Labor Relations Board case filings across the country over a recent window — the labor-dispute equivalent of a new-filings feed. Returns case number, name, date filed, status, city and region, newest first, with the total filed in the window. Answers "what NLRB charges were filed this week", "recent union election petitions", "how much labor board activity was there in the last 30 days". Filter by case type (C for unfair labor practice charges, R for election petitions) and NLRB region.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: {
          type: ['number', 'string'],
          description: 'How many days back from today to include (1-365, default 7).',
        },
        case_type: {
          type: 'string',
          description:
            'Restrict to "C" (unfair labor practice charges) or "R" (representation/election petitions). Omit for both. "ULP" is accepted as a synonym for C.',
        },
        status: {
          type: 'string',
          description: 'Restrict to "Open", "Closed", or "Open - Blocked".',
        },
        region: {
          type: 'string',
          description: 'NLRB region number, e.g. "10", "29".',
        },
        limit: {
          type: ['number', 'string'],
          description: 'Max cases to return (1-50, default 25).',
        },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------- fetch layer

async function rawFetch(url: string): Promise<Response> {
  return pwFetch(url, {
    headers: { Accept: '*/*', 'User-Agent': UA },
  });
}

/** True when nlrb.gov's WAF served its 200-status "Request Rejected" page. */
function isWafRejection(body: string): boolean {
  return /Request Rejected|The requested URL was rejected/i.test(body.slice(0, 600));
}

async function fetchText(url: string, what: string): Promise<{ ok: true; body: string } | { ok: false; reason: string; hint: string }> {
  let res: Response;
  try {
    res = await rawFetch(url);
  } catch {
    // One retry: nlrb.gov drops the occasional connection under load.
    try {
      res = await rawFetch(url);
    } catch (e) {
      return {
        ok: false,
        reason: 'upstream_unreachable',
        hint: `Could not reach nlrb.gov for ${what} (${(e as Error).message}). The site is keyless and normally reachable; retry shortly.`,
      };
    }
  }
  if (res.status === 404) {
    return { ok: false, reason: 'not_found', hint: `nlrb.gov has no ${what}.` };
  }
  const body = await res.text();
  if (isWafRejection(body)) {
    return {
      ok: false,
      reason: 'blocked',
      hint: `nlrb.gov's web application firewall refused this request for ${what}. Simplify the search term (plain company or union name, no punctuation-heavy strings) and retry.`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: res.status >= 500 ? 'upstream_error' : 'bad_request',
      hint: `nlrb.gov returned HTTP ${res.status} for ${what}.`,
    };
  }
  return { ok: true, body };
}

// ------------------------------------------------------------- HTML utilities

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * Pulls `<b|strong ...>Label:</b> value` pairs out of a fragment. Both the
 * search rows and the case page use this shape; only the tag and the value
 * terminator differ, so both terminators are accepted.
 */
function labelPairs(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<(b|strong)\b[^>]*>\s*([^<]+?)\s*:\s*<\/\1>([\s\S]*?)(?:<br|<\/p>|<\/div>|<(?:b|strong)\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    const label = decodeEntities(m[2]).trim();
    const value = stripTags(m[3]);
    if (label && value && !(label in out)) out[label] = value;
  }
  return out;
}

// ------------------------------------------------------------------- search

type CaseRow = {
  case_number: string;
  case_name: string;
  date_filed: string | null;
  status: string | null;
  location: string | null;
  region: string | null;
  case_type: string | null;
  url: string;
};

/** "10-CB-393760" -> "CB"; the middle segment is the case type code. */
function caseTypeOf(caseNumber: string): string | null {
  const m = /^\d{2}-([A-Z]{2})-/i.exec(caseNumber);
  return m ? m[1].toUpperCase() : null;
}

function parseSearchRows(html: string): CaseRow[] {
  const rows: CaseRow[] = [];
  const blocks = html.split(/<div class="wrapper-div">/).slice(1);
  for (const block of blocks) {
    const title = /<h2>\s*<a href="\/case\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!title) continue;
    const caseNumber = decodeEntities(title[1]).trim();
    const fields = labelPairs(block);
    rows.push({
      case_number: fields['Case Number'] || caseNumber,
      case_name: stripTags(title[2]),
      date_filed: fields['Date Filed'] ?? null,
      status: fields['Status'] ?? null,
      location: fields['Location'] ?? null,
      region: fields['Region Assigned'] ?? null,
      case_type: caseTypeOf(caseNumber),
      url: `${BASE_URL}/case/${caseNumber}`,
    });
  }
  return rows;
}

type AjaxCommand = { command?: string; data?: unknown; method?: string; args?: unknown[] };

/** The trailing `invoke` command carries the total match count in args[4]. */
function parseAjax(body: string): { html: string; total: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const cmds = parsed as AjaxCommand[];
  const html = cmds.map((c) => (typeof c.data === 'string' ? c.data : '')).join('');
  let total: number | null = null;
  for (const c of cmds) {
    if (c.command === 'invoke' && Array.isArray(c.args) && typeof c.args[4] === 'number') {
      total = c.args[4] as number;
    }
  }
  return { html, total };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** YYYY-MM-DD (or a Date) -> MM/DD/YYYY, which is the only format the filters accept. */
function toUsDate(input: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(input.trim())) return input.trim();
  return null;
}

function daysAgoUs(days: number): string {
  const d = new Date(Date.now() - days * 86400000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

function normalizeCaseType(input: unknown): 'C' | 'R' | null {
  if (typeof input !== 'string') return null;
  const v = input.trim().toUpperCase();
  if (v === 'C' || v === 'ULP' || v === 'CA' || v === 'CB' || v === 'UNFAIR LABOR PRACTICE') return 'C';
  if (v === 'R' || v === 'RC' || v === 'RD' || v === 'RM' || v === 'REPRESENTATION' || v === 'ELECTION') return 'R';
  return null;
}

function normalizeStatus(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  if (v === 'open') return 'Open';
  if (v === 'closed') return 'Closed';
  if (v.startsWith('open - blocked') || v === 'blocked' || v === 'open-blocked') return 'Open - Blocked';
  return null;
}

type SearchOpts = {
  term: string;
  caseType?: 'C' | 'R' | null;
  status?: string | null;
  region?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
  sort?: string;
  rows: number;
  page?: number;
};

async function runSearch(opts: SearchOpts): Promise<
  | { ok: true; rows: CaseRow[]; total: number | null; url: string }
  | { ok: false; reason: string; hint: string }
> {
  // The term is a PATH segment — a slash in it would change the endpoint.
  const term = opts.term.replace(/[\\/]+/g, ' ').trim() || 'all';
  const params: string[] = [`sort=${encodeURIComponent(opts.sort || 'desc')}`, `rows=${opts.rows}`];
  if (opts.page) params.push(`page=${opts.page}`);
  if (opts.caseType) params.push(`f[0]=case_type:${opts.caseType}`);
  if (opts.status) params.push(`s[0]=${encodeURIComponent(opts.status)}`);
  if (opts.region) params.push(`r[0]=${encodeURIComponent(opts.region)}`);
  if (opts.dateStart) params.push(`date_start=${encodeURIComponent(opts.dateStart)}`);
  if (opts.dateEnd) params.push(`date_end=${encodeURIComponent(opts.dateEnd)}`);
  const url = `${BASE_URL}/get-search-data/${encodeURIComponent(term)}/cases?${params.join('&')}`;

  const res = await fetchText(url, `case search for "${term}"`);
  if (!res.ok) return res;
  const ajax = parseAjax(res.body);
  if (!ajax) {
    return {
      ok: false,
      reason: 'unexpected_response',
      hint: 'nlrb.gov returned a non-JSON body for the case search endpoint, which usually means the site is serving an interstitial. Retry shortly.',
    };
  }
  return { ok: true, rows: parseSearchRows(ajax.html), total: ajax.total, url };
}

// -------------------------------------------------------------- case detail

function parseAllegations(html: string): string[] | null {
  const i = html.indexOf('<h2>Allegations</h2>');
  if (i < 0) return null;
  // Bound at the next heading — the page footer carries its own <ul>, which an
  // open-ended window swallows as if the languages menu were allegations.
  const next = html.indexOf('<h2', i + 20);
  const segment = html.slice(i, next > i ? next : i + 6000);
  if (/Allegations data is not available/i.test(segment)) return [];
  const items = [...segment.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1])).filter(Boolean);
  return items.length ? items : [];
}

function parseParticipants(html: string): Array<{ role: string | null; detail: string; address: string | null; phone: string | null }> {
  const i = html.indexOf("class='Participants");
  if (i < 0) return [];
  const table = html.slice(i, html.indexOf('</table>', i) + 8);
  const out: Array<{ role: string | null; detail: string; address: string | null; phone: string | null }> = [];
  for (const tr of table.split('<tr>').slice(1)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 3) continue;
    const roleMatch = /<b>\s*([\s\S]*?)<\/b>/.exec(cells[0]);
    const role = roleMatch ? stripTags(roleMatch[1]) : null;
    const detail = stripTags(cells[0].replace(/<b>[\s\S]*?<\/b>/, ''));
    if (!role && !detail) continue;
    out.push({
      role,
      detail,
      address: stripTags(cells[1]) || null,
      phone: stripTags(cells[2]) || null,
    });
  }
  return out;
}

function parseDocketActivity(html: string): Array<{ date: string; document: string; filed_by: string }> {
  const i = html.indexOf("class='docket-activity-table");
  if (i < 0) return [];
  const table = html.slice(i, html.indexOf('</table>', i) + 8);
  const out: Array<{ date: string; document: string; filed_by: string }> = [];
  for (const tr of table.split('<tr>').slice(1)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]));
    if (cells.length < 3) continue;
    if (!cells[0] && !cells[1]) continue;
    out.push({ date: cells[0], document: cells[1], filed_by: cells[2] });
  }
  return out;
}

// ------------------------------------------------------------------ callTool

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'nlrb_search': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return {
          found: false,
          reason: 'missing_query',
          hint: 'nlrb_search needs a query — an employer name, a union name, or a case number like "10-CB-393760". For a national feed of new filings with no search term, use nlrb_recent_filings.',
        };
      }
      const limit = clampInt(args.limit, 1, 50, 10);
      const sortArg = typeof args.sort === 'string' ? args.sort.trim().toLowerCase() : 'newest';
      const sort = sortArg === 'oldest' ? 'asc' : sortArg === 'relevance' ? 'relevance' : 'desc';
      const dateStart = typeof args.filed_since === 'string' ? toUsDate(args.filed_since) : null;
      const dateEnd = typeof args.filed_before === 'string' ? toUsDate(args.filed_before) : null;
      if (typeof args.filed_since === 'string' && !dateStart) {
        return { found: false, reason: 'bad_date', hint: 'filed_since must be YYYY-MM-DD, e.g. "2026-01-01".' };
      }
      if (typeof args.filed_before === 'string' && !dateEnd) {
        return { found: false, reason: 'bad_date', hint: 'filed_before must be YYYY-MM-DD, e.g. "2026-08-01".' };
      }
      const region = typeof args.region === 'string' && args.region.trim() ? args.region.trim().padStart(2, '0') : null;

      const res = await runSearch({
        term: query,
        caseType: normalizeCaseType(args.case_type),
        status: normalizeStatus(args.status),
        region,
        dateStart,
        dateEnd,
        sort,
        rows: limit,
        page: clampInt(args.page, 0, 500, 0),
      });
      if (!res.ok) return { found: false, reason: res.reason, hint: res.hint };
      if (!res.rows.length) {
        return {
          found: false,
          reason: 'no_matches',
          query,
          total_matches: res.total ?? 0,
          hint: `No NLRB cases matched "${query}" with the filters given. Case names are the charged party as filed (often a formal legal name — "Starbucks Corporation", not "Starbucks stores"), so try a shorter or more formal name, or drop the case_type/status/date filters.`,
          source: 'National Labor Relations Board case search (nlrb.gov)',
        };
      }
      return {
        found: true,
        query,
        total_matches: res.total,
        returned: res.rows.length,
        cases: res.rows,
        note:
          res.total && res.total > res.rows.length
            ? `Showing ${res.rows.length} of ${res.total} matching cases; raise limit (max 50) or advance page for more.`
            : undefined,
        source: 'National Labor Relations Board case search (nlrb.gov)',
      };
    }

    case 'nlrb_case': {
      const raw = typeof args.case_number === 'string' ? args.case_number.trim() : '';
      // Case numbers are region-type-serial; accept any case and spacing.
      const normalized = raw.toUpperCase().replace(/\s+/g, '');
      if (!/^\d{1,2}-[A-Z]{2}-\d+$/.test(normalized)) {
        return {
          found: false,
          reason: 'bad_case_number',
          hint: `"${raw}" is not an NLRB case number. They look like "10-CB-393760" — region, case type, serial. Use nlrb_search to find one by employer or union name.`,
        };
      }
      const caseNumber = normalized.replace(/^(\d)-/, '0$1-');
      const url = `${BASE_URL}/case/${caseNumber}`;
      const res = await fetchText(url, `case ${caseNumber}`);
      if (!res.ok) return { found: false, reason: res.reason, case_number: caseNumber, hint: res.hint };
      const html = res.body;

      const title = /<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/.exec(html);
      const caseName = title ? stripTags(title[1]) : null;
      if (!caseName || /Page not found/i.test(caseName)) {
        return {
          found: false,
          reason: 'not_found',
          case_number: caseNumber,
          hint: `nlrb.gov has no case ${caseNumber}. Check the region and serial, or search for the party with nlrb_search.`,
        };
      }

      // Header and (for R cases that reached a count) election tally are two
      // consecutive label/value blocks between the title and the docket table.
      const headEnd = html.indexOf('id="case_docket_activity_data"');
      const header = html.slice(0, headEnd > 0 ? headEnd : html.length);
      const segments = header.split('display-flex flex-justify flex-wrap').slice(1);
      const caseFields: Record<string, string> = {};
      const tallyFields: Record<string, string> = {};
      for (const seg of segments) {
        for (const [label, value] of Object.entries(labelPairs(seg))) {
          if (TALLY_LABELS.has(label)) tallyFields[label] = value;
          else if (!(label in caseFields)) caseFields[label] = value;
        }
      }

      const allegations = parseAllegations(html);
      const docket = parseDocketActivity(html);
      const type = caseTypeOf(caseNumber);
      return {
        found: true,
        case_number: caseFields['Case Number'] || caseNumber,
        case_name: caseName,
        case_type: type,
        case_type_meaning:
          type && type.startsWith('C')
            ? 'Unfair labor practice charge (C case)'
            : type && type.startsWith('R')
              ? 'Representation / election petition (R case)'
              : null,
        date_filed: caseFields['Date Filed'] ?? null,
        status: caseFields['Status'] ?? null,
        location: caseFields['Location'] ?? null,
        region: caseFields['Region Assigned'] ?? null,
        number_of_employees: caseFields['No. of Employees'] ?? null,
        unit_description: caseFields['Unit Description'] ?? null,
        allegations: allegations ?? [],
        allegations_note:
          allegations && allegations.length === 0
            ? 'No allegations are published for this case. Representation (R) petitions carry no allegations, and some charges have none listed.'
            : undefined,
        election_tally: Object.keys(tallyFields).length ? tallyFields : null,
        participants: parseParticipants(html),
        docket_activity: docket,
        docket_activity_note: docket.length
          ? 'The docket activity list does not reflect all actions in a case, and the page shows only the most recent entries.'
          : undefined,
        url,
        source: 'National Labor Relations Board case docket (nlrb.gov)',
      };
    }

    case 'nlrb_recent_filings': {
      const days = clampInt(args.days, 1, 365, 7);
      const limit = clampInt(args.limit, 1, 50, 25);
      const region = typeof args.region === 'string' && args.region.trim() ? args.region.trim().padStart(2, '0') : null;
      const dateStart = daysAgoUs(days);
      const dateEnd = daysAgoUs(0);
      const res = await runSearch({
        term: 'all',
        caseType: normalizeCaseType(args.case_type),
        status: normalizeStatus(args.status),
        region,
        dateStart,
        dateEnd,
        sort: 'desc',
        rows: limit,
      });
      if (!res.ok) return { found: false, reason: res.reason, hint: res.hint };
      if (!res.rows.length) {
        return {
          found: false,
          reason: 'no_matches',
          window_days: days,
          hint: `No NLRB cases were filed in the last ${days} days with the filters given. Widen days, or drop case_type/region.`,
          source: 'National Labor Relations Board case search (nlrb.gov)',
        };
      }
      return {
        found: true,
        window_days: days,
        filed_from: dateStart,
        filed_to: dateEnd,
        total_filed_in_window: res.total,
        returned: res.rows.length,
        cases: res.rows,
        source: 'National Labor Relations Board case search (nlrb.gov)',
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
