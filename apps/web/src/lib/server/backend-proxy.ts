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
    const body =
      method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    const response = await fetch(target, {
      method,
      headers,
      body,
      redirect: "manual"
    });

    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!hopByHopHeaders.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  };
}

function backendOrigin(): string {
  return process.env.PUBLIC_BACKEND_ORIGIN ?? "http://127.0.0.1:3000";
}
