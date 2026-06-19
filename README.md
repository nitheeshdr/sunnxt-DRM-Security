<div align="center">

# Sunnxt DRM Security

**A production-grade reverse-engineered streaming client built with Next.js**

[![Next.js](https://img.shields.io/badge/Next.js-16.2-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)](https://react.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-06b6d4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Shaka Player](https://img.shields.io/badge/Shaka_Player-5.x-4285f4?logo=google)](https://shaka-player-demo.appspot.com)
[![Vercel](https://img.shields.io/badge/Deployed_on-Vercel-000?logo=vercel)](https://vercel.com)

A fully functional clone of the [SunNXT](https://www.sunnxt.com) streaming platform built from real API traffic analysis. No mock data — everything is live. Built for security research: to understand how OTT platforms work under the hood, and to identify vulnerabilities for responsible disclosure.

</div>

---

## What This Project Does

| Feature | Description |
|---|---|
| Home Feed | Carousel groups — Trending, New Releases, Movies, TV Shows |
| Search | Content-type filters: Movies, TV Shows, Comedy, Music, Short Films, Live TV |
| Detail Pages | Cast, genres, subtitles, release year, Dolby badge |
| Video Player | MPEG-DASH + HLS adaptive streaming via Shaka Player |
| Live TV | Real-time live channel streaming |
| DRM Support | Widevine, PlayReady, and FairPlay (Safari/iOS) encrypted streams |
| FairPlay (Safari/iOS) | `hls-fp-aapl` format selected first on Safari; `com.apple.fps.1_0` key system configured with certificate + license proxy |
| Live Channel DRM Fix | `isLive=1` flag bypasses modularLicense and goes directly to nagravisionDRMProxy for live content |
| Download | `GET /api/download/video/[contentId]` — stream info JSON + `?stream=1` DASH-to-fMP4 streaming; optional server-side merge with ffmpeg |
| Geo-block Handling | Detects roaming errors and auto re-authenticates |
| Auto Login | Server-side session with automatic refresh + device-limit bypass |
| Heartbeat | Tracks watch sessions (Start/Stop events every 30s) |
| CDN Bypass | 3-path subscription bypass system with hdntl token persistence |
| UUID Harvest | Auto-discovers and persists content UUIDs (536+ in DB) for instant bypass |
| Session Recovery | Auto-retries pwaapi unauthenticated when main API session is rate-limited |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Browser (React / Shaka)                       │
│  Page Router  →  /api/*  (all API calls routed through server)  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              Next.js App Router  (Vercel — Mumbai bom1)          │
│                                                                  │
│  /api/media/[id]    →  Resolve + decrypt stream URLs + bypass   │
│  /api/stream-proxy  →  CORS proxy + MPD/HLS manifest rewriter   │
│  /api/license       →  DRM license proxy (Widevine/PlayReady)   │
│  /api/auth/*        →  Login, logout, session management        │
│  /api/heartbeat     →  Playback session tracking                │
│                                                                  │
│  lib/sunnxt-session.ts  — AES decrypt · session cache · login   │
│  lib/cdn-bypass.ts      — UUID DB · hdntl cache · bypass logic  │
└──────┬──────────────────────────┬────────────────────────────────┘
       │ Login / Media API         │ CDN Segment Requests
       ▼                           ▼
┌──────────────────┐     ┌──────────────────────────────┐
│  www.sunnxt.com  │     │  movies1-suntvvod1.akamaized  │
│  pwaapi.sunnxt   │     │  movies2-suntvvod1.akamaized  │
│  (Origin API)    │     │  (Akamai Media CDN)           │
└──────────────────┘     └──────────────────────────────┘
```

> The browser **never** contacts SunNXT directly. Every request — authentication, content metadata, stream URLs, CDN segments — routes through Next.js route handlers that inject auth cookies server-side.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Framework | Next.js 16 App Router | Server-side API routes + RSC |
| Language | TypeScript 5 | Type safety across API contracts |
| Styling | Tailwind CSS v4 | Rapid utility-first UI |
| Video | Shaka Player 5 | DASH + HLS + Widevine DRM |
| Crypto | CryptoJS 4 | AES-128-CBC for SunNXT payloads |
| Hosting | Vercel (bom1) | Mumbai region → Indian IP for SunNXT |

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/nitheeshdr/sunnxt-clone.git
cd sunnxt-clone

# 2. Install
npm install

# 3. Configure credentials
cp .env.local.example .env.local
# Edit .env.local — add your SunNXT credentials and optional hdntl token

# 4. Run
npm run dev
# → http://localhost:3000
```

After first launch, the server automatically logs in to SunNXT and caches the session.

**Session reset** (if playback fails):
```
http://localhost:3000/api/auth/clear-session
```

---

## Environment Variables

Create `.env.local` — gitignored, never committed:

```env
# Required: SunNXT account credentials (subscribed account for bypass)
SUNNXT_USERID=your_phone_or_email
SUNNXT_PASSWORD=your_password

# Optional: Akamai hdntl CDN token (seeds bypass cache on startup)
# Format: exp=<unix>~acl=/*~data=hdntl~hmac=<sha256>
# Extends bypass capability when server subscription expires
SUNNXT_HDNTL=exp=...~acl=/*~data=hdntl~hmac=...
```

The `SUNNXT_HDNTL` token auto-refreshes from stream proxy sessions — once playback starts, the cache stays current.

---

## Project Structure

```
sunnxt-clone/
├── app/
│   ├── page.tsx                    # Home feed
│   ├── search/                     # Search with filters
│   ├── player/[contentId]/         # Video player
│   ├── [slug]/detail/[serviceId]/  # Content detail
│   └── api/
│       ├── media/[contentId]/      # Stream URL resolver + 3-path bypass
│       ├── stream-proxy/           # CDN CORS proxy + manifest rewriter
│       ├── license/                # DRM license proxy (Widevine/PlayReady/FairPlay)
│       ├── search/                 # Search proxy
│       ├── heartbeat/              # Watch session tracker
│       ├── download/               # File/subtitle download proxy
│       │   └── video/[contentId]/  # DASH-to-fMP4 video download (stream info + segment streaming)
│       └── auth/                   # Login / logout / status / clear-session
│
├── lib/
│   ├── sunnxt-session.ts           # Server-side session management + auto-login
│   ├── cdn-bypass.ts               # UUID DB, hdntl cache, bypass entry builder
│   └── api.ts                      # Client-side API helpers
│
├── components/                     # Navbar, HeroBanner, CarouselSection, ...
├── types/index.ts                  # Shared TypeScript types
├── vercel.json                     # → region: bom1 (Mumbai)
└── docs/                           # Complete documentation library ↓
```

---

## Security Research Summary

**20 vulnerabilities** were discovered across SunNXT's platform:

| Severity | Count | Key Findings |
|---|---|---|
| Critical | 2 | VULN-11: DRM license endpoint has no auth; VULN-16: server session shared to all users |
| High | 4 | VULN-01: AES key in client JS; VULN-06: wildcard CDN token; VULN-12: permanent UUIDs; VULN-20: permanent access |
| Medium | 8 | Device limit bypass, no rate limiting, phone enumeration, geo-block bypass, and more |
| Low | 3 | DRM JWT reuse, HTTP 200 for errors, heartbeat injection |
| Informational | 3 | Key in multiple files, regex injection, best-practice gaps |

**The most critical chain:** VULN-06 (wildcard CDN token) + VULN-11 (no DRM auth) + VULN-12 (permanent UUIDs) = complete premium content access without any subscription.

**Post-harvest findings (May 2026):**
- `pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/` confirmed to work with **zero authentication** — no session cookie, no JWT, no account required
- `pwaapi.sunnxt.com/content/v3/contentDetail/` also works unauthenticated — UUID harvest requires no SunNXT account
- UUID database harvested to 536 entries in a single 10k-ID run
- Live HD channels (KTVHDB, SunTVHDB) have hard HDCP enforcement in Nagravision license policy — browser playback not possible regardless of DRM config
- Shaka 5.x breaking change: `videoRobustness`/`audioRobustness` in `advanced` must be `string[]`, not `string`
- FairPlay DRM now correctly handled: `hls-fp-aapl` format selected first on Safari/iOS; `com.apple.fps.1_0` key system with server certificate fetched via GET on the license proxy
- Live channel DRM fix: `isLive=1` flag in license proxy URL causes the proxy to skip `modularLicense` (which returns HDCP-enforcing licenses for all live content) and go directly to `nagravisionDRMProxy` — live channels now play on Chrome/Firefox/Edge/Android
- Download feature: `GET /api/download/video/[contentId]` returns stream info JSON; `?stream=1&track=video|audio` streams DASH segments as fragmented MP4; `?stream=1&merge=1` auto-merges server-side using ffmpeg (not compatible with Vercel serverless)

See [SECURITY_REPORT.md](SECURITY_REPORT.md) for the full report with CVSS scores, PoC, remediation, and the May 2026 addendum.

---

## Documentation Library

### Platform Internals

| # | Guide | What You'll Learn |
|---|---|---|
| 01 | [Project Overview](docs/01-overview.md) | Goals, scope, research methodology |
| 02 | [System Architecture](docs/02-architecture.md) | 3-layer proxy model, request flow |
| 03 | [API & Encryption](docs/03-api-encryption.md) | AES-CBC, static key, decrypt flow |
| 04 | [Session & Auth](docs/04-session-auth.md) | Login, cookies, device-limit bypass |
| 05 | [CORS Proxy & Manifests](docs/05-cors-proxy.md) | Stream proxy, DASH/HLS rewriting |
| 06 | [Video Player Pipeline](docs/06-video-player.md) | Shaka, adaptive streaming, quality fallback |
| 07 | [DRM Handling](docs/07-drm.md) | Widevine/PlayReady/FairPlay, 14 stream formats |
| 08 | [Geo-block & Security](docs/08-geo-security.md) | Roaming detection, all security findings |
| 09 | [Deployment](docs/09-deployment.md) | Vercel, Mumbai region, troubleshooting |

### Security Deep Dives

| # | Guide | What You'll Learn |
|---|---|---|
| 10 | [Vulnerability Deep Dive](docs/10-vulnerability-deep-dive.md) | All vulns explained with PoC + fix |
| 11 | [DRM Deep Dive](docs/11-drm-deep-dive.md) | EME API, PSSH, Nagravision, L1/L3 |
| 12 | [Web Security Fundamentals](docs/12-api-security-fundamentals.md) | SOP, CORS, sessions, crypto basics |
| 13 | [OWASP Top 10 Mapping](docs/13-owasp-top10-mapping.md) | All 20 findings mapped to OWASP 2021 |

### Reference Documents

| Document | Description |
|---|---|
| [SECURITY_REPORT.md](SECURITY_REPORT.md) | Full security assessment — 20 findings with CVSS, PoC, and remediation |
| [LEARNING_GUIDE.md](LEARNING_GUIDE.md) | Single-file complete reference — platform internals + all 20 vulnerabilities |
| [docs/COMPREHENSIVE.md](docs/COMPREHENSIVE.md) | Ultimate technical reference — API, CDN, DRM, bypass, all vulns |
| [docs/FULL_STREAM.md](docs/FULL_STREAM.md) | End-to-end streaming reference — DASH, HLS, CDN, Akamai |
| [docs/LICENSE_ENDPOINT.md](docs/LICENSE_ENDPOINT.md) | DRM license endpoint deep dive — modularLicense PoC, EME flow |
| [docs/FINAL_SECURITY.md](docs/FINAL_SECURITY.md) | Final comprehensive security assessment with all 20 findings |

---

## Deployment

Configured for Vercel Mumbai (`bom1`) — SunNXT sees Indian IPs:

```json
// vercel.json
{ "regions": ["bom1"] }
```

See [docs/09-deployment.md](docs/09-deployment.md) for the full deployment walkthrough.

---

> **Disclaimer:** This project is built for educational and security research purposes only. It is not affiliated with or endorsed by SunNXT / Sun Network. All findings have been prepared for responsible disclosure to the SunNXT security team. Use responsibly and in accordance with the platform's Terms of Service.
