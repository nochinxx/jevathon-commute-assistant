import { NextResponse } from "next/server";
import { browserbase, Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v4";

export const dynamic = "force-dynamic";

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY!;

type Comparison = { recommendedMode: string; etaMinutes: number | null; raw: string };

let cache: { data: Comparison; expiresAt: number } | null = null;
const CACHE_MS = 60_000;

const ExtractSchema = z.object({
  recommendedMode: z.string().describe("The top recommended transit mode shown (e.g. bus, ferry, train, walk)"),
  etaMinutes: z.number().nullable().describe("The stated total trip duration in minutes, or null if not visible"),
  raw: z.string().describe("The raw text of the top recommended option as shown on the page"),
});

async function fetchComparison(): Promise<Comparison> {
  const browser = await browserbase.launch({ apiKey: BROWSERBASE_API_KEY });
  const stagehand = await Stagehand.create({ browser });
  try {
    const [page] = await browser.context.pages();
    const url =
      "https://www.google.com/maps/dir/?api=1&origin=Sausalito%2C+CA&destination=Ferry+Building%2C+San+Francisco%2C+CA&travelmode=transit";
    await page.goto(url);
    await page.waitForTimeout(5000);

    const { data } = await stagehand.extract(
      "Extract the top/first recommended transit route option shown in the directions panel, including its mode of transport and total trip duration.",
      ExtractSchema
    );
    return data;
  } finally {
    await stagehand.close();
  }
}

export async function GET() {
  if (!BROWSERBASE_API_KEY) {
    return NextResponse.json({ error: "Browserbase not configured" }, { status: 503 });
  }
  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json(cache.data);
  }
  try {
    const data = await fetchComparison();
    cache = { data, expiresAt: Date.now() + CACHE_MS };
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: "Maps comparison unavailable", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
