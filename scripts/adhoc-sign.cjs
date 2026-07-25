// electron-builder afterPack hook: ad-hoc sign the whole bundle.
//
// Without any signing, electron-builder's modifications (asar, resources)
// invalidate Electron's original ad-hoc signatures — a downloaded (quarantined)
// copy then fails Gatekeeper with "app is damaged". A fresh, valid ad-hoc
// signature downgrades that to the "unidentified developer" flow, where
// right-click → Open works. (Full fix = Developer ID + notarization.)
const { execSync } = require('child_process')
const { join } = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  console.log(`  • ad-hoc signing ${appPath}`)
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' })
}
