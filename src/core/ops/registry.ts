// Every core op by name; facades map each one to a tool or mark it CLI-only (C3).
import { archiveTasks, deleteTask, restoreTask } from './archive.ts';
import { attachFile } from './attach.ts';
import { configureStore, doctor, initStore, migrateStore } from './admin.ts';
import { createTask } from './create.ts';
import { importTasks } from './import.ts';
import { getTask, listEvents, listTasks, taskSummary, viewBoard } from './read.ts';
import { listBoards } from '../boards.ts';
import { claimTask, commentTask, updateTask } from './update.ts';

export const OPS = {
  createTask,
  getTask,
  listTasks,
  updateTask,
  claimTask,
  commentTask,
  attachFile,
  archiveTasks,
  restoreTask,
  deleteTask,
  listEvents,
  taskSummary,
  initStore,
  migrateStore,
  doctor,
  importTasks,
  configureStore,
  viewBoard,
  listBoards,
} as const;

export type OpName = keyof typeof OPS;
