// 渲染层共享 WS 出口：app.tsx 在 connect() 里 setSocket，工作台组件经 sendCmd 发命令。
let socket: WebSocket | null = null;

export function setSocket(s: WebSocket | null) {
  socket = s;
}

export function sendCmd(cmd: unknown) {
  socket?.send(JSON.stringify(cmd));
}
