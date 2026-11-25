# Botstick 🎬

Bot de WhatsApp que convierte los vídeos que le envías en **stickers animados** y te devuelve el **audio** de ese mismo tramo como nota de voz.

> WhatsApp no permite stickers con sonido, así que el bot envía dos mensajes: el sticker animado y, justo después, la nota de voz con su audio.

## Requisitos

- [Node.js](https://nodejs.org) 20 o superior
- [ffmpeg](https://ffmpeg.org) (con `libwebp` y `libopus`, incluidos en las versiones normales)
  - Windows: `winget install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`
- Un número de WhatsApp para el bot (se recomienda uno secundario)

## Instalación

```bash
git clone <este repo>
cd Botstick
npm install
npm start
```

Aparecerá un **código QR** en la terminal. En el móvil del bot: WhatsApp → *Dispositivos vinculados* → *Vincular un dispositivo* y escanéalo.

Si prefieres un código en vez del QR:

```bash
PHONE_NUMBER=5215512345678 npm start   # número con prefijo de país, sin "+"
```

La sesión se guarda en la carpeta `auth/`; no hace falta volver a vincular cada vez.

## Uso

Desde otro número, envía un vídeo (o GIF) al bot en un chat privado y recibirás el sticker + el audio.

| Mensaje (texto del vídeo, o respuesta a un vídeo) | Resultado |
|---|---|
| *(nada)* | primeros 8 segundos |
| `!s 3` | empezando en el segundo 3 |
| `!s 1:05 4` | desde 1:05, durante 4 s (máx. 10 s) |
| `!s sinaudio` | solo el sticker |
| `!ayuda` | muestra la ayuda |

En **grupos** el bot solo responde si el vídeo lleva `!s` en el texto o si respondes a un vídeo con `!s`.

## Configuración (variables de entorno)

| Variable | Por defecto | Descripción |
|---|---|---|
| `STICKER_PACK` | `Botstick` | Nombre del paquete que muestra el sticker |
| `STICKER_AUTHOR` | `Botstick` | Autor que muestra el sticker |
| `MAX_VIDEO_MB` | `50` | Tamaño máximo de vídeo aceptado |
| `PHONE_NUMBER` | — | Vincular con código en lugar de QR |
| `AUTH_DIR` | `auth` | Carpeta donde se guarda la sesión |
| `LOG_LEVEL` | `warn` | Nivel de logs (`info`, `debug`…) |

## Cómo funciona

- Conexión a WhatsApp Web con [Baileys](https://github.com/WhiskeySockets/Baileys).
- `ffmpeg` recorta el tramo, lo escala a 512×512 con fondo transparente y lo codifica como WebP animado; si pasa de 500 KB baja calidad y fps automáticamente.
- El audio se extrae del mismo tramo en OGG/Opus mono (formato de nota de voz).

## Tests

```bash
npm test
```

## Aviso

Baileys no es una API oficial de WhatsApp. Usarlo puede infringir los términos de servicio y WhatsApp puede bloquear el número; usa un número secundario y no envíes spam.
