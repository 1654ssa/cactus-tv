import { errorResponse } from './_shared/http';
import type { AppData, Env } from './_shared/types';

export const onRequest: PagesFunction<Env, any, AppData> = async context => {
  const requestId = context.request.headers.get('cf-ray') || crypto.randomUUID();
  context.data.requestId = requestId;
  try {
    const response = await context.next();
    const headers = new Headers(response.headers);
    headers.set('x-request-id', requestId);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    if (new URL(context.request.url).pathname.startsWith('/api/')) return errorResponse(error, requestId);
    console.error(`[${requestId}]`, error);
    return new Response('Cactus TV 暂时无法处理此请求', { status: 500 });
  }
};
