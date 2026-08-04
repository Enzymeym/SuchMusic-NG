// Cross-platform native build wrapper
// On Windows: uses powershell. On Linux/macOS: uses pwsh if available, otherwise skips gracefully.
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dirname, 'build-native.ps1')
const isRelease = process.argv.includes('-Release')

// Check if native directory exists (gitignored, may not be present on CI)
const rustDir = join(__dirname, '..', 'native', 'rust-audio-engine')
if (!existsSync(rustDir)) {
  console.log('[native-build] Native directory not found, skipping build')
  process.exit(0)
}

let shell
if (process.platform === 'win32') {
  shell = 'powershell'
} else {
  // On Linux/macOS, try pwsh (PowerShell Core), otherwise skip
  try {
    execSync('which pwsh', { stdio: 'ignore' })
    shell = 'pwsh'
  } catch {
    console.log('[native-build] PowerShell not available on this platform, skipping native build')
    process.exit(0)
  }
}

const args = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath]
if (isRelease) args.push('-Release')

try {
  execSync([shell, ...args].join(' '), { stdio: 'inherit' })
} catch (e) {
  console.log('[native-build] Native build failed, continuing without it')
}
