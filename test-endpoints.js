/**
 * Test script to validate endpoints locally before deployment
 * 
 * Usage: npm test
 */

const axios = require('axios');

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

async function testEndpoint(method, path, data = null, expectedStatus = 200) {
  try {
    console.log(`Testing ${method.toUpperCase()} ${path}...`);
    
    const config = {
      method,
      url: `${BASE_URL}${path}`,
      timeout: 5000,
      validateStatus: () => true // Don't throw on non-2xx status
    };
    
    if (data) {
      config.data = data;
      config.headers = { 'Content-Type': 'application/json' };
    }
    
    const response = await axios(config);
    
    if (response.status === expectedStatus) {
      console.log(`✅ ${method.toUpperCase()} ${path} - Status: ${response.status}`);
      return true;
    } else {
      console.log(`❌ ${method.toUpperCase()} ${path} - Expected: ${expectedStatus}, Got: ${response.status}`);
      console.log(`   Response: ${JSON.stringify(response.data, null, 2)}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ ${method.toUpperCase()} ${path} - Error: ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('🧪 Testing WhatsApp Bot Endpoints');
  console.log(`📍 Base URL: ${BASE_URL}`);
  console.log('=' .repeat(50));
  
  const tests = [
    // Health check
    ['get', '/health'],
    
    // QR status
    ['get', '/api/qr-status'],
    
    // QR page (HTML)
    ['get', '/qr'],
    
    // Send message (should fail without connection)
    ['post', '/send-message', { to: '+5511999999999', message: 'Test' }, 503],
    
    // Send message (missing fields)
    ['post', '/send-message', { to: '+5511999999999' }, 400],
    
    // Webhook test
    ['post', '/webhook-test', { test: 'data' }],
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const [method, path, data, expectedStatus] of tests) {
    const success = await testEndpoint(method, path, data, expectedStatus);
    if (success) {
      passed++;
    } else {
      failed++;
    }
    
    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('=' .repeat(50));
  console.log(`📊 Test Results: ${passed} passed, ${failed} failed`);
  
  if (failed === 0) {
    console.log('🎉 All tests passed! Bot is ready for deployment.');
    process.exit(0);
  } else {
    console.log('⚠️  Some tests failed. Please check the bot configuration.');
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n⏹️  Tests interrupted by user');
  process.exit(1);
});

// Run tests
runTests().catch(error => {
  console.error('💥 Test suite failed:', error.message);
  process.exit(1);
});