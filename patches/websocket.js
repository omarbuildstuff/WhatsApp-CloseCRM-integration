import WebSocket from 'ws';
import { DEFAULT_ORIGIN } from '../../Defaults/index.js';
import { AbstractSocketClient } from './types.js';
export class WebSocketClient extends AbstractSocketClient {
    constructor() {
        super(...arguments);
        this.socket = null;
        this.socketListeners = new Map();
    }
    get isOpen() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
    get isClosed() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSED;
    }
    get isClosing() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSING;
    }
    get isConnecting() {
        return this.socket?.readyState === WebSocket.CONNECTING;
    }
    connect() {
        if (this.socket) {
            return;
        }
        this.socket = new WebSocket(this.url, {
            origin: DEFAULT_ORIGIN,
            headers: this.config.options?.headers,
            handshakeTimeout: this.config.connectTimeoutMs,
            timeout: this.config.connectTimeoutMs,
            agent: this.config.agent
        });
        this.socket.setMaxListeners(0);
        const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response'];
        for (const event of events) {
            const handler = (...args) => this.emit(event, ...args);
            this.socketListeners.set(event, handler);
            this.socket?.on(event, handler);
        }
    }
    close() {
        if (!this.socket) {
            return;
        }
        for (const [event, handler] of this.socketListeners) {
            this.socket.removeListener(event, handler);
        }
        this.socketListeners.clear();
        this.socket.close();
        this.socket = null;
    }
    send(str, cb) {
        this.socket?.send(str, cb);
        return Boolean(this.socket);
    }
}
//# sourceMappingURL=websocket.js.map
