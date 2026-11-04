// Shapes the web board reads, taken from their source (the server routes and the core ops), never retyped by hand.
import type { BoardData } from '../server/api.ts';

export type { BoardData, BoardTab } from '../server/api.ts';
export type { ListItem, ListResult, TaskDetail, TaskRef, TaskView, ViewCard } from '../../core/index.ts';

// One column of GET /api/board.
export type BoardColumnData = BoardData['columns'][number];

// State of the live connection shown in the top bar.
export type LiveState = 'connecting' | 'live' | 'polling' | 'offline';
