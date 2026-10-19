// collect.ts 在 Node 下复用主进程 data-loader 时替代 electron（只用到 app 路径与 net.fetch）
export const app = { getPath: () => '/tmp/aramgg-eval-app', isPackaged: false, getVersion: () => '0.0.0-eval', getAppPath: () => process.cwd(), on() {} }
export const net = { fetch: (...args) => fetch(...args) }
export default { app, net }
