# WhatsApp Bot Deployment Commands for Google Cloud Run

## Prerequisites
1. Install Google Cloud SDK: `gcloud auth login`
2. Set your project: `gcloud config set project YOUR_PROJECT_ID`
3. Enable required APIs:
   ```bash
   gcloud services enable cloudbuild.googleapis.com
   gcloud services enable run.googleapis.com
   gcloud services enable storage.googleapis.com
   ```

## Environment Variables Setup
Replace these values with your actual configuration:
- `YOUR_PROJECT_ID`: Your Google Cloud project ID
- `YOUR_BUCKET_NAME`: Your Google Cloud Storage bucket name
- `YOUR_REGION`: Your preferred region (e.g., `southamerica-east1`, `us-central1`)
- `YOUR_SERVICE_NAME`: Your Cloud Run service name (e.g., `whatsapp-bot`)

## 1. Create Storage Bucket (if not exists)
```bash
# Create bucket for session storage
gsutil mb gs://YOUR_BUCKET_NAME

# Set bucket permissions (if using default service account)
gsutil iam ch serviceAccount:YOUR_PROJECT_ID-compute@developer.gserviceaccount.com:objectAdmin gs://YOUR_BUCKET_NAME
```

## 2. Build and Push Container
```bash
# Option A: Using Cloud Build (recommended)
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/whatsapp-bot

# Option B: Using Docker locally
# docker build -t gcr.io/YOUR_PROJECT_ID/whatsapp-bot .
# docker push gcr.io/YOUR_PROJECT_ID/whatsapp-bot
```

## 3. Deploy to Cloud Run
```bash
gcloud run deploy YOUR_SERVICE_NAME \
  --image gcr.io/YOUR_PROJECT_ID/whatsapp-bot \
  --region YOUR_REGION \
  --platform managed \
  --allow-unauthenticated \
  --timeout 15m \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 1 \
  --concurrency 80 \
  --set-env-vars SESSION_BUCKET=YOUR_BUCKET_NAME,SESSIONS_PREFIX=sessions/whatsapp-bot
```

## 4. Get Service URL and Test
```bash
# Get the service URL
gcloud run services describe YOUR_SERVICE_NAME --region YOUR_REGION --format 'value(status.url)'

# Test the service (replace SERVICE_URL with actual URL)
curl https://SERVICE_URL/health

# Open QR code page in browser
# https://SERVICE_URL/qr
```

## 5. Monitor Logs
```bash
# Tail logs in real-time
gcloud run services logs tail YOUR_SERVICE_NAME --region YOUR_REGION

# Read recent logs
gcloud logs read "resource.type=cloud_run_revision AND resource.labels.service_name=YOUR_SERVICE_NAME" --limit 50 --format json
```

## 6. Session Management Commands

### List session files in bucket
```bash
gsutil ls -r gs://YOUR_BUCKET_NAME/sessions/
```

### Clear session (force new QR code)
```bash
# List files first to confirm
gsutil ls gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/

# Delete all session files
gsutil rm -r gs://YOUR_BUCKET_NAME/sessions/whatsapp-bot/**
```

### Check for duplicate services
```bash
# List all Cloud Run services
gcloud run services list --region YOUR_REGION

# Delete old/duplicate services
gcloud run services delete OLD_SERVICE_NAME --region YOUR_REGION
```

## 7. Update Deployment
```bash
# Rebuild and redeploy
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/whatsapp-bot
gcloud run deploy YOUR_SERVICE_NAME \
  --image gcr.io/YOUR_PROJECT_ID/whatsapp-bot \
  --region YOUR_REGION
```

## 8. Test Message Sending
```bash
# Test send message endpoint (replace SERVICE_URL and phone number)
curl -X POST https://SERVICE_URL/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+5511999999999",
    "message": "Hello from WhatsApp Bot!"
  }'
```

## Troubleshooting Commands

### Check service status
```bash
gcloud run services describe YOUR_SERVICE_NAME --region YOUR_REGION
```

### Check recent deployments
```bash
gcloud run revisions list --service YOUR_SERVICE_NAME --region YOUR_REGION
```

### Delete all revisions and start fresh
```bash
gcloud run services delete YOUR_SERVICE_NAME --region YOUR_REGION
# Then redeploy with the deploy command above
```

### Set service account with storage permissions
```bash
# Create service account
gcloud iam service-accounts create whatsapp-bot-sa --display-name "WhatsApp Bot Service Account"

# Grant storage permissions
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:whatsapp-bot-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Deploy with custom service account
gcloud run deploy YOUR_SERVICE_NAME \
  --image gcr.io/YOUR_PROJECT_ID/whatsapp-bot \
  --region YOUR_REGION \
  --service-account whatsapp-bot-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars SESSION_BUCKET=YOUR_BUCKET_NAME,SESSIONS_PREFIX=sessions/whatsapp-bot
```