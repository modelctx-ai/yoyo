import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    // 和入口一样先装警告过滤，测试输出里不再每个用到 node:sqlite 的文件都打一行 ExperimentalWarning。
    setupFiles: ['src/app/warnings.ts'],
  },

  lint: {
    plugins: ['typescript', 'unicorn', 'oxc', 'import', 'node', 'promise', 'vitest'],
    // Vite+ 自带的规则：测试 API 从 vite-plus/test 引，不直接引 vitest。
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    categories: {
      correctness: 'error',
      suspicious: 'warn',
    },
    env: { node: true, es2024: true },
    // typeAware：带类型信息的规则；typeCheck：顺带做完整的 TypeScript 类型检查（tsgolint，TS 7），
    // 按各文件所属的 tsconfig。`vp check` 因此同时覆盖格式、lint 和类型。
    options: { typeAware: true, typeCheck: true },
    rules: {
      // 断言都落在类型信息本来就断开的边界上：JSON.parse、SQLite 行、server.address()、测试里取替身的调用参数。
      // 换成运行时校验只会重复 zod 或存储层已经做过的事。
      'typescript/no-unsafe-type-assertion': 'off',
      // 入口第一条 import 只为副作用：在加载 node:sqlite 之前装好警告过滤（见 src/app/warnings.ts）。
      'import/no-unassigned-import': ['warn', { allow: ['**/app/warnings.ts'] }],
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
  },

  fmt: {
    singleQuote: true,
    printWidth: 120,
    trailingComma: 'all',
    // 保持 package.json 现有的键顺序。
    sortPackageJson: false,
    // docs/ 里是手写的 Markdown 和照抄的上游契约，不归格式化管。
    ignorePatterns: ['docs/**', 'pnpm-lock.yaml'],
  },
});
