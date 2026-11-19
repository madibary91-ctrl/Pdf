import { probeHttpResponse } from "@/modules/settlement-bootstrap";

export const dynamic = "force-dynamic";

/** پروبِ «startup» رفتگرِ تسویه (ADR-0033). مسیرِ `/api/health` بدونِ تغییر می‌ماند. */
export function GET(): Response {
  return probeHttpResponse(globalThis, "startup");
}
