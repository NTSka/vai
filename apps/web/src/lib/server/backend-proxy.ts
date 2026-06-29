import type { RequestHandler } from "@sveltejs/kit";

const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
  "upgrade"
]);

export function backendProxy(prefix: string): RequestHandler {
  return async ({ params, request, url }) => {
    const path = params.path ? `/${params.path}` : "";
    const target = new URL(`${prefix}${path}${url.search}`, backendOrigin());
    const headers = new Headers(request.headers);
    for (const header of hopByHopHeaders) {
      headers.delete(header);
    }

    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : request.body;
    const response = await fetch(target, {
      method,
      headers,
      body,
      ...(body ? { duplex: "half" } : {}),
      redirect: "manual"
    } as RequestInit & { duplex?: "half" });

    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      const normalizedKey = key.toLowerCase();
      if (!hopByHopHeaders.has(normalizedKey) && normalizedKey !== "set-cookie") {
        responseHeaders.set(key, value);
      }
    });
    for (const cookie of getSetCookieHeaders(response.headers)) {
      responseHeaders.append("set-cookie", cookie);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  };
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = withGetSetCookie.getSetCookie?.();
  if (setCookies && setCookies.length > 0) {
    return setCookies;
  }

  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function backendOrigin(): string {
  return process.env.PUBLIC_BACKEND_ORIGIN ?? "http://127.0.0.1:3000";
}
