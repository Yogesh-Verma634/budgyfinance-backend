# 🔥 Firebase Setup for Render

## Required Environment Variables

Add these to your Render dashboard:

### **Option 1: Service Account JSON (Recommended)**
```
GOOGLE_APPLICATION_CREDENTIALS=[paste entire JSON file content]
```

### **Option 2: Individual Variables**
```
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n[your-key]\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
```

## How to Get Service Account JSON

1. **Firebase Console** → **Project Settings** → **Service Accounts**
2. **Generate new private key** 
3. **Download JSON file**
4. **Copy entire content** and paste as `GOOGLE_APPLICATION_CREDENTIALS`

## Testing

After adding the environment variable:
1. **Redeploy** your Render service
2. **Test** your iOS app again
3. **Should see:** `✅ Firebase Admin initialized` in logs

## Your current environment variables should be:
- ✅ `OPENAI_API_KEY` = sk-proj-your-key
- ✅ `NODE_ENV` = production  
- 🔄 `GOOGLE_APPLICATION_CREDENTIALS` = [JSON content] (ADD THIS)

## Alternative: Simplified Firebase Init

If you have issues with the service account, you can also initialize Firebase Admin with just the project ID for basic functionality.
