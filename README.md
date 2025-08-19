# 🌐 BudgyFinance Backend Service

Secure backend API for processing receipts without exposing OpenAI API keys to mobile app users.

## 🚀 Features

- **🔐 Secure API Key Management** - OpenAI keys stay on server
- **🛡️ Firebase Authentication** - Only authenticated users can process
- **💰 Usage Quotas** - Free tier + premium subscriptions
- **⚡ Rate Limiting** - Prevent abuse
- **📊 Usage Analytics** - Track costs and user behavior

## 🏃‍♂️ Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export OPENAI_API_KEY="your-openai-key"
export GOOGLE_APPLICATION_CREDENTIALS="path/to/firebase-service-account.json"

# Start server
npm start
```

### Test Endpoints

```bash
# Health check
curl http://localhost:3000/health

# Process receipt (requires Firebase auth token)
curl -X POST http://localhost:3000/api/process-receipt \
  -H "Authorization: Bearer YOUR_FIREBASE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"extractedText": "Store Name\n2023-12-01\nItem 1 $5.00"}'
```

## 🌐 Deployment

### Heroku (Recommended)

```bash
# Login to Heroku
heroku login

# Create app
heroku create budgyfinance-backend

# Set environment variables
heroku config:set OPENAI_API_KEY="your-openai-key"
heroku config:set NODE_ENV="production"

# Deploy
git push heroku main
```

### Environment Variables

Required:
- `OPENAI_API_KEY` - Your OpenAI API key
- `GOOGLE_APPLICATION_CREDENTIALS` - Path to Firebase service account JSON

Optional:
- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 3000)

## 📊 API Endpoints

### POST /api/process-receipt
Process receipt text and return structured data.

**Headers:**
- `Authorization: Bearer <firebase-token>`
- `Content-Type: application/json`

**Body:**
```json
{
  "extractedText": "Receipt text content..."
}
```

**Response:**
```json
{
  "success": true,
  "receipt": {
    "id": "receipt_123",
    "storeName": "Example Store",
    "date": "2023-12-01",
    "items": [...]
  },
  "quota": {
    "isPremium": false,
    "monthlyUsage": 5,
    "monthlyLimit": 10,
    "remainingFree": 5
  }
}
```

### GET /api/user/quota
Get user's current quota information.

### GET /health
Health check endpoint.

## 💰 Business Logic

### Free Tier
- 10 receipts per month
- Basic processing speed

### Premium Tier
- Unlimited receipts
- Priority processing
- Advanced features

## 🔒 Security

- Firebase authentication required
- Rate limiting (50 requests/15min per IP)
- Input validation
- Error sanitization
- CORS protection

## 📊 Monitoring

- Usage tracking per user
- Error logging
- Performance metrics
- Cost monitoring

## 🆘 Troubleshooting

### Common Issues

**"OpenAI API key not configured"**
- Set `OPENAI_API_KEY` environment variable

**"Firebase Admin initialization failed"**
- Set `GOOGLE_APPLICATION_CREDENTIALS` environment variable
- Ensure Firebase service account has proper permissions

**"Authentication failed"**
- Check Firebase token is valid
- Ensure user is logged in to mobile app

## 📞 Support

For issues or questions, check the logs:

```bash
# Heroku logs
heroku logs --tail --app budgyfinance-backend

# Local logs
npm start
```
