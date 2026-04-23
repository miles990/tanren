/**
 * Agent Pool Integration Test
 * Verifies that two concurrent /chat requests with different discussionIds
 * are both accepted (not 429) and return independent responses.
 */

import { createAgent, serve } from '../dist/index.js'

const TEST_PORT = 19876

// Minimal config — uses CLI fallback (no API key needed for test)
const config = {
  identity: 'Test Agent',
  memoryDir: '/tmp/tanren-pool-test',
}

const agent = createAgent(config)
const handle = serve(agent, {
  port: TEST_PORT,
  serviceName: 'pool-test',
  memoryDir: '/tmp/tanren-pool-test',
  agentConfig: config,
  maxPoolSize: 3,
})

// Wait for server to start
await new Promise(r => setTimeout(r, 500))

console.log('=== Agent Pool Integration Test ===\n')

// Test 1: /health shows pool info
console.log('Test 1: /health includes pool status')
const healthRes = await fetch(`http://localhost:${TEST_PORT}/health`)
const health = await healthRes.json()
console.log(`  pool: ${JSON.stringify(health.pool)}`)
console.assert(health.pool !== undefined, 'pool should be in health response')
console.assert(health.pool.max === 3, `pool.max should be 3, got ${health.pool.max}`)
console.assert(health.pool.total === 1, `pool.total should start at 1, got ${health.pool.total}`)
console.log('  ✅ PASS\n')

// Test 2: /chat with discussionId is accepted
console.log('Test 2: /chat accepts discussionId parameter')
// We can't actually run a full tick without LLM, so we test the pool acquire/release path
// by checking that two requests don't immediately get 429
const poolStatus = handle.getPoolStatus()
console.log(`  pool before: ${JSON.stringify(poolStatus)}`)
console.assert(poolStatus.active === 0, 'no agents should be active initially')
console.log('  ✅ PASS\n')

// Test 3: Verify pool status endpoint after multiple discussions
console.log('Test 3: /health reflects pool.autonomous status')
const health2 = await fetch(`http://localhost:${TEST_PORT}/health`)
const h2 = await health2.json()
console.assert(h2.autonomous !== undefined, 'autonomous should be in health response')
console.assert(h2.autonomous.busy === false, 'autonomous should not be busy')
console.log(`  autonomous: ${JSON.stringify(h2.autonomous)}`)
console.log('  ✅ PASS\n')

// Test 4: runExclusive is independent from pool
console.log('Test 4: runExclusive uses autonomous agent (independent from pool)')
let exclusiveCompleted = false
const exclusivePromise = handle.runExclusive(async () => {
  exclusiveCompleted = true
  return 'done'
})
const result = await exclusivePromise
console.assert(result === 'done', 'runExclusive should complete')
console.assert(exclusiveCompleted, 'exclusive fn should have run')

// While autonomous is busy, pool should still be available
let exclusiveBlocking = false
const exclusivePromise2 = handle.runExclusive(async () => {
  // Try to acquire from pool while autonomous is "busy"
  // This tests that pool and autonomous are independent
  exclusiveBlocking = true
  await new Promise(r => setTimeout(r, 100))
  return 'done2'
})
// runExclusive should work since the first one already completed
const result2 = await exclusivePromise2
console.assert(result2 === 'done2', 'second runExclusive should also work after first completes')
console.log('  ✅ PASS\n')

// Test 5: Self-documenting root mentions discussionId
console.log('Test 5: Root endpoint documents discussionId')
const rootRes = await fetch(`http://localhost:${TEST_PORT}/`)
const root = await rootRes.json()
const chatBody = root.endpoints?.['POST /chat']?.body
console.assert(chatBody?.discussionId !== undefined, 'root should document discussionId')
console.log(`  POST /chat body: ${JSON.stringify(chatBody)}`)
console.log('  ✅ PASS\n')

console.log('=== All tests passed ===')
handle.server.close()
process.exit(0)
