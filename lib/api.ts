import { getSunnxtCookies } from "@/lib/sunnxt-session";

const API_BASE = "https://pwaapi.sunnxt.com";
const LANGUAGES = "tamil,telugu,malayalam,kannada,hindi,bengali,marathi,english";

export const DEFAULT_HEADERS: HeadersInit = {
  "x-myplex-platform": "browser",
  "x-ucv": "5",
  contentlanguage: LANGUAGES,
  origin: "https://www.sunnxt.com",
  referer: "https://www.sunnxt.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  accept: "*/*",
  "accept-language": "en",
};

export async function fetchApi<T>(
  path: string,
  options: RequestInit = {},
  cookieHeader?: string
): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  // Use provided cookie; if it has no sessionid, inject the server-side session
  let cookie = cookieHeader ?? "";
  if (!cookie.includes("sessionid")) {
    try {
      cookie = await getSunnxtCookies();
    } catch {
      // proceed without session — public endpoints still work
    }
  }

  const headers: HeadersInit = {
    ...DEFAULT_HEADERS,
    ...(cookie ? { cookie } : {}),
    ...options.headers,
  };
  const res = await fetch(url, {
    ...options,
    headers,
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${url}`);
  return res.json();
}

export async function getNavMenu() {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/_info?group=navMenuPortal&language=${LANGUAGES}`
  );
}

export async function getHomeCarouselInfo() {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/_info?group=portalHome&language=${LANGUAGES}`
  );
}

export async function getMovieCarouselInfo() {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/_info?group=portalMovies&language=${LANGUAGES}`
  );
}

export async function getTvCarouselInfo() {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/_info?group=portalTvShows&language=${LANGUAGES}`
  );
}

export async function getLiveCarouselInfo() {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/_info?group=liveTvPortal&language=${LANGUAGES}`
  );
}

export async function getLiveChannels(count = 60) {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/liveChannels?&level=devicemax&startIndex=1&count=${count}&contentlang=${LANGUAGES}`
  );
}

export async function getFreeCarouselInfo() {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/_info?group=portalComedies&language=${LANGUAGES}`
  );
}

export async function getMusicCarouselInfo() {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/_info?group=portalMusicVideo&language=${LANGUAGES}`
  );
}

export async function getShortsCarouselInfo() {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/_info?group=portalShorts&language=${LANGUAGES}`
  );
}

export async function getCarouselItems(
  name: string,
  count = 20,
  cookieHeader?: string
) {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/${name}?&level=devicemax&startIndex=1&count=${count}&contentlang=${LANGUAGES}`,
    {},
    cookieHeader
  );
}

export async function getContentDetail(id: string, cookieHeader?: string) {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v3/contentDetail/${id}/?level=devicemax&fields=contents,user%2Fcurrentdata,images,generalInfo,subtitles,relatedCast,globalServiceName,globalServiceId,relatedMedia,thumbnailSeekPreview,tags,publishingHouse`,
    {},
    cookieHeader
  );
}

export async function getSimilarContent(id: string) {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/similar/${id}/`
  );
}

export async function searchContent(query: string) {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v3/search/?fields=images,generalInfo,globalServiceId,publishingHouse,relatedCast,contents&level=dynamic&query=${encodeURIComponent(query)}&startIndex=1&count=30&searchFields=title&publishingHouseId=&languageFilters=`
  );
}

export async function getTrendingSearch() {
  return fetchApi<{ code: number; results: unknown[] }>(
    `/content/v2/carousel/TrendingSearch?&level=devicemax&startIndex=1&count=20&contentlang=${LANGUAGES}`
  );
}

export async function checkAccountStatus(userid: string) {
  return fetchApi<{
    code: number;
    status: string;
    login_account_type: string;
    password_available: boolean;
    user_available: boolean;
    subscription_status: string;
    partner_id: string;
  }>(`/user/v2/userAccountStatus/?userid=${encodeURIComponent(userid)}`);
}

export function getImageUrl(
  images: { values: Array<{ type: string; profile: string; link: string }> } | undefined,
  type = "preview",
  preferProfile = "xhdpi"
): string | null {
  if (!images?.values?.length) return null;
  const typeImages = images.values.filter((img) => img.type === type);
  if (!typeImages.length) {
    // fallback: any image
    return images.values[0]?.link ?? null;
  }
  const preferred = typeImages.find((img) => img.profile === preferProfile);
  if (preferred) return preferred.link;
  const fallbacks = ["xxhdpi", "xhdpi", "hdpi", "mdpi", "ldpi"];
  for (const p of fallbacks) {
    const found = typeImages.find((img) => img.profile === p);
    if (found) return found.link;
  }
  return typeImages[0]?.link ?? null;
}
