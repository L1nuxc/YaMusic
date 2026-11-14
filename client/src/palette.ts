export type RGB = [number, number, number];
export interface Palette { primary: RGB; secondary: RGB }
export const neutralPalette: Palette = { primary: [146, 158, 179], secondary: [131, 140, 158] };

/** Quantized dominant colors keep small highlights from overpowering the album's tone. */
export function paletteFromPixels(pixels: Uint8ClampedArray): Palette {
  const bins = new Map<number, { count: number; sum: RGB }>();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 180) continue;
    const rgb: RGB = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const brightness = rgb.reduce((a, b) => a + b, 0) / 3;
    if (brightness < 24 || brightness > 237) continue;
    const key = (rgb[0] >> 5) * 64 + (rgb[1] >> 5) * 8 + (rgb[2] >> 5);
    const bin = bins.get(key) ?? { count: 0, sum: [0, 0, 0] as RGB };
    bin.count++; rgb.forEach((value, channel) => bin.sum[channel] += value); bins.set(key, bin);
  }
  const colors = [...bins.values()].sort((a, b) => b.count - a.count)
    .map(bin => bin.sum.map(value => Math.round(value / bin.count)) as RGB);
  if (!colors.length) return neutralPalette;
  const primary = colors[0];
  const secondary = colors.find(color => color.reduce((sum, value, i) => sum + Math.abs(value - primary[i]), 0) > 95) ?? primary;
  return { primary, secondary };
}

const cache = new Map<string, Palette>();
export async function coverPalette(url: string): Promise<Palette> {
  if (!url) return neutralPalette;
  const cached = cache.get(url); if (cached) return cached;
  try {
    const image = new Image(); image.crossOrigin = 'anonymous'; image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => { image.src = ''; reject(new Error('cover timeout')); }, 6000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error('cover unavailable')); };
      image.src = url;
    });
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return neutralPalette;
    context.drawImage(image, 0, 0, 32, 32);
    const palette = paletteFromPixels(context.getImageData(0, 0, 32, 32).data);
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(url, palette); return palette;
  } catch { return neutralPalette; } // Covers without CORS permission must never affect audio playback.
}
