export interface RuleConfig {
  /** GAP-001: look-ahead before an unowned high-priority window opens. */
  unassignedLookaheadMinutes: number;
  /** GAP-002: window opening within this many minutes and still not acknowledged. */
  unacknowledgedLookaheadMinutes: number;
  /** GAP-004: minutes a reassignment may stay unaccepted. */
  reassignAcceptMinutes: number;
  /** HND-001: grace after shift end before "no handover" fires. */
  handoverGraceMinutes: number;
  /** HND-001: minutes a sent handover may stay unacknowledged. */
  handoverAckMinutes: number;
  /** HND-001: how far back to look for shift ends. */
  handoverLookbackHours: number;
  /** AI semantic findings raise alerts only at/above this confidence. */
  aiAlertConfidence: number;
  /** Stock counts older than this are treated as estimates. */
  stockFreshDays: number;
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  unassignedLookaheadMinutes: 180,
  unacknowledgedLookaheadMinutes: 60,
  reassignAcceptMinutes: 30,
  handoverGraceMinutes: 15,
  handoverAckMinutes: 30,
  handoverLookbackHours: 12,
  aiAlertConfidence: 0.7,
  stockFreshDays: 7,
};
