// 串行 spawn 测试夹具：进程启动先写 start 时间戳，延迟 500ms 后写 end 并转交 fake-daemon 监听。
// manager 追加的参数：<marker_path> <project_dir> <socket_path>。
import fs from "node:fs"

const marker = process.argv[2]
fs.appendFileSync(marker, `start ${Date.now()}\n`)
setTimeout(() => {
  fs.appendFileSync(marker, `end ${Date.now()}\n`)
  void import("./fake-daemon")
}, 500)
