import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: [
    'src/index'
  ],
  rollup: {
    esbuild: {
      minify: true
    },
    // 模板原本是 `inlineDependencies: true`（把所有依赖打进 dist）。
    // 这里改成 false，原因是 `libsodium-wrappers` 会在运行时加载 WASM，
    // 被 inline 进 bundle 后那段加载逻辑找不到自己的二进制文件。
    // 代价是 dist 不再自包含 —— `dependencies` 里的包由 npm 正常安装。
    inlineDependencies: false,
    json: {
      compact: true,
      namedExports: false,
      preferConst: false
    },
    commonjs: {
      requireReturnsDefault: 'auto'
    },
    dts: {
      respectExternal: false
    }
  },
  clean: true,
  declaration: true
})
