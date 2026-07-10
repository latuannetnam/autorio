export type Point = { x: number; y: number };
export type TilePoint = Point;
export type Box = { left: number; top: number; right: number; bottom: number };

export type ActionError =
  | "invalid_target"
  | "no_character"
  | "no_entity"
  | "not_minable"
  | "missing_item"
  | "collision"
  | "invalid_position"
  | "blocked"
  | "out_of_reach"
  | "inventory_full"
  | "invalid_recipe"
  | "timeout"
  | "interrupted"
  | "verification_failed"
  | "cursor_restore_failed";

export type EntityRef = {
  requestedTile: TilePoint;
  name: string;
  type: string;
  unitNumber: number | null;
  position: Point;
  box: Box;
  amount: number | null;
};

export type WalkResult = {
  ok: boolean;
  reached: boolean;
  blocked: boolean;
  position: Point | null;
  target: Point;
  distanceRemaining: number | null;
  elapsedMs: number;
  steps: number;
  error?: string;
};

export type CandidateAttempt = {
  candidate: Point;
  movement: WalkResult;
  reachable: boolean;
  error?: "blocked" | "out_of_reach" | "interrupted";
};

export type ApproachResult = {
  ok: boolean;
  position: Point | null;
  chosen: Point | null;
  attempts: CandidateAttempt[];
  error?: ActionError;
};

export class AsyncFifoLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export function rotateBox(box: Box, direction: number): Box {
  const normalized = ((direction % 16) + 16) % 16;
  if (normalized === 4 || normalized === 12) {
    return {
      left: box.top,
      top: box.left,
      right: box.bottom,
      bottom: box.right,
    };
  }
  return { ...box };
}

export function generateApproachCandidates(input: {
  player: Point;
  box: Box;
  reach: number;
  clearance: number;
}): Point[] {
  const { player, box, reach, clearance } = input;
  const inset = Math.max(clearance, Math.min(reach - 0.25, 1.5));
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const left = box.left - inset;
  const right = box.right + inset;
  const top = box.top - inset;
  const bottom = box.bottom + inset;
  return [
    { x: right, y: cy },
    { x: left, y: cy },
    { x: cx, y: bottom },
    { x: cx, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
    { x: right, y: top },
    { x: left, y: top },
  ].sort(
    (a, b) =>
      Math.hypot(a.x - player.x, a.y - player.y) -
      Math.hypot(b.x - player.x, b.y - player.y),
  );
}
