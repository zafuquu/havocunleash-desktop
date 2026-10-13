// Bundles the desktop main + inlines deps into a single dist/main.js,
// then packages a portable Electron exe with electron-builder.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const appDir = path.join(root, 'apps', 'desktop');

/**
 * PASS 9 (R2) — build provenance baked INTO the artifact.
 *
 * Mirrors BLOB's `blobSourceRevision` / `blobSourceDirty` fields but is
 * implemented independently. The revision is read from git at pack time and
 * injected two ways so the package can always describe itself:
 *   1. esbuild `define`  -> literals compiled into dist/main.js (runtime access)
 *   2. dist/build-info.json -> shipped in the ASAR (the inspector reads THIS,
 *      from the package, never from the working tree)
 *
 * If git is unavailable (source tarball, CI without .git, PATH missing) the
 * values are `null` — reported honestly, never guessed. A build that cannot
 * identify itself must not claim a revision.
 */
function buildProvenance() {
  const cmd = (args) => execSync('git ' + args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  let revision = null;
  let dirty = null;
  try {
    revision = cmd('rev-parse HEAD');
    if (!/^[0-9a-f]{40}$/i.test(revision)) revision = null;
  } catch {
    revision = null;
  }
  if (revision !== null) {
    try {
      // `status --porcelain` is empty for a clean tree. A non-zero exit here
      // means git ran but could not answer — leave `dirty` unknown rather than
      // guessing clean.
      const porcelain = cmd('status --porcelain');
      dirty = porcelain.length > 0;
    } catch {
      dirty = null;
    }
  }
  return {
    revision,
    revisionShort: revision === null ? null : revision.slice(0, 12),
    dirty,
    builtAt: new Date().toISOString(),
  };
}


async function main() {
  // 0. Contracts must be built first (workspace resolution target).
  execSync('npm run build -w packages/contracts', { cwd: root, stdio: 'inherit' });

  // 0b. PASS 9 (R2): stamp this artifact with its own source revision.
  const pkg = JSON.parse(execSync('node -p "JSON.stringify(require(\'./package.json\'))"', { cwd: appDir, encoding: 'utf8' }));
  const prov = buildProvenance();
  const defineLiteral = (v) => JSON.stringify(v === null || v === undefined ? 'null' : String(v));
  console.log(
    `[pack] provenance: ${pkg.version} (${prov.revisionShort ?? 'unknown-revision'}, ` +
      `${prov.dirty === null ? 'unknown' : prov.dirty ? 'dirty' : 'clean'})`,
  );
  const provenanceDefine = {
    __HU_BUILD_REVISION__: defineLiteral(prov.revision),
    __HU_BUILD_DIRTY__: defineLiteral(prov.dirty),
    __HU_BUILD_BUILT_AT__: defineLiteral(prov.builtAt),
    __HU_APP_VERSION__: defineLiteral(pkg.version),
  };

  // 1. Bundle main (CommonJS) with all deps inlined (contracts, socket.io-client, ws, zod).
  console.log('[pack] esbuild main.js');
  await build({
    entryPoints: [path.join(appDir, 'src', 'main', 'index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(appDir, 'dist', 'main.js'),
    // Native/hosted modules must stay external: @roamhq/wrtc loads a platform
    // .node binary at runtime (asarUnpack'd), koffi likewise, and bundling the
    // wrtc metapackage would inline JS that then fails to find its binary.
    external: ['electron', 'koffi', '@roamhq/wrtc', '@roamhq/wrtc-win32-x64'],
    define: { 'process.env.NODE_ENV': '"production"', ...provenanceDefine },
    legalComments: 'none',
  });

  // 1b. Bundle the game-data runtime (mock Valorant source) as a standalone
  //     node script the packaged app spawns with ELECTRON_RUN_AS_NODE=1.
  console.log('[pack] esbuild runtime-server.cjs');
  await build({
    entryPoints: [path.join(root, 'services', 'game-data-runtime', 'src', 'server.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(appDir, 'dist', 'runtime-server.cjs'),
    // Overwolf's SDK is a native/hosted module resolved at runtime only when the
    // OW app is present; keep it external so the mock path works everywhere and
    // real-GEP resolves on machines where Overwolf is installed.
    external: ['@overwolf/ow-electron'],
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
  });

  // 1c. Stage the Overwolf GEP pieces so electron-builder ships them as
  //     extraResources: ow-electron's electron.exe (the fork that hosts the GEP
  //     package) and the gep-provider child app (declares overwolf.packages).
  console.log('[pack] staging ow-electron + gep-provider');
  const owSrc = path.join(root, 'node_modules', '@overwolf', 'ow-electron');
  const owOut = path.join(appDir, 'dist', 'ow-electron');
  if (existsSync(owSrc)) {
    // robocopy exit codes 0-7 are success; >= 8 are failures.
    execSync('cmd /c robocopy "' + owSrc + '" "' + owOut + '" /E /NFL /NDL /NJH /NJS || exit /b 0', { stdio: 'ignore' });
  } else {
    console.warn('[pack] @overwolf/ow-electron not installed — GEP capture will be unavailable');
  }
  const gepSrc = path.join(root, 'services', 'game-data-runtime', 'gep-provider');
  const gepOut = path.join(appDir, 'dist', 'gep-provider');
  execSync('cmd /c xcopy /E /I /Y "' + gepSrc + '" "' + gepOut + '"', { stdio: 'inherit' });

  // 2. Copy HUD static assets into the package resources dir.
  const hudSrc = path.join(root, 'apps', 'hud', 'public');
  const hudOut = path.join(appDir, 'dist', 'hud-public');
  console.log('[pack] hud assets ->', hudOut);
  mkdirSync(hudOut, { recursive: true });
  execSync('cmd /c xcopy /E /I /Y "' + hudSrc + '" "' + hudOut + '"', { stdio: 'inherit' });

  // 3. Place a starting config for the user to edit.
  const cfgPath = path.join(appDir, 'havoc-unleash.config.example.json');
  if (!existsSync(cfgPath)) {
    const cfg = JSON.stringify(
      {
        appBase: 'https://<your-vercel>.vercel.app',
        bridgeOrigin: 'https://<your-bridge>.onrender.com',
        roomId: '<serverCode>',
      },
      null,
      2,
    );
    writeFileSync(cfgPath, cfg + '\n');
    console.log('[pack] wrote', cfgPath);
  }

  // 3b. PASS 9 (R2): ship the provenance as a real file too, so the packaged
  //     artifact can be inspected WITHOUT trusting the working tree. The
  //     inspector reads this from inside the ASAR.
  const buildInfoPath = path.join(appDir, 'dist', 'build-info.json');
  const buildInfo = {
    schema: 1,
    version: pkg.version,
    revision: prov.revision,
    revisionShort: prov.revisionShort,
    dirty: prov.dirty,
    builtAt: prov.builtAt,
    source: prov.revision === null && prov.dirty === null ? 'unknown' : 'embedded',
  };
  writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n');
  console.log('[pack] wrote', buildInfoPath);

  // 4. electron-builder: unpacked dir (stable exe we register protocols to)
  //    first, then the portable single-file exe as a convenience.
  //    An alternate output dir (argv[2]) lets us build a candidate payload while
  //    the running instance still holds release-fresh/win-unpacked open.
  const outDir = process.argv[2] || 'release-fresh';
  console.log(`[pack] packaging win-unpacked into ${outDir} (stable exe)...`);
  execSync(`npx electron-builder --win dir -c.directories.output=${outDir}`, { cwd: appDir, stdio: 'inherit', env: { ...process.env } });
  console.log(`[pack] DONE. win-unpacked at apps/desktop/${outDir}/win-unpacked/Havoc Unleash.exe`);
}

main().catch((e) => { console.error(e); process.exit(1); });