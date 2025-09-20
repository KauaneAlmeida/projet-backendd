# WhatsApp Bot Validation Checklist

## 5-Step Validation Process

### Step 1: Deploy and Access
1. Deploy using the commands in `deploy-commands.md`
2. Get your service URL: `gcloud run services describe YOUR_SERVICE_NAME --region YOUR_REGION --format 'value(status.url)'`
3. Open `https://YOUR_SERVICE_URL/health` - should return `{"status":"healthy"}`
4. Open `https://YOUR_SERVICE_URL/qr` - should show QR code page

### Step 2: Connect WhatsApp
1. On the `/qr` page, wait for QR code to appear (may take 30-60 seconds)
2. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
3. Scan the QR code displayed on the webpage
4. Wait for "Connected Successfully!" message on the webpage

### Step 3: Verify Session Persistence
1. Check bucket for session files: `gsutil ls gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/`
2. Should see files like `creds.json`, `app-state-sync-key-*.json`, etc.
3. Restart the service: `gcloud run services update YOUR_SERVICE_NAME --region YOUR_REGION`
4. Check `/qr` page - should show "Connected Successfully!" without new QR code

### Step 4: Test Message Sending
1. Send a test message using curl:
   ```bash
   curl -X POST https://YOUR_SERVICE_URL/send-message \
     -H "Content-Type: application/json" \
     -d '{"to": "+5511999999999", "message": "Test message from bot"}'
   ```
2. Should receive `{"success": true, "messageId": "..."}`
3. Check your WhatsApp - should receive the test message

### Step 5: Test Auto-Reply
1. Send a message to the bot's WhatsApp number from another phone
2. Bot should automatically reply with: "Thanks for your message! I received: ..."
3. Check logs: `gcloud run services logs tail YOUR_SERVICE_NAME --region YOUR_REGION`

## Log Indicators

### ✅ Success Indicators
- `✅ WhatsApp connected successfully!` - Bot is connected
- `🔑 Credentials updated locally` - Session saved
- `✅ Session upload completed` - Session backed up to bucket
- `Received message` - Bot receiving messages
- `Auto-reply sent` - Bot sending replies
- `Message sent successfully` - API message sent

### ❌ Problem Indicators
- `Connection closed` - Connection lost (normal during reconnection)
- `❌ Logged out - clearing session` - Need to scan QR again
- `Error connecting to WhatsApp` - Connection issues
- `WhatsApp not connected` - API calls failing
- `Error uploading session` - Bucket permission issues

### ⚠️ Warning Indicators
- `No bucket configured` - Running without persistence
- `QR generation debounced` - Preventing rapid QR loops
- `Reconnecting in 5 seconds` - Normal reconnection process

## Common Issues and Solutions

### Issue: QR Code Not Appearing
**Symptoms:** `/qr` page shows "Generating QR Code..." indefinitely
**Solution:** 
1. Check logs for connection errors
2. Ensure no other instances are running
3. Clear session: `gsutil rm -r gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/**`
4. Restart service

### Issue: Connection Drops Frequently
**Symptoms:** Logs show repeated "Connection closed" and "Reconnecting"
**Solution:**
1. Ensure only one Cloud Run service is running
2. Check for duplicate services: `gcloud run services list`
3. Increase memory/CPU if needed
4. Verify bucket permissions

### Issue: Messages Not Sending
**Symptoms:** `/send-message` returns error or success but message not received
**Solution:**
1. Verify connection status at `/qr` page
2. Check phone number format (include country code)
3. Ensure WhatsApp is still linked (check Linked Devices)
4. Check logs for send errors

### Issue: Session Not Persisting
**Symptoms:** Requires QR scan after every restart
**Solution:**
1. Verify bucket exists: `gsutil ls gs://YOUR_BUCKET_NAME/`
2. Check service account permissions
3. Verify `SESSION_BUCKET` environment variable is set
4. Check logs for upload/download errors

### Issue: Multiple QR Codes Generated
**Symptoms:** QR code keeps changing rapidly
**Solution:**
1. Check for multiple running instances
2. Verify debounce logic is working
3. Clear session and restart clean

## Monitoring Commands

### Check Service Health
```bash
# Service status
gcloud run services describe YOUR_SERVICE_NAME --region YOUR_REGION

# Recent logs
gcloud run services logs tail YOUR_SERVICE_NAME --region YOUR_REGION --limit 100

# Health endpoint
curl https://YOUR_SERVICE_URL/health
```

### Check Session Files
```bash
# List session files
gsutil ls -la gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/

# Check file contents (creds.json should exist)
gsutil cat gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/creds.json
```

### Performance Monitoring
```bash
# Check resource usage
gcloud run services describe YOUR_SERVICE_NAME --region YOUR_REGION --format="table(spec.template.spec.containers[0].resources.limits)"

# Check request metrics
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=YOUR_SERVICE_NAME" --limit 10
```

## Success Criteria
- ✅ QR code appears within 60 seconds of deployment
- ✅ WhatsApp connects successfully after QR scan
- ✅ Session files appear in bucket after connection
- ✅ Service survives restarts without requiring new QR scan
- ✅ Messages can be sent via API endpoint
- ✅ Bot responds to incoming messages automatically
- ✅ Logs show clear success/error indicators
- ✅ Only one service instance is running