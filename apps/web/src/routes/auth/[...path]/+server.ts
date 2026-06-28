import { backendProxy } from "$lib/server/backend-proxy";

const proxy = backendProxy("/auth");

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
