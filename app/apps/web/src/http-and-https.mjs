import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Dispatch each accepted socket once, retaining its native TLS state so the
// owner entry gate can validate the real scheme without trusting proxy headers.
export const createWebServer = (handler, {
  pemFile = process.env.WEB_TLS_PEM_FILE || '',
  reloadIntervalMs = 30_000,
} = {}) => {
  const plain = http.createServer(handler);
  if (!pemFile) return plain;

  let lastPem = fs.readFileSync(pemFile);
  const tlsOptions = pem => ({key: pem, cert: pem, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1']});
  const secure = https.createServer(tlsOptions(lastPem), handler);
  const sockets = new Set();
  const server = net.createServer({pauseOnConnect: true}, socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    const dispatch = () => {
      const first = socket.read(1);
      if (!first) {
        if (socket.readableEnded || socket.destroyed) socket.destroy();
        else socket.once('readable', dispatch);
        return;
      }
      socket.setTimeout(0);
      socket.unshift(first);
      (first[0] === 22 ? secure : plain).emit('connection', socket);
    };
    socket.once('readable', dispatch);
  });
  for (const backend of [plain, secure]) {
    backend.on('upgrade', (...args) => server.emit('upgrade', ...args));
  }
  server.closeAllConnections = () => { for (const socket of sockets) socket.destroy(); };

  let lastReloadError = '';
  const reloadTimer = setInterval(() => {
    try {
      const next = fs.readFileSync(pemFile);
      if (next.equals(lastPem)) return;
      // setSecureContext validates the whole replacement before switching it.
      secure.setSecureContext(tlsOptions(next));
      lastPem = next;
      lastReloadError = '';
      server.emit('certificateReloaded');
    } catch (error) {
      if (error.message !== lastReloadError) {
        console.error(`HTTPS certificate reload failed; retaining current certificate: ${error.message}`);
        lastReloadError = error.message;
      }
    }
  }, reloadIntervalMs);
  reloadTimer.unref();
  server.once('close', () => clearInterval(reloadTimer));
  return server;
};
