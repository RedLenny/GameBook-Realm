export function notFound(_req, res) {
  res.status(404).json({ error: 'Nenalezeno' });
}

const clientMessages = {
  'entity.parse.failed': 'Neplatný JSON',
  'entity.too.large': 'Požadavek je příliš velký',
};

export function errorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);

  const status = err.status >= 400 && err.status < 600 ? err.status : 500;

  if (status >= 500) {
    console.error(err);
    return res.status(status).json({ error: 'Interní chyba serveru' });
  }

  res.status(status).json({ error: clientMessages[err.type] || 'Neplatný požadavek' });
}
