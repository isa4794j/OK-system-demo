/**
 * 되돌릴 표 — 부모가 먼저(외래키 순서). 이 순서대로 넣고, 지울 때는 뒤에서부터 지운다.
 *
 * 새 표를 만들면 여기에도 적는다. 적지 않으면 그 표는 초기화되지 않고 쌓이기만 한다.
 */
export const TABLES = [
  "settings",
  "children_identity",
  "staff",
  "resources",
  "books",
  "schedules",
  "journals",
  "journal_observations",
  "observations",
  "resource_records",
  "yearly_evaluations",
  "half_observations",
  "inquiries",
  "audit_logs",
  "sessions",
] as const;
