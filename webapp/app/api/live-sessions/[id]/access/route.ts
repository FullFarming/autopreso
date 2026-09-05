import { NextRequest } from 'next/server';
import { AuthenticationError, createViewerGrantToken, requireHost, verifyViewerGrantToken, VIEWER_GRANT_COOKIE } from '@/lib/auth/live-auth';
import { renewHostSessionAccess, renewViewerSessionAccess } from '@/lib/live/access-renewal';
import { getLiveSessionStore } from '@/lib/live/store';
import { parseSessionId } from '@/lib/live/validation';
import { toLiveFailure } from '@/lib/live/errors';
import { apiError, apiSuccess } from '@/lib/security/api-response';
import { assertStrictOrigin, CsrfError } from '@/lib/security/csrf';
import { isProductionRuntime } from '@/lib/security/config';
import { privateNoStoreHeaders } from '@/lib/security/live-topic-validation';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertStrictOrigin(request);
    const sessionId = parseSessionId((await context.params).id);
    const audience = request.nextUrl.searchParams.get('audience');
    if (audience === 'host') {
      const { hostId } = await requireHost(request);
      return apiSuccess(await renewHostSessionAccess(getLiveSessionStore(), sessionId, hostId), { headers: privateNoStoreHeaders() });
    }
    if (audience !== 'viewer') return apiError('접근 대상이 올바르지 않습니다.', 'INVALID_AUDIENCE', 400, privateNoStoreHeaders());
    const claims = await verifyViewerGrantToken(request.cookies.get(VIEWER_GRANT_COOKIE)?.value);
    if (claims.sessionId !== sessionId) return apiError('다른 세션의 입장권입니다.', 'VIEWER_FORBIDDEN', 403, privateNoStoreHeaders());
    const expiresAt = await renewViewerSessionAccess({ sessionId, grantId: claims.grantId, userId: claims.userId });
    const now = Date.now();
    const signed = await createViewerGrantToken({ sessionId, grantId: claims.grantId, userId: claims.userId }, now, Math.min(Date.parse(expiresAt), now + 6 * 60 * 60_000));
    const response = apiSuccess({ expiresAt }, { headers: privateNoStoreHeaders() });
    response.cookies.set(VIEWER_GRANT_COOKIE, signed.token, {
      httpOnly: true, secure: isProductionRuntime(), sameSite: 'lax',
      path: `/api/live-sessions/${sessionId}`, expires: new Date(signed.claims.expiresAt),
    });
    return response;
  } catch (error: unknown) {
    if (error instanceof CsrfError) return apiError(error.message, 'CSRF_ORIGIN_FORBIDDEN', 403, privateNoStoreHeaders());
    if (error instanceof AuthenticationError) return apiError(error.message, 'AUTH_REQUIRED', 401, privateNoStoreHeaders());
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
  }
}
