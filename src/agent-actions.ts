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

export type PlayerSnapshot = {
  connected: boolean;
  hasCharacter: boolean;
  surface: number;
  controllerType: number;
  position: Point;
  reach: number;
};

export type BuildProbe = {
  requestedTile: TilePoint;
  name: string;
  direction: number;
  footprint: Box;
  itemCount: number;
  surfacePlaceable: boolean;
  error?: ActionError;
};

export type BuildRequest = { name: string; x: number; y: number; direction: number };

export type BuildOperationResult = {
  ok: boolean;
  requestedTile: TilePoint;
  actualPosition: Point | null;
  collisionBox: Box | null;
  direction: number | null;
  consumed: number;
  cursorRestored: boolean;
  error?: ActionError;
  detail?: string;
};

export type MiningSnapshot = {
  targetValid: boolean;
  targetName: string;
  targetType: string;
  unitNumber: number | null;
  amount: number | null;
  progress: number;
  playerItemCount: number;
};

export type MiningResult = {
  ok: boolean;
  requestedTile: TilePoint;
  cycles: number;
  final: MiningSnapshot;
  error?: ActionError;
  detail?: string;
};

export function miningCycleComplete(
  initial: MiningSnapshot,
  current: MiningSnapshot,
): boolean {
  if (!current.targetValid) return true;
  if (initial.targetType === "resource") {
    return (
      initial.amount !== null &&
      current.amount !== null &&
      current.amount < initial.amount
    );
  }
  return false;
}

export interface ActionAdapter {
  walkToPoint(target: Point): Promise<WalkResult>;
  probePlayer(): Promise<PlayerSnapshot>;
  probeEntity(target: TilePoint): Promise<EntityRef | null>;
  probeBuild(input: { name: string; x: number; y: number; direction: number }): Promise<BuildProbe>;
  isCharacterClear(point: Point): Promise<boolean>;
  canReachEntity(entity: EntityRef): Promise<boolean>;
  canReachBuild(probe: BuildProbe): Promise<boolean>;
  build(request: BuildRequest): Promise<BuildOperationResult>;
  verifyBuild(request: BuildRequest): Promise<BuildOperationResult>;
  pulseMining(entity: EntityRef, itemName: string): Promise<MiningSnapshot>;
  stopMining(): Promise<void>;
  restoreSelection(entity: EntityRef | null): Promise<void>;
}

export class AgentActionController {
  private readonly lock = new AsyncFifoLock();

  constructor(private readonly adapter: ActionAdapter) {}

  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.lock.run(work);
  }

  moveTiles(targets: TilePoint[]): Promise<WalkResult[]> {
    return this.runExclusive(async () => {
      const results: WalkResult[] = [];
      for (const target of targets) {
        results.push(
          await this.adapter.walkToPoint({ x: target.x + 0.5, y: target.y + 0.5 }),
        );
      }
      return results;
    });
  }

  async approachEntity(entity: EntityRef): Promise<ApproachResult> {
    const player = await this.adapter.probePlayer();
    if (!player.connected || !player.hasCharacter) {
      return { ok: false, position: null, chosen: null, attempts: [], error: "no_character" };
    }
    const candidates = generateApproachCandidates({
      player: player.position,
      box: entity.box,
      reach: player.reach,
      clearance: 0.4,
    });
    const attempts: CandidateAttempt[] = [];
    for (const candidate of candidates) {
      if (!(await this.adapter.isCharacterClear(candidate))) continue;
      const movement = await this.adapter.walkToPoint(candidate);
      if (!movement.ok) {
        attempts.push({ candidate, movement, reachable: false, error: "blocked" });
        continue;
      }
      const reachable = await this.adapter.canReachEntity(entity);
      attempts.push({
        candidate,
        movement,
        reachable,
        error: reachable ? undefined : "out_of_reach",
      });
      if (reachable) {
        return { ok: true, position: movement.position, chosen: candidate, attempts };
      }
    }
    return {
      ok: false,
      position: attempts.at(-1)?.movement.position ?? player.position,
      chosen: null,
      attempts,
      error: attempts.some((attempt) => attempt.error === "out_of_reach")
        ? "out_of_reach"
        : "blocked",
    };
  }

  async approachBuild(probe: BuildProbe): Promise<ApproachResult> {
    const player = await this.adapter.probePlayer();
    if (!player.connected || !player.hasCharacter) {
      return { ok: false, position: null, chosen: null, attempts: [], error: "no_character" };
    }
    const candidates = generateApproachCandidates({
      player: player.position,
      box: probe.footprint,
      reach: player.reach,
      clearance: 0.4,
    });
    const attempts: CandidateAttempt[] = [];
    for (const candidate of candidates) {
      if (!(await this.adapter.isCharacterClear(candidate))) continue;
      const movement = await this.adapter.walkToPoint(candidate);
      if (!movement.ok) {
        attempts.push({ candidate, movement, reachable: false, error: "blocked" });
        continue;
      }
      const reachable = await this.adapter.canReachBuild(probe);
      attempts.push({ candidate, movement, reachable, error: reachable ? undefined : "out_of_reach" });
      if (reachable) return { ok: true, position: movement.position, chosen: candidate, attempts };
    }
    return {
      ok: false,
      position: attempts.at(-1)?.movement.position ?? player.position,
      chosen: null,
      attempts,
      error: attempts.some((attempt) => attempt.error === "out_of_reach") ? "out_of_reach" : "blocked",
    };
  }

  async buildBatch(requests: BuildRequest[]): Promise<BuildOperationResult[]> {
    return this.runExclusive(async () => {
      const results: BuildOperationResult[] = [];
      for (const request of requests) {
        const result = await this.runOneBuild(request);
        results.push(result);
      }
      return results;
    });
  }

  private async runOneBuild(request: BuildRequest): Promise<BuildOperationResult> {
    const base: BuildOperationResult = {
      ok: false,
      requestedTile: { x: request.x, y: request.y },
      actualPosition: null,
      collisionBox: null,
      direction: null,
      consumed: 0,
      cursorRestored: false,
    };
    const probe = await this.adapter.probeBuild(request);
    if (probe.error) return { ...base, error: probe.error };
    if (probe.itemCount < 1) return { ...base, error: "missing_item" };
    if (!probe.surfacePlaceable) return { ...base, error: "collision" };
    const approach = await this.approachBuild(probe);
    if (!approach.ok) {
      return {
        ...base,
        error: approach.error ?? "out_of_reach",
        detail: approach.attempts.length > 0 ? `${approach.attempts.length} candidates` : undefined,
      };
    }
    const built = await this.adapter.build(request);
    if (!built.ok) return { ...base, error: built.error, detail: built.detail, cursorRestored: built.cursorRestored };
    const verify = await this.adapter.verifyBuild(request);
    if (!verify.ok) return { ...base, ...built, error: verify.error, detail: verify.detail };
    return { ...base, ...built, ok: true };
  }

  async mineBatch(targets: TilePoint[]): Promise<MiningResult[]> {
    return this.runExclusive(async () => {
      const results: MiningResult[] = [];
      for (const target of targets) {
        results.push(await this.runOneMine(target));
      }
      return results;
    });
  }

  private async runOneMine(target: TilePoint): Promise<MiningResult> {
    const base: MiningResult = {
      ok: false,
      requestedTile: target,
      cycles: 0,
      final: {
        targetValid: false,
        targetName: "",
        targetType: "",
        unitNumber: null,
        amount: null,
        progress: 0,
        playerItemCount: 0,
      },
    };
    const entity = await this.adapter.probeEntity(target);
    if (!entity) return { ...base, error: "no_entity" };
    if (entity.type === "character") return { ...base, error: "not_minable" };
    if (entity.name === "character") return { ...base, error: "not_minable" };
    const initial: MiningSnapshot = {
      targetValid: true,
      targetName: entity.name,
      targetType: entity.type,
      unitNumber: entity.unitNumber,
      amount: entity.amount,
      progress: 0,
      playerItemCount: 0,
    };
    const approach = await this.approachEntity(entity);
    if (!approach.ok) {
      return {
        ...base,
        error: approach.error ?? "out_of_reach",
        detail: approach.attempts.length > 0 ? `${approach.attempts.length} candidates` : undefined,
      };
    }
    let current: MiningSnapshot = initial;
    let cycles = 0;
    try {
      while (!miningCycleComplete(initial, current)) {
        if (cycles >= 1 && initial.targetType === "resource") break;
        current = await this.adapter.pulseMining(entity, entity.name);
        cycles += 1;
        if (cycles > 600) break;
      }
      return {
        ok: true,
        requestedTile: target,
        cycles,
        final: current,
      };
    } finally {
      try {
        await this.adapter.stopMining();
      } catch {
        // ignore cleanup failure
      }
      try {
        await this.adapter.restoreSelection(null);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}
