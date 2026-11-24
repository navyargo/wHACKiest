/** Inventory projection (INV-001/INV-002). Pure. Never suggests changing consumption. */
export interface ProjectionInput {
  currentStock: number;
  unitsPerAdministration: number;
  stockVerifiedAt: Date | null;
  isEstimate: boolean;
  scheduledPerDay: number;
  recordedSinceVerification: number;
  disputedSinceVerification: number;
  now: Date;
  freshDays: number;
}
export interface Projection {
  remainingUnits: number;
  daysRemaining: number | null;
  isEstimate: boolean;
  estimateReasons: string[];
  label: string;
}

export function projectInventory(i: ProjectionInput): Projection {
  // daysRemaining = (verifiedStock − recordedSinceVerification × units) / (scheduledPerDay × units)
  const remainingUnits = i.currentStock - i.recordedSinceVerification * i.unitsPerAdministration;
  const perDay = i.scheduledPerDay * i.unitsPerAdministration;
  const daysRemaining = perDay > 0 ? Math.max(0, remainingUnits) / perDay : null;
  const reasons: string[] = [];
  if (!i.stockVerifiedAt) reasons.push("Stock has never been verified by a count");
  else if (i.now.getTime() - i.stockVerifiedAt.getTime() > i.freshDays * 86_400_000) reasons.push(`Last stock count is older than ${i.freshDays} days`);
  if (i.disputedSinceVerification > 0) reasons.push("An administration record is disputed");
  if (i.isEstimate) reasons.push("Stock figure was entered as an estimate");
  const isEstimate = reasons.length > 0;
  const days = daysRemaining === null ? "no scheduled use" : `${daysRemaining.toFixed(1)} days`;
  return { remainingUnits, daysRemaining, isEstimate, estimateReasons: reasons, label: isEstimate ? `${days} (Estimate — needs verification)` : days };
}
