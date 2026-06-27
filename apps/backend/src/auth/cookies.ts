export const accessTokenCookieName = "vai_access_token";
export const refreshTokenCookieName = "vai_refresh_token";

export function readCookie(
  cookieHeader: string | string[] | undefined,
  name: string
): string | undefined {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (!header) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return undefined;
}

export function serializeAuthCookie(input: {
  readonly name: string;
  readonly value: string;
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
}): string {
  return [
    `${input.name}=${encodeURIComponent(input.value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${input.maxAgeSeconds}`,
    ...(input.secure ? ["Secure"] : [])
  ].join("; ");
}

export function serializeClearedCookie(input: {
  readonly name: string;
  readonly secure: boolean;
}): string {
  return [
    `${input.name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(input.secure ? ["Secure"] : [])
  ].join("; ");
}
