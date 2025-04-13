const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const translate = require('google-translate-api-x');
const langdetect = require('langdetect');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Function to log chat messages
const logChat = (messageData) => {
  const logFilePath = './chatLogs.json';

  if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, JSON.stringify([]));
  }

  const logData = JSON.parse(fs.readFileSync(logFilePath, 'utf-8'));
  logData.push(messageData);
  fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2));
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
      if (shouldReconnect) {
        startSock();
      }
    } else if (connection === 'open') {
      console.log('✅ connected to WhatsApp');
    }
  });

  const cache = {}; // simple in-memory cache

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    // ✅ voice message handling
    if (msg.message.audioMessage) {
     
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

        const detectedLanguage = langdetect.detect(text)[0]?.lang;

        if (detectedLanguage === 'en') {
          await sock.sendMessage(from, { text: `No translation needed, text already in english: ${text}` });
          return;
        }

        if (cache[text]) {
          await sock.sendMessage(from, { text: `🈶 Translated:\n${cache[text]}` });
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        const res = await translate(text, { from: 'zh-CN', to: 'en' });
        const translated = res.text;

        const translatedData = {
          sender: 'Bot',
          timestamp: new Date().toISOString(),
          message: translated,
          type: 'translated'
        };
        logChat(translatedData);

        cache[text] = translated;

        await sock.sendMessage(from, { text: `🈶 Translated:\n${translated}` });
      } catch (err) {
        await sock.sendMessage(from, { text: '❌ Failed to translate. Try again later.' });
        console.error('Translation error:', err);
      }
    }
  });
}

startSock();