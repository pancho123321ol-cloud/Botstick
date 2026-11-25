// Botstick: bot de WhatsApp que convierte los vídeos que recibe en
// stickers animados y devuelve el audio del mismo tramo como nota de voz.
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { processVideo, parseCommand, MAX_STICKER_SECONDS } from './media.js';

const AUTH_DIR = process.env.AUTH_DIR || 'auth';
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
const PACK_NAME = process.env.STICKER_PACK || 'Botstick';
const PACK_AUTHOR = process.env.STICKER_AUTHOR || 'Botstick';
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 50);

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const HELP = `🎬 *Botstick*
Mándame un vídeo (o GIF) y te devuelvo:
  1️⃣ un *sticker animado* con el vídeo
  2️⃣ una *nota de voz* con su audio

Opciones (en el texto del vídeo, o respondiendo a un vídeo):
  *!s* → los primeros 8 s
  *!s 3* → empezando en el segundo 3
  *!s 1:05 4* → desde 1:05, durante 4 s (máx. ${MAX_STICKER_SECONDS} s)
  *!s sinaudio* → solo el sticker

En grupos solo respondo si el vídeo lleva *!s* o si respondes a un vídeo con *!s*.
ℹ️ WhatsApp no permite stickers con sonido, por eso el audio llega aparte.`;

// Procesa los vídeos de uno en uno para no saturar la CPU con varios ffmpeg.
let queue = Promise.resolve();
const enqueue = (job) => (queue = queue.then(job).catch((err) => logger.error(err)));

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu('Botstick'),
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  if (PHONE_NUMBER && !sock.authState.creds.registered) {
    // Vinculación con código en lugar de QR.
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log(`\n🔑 Código de vinculación: ${code}`);
        console.log('WhatsApp → Dispositivos vinculados → Vincular con número de teléfono\n');
      } catch (err) {
        console.error('No se pudo pedir el código de vinculación:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !PHONE_NUMBER) {
      console.log('\n📱 Escanea este QR en WhatsApp → Dispositivos vinculados:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('✅ Botstick conectado. Envíale un vídeo.');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log(`❌ Sesión cerrada. Borra la carpeta "${AUTH_DIR}" y vuelve a vincular.`);
        process.exit(1);
      }
      console.log('🔄 Conexión perdida, reconectando…');
      setTimeout(start, 2000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      enqueue(() => handleMessage(sock, msg));
    }
  });
}

/** Busca un vídeo en el mensaje o en el mensaje al que responde. */
function findVideo(msg, content) {
  const direct = content.videoMessage;
  if (direct) return { video: direct, source: msg, text: direct.caption || '' };

  const text = content.extendedTextMessage?.text || content.conversation || '';
  const ctx = content.extendedTextMessage?.contextInfo;
  const quoted = normalizeMessageContent(ctx?.quotedMessage);
  if (quoted?.videoMessage) {
    const source = {
      key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant },
      message: quoted,
    };
    return { video: quoted.videoMessage, source, text, quotedReply: true };
  }
  return { video: null, text };
}

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const content = normalizeMessageContent(msg.message);
  if (!content) return;

  const { video, source, text, quotedReply } = findVideo(msg, content);
  const cmd = parseCommand(text);
  const firstWord = text.trim().toLowerCase().split(/\s+/)[0];

  if (['!ayuda', '!help', '/help', '/ayuda', '!menu'].includes(firstWord)) {
    await sock.sendMessage(jid, { text: HELP }, { quoted: msg });
    return;
  }

  if (!video) {
    if (!isGroup && cmd.isCommand) {
      await sock.sendMessage(jid, { text: 'Envíame un vídeo con *!s* o responde a un vídeo con *!s*. Escribe *!ayuda* para más info.' }, { quoted: msg });
    }
    return;
  }

  // En grupos solo se actúa con comando explícito; al responder a un vídeo siempre hace falta comando.
  if ((isGroup || quotedReply) && !cmd.isCommand) return;

  const sizeMb = Number(video.fileLength || 0) / (1024 * 1024);
  if (sizeMb > MAX_VIDEO_MB) {
    await sock.sendMessage(jid, { text: `⚠️ El vídeo pesa ${sizeMb.toFixed(1)} MB; el máximo es ${MAX_VIDEO_MB} MB.` }, { quoted: msg });
    return;
  }
  if (video.seconds && cmd.start >= video.seconds) {
    await sock.sendMessage(jid, { text: `⚠️ El vídeo dura ${video.seconds} s; no puedo empezar en el segundo ${cmd.start}.` }, { quoted: msg });
    return;
  }

  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
  try {
    const buffer = await downloadMediaMessage(source, 'buffer', {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    });
    const { sticker, audio } = await processVideo(buffer, {
      start: cmd.start,
      duration: cmd.duration,
      withAudio: cmd.withAudio,
      pack: PACK_NAME,
      author: PACK_AUTHOR,
    });

    await sock.sendMessage(jid, { sticker }, { quoted: msg });
    if (audio) {
      await sock.sendMessage(jid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
    } else if (cmd.withAudio) {
      await sock.sendMessage(jid, { text: '🔇 Este vídeo no tiene audio.' }, { quoted: msg });
    }
    await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
  } catch (err) {
    logger.error({ err }, 'Error procesando vídeo');
    await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
    await sock.sendMessage(jid, { text: '❌ No pude convertir ese vídeo. Prueba con otro o con un tramo más corto.' }, { quoted: msg });
  }
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
