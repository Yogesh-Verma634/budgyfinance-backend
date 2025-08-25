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
  let credential;
  
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      // Try to parse as JSON content first (for Render)
      const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
      credential = admin.credential.cert(serviceAccount);
      console.log('✅ Using Firebase service account from JSON content');
    } catch (parseError) {
      // If JSON parsing fails, treat as file path (for local development)
      credential = admin.credential.applicationDefault();
      console.log('✅ Using Firebase service account from file path');
    }
  } else {
    // Fallback - try with minimal config
    console.log('⚠️  No Firebase credentials provided. Using minimal config.');
    credential = admin.credential.applicationDefault();
  }
  
  admin.initializeApp({
    credential: credential,
  });
  
  console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error.message);
  // Don't crash the server, just log the error
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

// 🤖 AI Assistant endpoint
app.post('/api/ai-assistant', verifyToken, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { prompt } = req.body;
    const userId = req.user.uid;
    
    console.log(`🧠 AI Assistant request for user: ${userId.substring(0, 8)}...`);
    
    // Validate request
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ 
        error: 'No prompt provided for AI analysis',
        code: 'INVALID_PROMPT'
      });
    }
    
    // Check user quota for AI requests
    const quotaInfo = await getUserQuotaInfo(userId);
    if (!quotaInfo.hasQuota) {
      return res.status(429).json({ 
        error: 'AI Assistant quota exceeded. Please upgrade your plan.',
        code: 'QUOTA_EXCEEDED',
        quotaInfo
      });
    }
    
    // Process with OpenAI using backend's API key
    const aiResponse = await processAIQuestion(prompt);
    
    // Track usage
    await trackAIUsage(userId, prompt.length);
    
    const processingTime = Date.now() - startTime;
    console.log(`✅ AI Assistant response generated for user: ${userId.substring(0, 8)}... in ${processingTime}ms`);
    
    res.json({ 
      response: aiResponse,
      processingTime,
      quotaInfo: await getUserQuotaInfo(userId) // Return updated quota info
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('❌ Error in AI Assistant:', error.message);
    
    // Log error for debugging
    await logError(req.user?.uid, error, processingTime);
    
    res.status(500).json({ 
      error: 'Failed to process AI request',
      code: 'AI_PROCESSING_ERROR',
      details: error.message,
      processingTime
    });
  }
});

// 🧠 Process AI questions with OpenAI
async function processAIQuestion(prompt) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  
  if (!OPENAI_API_KEY) {
    console.error('❌ OpenAI API key not configured in environment variables');
    throw new Error('OpenAI API key not configured in environment variables');
  }
  
  if (!OPENAI_API_KEY.startsWith('sk-')) {
    console.error('❌ Invalid OpenAI API key format');
    throw new Error('Invalid OpenAI API key format');
  }
  
  console.log('🔑 Using OpenAI API key from environment variables');
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are an intelligent financial assistant helping users understand their spending patterns. Be helpful, accurate, and conversational. Always provide specific numbers and insights based on the data provided.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    })
  });
  
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`OpenAI API error: ${errorData.error?.message || 'Unknown error'}`);
  }
  
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  
  if (!content) {
    throw new Error('No response content from OpenAI');
  }
  
  return content;
}

// 📊 Track AI usage
async function trackAIUsage(userId, promptLength) {
  try {
    const usage = {
      userId,
      timestamp: new Date(),
      promptLength,
      service: 'ai-assistant',
      estimatedCost: (promptLength / 1000) * 0.002 // Rough estimate
    };
    
    await admin.firestore()
      .collection('ai-usage')
      .add(usage);
      
    // Update user's monthly AI usage counter
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format
    const userRef = admin.firestore().collection('users').doc(userId);
    
    await userRef.set({
      aiUsage: {
        [currentMonth]: admin.firestore.FieldValue.increment(1),
        lastUsed: new Date(),
        totalAIRequests: admin.firestore.FieldValue.increment(1)
      }
    }, { merge: true });
    
  } catch (error) {
    console.error('Error tracking AI usage:', error);
    // Don't fail the request if usage tracking fails
  }
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
      userQuota: 'GET /api/user/quota',
      aiAssistant: 'POST /api/ai-assistant'
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

// Check required environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY environment variable is required for AI Assistant functionality');
  console.warn('⚠️  AI Assistant endpoint will not work without this configuration');
} else {
  console.log('✅ OpenAI API key configured for AI Assistant');
}

app.listen(PORT, () => {
  console.log(`🌐 BudgyFinance Backend running on port ${PORT}`);
  console.log(`📋 Process receipt: POST /api/process-receipt`);
  console.log(`🧠 AI Assistant: POST /api/ai-assistant`);
  console.log(`📊 User quota: GET /api/user/quota`);
  console.log(`💚 Health check: GET /health`);
  console.log(`🔑 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
