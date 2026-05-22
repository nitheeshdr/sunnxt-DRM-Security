import { type NextRequest, NextResponse } from "next/server";
import CryptoJS from "crypto-js";
import { getSunnxtCookies, invalidateSession, forceRelogin } from "@/lib/sunnxt-session";
import {
  extractAndCacheHdntl,
  learnUuidsFromEntries,
  buildBypassEntries,
  type VideoEntry,
} from "@/lib/cdn-bypass";

const FIELDS = "contents,user/currentdata,images,generalInfo,subtitles,relatedCast,globalServiceName,globalServiceId,relatedMedia,videos,thumbnailSeekPreview";
const MEDIA_KEY = "A3s68aORSgHs$71P";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

async function fetchMedia(contentId: string, cookieHeader: string) {
  const url = `https://www.sunnxt.com/next/api/media/${contentId}?playbackCounter=1&fields=${FIELDS}&bw=5000000&nid=4`;
  return fetch(url, {
    headers: {
      "x-myplex-platform": "browser",
      "x-ucv": "5",
      origin: "https://www.sunnxt.com",
      referer: "https://www.sunnxt.com/",
      "user-agent": UA,
      cookie: cookieHeader,
    },
    cache: "no-store",
  });
}

async function fetchMediaViaContentDetail(contentId: string, cookieHeader: string) {
  const fields = "contents,user/currentdata,images,generalInfo,subtitles,relatedCast,globalServiceName,globalServiceId,relatedMedia,videos,thumbnailSeekPreview";
  const url = `https://pwaapi.sunnxt.com/content/v3/contentDetail/${contentId}/?level=devicemax&fields=${fields}&bw=5000000&nid=4&playbackCounter=1`;
  return fetch(url, {
    headers: {
      "x-myplex-platform": "browser",
      "x-ucv": "5",
      contentlanguage: "tamil,telugu,malayalam,kannada,hindi,bengali,marathi,english",
      origin: "https://www.sunnxt.com",
      referer: "https://www.sunnxt.com/",
      "user-agent": UA,
      accept: "*/*",
      cookie: cookieHeader,
    },
    cache: "no-store",
  });
}

function decrypt(response: string) {
  const keyWA = CryptoJS.enc.Utf8.parse(MEDIA_KEY);
  const iv = CryptoJS.enc.Hex.parse("00000000000000000000000000000000");
  const bytes = CryptoJS.AES.decrypt(response, keyWA, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const hex = bytes.toString(CryptoJS.enc.Hex);
  return JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
}

function hasVideos(data: Record<string, unknown>): boolean {
  const results = data.results as Array<Record<string, unknown>> | undefined;
  return !!(results?.[0]?.videos as { values?: unknown[] } | undefined)?.values?.length;
}

function getVideosError(data: Record<string, unknown>): string | null {
  const results = data.results as Array<Record<string, unknown>> | undefined;
  const videos = results?.[0]?.videos as Record<string, unknown> | undefined;
  if (videos?.status && !videos?.values) {
    return (videos.message as string) || "Video is not available";
  }
  return null;
}

function normalizeVideos(data: Record<string, unknown>): void {
  const results = data.results as Array<Record<string, unknown>> | undefined;
  const videos = results?.[0]?.videos as { values?: Array<Record<string, unknown>> } | undefined;
  if (!videos?.values) return;

  videos.values = videos.values.map((v) => {
    const link = v.link as string | undefined;
    if (link && !link.startsWith("http") && !link.startsWith("/")) {
      return { ...v, link: `https://suntvvod1.sunnxt.com/${link}` };
    }
    return v;
  });
}

function getRoamingError(data: Record<string, unknown>): string | null {
  const results = data.results as Array<Record<string, unknown>> | undefined;
  const r0 = results?.[0];
  if (r0?.blocked_reason || r0?.notify_type === "error_notify") {
    return (r0.title as string) || (r0.p1 as string) || "Content blocked";
  }
  return null;
}

/** After a successful media response, harvest hdntl + learn UUIDs for future bypass use. */
function harvestBypassData(contentId: string, data: Record<string, unknown>): void {
  const results = data.results as Array<Record<string, unknown>> | undefined;
  const vals = (results?.[0]?.videos as { values?: VideoEntry[] } | undefined)?.values;
  if (!vals?.length) return;
  extractAndCacheHdntl(vals);
  learnUuidsFromEntries(contentId, vals);
}

/** Build a minimal API-shaped response wrapping bypass video entries. */
function buildBypassResponse(
  contentId: string,
  entries: VideoEntry[],
  originalData: Record<string, unknown>
): Record<string, unknown> {
  // Graft bypass entries onto the original metadata (title, images, etc.)
  // so the player page can show content info alongside the stream.
  const results = (originalData.results as Array<Record<string, unknown>> | undefined) ?? [];
  const r0: Record<string, unknown> = results[0] ? { ...results[0] } : { _id: contentId };
  r0.videos = { values: entries };
  return { ...originalData, code: 200, results: [r0] };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ contentId: string }> }
) {
  const { contentId } = await params;
  const browserCookie = request.headers.get("cookie") || "";

  let cookieHeader = browserCookie;
  const hasBrowserSession = cookieHeader.includes("sessionid");
  if (!hasBrowserSession) {
    try {
      cookieHeader = await getSunnxtCookies();
    } catch {
      // No server credentials — user must be logged in via the login page
    }
  }

  // No session at all — tell the player to prompt login
  const hasSession = cookieHeader.includes("sessionid");
  if (!hasSession) {
    return NextResponse.json(
      { code: 401, error: "login_required", message: "Please log in to watch this content." },
      { status: 401 }
    );
  }

  try {
    let res = await fetchMedia(contentId, cookieHeader);
    let raw = await res.json() as Record<string, unknown>;

    let data: Record<string, unknown> = raw;
    if (raw.response) {
      try { data = decrypt(raw.response as string); } catch { data = raw; }
    }

    const videosErr = getVideosError(data);
    if (videosErr) {
      console.log(`media/${contentId}: browser session blocked (${videosErr})`);

      // --- Bypass attempt 1: retry with server subscribed credentials ---
      // When the browser's unsubscribed session hits the paywall, fall back to
      // the server's .env credentials which have a valid subscription.
      // This makes all content accessible to any logged-in browser user.
      if (process.env.SUNNXT_USERID) {
        try {
          const serverCookie = await getSunnxtCookies();
          if (serverCookie !== cookieHeader) {
            console.log(`media/${contentId}: retrying with server subscribed session`);
            const serverRes = await fetchMedia(contentId, serverCookie);
            const serverRaw = await serverRes.json() as Record<string, unknown>;
            let serverData: Record<string, unknown> = serverRaw;
            if (serverRaw.response) {
              try { serverData = decrypt(serverRaw.response as string); } catch { serverData = serverRaw; }
            }
            if (hasVideos(serverData)) {
              console.log(`media/${contentId}: server session bypass succeeded`);
              harvestBypassData(contentId, serverData);
              normalizeVideos(serverData);
              return NextResponse.json(serverData);
            }
          }
        } catch (e) {
          console.warn(`media/${contentId}: server session retry failed:`, e);
        }
      }

      // --- Bypass attempt 2: pwaapi contentDetail ---
      try {
        const bypassRes = await fetchMediaViaContentDetail(contentId, cookieHeader);
        const bypassRaw = await bypassRes.json() as Record<string, unknown>;
        let bypassData: Record<string, unknown> = bypassRaw;
        if (bypassRaw.response) {
          try { bypassData = decrypt(bypassRaw.response as string); } catch { bypassData = bypassRaw; }
        }
        if (hasVideos(bypassData)) {
          console.log(`media/${contentId}: pwaapi contentDetail bypass succeeded`);
          harvestBypassData(contentId, bypassData);
          normalizeVideos(bypassData);
          return NextResponse.json(bypassData);
        }
      } catch (e) {
        console.warn(`media/${contentId}: contentDetail bypass error:`, e);
      }

      // --- Bypass attempt 3: CDN UUID + hdntl wildcard token ---
      // Uses the content UUID from the database + a cached Akamai hdntl token
      // (acl=/*, 24h TTL) harvested from a previous successful media call.
      // DRM license via pwaapi modularLicense — no subscription check (VULN-11).
      const bypassEntries = buildBypassEntries(contentId);
      if (bypassEntries) {
        console.log(`media/${contentId}: CDN UUID+hdntl bypass succeeded`);
        const bypassResponse = buildBypassResponse(contentId, bypassEntries, data);
        return NextResponse.json(bypassResponse);
      }

      console.log(`media/${contentId}: all bypass attempts exhausted`);
      return NextResponse.json(
        { code: 404, error: "video_unavailable", message: videosErr },
        { status: 404 }
      );
    }

    const isRoaming = getRoamingError(data) !== null;
    const needsRetry =
      isRoaming ||
      data.code === 401 ||
      data.code === 403 ||
      (data.code === 200 && !hasVideos(data));

    if (needsRetry) {
      try {
        cookieHeader = isRoaming
          ? await forceRelogin()
          : await (invalidateSession(), getSunnxtCookies());
      } catch (e) {
        console.error("Re-login failed:", e);
        return NextResponse.json({ code: 401, error: "Session refresh failed" }, { status: 401 });
      }
      res = await fetchMedia(contentId, cookieHeader);
      raw = await res.json() as Record<string, unknown>;
      data = raw;
      if (raw.response) {
        try { data = decrypt(raw.response as string); } catch { data = raw; }
      }

      const roamingError2 = getRoamingError(data);
      if (roamingError2) {
        const r0 = (data.results as Array<Record<string, unknown>>)[0];
        return NextResponse.json({
          code: 451,
          error: "geo_blocked",
          title: r0.title,
          message: `${r0.p1 || ""} ${r0.p2 || ""}`.trim(),
          blocked_reason: r0.blocked_reason,
        }, { status: 451 });
      }
    }

    // Harvest bypass data from every successful response so future
    // subscription-locked requests can reuse the hdntl + learned UUIDs.
    harvestBypassData(contentId, data);
    normalizeVideos(data);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to fetch media" }, { status: 500 });
  }
}
