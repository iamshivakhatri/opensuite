/**
 * Parse a Content-Disposition attachment filename for browser downloads.
 */
export function filenameFromContentDisposition(
  header: string | null,
): string | undefined {
  if (!header) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // fall through
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1];
}
