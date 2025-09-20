# Production WhatsApp Bot - Deployment Guide

## 🚀 Quick Deployment Steps

### 1. Build and Push Container
```bash
# Replace YOUR_PROJECT_ID with your actual Google Cloud project ID
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/whatsapp-bot
```

### 2. Deploy to Cloud Run
```bash
# Replace YOUR_PROJECT_ID and YOUR_BUCKET_NAME with actual values
gcloud run deploy whatsapp-bot \
  --image gcr.io/YOUR_PROJECT_ID/whatsapp-bot \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --timeout 15m \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 1 \
  --concurrency 80 \
  --set-env-vars SESSION_BUCKET=YOUR_BUCKET_NAME,SESSIONS_PREFIX=sessions/whatsapp-bot,PHONE_NUMBER=+5511918368812
```

### 3. Get Service URL and Test
```bash
# Get the service URL
SERVICE_URL=$(gcloud run services describe whatsapp-bot --region us-central1 --format 'value(status.url)')
echo "Service URL: $SERVICE_URL"

# Test health endpoint
curl $SERVICE_URL/health

# Open QR code page in browser
echo "QR Code page: $SERVICE_URL/qr"
```

### 4. Create Storage Bucket (if needed)
```bash
# Create bucket for session storage
gsutil mb gs://YOUR_BUCKET_NAME

# Set bucket permissions
gsutil iam ch serviceAccount:YOUR_PROJECT_ID-compute@developer.gserviceaccount.com:objectAdmin gs://YOUR_BUCKET_NAME
```

### 5. Monitor and Manage
```bash
# Tail logs in real-time
gcloud run services logs tail whatsapp-bot --region us-central1

# List session files in bucket
gsutil ls -la gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/

# Clear session (force new QR code)
gsutil rm -r gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/**
```

## 🔧 Environment Variables

Set these in Cloud Run:

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SESSION_BUCKET` | ✅ | GCS bucket for session storage | `my-whatsapp-sessions` |
| `SESSIONS_PREFIX` | ❌ | Prefix for session files | `sessions/whatsapp-bot` |
| `PHONE_NUMBER` | ❌ | Bot phone number for display | `+5511918368812` |
| `WEBHOOK_URL` | ❌ | URL to POST incoming messages | `https://api.example.com/webhook` |

## 📋 5-Step Validation Checklist

After deployment, validate these steps:

### ✅ Step 1: Service Health
```bash
curl https://YOUR_SERVICE_URL/health
# Should return: {"status":"healthy","connected":false,...}
```

### ✅ Step 2: QR Code Generation
- Open `https://YOUR_SERVICE_URL/qr` in browser
- Should show QR code within 30 seconds
- QR code should be scannable

### ✅ Step 3: WhatsApp Connection
- Scan QR code with WhatsApp (Settings → Linked Devices)
- Page should show "Connected Successfully!" 
- Health endpoint should show `"connected":true`

### ✅ Step 4: Message Sending
```bash
curl -X POST https://YOUR_SERVICE_URL/send-message \
  -H "Content-Type: application/json" \
  -d '{"to":"+5511999999999","message":"Test message"}'
# Should return: {"success":true,"queued":true,...}
```

### ✅ Step 5: Session Persistence
```bash
# Check session files exist in bucket
gsutil ls gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/
# Should show: creds.json, app-state-sync-key-*.json, etc.

# Restart service
gcloud run services update whatsapp-bot --region us-central1

# Check QR page - should show "Connected" without new QR
```

## 🛠️ Troubleshooting

### Issue: QR Code Not Appearing
**Solution:**
```bash
# Check logs for errors
gcloud run services logs tail whatsapp-bot --region us-central1 --limit 50

# Clear session and restart
gsutil rm -r gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/**
gcloud run services update whatsapp-bot --region us-central1
```

### Issue: Connection Drops Frequently
**Solution:**
```bash
# Ensure only one instance is running
gcloud run services describe whatsapp-bot --region us-central1

# Check for multiple services
gcloud run services list --region us-central1

# Increase memory if needed
gcloud run services update whatsapp-bot --memory 2Gi --region us-central1
```

### Issue: Messages Not Sending
**Solution:**
```bash
# Check connection status
curl https://YOUR_SERVICE_URL/health

# Verify phone number format (include country code)
# Check logs for send errors
gcloud run services logs tail whatsapp-bot --region us-central1 | grep "send"
```

### Issue: Session Not Persisting
**Solution:**
```bash
# Verify bucket exists and has correct permissions
gsutil ls gs://YOUR_BUCKET_NAME/
gsutil iam get gs://YOUR_BUCKET_NAME/

# Check service account permissions
gcloud projects get-iam-policy YOUR_PROJECT_ID
```

## 📊 Monitoring Commands

```bash
# Service status
gcloud run services describe whatsapp-bot --region us-central1

# Recent logs with JSON parsing
gcloud run services logs tail whatsapp-bot --region us-central1 --format json

# Resource usage
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=whatsapp-bot" --limit 10

# List all revisions
gcloud run revisions list --service whatsapp-bot --region us-central1
```

## 🔄 Updates and Maintenance

```bash
# Update code and redeploy
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/whatsapp-bot
gcloud run deploy whatsapp-bot --image gcr.io/YOUR_PROJECT_ID/whatsapp-bot --region us-central1

# Update environment variables only
gcloud run services update whatsapp-bot \
  --set-env-vars WEBHOOK_URL=https://new-webhook.com/endpoint \
  --region us-central1

# Scale to zero (stop service)
gcloud run services update whatsapp-bot --min-instances 0 --max-instances 0 --region us-central1

# Scale back up
gcloud run services update whatsapp-bot --min-instances 0 --max-instances 1 --region us-central1
```

## 🔐 Security Best Practices

1. **Use IAM Service Accounts**: Create dedicated service account with minimal permissions
2. **Enable Audit Logs**: Monitor access to session bucket
3. **Rotate Sessions**: Clear sessions periodically for security
4. **Monitor Logs**: Set up log-based alerts for errors
5. **Use VPC**: Deploy in VPC for network isolation (optional)

## 📈 Production Considerations

- **Monitoring**: Set up Cloud Monitoring alerts for service health
- **Backup**: Regular backup of session bucket
- **Scaling**: Consider multiple regions for high availability
- **Rate Limiting**: Implement rate limiting for send-message endpoint
- **Authentication**: Add API key authentication for production use