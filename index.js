const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const P = require('pino');

// ========================
// CONFIGURATION
// ========================
const CONFIG = {
  phoneNumber: '+5511918368812', // Your WhatsApp number for identification
  authDir: '/tmp/whatsapp_session', // Cloud Run writable directory
  expressPort: process.env.PORT || 3000,
  bucketName: process.env.SESSION_BUCKET, // Set this in Cloud Run env vars
  sessionsPrefix: (process.env.SESSIONS_PREFIX || 'sessions/whatsapp-bot').replace(/\/+$/, '') + '/',
  maxRetries: 3,
  retryDelay: 2000, // Base delay for exponential backoff
  qrDebounceMs: 5000, // Prevent rapid QR generation
};

// ========================
// LOGGING & STORAGE SETUP
// ========================
const logger = P({ 
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: false }
  }
});

// Initialize Google Cloud Storage (only if bucket is configured)
const storage = CONFIG.bucketName ? new Storage() : null;
const bucket = CONFIG.bucketName ? storage.bucket(CONFIG.bucketName) : null;

if (!CONFIG.bucketName) {
  logger.warn('⚠️  SESSION_BUCKET not set - running without persistent storage (local dev mode)');
}

// ========================
// UTILITY FUNCTIONS
// ========================

/**
 * Sleep utility for delays
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry(operation, operationName, maxRetries = CONFIG.maxRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      logger.error({ 
        msg: `${operationName} failed (attempt ${attempt}/${maxRetries})`, 
        error: error.message 
      });
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      const delay = CONFIG.retryDelay * Math.pow(2, attempt - 1);
      logger.info({ msg: `Retrying ${operationName} in ${delay}ms` });
      await sleep(delay);
    }
  }
}

/**
 * Recursively list all files in a directory
 */
async function listLocalFiles(dir) {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await listLocalFiles(fullPath);
        files.push(...subFiles.map(f => path.join(entry.name, f)));
      } else {
        files.push(entry.name);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  return files;
}

/**
 * Download session files from Google Cloud Storage
 */
async function downloadSessionFromBucket() {
  if (!bucket) {
    logger.info('📁 No bucket configured - skipping session download');
    return;
  }

  await withRetry(async () => {
    // Ensure auth directory exists
    await fs.mkdir(CONFIG.authDir, { recursive: true });
    
    logger.info({ 
      msg: 'Downloading session from bucket', 
      bucket: CONFIG.bucketName, 
      prefix: CONFIG.sessionsPrefix 
    });

    const [files] = await bucket.getFiles({ prefix: CONFIG.sessionsPrefix });
    
    if (files.length === 0) {
      logger.info('📁 No session files found in bucket - fresh start');
      return;
    }

    for (const file of files) {
      const relativePath = file.name.slice(CONFIG.sessionsPrefix.length);
      if (!relativePath) continue; // Skip directory entries
      
      const localPath = path.join(CONFIG.authDir, relativePath);
      const localDir = path.dirname(localPath);
      
      // Ensure local directory exists
      await fs.mkdir(localDir, { recursive: true });
      
      logger.info({ msg: 'Downloading session file', remote: file.name, local: localPath });
      await file.download({ destination: localPath });
    }
    
    logger.info('✅ Session download completed');
  }, 'downloadSessionFromBucket');
}

/**
 * Upload session files to Google Cloud Storage
 */
async function uploadSessionToBucket() {
  if (!bucket) {
    logger.info('📁 No bucket configured - skipping session upload');
    return;
  }

  await withRetry(async () => {
    try {
      await fs.access(CONFIG.authDir);
    } catch (error) {
      logger.info('📁 No local session directory - nothing to upload');
      return;
    }

    logger.info({ 
      msg: 'Uploading session to bucket', 
      bucket: CONFIG.bucketName, 
      prefix: CONFIG.sessionsPrefix 
    });

    const localFiles = await listLocalFiles(CONFIG.authDir);
    
    for (const relativePath of localFiles) {
      const localPath = path.join(CONFIG.authDir, relativePath);
      const remotePath = CONFIG.sessionsPrefix + relativePath;
      
      logger.info({ msg: 'Uploading session file', local: localPath, remote: remotePath });
      await bucket.upload(localPath, { 
        destination: remotePath,
        resumable: false // Faster for small files
      });
    }
    
    logger.info('✅ Session upload completed');
  }, 'uploadSessionToBucket');
}

/**
 * Clear session files from bucket (when logged out)
 */
async function clearSessionFromBucket() {
  if (!bucket) {
    logger.info('📁 No bucket configured - skipping session clear');
    return;
  }

  await withRetry(async () => {
    logger.info({ 
      msg: 'Clearing session from bucket', 
      bucket: CONFIG.bucketName, 
      prefix: CONFIG.sessionsPrefix 
    });

    const [files] = await bucket.getFiles({ prefix: CONFIG.sessionsPrefix });
    
    for (const file of files) {
      logger.info({ msg: 'Deleting session file', remote: file.name });
      await file.delete();
    }
    
    logger.info('✅ Session cleared from bucket');
  }, 'clearSessionFromBucket');
}

/**
 * Convert phone number to WhatsApp JID format
 */
function toWhatsAppJID(phoneNumber) {
  // Remove all non-digits
  const cleaned = phoneNumber.replace(/\D/g, '');
  
  // Add country code if missing (assuming Brazil +55)
  let formatted = cleaned;
  if (!formatted.startsWith('55') && formatted.length <= 11) {
    formatted = '55' + formatted;
  }
  
  // Add @s.whatsapp.net if not present
  if (!formatted.includes('@')) {
    formatted += '@s.whatsapp.net';
  }
  
  return formatted;
}

// ========================
// WHATSAPP BOT CLASS
// ========================
class BaileysWhatsAppBot {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.authState = null;
    this.saveCreds = null;
    this.lastQRTime = 0;
    this.isShuttingDown = false;
    
    // Express app for HTTP endpoints
    this.app = express();
    this.app.use(express.json());
    this.qrCodeBase64 = null;
    
    this.setupExpressRoutes();
  }

  /**
   * Setup Express HTTP endpoints
   */
  setupExpressRoutes() {
    // QR Code display page
    this.app.get('/qr', (req, res) => {
      const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Bot - Connect</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      margin: 0; padding: 20px; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .container { 
      background: white; border-radius: 20px; padding: 40px;
      text-align: center; max-width: 500px; width: 100%;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }
    .title { color: #128C7E; font-size: 28px; font-weight: 700; margin-bottom: 20px; }
    .status { font-size: 18px; margin: 20px 0; font-weight: 600; }
    .connected { color: #28a745; }
    .waiting { color: #ffc107; }
    .qr-code { 
      max-width: 280px; border: 3px solid #25D366; 
      border-radius: 15px; padding: 15px; background: white; margin: 20px 0;
    }
    .instructions { color: #666; font-size: 14px; margin: 15px 0; }
    .refresh-btn { 
      background: #25D366; border: none; border-radius: 25px;
      padding: 12px 30px; color: white; font-weight: 600;
      cursor: pointer; font-size: 16px; margin-top: 20px;
      transition: all 0.3s ease;
    }
    .refresh-btn:hover { background: #128C7E; transform: translateY(-2px); }
    .footer { margin-top: 30px; color: #888; font-size: 12px; }
  </style>
  <script>
    // Auto-refresh every 10 seconds
    setTimeout(() => window.location.reload(), 10000);
  </script>
</head>
<body>
  <div class="container">
    <h1 class="title">📱 WhatsApp Bot</h1>
    ${this.isConnected 
      ? '<div class="status connected">✅ Connected Successfully!</div><p>Bot is ready to receive messages</p>'
      : this.qrCodeBase64 
        ? `<div class="status waiting">⏳ Waiting for QR Scan</div>
           <img src="${this.qrCodeBase64}" class="qr-code" alt="WhatsApp QR Code">
           <div class="instructions">
             1. Open WhatsApp on your phone<br>
             2. Go to Settings → Linked Devices<br>
             3. Tap "Link a Device"<br>
             4. Scan this QR code
           </div>`
        : '<div class="status waiting">⏳ Generating QR Code...</div><p>Please wait while we prepare the connection</p>'
    }
    <button class="refresh-btn" onclick="window.location.reload()">🔄 Refresh</button>
    <div class="footer">
      WhatsApp Bot Service<br>
      <small>Powered by Baileys • ${CONFIG.phoneNumber}</small>
    </div>
  </div>
</body>
</html>`;
      res.send(htmlContent);
    });

    // QR status API endpoint
    this.app.get('/api/qr-status', (req, res) => {
      res.json({
        hasQR: !!this.qrCodeBase64,
        isConnected: this.isConnected,
        phoneNumber: CONFIG.phoneNumber,
        timestamp: new Date().toISOString(),
        status: this.isConnected ? 'connected' : 
                this.qrCodeBase64 ? 'waiting_for_scan' : 'generating_qr'
      });
    });

    // Send message endpoint
    this.app.post('/send-message', async (req, res) => {
      try {
        const { to, message } = req.body;
        
        if (!to || !message) {
          return res.status(400).json({ 
            success: false, 
            error: 'Missing required fields: to, message' 
          });
        }

        if (!this.isConnected || !this.sock) {
          return res.status(503).json({ 
            success: false, 
            error: 'WhatsApp not connected. Please scan QR code first.' 
          });
        }

        const messageId = await this.sendMessage(to, message);
        
        res.json({ 
          success: true, 
          messageId, 
          to: toWhatsAppJID(to), 
          timestamp: new Date().toISOString() 
        });
        
      } catch (error) {
        logger.error({ msg: 'Error in send-message endpoint', error: error.message });
        res.status(500).json({ 
          success: false, 
          error: error.message || 'Failed to send message' 
        });
      }
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        service: 'whatsapp_bot',
        connected: this.isConnected,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    });

    // Start Express server
    this.app.listen(CONFIG.expressPort, '0.0.0.0', () => {
      logger.info({ 
        msg: 'Express server started', 
        port: CONFIG.expressPort,
        endpoints: ['/qr', '/health', '/send-message', '/api/qr-status']
      });
    });
  }

  /**
   * Initialize the WhatsApp bot
   */
  async initialize() {
    try {
      logger.info({ msg: 'Initializing Baileys WhatsApp Bot', config: {
        phoneNumber: CONFIG.phoneNumber,
        authDir: CONFIG.authDir,
        bucketName: CONFIG.bucketName,
        sessionsPrefix: CONFIG.sessionsPrefix
      }});

      // Create auth directory
      await fs.mkdir(CONFIG.authDir, { recursive: true });
      logger.info({ msg: 'Auth directory ready', path: CONFIG.authDir });

      // Download existing session from bucket
      await downloadSessionFromBucket();

      // Initialize auth state
      const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authDir);
      this.authState = state;
      this.saveCreds = saveCreds;

      logger.info('🔑 Auth state initialized');

      // Connect to WhatsApp
      await this.connectToWhatsApp();

    } catch (error) {
      logger.error({ msg: 'Failed to initialize WhatsApp bot', error: error.message });
      // Don't exit - let Cloud Run restart the container
      setTimeout(() => this.initialize(), 10000);
    }
  }

  /**
   * Connect to WhatsApp Web
   */
  async connectToWhatsApp() {
    try {
      logger.info('🔌 Connecting to WhatsApp Web...');
      
      this.sock = makeWASocket({
        auth: this.authState,
        printQRInTerminal: false, // We'll handle QR display via web
        browser: ['WhatsApp Bot', 'Chrome', '91.0'],
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: true,
        // Let Baileys auto-detect version - don't force whatsappWebVersion
      });

      this.setupEventHandlers();
      
    } catch (error) {
      logger.error({ msg: 'Error connecting to WhatsApp', error: error.message });
      throw error;
    }
  }

  /**
   * Setup Baileys event handlers
   */
  setupEventHandlers() {
    // Connection updates
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Debounce QR generation to prevent rapid loops
        const now = Date.now();
        if (now - this.lastQRTime < CONFIG.qrDebounceMs) {
          logger.info('🚫 QR generation debounced');
          return;
        }
        this.lastQRTime = now;

        logger.info('📱 New QR Code generated - visit /qr to scan');
        
        // Display QR in terminal for local development
        qrcode.generate(qr, { small: true });

        try {
          // Generate QR code image for web display
          this.qrCodeBase64 = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
          });
          logger.info('✅ QR Code ready for web display at /qr');
        } catch (error) {
          logger.error({ msg: 'Error generating QR code image', error: error.message });
        }
      }

      if (connection === 'close') {
        this.isConnected = false;
        this.qrCodeBase64 = null;
        
        const shouldReconnect = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;

        const reason = lastDisconnect?.error?.message || 'Unknown reason';
        logger.warn({ msg: 'Connection closed', reason, shouldReconnect });

        if (lastDisconnect?.error instanceof Boom && 
            lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut) {
          logger.warn('❌ Logged out - clearing session and waiting for new QR');
          
          // Clear local session files
          try {
            await fs.rm(CONFIG.authDir, { recursive: true, force: true });
            await fs.mkdir(CONFIG.authDir, { recursive: true });
          } catch (error) {
            logger.error({ msg: 'Error clearing local session', error: error.message });
          }
          
          // Clear bucket session files
          await clearSessionFromBucket();
        }

        if (shouldReconnect && !this.isShuttingDown) {
          logger.info('🔄 Reconnecting in 5 seconds...');
          setTimeout(() => {
            if (!this.isShuttingDown) {
              this.connectToWhatsApp().catch(error => {
                logger.error({ msg: 'Reconnection failed', error: error.message });
              });
            }
          }, 5000);
        }

      } else if (connection === 'open') {
        this.isConnected = true;
        this.qrCodeBase64 = null;
        
        const user = this.sock.user;
        logger.info({ 
          msg: '✅ WhatsApp connected successfully!', 
          userId: user?.id,
          userName: user?.name 
        });

      } else if (connection === 'connecting') {
        logger.info('🔄 Connecting to WhatsApp...');
      }
    });

    // Credentials update - upload to bucket
    this.sock.ev.on('creds.update', async () => {
      try {
        await this.saveCreds();
        logger.info('🔑 Credentials updated locally');
        
        // Upload to bucket after credentials are saved
        await uploadSessionToBucket();
        
      } catch (error) {
        logger.error({ msg: 'Error handling creds.update', error: error.message });
      }
    });

    // Message handler
    this.sock.ev.on('messages.upsert', async (messageUpdate) => {
      try {
        const message = messageUpdate.messages[0];
        
        // Skip if message is from us or not a notify type
        if (message.key.fromMe || messageUpdate.type !== 'notify') {
          return;
        }

        const messageText = message.message?.conversation || 
                           message.message?.extendedTextMessage?.text || 
                           null;

        if (messageText) {
          const from = message.key.remoteJid;
          logger.info({ 
            msg: 'Received message', 
            from, 
            text: messageText.substring(0, 100) + (messageText.length > 100 ? '...' : '')
          });

          // Simple auto-reply (customize as needed)
          const replyText = `Thanks for your message! I received: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`;
          
          try {
            await this.sock.sendMessage(from, { text: replyText });
            logger.info({ msg: 'Auto-reply sent', to: from });
          } catch (error) {
            logger.error({ msg: 'Error sending auto-reply', error: error.message });
          }
        }

      } catch (error) {
        logger.error({ msg: 'Error processing incoming message', error: error.message });
      }
    });
  }

  /**
   * Send a WhatsApp message
   */
  async sendMessage(to, message) {
    if (!this.isConnected || !this.sock) {
      throw new Error('WhatsApp not connected');
    }

    try {
      const jid = toWhatsAppJID(to);
      logger.info({ 
        msg: 'Sending WhatsApp message', 
        to: jid, 
        preview: message.substring(0, 100) + (message.length > 100 ? '...' : '')
      });

      const result = await this.sock.sendMessage(jid, { text: message });
      
      logger.info({ msg: 'Message sent successfully', messageId: result.key.id });
      return result.key.id;

    } catch (error) {
      logger.error({ msg: 'Error sending message', error: error.message });
      throw error;
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('📴 Shutting down WhatsApp bot...');
    this.isShuttingDown = true;

    try {
      if (this.sock) {
        await this.sock.end();
        logger.info('✅ WhatsApp socket closed');
      }
    } catch (error) {
      logger.error({ msg: 'Error closing WhatsApp socket', error: error.message });
    }

    logger.info('✅ Shutdown complete');
  }
}

// ========================
// MAIN EXECUTION
// ========================

// Initialize bot
const bot = new BaileysWhatsAppBot();

// Graceful shutdown handlers
const gracefulShutdown = async (signal) => {
  logger.info({ msg: `Received ${signal} - starting graceful shutdown` });
  
  try {
    await bot.shutdown();
    process.exit(0);
  } catch (error) {
    logger.error({ msg: 'Error during shutdown', error: error.message });
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error({ msg: 'Uncaught Exception', error: error.message, stack: error.stack });
  // Don't exit immediately - let the process try to recover
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ msg: 'Unhandled Rejection', reason, promise });
  // Don't exit immediately - let the process try to recover
});

// Start the bot
logger.info('🚀 Starting Baileys WhatsApp Bot...');
bot.initialize().catch(error => {
  logger.error({ msg: 'Fatal error during initialization', error: error.message });
  // Let Cloud Run restart the container
});