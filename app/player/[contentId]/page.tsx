"use client";

import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import { getImageUrl } from "@/lib/api";
import type { ContentItem } from "@/types";

interface VideoEntry {
  link: string;
  licenseUrl?: string;
  format: string;
  profile: string;
  resolution?: string;
}

interface Props {
  params: Promise<{ contentId: string }>;
}

export default function PlayerPage({ params }: Props) {
  const [contentId, setContentId] = useState("");
  const [item, setItem] = useState<ContentItem | null>(null);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isGeoBlocked, setIsGeoBlocked] = useState(false);
  const [downloadInfo, setDownloadInfo] = useState<{
    encrypted: boolean;
    videoUrl: string;
    audioUrl: string;
    note: string;
  } | null>(null);
  const [showDownload, setShowDownload] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerRef = useRef<any>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentVideoRef = useRef<VideoEntry | null>(null);
  const failedDrmLinksRef = useRef<Set<string>>(new Set());
  const failedFormatsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    params.then(({ contentId: id }) => {
      setContentId(id);
      fetchContent(id);
      loadAndPlay(id);
      fetchDownloadInfo(id);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, []);

  async function fetchContent(id: string) {
    try {
      const res = await fetch(`/api/content/${id}`);
      const data = await res.json();
      const results = data.results || [];
      if (results[0]) setItem(results[0]);
    } catch { /* non-critical — content info is supplementary */ }
  }

  async function fetchDownloadInfo(id: string) {
    try {
      const res = await fetch(`/api/download/video/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setDownloadInfo({
        encrypted: data.encrypted,
        videoUrl: data.videoDownloadUrl,
        audioUrl: data.audioDownloadUrl,
        note: data.note,
      });
    } catch { /* non-critical */ }
  }

  async function loadAndPlay(id: string) {
    setMediaLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/media/${id}`);
      const data = await res.json();

      if (data.error === "geo_blocked") {
        setIsGeoBlocked(true);
        setError(data.message || data.title || "This content is not available in your region.");
        return;
      }

      if (data.error === "login_required" || data.code === 401) {
        setError("login_required");
        return;
      }

      if (data.error === "video_unavailable") {
        setError(data.message || "Video is not available for this content.");
        return;
      }

      if (data.error === "session_blocked" || data.error === "upstream_error") {
        setError(data.message || "SunNXT is temporarily unavailable. Please wait a moment and retry.");
        return;
      }

      if (data.code !== 200 || !data.results?.[0]?.videos?.values?.length) {
        setError("Stream unavailable.");
        return;
      }

      // media API normalizes videos: resolves relative URLs, propagates licenseUrl
      const videos: VideoEntry[] = data.results[0].videos.values;

      // Priority:
      //  1. Unencrypted DASH (format=dash, no licenseUrl) — Akamai CDN, no DRM needed
      //  2. Widevine DASH (format=dash with licenseUrl) — requires Widevine CDM
      //  3. PlayReady DASH (dash-cenc) — Edge/Windows only
      //  4. HLS (any hls* format) — fallback
      //  5. First available entry
      // Skip any format whose stream URL already failed this session.
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
      const clearDash  = videos.find((v) => v.format === "dash" && !v.licenseUrl);
      const widevineDash = videos.find((v) => v.format === "dash" && v.licenseUrl);
      const cencDash = videos.find((v) => v.format === "dash-cenc" && v.licenseUrl);
      const hlsVideo = videos.find((v) => v.format?.includes("hls") && v.format !== "hls-fp-aapl");
      // FairPlay HLS is the native DRM for Safari/iOS — prefer it over DASH CENC on Apple devices.
      const fairPlayHls = isSafari ? videos.find((v) => v.format === "hls-fp-aapl") : undefined;
      // Safari: prefer FairPlay HLS (native Apple DRM) → then unencrypted DASH → then CENC DASH as last resort.
      // Other browsers: Widevine DASH → CENC DASH → generic HLS → fallback.
      const ordered = (isSafari
        ? [clearDash, fairPlayHls, hlsVideo, cencDash, widevineDash, videos[0]]
        : [clearDash, widevineDash, cencDash, hlsVideo, videos[0]]
      )
        .filter((v): v is VideoEntry => !!v)
        .filter((v, i, arr) => arr.findIndex((x) => x.link === v.link) === i)
        .filter((v) => !failedDrmLinksRef.current.has(v.link))
        .filter((v) => !failedFormatsRef.current.has(v.format));

      // Akamai DASH manifests include ContentProtection elements even for nominally
      // unencrypted streams — Shaka throws 6012 (NO_LICENSE_SERVER_GIVEN) if no
      // server is configured.  Pass the best available license URL as a fallback so
      // clearDash (and any other format without its own licenseUrl) can still load.
      const fallbackLicenseUrl =
        videos.find((v) => v.licenseUrl)?.licenseUrl ?? null;

      console.log("Player: formats available:", videos.map((v) => ({
        format: v.format,
        hasLicense: !!v.licenseUrl,
        url: v.link.split("?")[0].split("/").slice(-2).join("/"),
      })));

      let lastErr: unknown = null;
      let allDrmErrors = true;
      const isLiveStream = videos.some((v) => /livestream/i.test(v.link || ""));
      for (const video of ordered) {
        try {
          console.log("Player: trying format", video.format, video.link.split("?")[0].split("/").pop());
          await startPlayback(video, id, fallbackLicenseUrl);
          return; // success
        } catch (e) {
          lastErr = e;
          const code = (e as { code?: number })?.code;
          if (code !== 4012 && code !== 4032 && code !== 6007) allDrmErrors = false;
          console.warn("Player: format", video.format, "failed — trying next");
        }
      }
      if (allDrmErrors && isLiveStream) {
        throw Object.assign(new Error("hdcp_required"), { _hdcpLive: true });
      }
      throw lastErr ?? new Error("No playable stream found.");
    } catch (e: unknown) {
      if (e && typeof e === "object" && "_hdcpLive" in e) {
        console.warn("Live channel: all formats blocked by HDCP output restriction");
        setError("This live HD channel requires HDCP hardware support not available in the browser. Try the SunNXT app on a TV or mobile device.");
      } else if (e && typeof e === "object" && "category" in e) {
        const err = e as { code?: number; category?: number; data?: unknown[] };
        const d = Array.isArray(err.data) ? err.data : [];
        const isDrm = err.category === 6 || ((err.code ?? 0) >= 6000 && (err.code ?? 0) < 7000);
        console.error("Shaka load failed:", { code: err.code, category: err.category, url: d[0], httpStatus: d[1] });
        if (isDrm) {
          setError(`DRM error [${err.code}]: Could not obtain a license. The content may require a subscription or a different DRM system.`);
        } else {
          setError("Failed to load stream.");
        }
      } else {
        console.error("Load error:", e);
        setError("Failed to load stream.");
      }
    } finally {
      setMediaLoading(false);
    }
  }

  async function sendHeartbeat(id: string, action: "Start" | "Stop") {
    await fetch("/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentId: id, action }),
    }).catch(() => {});
  }

  function startHeartbeat(id: string) {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    sendHeartbeat(id, "Start");
    heartbeatRef.current = setInterval(() => sendHeartbeat(id, "Start"), 30_000);
  }

  function isSunnxtCdnUrl(url: string): boolean {
    try {
      const { hostname } = new URL(url);
      // sunnxt.com subdomains (livestream, suntvvod1, etc.)
      if (hostname.endsWith(".sunnxt.com") || hostname === "sunnxt.com") return true;
      // Akamai CDN: movies1-suntvvod-dd.akamaized.net, movies2-suntvvod.akamaized.net …
      if (hostname.endsWith(".akamaized.net") && hostname.includes("suntvvod")) return true;
      return false;
    } catch { return false; }
  }

  async function startPlayback(video: VideoEntry, id: string, fallbackLicenseUrl?: string | null) {
    if (!videoRef.current) return;
    currentVideoRef.current = video;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaka: any = await import("shaka-player");
    shaka.polyfill.installAll();

    if (!shaka.Player.isBrowserSupported()) {
      setError("Your browser does not support this player.");
      return;
    }

    if (playerRef.current) await playerRef.current.destroy();

    // Reset residual CDM session (e.g. output-restricted key status) so it doesn't
    // carry over and cause 4032 when Shaka filters the next format's manifest.
    try { await videoRef.current.setMediaKeys(null); } catch { /* best effort */ }

    const player = new shaka.Player();
    await player.attach(videoRef.current);
    playerRef.current = player;

    // Only surface errors that happen DURING playback (not during the load
    // phase — those are caught by the quality-fallback loop below).
    let loadingDone = false;
    player.addEventListener("error", (event: Event) => {
      if (!loadingDone) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = (event as any).detail;
      const code: number = detail?.code ?? 0;
      // Shaka error category 6 = DRM errors.
      // 4012 = RESTRICTIONS_CANNOT_BE_MET — all stream variants filtered after an
      // invalid DRM key status (e.g. CDM rejected modularLicense response). Treat
      // as format failure so the player moves on to the next format.
      const isDrm = detail?.category === 6 || (code >= 6000 && code < 7000) || code === 4012;
      const errData = Array.isArray(detail?.data) ? detail.data : [];
      console.error("Player runtime error:", { code, category: detail?.category, message: detail?.message, url: errData[0], httpStatus: errData[1] });

      if (isDrm && currentVideoRef.current) {
        console.warn(`DRM [${code}] on ${currentVideoRef.current.format} — trying next format`);
        // Always track by format: hdnea tokens change on every media refetch so
        // URL-based tracking never blocks the same stream on the next attempt.
        failedFormatsRef.current.add(currentVideoRef.current.format);
        loadAndPlay(id);
        return;
      }

      const msg = isDrm
        ? `DRM error [${code}]: ${detail?.message || "License request failed"}`
        : `Playback error [${code}]: ${detail?.message || "unknown"}`;
      setError(msg);
    });

    // Akamai EdgeAuth token (hdnea) from the manifest URL.
    // DASH segment URLs are resolved from the MPD <BaseURL> which is the directory
    // path only — query strings (including hdnea) are not inherited during relative
    // URL resolution per RFC 3986.  We re-inject it into every CDN segment request
    // so Akamai doesn't reject them with 403.
    let hdnea: string | null = null;
    try { hdnea = new URL(video.link).searchParams.get("hdnea"); } catch { /* no-op */ }

    // Proxy requests to CORS-blocked / auth-required SunNXT domains.
    // Skip already-proxied URLs to prevent double-proxying.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    player.getNetworkingEngine().registerRequestFilter((_type: any, request: any) => {
      const url: string = request.uris[0];
      if (url.includes("/api/stream-proxy")) return;
      if (isSunnxtCdnUrl(url)) {
        let cdnUrl = url;
        if (hdnea && !cdnUrl.includes("hdnea=")) {
          cdnUrl += (cdnUrl.includes("?") ? "&" : "?") + `hdnea=${encodeURIComponent(hdnea)}`;
        }
        request.uris[0] = `/api/stream-proxy?url=${encodeURIComponent(cdnUrl)}`;
      }
    });

    // Akamai CDN format=dash entries omit licenseUrl in the API response but the
    // segments are Widevine-encrypted (PSSH box in init.mp4). We need a license
    // server — prefer the API's fallbackLicenseUrl (nagravisionDRMProxy with a
    // subscribed-session JWT) when available; fall back to modularLicense otherwise.
    const isAkamaiDash = video.format === "dash" && !video.licenseUrl && isSunnxtCdnUrl(video.link);
    const inferredLicenseUrl = isAkamaiDash
      ? (fallbackLicenseUrl ?? `https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=${id}`)
      : null;
    const effectiveLicenseUrl =
      video.licenseUrl ??
      inferredLicenseUrl ??
      (video.format !== "dash" ? fallbackLicenseUrl : null) ??
      null;
    // Live channel: skip modularLicense (enforces HDCP for live IDs).
    // FairPlay: skip modularLicense (it's Widevine-only, wrong challenge format).
    // Both use the original nagravisionDRMProxy / FairPlay URL directly.
    const isLiveChannel = /livestream/i.test(video.link);
    const isFairPlay = video.format === "hls-fp-aapl";
    const bypassModular = isLiveChannel || isFairPlay;
    // Pass contentId so the license proxy can try pwaapi modularLicense
    // (no subscription check) before falling back to the api.sunnxt.com endpoint.
    const proxyLicenseUrl = effectiveLicenseUrl
      ? `/api/license?url=${encodeURIComponent(effectiveLicenseUrl)}&contentId=${encodeURIComponent(id)}${bypassModular ? "&isLive=1" : ""}`
      : null;

    if (proxyLicenseUrl) {
      if (isFairPlay) {
        // FairPlay (com.apple.fps.1_0) — Safari/iPhone only.
        // serverCertificateUri uses the same proxy URL; our GET handler returns the cert.
        player.configure({
          drm: {
            servers: { "com.apple.fps.1_0": proxyLicenseUrl },
            advanced: {
              "com.apple.fps.1_0": {
                serverCertificateUri: proxyLicenseUrl,
              },
            },
          },
        });
        console.log("Player: DRM configured for", video.format, "→ FairPlay");
      } else {
        // Configure both Widevine and PlayReady regardless of format — DASH manifests
        // (including dash-cenc) typically list both ContentProtection schemes and
        // Chrome will pick Widevine even for dash-cenc content.  Omitting Widevine
        // here causes Shaka error 6012 on Chrome for any DASH manifest.
        //
        // Request SW_SECURE_DECODE (Widevine L3) robustness so the license server
        // issues keys without mandatory HDCP output protection — without this,
        // Nagravision returns a license that requires HDCP 2.x and Chrome's software
        // CDM reports "output-restricted", causing Shaka error 4012/4032.
        // Shaka 5.x: videoRobustness/audioRobustness in advanced are string[] | null.
        player.configure({
          drm: {
            servers: {
              "com.widevine.alpha": proxyLicenseUrl,
              "com.microsoft.playready": proxyLicenseUrl,
            },
            defaultVideoRobustnessForWidevine: "SW_SECURE_DECODE",
            defaultAudioRobustnessForWidevine: "SW_SECURE_CRYPTO",
            advanced: {
              "com.widevine.alpha": {
                videoRobustness: ["SW_SECURE_DECODE"],
                audioRobustness: ["SW_SECURE_CRYPTO"],
              },
            },
          },
        });
        console.log("Player: DRM configured for", video.format, "→ Widevine L3 SW_SECURE_DECODE");
      }
    }

    const fallbacks = buildQualityFallbacks(video.link);
    let loaded = false;
    for (const url of fallbacks) {
      try {
        // For Widevine DASH, pass the license URL so stream-proxy can inject
        // <dashif:Laurl> into the MPD — fixes Shaka error 6012 on Akamai streams.
        const licenseParam =
          video.format === "dash" && proxyLicenseUrl
            ? `&licenseUrl=${encodeURIComponent(proxyLicenseUrl)}`
            : "";
        // Only strip ContentProtection for non-CDN dash streams that have no license
        // at all. Akamai CDN segments always carry Widevine encryption (PSSH in
        // init.mp4) so stripping the MPD's ContentProtection only causes 6010.
        const stripDrmParam =
          video.format === "dash" && !video.licenseUrl && !isAkamaiDash ? "&stripDrm=true" : "";
        const loadUrl = isSunnxtCdnUrl(url)
          ? `/api/stream-proxy?url=${encodeURIComponent(url)}${licenseParam}${stripDrmParam}`
          : url;
        console.log("Player: trying", url.split("?")[0].split("/").pop());
        await player.load(loadUrl);
        loaded = true;
        break;
      } catch (e: unknown) {
        const httpStatus = (e as { data?: unknown[] })?.data?.[1];
        // Only continue fallback on 404 — other errors should surface immediately
        if (httpStatus !== 404) throw e;
        console.warn("Player: 404 for", url.split("?")[0].split("/").pop(), "— trying next quality");
      }
    }
    if (!loaded) throw new Error("All quality variants returned 404");
    loadingDone = true;
    videoRef.current.play();
    startHeartbeat(id);
  }

  function buildQualityFallbacks(originalUrl: string): string[] {
    const urls = [originalUrl];
    const base = originalUrl.split("?")[0];
    const qs = originalUrl.includes("?") ? originalUrl.slice(originalUrl.indexOf("?")) : "";

    // e.g. 82850_est_sd.mpd → try _est_hd, _hd, _sd (without est), plain
    const filename = base.split("/").pop() || "";
    const dir = base.slice(0, base.lastIndexOf("/") + 1);

    const variants = [
      filename.replace(/_est_sd\.mpd/, "_est_hd.mpd"),
      filename.replace(/_est_sd\.mpd/, "_hd.mpd"),
      filename.replace(/_est_sd\.mpd/, "_sd.mpd"),
      filename.replace(/_est_hd\.mpd/, "_hd.mpd"),
      filename.replace(/_est_4k\.mpd/, "_4k.mpd"),
    ].filter((v) => v && v !== filename);

    for (const v of variants) {
      const candidate = dir + v + qs;
      if (!urls.includes(candidate)) urls.push(candidate);
    }
    return urls;
  }

  const backdropUrl = item
    ? getImageUrl(item.images, "preview", "xxhdpi") || getImageUrl(item.images, "landscape", "xxhdpi")
    : null;
  const posterUrl = item
    ? getImageUrl(item.images, "poster", "xhdpi") || getImageUrl(item.images, "preview", "hdpi")
    : null;
  const title = item?.generalInfo?.title || item?.globalServiceName || item?.title || "";
  const description = item?.generalInfo?.description || item?.generalInfo?.briefDescription || "";
  const genres = item?.genreInfo?.values?.map((g) => g.title) || [];
  const cast = item?.relatedCast?.values || [];

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Player area */}
      <div className="relative w-full bg-black" style={{ aspectRatio: "16/9", maxHeight: "80vh" }}>
        {/* Backdrop shown while loading */}
        {backdropUrl && (
          <Image
            src={backdropUrl}
            alt={title || "Content backdrop"}
            fill
            unoptimized
            priority
            className={`object-cover transition-opacity duration-500 ${mediaLoading ? "opacity-30" : "opacity-0"}`}
          />
        )}

        {/* Video element — always mounted so shaka can attach */}
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full"
          controls
          playsInline
          onPause={() => {
            if (heartbeatRef.current) {
              clearInterval(heartbeatRef.current);
              heartbeatRef.current = null;
            }
            sendHeartbeat(contentId, "Stop");
          }}
          onEnded={() => {
            if (heartbeatRef.current) {
              clearInterval(heartbeatRef.current);
              heartbeatRef.current = null;
            }
            sendHeartbeat(contentId, "Stop");
          }}
        />

        {/* Loading spinner overlay */}
        {mediaLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-14 h-14 border-4 border-white/20 border-t-red-500 rounded-full animate-spin" />
          </div>
        )}

        {/* Error overlay */}
        {error && !mediaLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 px-6 text-center">
            {error === "login_required" ? (
              <>
                <svg className="w-14 h-14 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                <p className="text-white font-bold text-lg">Login Required</p>
                <p className="text-gray-400 text-sm max-w-xs">Sign in with your SunNXT account to watch this content.</p>
                <a
                  href={`/login?next=/player/${contentId}`}
                  className="mt-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold px-8 py-2.5 rounded-full transition-colors"
                >
                  Sign In
                </a>
                <button onClick={() => history.back()} className="text-gray-500 text-xs hover:text-gray-300 mt-1">
                  Go Back
                </button>
              </>
            ) : isGeoBlocked ? (
              <>
                <div className="text-5xl">🌍</div>
                <p className="text-white font-bold text-base sm:text-lg">International Roaming Expired</p>
                <p className="text-gray-300 text-xs sm:text-sm max-w-sm leading-relaxed">{error}</p>
                <button
                  onClick={() => history.back()}
                  className="mt-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium px-6 py-2 rounded transition-colors"
                >
                  Go Back
                </button>
              </>
            ) : (
              <>
                <p className="text-yellow-400 text-sm max-w-md">{error}</p>
                <button
                  onClick={() => { failedDrmLinksRef.current.clear(); failedFormatsRef.current.clear(); loadAndPlay(contentId); }}
                  className="bg-red-600 hover:bg-red-700 text-white text-sm font-medium px-6 py-2 rounded transition-colors"
                >
                  Retry
                </button>
              </>
            )}
          </div>
        )}

        {/* Back button */}
        <div className="absolute top-4 left-4 z-10">
          <button
            onClick={() => history.back()}
            className="bg-black/50 hover:bg-black/80 text-white p-2 rounded-full transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        </div>

        {/* Download button (top-right) — only shown when stream info is ready */}
        {downloadInfo && (
          <div className="absolute top-4 right-4 z-10">
            <button
              onClick={() => setShowDownload((v) => !v)}
              title="Download"
              className="bg-black/50 hover:bg-black/80 text-white p-2 rounded-full transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 3v12" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Download panel — shown below player when toggled */}
      {showDownload && downloadInfo && (
        <div className="max-w-350 mx-auto px-6 sm:px-10 pt-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold text-sm">Download</h3>
              <button onClick={() => setShowDownload(false)} className="text-gray-500 hover:text-white text-xs">
                Close
              </button>
            </div>

            {downloadInfo.encrypted && (
              <div className="mb-3 flex items-start gap-2 bg-yellow-900/30 border border-yellow-700/50 rounded-lg px-3 py-2">
                <svg className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 15v2m0 0v2m0-2h2m-2 0H10m2-6V7m0 0a2 2 0 100-4 2 2 0 000 4z" />
                </svg>
                <p className="text-yellow-300 text-xs leading-relaxed">{downloadInfo.note}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <a
                href={downloadInfo.videoUrl}
                download
                className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 10l5 5 5-5M12 3v12" />
                </svg>
                Download Video
              </a>
              <a
                href={downloadInfo.audioUrl}
                download
                className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm12-3c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z" />
                </svg>
                Download Audio
              </a>
            </div>
            <p className="text-gray-500 text-xs mt-3">
              Video and audio are downloaded as separate fMP4 tracks. Merge with:
              <code className="ml-1 text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded text-[11px]">
                ffmpeg -i video.mp4 -i audio.mp4 -c copy merged.mp4
              </code>
            </p>
          </div>
        </div>
      )}

      {/* Content info */}
      <div className="max-w-350 mx-auto px-6 sm:px-10 py-8">
        <div className="flex gap-6">
          {posterUrl && (
            <div className="shrink-0 hidden sm:block w-32">
              <div className="relative aspect-2/3 rounded-lg overflow-hidden">
                <Image src={posterUrl} alt={title || "Poster"} fill unoptimized className="object-cover" />
              </div>
            </div>
          )}

          <div className="flex-1 min-w-0">
            <h2 className="text-2xl font-black text-white mb-2">{title}</h2>

            <div className="flex flex-wrap items-center gap-3 text-sm text-gray-400 mb-3">
              {item?.releaseDate && <span>{new Date(item.releaseDate).getFullYear()}</span>}
              {item?.generalInfo?.type && (
                <span className="bg-gray-800 px-2 py-0.5 rounded text-xs uppercase">
                  {item.generalInfo.type}
                </span>
              )}
              {genres.length > 0 && <span>{genres.join(" • ")}</span>}
              {item?.generalInfo?.isDolby && (
                <span className="bg-blue-600 text-white text-xs font-bold px-2 py-0.5 rounded">DOLBY</span>
              )}
            </div>

            {description && (
              <p className="text-gray-300 text-sm leading-relaxed mb-4 max-w-2xl">{description}</p>
            )}

            {item?.subtitles?.values?.length ? (
              <div className="mb-4">
                <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Subtitles</p>
                <div className="flex flex-wrap gap-2">
                  {item.subtitles.values.map((sub) => (
                    <span key={sub.language} className="bg-gray-800 text-gray-300 text-xs px-2 py-0.5 rounded">
                      {sub.language}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {cast.length > 0 && (
          <div className="mt-8">
            <h3 className="text-white font-bold text-base mb-4">Cast</h3>
            <div className="flex gap-4 overflow-x-auto scrollbar-hide pb-2">
              {cast.slice(0, 12).map((member, idx) => {
                const castImg = getImageUrl(member.images, "squareimage", "hdpi");
                return (
                  <div key={`${member._id}-${idx}`} className="shrink-0 text-center w-20">
                    <div className="relative w-16 h-16 mx-auto rounded-full overflow-hidden bg-gray-800 mb-2">
                      {castImg ? (
                        <Image src={castImg} alt={member.name} fill unoptimized className="object-cover" />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-xl font-bold">
                          {member.name[0]}
                        </div>
                      )}
                    </div>
                    <p className="text-gray-300 text-xs leading-tight line-clamp-2">{member.name}</p>
                    {member.types[0] && (
                      <p className="text-gray-500 text-[10px] mt-0.5">{member.types[0]}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
