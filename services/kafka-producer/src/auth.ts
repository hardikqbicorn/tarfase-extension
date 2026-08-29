import jwt from "jsonwebtoken";

export interface InstallationClaims {
  /** Subject = installation_id. */
  sub: string;
  user_id: string;
  ide_name?: string;
  iat?: number;
  exp?: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: 401 | 403 = 401
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Verifies the installation bearer token issued by the API service.
 * Tokens are signed with HS256 using a secret shared between the API and
 * ingestion services (rotate via JWT_SECRET; in a multi-tenant deployment,
 * swap for asymmetric RS256 and publish a JWKS endpoint).
 */
export function verifyInstallationToken(
  authorizationHeader: string | undefined,
  secret: string
): InstallationClaims {
  if (!authorizationHeader) {
    throw new AuthError("Missing Authorization header");
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    throw new AuthError("Malformed Authorization header");
  }

  try {
    const decoded = jwt.verify(match[1], secret, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || !decoded.sub || !(decoded as any).user_id) {
      throw new AuthError("Token missing required claims");
    }
    return decoded as unknown as InstallationClaims;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Invalid or expired installation token");
  }
}
