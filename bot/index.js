// === import dependencies ===
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const langdetect = require('langdetect');
const fs = require('fs');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fetch = require('node-fetch');

// === ffmpeg setup ===
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// === chat logger ===
const logChat = (messageData) => {
  const logFilePath = './chatLogs.json';
  if (!fs.existsSync(logFilePath)) fs.writeFileSync(logFilePath, JSON.stringify([]));
  const logData = JSON.parse(fs.readFileSync(logFilePath, 'utf-8'));
  logData.push(messageData);
  fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2));
};

// === translation ===
const translateWithRetry = async (text, fromLang, toLang, maxRetries = 5, delayTime = 5000) => {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${fromLang}&tl=${toLang}&dt=t&q=${encodeURIComponent(text)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Translation failed');
      const data = await res.json();
      return data[0]?.[0]?.[0] || '';
    } catch (err) {
      retries++;
      if (retries < maxRetries) {
        console.log(`Retrying translation... Attempt ${retries}`);
        await new Promise(resolve => setTimeout(resolve, delayTime));
      } else {
        throw new Error('Max retries reached for translation');
      }
    }
  }
};

// === whatsapp bot setup ===
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
      console.log('Connection closed:', lastDisconnect?.error, ', reconnecting:', shouldReconnect);
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

    // === voice message handling ===
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
            .on('error', reject)
            .save(mp3Path);
        });

        exec(`python transcribe.py "${mp3Path}"`, async (err, stdout) => {
          if (err) {
            console.error('❌ Transcription error:', err);
            await sock.sendMessage(from, { text: '❌ Failed to transcribe voice message.' });
            return;
          }

          const transcription = stdout.trim();
          console.log('📝 Transcribed:', transcription);
          let lang = 'en';
          const detectedLang = langdetect.detect(transcription);
          if (detectedLang.length > 0) lang = detectedLang[0]?.lang || 'en';
          if (lang === 'zh-tw') lang = 'zh-CN';

          try {
            const translated = lang !== 'en'
              ? await translateWithRetry(transcription, lang, 'en')
              : transcription;

            await sock.sendMessage(from, {
              text: `🈶 translated:\n${translated}`
            });
          } catch (err) {
            await sock.sendMessage(from, {
              text: `📝 Transcribed:\n${transcription}\n⚠️ But failed to translate.`
            });
          }
        });
      } catch (err) {
        console.error('❌ Voice error:', err);
        await sock.sendMessage(from, { text: '❌ Failed to process voice message.' });
      }
    }

    // === text message handling ===
    if (text) {
      try {
        logChat({ sender: from, timestamp: new Date().toISOString(), message: text, type: 'original' });

        let detectedLang = langdetect.detect(text)[0]?.lang || 'auto';
        if (detectedLang === 'zh-tw') detectedLang = 'zh-CN';

        if (detectedLang === 'en') {
          await sock.sendMessage(from, { text: '✅ Message is already in English.' });
          return;
        }

        if (cache[text]) {
          await sock.sendMessage(from, { text: `🈶 translated:\n${cache[text]}` });
          return;
        }

        await new Promise(r => setTimeout(r, 1000));
        const translated = await translateWithRetry(text, detectedLang, 'en');

        logChat({ sender: 'Bot', timestamp: new Date().toISOString(), message: translated, type: 'translated' });
        cache[text] = translated;

        await sock.sendMessage(from, { text: `🈶 translated:\n${translated}` });
      } catch (err) {
        console.error('❌ Text translation error:', err);
        await sock.sendMessage(from, { text: '❌ Failed to translate text.' });
      }
    }
  });
}

// === start bot ===
startSock();

// === keep Render "alive" ===
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_, res) => res.send('✅ Bot is running!'));
app.listen(port, () => console.log(`🌐 Server listening on port ${port}`));
