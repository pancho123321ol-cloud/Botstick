import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebP from 'node-webpmux';
import { processVideo, parseCommand } from '../src/media.js';

function makeVideo({ audio = true, seconds = 12, size = '1280x720' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'botstick-test-'));
  const out = path.join(dir, 'v.mp4');
  const args = ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac');
  args.push(out);
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
  const buf = readFileSync(out);
  rmSync(dir, { recursive: true, force: true });
  return buf;
}

function probe(buf, ext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'botstick-probe-'));
  const f = path.join(dir, `x.${ext}`);
  execFileSync('sh', ['-c', 'cat > "$0"', f], { input: buf });
  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]));
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test('vídeo con audio -> sticker animado 512x512 + nota de voz opus', async () => {
  const { sticker, audio } = await processVideo(makeVideo(), { start: 2, duration: 5, pack: 'P', author: 'A' });
  assert.equal(sticker.subarray(0, 4).toString(), 'RIFF');
  assert.equal(sticker.subarray(8, 12).toString(), 'WEBP');
  assert.ok(sticker.length <= 500 * 1024, `sticker demasiado grande: ${sticker.length}`);
  const img = new WebP.Image();
  await img.load(sticker);
  assert.ok(img.hasAnim, 'debe ser animado');
  assert.ok(img.frames.length > 10);
  assert.equal(img.width, 512);
  assert.equal(img.height, 512);
  assert.match(img.exif.toString('utf8'), /"sticker-pack-name":"P"/);

  assert.ok(audio);
  const info = probe(audio, 'ogg');
  assert.equal(info.streams[0].codec_name, 'opus');
  assert.equal(info.streams[0].channels, 1);
  assert.ok(Math.abs(Number(info.format.duration) - 5) < 0.3, `duración ${info.format.duration}`);
});

test('vídeo sin audio -> solo sticker', async () => {
  const { sticker, audio } = await processVideo(makeVideo({ audio: false, seconds: 3, size: '480x854' }));
  assert.equal(sticker.subarray(8, 12).toString(), 'WEBP');
  assert.equal(audio, null);
});

test('parseCommand', () => {
  assert.deepEqual(parseCommand(''), { isCommand: false, start: 0, duration: 8, withAudio: true });
  assert.deepEqual(parseCommand('!s 3 5'), { isCommand: true, start: 3, duration: 5, withAudio: true });
  assert.deepEqual(parseCommand('!S 1:05 4 sinaudio'), { isCommand: true, start: 65, duration: 4, withAudio: false });
  assert.equal(parseCommand('!s 0 60').duration, 10);
  assert.equal(parseCommand('hola').isCommand, false);
});
