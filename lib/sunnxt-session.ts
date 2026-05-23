import CryptoJS from "crypto-js";

const MEDIA_KEY = "A3s68aORSgHs$71P";

const LOGIN_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  "x-myplex-platform": "browser",
  "x-ucv": "5",
  origin: "https://www.sunnxt.com",
  referer: "https://www.sunnxt.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

// Module-level session cache — persists across requests within a server process
let cachedCookies = "";
let loginPromise: Promise<string> | null = null;

function encryptPayload(obj: Record<string, string>): string {
  const keyWA = CryptoJS.enc.Utf8.parse(MEDIA_KEY);
  const iv = CryptoJS.enc.Hex.parse("00000000000000000000000000000000");
  return CryptoJS.AES.encrypt(JSON.stringify(obj), keyWA, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).toString();
}

export function decryptResponse(response: string): unknown {
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

function extractCookies(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  if (raw.length) return raw.map((c) => c.split(";")[0]).join("; ");
  const single = res.headers.get("set-cookie");
  if (single) return single.split(",").map((c) => c.trim().split(";")[0]).join("; ");
  return "";
}

async function attemptLogin(): Promise<{ cookies: string; response: Record<string, unknown> }> {
  const userid = process.env.SUNNXT_USERID;
  const password = process.env.SUNNXT_PASSWORD;
  if (!userid || !password) throw new Error("SUNNXT credentials not configured in .env.local");

  const payload = encryptPayload({ userid, password });
  const res = await fetch("https://www.sunnxt.com/next/api/login", {
    method: "POST",
    headers: LOGIN_HEADERS,
    body: `payload=${encodeURIComponent(payload)}&version=1`,
    redirect: "manual",
  });

  const cookies = extractCookies(res);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    throw new Error(`SunNXT login returned non-JSON (status ${res.status}) — likely rate-limited, try again in a minute`);
  }
  const raw = await res.json() as { response?: string };
  const data = raw.response ? (decryptResponse(raw.response) as Record<string, unknown>) : raw;
  return { cookies, response: data };
}

async function removeDevice(token: string, deviceId: string): Promise<void> {
  const url = `https://api.sunnxt.com/user/v4/removeDevice/?token=${encodeURIComponent(token)}&deviceId=${deviceId}&redirectUrl=`;
  await fetch(url, {
    method: "GET",
    headers: { "user-agent": LOGIN_HEADERS["user-agent"] },
    redirect: "manual",
  });
}

async function doLogin(): Promise<string> {
  // First attempt
  const first = await attemptLogin();

  if (first.response.code === 200) {
    cachedCookies = first.cookies;
    return cachedCookies;
  }

  if (first.response.code === 423) {
    // Device limit — extract removeDevice info from the Manage Devices button
    const ui = first.response.ui as { buttons?: Array<{ action?: string; buttonAction?: string }> };
    const manageUrl = ui?.buttons?.find((b) => b.action === "webView")?.buttonAction;
    const token = manageUrl?.match(/token=([^&]+)/)?.[1];

    if (token && manageUrl) {
      // Fetch the device list webview to find registered device IDs
      const devRes = await fetch(manageUrl, {
        headers: { "user-agent": LOGIN_HEADERS["user-agent"], cookie: first.cookies },
        redirect: "manual",
      });
      const html = await devRes.text();

      // Extract all deviceId values from removeDevice links
      const deviceIds = [...html.matchAll(/removeDevice[^"']*deviceId=(\d+)/g)].map((m) => m[1]);

      if (deviceIds.length > 0) {
        // Remove the first stale device to free a slot
        await removeDevice(token, deviceIds[0]);

        // Re-attempt login now that a slot is free
        const second = await attemptLogin();
        if (second.response.code === 200) {
          cachedCookies = second.cookies;
          return cachedCookies;
        }
      }
    }

    throw new Error(`SunNXT device limit reached (423). Could not free a device slot.`);
  }

  throw new Error(`SunNXT login failed: code=${first.response.code} status=${first.response.status}`);
}

/**
 * Returns a valid SunNXT session cookie string.
 * Requires SUNNXT_USERID and SUNNXT_PASSWORD in .env.local.
 * Throws if credentials are not configured — callers should catch and
 * fall back to the browser-supplied session or proceed without auth.
 */
export async function getSunnxtCookies(): Promise<string> {
  if (!process.env.SUNNXT_USERID || !process.env.SUNNXT_PASSWORD) {
    throw new Error("SUNNXT credentials not configured — user session required");
  }
  if (cachedCookies) return cachedCookies;

  // Deduplicate concurrent login attempts
  if (!loginPromise) {
    loginPromise = doLogin().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

/** Force a fresh login on the next call (e.g. when a 401 is received). */
export function invalidateSession() {
  cachedCookies = "";
}

/**
 * Full logout + fresh login.  Used when a roaming/geo error is detected so
 * SunNXT re-evaluates the current IP and resets the roaming flag.
 */
export async function forceRelogin(): Promise<string> {
  cachedCookies = "";
  loginPromise = null;

  // Tell SunNXT to invalidate the old session
  try {
    await fetch("https://www.sunnxt.com/next/api/logout", {
      method: "POST",
      headers: LOGIN_HEADERS,
    });
  } catch { /* ignore — logout is best-effort */ }

  // Fresh login from current IP
  return getSunnxtCookies();
}
