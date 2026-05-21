import { type NextRequest, NextResponse } from "next/server";
import CryptoJS from "crypto-js";
import { getSunnxtCookies, invalidateSession } from "@/lib/sunnxt-session";

const FIELDS = "contents,user/currentdata,images,generalInfo,subtitles,relatedCast,globalServiceName,globalServiceId,relatedMedia,videos,thumbnailSeekPreview";
const MEDIA_KEY = "A3s68aORSgHs$71P";

async function fetchMedia(contentId: string, cookieHeader: string) {
  const url = `https://www.sunnxt.com/next/api/media/${contentId}?playbackCounter=1&fields=${FIELDS}`;
  return fetch(url, {
    headers: {
      "x-myplex-platform": "browser",
      "x-ucv": "5",
      origin: "https://www.sunnxt.com",
      referer: "https://www.sunnxt.com/",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
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
  return (results?.[0]?.videos as { values?: unknown[] } | undefined)?.values?.length as unknown as boolean;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ contentId: string }> }
) {
  const { contentId } = await params;
  const browserCookie = request.headers.get("cookie") || "";

  let cookieHeader = browserCookie;
  if (!cookieHeader.includes("sessionid")) {
    try {
      cookieHeader = await getSunnxtCookies();
    } catch {
      // proceed without session
    }
  }

  try {
    let res = await fetchMedia(contentId, cookieHeader);
    let raw = await res.json() as Record<string, unknown>;

    // Decrypt if encrypted
    let data: Record<string, unknown> = raw;
    if (raw.response) {
      try { data = decrypt(raw.response as string); } catch { data = raw; }
    }

    // SunNXT returns code:200 but empty videos when session is missing/expired.
    // Treat 0 videos the same as 401 — force a fresh login and retry once.
    const needsRetry =
      data.code === 401 ||
      data.code === 403 ||
      (data.code === 200 && !hasVideos(data));

    if (needsRetry) {
      invalidateSession();
      try {
        cookieHeader = await getSunnxtCookies();
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
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to fetch media" }, { status: 500 });
  }
}
