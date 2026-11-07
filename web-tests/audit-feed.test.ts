import { expect, test, vi } from "vitest";
// @ts-expect-error The vendor declaration intentionally exposes only liveFeed.
import { createFeedService, normalizeResponse, safePostingUrl, FEED_SOURCES } from "../server/vendor/jobtracker/live-feed.mjs";

const source = { id: "audit", provider: "ashby", board: "audit", company: "Audit Employer",
  sector: "Software", home: "https://jobs.example.com/" };
const posting = { id: "audit-1", title: "Analyst", isListed: true,
  jobUrl: "https://jobs.example.com/audit", location: "Remote", descriptionPlain: "Synthetic role." };
const response = (jobs: unknown[]) => new Response(JSON.stringify({ jobs }), {
  headers: { "content-type": "application/json" },
});

test.each([
  "javascript:alert(1)", "http://jobs.example.com/a", "https://u:p@example.com/",
  "https://127.0.0.1/", "https://[::1]/", "https://corp.internal/", "https://example.com:444/",
])("audit: feed rejects unsafe outbound URL %s", value => {
  expect(safePostingUrl(value)).toBeNull();
});

test("audit: feed strips tracking parameters and fragments without changing the job", () => {
  expect(safePostingUrl("https://jobs.example.com/a?id=1&utm_source=x#apply"))
    .toBe("https://jobs.example.com/a?id=1");
});

test("audit: only configured fixed provider endpoints can be fetched", async () => {
  const fetchImpl = vi.fn(async (_input: unknown, _init?: RequestInit) => response([posting]));
  const service = createFeedService({ sources: [source], fetchImpl });
  await service.get();
  expect(fetchImpl.mock.calls[0]?.[0]).toBe(
    "https://api.ashbyhq.com/posting-api/job-board/audit?includeCompensation=true",
  );
  expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  expect(FEED_SOURCES).toHaveLength(8);
});

test("audit: unlisted, malformed, unsafe and duplicate postings never enter results", () => {
  const result = normalizeResponse({ jobs: [
    posting, { ...posting }, { ...posting, isListed: false }, null,
    { ...posting, jobUrl: "https://127.0.0.1/" },
  ] }, source, "2026-11-07T00:00:00.000Z");
  expect(result.jobs).toHaveLength(1);
  expect(result.excluded).toBe(4);
});

test("audit: concurrent cold requests share a single upstream refresh", async () => {
  let release!: (value: Response) => void;
  const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  const service = createFeedService({ sources: [source], fetchImpl });
  const first = service.get(); const second = service.get();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  release(response([posting]));
  const [a, b] = await Promise.all([first, second]);
  expect(a.jobs).toEqual(b.jobs);
});

test("audit: warm cache avoids network until its exact expiry", async () => {
  let now = 100000;
  const fetchImpl = vi.fn(async () => response([posting]));
  const service = createFeedService({ sources: [source], fetchImpl, now: () => now, ttl: 300000 });
  await service.get(); now += 299999;
  expect((await service.get()).cached).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  now += 1; await service.get();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test("audit: failed rechecks label retained listings stale with their original check time", async () => {
  let now = 100000;
  const fetchImpl = vi.fn().mockResolvedValueOnce(response([posting]))
    .mockRejectedValueOnce(new Error("synthetic source failure"));
  const service = createFeedService({ sources: [source], fetchImpl, now: () => now, ttl: 100 });
  const first = await service.get(); now += 100;
  const second = await service.get();
  expect(second.status).toBe("unavailable");
  expect(second.jobs[0].availability).toBe("source_recheck_failed");
  expect(second.jobs[0].checkedAt).toBe(first.jobs[0].checkedAt);
  expect(second.sources[0].status).toBe("stale");
});

test("audit: an oversized declared response is rejected, not trusted as live", async () => {
  const fetchImpl = vi.fn(async () => new Response("{}", {
    headers: { "content-length": String(12 * 1024 * 1024 + 1) },
  }));
  const result = await createFeedService({ sources: [source], fetchImpl }).get();
  expect(result.status).toBe("unavailable");
  expect(result.jobs).toEqual([]);
});

test("audit: streamed overflow is cancelled even without content-length", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1)); },
    cancel,
  });
  const fetchImpl = vi.fn(async () => new Response(stream));
  const result = await createFeedService({ sources: [source], fetchImpl }).get();
  expect(result.status).toBe("unavailable");
  expect(cancel).toHaveBeenCalledOnce();
});
