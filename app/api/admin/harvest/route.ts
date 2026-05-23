import { type NextRequest, NextResponse } from "next/server";
import { runHarvest, harvestState } from "@/lib/uuid-harvest";
import { getUuidDbSize } from "@/lib/cdn-bypass";

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");

  // Return current status
  if (action !== "start") {
    return NextResponse.json({
      ...harvestState,
      dbSize: getUuidDbSize(),
    });
  }

  // Start harvest in background — don't await it
  if (harvestState.running) {
    return NextResponse.json({ message: "Harvest already running", ...harvestState });
  }

  // Determine base URL for calling our own /api/media routes
  const host = request.headers.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const baseUrl = `${protocol}://${host}`;

  // Fire and forget — runs in background
  void runHarvest(baseUrl);

  return NextResponse.json({
    message: "Harvest started",
    note: "Poll GET /api/admin/harvest for progress",
    dbSizeBefore: getUuidDbSize(),
  });
}
