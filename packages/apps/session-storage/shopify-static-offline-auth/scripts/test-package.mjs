import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const consumer = mkdtempSync(
  join(tmpdir(), 'shopify-static-offline-consumer-'),
);
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: consumer,
    stdio: 'inherit',
    env: {...process.env, NODE_PATH: ''},
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
};

try {
  const [packed] = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        packageDir,
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        consumer,
      ],
      {cwd: consumer, encoding: 'utf8'},
    ),
  );
  for (const file of packed.files) {
    assert.match(
      file.path,
      /^(dist\/(esm|cjs|ts)\/|package\.json$|README\.md$|LICENSE\.md$)/,
    );
    assert.doesNotMatch(
      file.path,
      /(__tests__|\.env|node_modules|tsbuildinfo|\.test\.)/,
    );
  }
  assert.ok(packed.files.some(({path}) => path === 'dist/ts/index.d.ts'));
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          'shopify-static-offline-auth': `file:./${packed.filename}`,
          '@shopify/shopify-api': '15.1.1',
          '@shopify/shopify-app-react-router': '4.0.2',
          '@shopify/shopify-app-session-storage': '7.0.3',
          react: '18.3.1',
          'react-dom': '18.3.1',
          'react-router': '7.17.0',
          typescript: '5.9.3',
          '@types/node': '^22',
          '@types/react': '^18',
          '@types/react-dom': '^18',
        },
      },
      null,
      2,
    ),
  );
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org',
  ]);
  for (const [name, version] of [
    ['@shopify/shopify-api', '15.1.1'],
    ['@shopify/shopify-app-react-router', '4.0.2'],
  ]) {
    const location = join(consumer, 'node_modules', name);
    assert.ok(
      realpathSync(location).startsWith(realpathSync(consumer)),
      'Must not resolve workspace symlinks',
    );
    assert.equal(
      JSON.parse(readFileSync(join(location, 'package.json'), 'utf8')).version,
      version,
    );
  }
  copyFileSync(
    join(packageDir, 'tests/contract.test.mjs'),
    join(consumer, 'contract.test.mjs'),
  );
  copyFileSync(
    join(packageDir, 'tests/consumer.ts'),
    join(consumer, 'consumer.ts'),
  );
  run('node', ['--test', 'contract.test.mjs']);
  run('node', [
    '--input-type=commonjs',
    '-e',
    "const assert = require('node:assert/strict'); const api = require('shopify-static-offline-auth'); assert.equal(typeof api.createStaticOfflineShopifyApp, 'function'); const storage = new api.StaticSessionStorage({stores: {'example.myshopify.com': {accessToken:'test-token'}}, scopes:['read_products']}); storage.loadSession('offline_example.myshopify.com').then(session => assert.equal(session.scope, 'read_products')); assert.throws(() => require('shopify-static-offline-auth/dist/cjs/storage.js'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});",
  ]);
  run(join(consumer, 'node_modules/.bin/tsc'), [
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    'consumer.ts',
  ]);
  console.log(
    `Verified ${packed.filename}: ${packed.files.length} allowlisted files, isolated npm contracts, ESM/CJS and TypeScript.`,
  );
} finally {
  rmSync(consumer, {recursive: true, force: true});
}
