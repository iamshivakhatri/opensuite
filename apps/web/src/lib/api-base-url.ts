/**
 * Public API origin from `NEXT_PUBLIC_API_URL`.
 * Strips a trailing slash so `${base}/health` never becomes `//health`
 * (which triggers 308 redirects / CORS failures behind Cloudflare).
 */
export function resolveApiBaseUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_API_URL,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}
