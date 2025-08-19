// 🌐 BudgyFinance Backend Service
// Secure API for processing receipts without exposing OpenAI keys to users

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

// Initialize Firebase Admin
try {
  // For local development, use service account file
  // For production, Heroku will use environment variables
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  } else {
    // Fallback for development
    console.log('⚠️  Using default Firebase credentials. Set GOOGLE_APPLICATION_CREDENTIALS for production.');
    admin.initializeApp();
  }
  console.log('✅ Firebase Admin initialized');
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error.message);
}

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'https://budgyfinance.app'], // Add your domains
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Rate limiting - 50 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);

// Verify Firebase token middleware
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'No authentication token provided',
        code: 'AUTH_REQUIRED'
      });
    }

    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('❌ Token verification failed:', error.message);
    return res.status(401).json({ 
      error: 'Invalid authentication token',
      code: 'AUTH_INVALID'
    });
  }
};

// 📱 Main endpoint: Process receipt
app.post('/api/process-receipt', verifyToken, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { extractedText } = req.body;
    const userId = req.user.uid;
    
    console.log(`📋 Processing receipt for user: ${userId.substring(0, 8)}...`);
    
    // Validate request
    if (!extractedText || typeof extractedText !== 'string' || extractedText.trim().length === 0) {
      return res.status(400).json({ 
        error: 'No valid text provided for processing',
        code: 'INVALID_TEXT'
      });
    }

    if (extractedText.length > 10000) {
      return res.status(400).json({ 
        error: 'Text too long. Maximum 10,000 characters allowed.',
        code: 'TEXT_TOO_LONG'
      });
    }
    
    // Check user quota
    const hasQuota = await checkUserQuota(userId);
    if (!hasQuota.allowed) {
      return res.status(429).json({ 
        error: hasQuota.message,
        code: 'QUOTA_EXCEEDED',
        upgradeRequired: true
      });
    }
    
    // Process with OpenAI
    const receipt = await processWithOpenAI(extractedText);
    
    // Track usage
    const processingTime = Date.now() - startTime;
    await trackUsage(userId, extractedText.length, processingTime);
    
    console.log(`✅ Receipt processed successfully for user: ${userId.substring(0, 8)}... (${processingTime}ms)`);
    
    res.json({
      success: true,
      receipt: receipt,
      processingTime: processingTime,
      quota: await getUserQuotaInfo(userId)
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('❌ Error processing receipt:', error.message);
    
    // Log error for debugging
    await logError(req.user?.uid, error, processingTime);
    
    if (error.message.includes('OpenAI API key')) {
      res.status(500).json({ 
        error: 'Service configuration error. Please try again later.',
        code: 'SERVICE_CONFIG_ERROR'
      });
    } else if (error.message.includes('quota')) {
      res.status(429).json({ 
        error: 'API quota exceeded. Please try again later.',
        code: 'API_QUOTA_EXCEEDED'
      });
    } else {
      res.status(500).json({ 
        error: 'Failed to process receipt. Please try again.',
        code: 'PROCESSING_FAILED',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
});

// 🤖 OpenAI Integration
async function processWithOpenAI(extractedText) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured in environment variables');
  }

  if (!OPENAI_API_KEY.startsWith('sk-')) {
    throw new Error('Invalid OpenAI API key format');
  }
  
  const prompt = `Extract receipt information from this text and return ONLY a valid JSON object with this exact structure:

{
  "storeName": "Store Name",
  "date": "YYYY-MM-DD",
  "items": [
    {
      "name": "Item Name",
      "price": 0.00,
      "quantity": 1.0,
      "category": "Food & Dining"
    }
  ]
}

Use these categories only: Food & Dining, Groceries, Transportation, Entertainment, Shopping, Health & Fitness, Travel, Bills & Utilities, Other

Receipt text:
${extractedText}

Return only the JSON object, no other text.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.1
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenAI API Error:', response.status, errorText);
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }
  
  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  
  if (!content) {
    throw new Error('No content received from OpenAI API');
  }
  
  // Parse JSON response
  try {
    const cleanContent = content.trim().replace(/^```json\s*|\s*```$/g, '');
    const receipt = JSON.parse(cleanContent);
    
    // Add required fields
    receipt.id = generateReceiptId();
    receipt.scannedTime = new Date().toISOString();
    receipt.category = receipt.category || 'Other';
    
    // Ensure items have IDs and valid data
    if (receipt.items && Array.isArray(receipt.items)) {
      receipt.items = receipt.items.map(item => ({
        id: generateItemId(),
        name: item.name || 'Unknown Item',
        price: parseFloat(item.price) || 0.0,
        quantity: parseFloat(item.quantity) || 1.0,
        category: item.category || 'Other'
      }));
    } else {
      receipt.items = [];
    }
    
    return receipt;
    
  } catch (parseError) {
    console.error('Failed to parse OpenAI response:', content);
    throw new Error(`Invalid response format from AI service: ${parseError.message}`);
  }
}

// 💰 Business Logic
async function checkUserQuota(userId) {
  try {
    const userDoc = await admin.firestore()
      .collection('users')
      .doc(userId)
      .get();
      
    const userData = userDoc.data() || {};
    const subscription = userData.subscription || {};
    const usage = userData.usage || {};
    
    // Check if user has active subscription
    if (subscription.status === 'active' && subscription.expiresAt > new Date()) {
      return { allowed: true, message: 'Premium subscription active' };
    }
    
    // Free tier limits
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const monthlyUsage = usage[currentMonth] || 0;
    const freeLimit = 10;
    
    if (monthlyUsage >= freeLimit) {
      return { 
        allowed: false, 
        message: `Free tier limit reached (${freeLimit} receipts/month). Upgrade to continue processing.`
      };
    }
    
    return { 
      allowed: true, 
      message: `Free tier: ${monthlyUsage}/${freeLimit} receipts used this month` 
    };
    
  } catch (error) {
    console.error('Error checking user quota:', error);
    // Allow processing if we can't check quota (fail open)
    return { allowed: true, message: 'Quota check unavailable' };
  }
}

async function getUserQuotaInfo(userId) {
  try {
    const userDoc = await admin.firestore()
      .collection('users')
      .doc(userId)
      .get();
      
    const userData = userDoc.data() || {};
    const subscription = userData.subscription || {};
    const usage = userData.usage || {};
    
    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthlyUsage = usage[currentMonth] || 0;
    
    return {
      isPremium: subscription.status === 'active',
      monthlyUsage: monthlyUsage,
      monthlyLimit: subscription.status === 'active' ? null : 10,
      remainingFree: subscription.status === 'active' ? null : Math.max(0, 10 - monthlyUsage)
    };
  } catch (error) {
    console.error('Error getting quota info:', error);
    return { isPremium: false, monthlyUsage: 0, monthlyLimit: 10, remainingFree: 10 };
  }
}

async function trackUsage(userId, textLength, processingTime) {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const estimatedCost = (textLength / 1000) * 0.002; // Rough OpenAI cost estimate
    
    // Log individual usage
    await admin.firestore().collection('usage_logs').add({
      userId,
      timestamp: new Date(),
      textLength,
      processingTime,
      estimatedCost,
      month: currentMonth
    });
    
    // Update user's monthly usage counter
    const userRef = admin.firestore().collection('users').doc(userId);
    await userRef.set({
      usage: {
        [currentMonth]: admin.firestore.FieldValue.increment(1),
        lastUsed: new Date(),
        totalProcessed: admin.firestore.FieldValue.increment(1)
      }
    }, { merge: true });
    
  } catch (error) {
    console.error('Error tracking usage:', error);
    // Don't fail the request if usage tracking fails
  }
}

async function logError(userId, error, processingTime) {
  try {
    await admin.firestore().collection('error_logs').add({
      userId: userId || 'anonymous',
      error: error.message,
      stack: error.stack,
      timestamp: new Date(),
      processingTime
    });
  } catch (logError) {
    console.error('Failed to log error:', logError);
  }
}

// 🔧 Utility functions
function generateReceiptId() {
  return 'receipt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateItemId() {
  return 'item_' + Math.random().toString(36).substr(2, 9);
}

// 📊 Additional endpoints
app.get('/api/user/quota', verifyToken, async (req, res) => {
  try {
    const quotaInfo = await getUserQuotaInfo(req.user.uid);
    res.json(quotaInfo);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get quota information' });
  }
});

// 📊 Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'budgyfinance-backend',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'BudgyFinance Backend',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      processReceipt: 'POST /api/process-receipt',
      userQuota: 'GET /api/user/quota'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    code: 'INTERNAL_ERROR'
  });
});

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    code: 'NOT_FOUND'
  });
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 BudgyFinance Backend running on port ${PORT}`);
  console.log(`📋 Process receipt: POST /api/process-receipt`);
  console.log(`📊 User quota: GET /api/user/quota`);
  console.log(`💚 Health check: GET /health`);
  console.log(`🔑 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
