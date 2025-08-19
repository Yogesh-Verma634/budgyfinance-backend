# 🚀 Deploy to Render (Free & Easy)

## 📁 Step 1: Push to GitHub

You need to push this code to a GitHub repository first:

### Option A: Use GitHub Desktop (Easiest)
1. Open **GitHub Desktop**
2. **File → Add Local Repository**
3. Choose this folder: `/budgyfinance-backend/`
4. **Publish repository** to GitHub
5. Make it **public**
6. **Push** the code

### Option B: Manual Git Commands
```bash
# If you don't have a remote yet:
git remote add origin https://github.com/YOUR_USERNAME/budgyfinance-backend.git
git branch -M main
git push -u origin main
```

## 🌐 Step 2: Deploy to Render

1. **Go to [render.com](https://render.com)**
2. **Sign up** with your GitHub account
3. **New → Web Service**
4. **Connect** your `budgyfinance-backend` repository
5. **Configure the service:**

   ```
   Name: budgyfinance-backend
   Environment: Node
   Build Command: npm install
   Start Command: npm start
   Plan: Free
   ```

6. **Add Environment Variable:**
   - Key: `OPENAI_API_KEY`
   - Value: `your-openai-api-key-here`

7. **Click "Create Web Service"**

## ✅ Step 3: Get Your URL

After deployment (takes 2-3 minutes):
- Your backend will be live at: `https://budgyfinance-backend.onrender.com`
- Test health: `https://budgyfinance-backend.onrender.com/health`

## 📱 Step 4: Update iOS App

In your iOS project, update `AppConfig.swift`:

```swift
static let production = "https://budgyfinance-backend.onrender.com/api"
```

## 🎉 That's It!

Your backend is now:
- ✅ **Live and accessible**
- ✅ **Automatically updating** (pushes to GitHub = auto-deploy)
- ✅ **Free hosting** (750 hours/month)
- ✅ **Secure** (API keys on server only)

## 🧪 Testing

Test your deployed backend:

```bash
# Health check
curl https://budgyfinance-backend.onrender.com/health

# Should return:
{"status":"healthy","timestamp":"...","service":"budgyfinance-backend","version":"1.0.0","environment":"production"}
```

## 🔧 Troubleshooting

If deployment fails:
1. Check **Render logs** in the dashboard
2. Verify your **package.json** has correct start script
3. Ensure **environment variables** are set
4. Check **Node.js version compatibility**

## 💡 Next Steps

Once deployed:
1. Update iOS app backend URL
2. Test receipt processing
3. Monitor usage in Render dashboard
4. Set up custom domain (optional)

---

**Your backend is production-ready! 🚀**
