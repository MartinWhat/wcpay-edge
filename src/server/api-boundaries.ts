export function isPublicApiRequest(request: Request) {
	const { pathname } = new URL(request.url);
	if (pathname === "/api/auth" || pathname.startsWith("/api/auth/"))
		return true;
	if (
		request.method === "GET" &&
		(pathname === "/api/site-logo" || pathname === "/api/site-background")
	)
		return true;
	return (
		(pathname === "/api/providers/alipay/notify" &&
			request.method === "POST") ||
		(pathname === "/api/providers/okpay/notify" && request.method === "POST") ||
		(/^\/api\/providers\/alchemy\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			pathname,
		) &&
			request.method === "POST") ||
		(/^\/api\/telegram\/[0-9a-f-]{36}\/webhook$/i.test(pathname) &&
			request.method === "POST") ||
		(/^\/api\/checkout\/\d{20}\/review$/.test(pathname) &&
			request.method === "POST")
	);
}

export function isSameOriginRequest(request: Request) {
	const origin = request.headers.get("origin");
	if (!origin) return false;
	try {
		return new URL(origin).origin === new URL(request.url).origin;
	} catch {
		return false;
	}
}
