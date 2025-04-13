const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const translate = require('google-translate-api-x');
const langdetect = require('langdetect');
const fs = require('fs');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_, res) => res.send('Bot is alive!'));
app.listen(port, () => console.log(`✅ Server running on port ${port}`));

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const logChat = (messageData) => {
  const logFilePath = './chatLogs.json';

  if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, JSON.stringify([]));
  }

  const logData = JSON.parse(fs.readFileSync(logFilePath, 'utf-8'));
  logData.push(messageData);
  fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2));
};

// Retry logic for Google Translate API
const translateWithRetry = async (text, fromLang, toLang, maxRetries = 5, delayTime = 5000) => {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      const res = await translate(text, { from: fromLang, to: toLang, forceFrom: true });
      return res.text;
    } catch (err) {
      if (err.message.includes('Too Many Requests') && retries < maxRetries) {
        retries++;
        console.log(`Retrying translation... Attempt ${retries}`);
        await new Promise(resolve => setTimeout(resolve, delayTime)); // Delay before retrying
      } else {
        throw err;
      }
    }
  }
  throw new Error('Max retries reached for translation');
};

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['Chrome', 'Windows', '10'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error = new Boom(lastDisconnect?.error))?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('connection closed due to', lastDisconnect?.error, ', reconnecting', shouldReconnect);
      if (shouldReconnect) startSock();
    } else if (connection === 'open') {
      console.log('✅ connected to WhatsApp');
    }
  });

  const cache = {};

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    // ✅ voice message handling
    if (msg.message.audioMessage) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
        const oggPath = path.join(__dirname, 'voice.ogg');
        const mp3Path = path.join(__dirname, 'voice.mp3');

        fs.writeFileSync(oggPath, buffer);
        console.log('✅ voice.ogg saved');

        await new Promise((resolve, reject) => {
          ffmpeg(oggPath)
            .toFormat('mp3')
            .on('end', () => {
              console.log('✅ Converted to MP3');
              resolve();
            })
            .on('error', (err) => {
              console.error('❌ Error converting to MP3:', err);
              reject(err);
            })
            .save(mp3Path);
        });

        exec(`python transcribe.py "${mp3Path}"`, async (err, stdout, stderr) => {
          if (err) {
            console.error('❌ Transcribe error:', err);
            await sock.sendMessage(from, { text: '❌ Failed to transcribe voice message.' });
            return;
          }

          const transcription = stdout.trim();
          console.log('📝 Transcribed:', transcription);

          let lang = langdetect.detect(transcription)[0]?.lang || 'en';
          if (lang === 'zh-tw') lang = 'zh-CN';

          try {
            if (lang !== 'en') {
              const translated = await translateWithRetry(transcription, lang, 'en');

              await sock.sendMessage(from, {
                text: `🈶 translated:\n${translated}`
              });
            } else {
              await sock.sendMessage(from, { text: `🈶 translated:\n${transcription}` });
            }
          } catch (translateErr) {
            console.error('❌ Translation failed:', translateErr);
            await sock.sendMessage(from, { text: `📝 Transcribed:\n${transcription}\n⚠️ But failed to translate.` });
          }
        });
      } catch (err) {
        console.error('❌ Voice message error:', err);
        await sock.sendMessage(from, { text: '❌ Failed to process voice message.' });
      }
    }

    // ✅ text message handling
    if (text) {
      try {
        const messageData = {
          sender: from,
          timestamp: new Date().toISOString(),
          message: text,
          type: 'original'
        };
        logChat(messageData);

        let detectedLanguage = langdetect.detect(text)[0]?.lang || 'auto';
        if (detectedLanguage === 'zh-tw') detectedLanguage = 'zh-CN';

        if (detectedLanguage === 'en') {
          await sock.sendMessage(from, {
            text: `🈶 translated:\n${text}`
          });
          return;
        }

        if (cache[text]) {
          await sock.sendMessage(from, {
            text: `🈶 translated:\n${cache[text]}`
          });
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        const translated = await translateWithRetry(text, detectedLanguage, 'en');
        const translatedData = {
          sender: 'Bot',
          timestamp: new Date().toISOString(),
          message: translated,
          type: 'translated'
        };
        logChat(translatedData);

        cache[text] = translated;

        await sock.sendMessage(from, {
          text: `🈶 translated:\n${translated}`
        });
      } catch (err) {
        await sock.sendMessage(from, { text: '❌ Failed to translate. Try again later.' });
        console.error('Translation error:', err);
      }
    }
  });

  // Keep bot alive and handle reconnections periodically
  setInterval(async () => {
    try {
      await sock.ping();
      console.log('🟢 Bot is alive and connected.');
    } catch (error) {
      console.error('❌ Connection lost, trying to reconnect...');
      startSock();
    }
  }, 60000); // Ping every minute to keep the connection alive
}

startSock();
