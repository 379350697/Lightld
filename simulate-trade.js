const headers = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer replace-me'
};

async function simulateTrade() {
  console.log("1. 构造开仓信号 (Buy Intent)...");
  const intent = {
    strategyId: 'new-token-v1',
    poolAddress: 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump',
    outputSol: 0.001, // 用 0.001 SOL 测试
    idempotencyKey: 'test-trade-' + Date.now(),
    createdAt: new Date().toISOString(),
    side: 'buy',
    tokenMint: 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump'
  };

  console.log("2. 提交给本地签名服务 (Signer)...");
  const signRes = await fetch('http://127.0.0.1:8787/sign', {
    method: 'POST',
    headers,
    body: JSON.stringify({ intent })
  });
  const signedResponse = await signRes.json();
  const signed = { ...signedResponse, intent };
  console.log("   签名结果:", signed.signature ? "成功" : signed);
  if (!signRes.ok) return;

  console.log("\n3. 提交给执行器请求打包上链 (Broadcaster)...");
  console.log("   (这将在后台向 Jupiter 获取报价，组合交易并发送至 Solana RPC)");
  const broadcastRes = await fetch('http://127.0.0.1:8790/broadcast', {
    method: 'POST',
    headers,
    body: JSON.stringify({ intent: signed })
  });
  const broadcastText = await broadcastRes.text();
  console.log("   广播结果 HTTP " + broadcastRes.status + ":", broadcastText);
  if (!broadcastRes.ok) return;

  const broadcasted = JSON.parse(broadcastText);

  console.log("\n4. 轮询链上确认状态 (Confirmation)...");
  let confirmed = false;
  for (let i = 0; i < 5; i++) {
    const confirmRes = await fetch('http://127.0.0.1:8790/confirmation', {
      method: 'POST',
      headers,
      body: JSON.stringify({ submissionId: broadcasted.submissionId })
    });
    const confirmData = await confirmRes.json();
    console.log(`   第 ${i+1} 次检查状态: ${confirmData.status} (Finality: ${confirmData.finality})`);
    
    if (confirmData.finality === 'confirmed' || confirmData.finality === 'finalized' || confirmData.status === 'failed') {
      confirmed = true;
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

simulateTrade();
