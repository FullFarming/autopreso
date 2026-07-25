import { startServer } from "../src/server.js";
import { WebSocket } from "ws";
const log = (s) => console.log(`[${Date.now() % 100000}] ${s}`);
log("starting server");
const { httpServer, url } = await startServer({
  host: "127.0.0.1", port: 0, moonshineModel: "medium", openaiApiKey: "test",
  createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
});
log("server up " + url);
const wsUrl = url.replace("http:", "ws:") + "/ws";
const listener = new WebSocket(wsUrl);
const sender = new WebSocket(wsUrl);
const received = [];
listener.on("message", (raw) => { const m = JSON.parse(raw.toString()); received.push(m.type); });
await Promise.all([listener, sender].map((s) => new Promise((r) => s.on("open", r))));
log("both sockets open");
sender.send(JSON.stringify({ type: "subtitle:mirror", partial: false, translatedText: "안녕", sourceText: "Hi", speaker: "Noel" }));
await new Promise((r) => setTimeout(r, 300));
log("received types: " + received.join(","));
listener.close(); sender.close();
log("closing http server");
httpServer.closeAllConnections?.();
await new Promise((r) => httpServer.close(r));
log("DONE");
process.exit(0);
