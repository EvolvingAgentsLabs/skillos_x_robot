// src/hal.ts
// Hardware Abstraction Layer for skillos_x_robot.
// Defines the RobotHAL interface and a SimulatorHAL for 2D simulation.

import type { Position, Landmark, ObserveResult } from './types';
import type { IOAdapter } from './io';

// ── HAL Interface ──────────────────────────────────────────────

export interface RobotHAL {
  move_forward(distance_cm: number): Promise<{ ok: true; new_position: Position }>;
  rotate_left(degrees: number): Promise<{ ok: true; new_position: Position }>;
  rotate_right(degrees: number): Promise<{ ok: true; new_position: Position }>;
  stop(): Promise<{ ok: true }>;
  get_position(): Promise<Position>;
  observe(): Promise<ObserveResult>;
  speak(text: string): Promise<{ ok: true }>;
  listen(): Promise<{ text: string }>;
}

// ── SimulatorHAL ───────────────────────────────────────────────

export interface SimulatorConfig {
  /** Initial robot position. Default: { x: 0, y: -1.0, heading: 90 } */
  startPosition?: Position;
  /** Static landmarks in the arena. */
  landmarks: Landmark[];
  /** I/O adapter for speak/listen. */
  io: IOAdapter;
  /** Observation radius in meters. Default: 3.0 */
  observeRadius?: number;
}

export class SimulatorHAL implements RobotHAL {
  private pos: Position;
  private landmarks: Landmark[];
  private io: IOAdapter;
  private observeRadius: number;

  constructor(config: SimulatorConfig) {
    this.pos = config.startPosition
      ? { ...config.startPosition }
      : { x: 0, y: -1.0, heading: 90 };
    this.landmarks = config.landmarks;
    this.io = config.io;
    this.observeRadius = config.observeRadius ?? 3.0;
  }

  getPosition(): Position {
    return { ...this.pos };
  }

  async move_forward(distance_cm: number): Promise<{ ok: true; new_position: Position }> {
    const d = distance_cm / 100;  // cm -> m
    const rad = this.pos.heading * Math.PI / 180;
    this.pos.x += d * Math.cos(rad);
    this.pos.y += d * Math.sin(rad);
    return { ok: true, new_position: { ...this.pos } };
  }

  async rotate_left(degrees: number): Promise<{ ok: true; new_position: Position }> {
    this.pos.heading = normAngle(this.pos.heading + degrees);
    return { ok: true, new_position: { ...this.pos } };
  }

  async rotate_right(degrees: number): Promise<{ ok: true; new_position: Position }> {
    this.pos.heading = normAngle(this.pos.heading - degrees);
    return { ok: true, new_position: { ...this.pos } };
  }

  async stop(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async get_position(): Promise<Position> {
    return { ...this.pos };
  }

  async observe(): Promise<ObserveResult> {
    const nearby: ObserveResult['nearby_landmarks'] = [];
    let nearestPerson: ObserveResult['nearest_person'] = undefined;
    let nearestPersonDist = Infinity;

    for (const lm of this.landmarks) {
      const dx = lm.x - this.pos.x;
      const dy = lm.y - this.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > this.observeRadius) continue;

      const bearing = signedBearing(Math.atan2(dy, dx) * 180 / Math.PI - this.pos.heading);

      nearby.push({
        id: lm.id,
        label: lm.label,
        distance_m: round2(dist),
        bearing_deg: round2(bearing),
        type: lm.type,
      });

      if (lm.type === 'person' && dist < nearestPersonDist) {
        nearestPersonDist = dist;
        nearestPerson = {
          id: lm.id,
          label: lm.label,
          distance_m: round2(dist),
          bearing_deg: round2(bearing),
        };
      }
    }

    return {
      position: { ...this.pos },
      nearby_landmarks: nearby,
      nearest_person: nearestPerson,
    };
  }

  reset(position?: Position): void {
    this.pos = position
      ? { ...position }
      : { x: -0.5, y: -1.0, heading: 90 };
  }

  async speak(text: string): Promise<{ ok: true }> {
    await this.io.speak(text);
    return { ok: true };
  }

  async listen(): Promise<{ text: string }> {
    const text = await this.io.listen();
    return { text };
  }
}

// ── Helpers ────────────────────────────────────────────────────

function normAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Returns bearing in -180..+180 range. Positive = left, negative = right. */
function signedBearing(deg: number): number {
  let b = ((deg % 360) + 360) % 360;
  if (b > 180) b -= 360;
  return b;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
