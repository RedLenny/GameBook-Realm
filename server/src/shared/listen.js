export function listen(app, { name, port, host, onClose }) {
  const server = app.listen(port, host, () => {
    console.log(`[${name}] http://${host}:${port}`);
  });
  server.on('error', (error) => {
    console.error(`[${name}]`, error.code === 'EADDRINUSE' ? `Port ${port} je obsazený` : error);
    process.exit(1);
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 5000);
    timer.unref();
    server.close(async () => {
      try {
        await onClose?.();
        clearTimeout(timer);
        process.exit(0);
      } catch (error) {
        console.error(`[${name}]`, error);
        process.exit(1);
      }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}
