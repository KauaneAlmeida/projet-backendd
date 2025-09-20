/**
 * Production-Grade WhatsApp Bot for Google Cloud Run
 * 
 * Features:
 * - Persistent session storage in Google Cloud Storage
 * - Graceful shutdown and reconnection handling
 * - Structured JSON logging
 * - Health endpoints and monitoring
 * - Message queue with retry logic
 * - Session locking mechanism
 * - Webhook integration
 * - Production-ready error handling
 */

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const crypto = require('crypto');
const axios = require('axios');

// ========================
// CONFIGURATION & VALIDATION
// ========================
const CONFIG = {
  // Core settings
  phoneNumber: process.env.PHONE_NUMBER || '+5511918368812',
  sessionPath: '/tmp/whatsapp_session', // Cloud Run writable directory
  expressPort: process.env.PORT || 3000,
  
  // Google Cloud Storage settings
  bucketName: process.env.SESSION_BUCKET, // REQUIRED: Set in Cloud Run
  sessionsPrefix: (process.env.SESSIONS_PREFIX || 'sessions/whatsapp-bot').replace(/\/+$/, '') + '/',
  
  // Optional webhook for incoming messages
  webhookUrl: process.env.WEBHOOK_URL,
  
  // Retry and backoff settings
  maxRetries: 3,
  baseRetryDelay: 1000, // 1 second base delay
  maxRetryDelay: 30000, // 30 seconds max delay
  
  // Session lock settings
  lockTtlMs: 300000, // 5 minutes lock TTL
  
  // QR code debounce
  qrDebounceMs: 5000, // 5 seconds between QR generations
  
  // Message queue settings
  messageQueueMaxSize: 100,
  messageRetryDelay: 2000,
};

// Validate required environment variables
function validateEnvironment() {
  const logger = createLogger('config');
  
  if (!CONFIG.bucketName) {
    logger.error('❌ SESSION_BUCKET environment variable is required');
    process.exit(1);
  }
  
  logger.info('✅ Environment validation passed', {
    bucketName: CONFIG.bucketName,
    sessionsPrefix: CONFIG.sessionsPrefix,
    phoneNumber: CONFIG.phoneNumber,
    port: CONFIG.expressPort,
    webhookUrl: CONFIG.webhookUrl || 'not configured'
  });
}

// ========================
// STRUCTURED LOGGING
// ========================
function createLogger(component) {
  return {
    info: (message, meta = {}) => {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        component,
        message,
        ...meta
      }));
    },
    warn: (message, meta = {}) => {
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        component,
        message,
        ...meta
      }));
    },
    error: (message, meta = {}) => {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        component,
        message,
        ...meta
      }));
    }
  };
}

const logger = createLogger('main');

// ========================
// UTILITY FUNCTIONS
// ========================

/**
 * Sleep utility for delays and backoff
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generate exponential backoff delay with jitter
 */
function getBackoffDelay(attempt, baseDelay = CONFIG.baseRetryDelay) {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
  return Math.min(exponentialDelay + jitter, CONFIG.maxRetryDelay);
}

/**
 * Retry wrapper with exponential backoff and jitter
 */
async function withRetry(operation, operationName, maxRetries = CONFIG.maxRetries) {
  const retryLogger = createLogger('retry');
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      retryLogger.warn(`${operationName} failed`, {
        attempt,
        maxRetries,
        error: error.message
      });
      
      if (attempt === maxRetries) {
        retryLogger.error(`${operationName} failed after all retries`, {
          attempts: maxRetries,
          error: error.message
        });
        throw error;
      }
      
      const delay = getBackoffDelay(attempt);
      retryLogger.info(`Retrying ${operationName}`, { delay, nextAttempt: attempt + 1 });
      await sleep(delay);
    }
  }
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

// ========================
// GOOGLE CLOUD STORAGE OPERATIONS
// ========================
const storage = new Storage();
const bucket = storage.bucket(CONFIG.bucketName);
const gcsLogger = createLogger('gcs');

/**
 * Session lock mechanism to prevent multiple instances from conflicting
 */
class SessionLock {
  constructor() {
    this.lockFile = CONFIG.sessionsPrefix + 'lock.json';
    this.instanceId = crypto.randomUUID();
  }
  
  async acquireLock() {
    try {
      const lockData = {
        instanceId: this.instanceId,
        timestamp: Date.now(),
        ttl: CONFIG.lockTtlMs
      };
      
      // Try to create lock file (fails if exists)
      const file = bucket.file(this.lockFile);
      await file.save(JSON.stringify(lockData), {
        preconditionOpts: { ifGenerationMatch: 0 } // Only create if doesn't exist
      });
      
      gcsLogger.info('Session lock acquired', { instanceId: this.instanceId });
      return true;
    } catch (error) {
      if (error.code === 412) { // Precondition failed - lock exists
        // Check if lock is expired
        try {
          const file = bucket.file(this.lockFile);
          const [content] = await file.download();
          const lockData = JSON.parse(content.toString());
          
          if (Date.now() - lockData.timestamp > lockData.ttl) {
            // Lock expired, try to break it
            await this.releaseLock();
            return await this.acquireLock();
          }
          
          gcsLogger.warn('Session lock held by another instance', {
            holder: lockData.instanceId,
            age: Date.now() - lockData.timestamp
          });
          return false;
        } catch (parseError) {
          gcsLogger.warn('Invalid lock file, breaking lock', { error: parseError.message });
          await this.releaseLock();
          return await this.acquireLock();
        }
      }
      throw error;
    }
  }
  
  async releaseLock() {
    try {
      const file = bucket.file(this.lockFile);
      await file.delete();
      gcsLogger.info('Session lock released', { instanceId: this.instanceId });
    } catch (error) {
      if (error.code !== 404) {
        gcsLogger.warn('Error releasing lock', { error: error.message });
      }
    }
  }
}

const sessionLock = new SessionLock();

/**
 * Download session files from Google Cloud Storage
 */
async function downloadSessionFromBucket() {
  return withRetry(async () => {
    // Ensure session directory exists
    await fs.mkdir(CONFIG.sessionPath, { recursive: true });
    
    gcsLogger.info('Downloading session from bucket', {
      bucket: CONFIG.bucketName,
      prefix: CONFIG.sessionsPrefix
    });
    
    const [files] = await bucket.getFiles({ prefix: CONFIG.sessionsPrefix });
    
    // Filter out lock file
    const sessionFiles = files.filter(f => !f.name.endsWith('lock.json'));
    
    if (sessionFiles.length === 0) {
      gcsLogger.info('No session files found in bucket - fresh start');
      return;
    }
    
    for (const file of sessionFiles) {
      const relativePath = file.name.slice(CONFIG.sessionsPrefix.length);
      if (!relativePath) continue; // Skip directory entries
      
      const localPath = path.join(CONFIG.sessionPath, relativePath);
      const localDir = path.dirname(localPath);
      
      // Ensure local directory exists
      await fs.mkdir(localDir, { recursive: true });
      
      gcsLogger.info('Downloading session file', {
        remote: file.name,
        local: localPath
      });
      
      await file.download({ destination: localPath });
    }
    
    gcsLogger.info('Session download completed');
  }, 'downloadSessionFromBucket');
}

/**
 * Upload session files to Google Cloud Storage
 */
async function uploadSessionToBucket() {
  return withRetry(async () => {
    try {
      await fs.access(CONFIG.sessionPath);
    } catch (error) {
      gcsLogger.info('No local session directory - nothing to upload');
      return;
    }
    
    gcsLogger.info('Uploading session to bucket', {
      bucket: CONFIG.bucketName,
      prefix: CONFIG.sessionsPrefix
    });
    
    const localFiles = await listLocalFiles(CONFIG.sessionPath);
    
    for (const relativePath of localFiles) {
      const localPath = path.join(CONFIG.sessionPath, relativePath);
      const remotePath = CONFIG.sessionsPrefix + relativePath;
      
      gcsLogger.info('Uploading session file', {
        local: localPath,
        remote: remotePath
      });
      
      await bucket.upload(localPath, {
        destination: remotePath,
        resumable: false // Faster for small files
      });
    }
    
    gcsLogger.info('Session upload completed');
  }, 'uploadSessionToBucket');
}

/**
 * Clear session files from bucket (when logged out)
 */
async function clearSessionFromBucket() {
  return withRetry(async () => {
    gcsLogger.info('Clearing session from bucket', {
      bucket: CONFIG.bucketName,
      prefix: CONFIG.sessionsPrefix
    });
    
    const [files] = await bucket.getFiles({ prefix: CONFIG.sessionsPrefix });
    
    // Don't delete lock file during clear
    const sessionFiles = files.filter(f => !f.name.endsWith('lock.json'));
    
    for (const file of sessionFiles) {
      gcsLogger.info('Deleting session file', { remote: file.name });
      await file.delete();
    }
    
    gcsLogger.info('Session cleared from bucket');
  }, 'clearSessionFromBucket');
}

// ========================
// MESSAGE QUEUE WITH RETRY
// ========================
class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.logger = createLogger('message-queue');
  }
  
  async enqueue(to, message, retries = 3) {
    if (this.queue.length >= CONFIG.messageQueueMaxSize) {
      this.logger.warn('Message queue full, dropping message', { to, messagePreview: message.substring(0, 50) });
      return false;
    }
    
    this.queue.push({ to, message, retries, timestamp: Date.now() });
    this.logger.info('Message queued', { queueSize: this.queue.length, to });
    
    if (!this.processing) {
      this.processQueue();
    }
    
    return true;
  }
  
  async processQueue() {
    if (this.processing) return;
    this.processing = true;
    
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      
      try {
        await this.sendMessage(item.to, item.message);
        this.logger.info('Message sent successfully', { to: item.to });
      } catch (error) {
        this.logger.error('Message send failed', {
          to: item.to,
          error: error.message,
          retriesLeft: item.retries - 1
        });
        
        if (item.retries > 1) {
          // Re-queue with reduced retries
          item.retries--;
          this.queue.unshift(item);
          await sleep(CONFIG.messageRetryDelay);
        }
      }
      
      // Rate limiting - small delay between messages
      await sleep(100);
    }
    
    this.processing = false;
  }
  
  async sendMessage(to, message) {
    // This will be set by the bot instance
    if (!this.bot || !this.bot.sock || !this.bot.isConnected) {
      throw new Error('WhatsApp not connected');
    }
    
    const jid = toWhatsAppJID(to);
    const result = await this.bot.sock.sendMessage(jid, { text: message });
    return result.key.id;
  }
  
  setBotInstance(bot) {
    this.bot = bot;
  }
}

const messageQueue = new MessageQueue();

// ========================
// WHATSAPP BOT CLASS
// ========================
class BaileysWhatsAppBot {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.authState = null;
    this.saveCreds = null;
    this.isShuttingDown = false;
    this.lastQRTime = 0;
    
    // Express app for HTTP endpoints
    this.app = express();
    this.app.use(express.json());
    this.qrCodeBase64 = null;
    
    this.logger = createLogger('bot');
    
    // Set bot instance for message queue
    messageQueue.setBotInstance(this);
    
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
      <strong>WhatsApp Bot Service</strong><br>
      <small>${CONFIG.phoneNumber}</small><br>
      <small>Powered by Baileys</small>
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
        
        // Use message queue for reliability
        const queued = await messageQueue.enqueue(to, message);
        
        if (!queued) {
          return res.status(503).json({
            success: false,
            error: 'Message queue full. Please try again later.'
          });
        }
        
        res.json({ 
          success: true, 
          queued: true,
          to: toWhatsAppJID(to), 
          timestamp: new Date().toISOString() 
        });
        
      } catch (error) {
        this.logger.error('Error in send-message endpoint', { error: error.message });
        res.status(500).json({ 
          success: false, 
          error: error.message || 'Failed to send message' 
        });
      }
    });
    
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      const health = {
        status: 'healthy',
        service: 'whatsapp_bot',
        connected: this.isConnected,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        queueSize: messageQueue.queue.length,
        config: {
          bucketName: CONFIG.bucketName,
          sessionsPrefix: CONFIG.sessionsPrefix,
          phoneNumber: CONFIG.phoneNumber
        }
      };
      
      // Return 503 if not connected for load balancer health checks
      const statusCode = this.isConnected ? 200 : 503;
      res.status(statusCode).json(health);
    });
    
    // Webhook test endpoint
    this.app.post('/webhook-test', (req, res) => {
      this.logger.info('Webhook test received', { body: req.body });
      res.json({ success: true, received: req.body });
    });
    
    // Start Express server
    this.app.listen(CONFIG.expressPort, '0.0.0.0', () => {
      this.logger.info('Express server started', {
        port: CONFIG.expressPort,
        endpoints: ['/qr', '/health', '/send-message', '/api/qr-status', '/webhook-test']
      });
    });
  }
  
  /**
   * Initialize the WhatsApp bot
   */
  async initialize() {
    try {
      this.logger.info('Initializing Baileys WhatsApp Bot', {
        phoneNumber: CONFIG.phoneNumber,
        sessionPath: CONFIG.sessionPath,
        bucketName: CONFIG.bucketName,
        sessionsPrefix: CONFIG.sessionsPrefix
      });
      
      // Acquire session lock
      const lockAcquired = await sessionLock.acquireLock();
      if (!lockAcquired) {
        this.logger.warn('Could not acquire session lock, continuing anyway');
      }
      
      // Create session directory
      await fs.mkdir(CONFIG.sessionPath, { recursive: true });
      this.logger.info('Session directory ready', { path: CONFIG.sessionPath });
      
      // Download existing session from bucket
      await downloadSessionFromBucket();
      
      // Initialize auth state
      const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionPath);
      this.authState = state;
      this.saveCreds = saveCreds;
      
      this.logger.info('Auth state initialized');
      
      // Connect to WhatsApp
      await this.connectToWhatsApp();
      
    } catch (error) {
      this.logger.error('Failed to initialize WhatsApp bot', { error: error.message });
      // Don't exit - let Cloud Run restart the container
      setTimeout(() => this.initialize(), 10000);
    }
  }
  
  /**
   * Connect to WhatsApp Web
   */
  async connectToWhatsApp() {
    try {
      this.logger.info('Connecting to WhatsApp Web');
      
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
      this.logger.error('Error connecting to WhatsApp', { error: error.message });
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
          this.logger.info('QR generation debounced');
          return;
        }
        this.lastQRTime = now;
        
        this.logger.info('New QR Code generated - visit /qr to scan');
        
        // Display QR in terminal for local development
        qrcode.generate(qr, { small: true });
        
        try {
          // Generate QR code image for web display
          this.qrCodeBase64 = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
          });
          this.logger.info('QR Code ready for web display at /qr');
        } catch (error) {
          this.logger.error('Error generating QR code image', { error: error.message });
        }
      }
      
      if (connection === 'close') {
        this.isConnected = false;
        this.qrCodeBase64 = null;
        
        const shouldReconnect = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;
        
        const reason = lastDisconnect?.error?.message || 'Unknown reason';
        this.logger.warn('Connection closed', { reason, shouldReconnect });
        
        if (lastDisconnect?.error instanceof Boom && 
            lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut) {
          this.logger.warn('Logged out - clearing session and waiting for new QR');
          
          // Clear local session files
          try {
            await fs.rm(CONFIG.sessionPath, { recursive: true, force: true });
            await fs.mkdir(CONFIG.sessionPath, { recursive: true });
          } catch (error) {
            this.logger.error('Error clearing local session', { error: error.message });
          }
          
          // Clear bucket session files
          await clearSessionFromBucket();
        }
        
        if (shouldReconnect && !this.isShuttingDown) {
          this.logger.info('Reconnecting in 5 seconds');
          setTimeout(() => {
            if (!this.isShuttingDown) {
              this.connectToWhatsApp().catch(error => {
                this.logger.error('Reconnection failed', { error: error.message });
              });
            }
          }, 5000);
        }
        
      } else if (connection === 'open') {
        this.isConnected = true;
        this.qrCodeBase64 = null;
        
        const user = this.sock.user;
        this.logger.info('WhatsApp connected successfully', {
          userId: user?.id,
          userName: user?.name
        });
        
      } else if (connection === 'connecting') {
        this.logger.info('Connecting to WhatsApp');
      }
    });
    
    // Credentials update - upload to bucket
    this.sock.ev.on('creds.update', async () => {
      try {
        await this.saveCreds();
        this.logger.info('Credentials updated locally');
        
        // Upload to bucket after credentials are saved
        await uploadSessionToBucket();
        
      } catch (error) {
        this.logger.error('Error handling creds.update', { error: error.message });
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
          this.logger.info('Received message', {
            from,
            text: messageText.substring(0, 100) + (messageText.length > 100 ? '...' : '')
          });
          
          // Send to webhook if configured
          if (CONFIG.webhookUrl) {
            try {
              await axios.post(CONFIG.webhookUrl, {
                from,
                message: messageText,
                timestamp: new Date().toISOString(),
                messageId: message.key.id
              }, { timeout: 5000 });
              
              this.logger.info('Message sent to webhook', { webhookUrl: CONFIG.webhookUrl });
            } catch (webhookError) {
              this.logger.error('Error sending to webhook', {
                error: webhookError.message,
                webhookUrl: CONFIG.webhookUrl
              });
            }
          }
          
          // Simple auto-reply (customize as needed)
          const replyText = `Thanks for your message! I received: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`;
          
          try {
            await messageQueue.enqueue(from, replyText);
            this.logger.info('Auto-reply queued', { to: from });
          } catch (error) {
            this.logger.error('Error queuing auto-reply', { error: error.message });
          }
        }
        
      } catch (error) {
        this.logger.error('Error processing incoming message', { error: error.message });
      }
    });
  }
  
  /**
   * Send a WhatsApp message directly (bypassing queue)
   */
  async sendMessage(to, message) {
    if (!this.isConnected || !this.sock) {
      throw new Error('WhatsApp not connected');
    }
    
    try {
      const jid = toWhatsAppJID(to);
      this.logger.info('Sending WhatsApp message', {
        to: jid,
        preview: message.substring(0, 100) + (message.length > 100 ? '...' : '')
      });
      
      const result = await this.sock.sendMessage(jid, { text: message });
      
      this.logger.info('Message sent successfully', { messageId: result.key.id });
      return result.key.id;
      
    } catch (error) {
      this.logger.error('Error sending message', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.logger.info('Shutting down WhatsApp bot');
    this.isShuttingDown = true;
    
    try {
      // Upload final session state
      if (this.saveCreds) {
        await this.saveCreds();
        await uploadSessionToBucket();
        this.logger.info('Final session state uploaded');
      }
      
      // Close WhatsApp socket
      if (this.sock) {
        await this.sock.end();
        this.logger.info('WhatsApp socket closed');
      }
      
      // Release session lock
      await sessionLock.releaseLock();
      
    } catch (error) {
      this.logger.error('Error during shutdown', { error: error.message });
    }
    
    this.logger.info('Shutdown complete');
  }
}

// ========================
// MAIN EXECUTION
// ========================

// Validate environment before starting
validateEnvironment();

// Initialize bot
const bot = new BaileysWhatsAppBot();

// Graceful shutdown handlers
const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal} - starting graceful shutdown`);
  
  try {
    await bot.shutdown();
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', {
    error: error.message,
    stack: error.stack
  });
  // Don't exit immediately - let the process try to recover
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
  // Don't exit immediately - let the process try to recover
});

// Start the bot
logger.info('Starting Baileys WhatsApp Bot');
bot.initialize().catch(error => {
  logger.error('Fatal error during initialization', { error: error.message });
  // Let Cloud Run restart the container
});