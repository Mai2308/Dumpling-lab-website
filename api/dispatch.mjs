import { handleRequest } from './[...path].mjs';

export default function handler(request, response) {
  const url = new URL(request.url || '/', `https://${request.headers.host || 'localhost'}`);
  const routePath = url.searchParams.get('route');
  if (!routePath || routePath.includes('..') || routePath.startsWith('/')) {
    response.status(400).json({ error: 'A valid API route is required.' });
    return;
  }
  return handleRequest(request, response, routePath);
}
