import helmet from "helmet";
import cors from "cors";
import type { CorsOptions } from "cors";
import type { Application, Request, Response } from "express";
import type { AppError } from "../types/api";

const ALLOWED_ORIGINS = new Set([
  // Dev
  "https://danceup-users-dev--dev-danceup.us-east4.hosted.app",
  "https://danceup-studio-owners-dev--dev-danceup.us-east4.hosted.app",
  // Staging
  "https://danceup-users-staging--staging-danceup.us-east4.hosted.app",
  "https://danceup-studio-owners--staging-danceup.us-east4.hosted.app",
  // Production
  "https://danceup-users-production--production-danceup.us-east4.hosted.app",
  "https://danceup-studio-owners--production-danceup.us-east4.hosted.app",
]);

export function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
    return true;
  }
  return ALLOWED_ORIGINS.has(origin);
}

const CORS_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;
const CORS_ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-Requested-With"] as const;
const CORS_EXPOSED_HEADERS = ["Content-Type", "Authorization"] as const;

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed by CORS policy`));
  },
  credentials: true,
  methods: [...CORS_METHODS],
  allowedHeaders: [...CORS_ALLOWED_HEADERS],
  exposedHeaders: [...CORS_EXPOSED_HEADERS],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

export function handleCorsPreflight(req: Request, res: Response): boolean {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
    }
    res.set("Access-Control-Allow-Methods", CORS_METHODS.join(", "));
    res.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS.join(", "));
    res.set("Access-Control-Max-Age", "3600");
    res.status(204).send("");
    return true;
  }
  return false;
}

export function setCorsHeaders(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
  }
  res.set("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS.join(", "));
}

export function sendJsonResponse(req: Request, res: Response, statusCode: number, data: unknown): void {
  setCorsHeaders(req, res);
  res.status(statusCode).json(data);
}

export function sendErrorResponse(
  req: Request,
  res: Response,
  statusCode: number,
  error: string,
  message: string,
  additionalData: Record<string, unknown> = {},
): void {
  setCorsHeaders(req, res);
  const { stack: _stack, ...safeData } = additionalData;
  const response: Record<string, unknown> = { error, message, ...safeData };
  if (process.env["NODE_ENV"] === "development" && _stack) {
    response["stack"] = _stack;
  }
  res.status(statusCode).json(response);
}

export function handleError(req: Request, res: Response, error: unknown): void {
  const err = error as AppError;
  console.error("Unhandled error:", err instanceof Error ? err.message : String(err));

  if (err.status) {
    return sendErrorResponse(req, res, err.status, err.error ?? "Error", err.message ?? "An error occurred");
  }

  if (err.name === "ValidationError" || err.message?.includes("Validation")) {
    return sendErrorResponse(req, res, 400, "Validation Error", err.message ?? "Invalid input", {
      errors: (err as AppError & { errors?: unknown[] }).errors ?? [],
    });
  }

  sendErrorResponse(req, res, 500, "Internal Server Error", "An unexpected error occurred", {
    stack: err.stack,
  });
}

export function extractPathParams(url: string, pattern: string): Record<string, string> | null {
  const path = url.split("?")[0] ?? "";
  const patternParts = pattern.split("/").filter((p) => p);
  const urlParts = path.split("/").filter((p) => p);

  if (patternParts.length !== urlParts.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i] ?? "";
    const up = urlParts[i] ?? "";
    if (pp.startsWith(":")) {
      params[pp.substring(1)] = up;
    } else if (pp !== up) {
      return null;
    }
  }

  return params;
}

export function applySecurityMiddleware(app: Application): void {
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: false,
    }),
  );
}

export { cors };
