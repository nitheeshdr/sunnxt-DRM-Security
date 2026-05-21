import { type NextRequest, NextResponse } from "next/server";
import { getSunnxtCookies } from "@/lib/sunnxt-session";
import { DEFAULT_HEADERS } from "@/lib/api";

const ALLOWED_HOSTS = [
  "livestream.sunnxt.com",
  "suntvvod1.sunnxt.com",
  "sunnxt.com",        // matches *.sunnxt.com
  "akamaized.net",     // checked together with suntvvod guard below
];

// Inject a <BaseURL> into an MPD so Shaka resolves relative segment paths
// against the original upstream domain.  The request filter in the player then
// catches those resolved URLs (they contain the blocked domain) and re-routes
// them through this proxy.  This is safer than rewriting SegmentTemplate
// media= attributes because those contain $Number$/$Time$ tokens that Shaka
// must expand itself.
function rewriteMpd(xml: string, manifestUrl: string): string {
  const baseDir = manifestUrl.substring(0, manifestUrl.lastIndexOf("/") + 1);
  const baseUrlTag = `<BaseURL>${baseDir}</BaseURL>`;

  // Prefer to insert right after the opening <MPD …> tag.
  // If no match (malformed MPD), prepend the tag at the top.
  if (/<MPD[^>]*>/.test(xml)) {
    return xml.replace(/(<MPD[^>]*>)/, `$1\n  ${baseUrlTag}`);
  }
  return `${baseUrlTag}\n${xml}`;
}

// Rewrite an HLS manifest: make every URI / segment line absolute+proxied.
// HLS doesn't have a template-variable system so full rewriting is safe.
function rewriteM3u8(text: string, manifestUrl: string): string {
  const baseDir = manifestUrl.substring(0, manifestUrl.lastIndexOf("/") + 1);

  function resolveAndProxy(href: string): string {
    try {
      // Already absolute
      const abs = new URL(href).href;
      return `/api/stream-proxy?url=${encodeURIComponent(abs)}`;
    } catch {
      return `/api/stream-proxy?url=${encodeURIComponent(new URL(href, baseDir).href)}`;
    }
  }

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_, val) => `URI="${resolveAndProxy(val)}"`);
      }
      if (trimmed && !trimmed.startsWith("#")) {
        return resolveAndProxy(trimmed);
      }
      return line;
    })
    .join("\n");
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("Missing url", { status: 400 });

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }

  const allowed =
    ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`)) &&
    // For akamaized.net, only allow SunNXT VOD subdomains (e.g. movies2-suntvvod.akamaized.net)
    (hostname.endsWith(".akamaized.net") ? hostname.includes("suntvvod") : true);

  if (!allowed) {
    return new NextResponse("Domain not allowed", { status: 403 });
  }

  try {
    const cookie = await getSunnxtCookies().catch(() => "");
    const upstream = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        ...(cookie ? { cookie } : {}),
      },
    });

    if (!upstream.ok) {
      console.error(`stream-proxy: ${upstream.status} ${upstream.statusText} for ${url}`);
      return new NextResponse(null, { status: upstream.status });
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const cacheControl = upstream.headers.get("cache-control") ?? "no-cache";

    const isMpd =
      contentType.includes("dash+xml") ||
      contentType.includes("mpd") ||
      url.split("?")[0].endsWith(".mpd");

    const isM3u8 =
      contentType.includes("mpegurl") ||
      url.split("?")[0].endsWith(".m3u8");

    if (isMpd) {
      const xml = await upstream.text();
      const rewritten = rewriteMpd(xml, url);
      console.log(`stream-proxy: MPD rewrite for ${url.split("?")[0]}, injected BaseURL`);
      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          "content-type": "application/dash+xml",
          "access-control-allow-origin": "*",
          "cache-control": cacheControl,
        },
      });
    }

    if (isM3u8) {
      const text = await upstream.text();
      const rewritten = rewriteM3u8(text, url);
      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          "access-control-allow-origin": "*",
          "cache-control": cacheControl,
        },
      });
    }

    // Binary video segments — stream directly without buffering
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "access-control-allow-origin": "*",
        "cache-control": cacheControl,
      },
    });
  } catch (e) {
    console.error("Stream proxy error:", e);
    return new NextResponse("Proxy error", { status: 500 });
  }
}
