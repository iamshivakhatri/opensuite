/** Return a readable solid text color for a six-digit hex background. */
export function readableTextColor(background: string | undefined): '000000' | 'FFFFFF' | undefined {
  if (!background || !/^(?:#)?[0-9a-f]{6}$/i.test(background)) return undefined;
  const value = background.replace('#', '');
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  return luminance > 0.179 ? '000000' : 'FFFFFF';
}
