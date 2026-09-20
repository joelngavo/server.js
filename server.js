const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// --- 1. CONNEXION À VOTRE BASE DE DONNÉES ---
const dbConfig = {
    host: 'localhost',
    user: 'u418079139_accofadebd', // Remplacez par votre utilisateur MySQL si différent
    password: 'VOTRE_MOT_DE_PASSE_DB', // Mettez votre mot de passe MySQL
    database: 'u418079139_accofadebd'
};

let db;
async function initDB() {
    try {
        db = await mysql.createPool(dbConfig);
        console.log('✅ Connecté à la base de données u418079139_accofadebd avec succès.');
    } catch (err) {
        console.error('❌ Erreur de connexion DB:', err.message);
    }
}
initDB();

// --- 2. DOSSIERS DE STOCKAGE DANS "messagerie_whatsapp" ---
const baseUploadDir = path.join(__dirname, '../messagerie_whatsapp/uploads');

const storageDirs = {
    pdf: path.join(baseUploadDir, 'pdf'),
    image: path.join(baseUploadDir, 'images'),
    audio: path.join(baseUploadDir, 'audio'),
    video: path.join(baseUploadDir, 'video'),
    document: path.join(baseUploadDir, 'documents')
};

// Création automatique des dossiers s'ils n'existent pas
Object.values(storageDirs).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Config Multer pour l'envoi de fichiers médias
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) cb(null, storageDirs.image);
        else if (ext === '.pdf') cb(null, storageDirs.pdf);
        else if (['.mp3', '.ogg', '.wav', '.m4a'].includes(ext)) cb(null, storageDirs.audio);
        else if (['.mp4', '.mkv', '.avi', '.mov'].includes(ext)) cb(null, storageDirs.video);
        else cb(null, storageDirs.document);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// --- 3. GESTION DES 5 SESSIONS WHATSAPP ---
const NUM_SESSIONS = 5;
const sessions = {};

async function updateSessionStatus(sessionName, isConnected, phoneNumber = null) {
    try {
        await db.query(
            `UPDATE whatsapp_sessions SET is_connected = ?, phone_number = COALESCE(?, phone_number) WHERE session_name = ?`,
            [isConnected ? 1 : 0, phoneNumber, sessionName]
        );
    } catch (err) {
        console.error(`Erreur mise à jour statut ${sessionName}:`, err.message);
    }
}

async function startSession(sessionName) {
    const authPath = path.join(__dirname, `sessions/auth_${sessionName}`);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`\n========================================`);
            console.log(`  QR Code pour : ${sessionName.toUpperCase()}`);
            console.log(`========================================`);
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            sessions[sessionName].isConnected = false;
            await updateSessionStatus(sessionName, false);
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log(`[${sessionName}] Connexion fermée. Reconnexion...`, shouldReconnect);
            if (shouldReconnect) startSession(sessionName);
        } else if (connection === 'open') {
            const userPhone = sock.user.id.split(':')[0];
            sessions[sessionName].isConnected = true;
            sessions[sessionName].phone = userPhone;
            await updateSessionStatus(sessionName, true, userPhone);
            console.log(`✅ [${sessionName}] Connecté avec le numéro: ${userPhone}`);
        }
    });

    // ÉCOUTE DES MESSAGES ENTRANTS DE VOS CLIENTS
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const senderPhone = msg.key.remoteJid.split('@')[0];
            let messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            let messageType = 'text';
            let mediaPath = null;

            if (msg.message?.imageMessage) {
                messageType = 'image';
                mediaPath = await saveIncomingMedia(msg, storageDirs.image, '.jpg');
            } else if (msg.message?.documentMessage) {
                const fileName = msg.message.documentMessage.fileName || '';
                messageType = fileName.endsWith('.pdf') ? 'pdf' : 'document';
                const ext = path.extname(fileName) || '.bin';
                mediaPath = await saveIncomingMedia(msg, storageDirs[messageType], ext);
            } else if (msg.message?.audioMessage) {
                messageType = 'audio';
                mediaPath = await saveIncomingMedia(msg, storageDirs.audio, '.ogg');
            } else if (msg.message?.videoMessage) {
                messageType = 'video';
                mediaPath = await saveIncomingMedia(msg, storageDirs.video, '.mp4');
            }

            // Sauvegarde dans u418079139_accofadebd
            await db.query(
                `INSERT INTO messages_whatsapp (direction, sender_phone, receiver_phone, message_type, message_text, media_path, session_used, status)
                 VALUES ('RECEIVED', ?, ?, ?, ?, ?, ?, 'RECEIVED')`,
                [senderPhone, sessions[sessionName].phone || 'LOCAL', messageType, messageText, mediaPath, sessionName]
            );

            console.log(`📩 Message reçu de ${senderPhone} enregistrer dans u418079139_accofadebd`);
        }
    });

    sessions[sessionName] = { sock, isConnected: false, phone: null };
}

async function saveIncomingMedia(msg, dir, ext) {
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, buffer);
        return filePath;
    } catch (e) {
        console.error('Erreur lors de la sauvegarde du média entrant:', e.message);
        return null;
    }
}

// Initialiser les 5 numéros au démarrage
for (let i = 1; i <= NUM_SESSIONS; i++) {
    startSession(`numero_${i}`);
}

// Trouver le premier numéro connecté
function getAvailableSession() {
    for (const [key, session] of Object.entries(sessions)) {
        if (session.isConnected && session.sock) {
            return { sessionName: key, sock: session.sock, phone: session.phone };
        }
    }
    return null;
}

// --- 4. ROUTES API_ngavo_markting ---

// Route 1: Envoyer un message texte
app.post('/api/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Numéro (phone) et message requis.' });

    const activeSession = getAvailableSession();
    if (!activeSession) return res.status(503).json({ error: 'Aucun des 5 numéros WhatsApp n\'est en ligne.' });

    const formattedPhone = `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    try {
        await activeSession.sock.sendMessage(formattedPhone, { text: message });

        await db.query(
            `INSERT INTO messages_whatsapp (direction, sender_phone, receiver_phone, message_type, message_text, session_used, status)
             VALUES ('SENT', ?, ?, 'text', ?, ?, 'SENT')`,
            [activeSession.phone, phone, message, activeSession.sessionName]
        );

        return res.json({ status: 'success', sentVia: activeSession.sessionName, message: 'Message envoyé avec succès !' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Échec de l\'envoi du message' });
    }
});

// Route 2: Envoyer un média (PDF, Image, Video, Audio)
app.post('/api/send-media', upload.single('file'), async (req, res) => {
    const { phone, caption } = req.body;
    const file = req.file;

    if (!phone || !file) return res.status(400).json({ error: 'Numéro (phone) et fichier requis.' });

    const activeSession = getAvailableSession();
    if (!activeSession) return res.status(503).json({ error: 'Aucun des 5 numéros WhatsApp n\'est en ligne.' });

    const formattedPhone = `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    const ext = path.extname(file.originalname).toLowerCase();

    let messageOptions = {};
    let messageType = 'document';

    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
        messageType = 'image';
        messageOptions = { image: fs.readFileSync(file.path), caption: caption || '' };
    } else if (ext === '.pdf') {
        messageType = 'pdf';
        messageOptions = { document: fs.readFileSync(file.path), mimetype: 'application/pdf', fileName: file.originalname, caption: caption || '' };
    } else if (['.mp3', '.ogg', '.wav'].includes(ext)) {
        messageType = 'audio';
        messageOptions = { audio: fs.readFileSync(file.path), mimetype: 'audio/mp4', ptt: true };
    } else if (['.mp4', '.mov'].includes(ext)) {
        messageType = 'video';
        messageOptions = { video: fs.readFileSync(file.path), caption: caption || '' };
    } else {
        messageOptions = { document: fs.readFileSync(file.path), mimetype: 'application/octet-stream', fileName: file.originalname };
    }

    try {
        await activeSession.sock.sendMessage(formattedPhone, messageOptions);

        await db.query(
            `INSERT INTO messages_whatsapp (direction, sender_phone, receiver_phone, message_type, message_text, media_path, session_used, status)
             VALUES ('SENT', ?, ?, ?, ?, ?, ?, 'SENT')`,
            [activeSession.phone, phone, messageType, caption || '', file.path, activeSession.sessionName]
        );

        return res.json({ status: 'success', sentVia: activeSession.sessionName, fileType: messageType, message: 'Fichier envoyé avec succès !' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Échec d\'envoi du fichier.' });
    }
});

// Route 3: Statut des 5 sessions
app.get('/api/sessions-status', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM whatsapp_sessions');
    return res.json(rows);
});

// Démarrage du serveur API_ngavo_markting
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 API_ngavo_markting opérationnel sur http://localhost:${PORT}`);
});
