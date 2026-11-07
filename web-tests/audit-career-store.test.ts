// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { notifyManager, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CareerProvider, useCareer } from "../client/src/career-store.js";
import { queryClient } from "../client/src/lib/queryClient.js";
import type { PublicAccountSession } from "../shared/account-schema.js";
import { emptyBackground, emptyWorkspace } from "../shared/career-schema.js";

let current: ReturnType<typeof useCareer>;
let root: Root;
let container: HTMLDivElement;
const guest = { user: null, account: null, profile: null, privacy: null, authEnabled: false,
  method: "email-code", appOrigin: "https://findworkprivately.com" } as PublicAccountSession;
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const facts = (name: string) => ({ ...emptyBackground, name, skills: ["Accounting"] });
const workspace = (name: string) => ({
  ...emptyWorkspace(), background: { content: facts(name), version: 1 },
});
const identity = (id: string) => ({
  ...guest, authEnabled: true, user: { id, email: "audit@example.com" },
  account: { user_id: id, account_kind: "candidate", status: "active", display_name: "Synthetic" },
}) as PublicAccountSession;
const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
});
function Probe() {
  current = useCareer();
  return createElement("span", null, current.owner);
}
async function mount() {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient },
      createElement(CareerProvider, null, createElement(Probe))));
  });
  await vi.waitFor(() => expect(current.loading).toBe(false));
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  notifyManager.setScheduler(queueMicrotask);
  queryClient.clear();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear(); container.remove(); vi.unstubAllGlobals();
  notifyManager.setScheduler(callback => { setTimeout(callback, 0); });
});

test("audit: guest background stays in memory without private network writes", async () => {
  const fetcher = vi.fn(async () => json(guest));
  vi.stubGlobal("fetch", fetcher); await mount();
  await act(async () => current.saveBackground(facts("Guest synthetic"), 0));
  expect(current.workspace.background?.content.name).toBe("Guest synthetic");
  expect(fetcher).toHaveBeenCalledTimes(1); // The session GET only.
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

test("audit: guest facts are not silently uploaded after an identity change", async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    json(url === "/api/auth/session" ? guest : workspace("Cloud A")));
  vi.stubGlobal("fetch", fetcher); await mount();
  await act(async () => current.saveBackground(facts("Guest synthetic"), 0));
  await act(async () => { queryClient.setQueryData(["/api/auth/session"], identity(ownerA)); });
  await vi.waitFor(() => expect(current.workspace.background?.content.name).toBe("Cloud A"));
  expect(current.owner).toBe(ownerA);
  expect(fetcher.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method
    || (init as RequestInit).method === "GET")).toBe(true);
});

test("audit: a late mutation for account A cannot overwrite account B", async () => {
  let release!: (value: Response) => void;
  const fetcher = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === "/api/auth/session") return json(identity(ownerA));
    if (init?.method === "POST") return new Promise(resolve => { release = resolve; });
    const headers = init?.headers as Record<string, string>;
    return json(workspace(headers?.["X-Account-Id"] === ownerB ? "Cloud B" : "Cloud A"));
  });
  vi.stubGlobal("fetch", fetcher); await mount();
  await vi.waitFor(() => expect(current.workspace.background?.content.name).toBe("Cloud A"));
  let pending!: Promise<void>;
  await act(async () => { pending = current.saveBackground(facts("Late A result"), 1); });
  await act(async () => { queryClient.setQueryData(["/api/auth/session"], identity(ownerB)); });
  await vi.waitFor(() => expect(current.workspace.background?.content.name).toBe("Cloud B"));
  await act(async () => { release(json(workspace("Late A result"))); await pending; });
  expect(current.owner).toBe(ownerB);
  expect(current.workspace.background?.content.name).toBe("Cloud B");
  expect(current.notice).toBe("");
});

test("audit: cached owner plus failed session recheck signals private-content hiding", async () => {
  let authFailure = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/auth/session") return authFailure
      ? new Response('{"message":"Synthetic unavailable"}', { status: 503 })
      : json(identity(ownerA));
    return json(workspace("Cloud A"));
  }));
  await mount();
  authFailure = true;
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] }); });
  await vi.waitFor(() => expect(current.verificationFailed).toBe(true));
  expect(current.owner).toBe(ownerA);
});

test("audit: unmounting and reopening a guest provider clears temporary facts", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(guest))); await mount();
  await act(async () => current.saveBackground(facts("Temporary only"), 0));
  await act(async () => root.unmount());
  queryClient.clear(); root = createRoot(container); await mount();
  expect(current.workspace.background).toBeNull();
});
