/**
 * Minimal Tanren config — zero external dependencies.
 * Uses Claude CLI (local installation, no API key).
 *
 * Usage:
 *   cd examples/minimal
 *   npx tanren tick                  # single tick
 *   npx tanren chat                  # interactive
 *   npx tanren serve --port 3002    # HTTP server
 */

export default {
  identity: './soul.md',
  memoryDir: './memory',
}
