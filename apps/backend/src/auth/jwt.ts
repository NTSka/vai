import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { TokenSession } from "./types.js";

type JwtPayload = TokenSession & {
  readonly typ: "access" | "refresh";
  readonly iat: number;
  readonly exp: number;
};

export type JwtIssuer = {
  issuePair(userId: string): {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly accessMaxAgeSeconds: number;
    readonly refreshMaxAgeSeconds: number;
  };
  verifyAccess(token: string): TokenSession | undefined;
  verifyRefresh(token: string): TokenSession | undefined;
};

export function createJwtIssuer(input: {
  readonly accessSecret: string;
  readonly refreshSecret: string;
  readonly accessMaxAgeSeconds?: number;
  readonly refreshMaxAgeSeconds?: number;
  readonly now?: () => Date;
}): JwtIssuer {
  const accessMaxAgeSeconds = input.accessMaxAgeSeconds ?? 15 * 60;
  const refreshMaxAgeSeconds = input.refreshMaxAgeSeconds ?? 30 * 24 * 60 * 60;
  const now = input.now ?? (() => new Date());

  return {
    issuePair(userId) {
      const sessionId = randomUUID();
      const issuedAt = Math.floor(now().getTime() / 1000);

      return {
        accessToken: sign(
          {
            userId,
            sessionId,
            typ: "access",
            iat: issuedAt,
            exp: issuedAt + accessMaxAgeSeconds
          },
          input.accessSecret
        ),
        refreshToken: sign(
          {
            userId,
            sessionId,
            typ: "refresh",
            iat: issuedAt,
            exp: issuedAt + refreshMaxAgeSeconds
          },
          input.refreshSecret
        ),
        accessMaxAgeSeconds,
        refreshMaxAgeSeconds
      };
    },
    verifyAccess(token) {
      return verify(token, input.accessSecret, "access", now);
    },
    verifyRefresh(token) {
      return verify(token, input.refreshSecret, "refresh", now);
    }
  };
}

function sign(payload: JwtPayload, secret: string): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode(payload);
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

function verify(
  token: string,
  secret: string,
  expectedType: "access" | "refresh",
  now: () => Date
): TokenSession | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  const [header, body, signature] = parts as [string, string, string];
  const expectedSignature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return undefined;
  }

  const payload = decode(body);
  if (!isJwtPayload(payload) || payload.typ !== expectedType) {
    return undefined;
  }

  const nowSeconds = Math.floor(now().getTime() / 1000);
  if (payload.exp <= nowSeconds) {
    return undefined;
  }

  return {
    userId: payload.userId,
    sessionId: payload.sessionId
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isJwtPayload(value: unknown): value is JwtPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<JwtPayload>;
  return (
    typeof payload.userId === "string" &&
    typeof payload.sessionId === "string" &&
    (payload.typ === "access" || payload.typ === "refresh") &&
    typeof payload.iat === "number" &&
    typeof payload.exp === "number"
  );
}
