const headers = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer replace-me'
};

async function testEndpoint(name, url, method = 'GET', body = null) {
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    
    // Some endpoints may return 400 Bad Request if the payload is incomplete, 
    // but 401 Unauthorized or 404 would mean the interface is NOT properly up.
    // 400 or 200 means the interface is reachable and working.
    const text = await res.text();
    console.log(`[${name}] ${method} ${url} -> ${res.status}`);
    if (res.status === 200) {
      console.log(`  Response: ${text.slice(0, 150)}`);
    } else {
      console.log(`  Error body: ${text.slice(0, 150)}`);
    }
  } catch (err) {
    console.log(`[${name}] ${method} ${url} -> FAILED: ${err.message}`);
  }
}

async function run() {
  console.log("=== Testing Signer ===");
  await testEndpoint('Signer Health', 'http://127.0.0.1:8787/health');
  await testEndpoint('Signer Sign', 'http://127.0.0.1:8787/sign', 'POST', {
    intent: {
      idempotencyKey: 'test-123',
      mint: 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump',
      action: 'BUY',
      amountInSol: 0.01,
      slippageBps: 100
    }
  });

  console.log("\n=== Testing Execution ===");
  await testEndpoint('Execution Health', 'http://127.0.0.1:8790/health');
  await testEndpoint('Execution Account State', 'http://127.0.0.1:8790/account-state', 'GET');
  await testEndpoint('Execution Broadcast', 'http://127.0.0.1:8790/broadcast', 'POST', {
    intent: {
      intent: { idempotencyKey: 'test-123' },
      signature: 'test-sig'
    }
  });
  await testEndpoint('Execution Confirmation', 'http://127.0.0.1:8790/confirmation', 'POST', {
    submissionId: 'test-123'
  });
}

run();
