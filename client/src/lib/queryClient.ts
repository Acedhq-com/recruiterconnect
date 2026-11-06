import { QueryClient } from "@tanstack/react-query";

// Rewritten only for the Computer preview. Vercel uses same-origin serverless API routes.
const proxy = "__PORT_5000__";
const API_BASE = proxy.startsWith("__") ? "" : proxy;

export async function apiRequest(method: string, url: string, data?: unknown): Promise<Response> {
  const response = await fetch(`${API_BASE}${url}`, {
    method,
    ...(data === undefined ? {} : {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }),
  });
  if (!response.ok) {
    const body: { message?: string } = await response.json().catch(() => ({}));
    throw new Error(body.message ?? "This request could not be completed. Please try again.");
  }
  return response;
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 60_000 } },
});
