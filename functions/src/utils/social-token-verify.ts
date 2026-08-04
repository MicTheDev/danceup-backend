import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

// Web (client_type 3) OAuth client per environment — google_sign_in on both
// iOS and Android is configured with this as its `serverClientId`, so the
// ID token's `aud` claim is always this value regardless of platform.
const GOOGLE_WEB_CLIENT_IDS: Record<string, string> = {
  dev: "988466211229-u7ic3i2av5ktuuq8vqge1brkuea5773m.apps.googleusercontent.com",
  staging: "1038969677041-8sa4907rkpo7ai1h5ir6plh4qrcoj3n1.apps.googleusercontent.com",
  production: "925139874275-20gj22afnd44p5ecbfu89um7sqidbb95.apps.googleusercontent.com",
};

// Sign In with Apple is configured per-app (Bundle ID), not per-environment —
// the same value applies across dev/staging/production since it's tied to
// the App ID, not a Firebase project.
const APPLE_AUDIENCE = "com.danceup.danceupUsers";
const APPLE_ISSUER = "https://appleid.apple.com";

function currentEnv(): "dev" | "staging" | "production" {
  const projectId = process.env["GCLOUD_PROJECT"] ?? process.env["GCP_PROJECT"] ?? "";
  if (projectId.includes("production")) return "production";
  if (projectId.includes("staging")) return "staging";
  return "dev";
}

const googleClient = new OAuth2Client();

export interface VerifiedSocialToken {
  email: string;
  firstName: string;
  lastName: string;
  picture?: string | null;
}

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedSocialToken> {
  const audience = GOOGLE_WEB_CLIENT_IDS[currentEnv()];
  const ticket = await googleClient.verifyIdToken({ idToken, audience });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new Error("Google ID token missing required claims");
  }
  const nameParts = (payload.name || "").trim().split(" ");
  return {
    email: payload.email,
    firstName: nameParts[0] || "",
    lastName: nameParts.slice(1).join(" ") || "",
    picture: payload.picture || null,
  };
}

const appleJwks = jwksClient({
  jwksUri: "https://appleid.apple.com/auth/keys",
  cache: true,
  cacheMaxAge: 60 * 60 * 1000, // 1 hour
});

function getAppleSigningKey(header: jwt.JwtHeader, callback: (err: Error | null, key?: string) => void): void {
  if (!header.kid) {
    callback(new Error("Apple ID token missing 'kid' header"));
    return;
  }
  appleJwks.getSigningKey(header.kid, (err, key) => {
    if (err || !key) {
      callback(err ?? new Error("Unable to resolve Apple signing key"));
      return;
    }
    callback(null, key.getPublicKey());
  });
}

/**
 * Apple only sends the user's name on the very first authorization ever —
 * the client must capture `fullName` from the native AuthorizationCredential
 * on first sign-in and pass it through here, since it's never in the token
 * itself and never resent on subsequent sign-ins.
 */
export async function verifyAppleIdToken(
  idToken: string,
  fallbackName?: { firstName?: string; lastName?: string }
): Promise<VerifiedSocialToken> {
  // Fail fast on empty/malformed input with a distinct error rather than
  // letting it reach jwt.verify() and come back as an opaque "jwt malformed"
  // — seen in production from a client that hadn't yet guarded against
  // Apple's native bridge returning an empty string instead of nil for
  // identityToken. Older app versions can still send this, so this check
  // stays even though the client now guards against it too.
  if (!idToken || idToken.split(".").length !== 3) {
    throw new Error("Apple ID token is empty or malformed");
  }

  const payload = await new Promise<jwt.JwtPayload>((resolve, reject) => {
    jwt.verify(
      idToken,
      getAppleSigningKey,
      { algorithms: ["RS256"], audience: APPLE_AUDIENCE, issuer: APPLE_ISSUER },
      (err, decoded) => {
        if (err || !decoded || typeof decoded === "string") {
          reject(err ?? new Error("Invalid Apple ID token"));
          return;
        }
        resolve(decoded);
      }
    );
  });

  const email = payload["email"] as string | undefined;
  if (!email) {
    throw new Error("Apple ID token missing required claims");
  }

  return {
    email,
    firstName: fallbackName?.firstName?.trim() || "",
    lastName: fallbackName?.lastName?.trim() || "",
    picture: null,
  };
}
