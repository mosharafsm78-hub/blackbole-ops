export function reasonPresets(status?: OrderStatus | null): string[] {
  if (status === "on_hold") return [ADVANCE_REASON_AWAITING, ADVANCE_REASON_PROMISED, ...HOLD_REASONS]
  if (status === "cancelled") return [ADVANCE_REASON_REFUSED, ADVANCE_REASON_FAILED, ...CANCEL_REASONS]
  if (status === "returned" || status === "pending_returned" || status === "damaged") return RETURN_REASONS
  return []
}
