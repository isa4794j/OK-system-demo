/**
 * 근거 스냅샷 — 평가를 쓸 때 무엇을 읽었는지 찍어 두고, 나중에 견준다
 *
 * [왜 해시인가]
 * 관찰 본문을 통째로 담아 두면 평가 한 건마다 그 반기 관찰이 한 벌씩 복사된다.
 * 아동 신원이 섞이지는 않지만(관찰에는 이름이 없다) 같은 글이 두 곳에 살면
 * 어느 쪽이 진짜인지 헷갈리는 날이 온다. 우리가 알아야 하는 것은
 * "그때와 같은가" 뿐이므로 해시면 충분하다.
 *
 * 본문과 영역을 함께 해시한다. 영역이 바뀌면 그 서술의 근거가 다른 칸으로 옮겨 간 것이라
 * 평가를 쓴 사람이 알아야 한다.
 *
 * [영역 미지정은 담지 않는다]
 * 어느 칸의 근거도 아니다. 나중에 영역이 정해지면 "추가" 로 잡히는 편이
 * "수정" 으로 잡히는 것보다 사람이 읽기에 맞다.
 *
 * 이 파일은 Supabase 도 AI 도 부르지 않는다. 값만 다룬다.
 */

export type EvidenceEntry = {
  obs_id: string;
  content_hash: string;
};

/** 스냅샷을 찍을 관찰. 필요한 세 가지만 받는다. */
export type EvidenceSource = {
  id: string;
  area: string | null;
  content: string;
};

/**
 * 본문+영역의 해시. SHA-256 앞 16자리(64비트)를 쓴다.
 *
 * 자르는 이유는 자리 수다 — 평가마다 수십 줄이 저장되는데 64자는 읽을 일도 없이 길다.
 * 우연히 겹칠 확률은 이 규모(한 반기 관찰 수십 건)에서 없다고 봐도 된다.
 */
export async function evidenceHash(content: string, area: string | null): Promise<string> {
  const text = `${area ?? ""}\n${content}`;
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * 지금 근거로 스냅샷을 찍는다.
 *
 * obs_id 로 정렬해 담는다 — 같은 내용이면 늘 같은 모양이어야
 * 감사 로그의 before/after 가 "순서만 바뀐 것" 으로 시끄러워지지 않는다.
 */
export async function buildSnapshot(rows: EvidenceSource[]): Promise<EvidenceEntry[]> {
  const usable = rows.filter((one) => one.area);
  const entries = await Promise.all(
    usable.map(async (one) => ({
      obs_id: one.id,
      content_hash: await evidenceHash(one.content, one.area),
    })),
  );
  return entries.sort((a, b) => a.obs_id.localeCompare(b.obs_id));
}

export type EvidenceDiff = {
  /** 그때도 있었고 지금도 있는데 내용이나 영역이 바뀐 것 */
  modified: string[];
  /** 그때는 없었는데 지금 근거에 들어온 것 */
  added: string[];
  /** 그때는 있었는데 지금 근거에 없는 것. 왜 없어졌는지는 부르는 쪽이 가린다. */
  removed: string[];
};

/** 찍어 둔 것과 지금을 견준다. 값만 본다 — 왜 그렇게 됐는지는 여기서 모른다. */
export function diffSnapshot(
  snapshot: EvidenceEntry[],
  current: EvidenceEntry[],
): EvidenceDiff {
  const was = new Map(snapshot.map((one) => [one.obs_id, one.content_hash]));
  const now = new Map(current.map((one) => [one.obs_id, one.content_hash]));

  const modified: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [id, hash] of now) {
    if (!was.has(id)) added.push(id);
    else if (was.get(id) !== hash) modified.push(id);
  }
  for (const id of was.keys()) {
    if (!now.has(id)) removed.push(id);
  }
  return { modified, added, removed };
}

/** 바뀐 것이 하나라도 있는가. 배너를 띄울지 가른다. */
export function countChanges(diff: EvidenceDiff): number {
  return diff.modified.length + diff.added.length + diff.removed.length;
}

/** 저장된 값이 스냅샷 모양인지. 아니면 null 로 본다 — 추적 이전 평가와 같게 다룬다. */
export function readSnapshot(value: unknown): EvidenceEntry[] | null {
  if (!Array.isArray(value)) return null;
  for (const one of value) {
    if (!one || typeof one !== "object") return null;
    const row = one as Record<string, unknown>;
    if (typeof row.obs_id !== "string" || typeof row.content_hash !== "string") return null;
  }
  return value as EvidenceEntry[];
}
