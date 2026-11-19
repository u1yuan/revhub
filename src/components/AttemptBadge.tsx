"use client";

import { useEffect, useState } from "react";
import { peekStatus } from "@/lib/attempt";

/** Shows "in progress" / "results ready" for an assessment, read from this tab's sessionStorage. */
export default function AttemptBadge({ bankId, total }: { bankId: string; total: number }) {
  const [status, setStatus] = useState<ReturnType<typeof peekStatus>>(null);
  useEffect(() => setStatus(peekStatus(bankId)), [bankId]);
  if (!status) return null;
  return (
    <span className={`badge ${status.finished ? "badge--done" : "badge--live"}`}>
      {status.finished ? `${status.mode}${status.questionCount ? " retry" : ""} · results ready` : `${status.mode}${status.questionCount ? " retry" : ""} in progress · question ${status.index + 1} of ${status.questionCount ?? total}`}
    </span>
  );
}
