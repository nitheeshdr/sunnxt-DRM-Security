import { type NextRequest, NextResponse } from "next/server";
import { getSunnxtCookies } from "@/lib/sunnxt-session";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const CDN_HEADERS = {
  "user-agent": UA,
  origin: "https://www.sunnxt.com",
  referer: "https://www.sunnxt.com/",
};

interface SegmentInfo {
  initUrl: string;
  segmentUrls: string[];
  codec: string;
  bandwidth: number;
  width: number;
  height: number;
  durationSec: number;
}

// Parse a DASH MPD and return segment URLs for the highest-quality track.
// Handles SegmentTemplate + SegmentTimeline. BaseURL is resolved at MPD/AdaptationSet level.
function parseMpdTrack(
  mpdXml: string,
  mpdBaseDir: string,
  qs: string,
  mimeType: "video" | "audio",
): SegmentInfo | null {
  // Resolve a segment path against a base dir, appending the auth query string
  const resolveUrl = (path: string, base: string): string =>
    path.startsWith("http") ? path + qs : base + path + qs;

  // MPD-level BaseURL (may be injected by stream-proxy or present natively)
  const mpdBase = (() => {
    const m = mpdXml.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);
    const v = m?.[1]?.trim() ?? "";
    return v.startsWith("http") ? v : v ? mpdBaseDir + v : mpdBaseDir;
  })();

  // Period duration in seconds — used when SegmentTemplate has @duration but no SegmentTimeline
  const periodDuration = (() => {
    const pt =
      mpdXml.match(/mediaPresentationDuration="([^"]+)"/i)?.[1] ||
      mpdXml.match(/<Period\b[^>]*\sduration="([^"]+)"/i)?.[1] || "";
    const m = pt.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/i);
    if (!m) return 0;
    return (parseInt(m[1] ?? "0") * 3600) + (parseInt(m[2] ?? "0") * 60) + parseFloat(m[3] ?? "0");
  })();

  let best: SegmentInfo | null = null;

  for (const adaptMatch of mpdXml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    const adaptAttrs = adaptMatch[1];
    const adaptBody  = adaptMatch[2];

    // mimeType check — look in attrs and anywhere in the body
    const mimeRaw =
      adaptAttrs.match(/mimeType="([^"]+)"/i)?.[1] ||
      adaptAttrs.match(/contentType="([^"]+)"/i)?.[1] ||
      adaptBody.match(/mimeType="([^"]+)"/i)?.[1] ||
      adaptBody.match(/contentType="([^"]+)"/i)?.[1] || "";
    if (!mimeRaw || !mimeRaw.toLowerCase().startsWith(mimeType)) continue;

    // AdaptationSet-level BaseURL
    const adaptBase = (() => {
      const m = adaptBody.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);
      const v = m?.[1]?.trim() ?? "";
      return v.startsWith("http") ? v : v ? mpdBase + v : mpdBase;
    })();

    // Shared SegmentTemplate attributes (at AdaptationSet level)
    // Match both <SegmentTemplate .../> and <SegmentTemplate ...>
    const tmplRaw = adaptBody.match(/<SegmentTemplate\b([^>]*)/i)?.[1] ?? "";
    const sharedInit  = tmplRaw.match(/initialization="([^"]+)"/i)?.[1] ?? "init.mp4";
    const sharedMedia = tmplRaw.match(/\bmedia="([^"]+)"/i)?.[1] ?? "";
    const sharedStart = parseInt(tmplRaw.match(/startNumber="(\d+)"/i)?.[1] ?? "1");
    const timescale   = parseInt(tmplRaw.match(/timescale="(\d+)"/i)?.[1] ?? "1");
    const tmplDur     = parseInt(tmplRaw.match(/\bduration="(\d+)"/i)?.[1] ?? "0");

    // Segment count from SegmentTimeline
    // Match <S .../> AND <S ...> (with or without self-close slash, with or without space)
    const tlBody = adaptBody.match(/<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i)?.[1] ?? "";
    let segCount = 0, totalTicks = 0;
    for (const s of tlBody.matchAll(/<S\b([^>]*)/gi)) {
      const a = s[1];
      const d = parseInt(a.match(/\bd="(\d+)"/i)?.[1] ?? "0");
      const r = parseInt(a.match(/\br="(\d+)"/i)?.[1] ?? "0");
      segCount  += r + 1;
      totalTicks += d * (r + 1);
    }

    // Fallback: derive count from @duration + period duration
    if (segCount === 0 && tmplDur > 0 && periodDuration > 0) {
      segCount = Math.ceil(periodDuration * timescale / tmplDur);
      totalTicks = segCount * tmplDur;
    }
    if (segCount === 0) continue;

    const durationSec = totalTicks / (timescale || 1);

    // Find highest-bandwidth Representation (only need opening tag attrs)
    let bestBw = 0;
    let bestRepId = "";
    let bestCodec = "";
    let bestWidth = 0;
    let bestHeight = 0;

    for (const repM of adaptBody.matchAll(/<Representation\b([^>]*)/gi)) {
      const ra = repM[1];
      const bw = parseInt(ra.match(/bandwidth="(\d+)"/i)?.[1] ?? "0");
      if (bw <= bestBw) continue;
      bestBw     = bw;
      bestRepId  = ra.match(/\bid="([^"]+)"/i)?.[1] ?? "";
      bestCodec  = ra.match(/codecs="([^"]+)"/i)?.[1] ?? "";
      bestWidth  = parseInt(ra.match(/width="(\d+)"/i)?.[1] ?? "0");
      bestHeight = parseInt(ra.match(/height="(\d+)"/i)?.[1] ?? "0");
    }
    if (bestBw === 0) continue;

    const expand = (tpl: string, num?: number) =>
      tpl
        .replace(/\$Bandwidth\$/g, String(bestBw))
        .replace(/\$RepresentationID\$/g, bestRepId)
        .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) =>
          num === undefined
            ? "0"
            : pad ? String(num).padStart(parseInt(pad), "0") : String(num)
        );

    const initUrl    = resolveUrl(expand(sharedInit), adaptBase);
    const segmentUrls = Array.from({ length: segCount }, (_, i) =>
      resolveUrl(expand(sharedMedia, sharedStart + i), adaptBase)
    );

    if (!best || bestBw > best.bandwidth) {
      best = {
        initUrl, segmentUrls,
        codec: bestCodec, bandwidth: bestBw,
        width: bestWidth, height: bestHeight,
        durationSec,
      };
    }
  }

  return best;
}

async function fetchBytes(url: string, cookie?: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { ...CDN_HEADERS, ...(cookie ? { cookie } : {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url.split("?")[0].split("/").pop()}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ contentId: string }> }
) {
  const { contentId } = await params;
  const wantStream = request.nextUrl.searchParams.get("stream") === "1";
  const track = (request.nextUrl.searchParams.get("track") ?? "video") as "video" | "audio";
  const debug = request.nextUrl.searchParams.get("debug");

  // --- Fetch media info via our own /api/media route (handles bypass/auth) ---
  const origin = new URL(request.url).origin;
  const mediaRes = await fetch(`${origin}/api/media/${contentId}`, { cache: "no-store" });
  if (!mediaRes.ok) {
    return NextResponse.json({ error: "Media API unavailable" }, { status: mediaRes.status });
  }
  const data = await mediaRes.json();

  if (!data.results?.[0]?.videos?.values?.length) {
    return NextResponse.json({ error: "No streams found for this content" }, { status: 404 });
  }

  type VideoEntry = { link: string; licenseUrl?: string; format: string };
  const videos: VideoEntry[] = data.results[0].videos.values;
  const title: string =
    data.results?.[0]?.generalInfo?.title ||
    data.results?.[0]?.globalServiceName ||
    data.results?.[0]?.title ||
    contentId;

  // Prefer unencrypted DASH, then encrypted DASH (downloads encrypted segments for research)
  const clearDash = videos.find((v) => v.format === "dash" && !v.licenseUrl);
  const encDash =
    videos.find((v) => v.format === "dash" && v.licenseUrl) ||
    videos.find((v) => v.format === "dash-cenc");
  const target = clearDash || encDash;

  if (!target) {
    return NextResponse.json(
      {
        error: "No DASH stream available — only HLS formats found",
        formats: videos.map((v) => v.format),
      },
      { status: 404 }
    );
  }

  const isEncrypted = !clearDash;
  const safeName = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, "_").slice(0, 80);

  // --- Info-only response (no stream param) ---
  if (!wantStream) {
    return NextResponse.json({
      title,
      contentId,
      encrypted: isEncrypted,
      format: target.format,
      mpdUrl: target.link,
      licenseUrl: target.licenseUrl ?? null,
      videoDownloadUrl: `${origin}/api/download/video/${contentId}?stream=1&track=video`,
      audioDownloadUrl: `${origin}/api/download/video/${contentId}?stream=1&track=audio`,
      note: isEncrypted
        ? "Segments are Widevine CENC encrypted. Decryption requires a content key (obtainable via /api/license)."
        : "Clear DASH stream — segments are unencrypted and directly playable.",
    });
  }

  // --- Fetch the MPD manifest ---
  const cookie = await getSunnxtCookies().catch(() => "");
  const mpdRes = await fetch(target.link, {
    headers: { ...CDN_HEADERS, ...(cookie ? { cookie } : {}) },
    cache: "no-store",
  });
  if (!mpdRes.ok) {
    return NextResponse.json(
      { error: `Manifest fetch failed: HTTP ${mpdRes.status}`, mpdUrl: target.link },
      { status: 502 }
    );
  }
  const mpdXml = await mpdRes.text();

  // --- Debug mode: return raw MPD so the structure can be inspected ---
  if (debug === "mpd") {
    return new NextResponse(mpdXml, {
      headers: { "content-type": "application/dash+xml; charset=utf-8" },
    });
  }

  // Extract base dir and query string from the MPD URL
  const rawMpdUrl = target.link;
  const mpdBaseDir = rawMpdUrl.split("?")[0].replace(/\/[^/]+$/, "/");
  const qs = rawMpdUrl.includes("?") ? rawMpdUrl.slice(rawMpdUrl.indexOf("?")) : "";

  const segInfo = parseMpdTrack(mpdXml, mpdBaseDir, qs, track);

  if (!segInfo || segInfo.segmentUrls.length === 0) {
    // Log enough of the MPD to diagnose the parse failure
    const adaptSets = [...mpdXml.matchAll(/<AdaptationSet\b([^>]*)/gi)].map((m) => m[1].trim().slice(0, 120));
    const tmplAttrs = [...mpdXml.matchAll(/<SegmentTemplate\b([^>]*)/gi)].map((m) => m[1].trim().slice(0, 120));
    console.error(
      `Download ${contentId}: MPD parse failed for track=${track}\n`,
      `  adaptationSets: ${JSON.stringify(adaptSets)}\n`,
      `  segmentTemplates: ${JSON.stringify(tmplAttrs)}\n`,
      `  mpdUrl: ${rawMpdUrl.split("?")[0]}`
    );
    return NextResponse.json(
      {
        error: `No ${track} segments found in manifest`,
        hint: `Call with ?stream=1&debug=mpd to inspect the raw manifest`,
        adaptationSets: adaptSets,
        segmentTemplates: tmplAttrs,
      },
      { status: 404 }
    );
  }

  const filename = `${safeName}_${track}_${segInfo.width > 0 ? `${segInfo.height}p` : "audio"}.mp4`;
  const durationMin = Math.round(segInfo.durationSec / 60);
  console.log(
    `Download: ${contentId} "${title}" — ${track} ${segInfo.width}x${segInfo.height} ` +
    `${Math.round(segInfo.bandwidth / 1000)}kbps · ${segInfo.segmentUrls.length} segs · ` +
    `~${durationMin}min · encrypted=${isEncrypted}`
  );

  // Stream segments: init.mp4 followed by all media segments.
  // Result is a valid fragmented MP4 (fMP4/CMAF). For encrypted content,
  // segments are CENC-encrypted and need the AES content key to decode.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  (async () => {
    try {
      const initBytes = await fetchBytes(segInfo.initUrl, cookie);
      await writer.write(initBytes);

      for (let i = 0; i < segInfo.segmentUrls.length; i++) {
        const segBytes = await fetchBytes(segInfo.segmentUrls[i], cookie);
        await writer.write(segBytes);
        if ((i + 1) % 50 === 0) {
          console.log(`Download ${contentId}: ${i + 1}/${segInfo.segmentUrls.length} segments`);
        }
      }
      await writer.close();
      console.log(`Download ${contentId}: complete — ${segInfo.segmentUrls.length} segments`);
    } catch (e) {
      console.error(`Download ${contentId}: stream error —`, e);
      await writer.abort(e);
    }
  })();

  return new Response(readable as ReadableStream, {
    headers: {
      "content-type": "video/mp4",
      "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      "x-encrypted": String(isEncrypted),
      "x-segments": String(segInfo.segmentUrls.length),
      "x-duration-sec": String(Math.round(segInfo.durationSec)),
      "x-resolution": segInfo.width > 0 ? `${segInfo.width}x${segInfo.height}` : "audio",
    },
  });
}
