// Build step: zip the browser extension into dist/ui so the web UI can offer it as a
// one-click download (GET /extension.zip, served by the static UI plugin). Runs after
// `vp build ui`. Uses adm-zip (dev-only) — no runtime dependency is added.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import AdmZip from 'adm-zip'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionDir = path.join(root, 'extension')
const outDir = path.join(root, 'dist', 'ui')
const outFile = path.join(outDir, 'extension.zip')

if (!fs.existsSync(extensionDir)) {
  console.error(`[pack-extension] extension/ not found at ${extensionDir}`)
  process.exit(1)
}
if (!fs.existsSync(outDir)) {
  // dist/ui is produced by `vp build ui`; if it's missing the UI wasn't built.
  console.error(`[pack-extension] ${outDir} not found — run the UI build first`)
  process.exit(1)
}

const zip = new AdmZip()
// Add the files under an `extension/` folder so unzipping yields a ready "Load unpacked" dir.
zip.addLocalFolder(extensionDir, 'extension')
zip.writeZip(outFile)
console.log(`[pack-extension] wrote ${path.relative(root, outFile)}`)
