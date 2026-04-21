import * as admin from "firebase-admin";
import type { Request } from "express";
import type { AppError, DecodedToken } from "../types/api";

/**
 * Verify Firebase ID token from Authorization header.
 * @throws {AppError} If token is missing or invalid
 */
export async function verifyToken(req: Request): Promise<DecodedToken> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    const error = new Error("Missing or invalid authorization header") as AppError;
    error.status = 401;
    error.error = "Unauthorized";
    throw error;
  }

  const idToken = authHeader.split("Bearer ")[1] ?? "";

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return {
      uid: decodedToken.uid,
      email: decodedToken.email ?? "",
      emailVerified: decodedToken.email_verified ?? false,
    };
  } catch (err) {
    console.error("Error verifying ID token:", err);
    const authError = new Error("Invalid or expired token") as AppError;
    authError.status = 401;
    authError.error = "Unauthorized";
    throw authError;
  }
}
