import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: err instanceof Error ? err.message : "Internal server error",
  });
};
