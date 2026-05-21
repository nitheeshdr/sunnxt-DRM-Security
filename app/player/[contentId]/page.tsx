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
  const videoRef = useRef<HTMLVideoElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerRef = useRef<any>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    params.then(({ contentId: id }) => {
      setContentId(id);
      fetchContent(id);
      loadAndPlay(id);
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

      if (data.code !== 200 || !data.results?.[0]?.videos?.values?.length) {
        setError("Stream unavailable.");
        return;
      }

      const videos: VideoEntry[] = data.results[0].videos.values;
      // Prefer unencrypted DASH (no DRM — works on all mobile browsers).
      // Fall back to DRM-encrypted DASH, then HLS, then first available.
      const clearDash = videos.find((v) => v.format === "dash" && !v.licenseUrl);
      const cencDash = videos.find((v) => v.format?.includes("cenc") || (v.format?.includes("dash") && v.licenseUrl));
      const hlsVideo = videos.find((v) => v.format?.includes("hls") || v.link?.includes(".m3u8"));
      const chosen = clearDash || cencDash || hlsVideo || videos[0];

      if (!chosen) {
        setError("No playable stream found.");
        return;
      }

      console.log("Player: all formats:", videos.map((v) => ({ format: v.format, hasLicense: !!v.licenseUrl, url: v.link })));
      console.log("Player: chosen format:", chosen.format, chosen.link);
      await startPlayback(chosen, id);
    } catch (e: unknown) {
      if (e && typeof e === "object" && "category" in e) {
        const err = e as { code?: number; category?: number; severity?: number; data?: unknown[]; message?: string };
        const d = Array.isArray(err.data) ? err.data : [];
        console.error("Shaka load failed:", {
          code: err.code,
          category: err.category,
          message: err.message,
          url: d[0],
          httpStatus: d[1],
          responseText: typeof d[2] === "string" ? d[2].slice(0, 200) : d[2],
        });
      } else {
        console.error("Load error:", e);
      }
      setError("Failed to load stream.");
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

  async function startPlayback(video: VideoEntry, id: string) {
    if (!videoRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaka: any = await import("shaka-player");
    shaka.polyfill.installAll();

    if (!shaka.Player.isBrowserSupported()) {
      setError("Your browser does not support this player.");
      return;
    }

    if (playerRef.current) await playerRef.current.destroy();

    const player = new shaka.Player();
    await player.attach(videoRef.current);
    playerRef.current = player;

    player.addEventListener("error", (event: Event) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = (event as any).detail;
      console.error("Shaka error:", {
        code: detail?.code,
        category: detail?.category,
        severity: detail?.severity,
        data: detail?.data,
        message: detail?.message,
      });
      setError(`Playback error [${detail?.code ?? "?"}]: ${detail?.message || "unknown"}`);
    });

    // Proxy requests to CORS-blocked SunNXT domains through our server
    const CORS_BLOCKED = ["livestream.sunnxt.com", "suntvvod1.sunnxt.com"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    player.getNetworkingEngine().registerRequestFilter((_type: any, request: any) => {
      const url: string = request.uris[0];
      if (CORS_BLOCKED.some((h) => url.includes(h))) {
        request.uris[0] = `/api/stream-proxy?url=${encodeURIComponent(url)}`;
      }
    });

    if (video.licenseUrl) {
      const proxyLicenseUrl = `/api/license?url=${encodeURIComponent(video.licenseUrl)}`;
      player.configure({
        drm: {
          servers: {
            "com.widevine.alpha": proxyLicenseUrl,
            "com.microsoft.playready": proxyLicenseUrl,
          },
        },
      });
    }

    await player.load(video.link);
    videoRef.current.play();
    startHeartbeat(id);
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
            {isGeoBlocked ? (
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
                  onClick={() => loadAndPlay(contentId)}
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
      </div>

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
