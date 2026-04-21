import type { Request } from "express";

export interface DecodedToken {
  uid: string;
  email: string;
  emailVerified: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: DecodedToken;
}

export interface AppError extends Error {
  status?: number;
  error?: string;
}

export interface ApiResponse<T> {
  data: T;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

export interface ValidationErrors {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}
