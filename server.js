const express = require("express");
const cheerio = require("cheerio");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

const FETCH_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB cap, so we never buffer something huge
const USER_AGENT = "URL-Auditor/1.0 (+https://github.com/) Mozilla/5.0";

app.use(express.json());
app.use(express.static("public"));

/**
 * Validates that the input is a well-formed, publicly-fetchable http(s) URL.
 * Returns { ok: true, url } or { ok: false, error }.
 */
function validateUrl(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "Please enter a URL." };
  }

  let candidate = raw.trim();
  // Only add a scheme if none was given at all. If some other scheme was
  // given (ftp://, mailto:, etc.) leave it alone so it fails the protocol
  // check below with an accurate message, instead of getting mangled into
  // "https://ftp://...".
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "Only http:// and https:// URLs are supported." };
  }

  const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "::1"];
  if (blockedHosts.includes(parsed.hostname.toLowerCase())) {
    return { ok: false, error: "Local or loopback addresses aren't allowed." };
  }

  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    // Cheap guard against bare/internal-looking hostnames like "http://intranet".
    return { ok: false, error: "That URL doesn't have a valid hostname." };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * Fetches a URL with a hard timeout and a byte cap on the body.
 * Throws a labeled error the route handler turns into a clean JSON response.
 */
async function fetchWithLimits(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.8" },
    });
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error("The request timed out.");
      e.code = "TIMEOUT";
      throw e;
    }
    const e = new Error("Could not reach that URL. Check the address and try again.");
    e.code = "UNREACHABLE";
    throw e;
  } finally {
    clearTimeout(timer);
  }

  return response;
}

async function readBodyWithCap(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    // Environments without a streaming body (rare) - fall back to text().
    return response.text();
  }

  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      const e = new Error("The page is too large to audit.");
      e.code = "TOO_LARGE";
      throw e;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function buildReport(html, meta) {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim() || null;

  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    null;

  const h1Count = $("h1").length;

  const images = $("img");
  const totalImages = images.length;
  let missingAlt = 0;
  images.each((_, el) => {
    const alt = $(el).attr("alt");
    if (alt === undefined || alt.trim() === "") missingAlt += 1;
  });

  // Approximate word count from visible text: strip script/style/noscript,
  // collapse whitespace, split on it.
  $("script, style, noscript, template").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText.length === 0 ? 0 : bodyText.split(" ").length;

  return {
    url: meta.finalUrl,
    redirected: meta.redirected,
    statusCode: meta.statusCode,
    responseTimeMs: meta.responseTimeMs,
    contentType: meta.contentType,
    title,
    metaDescription,
    h1Count,
    images: {
      total: totalImages,
      missingAlt,
    },
    wordCount,
  };
}

app.post("/api/audit", async (req, res) => {
  const check = validateUrl(req.body?.url);
  if (!check.ok) {
    return res.status(400).json({ error: check.error });
  }

  const started = Date.now();
  let response;
  try {
    response = await fetchWithLimits(check.url);
  } catch (err) {
    const status = err.code === "TIMEOUT" ? 504 : 502;
    return res.status(status).json({ error: err.message });
  }

  const responseTimeMs = Date.now() - started;
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.toLowerCase().includes("text/html")) {
    return res.status(415).json({
      error: `That URL returned "${contentType.split(";")[0] || "an unknown content type"}", not an HTML page, so there's nothing to audit.`,
      statusCode: response.status,
      responseTimeMs,
    });
  }

  if (!response.ok) {
    // Still try to parse it - a 404 page is still HTML worth reporting on -
    // but flag the status clearly for the caller.
  }

  let html;
  try {
    html = await readBodyWithCap(response);
  } catch (err) {
    const status = err.code === "TOO_LARGE" ? 413 : 502;
    return res.status(status).json({ error: err.message });
  }

  let report;
  try {
    report = buildReport(html, {
      finalUrl: response.url || check.url,
      redirected: response.redirected,
      statusCode: response.status,
      responseTimeMs,
      contentType: contentType.split(";")[0],
    });
  } catch (err) {
    return res.status(500).json({ error: "Could not parse the page's HTML." });
  }

  return res.json(report);
});

// Catch-all JSON 404 for unknown API routes (keeps errors consistent, no HTML crash pages)
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Unknown API route." });
});

// Never let an unexpected error crash the process or leak a stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

app.listen(PORT, () => {
  console.log(`URL Auditor running on http://localhost:${PORT}`);
});
