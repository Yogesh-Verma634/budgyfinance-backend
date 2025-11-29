// 🌐 BudgyFinance Backend Service
// Secure API for processing receipts without exposing OpenAI keys to users

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

// Trust proxy for proper IP detection behind load balancers (Render, Heroku, etc.)
app.set('trust proxy', 1);

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

// Rate limiting - Very generous limits for unlimited scanning
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // Very generous limit for unlimited scanning
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise fall back to IP
    return req.user?.uid || req.ip;
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/';
  }
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
    
    // Quota checking removed - unlimited scanning enabled
    
    // Process with OpenAI
    const receipt = await processWithOpenAI(extractedText);
    
    // Usage tracking removed - unlimited scanning enabled
    const processingTime = Date.now() - startTime;
    
    console.log(`✅ Receipt processed successfully for user: ${userId.substring(0, 8)}... (${processingTime}ms)`);
    
    res.json({
      success: true,
      receipt: receipt,
      processingTime: processingTime
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('❌ Error processing receipt:', error.message);
    
    // Log error for debugging
    await logError(req.user?.uid, error, processingTime);
    
    // Quota error handling removed - unlimited scanning enabled
    {
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

IMPORTANT PRICING RULES FOR WEIGHT-BASED ITEMS:
- For weight-based items (e.g., "$2.99/lb", "$1.50/oz", "$5.00/kg", "$3.49 per lb"):
  * "price" MUST be the PER-UNIT RATE (e.g., 2.99 for "$2.99/lb", 1.50 for "$1.50/oz")
  * "quantity" MUST be the ACTUAL WEIGHT PURCHASED as a decimal (e.g., 0.3 for "0.3 lb", 1.2 for "1.2 lb", 0.56 for "0.56 lb")
  * quantity MUST be a decimal number when partial weights are purchased (NOT rounded to 1.0)
  * The total for that item = price × quantity (e.g., 2.99 × 0.3 = 0.897)
  
- For regular items (no weight unit shown):
  * "price" should be the unit price or total price for that item
  * "quantity" should be the number of units (can be 1.0, 2.0, 3.0, etc.)
  
- Always extract the per-unit rate, NOT the total price, when weight units are present
- Look for weight indicators: /lb, /oz, /kg, /g, per lb, per oz, etc.
- Examples:
  * "TOMATOES $2.99/lb 0.3 lb $0.90" → price: 2.99, quantity: 0.3
  * "BANANAS $1.50/lb 1.2 lb $1.80" → price: 1.50, quantity: 1.2
  * "DESI CUCUMBER $1.67/lb 0.56 lb $0.94" → price: 1.67, quantity: 0.56
  * "MILK $3.99" → price: 3.99, quantity: 1.0
  * "APPLES $2.00 3" → price: 2.00, quantity: 3.0
  * "ORGANIC GINGER $0.09/oz 0.03 oz $0.003" → price: 0.09, quantity: 0.03

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

// 💰 Business Logic - Quota functions removed for unlimited scanning

// trackUsage function removed - unlimited scanning enabled

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

// 📊 Additional endpoints - Quota endpoint removed for unlimited scanning

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
    features: {
      unlimitedScanning: true,
      aiAssistant: true
    },
    endpoints: {
      health: '/health',
      processReceipt: 'POST /api/process-receipt',
      llamaAssistant: 'POST /api/llama-assistant',
    }
  });
});

// 🤖 LLaMA 3 AI Assistant endpoint (Lightweight for Render)
app.post('/api/llama-assistant', verifyToken, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { prompt, model = 'llama3:1b' } = req.body; // Use 1B model by default
    const userId = req.user.uid;
    
    console.log(`🧠 LLaMA 3 1B AI Assistant request for user: ${userId.substring(0, 8)}...`);
    console.log(`📝 Received prompt: ${prompt.substring(0, 200)}...`);
    console.log(`📊 Prompt length: ${prompt.length} characters`);
    console.log(`🤖 Model requested: ${model}`);
    
    // Validate request
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ 
        error: 'No prompt provided for AI analysis',
        code: 'INVALID_PROMPT'
      });
    }
    
    // Check prompt length for memory optimization
    if (prompt.length > 2000) {
      return res.status(400).json({
        error: 'Prompt too long for memory-constrained environment',
        code: 'PROMPT_TOO_LONG',
        maxLength: 2000
      });
    }
    
    // Process with LLaMA 3 1B
    const aiResponse = await processWithLLaMA(prompt, model);
    
    const processingTime = Date.now() - startTime;
    console.log(`✅ LLaMA 3 1B AI Assistant response generated for user: ${userId.substring(0, 8)}... in ${processingTime}ms`);
    
    res.json({ 
      response: aiResponse,
      processingTime,
      model: model,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('❌ Error in LLaMA 3 1B AI Assistant:', error.message);
    
    // Log error for debugging
    await logError(req.user?.uid, error, processingTime);
    
    res.status(500).json({ 
      error: 'Failed to process AI request',
      code: 'LLAMA_PROCESSING_ERROR',
      details: error.message,
      processingTime
    });
  }
});

// 🧠 Process AI questions with LLaMA 3 1B (Memory-optimized for Render)
async function processWithLLaMA(prompt, model) {
  const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL;
  
  if (!LLAMA_SERVER_URL) {
    console.error('❌ LLaMA server URL not configured in environment variables');
    throw new Error('LLaMA server URL not configured in environment variables');
  }
  
  console.log('🔑 Using LLaMA server from environment variables');
  console.log(`📤 Sending to LLaMA server - Prompt preview: ${prompt.substring(0, 300)}...`);
  console.log(`📊 Full prompt length: ${prompt.length} characters`);
  console.log(`🌐 LLaMA Server URL: ${LLAMA_SERVER_URL}`);
  console.log(`🤖 Model: ${model}`);
  
  // Memory-optimized request for Render compatibility
  const requestBody = {
    prompt: prompt,
    model: model,
    max_tokens: 500, // Reduced for memory efficiency
    temperature: 0.7,
    stream: false,
    // Memory optimization parameters
    num_ctx: 1024, // Reduced context window
    num_thread: 2, // Reduced thread count
    num_gpu: 0, // CPU only for Render
    repeat_penalty: 1.1
  };
  
  console.log('📤 Memory-optimized request body:', requestBody);
  
  const response = await fetch(`${LLAMA_SERVER_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`LLaMA server error: ${errorData.error || response.statusText}`);
  }
  
  const data = await response.json();
  const content = data.response || data.content;
  
  if (!content) {
    throw new Error('No response content from LLaMA server');
  }
  
  return content;
}

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
  console.log(`🚀 BudgyFinance Backend running on port ${PORT}`);
  console.log(`📋 Process receipt: POST /api/process-receipt (UNLIMITED SCANNING)`);
  console.log(`🧠 LLaMA 3 AI Assistant: POST /api/llama-assistant`);
  console.log(`💚 Health check: GET /health`);
  console.log(`🔑 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🎉 UNLIMITED SCANNING ENABLED - No quotas or limits!`);
  
  // Check LLaMA server configuration
  if (process.env.LLAMA_SERVER_URL) {
    console.log('✅ LLaMA server URL configured');
  } else {
    console.log('⚠️ LLaMA server URL not configured');
  }
});

module.exports = app;
