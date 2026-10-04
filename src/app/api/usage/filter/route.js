import { NextResponse } from "next/server";
import { getUsageFilter, setUsageFilter, getUsageFilterOptions } from "@/lib/db/repos/usageFilterRepo.js";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const [filter, options] = await Promise.all([getUsageFilter(), getUsageFilterOptions()]);
    return NextResponse.json({ filter, options }, { headers: HEADERS });
  } catch (error) {
    console.error("[API] Failed to get usage filter:", error);
    return NextResponse.json({ error: "Failed to fetch usage filter" }, { status: 500 });
  }
}

export async function PUT(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const filter = await setUsageFilter(body);
    return NextResponse.json({ filter }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof TypeError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("[API] Failed to update usage filter:", error);
    return NextResponse.json({ error: "Failed to update usage filter" }, { status: 500 });
  }
}
