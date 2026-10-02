/**
 * 验证运行器（仅用于本地表征测试，不进入前端构建）：
 * 1) 用 tsc 把 src 与 verify 的 TS 按 tsconfig.verify.json 编成 CommonJS 到 .verify-build；
 * 2) 给 require 打补丁，把编译产物里的「@/」路径别名解析到 .verify-build/src；
 * 3) 用 node:test 跑 .verify-build/verify 下的测试。
 */
const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, '.verify-build')

execFileSync(
  path.join(root, 'node_modules', '.bin', 'tsc'),
  ['-p', path.join(root, 'tsconfig.verify.json')],
  { cwd: root, stdio: 'inherit' },
)

// 编译产物是 CommonJS，而根 package.json 声明了 type=module，这里显式覆盖。
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }))

// 给 CommonJS 产物补「@/」别名解析（tsc 编译不会改写 paths）。
const originalResolve = Module._resolveFilename
Module._resolveFilename = function patched(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const candidate = path.join(outDir, 'src', request.slice(2))
    return originalResolve.call(this, candidate, parent, isMain, options)
  }
  return originalResolve.call(this, request, parent, isMain, options)
}

const testDir = path.join(outDir, 'verify')
for (const file of fs.readdirSync(testDir)) {
  if (file.endsWith('.test.js')) {
    require(path.join(testDir, file))
  }
}
