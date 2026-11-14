export type TrackingMode = 'alwaysOpen' | 'windowFocused';
export interface ActivitySession {
  id: string; start: number; end: number; durationMs: number;
  project: string; language: string; hour: number; date: string;
}
export interface Lease { owner: string; heartbeat: number; expiresAt: number; }
export interface Database { schemaVersion: number; sessions: ActivitySession[]; updatedAt: number; }
export const SCHEMA_VERSION = 1;
