// Conversión de vídeo -> sticker animado (WebP) + audio (nota de voz OGG/Opus) con ffmpeg.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebP from 'node-webpmux';

const run = promisify(execFile);

export const MAX_STICKER_SECONDS = 10;
export const DEFAULT_STICKER_SECONDS = 8;
// WhatsApp rechaza stickers animados demasiado pesados; 500 KB es el límite recomendado.
const MAX_STICKER_BYTES = 500 * 1024;

/** ¿Tiene el archivo una pista de audio? */
export async function hasAudio(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', file,
  ]);
  return stdout.trim().length > 0;
}

/** Recorta el vídeo y lo convierte en WebP animado de 512x512 con fondo transparente. */
async function encodeSticker(input, output, { start, duration, fps, quality }) {
  const vf = [
    `fps=${fps}`,
    'scale=512:512:force_original_aspect_ratio=decrease',
    'format=rgba',
    'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0.0',
  ].join(',');
  await run('ffmpeg', [
    '-y', '-ss', String(start), '-t', String(duration), '-i', input,
    '-vf', vf, '-an',
    '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(quality),
    '-compression_level', '6', '-loop', '0', '-fps_mode', 'passthrough',
    output,
  ]);
  return readFile(output);
}

/** Genera el sticker, bajando calidad/fps hasta que quepa en el límite de tamaño. */
export async function videoToSticker(input, workdir, { start = 0, duration = DEFAULT_STICKER_SECONDS } = {}) {
  const attempts = [
    { fps: 15, quality: 60 },
    { fps: 12, quality: 45 },
    { fps: 10, quality: 35 },
    { fps: 10, quality: 25 },
    { fps: 8, quality: 15 },
  ];
  let webp;
  for (const [i, a] of attempts.entries()) {
    webp = await encodeSticker(input, path.join(workdir, `sticker${i}.webp`), { start, duration, ...a });
    if (webp.length <= MAX_STICKER_BYTES) return webp;
  }
  // Último recurso: acortar a la mitad.
  return encodeSticker(input, path.join(workdir, 'sticker_short.webp'), {
    start, duration: Math.max(1, duration / 2), fps: 8, quality: 15,
  });
}

/** Extrae el audio del mismo tramo como OGG/Opus mono (formato de notas de voz de WhatsApp). */
export async function videoToVoiceNote(input, workdir, { start = 0, duration } = {}) {
  const output = path.join(workdir, 'audio.ogg');
  const args = ['-y', '-ss', String(start)];
  if (duration) args.push('-t', String(duration));
  args.push('-i', input, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', output);
  await run('ffmpeg', args);
  return readFile(output);
}

/** Añade los metadatos de paquete/autor que muestra WhatsApp al abrir el sticker. */
export async function addStickerMetadata(webpBuffer, { pack = 'Botstick', author = 'Botstick' } = {}) {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': `botstick-${Date.now()}`,
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    emojis: ['🎬'],
  }), 'utf8');
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const exif = Buffer.concat([exifHeader, json]);
  exif.writeUIntLE(json.length, 14, 4);

  const img = new WebP.Image();
  await img.load(webpBuffer);
  img.exif = exif;
  return img.save(null);
}

/**
 * Procesa un vídeo completo: devuelve { sticker, audio } (audio = null si el vídeo no tiene sonido).
 */
export async function processVideo(videoBuffer, { start = 0, duration = DEFAULT_STICKER_SECONDS, withAudio = true, pack, author } = {}) {
  const workdir = await mkdtemp(path.join(tmpdir(), 'botstick-'));
  try {
    const input = path.join(workdir, 'input.mp4');
    await writeFile(input, videoBuffer);
    const raw = await videoToSticker(input, workdir, { start, duration });
    const sticker = await addStickerMetadata(raw, { pack, author });
    let audio = null;
    if (withAudio && await hasAudio(input)) {
      audio = await videoToVoiceNote(input, workdir, { start, duration });
    }
    return { sticker, audio };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/**
 * Interpreta el texto del mensaje. Formatos aceptados:
 *   !s                -> desde 0 s, 8 s
 *   !s 3              -> desde el segundo 3
 *   !s 3 5            -> desde el segundo 3, durante 5 s
 *   !s 1:05 4         -> desde 1 min 5 s, durante 4 s
 *   ... sinaudio      -> solo el sticker
 */
export function parseCommand(text = '') {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const isCommand = ['!s', '!sticker', '/s', '/sticker', '.s'].includes(words[0]);
  const rest = isCommand ? words.slice(1) : words;
  const withAudio = !rest.some((w) => ['sinaudio', 'mute', 'noaudio'].includes(w));
  const nums = rest.map(toSeconds).filter((n) => n !== null);
  const start = nums[0] ?? 0;
  const duration = Math.min(Math.max(nums[1] ?? DEFAULT_STICKER_SECONDS, 0.5), MAX_STICKER_SECONDS);
  return { isCommand, start, duration, withAudio };
}

function toSeconds(word) {
  if (/^\d+(\.\d+)?$/.test(word)) return Number(word);
  const m = word.match(/^(\d+):(\d{1,2})(\.\d+)?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3] ?? 0);
  return null;
}
