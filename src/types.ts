import type { RoomDurableObject } from './room-do';

export type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  ROOM_DO: DurableObjectNamespace<RoomDurableObject>;
  AI: Ai;
};

export type Variables = {
  userId: string;
  username: string;
};
