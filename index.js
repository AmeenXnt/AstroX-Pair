const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('baileys');
const pino = require('pino');
const fs = require('fs-extra');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const qrcode = require('qrcode');
const { upload: uploadToMega } = require('./mega.cjs');
const config = require('./config.cjs');

const app = express();
const port = process.env.PORT || 5000;

const upload = multer({ dest: 'uploads/' });
fs.ensureDirSync('uploads');

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

let sock = null;
let qrCodeData = null;
let connectionState = 'DISCONNECTED';
let sessionId = null;

const shutdownSocket = async () => {
    if (sock) {
        try { await sock.logout(); } catch (_) {
            try { sock.end(); } catch (_) {}
        } finally {
            sock = null;
            qrCodeData = null;
            connectionState = 'DISCONNECTED';
        }
    }
};

const clearAuth = () => {
    try {
        if (fs.existsSync(AUTH_DIR)) fs.removeSync(AUTH_DIR);
    } catch (e) {}
};

const initializeSocket = () => {
    connectionState = 'CONNECTING';
    qrCodeData = null;
    sessionId = null;

    async function connectToWhatsApp() {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        const { version } = await fetchLatestBaileysVersion();
        console.log(`Using WA version: ${version.join('.')}`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'),
            auth: state,
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeData = await qrcode.toDataURL(qr);
                console.log('QR code ready.');
            }

            if (connection === 'open') {
                console.log('WhatsApp connected successfully.');
                connectionState = 'CONNECTED';
                qrCodeData = null;

                // Upload creds to MEGA and get session ID
                setTimeout(async () => {
                    try {
                        const credsPath = path.join(AUTH_DIR, 'creds.json');
                        if (!fs.existsSync(credsPath)) {
                            console.error('creds.json not found for upload.');
                            return;
                        }
                        console.log('Uploading session to MEGA...');
                        const url = await uploadToMega(credsPath);
                        if (url && url.includes('https://mega.nz/file/')) {
                            sessionId = config.PREFIX + url.split('https://mega.nz/file/')[1];
                        } else {
                            sessionId = url || 'Upload failed';
                        }
                        console.log('Session ID generated:', sessionId);

                        // Send session ID to self via WhatsApp
                        await sock.sendMessage(sock.user.id, {
                            text: `*Your Session ID:*\n\n\`${sessionId}\`\n\n_Keep this safe. Do not share it with anyone._`
                        });
                    } catch (err) {
                        console.error('MEGA upload error:', err.message || err);
                        sessionId = 'Upload failed - check MEGA credentials';
                    }
                }, 3000);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log('Connection closed. Reason:', reason);
                if (reason !== DisconnectReason.loggedOut) {
                    console.log('Reconnecting...');
                    initializeSocket();
                } else {
                    connectionState = 'DISCONNECTED';
                    sessionId = null;
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', () => {});
        sock.ev.on('presence.update', () => {});
    }

    connectToWhatsApp().catch((err) => {
        console.error('Socket init error:', err.message || err);
        connectionState = 'ERROR';
    });
};

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/status', (req, res) => {
    res.json({ state: connectionState, qr: qrCodeData, sessionId });
});

app.get('/session-id', (req, res) => {
    if (!sessionId) {
        return res.status(404).json({ sessionId: null, message: 'No session available yet.' });
    }
    res.json({ sessionId });
});

app.get('/connect-qr', async (req, res) => {
    await shutdownSocket();
    clearAuth();
    initializeSocket();
    res.json({ message: 'QR connection initiated.' });
});


app.post('/update-pp', upload.single('profilePic'), async (req, res) => {
    if (connectionState !== 'CONNECTED' || !sock) {
        return res.status(400).json({ success: false, message: 'Not connected to WhatsApp.' });
    }
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image uploaded.' });
    }

    const filePath = req.file.path;
    try {
        const imageBuffer = await fs.readFile(filePath);
        const meta = await sharp(imageBuffer).metadata();
        const min = Math.min(meta.width, meta.height);

        const img = await sharp(imageBuffer)
            .extract({ left: 0, top: 0, width: min, height: min })
            .resize(720, 720, { fit: 'fill' })
            .jpeg({ quality: 90 })
            .toBuffer();

        await sock.query({
            tag: 'iq',
            attrs: { to: sock.user.id, type: 'set', xmlns: 'w:profile:picture' },
            content: [{ tag: 'picture', attrs: { type: 'image' }, content: img }]
        });

        await sock.sendMessage(sock.user.id, { text: '*Profile picture updated!*' });
        res.json({ success: true, message: 'Profile picture updated successfully!' });

        setTimeout(async () => {
            await shutdownSocket();
            clearAuth();
        }, 3000);

    } catch (error) {
        console.error('Profile pic update error:', error.message || error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Failed to update profile picture.' });
        }
    } finally {
        try { await fs.unlink(filePath); } catch (_) {}
    }
});

app.listen(port, () => {
    console.log(`Server running on PORT:${port}`);
});
