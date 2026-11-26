import { probeHttpResponse } from "@/modules/tool-policy-bootstrap";

export const dynamic = "force-dynamic";

/** پروبِ «live» میزبانِ سیاستِ ابزار (ADR-0076). `/api/health` و پروب‌های تسویه بدونِ تغییر می‌مانند. */
export function GET(): Response {
  return probeHttpResponse(globalThis, "live");
}
