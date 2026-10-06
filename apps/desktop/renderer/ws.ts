// 渲染层共享 WS 出口：app.tsx 在 connect() 里 setSocket，工作台组件经 sendCmd 发命令。
let socket: WebSocket | null = null;

export function setSocket(s: WebSocket | null) {
  socket = s;
}

export function sendCmd(cmd: unknown) {
  // readyState 守卫：对正在关闭/已关闭的 socket 调 send() 会抛 InvalidStateError，
  // 把点击处理函数一起带崩（表现为「点了没反应」）；断连期间的命令直接丢弃，重连后重发
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
}
