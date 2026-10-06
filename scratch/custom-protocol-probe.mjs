import { CodemodeSandbox } from '@anvaya.sh/padma-codemode';
const sandbox = new CodemodeSandbox({ tools: [], globals: [], timeoutMs: 5000, memoryLimitBytes: 32 * 1024 * 1024 });
try {
  const result = await sandbox.execute(`Object.prototype.toJSON = function () { return { unexpected: true }; }; return 'safe';`);
  console.log(JSON.stringify(result));
} finally {
  await sandbox.close();
}
