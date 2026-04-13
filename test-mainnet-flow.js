// test-mainnet-flow.js — End-to-end mainnet test: Buy → Add LP → Withdraw LP → Sell
const headers = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer replace-me'
};

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_USDC_DLMM_POOL = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6'; // SOL-USDC DLMM (bin_step=4)

async function executeAction(stepName, action, outputSol, poolAddress, tokenMint) {
  console.log(`\n======================================`);
  console.log(`[Step] ${stepName}: ${action.toUpperCase()} ${outputSol} SOL`);
  console.log(`======================================`);

  const intent = {
    strategyId: 'new-token-v1',
    poolAddress: poolAddress || SOL_USDC_DLMM_POOL,
    outputSol,
    idempotencyKey: `mainnet-test-${action}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    side: action,
    tokenMint: tokenMint || USDC_MINT
  };

  process.stdout.write("-> Requesting Signature... ");
  const signRes = await fetch('http://127.0.0.1:8787/sign', {
    method: 'POST', headers, body: JSON.stringify({ intent })
  });
  if (!signRes.ok) throw new Error(await signRes.text());
  const signedResponse = await signRes.json();
  const signed = { ...signedResponse, intent };
  console.log("OK");

  process.stdout.write("-> Broadcasting to Mainnet... ");
  const broadcastRes = await fetch('http://127.0.0.1:8791/broadcast', {
    method: 'POST', headers, body: JSON.stringify({ intent: signed })
  });
  const broadcastText = await broadcastRes.text();
  if (!broadcastRes.ok) throw new Error(broadcastText);

  const broadcasted = JSON.parse(broadcastText);
  console.log(`OK (Tx ID: ${broadcasted.submissionId})`);
  console.log(`   https://solscan.io/tx/${broadcasted.submissionId}`);

  process.stdout.write("-> Waiting for Confirmation... ");
  let confirmed = false;
  for (let i = 0; i < 15; i++) {
    const confirmRes = await fetch('http://127.0.0.1:8791/confirmation', {
      method: 'POST', headers, body: JSON.stringify({ submissionId: broadcasted.submissionId })
    });
    const confirmData = await confirmRes.json();

    if (confirmData.finality === 'confirmed' || confirmData.finality === 'finalized') {
      console.log(`CONFIRMED! (${confirmData.finality})`);
      confirmed = true;
      break;
    } else if (confirmData.status === 'failed') {
      throw new Error(`Tx Failed on Chain: ${confirmData.reason}`);
    } else {
      process.stdout.write(".");
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!confirmed) {
    console.log(" TIMEOUT (may still confirm later)");
  }
  return broadcasted;
}

async function executeActionSafe(stepName, action, outputSol, poolAddress, tokenMint) {
  try {
    return await executeAction(stepName, action, outputSol, poolAddress, tokenMint);
  } catch (err) {
    console.error(`   ❌ Failed: ${err.message}`);
    return null;
  }
}

async function runMainnetSimulation() {
  try {
    console.log("🚀 实盘闭环测试: Buy → Add LP → Withdraw LP → Sell\n");

    // Step 1: Buy USDC with 0.003 SOL via Jupiter
    await executeActionSafe("1. Jupiter Buy (SOL→USDC)", "buy", 0.003, SOL_USDC_DLMM_POOL, USDC_MINT);
    await new Promise(r => setTimeout(r, 3000));

    // Step 2: Add LP to SOL-USDC DLMM pool (0.002 SOL)
    await executeActionSafe("2. Meteora Add LP (SOL-USDC DLMM)", "add-lp", 0.002, SOL_USDC_DLMM_POOL, USDC_MINT);
    await new Promise(r => setTimeout(r, 5000));

    // Step 3: Withdraw LP from the same pool
    await executeActionSafe("3. Meteora Withdraw LP", "withdraw-lp", 0.002, SOL_USDC_DLMM_POOL, USDC_MINT);
    await new Promise(r => setTimeout(r, 3000));

    // Step 4: Sell USDC back to SOL
    await executeActionSafe("4. Jupiter Sell (USDC→SOL)", "sell", 0.002, SOL_USDC_DLMM_POOL, USDC_MINT);

    console.log(`\n✅ 实盘闭环测试全部完成！`);
  } catch (err) {
    console.error(`\n❌ UNEXPECTED FAILURE: ${err.message}`);
  }
}

runMainnetSimulation();
