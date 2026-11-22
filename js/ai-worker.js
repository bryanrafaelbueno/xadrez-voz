/**
 * Web Worker entry point for the chess engine.
 * Receives a position as FEN + move history, replies with the chosen move.
 */

import { think } from './ai.js';

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type !== 'think') return;
  try {
    const result = think({
      startFen: msg.startFen,
      moves: msg.moves || [],
      level: msg.level,
      timeMs: msg.timeMs,
      maxDepth: msg.maxDepth,
      blunder: msg.blunder,
      allowBlunder: msg.allowBlunder,
      book: msg.book,
    });
    self.postMessage({ type: 'result', id: msg.id, ...result });
  } catch (error) {
    self.postMessage({ type: 'error', id: msg.id, message: String(error && error.message || error) });
  }
};
