#!/bin/bash

# 🚀 BudgyFinance Backend Deployment Script

echo "🌐 Deploying BudgyFinance Backend..."

# Check if Heroku CLI is installed
if ! command -v heroku &> /dev/null; then
    echo "❌ Heroku CLI not found. Please install it first:"
    echo "   brew install heroku/brew/heroku"
    exit 1
fi

# Check if logged into Heroku
if ! heroku auth:whoami &> /dev/null; then
    echo "🔐 Please login to Heroku first:"
    echo "   heroku login"
    exit 1
fi

# Set app name (change this if needed)
APP_NAME="budgyfinance-backend"

echo "📝 Creating Heroku app: $APP_NAME"

# Create Heroku app (or use existing)
heroku create $APP_NAME 2>/dev/null || echo "App may already exist, continuing..."

# Add Heroku remote if not exists
git remote remove heroku 2>/dev/null || true
heroku git:remote -a $APP_NAME

echo "🔑 Setting up environment variables..."

# Prompt for OpenAI API key
read -p "Enter your OpenAI API Key (starts with sk-): " OPENAI_API_KEY

if [[ ! $OPENAI_API_KEY == sk-* ]]; then
    echo "❌ Invalid OpenAI API key format. Should start with 'sk-'"
    exit 1
fi

# Set environment variables
heroku config:set OPENAI_API_KEY="$OPENAI_API_KEY" -a $APP_NAME
heroku config:set NODE_ENV="production" -a $APP_NAME

echo "🚀 Deploying to Heroku..."

# Deploy
git push heroku main

echo "✅ Deployment complete!"

# Get the app URL
APP_URL=$(heroku apps:info -a $APP_NAME | grep "Web URL" | cut -d: -f2- | xargs)

echo ""
echo "🌐 Your backend is now live at: $APP_URL"
echo "📊 Health check: $APP_URL/health"
echo "📋 Process receipt: POST $APP_URL/api/process-receipt"
echo ""
echo "🔧 To view logs: heroku logs --tail -a $APP_NAME"
echo "📊 To open dashboard: heroku open -a $APP_NAME"
echo ""
echo "🎯 Next steps:"
echo "1. Update your iOS app's backend URL to: $APP_URL/api"
echo "2. Test the health endpoint: curl $APP_URL/health"
echo "3. Test receipt processing with a Firebase token"
echo ""
echo "🔐 Important: Your OpenAI API key is now securely stored on Heroku"
echo "   and will never be exposed to your mobile app users!"
