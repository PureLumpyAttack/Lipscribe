// electron-builder afterPack hook (macOS): ad-hoc sign the whole app.
//
// We have no Apple Developer ID, so the app isn't properly signed. Left as is,
// its signature doesn't match its contents and macOS calls a downloaded copy
// "damaged". An ad-hoc signature makes it consistent: macOS then says the
// developer can't be verified, and the user can allow it once in System
// Settings -> Privacy & Security -> Open Anyway.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${app}`);
};
