/**
 * resolve the Pullfrog API base URL.
 *
 * in the action: API_URL is not explicitly set, so this falls back to https://pullfrog.com.
 * in local dev: API_URL=http://localhost:3000 (from .env).
 */
export function getApiUrl(): string {
  return process.env.API_URL || "https://pullfrog.com";
}
