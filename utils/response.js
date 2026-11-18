export function sendError(res, message, status = 500) {
  return res.status(status).json({ error: message });
}
